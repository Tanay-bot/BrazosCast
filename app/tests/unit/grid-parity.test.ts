import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { firstForecastIndex, runEnsemble, type EnsembleSpec } from "../../src/lib/ensemble";
import { flagCounts, tierOnsets } from "../../src/lib/backcast";
import { applyTransfer, applyTransferClamped, type Transfer } from "../../src/lib/transfer";
import type { Pt } from "../../src/lib/series";

/**
 * T3 — cross-language grid parity, checked instead of sampled.
 *
 * The ensemble, the crest transfer and the backcast rule are each implemented twice: Python in
 * `pipeline/derive/` (which writes the artifacts) and TypeScript in `app/src/lib/` (which runs in
 * the browser). Until this file, "they agree" rested on a DEV-only inspection hook — and for the
 * backcast nothing called it at all. A duplicated algorithm that nothing checks is two
 * algorithms.
 *
 * The method here is: take the grid the pipeline emitted for the app to reproduce, recompute
 * every row through the app's own kernel, and require each number to match exactly. Nothing in
 * this file re-derives a value from the raw inputs; the expectations are the pipeline's own rows,
 * and the inputs are the artifacts the app is actually served (`public/data/`, which the build
 * copies to `dist/`), not a test fixture. The one thing asserted about the inputs is an identity
 * the pipeline's grids depend on and no test held before: that the series the app replays is the
 * series the pipeline's grid was computed on (asserted in Python, where that series is built —
 * `pipeline/tests/test_grid_parity.py` — because rebuilding it needs pandas).
 *
 * A note on why the counts are exact rather than approximate. The two implementations round
 * identically on purpose — drawn values to 6 dp, crossing hours to 3 dp, thresholds to 4 dp,
 * quantiles to 2 dp — so that libm and V8 differing in the last ulp cannot move a draw across a
 * hydrograph point and change a reported count. That design decision is what makes `toBe` the
 * right assertion; a tolerance here would hide the very drift it exists to prevent.
 */

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

/** The replay hydrograph as the app fetches and parses it (app/public/data/replay-harvey.json),
 *  not the raw USGS cache — if this series and the pipeline's version diverge, the parity below
 *  is being asserted against the wrong input. */
const replay: Pt[] = (
  read("../../public/data/replay-harvey.json") as { points: { t: string; v: number }[] }
).points.map((p) => ({ t: Date.parse(p.t), v: p.v, kind: "obs" as const }));

/** Every segment's flood stage, in segment order — the population the app counts over. */
const thresholds: number[] = (
  read("../../public/data/road_thresholds.geojson") as {
    features: { properties: { flood_stage_ft: number } }[];
  }
).features.map((f) => f.properties.flood_stage_ft);

const ensembleSpec = read("../../../data/derived/ensemble.json") as EnsembleSpec;
const backcast = read("../../../data/derived/harvey_backcast.json") as {
  event: { window: { n_points: number } };
  tiers: { tier: string; stage_ft: number }[];
  street_lead_time: { segments: number };
  correction_tradeoff: { lift_ft: number };
  verification_grid: {
    flag_counts: { stage_ft: number; shipped: number; corrected: number }[];
    tier_onsets_h: Record<string, number | null>;
  };
};
const redundancy = read("../../../data/derived/gauge_redundancy.json") as {
  transfer: Record<string, Transfer>;
};

const ref = replay[0].t;

describe("the inputs the grids are computed on", () => {
  test("the replay series is hourly and is the one the pipeline's grid used", () => {
    // The pipeline's own window record says 241 points over 240 h (backcast.py) and ensemble.py
    // resamples the same USGS record the same way. If either changes shape, the grid's rows
    // stop meaning what the artifact says they mean, and this is where that is noticed.
    expect(replay.length).toBe(backcast.event.window.n_points);
    expect(replay.length).toBe(241);
    for (let i = 1; i < replay.length; i++) {
      expect(replay[i].t - replay[i - 1].t).toBe(3_600_000);
    }
    // Wholly observed, so the ensemble's spread here is the threshold error alone.
    expect(firstForecastIndex(replay)).toBeNull();
  });

  test("the app counts over the same population the pipeline counted", () => {
    expect(thresholds.length).toBe(backcast.street_lead_time.segments);
    expect(thresholds.length).toBe(1614);
    expect(thresholds.every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe("the ensemble grid (pipeline/derive/ensemble.py)", () => {
  const grid = ensembleSpec.verification_grid;

  test("the grid is the 16 rows the app is asked to reproduce", () => {
    // Guards the check itself: a grid that shrank (or stopped exercising the forecast path)
    // would otherwise let this file pass by comparing fewer and fewer rows.
    expect(grid).toHaveLength(16);
    expect(grid.filter((r) => r.forecast_from === null)).toHaveLength(8);
    expect(grid.filter((r) => r.forecast_from !== null)).toHaveLength(8);
    expect(grid.some((r) => r.crossing === 0)).toBe(true);
    // The grid has to carry spread, or "a distribution, not a point estimate" is unsupported:
    // the pipeline's own gate is that some row is uncertain, i.e. neither 0 nor all members
    // cross. (No row crosses for every member — 47 of 50 is the highest — which is worth knowing
    // before writing a guard that assumes one does.)
    expect(grid.some((r) => r.crossing > 0 && r.crossing < r.of)).toBe(true);
    expect(grid.every((r) => r.crossing <= r.of)).toBe(true);
  });

  test.each(grid.map((row, i) => [i, row] as const))(
    "row %i: %s ft, %s",
    (_i, row) => {
      const got = runEnsemble(row.threshold_ft, ensembleSpec, replay, ref, row.forecast_from);
      // The pipeline's row IS the expectation — count, never-count and all three quantiles.
      expect({
        members: got.members, crossing: got.crossing, of: got.of, never_h: got.never_h,
        median_h: got.median_h, p10_h: got.p10_h, p90_h: got.p90_h,
      }).toEqual({
        members: row.members, crossing: row.crossing, of: row.of, never_h: row.never_h,
        median_h: row.median_h, p10_h: row.p10_h, p90_h: row.p90_h,
      });
    },
  );
});

describe("the crossing rule at its boundary", () => {
  // What the grid rows above cannot witness, and it took a mutation to notice: the shipped rows
  // have no draw that lands exactly on an observed stage, so a parity check of counts and
  // quantiles is exact and still blind to the comparison's convention. The app's rule is
  // `v >= tau` with tau drawn at 4 dp, so a threshold 1e-6 ft ABOVE an observed stage rounds back
  // onto it and crosses in every member. Breaking that (a strict `>`, or rounding tau elsewhere)
  // passes the grid and is caught only here — which is why this block exists even though it makes
  // no claim about the pipeline.
  const noError = {
    ...ensembleSpec,
    parameters: { ...ensembleSpec.parameters, lift_ft: 0, per_street_sigma_ft: 0 },
  } as EnsembleSpec;
  const flat: Pt[] = [0, 1, 2].map((h) => ({ t: h * 3_600_000, v: 12 + h * 0.5, kind: "obs" }));
  const crossing = (threshold: number) =>
    runEnsemble(threshold, noError, flat, 0, null).crossing;

  test("a stage exactly at the threshold crosses, in every member", () => {
    expect(crossing(12)).toBe(noError.parameters.members);
    expect(crossing(13)).toBe(noError.parameters.members);
  });

  test("a threshold inside the rounding of an observed stage still crosses", () => {
    expect(crossing(13 + 1e-6)).toBe(noError.parameters.members);
    expect(crossing(13.01)).toBe(0);
  });
});

describe("the backcast grid (pipeline/derive/backcast.py)", () => {
  const vg = backcast.verification_grid;

  test("the grid is the 17 rows the app is asked to reproduce", () => {
    expect(Object.keys(vg.tier_onsets_h)).toHaveLength(4);
    expect(vg.flag_counts).toHaveLength(13);
    expect(Object.keys(vg.tier_onsets_h).length + vg.flag_counts.length).toBe(17);
  });

  test("every tier onset matches, keyed the way the app looks it up", () => {
    const got = tierOnsets(replay, backcast.tiers);
    backcast.tiers.forEach((t, i) => {
      // The app's own key format, so a drift in it fails here rather than silently reading null.
      const want = vg.tier_onsets_h[`${t.tier}_${t.stage_ft}`];
      expect(want, `no grid row for ${t.tier} at ${t.stage_ft} ft`).toBeDefined();
      expect(got[i]).toBe(want);
    });
  });

  test.each(vg.flag_counts.map((row, i) => [i, row] as const))(
    "flag counts at row %i (%s ft)",
    (_i, row) => {
      const got = flagCounts(thresholds, row.stage_ft, backcast.correction_tradeoff.lift_ft);
      expect(got).toEqual({ shipped: row.shipped, corrected: row.corrected });
    },
  );
});

describe("the crest transfer (pipeline/derive/gauge_redundancy.py)", () => {
  // This one has no verification grid in the artifact, so the fixture is the artifact's own
  // knots. That is weaker than the two grids above and it is stated rather than implied: it can
  // catch the interpolation being off by one index, a clamp pointing the wrong way, or a knot
  // list read in the wrong order — not a subtly different mid-range rule, because no pipeline
  // evaluation of the mid-range exists to compare against.
  const gauges = Object.entries(redundancy.transfer);

  test("both gauges carry usable knots", () => {
    expect(gauges).toHaveLength(2);
    for (const [, t] of gauges) {
      expect(t.u_ft.length).toBe(t.r_ft.length);
      expect(t.u_ft.length).toBeGreaterThan(2);
      for (let i = 1; i < t.u_ft.length; i++) expect(t.u_ft[i]).toBeGreaterThan(t.u_ft[i - 1]);
    }
  });

  test.each(gauges)("%s reproduces the pipeline's knots", (_lid, t) => {
    t.u_ft.forEach((u, i) => {
      expect(applyTransfer(t, u)).toBeCloseTo(t.r_ft[i], 9);
    });
    // The pipeline interpolates with `np.interp(..., left=r[0], right=r[-1])`: outside the
    // fitted range it holds the end value and the fitted band no longer describes the answer.
    // The app must report that clamp rather than quote the band over it.
    expect(applyTransferClamped(t, t.u_ft[0] - 50)).toEqual({ v: t.r_ft[0], clamped: true });
    expect(applyTransferClamped(t, t.u_ft[t.u_ft.length - 1] + 50))
      .toEqual({ v: t.r_ft[t.r_ft.length - 1], clamped: true });
  });

  test.each(gauges)("%s stays inside the bracket its two knots imply", (_lid, t) => {
    for (let i = 1; i < t.u_ft.length; i++) {
      const mid = (t.u_ft[i - 1] + t.u_ft[i]) / 2;
      const got = applyTransferClamped(t, mid);
      const lo = Math.min(t.r_ft[i - 1], t.r_ft[i]), hi = Math.max(t.r_ft[i - 1], t.r_ft[i]);
      expect(got.clamped, `the midpoint of a fitted interval is not reported as clamped`).toBe(false);
      expect(got.v).toBeGreaterThanOrEqual(lo);
      expect(got.v).toBeLessThanOrEqual(hi);
    }
  });
});
