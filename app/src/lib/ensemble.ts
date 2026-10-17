/* The uncertainty ensemble's kernel — a line-by-line mirror of pipeline/derive/ensemble.py.
 *
 * It lives in a module rather than inside main.ts because it is implemented TWICE, in two
 * languages, and "the two agree" has to be checkable without a browser: the pipeline emits a
 * verification grid the app must reproduce exactly, and until now that grid was reproducible
 * only through the DEV-only inspection hook, which no CI can see.
 * app/tests/unit/grid-parity.test.ts recomputes every row of it through these functions, and
 * pipeline/tests/test_grid_parity.py runs that test from the project's one check command.
 *
 * Nothing here reads app state. The series, the instant lead times are measured from, and the
 * observed/forecast boundary are arguments — which is what lets the pipeline's grid, computed
 * on the replay hydrograph with its own boundary index, be reproduced from a test.

 * The PRNG is mulberry32 in both languages (Math.imul is the low 32 bits of the product, which
 * is why the Python side masks), and the drawn values are rounded to 6 dp so that libm and V8
 * differing in the last ulp cannot move a draw across a hydrograph point and change the
 * reported count. */
import type { Pt } from "./series";

/* The uncertainty the point estimate hides (pipeline/derive/ensemble.py).
 * Parameters AND the algorithm come from the pipeline, and the app must reproduce the
 * pipeline's verification grid — the same cross-language check the crest transfer and
 * the Dijkstra already get. Nothing here is invented in the browser. */
export type EnsembleOut = {
  members: number; crossing: number; of: number;
  median_h: number | null; p10_h: number | null; p90_h: number | null; never_h: number;
};
export type EnsembleSpec = {
  parameters: {
    members: number; seed: number; lift_ft: number; per_street_sigma_ft: number;
    forecast_rmse_knots_ft: [number, number][]; forecast_rmse_beyond_measured_ft: number;
  };
  verification_grid: ({ threshold_ft: number; forecast_from: number | null; mode: string }
    & EnsembleOut)[];
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = (t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0 ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return Math.round(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 1e6) / 1e6;
}

/* Measured forecast RMSE (ft) at a given horizon in days: linear between the knots the
 * benchmark produced, zero at zero, and held at the longest measured horizon beyond it. */
export function rmseFt(days: number, spec: EnsembleSpec): number {
  const k = spec.parameters.forecast_rmse_knots_ft;
  if (days <= 0) return 0;
  if (days >= k[k.length - 1][0]) return spec.parameters.forecast_rmse_beyond_measured_ft;
  if (days < k[0][0]) return (k[0][1] * days) / k[0][0];
  for (let i = 0; i + 1 < k.length; i++) {
    const [d0, v0] = k[i], [d1, v1] = k[i + 1];
    if (days >= d0 && days <= d1) return v0 + ((v1 - v0) * (days - d0)) / (d1 - d0);
  }
  return spec.parameters.forecast_rmse_beyond_measured_ft;
}

/** Where the observation stops and the forecast begins, or null when the whole series is
 *  observed (replay): the perturbation is applied only past this boundary, so in replay the
 *  spread the ensemble reports is the threshold error alone. */
export function firstForecastIndex(series: readonly Pt[]): number | null {
  const i = series.findIndex((p) => p.kind === "fc");
  return i < 0 ? null : i;
}

/** `ref` is the instant the reported hours are measured from — now, in live mode; the start
 *  of the record, in replay. `forecastFrom` is an index into `series`, or null for none. */
export function runEnsemble(threshold: number, spec: EnsembleSpec, series: readonly Pt[],
  ref: number, forecastFrom: number | null): EnsembleOut {
  const { members, seed, lift_ft, per_street_sigma_ft } = spec.parameters;
  const rng = mulberry32(seed);
  const hours: number[] = [];
  for (let m = 0; m < members; m++) {
    const tau = Math.round((threshold + lift_ft + per_street_sigma_ft * gauss(rng)) * 1e4) / 1e4;
    // Forecast error is a random walk whose cumulative sd at each horizon equals the
    // measured RMSE there, so it grows the way the benchmark says it does. Observed
    // points are never perturbed — in replay that leaves only the threshold term.
    let z = 0, prevVar = 0, hit: number | null = null;
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      let v = p.v;
      if (forecastFrom !== null && i >= forecastFrom) {
        const var_ = rmseFt((p.t - ref) / 86_400_000, spec) ** 2;
        z += Math.sqrt(Math.max(0, var_ - prevVar)) * gauss(rng);
        prevVar = var_;
        v = v + z;
      }
      if (v >= tau) { hit = Math.round(Math.max(0, (p.t - ref) / 3_600_000) * 1e3) / 1e3; break; }
    }
    if (hit !== null) hours.push(hit);
  }
  hours.sort((a, b) => a - b);
  const q = (p: number) => {
    if (!hours.length) return null;
    const idx = (hours.length - 1) * (p / 100);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const val = hours[lo] + (hours[hi] - hours[lo]) * (idx - lo);
    return Math.round(val * 100) / 100;
  };
  return { members, crossing: hours.length, of: members,
    median_h: q(50), p10_h: q(10), p90_h: q(90), never_h: members - hours.length };
}
