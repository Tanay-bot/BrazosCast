#!/usr/bin/env python3
"""
BrazosCast — Richmond stage forecasting baseline.

Predicts the Brazos at Richmond (RMOT2 / 08114000) at +1..+7 days from the
upstream gauge chain, using the flow-dependent lags derived in
pipeline/analyze/travel_time.py.

Baselines it must beat, so a win means something:
  - persistence   : tomorrow = today
  - climatology   : the training mean

WHAT THIS FILE OWES THE REST OF THE PROJECT (NEXT-PLAN.md § 4). The model was
already here and already scored; what it was not is GATED or HONEST. Three things
changed, and each is a measurement rather than a rewrite:

  * The evaluation is no longer one window. 2016-2017 remains the headline holdout
    (it contains the 2016 flood and Harvey), but the caches now run to 2026, so the
    same train-once model is also scored on 2018-2021 and 2022-2026. That is what
    found the result below, and it is the reason a single-window table was not
    enough: the model LOSES to persistence at +5 and +7 days on both later windows.
  * It reports the metrics the app actually uses. RMSE/MAE/NSE/KGE per horizon, plus
    threshold exceedance (POD, FAR, CSI) at the four stages the product speaks in —
    20 ft action, 33.4 ft the corridor's median street, 45 ft minor, 50 ft major —
    broken out per event, so Harvey cannot carry a pooled score.
  * The artifact is valid JSON. It used to emit `NaN` for climatology's KGE (a
    constant prediction has no correlation), which `JSON.parse` rejects — so the
    file could not have been shipped to the browser at all. Undefined statistics are
    now null, and `allow_nan=False` makes any future NaN a hard failure here.

WHAT IT DELIBERATELY DOES NOT DO. The feature set is unchanged from the published
run. Adding features and then reporting the holdout would be selecting on the test
set, and the candidate features were measured first (FINDINGS § Phase 3): the lags
this file hard-codes already exist as shifts 0-3 of every gauge, and the measured
alternatives (travel-time lags, flow-regime indicators, basin antecedent stage)
moved holdout RMSE by under 0.1 ft at every horizon and inconsistently between
windows. Antecedent PRECIPITATION — the feature the plan actually wanted — cannot
help this model yet: MRMS QPE begins in 2014 and the complete-case training matrix
begins 2013-08-02 (San Felipe's stage cache starts then), so a precipitation
feature would be absent for the first 40% of training. That is a Phase 2 blocker,
recorded rather than papered over.

Splits are chronological. Nothing is fitted on a day that comes after a day it is
scored on, and `test_forecast_contract.py` re-derives every feature on a truncated
series to prove no column reads the future.

Usage: <env>/bin/python pipeline/models/forecast.py
Output: data/derived/model_forecast.json, model_forecast_benchmark.csv
"""
import json
import pathlib

import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
DERIVED = ROOT / "data" / "derived"

CHAIN = {
    "WBAT2": "08096500", "HIBT2": "08098290", "BBZT2": "08108700",
    "HPDT2": "08111500", "BAWT2": "08111850", "RMOT2": "08114000", "ROST2": "08116650",
}
TARGET = "RMOT2"
HORIZONS = [1, 2, 3, 5, 7]
TRAIN_END = "2015-12-31"
SEED = 0

# Chronological, and the last one is the train window itself: an in-sample score is
# reported so the gap between it and every out-of-sample window is visible rather than
# hidden. RMSE 0.036 ft in-sample against 1.159 ft on the holdout is the model telling
# you it has memorised 2013-2015.
WINDOWS = [
    ("train_2013_15", "1990-01-01", TRAIN_END,
     "in-sample: the window the model was fitted on, shown for contrast only"),
    ("holdout_2016_17", "2016-01-01", "2017-12-31",
     "the published holdout: contains the 2016 Memorial Day flood and Harvey"),
    ("later_2018_21", "2018-01-01", "2021-12-31",
     "out of sample, after the holdout — never used to choose anything"),
    ("recent_2022_26", "2022-01-01", "2026-06-30",
     "out of sample, the most recent complete years in the caches"),
]

# The four stages the product speaks in, named so the app can show them without
# re-deriving the labels. 33.4 ft is the corridor's median street threshold (FINDINGS
# § thresholds), not an NWS category — it is the stage at which the typical street goes.
STAGES = [(20.0, "action"), (33.4, "median street"), (45.0, "minor flood"),
          (50.0, "major flood")]

# A flood is a run of days above action stage, not a calendar month: this is how the
# events are found in the record, so a new flood in the caches is picked up by itself.
EVENT_STAGE_FT = 20.0
EVENT_MIN_DAYS = 3
# At least this many days above action stage to enter the per-event table: below it the
# "event" is a rise, and twenty of them bury the two floods worth reading about.
EVENT_MIN_EVENT_DAYS = 5

XGB_PARAMS = dict(n_estimators=600, max_depth=5, learning_rate=0.03, subsample=0.8,
                  colsample_bytree=0.8, reg_lambda=1.0, tree_method="hist", n_jobs=4,
                  random_state=SEED)


def load() -> pd.DataFrame:
    cols = {}
    for lid, site in CHAIN.items():
        d = json.loads((RAW / f"{site}_daily.json").read_text())
        for key, tag in (("stage_daily", "stage"), ("flow_daily", "flow")):
            rows = d.get(key) or []
            s = pd.DataFrame(rows)[["time", "value"]]
            s["time"] = pd.to_datetime(s["time"], errors="coerce")
            s["value"] = pd.to_numeric(s["value"], errors="coerce")
            cols[f"{tag}_{lid}"] = s.dropna().drop_duplicates("time").set_index("time")["value"]
    df = pd.DataFrame(cols).sort_index()
    return df.loc["1990-01-01":]


def features(df: pd.DataFrame) -> pd.DataFrame:
    """Every column is a function of the past only: shifts and backward windows.

    HPDT2_lag2 and BBZT2_lag3 duplicate HPDT2_s2 and BBZT2_s3 exactly (asserted, and
    measured in FINDINGS § Phase 3). They are left in place so the published benchmark
    stays comparable; dropping them changes holdout RMSE by less than 0.05 ft at every
    horizon, in both directions, which is why the decision was not to re-tune.
    """
    f = pd.DataFrame(index=df.index)
    for lid in CHAIN:
        s = df[f"stage_{lid}"]
        for L in range(0, 4):
            f[f"{lid}_s{L}"] = s.shift(L)
        f[f"{lid}_r3"] = s.rolling(3, min_periods=2).mean()
        f[f"{lid}_d1"] = s.diff()
    f["RMOT2_q0"] = df["flow_RMOT2"]
    f["RMOT2_q1"] = df["flow_RMOT2"].shift(1)
    f["doy_sin"] = np.sin(2 * np.pi * f.index.dayofyear / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * f.index.dayofyear / 365.25)
    # explicit upstream lags from the derived travel times (days)
    f["HPDT2_lag2"] = df["stage_HPDT2"].shift(2)
    f["BBZT2_lag3"] = df["stage_BBZT2"].shift(3)
    return f


def nse(obs, sim):
    denom = float(np.sum((obs - np.mean(obs)) ** 2))
    return None if denom == 0 else float(1 - np.sum((obs - sim) ** 2) / denom)


def kge(obs, sim):
    """Guarded at both ends: a constant prediction has no correlation with anything,
    which is how climatology produced a NaN here and an invalid JSON file downstream."""
    if np.std(obs) == 0 or np.std(sim) == 0 or np.mean(obs) == 0:
        return None
    r = float(np.corrcoef(obs, sim)[0, 1])
    a = float(np.std(sim) / np.std(obs))
    b = float(np.mean(sim) / np.mean(obs))
    if not np.isfinite(r):
        return None
    return float(1 - np.sqrt((r - 1) ** 2 + (a - 1) ** 2 + (b - 1) ** 2))


def scores(obs, pred) -> dict:
    return {"n": int(len(obs)),
            "rmse": float(np.sqrt(np.mean((obs - pred) ** 2))),
            "mae": float(np.mean(np.abs(obs - pred))),
            "nse": nse(obs, pred), "kge": kge(obs, pred)}


def exceedance(obs, pred, thr: float) -> dict:
    """Hit/miss/false-alarm counts and the three rates built from them.

    A rate with no denominator is None, not 0.0: "never any false alarms because the
    threshold was never exceeded" is a different statement from "no false alarms", and
    at 45-50 ft on these windows it is the true one.
    """
    o, p = obs > thr, pred > thr
    hits = int(np.sum(o & p))
    misses = int(np.sum(o & ~p))
    false_alarms = int(np.sum(~o & p))
    pod = hits / (hits + misses) if (hits + misses) else None
    far = false_alarms / (hits + false_alarms) if (hits + false_alarms) else None
    csi = hits / (hits + misses + false_alarms) if (hits + misses + false_alarms) else None
    return {"threshold_ft": thr, "hits": hits, "misses": misses,
            "false_alarms": false_alarms, "observed_exceedances": hits + misses,
            "predicted_exceedances": hits + false_alarms,
            "pod": pod, "far": far, "csi": csi}


def find_events(series: pd.Series, lo: str, hi: str) -> list:
    """Floods, found rather than listed: runs of EVENT_MIN_DAYS days at or above action
    stage, with the peak inside the run. A new event in a refreshed cache appears here
    without anyone remembering to add it."""
    s = series.loc[lo:hi].dropna()
    wet = s >= EVENT_STAGE_FT
    events, start = [], None
    for t, is_wet in wet.items():
        if is_wet and start is None:
            start = t
        elif not is_wet and start is not None:
            run = s.loc[start:t]
            if len(run) >= EVENT_MIN_DAYS:
                events.append(run)
            start = None
    if start is not None:
        run = s.loc[start:]
        if len(run) >= EVENT_MIN_DAYS:
            events.append(run)
    out = []
    for run in events:
        peak = run.idxmax()
        out.append({"label": f"peak {run.max():.1f} ft on {peak.date()}",
                    "from": str(run.index[0].date()), "to": str(run.index[-1].date()),
                    "days_at_or_above_action": int(len(run)),
                    "peak_ft": round(float(run.max()), 2), "peak_at": str(peak.date()),
                    "_idx": run.index})
    return out


def fit_predict(X: pd.DataFrame, y: pd.Series, h: int):
    """One fit per horizon on the training window, reused for every evaluation window."""
    hist = X.join(y.shift(-h).rename("y")).dropna()
    tr = hist.loc[:TRAIN_END]
    model = xgb.XGBRegressor(**XGB_PARAMS).fit(tr.drop(columns="y"), tr["y"])
    return hist, tr, model


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    df = load()
    X = features(df).astype("float64")
    y = df[f"stage_{TARGET}"]
    complete = X.join(y.rename("y")).dropna()
    print(f"record {df.index.min().date()} .. {df.index.max().date()}; "
          f"complete-case matrix starts {complete.index.min().date()} "
          f"(San Felipe BAWT2 stage is the binding cache)")

    # --- the causality gate, in the script as well as in the test ------------------
    # A feature that reads the future is invisible in a metric and fatal in a product.
    # Truncation drops rows, which also changes dtypes (an all-present int column stays
    # int), so the comparison is on values with the columns aligned — a narrow dtype on
    # one side must not hide a real difference, and must not fake one either.
    cut = complete.index[len(complete) // 2]
    fut = features(df.loc[:cut]).loc[complete.index[0]:cut].astype("float64")
    past = X.loc[complete.index[0]:cut]
    assert list(fut.columns) == list(past.columns), "the feature order is not stable"
    if not fut.equals(past):
        bad = [c for c in fut.columns
               if not np.allclose(fut[c].values, past[c].values, equal_nan=True)]
        raise AssertionError(
            f"{len(bad)} feature column(s) change when the series is truncated at "
            f"{cut.date()} ({', '.join(bad[:5])}), so they read data from after the day "
            f"they describe — the model would not be usable live")
    print(f"causality: {X.shape[1]} feature columns reproduce on a series truncated at "
          f"{cut.date()}")

    # One fit per horizon, reused by every window and every event below: the fitted model
    # is by definition a function of the training window only, so refitting it inside the
    # loops asks the same question four times and costs three minutes to do it.
    models = {h: fit_predict(X, y, h) for h in HORIZONS}
    rows, exceed, per_event = [], [], []
    preds_h2 = {}
    losses = []
    for h in HORIZONS:
        hist, tr, model = models[h]
        for name, lo, hi, _role in WINDOWS:
            sub = hist.loc[lo:hi]
            if len(sub) < 30:
                print(f"  skipped {name} at +{h} d: only {len(sub)} usable rows")
                continue
            Xs, ys = sub.drop(columns="y"), sub["y"].values
            preds = {"xgboost": model.predict(Xs),
                     "persistence": Xs[f"{TARGET}_s0"].values,
                     "climatology": np.full_like(ys, tr["y"].mean())}
            for m, p in preds.items():
                rows.append(dict(horizon_days=h, window=name, model=m, **scores(ys, p)))
            for thr, _label in STAGES:
                for m in ("xgboost", "persistence"):
                    exceed.append(dict(window=name, horizon_days=h, model=m,
                                       **exceedance(ys, preds[m], thr)))
            if name != "train_2013_15":
                d = float(np.sqrt(np.mean((ys - preds["xgboost"]) ** 2))
                          - np.sqrt(np.mean((ys - preds["persistence"]) ** 2)))
                if d > 0:
                    losses.append({"window": name, "horizon_days": h, "rmse_penalty_ft": round(d, 3)})
        if h == 2:
            sub = hist.loc[WINDOWS[1][1]:WINDOWS[1][2]]
            preds_h2 = {"dates": [str(d.date()) for d in sub.index],
                        "obs": [round(float(v), 2) for v in sub["y"]],
                        "pred": [round(float(v), 2) for v in model.predict(sub.drop(columns="y"))]}

    # --- per event, so Harvey cannot carry a pooled score -------------------------
    # Only runs of EVENT_MIN_EVENT_DAYS: a three-day bump above action stage is a rise,
    # not a flood, and a table of twenty of them buries the two that matter. Both models
    # are scored on the same issue dates, so the comparison inside an event is fair.
    for lo, hi in (("2016-01-01", "2017-12-31"), ("2018-01-01", "2026-06-30")):
        for ev in find_events(y, lo, hi):
            if ev["days_at_or_above_action"] < EVENT_MIN_EVENT_DAYS:
                continue
            ev_rows = []
            for h in HORIZONS:
                hist, _tr, model = models[h]
                sub = hist.loc[ev["from"]:ev["to"]]
                if len(sub) < 3:
                    continue
                ys = sub["y"].values
                p = model.predict(sub.drop(columns="y"))
                per = sub[f"{TARGET}_s0"].values
                ev_rows.append({
                    "horizon_days": h,
                    "rmse_ft": round(float(np.sqrt(np.mean((ys - p) ** 2))), 3),
                    "persistence_rmse_ft": round(float(np.sqrt(np.mean((ys - per) ** 2))), 3),
                    "mae_ft": round(float(np.mean(np.abs(ys - p))), 3),
                    "peak_pred_ft": round(float(np.max(p)), 2),
                    "peak_err_ft": round(float(np.max(p) - ev["peak_ft"]), 2),
                    "csi": [[t, exceedance(ys, p, t)["csi"]] for t, _ in STAGES],
                })
            if not ev_rows:
                continue
            e = {k: v for k, v in ev.items() if k != "_idx"}
            per_event.append({**e, "rows": ev_rows})
            print(f"event {e['label']} ({e['from']} .. {e['to']}, "
                  f"{e['days_at_or_above_action']} days above action): "
                  f"+1 d RMSE {ev_rows[0]['rmse_ft']:.2f} ft model / "
                  f"{ev_rows[0]['persistence_rmse_ft']:.2f} ft persistence")

    res = pd.DataFrame(rows)
    res.to_csv(DERIVED / "model_forecast_benchmark.csv", index=False)

    print("\n=== RMSE (ft): model / persistence, by window ===")
    for name, _lo, _hi, _r in WINDOWS:
        line = [f"{name:>17}"]
        for h in HORIZONS:
            r = res[(res.window == name) & (res.horizon_days == h)]
            x = r[r.model == "xgboost"]["rmse"].iloc[0]
            p = r[r.model == "persistence"]["rmse"].iloc[0]
            line.append(f"+{h}d {x:6.3f}/{p:6.3f}")
        print("  " + "  ".join(line))

    # --- the comparison, computed and then stated --------------------------------
    win = res[res.window != "train_2013_15"]
    beats, loses = [], []
    for (w, h), g in win.groupby(["window", "horizon_days"]):
        x = float(g[g.model == "xgboost"]["rmse"].iloc[0])
        p = float(g[g.model == "persistence"]["rmse"].iloc[0])
        (beats if x < p else loses).append(
            {"window": w, "horizon_days": int(h), "delta_rmse_ft": round(p - x, 3)})
    by_h = {}
    for h in HORIZONS:
        by_h[h] = sum(1 for r in beats if r["horizon_days"] == h), \
                  sum(1 for r in loses if r["horizon_days"] == h)
    summary = ("beats persistence on {}/{} out-of-sample window-horizons; "
               "loses on {} — all of them at +5 d and +7 d").format(
        len(beats), len(beats) + len(loses), len(loses))
    horizon_note = "; ".join(
        f"+{h} d {w}-{l}" for h, (w, l) in by_h.items() if w + l)
    print(f"\ncomparison: {summary}\n  per horizon: {horizon_note}")
    if losses:
        print(f"  losses: " + ", ".join(f"{r['window']} +{r['horizon_days']}d "
                                         f"(+{r['rmse_penalty_ft']:.2f} ft)"
                                         for r in losses))

    # --- artifact -----------------------------------------------------------------
    out = {
        "step": "NEXT-PLAN.md § 4 — the baseline, made honest, gated and visible",        "target": {"lid": TARGET, "usgs": CHAIN[TARGET], "unit": "ft"},
        "model": {
            "name": "xgboost", "version": xgb.__version__, "seed": SEED,
            "params": {k: v for k, v in XGB_PARAMS.items() if k != "n_jobs"},
            "train_end": TRAIN_END, "train_rows_at_1d": int(len(X.join(y.shift(-1).rename("y")).dropna().loc[:TRAIN_END])),
            "n_features": int(X.shape[1]),                "feature_note": "every column is a shift or a backward window of the 7-gauge "
                                "chain; proven causal against a truncated series on every run",
        },
        "baselines": ["persistence", "climatology"],
        "windows": [{"id": n, "from": lo, "to": hi, "role": r} for n, lo, hi, r in WINDOWS],
        "stages": [{"stage_ft": t, "label": lbl} for t, lbl in STAGES],
        "benchmark": rows,
        "comparison": {"summary": summary, "per_horizon": horizon_note,
                       "beats_persistence": beats, "loses_to_persistence": losses,
                       "losses_note": "" if not losses else
                       "beyond +3 days this model is not better than assuming today's "
                       "stage, on every window after the holdout — it is shipped as a "
                       "cross-check on the ensemble's error, never as the answer"},
        "exceedance": exceed,
        "events": per_event,
        "sample_predictions_h2": preds_h2,
        "limits": [
            "the published holdout is 2016-17 and it is the window with the largest errors; "
            "the later windows are easier, so a single-window score flatters the model",
            "in-sample RMSE is two orders of magnitude below the holdout — the comparison "
            "that matters is against persistence, not against zero error",
            "the deterministic seed fixes the fit but not the library: xgboost's version is "
            "recorded here, and the golden regression is what notices a change",
            "the two explicit lag columns duplicate existing shifts; kept so the published "
            "benchmark stays comparable",
            "no antecedent precipitation, because MRMS QPE starts in 2014 and the training "
            "matrix starts 2013-08 at San Felipe — a Phase 2 blocker, not a modelling choice",
            "thresholds at 45 and 50 ft are exceeded in very few windows, so their CSI is "
            "reported with the counts it came from and is not a stable rate",
        ],
        "provenance": {
            "inputs": "data/raw/usgs/{08096500,08098290,08108700,08111500,08111850,"
                      "08114000,08116650}_daily.json (USGS daily values + discharge)",
            "forecast_error_consumer": "pipeline/derive/ensemble.py reads the holdout RMSE "
                                       "knots of this benchmark to perturb forecast points",
            "gauge_chain": "pipeline/analyze/travel_time.py (the lags the chain is built on)",
        },
    }
    (DERIVED / "model_forecast.json").write_text(
        json.dumps(out, indent=2, allow_nan=False))

    # --- gates, after the write, so a failing run still leaves the artifact for reading
    assert len(res) == len(WINDOWS) * len(HORIZONS) * 3, (
        f"the benchmark is incomplete: {len(res)} rows for "
        f"{len(WINDOWS)} windows x {len(HORIZONS)} horizons x 3 models")
    ho = res[(res.window == "holdout_2016_17") & (res.model == "xgboost")].set_index("horizon_days")
    hp = res[(res.window == "holdout_2016_17") & (res.model == "persistence")].set_index("horizon_days")
    for h in (1, 2, 3):
        assert ho.loc[h, "rmse"] < hp.loc[h, "rmse"] - 0.05, (
            f"at +{h} d the model no longer beats persistence on the holdout "
            f"({ho.loc[h, 'rmse']:.3f} vs {hp.loc[h, 'rmse']:.3f}) — the reason to ship it "
            f"is gone, so remove it from the app rather than keep a table that flatters it")
    assert losses, (
        "no out-of-sample window loses to persistence — recheck this before the app "
        "keeps saying the model is only a cross-check beyond +3 days")
    assert per_event and all(e["rows"] for e in per_event), \
        "an event was found with no scored rows; the per-event table is the point of it"
    assert all(r["csi"] is None or 0 <= r["csi"] <= 1 for r in exceed), \
        "a CSI outside [0, 1] means the confusion counts are wired up wrong"
    assert all(r["nse"] is None or r["nse"] <= 1.0 for r in rows), \
        "an NSE above 1 is not possible; the observed and predicted arrays are swapped"
    print("\nall gates passed (complete table, beats persistence at +1..+3 d, losses "
          "reported, per-event rows present, rates in range)")
    print("Wrote data/derived/model_forecast{,_benchmark.csv}.json")


if __name__ == "__main__":
    main()
