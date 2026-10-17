/* The Harvey backcast's rule — pipeline/derive/backcast.py, mirrored for the browser.
 *
 * The rule is recomputed in the app rather than read off the artifact, and the artifact carries
 * a verification grid for that reason: 4 tier onsets + 13 flag counts, 17 rows the app must
 * reproduce. app/tests/unit/grid-parity.test.ts recomputes all 17 from the app's own replay
 * series and road list; the artifact's `reference_algorithm` is the same statement in prose.
 *
 * Both functions take what they need as arguments — the series, the road thresholds — so the
 * grid is checkable from a test rather than only from a running page. */
import type { Pt } from "./series";

/** A tier onset is the first hourly point at or above the tier stage, in hours from the start
 *  of the series, to 0.1 h. Null when the tier is never crossed inside the window. */
export function tierOnsets(series: readonly Pt[], tiers: readonly { stage_ft: number }[]): (number | null)[] {
  const ref = series[0]?.t ?? 0;
  return tiers.map((t) => {
    for (const p of series) {
      if (p.v >= t.stage_ft) return Math.round(((p.t - ref) / 3_600_000) * 10) / 10;
    }
    return null;
  });
}

/** Hours between a segment's own alert and the observed crest, or null when the segment's
 *  threshold was never reached inside the window — the per-street half of the backcast, which
 *  is what makes the historical claim personal (I3).
 *
 * The population it reads is the app's own replay series, and the artifact carries the whole
 * per-segment array so this can be compared row by row rather than trusted: the pipeline's
 * `street_lead_time.per_segment_h` and `verification_grid.segment_lead_h`.
 *
 * The crest is the maximum of the series rather than the published peak: in replay the series IS
 * the observation the crest was taken from (pipeline/tests/test_grid_parity.py asserts the two
 * hydrographs are identical), and reading it from the artifact would make the number unfalsifiable
 * in the browser. */
export function crestHours(series: readonly Pt[]): number {
  const ref = series[0]?.t ?? 0;
  let best = series[0];
  for (const p of series) if (p.v > best.v) best = p;
  return ((best.t - ref) / 3_600_000);
}

export function streetLeadHours(series: readonly Pt[], threshold: number): number | null {
  const ref = series[0]?.t ?? 0;
  for (const p of series) {
    if (p.v >= threshold) {
      return Math.round((crestHours(series) - (p.t - ref) / 3_600_000) * 10) / 10;
    }
  }
  return null;
}

/** A segment is flagged iff its threshold is at or below the stage; the corrected rule uses
 *  threshold + the measured probit lift. `thresholds` is every segment's flood_stage_ft — the
 *  same population the pipeline counted (1,614 segments of road_thresholds.geojson). */
export function flagCounts(thresholds: readonly number[], stage: number, lift: number): { shipped: number; corrected: number } {
  let shipped = 0, corrected = 0;
  for (const at of thresholds) {
    if (at <= stage) shipped++;
    if (at + lift <= stage) corrected++;
  }
  return { shipped, corrected };
}
