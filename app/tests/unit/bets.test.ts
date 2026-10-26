import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { streetLeadHours } from "../../src/lib/backcast";
import { crossCheck, valueAt, type UpstreamReading } from "../../src/lib/crosscheck";
import { cutOffAt, hospitalCutAt, summarize } from "../../src/lib/responders";
import { parseForecast, applyUserForecast } from "../../src/lib/userforecast";
import { crossingHoursIn, robustness } from "../../src/lib/robustness";
import type { Pt } from "../../src/lib/series";
import type { Transfer } from "../../src/lib/transfer";

/**
 * The post-submission bets (I2–I6) and the quiet-river answer.
 *
 * Four new rules live in `src/lib/` rather than inside main.ts because each one has a failure
 * mode worth naming and none of them needs a browser to decide:
 *
 *   * I2 — the transfer is the pipeline's, so the only thing that can be wrong here is the
 *     verdict: a clamped knot, a missing gauge or an inverted band would all read as agreement.
 *   * I5 — the inverse set is defined by an INEQUALITY (cut at or before the stage, street still
 *     dry). An off-by-one there reports the wrong population, and the population is the feature.
 *   * I4 — a parser that silently drops a line moves a crossing time with nothing on screen
 *     saying so, which is exactly why every rejected line is reported with its number.
 *   * I6 — the perturbation has to be the ARTIFACT's measured numbers, and the verdict has to be
 *     about the qualitative claim rather than about hours moving.
 *
 * The artifacts are read the way the app reads them (`public/data`), not as fixtures, and the
 * per-segment backcast is checked against the pipeline's own array for every row it names.
 */

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

const replay: Pt[] = (
  read("../../public/data/replay-harvey.json") as { points: { t: string; v: number }[] }
).points.map((p) => ({ t: Date.parse(p.t), v: p.v, kind: "obs" as const }));

const thresholds: number[] = (
  read("../../public/data/road_thresholds.geojson") as {
    features: { properties: { flood_stage_ft: number } }[];
  }
).features.map((f) => f.properties.flood_stage_ft);

const backcast = read("../../../data/derived/harvey_backcast.json") as {
  street_lead_time: { per_segment_h: (number | null)[]; segments_reaching_threshold: number };
  verification_grid: { segment_lead_h: Record<string, number | null> };
};

const history = read("../../../data/derived/gauge_history.json") as {
  unit: string; n_peaks: number; from: string; to: string;
  highest: { at: string; ft: number };
  peaks: { at: string; ft: number }[];
};

const redundancy = read("../../../data/derived/gauge_redundancy.json") as {
  transfer: Record<string, Transfer>;
  uncertainty: { band_ft: [number, number] };
};

/* ------------------------------------------------------------------ I3 */

describe("I3 — the per-street backcast is recomputed, not read", () => {
  test("every segment the pipeline named comes out of the app's own rule", () => {
    const grid = backcast.verification_grid.segment_lead_h;
    expect(Object.keys(grid).length).toBeGreaterThan(10);
    for (const [k, want] of Object.entries(grid)) {
      const got = streetLeadHours(replay, thresholds[Number(k)]);
      expect(got).toBe(want);
    }
  });

  test("the named rows include the two cases the answer branches on", () => {
    const values = Object.values(backcast.verification_grid.segment_lead_h);
    expect(values.some((v) => v === null)).toBe(true);       // never reached in 2017
    expect(values.some((v) => v !== null)).toBe(true);       // reached, with hours
  });

  test("the whole corridor is reproduced, and the array's own population is the one quoted", () => {
    // Not a sample: 1,614 rows is the population the published percentiles were taken from, and
    // a rule that is right on 16 sampled rows and wrong on the other 1,598 is not right.
    const per = backcast.street_lead_time.per_segment_h;
    expect(per.length).toBe(thresholds.length);
    let reached = 0;
    for (let i = 0; i < per.length; i++) {
      const got = streetLeadHours(replay, thresholds[i]);
      if (got !== null) reached++;
      expect(got).toBe(per[i]);
    }
    expect(reached).toBe(backcast.street_lead_time.segments_reaching_threshold);
  });

  test("a threshold above the observed crest is never reached — the null branch is real", () => {
    const crest = Math.max(...replay.map((p) => p.v));
    expect(streetLeadHours(replay, crest + 5)).toBe(null);
    const atCrest = streetLeadHours(replay, crest - 0.01);
    expect(atCrest).not.toBe(null);
    expect(atCrest as number).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ quiet river */

describe("the quiet-river answer", () => {
  const lastReached = (threshold: number) => {
    let best: { at: string; ft: number } | null = null;
    for (const p of history.peaks) if (p.ft >= threshold && (!best || p.at > best.at)) best = p;
    return best;
  };

  test("the rule the app runs finds the last year at or above a stage", () => {
    const median = [...thresholds].sort((a, b) => a - b)[thresholds.length >> 1];
    const hit = lastReached(median);
    expect(hit).not.toBe(null);
    expect(hit!.ft).toBeGreaterThanOrEqual(median);
    expect(new Date(hit!.at).getUTCFullYear()).toBeGreaterThan(1950);
  });

  test("an impossible stage is answered with null rather than a year", () => {
    expect(lastReached(history.highest.ft + 1)).toBe(null);
    expect(lastReached(history.highest.ft)).not.toBe(null);
  });

  test("the record is feet, comes from one gauge, and is long enough to say 'never'", () => {
    expect(history.unit).toBe("ft");
    expect(history.n_peaks).toBe(history.peaks.length);
    expect(history.n_peaks).toBeGreaterThan(50);
    expect(Number(history.from.slice(0, 4))).toBeLessThan(1950);
    const highest = history.peaks.reduce((a, b) => (b.ft > a.ft ? b : a));
    expect(highest.ft).toBe(history.highest.ft);
    expect(highest.at).toBe(history.highest.at);
  });
});

/* ------------------------------------------------------------------ I2 */

const toyTransfer = (name: string, lag: number): Transfer =>
  ({ name, usgs: "0", lag_h: lag, lag_h_used: lag, u_ft: [10, 20, 30], r_ft: [11, 21, 31] });

describe("I2 — two gauges, one answer", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  // Readings at both lags the two shipped transfers need (48 h and 31 h), because a gauge with
  // no reading at ITS lag is reported as missing rather than compared at the nearest point.
  const series = (v: number): { t: number; v: number }[] =>
    [{ t: now - 48 * 3_600_000, v }, { t: now - 31 * 3_600_000, v }];

  test("an estimate inside the measured band agrees, and the divergence is signed", () => {
    // upstream 20 ft transfers to 21 ft against an observed 20.5 → +0.50 ft, inside −1.56..+1.01.
    const g: UpstreamReading = { lid: "HPDT2", transfer: toyTransfer("Hempstead", 48), series: series(20) };
    const out = crossCheck(20.5, [g], now, [-1.56, 1.01]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].estimateFt).toBe(21);
    expect(out.rows[0].divergenceFt).toBe(0.5);
    expect(out.rows[0].agrees).toBe(true);
    expect(out.flagged).toBe(false);
  });

  test("a divergence outside the band is flagged, in both directions", () => {
    const g: UpstreamReading = { lid: "HPDT2", transfer: toyTransfer("Hempstead", 48), series: series(20) };
    // 21 vs 22 is −1.0 ft, which is INSIDE −1.56..+1.01: the band is asymmetric on purpose
    // (the transfer runs a little low), so an in-band negative divergence is not a flag.
    expect(crossCheck(22, [g], now, [-1.56, 1.01]).flagged).toBe(false);
    const big = crossCheck(25, [g], now, [-1.56, 1.01]);
    expect(big.rows[0].divergenceFt).toBe(-4);
    expect(big.flagged).toBe(true);
    expect(big.note).toContain("Hempstead");
    expect(crossCheck(23, [g], now, [-1.56, 1.01]).flagged).toBe(true);    // −2.0, past the low edge
    expect(crossCheck(19, [g], now, [-1.56, 1.01]).flagged).toBe(true);   // +2 ft, above +1.01
  });

  test("a clamped knot never counts as agreement, whatever the arithmetic says", () => {
    // 5 ft is below the fitted range, so the transfer returns the floor: the band it would be
    // compared against was measured over the fitted range and does not describe this case.
    const g: UpstreamReading = { lid: "HPDT2", transfer: toyTransfer("Hempstead", 48), series: series(5) };
    const out = crossCheck(11, [g], now, [-1.56, 1.01]);
    expect(out.rows[0].clamped).toBe(true);
    expect(out.rows[0].estimateFt).toBe(11);
    expect(out.rows[0].divergenceFt).toBe(0);
    expect(out.rows[0].agrees).toBe(false);        // a floored value is not an agreement…
    expect(out.inRange).toBe(0);
    expect(out.flagged).toBe(false);               // …and not a disagreement either: it is no check
    expect(out.note).toContain("clamped floor");
  });

  test("in a quiet river both gauges floor, and the card says the check cannot be made", () => {
    // Measured in the browser at 8.6 ft: both gauges read ~2 ft above the live stage, because
    // the transfer is fitted on flood events. Reporting that as disagreement would put a
    // permanent false alarm on the page whose whole purpose is one number.
    const a: UpstreamReading = { lid: "HPDT2", transfer: toyTransfer("Hempstead", 48), series: series(5) };
    const b: UpstreamReading = { lid: "BAWT2", transfer: toyTransfer("San Felipe", 31), series: series(6) };
    const out = crossCheck(8.6, [a, b], now, [-1.56, 1.01]);
    expect(out.rows).toHaveLength(2);
    expect(out.inRange).toBe(0);
    expect(out.flagged).toBe(false);
    expect(out.note).toContain("flood events");
  });

  test("one gauge inside the range is enough to make the check, and it governs the verdict", () => {
    const floored: UpstreamReading = { lid: "HPDT2", transfer: toyTransfer("Hempstead", 48), series: series(5) };
    const real: UpstreamReading = { lid: "BAWT2", transfer: toyTransfer("San Felipe", 31), series: series(20) };
    // San Felipe transfers 20 → 21 against an observed 25: −4 ft, outside the band.
    const out = crossCheck(25, [floored, real], now, [-1.56, 1.01]);
    expect(out.inRange).toBe(1);
    expect(out.flagged).toBe(true);
    expect(out.note).toContain("San Felipe");
    expect(out.note).not.toContain("Hempstead");   // the floored gauge is not blamed
  });

  test("a gauge with no reading at the lag is named as missing, never as agreement", () => {
    const g: UpstreamReading = { lid: "BAWT2", transfer: toyTransfer("San Felipe", 31), series: [] };
    const out = crossCheck(20, [g], now, [-1.56, 1.01]);
    expect(out.rows).toHaveLength(0);
    expect(out.missing).toEqual(["San Felipe"]);
    expect(out.flagged).toBe(false);
    expect(out.note).toContain("No upstream gauge");
  });

  test("the shipped band is two-sided, so both directions are checkable", () => {
    const [lo, hi] = redundancy.uncertainty.band_ft;
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
  });

  test("valueAt measures distance in time, and refuses a reading it does not have", () => {
    const s = [{ t: now, v: 1 }, { t: now + 3_600_000, v: 2 }];
    expect(valueAt(s, now + 60_000, 3_600_000)).toBe(1);
    expect(valueAt(s, now + 4_800_000, 3_600_000)).toBe(2);
    expect(valueAt(s, now + 48 * 3_600_000, 3_600_000)).toBe(null);
    expect(valueAt([], now, 3_600_000)).toBe(null);
  });
});

/* ------------------------------------------------------------------ I5 */

const names = ["Alpha Rd", "Bravo St", "Charlie Ln", "Delta Way"];

describe("I5 — dry road, no way out", () => {
  //      i: 0 route cut 30, street floods 45, hospital cut 31  (margin 15)
  //         1 route cut 40, street floods 42, hospital cut 41  (margin  2)
  //         2 route cut 20, street floods 60, hospital cut 20  (margin 40)
  //         3 no modelled route at any stage (null) → never reported
  const cut = [30, 40, 20, null];
  const medical = [31, 41, 20, null];
  const thr = [45, 42, 60, 30];

  test("a segment is in the set only once its route is gone, and only while its street is dry", () => {
    expect(cutOffAt(19.9, thr, cut, medical, names)).toEqual([]);   // nothing cut yet
    expect(cutOffAt(20, thr, cut, medical, names).map((r) => r.i)).toEqual([2]);
    expect(cutOffAt(29.9, thr, cut, medical, names).map((r) => r.i)).toEqual([2]);
    // At 30 the second route goes, and the set already holds the one whose route went first.
    expect(cutOffAt(30, thr, cut, medical, names).map((r) => r.i)).toEqual([2, 0]);
  });

  test("a flooded street leaves the set — it is a different, later state", () => {
    // 1's street (42 ft) is under at 42; 2's (60 ft) is not, so the set is not simply
    // "everything whose route is gone". A set that kept flooded streets would grow
    // monotonically and describe the wrong population.
    expect(cutOffAt(41.9, thr, cut, medical, names).map((r) => r.i)).toEqual([2, 0, 1]);
    expect(cutOffAt(42, thr, cut, medical, names).map((r) => r.i)).toEqual([2, 0]);
    expect(cutOffAt(45, thr, cut, medical, names).map((r) => r.i)).toEqual([2]);
    expect(cutOffAt(60, thr, cut, medical, names)).toEqual([]);
  });

  test("worst first: the widest window between losing the way out and the water", () => {
    const rows = cutOffAt(41.9, thr, cut, medical, names);
    expect(rows.map((r) => r.marginFt)).toEqual([40, 15, 2]);
    expect(rows[0].cutFt).toBe(20);
    expect(rows[0].floodFt).toBe(60);
    expect(rows[1].cutFt).toBe(30);
    expect(rows[1].marginFt).toBe(15);
  });

  test("a segment with no modelled route at any stage is excluded, not reported as trapped", () => {
    for (const stage of [10, 30, 44, 56]) {
      expect(cutOffAt(stage, thr, cut, medical, names).some((r) => r.i === 3)).toBe(false);
    }
  });

  test("a hospital route that is also cut is counted separately from the way out", () => {
    const at30 = cutOffAt(30, thr, cut, medical, names);
    expect(at30.find((r) => r.i === 0)!.noHospital).toBe(false);   // hospital cut at 31, not yet
    expect(at30.find((r) => r.i === 2)!.noHospital).toBe(true);    // hospital cut at 20, already
    const at31 = cutOffAt(31, thr, cut, medical, names);
    expect(at31.find((r) => r.i === 0)!.noHospital).toBe(true);    // now it is
    const s = summarize(at31);
    expect(s.count).toBe(2);
    expect(s.noHospital).toBe(2);
    expect(s.worstMarginFt).toBe(40);
    expect(summarize([]).worstMarginFt).toBe(null);
    expect(summarize([]).count).toBe(0);
  });

  test("the ranking does not depend on the stage — only membership does", () => {
    // The card promises "worst first", so a set that was re-sorted as the stage moved would
    // reorder rows under the reader's eyes for no reason the reader can see.
    const at419 = cutOffAt(41.9, thr, cut, medical, names).map((r) => r.i);
    const at43 = cutOffAt(43, thr, cut, medical, names).map((r) => r.i);
    expect(at419).toEqual([2, 0, 1]);                        // margins 40, 15, 2
    expect(at43).toEqual(at419.filter((i) => at43.includes(i)));
    expect(at43).toEqual([2, 0]);
  });

  test("the hospital flag is decided per stage, and never guessed", () => {
    const row = (stage: number, i: number) =>
      cutOffAt(stage, thr, cut, medical, names).find((r) => r.i === i)!;
    expect(row(30, 0).noHospital).toBe(false);               // hospital cut at 31, not yet
    expect(row(31, 0).noHospital).toBe(true);
    // Segment 1's own street goes under at 42, so its row can only be read below that.
    const one = row(41.9, 1);
    expect(one.cutToHospitalFt).toBe(41);
    expect(hospitalCutAt(one, 40)).toBe(false);
    expect(hospitalCutAt(one, 41)).toBe(true);
  });

  test("the real graph's cut arrays are the same length as the road layer", () => {
    const g = read("../../public/data/routing_graph.json") as {
      segment_route_cut_ft: (number | null)[]; segment_route_cut_medical_ft: (number | null)[];
    };
    expect(g.segment_route_cut_ft.length).toBe(thresholds.length);
    expect(g.segment_route_cut_medical_ft.length).toBe(thresholds.length);
    const at45 = cutOffAt(45, thresholds, g.segment_route_cut_ft, g.segment_route_cut_medical_ft,
      thresholds.map((_, i) => `segment ${i}`));
    expect(at45.length).toBeGreaterThan(0);
    expect(at45.every((r) => r.cutFt <= 45 && 45 < r.floodFt)).toBe(true);
    expect(at45[0].marginFt).toBeGreaterThanOrEqual(at45[at45.length - 1].marginFt);
  });
});

/* ------------------------------------------------------------------ I6 */

const spec = read("../../../data/derived/ensemble.json") as {
  parameters: { per_street_sigma_ft: number; lift_ft: number; forecast_rmse_beyond_measured_ft: number };
};

describe("I6 — does the answer survive", () => {
  const now = replay[0].t;
  const fcIndex = 3;
  const series: Pt[] = [
    { t: now, v: 10, kind: "obs" },
    { t: now + 6 * 3_600_000, v: 20, kind: "obs" },
    { t: now + 12 * 3_600_000, v: 30, kind: "obs" },
    { t: now + 18 * 3_600_000, v: 40, kind: "fc" },
    { t: now + 24 * 3_600_000, v: 45, kind: "fc" },
  ];
  const opts = {
    sigmaFt: 11.36, liftFt: 23.72,
    rmseAtHours: () => 3.0, forecastFrom: fcIndex,
  };

  test("the base answer is the app's own rule over the same series", () => {
    expect(crossingHoursIn(series, now, 45)).toBe(24);
    expect(crossingHoursIn(series, now, 50)).toBe(null);
  });

  test("a later threshold and the corridor lift both move the answer later, and can erase it", () => {
    const r = robustness(series, now, 45, opts);
    expect(r.base).toBe(24);
    expect(r.rows.find((x) => x.key === "thr_hi")!.hours).toBe(null);      // 56.4 ft never reached
    expect(r.rows.find((x) => x.key === "thr_hi")!.holds).toBe(false);
    expect(r.rows.find((x) => x.key === "thr_lo")!.hours).toBeLessThan(24);
    expect(r.rows.find((x) => x.key === "lift")!.hours).toBe(null);        // 68.7 ft never reached
  });

  test("the forecast's own measured error moves the crossing, in both directions", () => {
    // 40 ft is crossed by the first forecast point (40 ft at +18 h). The base answer is 18 h;
    // a forecast that is 3 ft high crosses there too, and one that is 3 ft low defers the
    // crossing to the NEXT forecast point at +24 h — the direction that costs someone hours.
    const r = robustness(series, now, 40, { ...opts, sigmaFt: 0, liftFt: 0 });
    const hi = r.rows.find((x) => x.key === "fc_hi")!;
    const lo = r.rows.find((x) => x.key === "fc_lo")!;
    expect(r.base).toBe(18);
    expect(r.rows.find((x) => x.key === "thr_hi")!.hours).toBe(r.base);
    expect(hi.hours).toBe(18);
    expect(lo.hours).toBe(24);
    expect(lo.delta).toBe(6);
    expect(lo.holds).toBe(true);                     // still reached: the claim survives
  });



  /* The four cases the release asked for, as four tests. The first is the bug: the forecast
   * rows used to be skipped whenever the base answer was "not reached", which reported that a
   * non-crossing survived every perturbation — when an upward-shifted forecast is precisely how
   * a non-crossing becomes a crossing. */
  // A forecast that peaks just under the threshold: 47 ft, then 48 ft, against 50 ft.
  const nearMiss: Pt[] = [
    { t: now, v: 10, kind: "obs" },
    { t: now + 6 * 3_600_000, v: 20, kind: "obs" },
    { t: now + 12 * 3_600_000, v: 30, kind: "obs" },
    { t: now + 18 * 3_600_000, v: 47, kind: "fc" },
    { t: now + 24 * 3_600_000, v: 48, kind: "fc" },
  ];
  // The measured RMSE grows with lead time: 1 ft at the first forecast point, 3 ft at +6 h.
  const growing = (h: number) => (h <= 0 ? 1 : 3);

  test("a base non-crossing is perturbed, and a high forecast can turn it into a crossing", () => {
    const r = robustness(nearMiss, now, 50,
      { ...opts, sigmaFt: 0, liftFt: 0, rmseAtHours: growing });
    expect(r.base).toBe(null);                              // the point estimate: not reached
    const hi = r.rows.find((x) => x.key === "fc_hi")!;
    const lo = r.rows.find((x) => x.key === "fc_lo")!;
    expect(hi.skipped).toBe(false);                         // ...and it IS perturbed
    // The envelope is by horizon, not one offset: +1 ft at the first forecast point (48 ft)
    // misses, +3 ft at the next (51 ft) crosses, so the answer is 24 h from `now`.
    expect(hi.hours).toBe(24);
    expect(hi.holds).toBe(false);
    expect(r.survives).toBe(false);
    expect(lo.hours).toBe(null);                            // −1σ, −3σ: never reaches
    expect(lo.holds).toBe(true);
    expect(hi.detail).toContain("at +6 h");
    expect(r.forecastEnvelope).toEqual({ maxFt: 3, atHours: 6 });
  });

  test("a base non-crossing that no perturbation reaches keeps the answer", () => {
    const r = robustness(nearMiss, now, 60, { ...opts, sigmaFt: 0, liftFt: 0, rmseAtHours: growing });
    expect(r.base).toBe(null);
    expect(r.rows.find((x) => x.key === "fc_hi")!.hours).toBe(null);
    expect(r.rows.find((x) => x.key === "fc_hi")!.holds).toBe(true);
    expect(r.survives).toBe(true);
    expect(r.appliedCount).toBe(6);
  });

  test("an ordinary crossing is still moved by the forecast envelope", () => {
    const r = robustness(nearMiss, now, 40, { ...opts, sigmaFt: 0, liftFt: 0, rmseAtHours: growing });
    expect(r.base).toBe(18);
    const lo = r.rows.find((x) => x.key === "fc_lo")!;
    // 47 − 1 = 46 still crosses 40 at the first forecast point, so the low scenario keeps the
    // answer and its hours; only a base answering "not reached" can be turned into a crossing.
    expect(lo.hours).toBe(18);
    expect(lo.holds).toBe(true);
  });

  test("an observed-only replay has no forecast to perturb, and says so", () => {
    const observed = series.map((p) => ({ ...p, kind: "obs" as const }));
    const r = robustness(observed, now, 45, { ...opts, forecastFrom: null });
    expect(r.rows.filter((x) => x.skipped).map((x) => x.key)).toEqual(["fc_hi", "fc_lo"]);
    expect(r.rows.filter((x) => x.key.startsWith("fc"))[0].detail)
      .toContain("no forecast in this series");
    expect(r.forecastEnvelope).toBe(null);
    expect(r.appliedCount).toBe(4);
  });

  test("an answer that nothing perturbs into reversals reports survives", () => {
    const r = robustness(series, now, 10, { ...opts, sigmaFt: 0, liftFt: 0 });
    expect(r.base).toBe(0);
    expect(r.survives).toBe(true);
    expect(r.appliedCount).toBe(6);
  });

  test("the truncation row is the horizon the app quotes, and it can turn 'reached' into 'not'", () => {
    const late: Pt[] = [...series, { t: now + 96 * 3_600_000, v: 50, kind: "fc" }];
    const r = robustness(late, now, 50, { ...opts, sigmaFt: 0, liftFt: 0 });
    expect(r.base).toBe(96);
    const horizon = r.rows.find((x) => x.key === "horizon")!;
    expect(horizon.hours).toBe(null);
    expect(horizon.holds).toBe(false);
    expect(r.survives).toBe(false);
  });

  test("the perturbations are the artifact's measured numbers", () => {
    expect(spec.parameters.per_street_sigma_ft).toBeCloseTo(11.36, 2);
    expect(spec.parameters.lift_ft).toBeCloseTo(23.72, 2);
    expect(spec.parameters.forecast_rmse_beyond_measured_ft).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ I4 */

describe("I4 — bring your own forecast", () => {
  const now = Date.parse("2026-10-17T06:00:00Z");

  test("hour offsets and ISO times are both read, to the same instants", () => {
    const a = parseForecast("+6, 33.0\n+12 36.4\n+18;39.1", now);
    expect(a.errors).toEqual([]);
    expect(a.points.map((p) => p.v)).toEqual([33, 36.4, 39.1]);
    expect(a.points[0].t).toBe(now + 6 * 3_600_000);
    expect(a.points.every((p) => p.kind === "fc")).toBe(true);

    // A time with no zone is UTC, not the viewer's local clock: the same paste has to mean the
    // same instant wherever the link is opened. An explicit offset is honoured as written.
    const iso = parseForecast("2026-10-17T12:00 33.0\n2026-10-17T18:00,36.4", now);
    expect(iso.errors).toEqual([]);
    expect(iso.points[0].t).toBe(a.points[0].t);
    const offset = parseForecast("2026-10-17T07:00-05:00, 30", now);
    expect(offset.points[0].t).toBe(Date.parse("2026-10-17T12:00:00Z"));
  });

  test("every unreadable line is reported with its number and the reason", () => {
    const p = parseForecast("# a comment\n+6, 33\n\n+12, abc\n+18\n+24, 30, 31\n2020-01-01, 20", now);
    expect(p.points.map((x) => x.v)).toEqual([33]);
    expect(p.errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
    expect(p.errors[0].why).toContain("not a stage");
    expect(p.errors[1].why).toContain("time and a stage");
    expect(p.errors[2].why).toContain("more than two");
    expect(p.errors[3].why).toContain("already passed");
  });

  test("points beyond the accepted horizon are dropped and counted, never silently kept", () => {
    const p = parseForecast("+6, 30\n+400, 40\n+1000, 50", now);
    expect(p.points).toHaveLength(1);
    expect(p.tooFar).toBe(2);
  });

  test("duplicate timestamps collapse to the last value, and the count is reported", () => {
    const p = parseForecast("+6, 30\n+6, 31\n+12, 40", now);
    expect(p.points.map((x) => x.v)).toEqual([31, 40]);
    expect(p.duplicates).toBe(1);
  });

  test("applying it keeps every observation and replaces only the forecast", () => {
    const gauge: Pt[] = [
      { t: now - 6 * 3_600_000, v: 10, kind: "obs" },
      { t: now, v: 20, kind: "obs" },
      { t: now + 6 * 3_600_000, v: 30, kind: "fc" },
      { t: now + 12 * 3_600_000, v: 35, kind: "fc" },
    ];
    const user = parseForecast("+6, 40\n+12, 44\n+18, 48", now).points;
    const out = applyUserForecast(gauge, user)!;
    expect(out.series.filter((p) => p.kind === "obs")).toHaveLength(2);
    expect(out.series.filter((p) => p.kind === "fc").map((p) => p.v)).toEqual([40, 44, 48]);
    expect(out.replaced).toBe(2);
    expect(out.replacedPeakFt).toBe(35);
    expect(out.note).toContain("3 pasted points replaced 2");
  });

  test("a paste that cannot stand in for a forecast is refused rather than half-applied", () => {
    const gauge: Pt[] = [{ t: now, v: 20, kind: "obs" }, { t: now + 3_600_000, v: 25, kind: "fc" }];
    // Two points is below the floor of three: refusing is the point, because a two-point
    // "forecast" would produce a confident crossing time from a straight line.
    expect(applyUserForecast(gauge, parseForecast("+6, 30\n+12, 40", now).points)).toBe(null);
    // A series with nothing OBSERVED has no anchor: the pasted points would be the whole
    // record, and the lead time would then be a statement about the paste.
    const noObs: Pt[] = [{ t: now, v: 20, kind: "fc" }];
    expect(applyUserForecast(noObs, parseForecast("+6, 30\n+12, 40\n+18, 50", now).points)).toBe(null);
    const past = parseForecast("-1000, 30\n-999, 40\n-998, 50", now);
    expect(applyUserForecast(gauge, past.points)).toBe(null);
  });

  test("a series with no forecast at all accepts a paste and says so", () => {
    const allObs: Pt[] = [{ t: now, v: 20, kind: "obs" }];
    const out = applyUserForecast(allObs, parseForecast("+6, 30\n+12, 40\n+18, 50", now).points)!;
    expect(out.replaced).toBe(0);
    expect(out.replacedPeakFt).toBe(null);
    expect(out.note).toContain("no forecast to replace");
  });

  test("pasted points before the last observation cannot overwrite an observation", () => {
    const gauge: Pt[] = [
      { t: now - 6 * 3_600_000, v: 10, kind: "obs" },
      { t: now, v: 20, kind: "obs" },
      { t: now + 6 * 3_600_000, v: 30, kind: "fc" },
    ];
    // Three readable points, but the earliest two are in the past relative to the last
    // observation, so only one can be a forecast — below the floor, so the paste is refused.
    const user = parseForecast("+1, 40\n+2, 44\n+3, 48", now).points
      .map((p) => ({ ...p, t: p.t - 5 * 3_600_000 }));
    expect(applyUserForecast(gauge, user)).toBe(null);
  });
});
