/* The upstream→Richmond stage transfer — the interpolation half of
 * pipeline/derive/gauge_redundancy.py, which fits the knots and measures the band this applies.
 *
 * The pipeline interpolates with `np.interp(x, u, r, left=r[0], right=r[-1])`: piecewise-linear
 * through binned medians, clamped outside the fitted range. The app has to do the same thing,
 * and the clamp is reported rather than hidden, because the transfer is fitted on FLOOD events —
 * an upstream stage below the fitted range yields the floor value, and the uncertainty band
 * measured over the fitted range does not describe that case. Quoting the band anyway would be
 * a lie. app/tests/unit/grid-parity.test.ts checks the knots, the clamp and the bracket against
 * the artifact's own numbers. */
export type Transfer = { name: string; usgs: string; lag_h: number; lag_h_used: number; u_ft: number[]; r_ft: number[] };

/** The same clamped piecewise-linear interpolation the pipeline validated, with the
 *  clamp reported. */
export function applyTransferClamped(t: Transfer, x: number): { v: number; clamped: boolean } {
  const u = t.u_ft, r = t.r_ft;
  if (x <= u[0]) return { v: r[0], clamped: true };
  if (x >= u[u.length - 1]) return { v: r[r.length - 1], clamped: true };
  for (let i = 1; i < u.length; i++) {
    if (x <= u[i]) {
      const f = (x - u[i - 1]) / (u[i] - u[i - 1] || 1);
      return { v: r[i - 1] + f * (r[i] - r[i - 1]), clamped: false };
    }
  }
  return { v: r[r.length - 1], clamped: true };
}

export function applyTransfer(t: Transfer, x: number): number {
  return applyTransferClamped(t, x).v;
}
