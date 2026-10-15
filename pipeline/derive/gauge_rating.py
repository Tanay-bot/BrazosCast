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

WHY NOT A CLOSED-FORM CURVE
  Two analytic forms were fitted and both were rejected on the same
  measurement — the largest event on record (2017-08-31, Hurricane Harvey:
  55.01 ft at 120,000 cfs):

    * plain power law, stage = a * flow^b — predicts 39.3 ft there, 15.7 ft low;
    * shifted power law, stage = s0 + (flow/a)^(1/c) — predicts 71.58 ft there,
      16.6 ft high, while fitting the low-flow bulk to 0.34 ft.

  The direction of the two errors is the diagnostic: the observed curve
  FLATTENS at high stage (102,000 cfs gives 54.65 ft, not 64 ft), and no
  three-parameter power form bends that way. This is not scatter — the top of
  the record is clean and monotone (54.65 ft at 102,000 cfs, 55.01 at 120,000).

WHAT IS USED INSTEAD
  A monotone piecewise-cubic (PCHIP, Fritsch-Carlson) curve through the median
  stage of 40 log-spaced flow bins, with the record's peak appended as an exact
  knot. Monotone by construction, and it reproduces the data everywhere:

    median |error| 0.28 ft (was 0.34)
    stage > 35 ft  1.12 ft   (was 2.73)
    stage > 45 ft  1.14 ft   (was ~5-9)
    max |error|    4.01 ft   (was 16.57)
    observed peak  0.00 ft   (was -16.57)

  Beyond the record the curve continues as a local power-law tail anchored at
  the top knot and fitted on the stage >= 45 ft points, so it stays continuous
  and monotone. `stage_from_flow` reports whether a query is extrapolation, and
  the error metrics above are published in the artifact rather than hidden.

Usage: <env>/bin/python pipeline/derive/gauge_rating.py
Output: data/derived/gauge_rating.json
"""
import json
import pathlib

import numpy as np
import pandas as pd
from scipy.interpolate import PchipInterpolator

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
DERIVED = ROOT / "data" / "derived"

GAUGE_USGS = "08114000"
GAUGE_LID = "RMOT2"
STAGE_PARAM = "00065"   # gage height, ft
FLOW_PARAM = "00060"    # discharge, ft^3/s

KNOT_BINS = 40          # log-spaced flow bins, one median-stage knot each
TAIL_FROM_FT = 45.0     # stage above which the extrapolation tail is fitted
MIN_BIN_N = 5           # a bin thinner than this contributes no knot


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


def _knots(flow: np.ndarray, stage: np.ndarray, bins: int = KNOT_BINS):
    """Median stage per log-spaced flow bin, forced non-decreasing, peak anchored."""
    edges = np.unique(np.exp(np.linspace(np.log(flow[0]), np.log(flow[-1]), bins + 1)))
    idx = np.clip(np.digitize(flow, edges) - 1, 0, len(edges) - 2)
    kf, ks = [], []
    for b in range(len(edges) - 1):
        m = idx == b
        if int(m.sum()) < MIN_BIN_N:
            continue
        kf.append(float(np.median(flow[m])))
        ks.append(float(np.median(stage[m])))
    kf.append(float(flow[-1]))          # the observed peak, as an exact knot
    ks.append(float(stage[-1]))
    kf = np.asarray(kf)
    ks = np.maximum.accumulate(np.asarray(ks))   # a rating cannot fall with flow
    uniq = np.concatenate(([True], np.diff(kf) > 1e-9))
    return kf[uniq], ks[uniq]


def fit(site: str = GAUGE_USGS) -> dict:
    """Monotone rating + diagnostics. Returns params, knots and error metrics."""
    df = load_pairs(site)
    if len(df) < 100:
        raise SystemExit(f"only {len(df)} paired observations for {site} — refusing to fit")
    flow = np.sort(df["flow"].to_numpy())
    stage = df.sort_values("flow")["stage"].to_numpy()

    kf, ks = _knots(flow, stage)
    curve = PchipInterpolator(np.log(kf), ks)
    pred = curve(np.log(np.clip(flow, kf[0], kf[-1])))
    resid = stage - pred

    # extrapolation tail: local power law through the top knot, fitted on the
    # flood range only. s = s_top * (Q / Q_top) ** p, so it passes through
    # (Q_top, s_top) exactly and stays monotone for p > 0.
    q_top, s_top = float(kf[-1]), float(ks[-1])
    hi = stage >= TAIL_FROM_FT
    x = np.log(flow[hi] / q_top)
    y = np.log(stage[hi] / s_top)
    p_tail = float((x @ y) / (x @ x)) if len(x) and (x @ x) > 0 else 0.25

    def err(sel):
        return float(np.median(np.abs(resid[sel]))) if sel.any() else None

    return {
        "site": site,
        "lid": GAUGE_LID,
        "model": ("monotone PCHIP through median stage of 40 log-spaced flow bins, "
                  "peak anchored; power-law tail above the record"),
        "n": int(len(df)),
        "period": [str(df["time"].iloc[0]), str(df["time"].iloc[-1])],
        "knots": {"flow_cfs": [float(v) for v in kf], "stage_ft": [float(v) for v in ks],
                  "count": int(len(kf)), "bins": KNOT_BINS},
        "tail": {"anchor_flow_cfs": q_top, "anchor_stage_ft": s_top, "exponent": p_tail,
                 "fitted_from_stage_ft": TAIL_FROM_FT},
        "r2": float(1 - (resid ** 2).sum() / ((stage - stage.mean()) ** 2).sum()),
        "median_abs_error_ft": float(np.median(np.abs(resid))),
        "median_abs_error_ft_stage_above_35": err(stage > 35.0),
        "median_abs_error_ft_stage_above_45": err(stage > TAIL_FROM_FT),
        "max_abs_error_ft": float(np.max(np.abs(resid))),
        "error_at_observed_peak_ft": float(resid[int(np.argmax(stage))]),
        "observed_stage_ft": {"min": float(stage.min()), "max": float(stage.max())},
        "observed_flow_cfs": {"min": float(flow.min()), "max": float(flow.max())},
    }


_FIT: dict | None = None
_CURVE = None


def _params(site: str = GAUGE_USGS) -> dict:
    global _FIT, _CURVE
    if _FIT is None or _FIT["site"] != site:
        _FIT = fit(site)
        _CURVE = PchipInterpolator(np.log(_FIT["knots"]["flow_cfs"]), _FIT["knots"]["stage_ft"])
    return _FIT


def stage_from_flow(flow_cfs: float, site: str = GAUGE_USGS) -> tuple[float, bool]:
    """Gauge stage (ft) for a discharge. Second value is True if extrapolated."""
    p = _params(site)
    q = float(flow_cfs)
    kf = p["knots"]["flow_cfs"]
    if q < kf[0]:
        return float(p["knots"]["stage_ft"][0]), True
    if q > kf[-1]:
        t = p["tail"]
        return float(t["anchor_stage_ft"] * (q / t["anchor_flow_cfs"]) ** t["exponent"]), True
    return float(_CURVE(np.log(q))), False


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    p = _params()
    (DERIVED / "gauge_rating.json").write_text(json.dumps(p, indent=2))

    print(f"n = {p['n']} paired days, {p['period'][0]} .. {p['period'][1]}")
    print(f"knots: {p['knots']['count']} over {p['observed_flow_cfs']['min']:,.0f} .. "
          f"{p['observed_flow_cfs']['max']:,.0f} cfs")
    print(f"tail exponent above {p['tail']['anchor_flow_cfs']:,.0f} cfs: {p['tail']['exponent']:.4f}")
    print(f"median |error| {p['median_abs_error_ft']:.3f} ft   "
          f">35 ft {p['median_abs_error_ft_stage_above_35']:.2f} ft   "
          f">45 ft {p['median_abs_error_ft_stage_above_45']:.2f} ft   "
          f"max {p['max_abs_error_ft']:.2f} ft")
    print(f"error at the observed peak: {p['error_at_observed_peak_ft']:+.3f} ft "
          f"(the fit is anchored there by construction)")

    print("\nkey flows -> Richmond stage:")
    for q in (14_000, 27_000, 55_000, 120_000, 265_000, 440_000, 1_000_000):
        s, extrap = stage_from_flow(q)
        print(f"  {q:>9,} cfs -> {s:6.2f} ft{'   (extrapolated)' if extrap else ''}")

    # --- gates: the rating must stay monotone and must not regress at the top ---
    # Below the lowest observation the curve is held flat (there is nothing to
    # interpolate), so the grid starts at the first knot and strict increase is
    # required from there up.
    kf = p["knots"]["flow_cfs"]
    grid = np.exp(np.linspace(np.log(kf[0]), np.log(p["observed_flow_cfs"]["max"] * 4), 4000))
    s = np.array([stage_from_flow(float(q))[0] for q in grid])
    assert np.all(np.diff(s) >= 0), "the rating decreases with flow somewhere"
    ks = np.array([stage_from_flow(float(q))[0] for q in kf])
    assert np.all(np.diff(ks) > 0), "the rating is not strictly increasing across the knots"
    assert s[-1] - s[0] > 40.0, "the rating no longer spans the observed flood range"
    assert abs(p["error_at_observed_peak_ft"]) < 1e-6, \
        "the observed peak is no longer an exact knot — the top of the record is being fitted, not met"
    assert p["median_abs_error_ft"] < 0.4, "median rating error regressed"
    assert p["median_abs_error_ft_stage_above_35"] < 1.5, \
        "rating error in the flood range regressed above 1.5 ft"
    assert p["max_abs_error_ft"] < 6.0, "max rating error regressed above 6 ft"
    assert p["tail"]["exponent"] > 0, "the extrapolation tail is not increasing"
    print("\nall gates passed: rating non-decreasing and strictly increasing across its ", 
          f"{len(kf)} knots, peak exact, flood-range error within 1.5 ft")
    print("Wrote data/derived/gauge_rating.json")


if __name__ == "__main__":
    main()
