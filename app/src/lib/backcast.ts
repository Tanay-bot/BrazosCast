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
