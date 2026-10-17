/* The stage series both kernels read: gauge readings and forecast points on one clock.
 *
 * Its own module rather than a type declared inside one kernel, because two kernels read it —
 * and a kernel that imported another kernel only for a type would tie them together for no
 * reason. `kind` is the observed/forecast boundary the ensemble perturbs past. */
export type Pt = { t: number; v: number; kind: "obs" | "fc" };
