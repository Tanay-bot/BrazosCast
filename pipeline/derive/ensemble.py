#!/usr/bin/env python3
"""
BrazosCast — Step 7: the uncertainty the point estimate hides.

The app answers "water reaches your street at stage X", where X is one number from
one model. Step 6 measured how wrong those numbers are and found TWO things, and only
the first is widely appreciated:

  * the corridor is off by a CONSTANT (lift +23.7 ft), which is a bias to correct; and
  * two streets with the SAME threshold differ by sigma = 11.4 ft (1 sd), which is not.

The second is the uncertainty a household actually faces and the point estimate cannot
express. So this module turns the fitted error model into an ensemble: draw each
street's true flood stage from the measured distribution, draw the forecast's own
measured error, and report the resulting DISTRIBUTION of lead times —
"37 of 50 runs reach your street", not "31 hours".

Two measured inputs, no invented parameters:
  slope   : data/derived/harvey_validation.json  -> lift_ft, per_street_sigma_ft
  forecast: data/derived/model_forecast_benchmark.csv -> RMSE by horizon (xgboost,
            holdout 2016-17), which is an error curve that GROWS with horizon

The same algorithm is implemented in app/src/main.ts, and this module emits a
verification grid the app must reproduce — the check the transfer function and the
Dijkstra already get, so the ensemble is auditable rather than asserted.

WHAT THIS IS NOT. It is not a probability of flooding and not a confidence interval on
a measured quantity: sigma is unexplained variance from a single event, so it absorbs
genuine per-reach differences and everything the HAND model cannot see. In replay the
hydrograph is observed, so only the threshold term is active — stated in the artifact.

Input : data/derived/harvey_validation.json, data/derived/model_forecast_benchmark.csv,
        data/raw/usgs/iv/08114000_20170822.json
Output: data/derived/ensemble.json
Usage : <env>/bin/python pipeline/derive/ensemble.py
"""
import json
import math
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
IVCACHE = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20170822.json"

MEMBERS = 50
SEED = 20261014
FORECAST_FLOOR_FT = 6.057      # measured +7 d RMSE, held beyond the measured range

# RMSE (ft) by days ahead, from model_forecast_benchmark.csv for the shipped model.
RMSE_KNOTS = [(1.0, 1.159335767351426), (2.0, 2.1626943913098886),
              (3.0, 3.568178711656254), (5.0, 5.365043746179423),
              (7.0, 6.057353872726056)]


def rmse_ft(days: float) -> float:
    """Measured horizon error, linear between knots, 0 at 0 d, held at 7 d beyond."""
    if days <= 0:
        return 0.0
    if days >= RMSE_KNOTS[-1][0]:
        return FORECAST_FLOOR_FT
    if days < RMSE_KNOTS[0][0]:
        f, v = RMSE_KNOTS[0]
        return v * days / f
    for (d0, v0), (d1, v1) in zip(RMSE_KNOTS, RMSE_KNOTS[1:]):
        if d0 <= days <= d1:
            return v0 + (v1 - v0) * (days - d0) / (d1 - d0)
    return FORECAST_FLOOR_FT


def mulberry32(seed: int):
    """The exact PRNG app/src/main.ts implements, so both languages agree bit for bit.
    Math.imul(a, b) is the low 32 bits of a*b, which masking reproduces in Python."""
    a = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return nxt


def gauss(rng) -> float:
    """Box-Muller. Rounded to 6 dp because libm and V8 differ in the last ulp, and an
    ulp difference must not be able to move a draw across a hydrograph point and change
    the reported count between the two implementations."""
    u1 = max(rng(), 1e-12)
    u2 = rng()
    return round(math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2), 6)


def ensemble(threshold: float, series: list, ref_ms: float, forecast_from,
             lift: float, sigma: float, members: int = MEMBERS,
             seed: int = SEED) -> dict:
    """The algorithm, in the form app/src/main.ts mirrors exactly.

    series: [[t_ms, stage_ft], ...] ascending. forecast_from: index of the first
    FORECAST point, or None when the whole series is observed (replay).
    """
    rng = mulberry32(seed)
    base_days = [(t - ref_ms) / 86_400_000.0 for t, _ in series]
    crossing, hours = 0, []
    for _ in range(members):
        tau = round(threshold + lift + sigma * gauss(rng), 4)
        # Forecast error is a random walk whose cumulative sd at each horizon equals the
        # measured RMSE there, so the perturbation grows the way the benchmark says it
        # does instead of being flat noise. Observed points are untouched.
        z, prev_var = 0.0, 0.0
        hit = None
        for i, (t, v) in enumerate(series):
            if forecast_from is not None and i >= forecast_from:
                var = rmse_ft(base_days[i]) ** 2
                step = math.sqrt(max(0.0, var - prev_var))
                z += step * gauss(rng)
                prev_var = var
                v = v + z
            if v >= tau:
                hit = round(max(0.0, (t - ref_ms) / 3_600_000.0), 3)
                break
        if hit is not None:
            crossing += 1
            hours.append(hit)
    hours.sort()

    def q(p: float):
        if not hours:
            return None
        return round(float(np.percentile(hours, p)), 2)

    return {"members": members, "crossing": crossing, "of": members,
            "median_h": q(50), "p10_h": q(10), "p90_h": q(90),
            "never_h": members - crossing}


def replay_series() -> list:
    """The hourly Harvey series, built exactly as pipeline/export/app_data.py builds the
    replay artifact, so the verification grid is computed on the app's own series."""
    rows = json.loads(IVCACHE.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["t", "v"]).drop_duplicates("t").sort_values("t")
    df = df.set_index("t").resample("1h")["v"].mean().dropna()
    return [[int(ts.value // 1_000_000), round(float(v), 2)] for ts, v in df.items()]


def main():
    hv_path = DERIVED / "harvey_validation.json"
    if not hv_path.exists():
        raise SystemExit("run pipeline/derive/harvey_validation.py first")
    hv = json.loads(hv_path.read_text())
    tm = hv["diagnosis"]["threshold_error_model"]
    lift, sigma = tm["lift_ft"], tm["per_street_sigma_ft"]
    print(f"measured error model: lift {lift:+.2f} ft, per-street sigma {sigma:.2f} ft")

    series = replay_series()
    ref = series[0][0]
    print(f"replay series: {len(series)} hourly points, {pd.Timestamp(ref, unit='ms')}")

    # --- the sentence the product should be able to say -------------------------
    # On the Harvey hydrograph, how the answer changes with the measured uncertainty,
    # for streets across the threshold range.
    demo = []
    for thr in (20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0):
        e = ensemble(thr, series, ref, None, lift, sigma)
        # The shipped point estimate: first crossing of the UNCORRECTED threshold.
        point = next(((t - ref) / 3_600_000.0 for t, v in series if v >= thr), None)
        demo.append({"threshold_ft": thr,
                     "point_estimate_h": round(point, 1) if point is not None else None,
                     "ensemble": e})
        print(f"  threshold {thr:>4.0f} ft -> point estimate "
              f"{('%6.1f h' % point) if point is not None else '   none'}"
              f" | ensemble {e['crossing']:>2}/{e['of']} cross, median "
              f"{e['median_h']}h [{e['p10_h']}-{e['p90_h']}]")

    thr = 30.0
    e_thr = ensemble(thr, series, ref, None, lift, sigma)
    e_bias = ensemble(thr, series, ref, None, 0.0, 0.0)
    print(f"\nspread on the replay hydrograph is entirely threshold-driven "
          f"(observed series is not perturbed): {e_thr['crossing']}/{e_thr['of']} cross; "
          f"with lift and sigma both zero {e_bias['crossing']}/{e_bias['of']} cross")

    # --- verification grid: the app must reproduce every row ---------------------
    # forecast_from exercises the forecast-error path on a deterministic input, which
    # the live series cannot be (it changes with every NWS update).
    grid = []
    for thr in (15.0, 22.5, 28.0, 33.4, 38.0, 42.5, 47.0, 52.0):
        for ff, tag in ((None, "observed_only"), (len(series) // 3, "third_forecast")):
            r = ensemble(thr, series, ref, ff, lift, sigma)
            grid.append({"threshold_ft": thr, "forecast_from": ff, "mode": tag, **r})
    print(f"\nverification grid: {len(grid)} rows for the browser cross-check")

    # --- gates -------------------------------------------------------------------
    assert gauss(mulberry32(1)) == gauss(mulberry32(1)), "the PRNG is not reproducible"
    assert abs(rmse_ft(0.0)) < 1e-9 and abs(rmse_ft(1.0) - RMSE_KNOTS[0][1]) < 1e-9, \
        "the forecast error curve does not pass through its measured knots"
    assert all(rmse_ft(a) <= rmse_ft(b) + 1e-9 for a, b in
               zip(np.linspace(0, 8, 65), np.linspace(0, 8, 65)[1:])), \
        "forecast error must not decrease with horizon"
    assert (lift > 0) and (sigma > 0), "the error model is not the measured one"
    assert all(g["crossing"] <= g["of"] for g in grid), "crossing count exceeds members"
    assert all(g["median_h"] is None or g["p10_h"] <= g["median_h"] <= g["p90_h"]
               for g in grid), "ensemble quantiles are not ordered"
    increasing = [g["crossing"] for g in grid if g["mode"] == "observed_only"]
    assert increasing == sorted(increasing, reverse=True), (
        "a higher threshold must not cross more often — the ensemble is inverted")
    assert any(g["crossing"] != g["of"] for g in grid), \
        "no grid row is uncertain; the ensemble is not carrying any spread"
    print("all gates passed (parameters measured, ordering sane, spread non-empty)")

    out = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "step": "UPGRADE-PLAN.md Step 7 — uncertainty ensemble",
        "question": "given what the 2017 flood measured about these thresholds, when "
                    "does water reach this street, as a distribution?",
        "answer_template": "{crossing} of {of} runs reach this street within the window",
        "parameters": {
            "members": MEMBERS, "seed": SEED,
            "lift_ft": lift, "per_street_sigma_ft": sigma,
            "lift_ci90_ft": tm["lift_ci90_ft"], "sigma_ci90_ft": tm["sigma_ci90_ft"],
            "forecast_rmse_knots_ft": RMSE_KNOTS,
            "forecast_rmse_beyond_measured_ft": FORECAST_FLOOR_FT,
        },
        "method": {
            "threshold": "true flood stage = shipped threshold + lift + sigma*N(0,1), "
                         "the probit model fitted in harvey_validation.py",
            "hydrograph": "forecast points are perturbed by a random walk whose "
                          "cumulative sd at each horizon equals the measured RMSE there; "
                          "observed points are left alone, so in replay only the "
                          "threshold term is active",
            "prng": "mulberry32 + Box-Muller, identical in both languages",
            "reported_hours": "quantiles over the members that cross; the count is the "
                              "headline and 'never_h' is always reported too",
        },
        "sources": {
            "threshold_error": "data/derived/harvey_validation.json "
                               "(USGS SIR 2018-5070 extent, doi:10.5066/F7VH5N3N)",
            "forecast_error": "data/derived/model_forecast_benchmark.csv "
                              "(xgboost, holdout 2016-17, which contains Harvey)",
        },
        "replay_demonstration": demo,
        "replay_spread_is_threshold_only": {
            "threshold_30ft": e_thr, "lift_and_sigma_zero": e_bias},
        "verification_grid": grid,
        "limits": [
            "sigma is unexplained variance from ONE event: it absorbs real per-reach "
            "differences (culverts, levees, the HAND reference error) and everything the "
            "model cannot see, so it is an uncertainty budget, not a mechanism",
            "this is not a probability of flooding and not a confidence interval on a "
            "measured quantity",
            "the forecast error curve is measured on this gauge's daily record, and is "
            "applied here to an hourly hydrograph",
            "replay mode carries no forecast uncertainty because the series is observed, "
            "so its spread understates what a live forecast would carry",
            "the lift is not applied to the shipped thresholds anywhere in the app; the "
            "ensemble is reported alongside the point estimate, never in place of it",
        ],
    }
    (DERIVED / "ensemble.json").write_text(json.dumps(out, indent=2))
    print("\nWrote data/derived/ensemble.json")


if __name__ == "__main__":
    main()
