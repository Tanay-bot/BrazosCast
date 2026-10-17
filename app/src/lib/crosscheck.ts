/* I2 — two gauges, one answer.
 *
 * The redundancy path (pipeline/derive/gauge_redundancy.py) exists for the day RMOT2 stops
 * reporting: it transfers an upstream stage down the reach with a lag, and the app uses it only
 * past the measured crossover. That is a CONTINGENCY, and it throws away the thing a second
 * gauge is worth when both are working — a check on the reading the whole app is keyed to.
 *
 * This module runs the same transfer whenever the upstream gauges have data, at the lag their
 * own agreement was fitted at, and reports the DIVERGENCE from the live Richmond reading against
 * the band that pipeline measured on held-out events. It is not a second forecast and it is not
 * a correction: it is the only number in the app that can be wrong in a way the app notices.
 *
 * The knots, the lags and the band are arguments, because they are the artifact's numbers and
 * app/tests/unit/bets.test.ts drives them from the artifact itself.
 */
import { applyTransferClamped, type Transfer } from "./transfer";

export type Sample = { t: number; v: number };
export type UpstreamReading = { lid: string; transfer: Transfer; series: readonly Sample[] };

export type CrossRow = {
  lid: string; name: string; lagH: number;
  upstreamFt: number | null; estimateFt: number; divergenceFt: number;
  clamped: boolean; agrees: boolean;
};

/** Nearest reading to `targetMs`, or null when the series has nothing within `tolMs`. */
export function valueAt(series: readonly Sample[], targetMs: number, tolMs: number): number | null {
  let best = Infinity, out: number | null = null;
  for (const p of series) {
    const d = Math.abs(p.t - targetMs);
    if (d < best) { best = d; out = p.v; }
  }
  return best <= tolMs ? out : null;
}

export type CrossVerdict = {
  rows: CrossRow[];
  /** True when at least one gauge INSIDE the fitted range disagrees by more than the band. */
  flagged: boolean;
  /** Gauges that had a reading at the lag they need. The rest are named as missing. */
  missing: string[];
  /** Rows whose upstream value fell inside the range the transfer was fitted on. */
  inRange: number;
  note: string;
};

const round2 = (x: number) => Math.round(x * 100) / 100;

export function crossCheck(observed: number, gauges: readonly UpstreamReading[],
  now: number, band: readonly [number, number], tolMs = 3 * 3_600_000): CrossVerdict {
  const [lo, hi] = band;
  const rows: CrossRow[] = [];
  const missing: string[] = [];
  for (const g of gauges) {
    const lagH = g.transfer.lag_h_used;
    const upstreamFt = valueAt(g.series, now - lagH * 3_600_000, tolMs);
    if (upstreamFt === null) { missing.push(g.transfer.name); continue; }
    const applied = applyTransferClamped(g.transfer, upstreamFt);
    const divergenceFt = applied.v - observed;
    rows.push({
      lid: g.lid, name: g.transfer.name, lagH,
      upstreamFt: round2(upstreamFt), estimateFt: round2(applied.v),
      divergenceFt: round2(divergenceFt), clamped: applied.clamped,
      // The band is the measured error of this transfer, so "inside the band" is the only
      // agreement claim this module is entitled to make — and a clamped knot is outside the
      // range the band was measured over, so it never counts as agreement.
      agrees: !applied.clamped && divergenceFt >= lo && divergenceFt <= hi,
    });
  }
  // A clamped row is OUTSIDE the range the transfer was fitted on — it was fitted on flood
  // events, so a quiet river parks both gauges on a floor value and the two "estimates" are the
  // ends of the fitted curve, not predictions. Measured in the browser on a quiet day: both
  // gauges clamped and both read ~2 ft above the live stage, which a naive verdict would have
  // reported as a disagreement — a check that cannot be made is not a failure, and saying it was
  // would put a permanent false alarm in front of the one number the page is about.
  const defined = rows.filter((r) => !r.clamped);
  const flagged = defined.some((r) => !r.agrees);
  const note = !rows.length
    ? "No upstream gauge had a reading at the lag its transfer needs."
    : !defined.length
      ? `${rows.length === 1 ? "The upstream gauge is" : "Both upstream gauges are"} below the ` +
        `range this transfer was fitted on (flood events), so the reading is a clamped floor, ` +
        `not a check. Drag the stage up, or read it when the river is high.`
      : flagged
        ? `⚠ ${defined.filter((r) => !r.agrees).map((r) => r.name).join(" and ")} disagree(s) with ` +
          `the live reading by more than the measured band (${lo} to +${hi} ft).`
        : `${defined.length === 1 ? "One gauge" : "Both gauges"} agree(s) with the live reading ` +
          `inside the measured band (${lo} to +${hi} ft, held-out events). This is a check on the ` +
          `transfer, not a second forecast.`;
  return { rows, flagged, missing, inRange: defined.length, note };
}
