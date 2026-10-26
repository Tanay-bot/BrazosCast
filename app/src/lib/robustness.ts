/* I6 — does the answer survive the errors we have measured?
 *
 * Every number the app publishes descends from two estimated quantities: a street's flood stage,
 * which the Harvey validation measured as running ~22 ft low corridor-wide with about 11 ft of
 * per-street spread, and the forecast, whose error the benchmark measured at a handful of
 * horizons. The headline quotes a point lead time and says nothing about either.
 *
 * This module perturbs the series and the threshold by exactly those two measured errors and
 * asks the only question that matters for a decision: does the ANSWER change? "Water reaches your
 * street in 31 hours" that becomes 22–41 h under the measured error is a different product from
 * one that becomes "in 31 h or never in the window".
 *
 * Three deliberate choices:
 *
 *   * the perturbations are the artifacts' own numbers (sigma, lift, the RMSE knots), never
 *     chosen here — app/tests/unit/bets.test.ts drives them from ensemble.json;
 *   * the corridor bias is applied as a DIRECTION the app does not act on: it is disclosed, not
 *     corrected (one event), so it appears as a row showing what correcting it would do;
 *   * "holds" is about the qualitative claim only — whether the street is reached inside the
 *     window at all — because that is the claim a household acts on, and a lead time that moves
 *     from 31 h to 22 h does not change it while a lead time that vanishes does.
 *
 * The forecast rows are an ENVELOPE, not one offset. The measured RMSE grows with lead time, so
 * each forecast point is shifted by the error at ITS OWN horizon, counted from the first forecast
 * point (the issue time the benchmark scores from). Two consequences matter:
 *
 *   * the perturbation no longer depends on there being a base crossing. Until this was fixed the
 *     forecast rows were skipped when the base answer was "not reached" — but a forecast that is
 *     biased high is exactly how a non-crossing becomes a crossing, which is the direction that
 *     costs someone their window. A non-crossing is now perturbed like any other answer and may
 *     well come back "reached".
 *   * it is an ASSUMPTION when applied to the official NOAA forecast. The curve was measured on
 *     this project's own model, not on NOAA's; the UI says so wherever these rows are shown.
 */
import type { Pt } from "./series";

/** Hours from `ref` until the first point at or above `threshold`, or null inside the window. */
export function crossingHoursIn(series: readonly Pt[], ref: number, threshold: number): number | null {
  for (const p of series) {
    if (p.v >= threshold) return Math.max(0, (p.t - ref) / 3_600_000);
  }
  return null;
}

export type RobustRow = {
  key: string;
  label: string;
  /** What was changed, in the units it was changed in. */
  detail: string;
  hours: number | null;
  /** Hours relative to the base answer, in hours (positive = later). Null when either is null. */
  delta: number | null;
  /** False when this row turns "reached inside the window" into "not reached", or back. */
  holds: boolean;
  /** True when the perturbation could not be applied to this series (no forecast, say). */
  skipped: boolean;
};

export type RobustOut = {
  base: number | null;
  rows: RobustRow[];
  /** True when every applicable perturbation keeps the same qualitative answer. */
  survives: boolean;
  appliedCount: number;
  /** The largest forecast error the envelope applied, in ft, and the horizon it applies at. */
  forecastEnvelope: { maxFt: number; atHours: number } | null;
};

export type RobustOpts = {
  /** Per-street threshold error, 1 sd, in ft (ensemble.json parameters.per_street_sigma_ft). */
  sigmaFt: number;
  /** The corridor-wide measured lift, in ft (the correction the app does not apply). */
  liftFt: number;
  /** Measured forecast RMSE in ft at a LEAD time in hours, counted from the first forecast
   *  point — the issue time the benchmark scores from, not from `ref`. */
  rmseAtHours: (hours: number) => number;
  /** Index of the first forecast point, or null when the whole series is observed. */
  forecastFrom: number | null;
  /** How far ahead the app is willing to quote, in hours (the truncation row). */
  horizonHours?: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The series with every forecast point shifted by the error measured at its own horizon,
 *  observations untouched. `sign` is +1 for the high scenario and −1 for the low one. A
 *  forecast biased high reaches a threshold EARLIER; a low one reaches it later or not at
 *  all, which is the direction that costs someone their window. */
function envelope(series: readonly Pt[], from: number, rmseAtHours: (h: number) => number,
  sign: number): { pts: Pt[]; maxFt: number; atHours: number } {
  const anchor = series[from].t;
  let maxFt = 0;
  let atHours = 0;
  const pts = series.map((p, i) => {
    if (i < from) return p;
    const hours = Math.max(0, (p.t - anchor) / 3_600_000);
    const sigma = Math.max(0, rmseAtHours(hours));
    if (sigma > maxFt) { maxFt = sigma; atHours = hours; }
    return { ...p, v: p.v + sign * sigma };
  });
  return { pts, maxFt: round1(maxFt), atHours: Math.round(atHours) };
}

export function robustness(series: readonly Pt[], ref: number, threshold: number,
  opts: RobustOpts): RobustOut {
  const base = crossingHoursIn(series, ref, threshold);
  const rows: RobustRow[] = [];
  const push = (key: string, label: string, detail: string, s: readonly Pt[], thr: number,
    applicable = true) => {
    if (!applicable) {
      rows.push({ key, label, detail, hours: null, delta: null, holds: true, skipped: true });
      return;
    }
    const hours = crossingHoursIn(s, ref, thr);
    rows.push({
      key, label, detail,
      hours: hours === null ? null : round1(hours),
      delta: hours === null || base === null ? null : round1(hours - base),
      holds: (hours === null) === (base === null),
      skipped: false,
    });
  };

  push("thr_hi", "Threshold +1σ", `the street floods ${opts.sigmaFt.toFixed(1)} ft later than modelled`,
    series, threshold + opts.sigmaFt);
  push("thr_lo", "Threshold −1σ", `the street floods ${opts.sigmaFt.toFixed(1)} ft earlier than modelled`,
    series, threshold - opts.sigmaFt);
  push("lift", "Measured corridor bias removed",
    `the +${opts.liftFt.toFixed(1)} ft lift the 2017 extent implies, deliberately not applied`,
    series, threshold + opts.liftFt);

  // The envelope is computed whether or not the base answer crosses: an upward shift is the one
  // way a "not reached" becomes "reached", and skipping it reported that answer as surviving.
  let forecastEnvelope: RobustOut["forecastEnvelope"] = null;
  if (opts.forecastFrom !== null && opts.forecastFrom < series.length) {
    const hi = envelope(series, opts.forecastFrom, opts.rmseAtHours, +1);
    const lo = envelope(series, opts.forecastFrom, opts.rmseAtHours, -1);
    forecastEnvelope = { maxFt: hi.maxFt, atHours: hi.atHours };
    const what = `every forecast point shifted by the RMSE measured at its own horizon ` +
      `(up to ${hi.maxFt.toFixed(1)} ft at +${hi.atHours} h)`;
    push("fc_hi", "Forecast 1σ high", what, hi.pts, threshold);
    push("fc_lo", "Forecast 1σ low", what, lo.pts, threshold);
  } else {
    const why = opts.forecastFrom === null
      ? "no forecast in this series — the whole record is observed"
      : "the forecast index is past the end of this series";
    push("fc_hi", "Forecast 1σ high", why, series, threshold, false);
    push("fc_lo", "Forecast 1σ low", why, series, threshold, false);
  }

  const horizon = opts.horizonHours ?? 72;
  const cutoff = ref + horizon * 3_600_000;
  push("horizon", `Inside ${horizon} h`, "the same rule, quoted only as far ahead as the ladder is trusted",
    series.filter((p) => p.t <= cutoff), threshold);

  const applied = rows.filter((r) => !r.skipped);
  return {
    base: base === null ? null : round1(base),
    rows,
    survives: applied.every((r) => r.holds),
    appliedCount: applied.length,
    forecastEnvelope,
  };
}
