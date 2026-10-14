#!/usr/bin/env python3
"""
BrazosCast — Richmond gauge stage/discharge rating.

The road thresholds are derived from OWP HAND FIM, which reports, per road
segment, the *discharge* at which that segment's low point is inundated
(`threshold_discharge_cfs`). A discharge is not what the app shows and not what
a user can act on — the app shows a gauge stage.

This module turns one into the other using the gauge's own published record:
paired daily stage (USGS parameter 00065) and discharge (00060) for the Richmond
gauge, already cached by `pipeline/fetch/`. No new downloads.

Model: the standard hydrologic rating form, flow = a * (stage - s0)^c, fitted in
log-log space with s0 chosen by grid search and inverted to give stage. A plain
power law (stage = a * flow^b) was tried first and rejected: it fits the low-flow
bulk well but is badly biased across the flood range — it predicts 39.3 ft where
the record shows 55.0 ft at the largest observed flow, a 15.7 ft error at the one
event that matters most. The shifted form reduces median error to 0.36 ft overall
and 1.45 ft among stages above 35 ft.

The fit is honest about its limits. The observed record tops out at the largest
measured flow, so `stage_from_flow` reports whether a query is an extrapolation,
and the fit's error at the top of the record is published in the metadata rather
than hidden.

Usage: <env>/bin/python pipeline/derive/gauge_rating.py
Output: data/derived/gauge_rating.json
"""
import json
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
DERIVED = ROOT / "data" / "derived"

GAUGE_USGS = "08114000"
GAUGE_LID = "RMOT2"
STAGE_PARAM = "00065"   # gage height, ft
FLOW_PARAM = "00060"    # discharge, ft^3/s


def load_pairs(site: str = GAUGE_USGS) -> pd.DataFrame:
    """Paired (stage, flow) daily observations. One row per day both exist."""
    j = json.loads((RAW / f"{site}_daily.json").read_text())
    st = pd.DataFrame(j["stage_daily"])
    fl = pd.DataFrame(j["flow_daily"])
    st = st[st["parameter_code"] == STAGE_PARAM][["time", "value"]].rename(columns={"value": "stage"})
    fl = fl[fl["parameter_code"] == FLOW_PARAM][["time", "value"]].rename(columns={"value": "flow"})
    st["stage"] = pd.to_numeric(st["stage"], errors="coerce")
    fl["flow"] = pd.to_numeric(fl["flow"], errors="coerce")
    df = st.merge(fl, on="time").dropna()
    return df[df["flow"] > 0].sort_values("time").reset_index(drop=True)


def fit(site: str = GAUGE_USGS) -> dict:
    """Fit flow = a * (stage - s0)^c, inverted to stage. Returns params + diagnostics."""
    df = load_pairs(site)
    if len(df) < 100:
        raise SystemExit(f"only {len(df)} paired observations for {site} — refusing to fit")
    stage = df["stage"].to_numpy()
    flow = df["flow"].to_numpy()

    # s0 must stay below the minimum stage so (stage - s0) > 0 for every row.
    best = None
    for s0 in np.arange(-40.0, float(stage.min()) - 0.25, 0.5):
        c, log_a = np.polyfit(np.log(stage - s0), np.log(flow), 1)
        pred = (flow / np.exp(log_a)) ** (1.0 / c) + s0
        err = float(np.median(np.abs(stage - pred)))
        if best is None or err < best[0]:
            best = (err, float(s0), float(c), float(np.exp(log_a)), pred)
    _, s0, c, a, pred = best
    resid = stage - pred
    high = stage > 35.0
    return {
        "site": site,
        "lid": GAUGE_LID,
        "model": "inverted rating: stage_ft = s0 + (flow_cfs / a)^(1/c)",
        "s0": s0,
        "a": a,
        "c": c,
        "n": int(len(df)),
        "period": [str(df["time"].iloc[0]), str(df["time"].iloc[-1])],
        "r2": float(1 - (resid ** 2).sum() / ((stage - stage.mean()) ** 2).sum()),
        "median_abs_error_ft": float(np.median(np.abs(resid))),
        "median_abs_error_ft_stage_above_35": float(np.median(np.abs(resid[high]))),
        "max_abs_error_ft": float(np.max(np.abs(resid))),
        "observed_stage_ft": {"min": float(stage.min()), "max": float(stage.max())},
        "observed_flow_cfs": {"min": float(flow.min()), "max": float(flow.max())},
    }


_FIT: dict | None = None


def _params(site: str = GAUGE_USGS) -> dict:
    global _FIT
    if _FIT is None or _FIT["site"] != site:
        _FIT = fit(site)
    return _FIT


def stage_from_flow(flow_cfs: float, site: str = GAUGE_USGS) -> tuple[float, bool]:
    """Gauge stage (ft) for a discharge. Second value is True if extrapolated."""
    p = _params(site)
    stage = p["s0"] + (float(flow_cfs) / p["a"]) ** (1.0 / p["c"])
    return float(stage), bool(float(flow_cfs) > p["observed_flow_cfs"]["max"])


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    p = _params()
    (DERIVED / "gauge_rating.json").write_text(json.dumps(p, indent=2))
    print(json.dumps(p, indent=2))
    print("\nkey flows -> Richmond stage (observed record ends at "
          f"{p['observed_flow_cfs']['max']:,.0f} cfs / {p['observed_stage_ft']['max']:.2f} ft):")
    for q in (14_000, 27_000, 55_000, 120_000, 265_000, 440_000, 1_000_000):
        s, extrap = stage_from_flow(q)
        print(f"  {q:>9,} cfs -> {s:6.2f} ft{'   (extrapolated)' if extrap else ''}")
    print("Wrote data/derived/gauge_rating.json")


if __name__ == "__main__":
    main()
