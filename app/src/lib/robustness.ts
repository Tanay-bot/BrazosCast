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
};

export type RobustOpts = {
  /** Per-street threshold error, 1 sd, in ft (ensemble.json parameters.per_street_sigma_ft). */
  sigmaFt: number;
  /** The corridor-wide measured lift, in ft (the correction the app does not apply). */
  liftFt: number;
  /** Measured forecast RMSE in ft at a given horizon in hours. */
  rmseAtHours: (hours: number) => number;
  /** Index of the first forecast point, or null when the whole series is observed. */
  forecastFrom: number | null;
  /** How far ahead the app is willing to quote, in hours (the truncation row). */
  horizonHours?: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The series with every forecast point shifted by `ft`, observations untouched. A forecast that
 *  is biased high reaches a threshold EARLIER, which is the direction that matters: a later
 *  crossing is what costs someone their window. */
function shiftForecast(series: readonly Pt[], from: number | null, ft: number): Pt[] {
  if (from === null) return [...series];
  return series.map((p, i) => (i >= from ? { ...p, v: p.v + ft } : p));
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

  const fcSkip = opts.forecastFrom === null
    ? "no forecast in this series"
    : "the answer is already 'not reached', and forecast error cannot change that";
  if (opts.forecastFrom !== null && base !== null) {
    // The forecast error is quoted at the horizon the base answer lands on, which is the only
    // horizon that can change THIS answer.
    const err = round1(opts.rmseAtHours(base));
    const shifted = shiftForecast(series, opts.forecastFrom, err);
    push("fc_hi", "Forecast 1σ high", `every forecast point +${err.toFixed(1)} ft at this horizon`,
      shifted, threshold);
    push("fc_lo", "Forecast 1σ low", `every forecast point −${err.toFixed(1)} ft at this horizon`,
      shiftForecast(series, opts.forecastFrom, -err), threshold);
  } else {
    push("fc_hi", "Forecast 1σ high", fcSkip, series, threshold, false);
    push("fc_lo", "Forecast 1σ low", fcSkip, series, threshold, false);
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
  };
}
