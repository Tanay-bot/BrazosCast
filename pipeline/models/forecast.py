#!/usr/bin/env python3
"""
BrazosCast — Richmond stage forecasting baseline.

Predicts the Brazos at Richmond (RMOT2 / 08114000) at +1..+7 days from the
upstream gauge chain, using the flow-dependent lags derived in
pipeline/analyze/travel_time.py.

Baselines it must beat, so a win means something:
  - persistence   : tomorrow = today
  - climatology   : the training mean

Holdout: 2016–2017 (the spec's test events; includes the 2016 flood and Harvey),
plus a separate 2018+ window.

Honest scope note: archived NWS/AHPS forecasts and the NWM retrospective are not
yet ingested, so this reports model-vs-baseline only. The NWS/NWM head-to-head is
tracked separately in FINDINGS.md.

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
HOLDOUT = ("2016-01-01", "2017-12-31")


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
    return 1 - np.sum((obs - sim) ** 2) / np.sum((obs - np.mean(obs)) ** 2)


def kge(obs, sim):
    r = np.corrcoef(obs, sim)[0, 1]
    a = np.std(sim) / np.std(obs)
    b = np.mean(sim) / np.mean(obs)
    return 1 - np.sqrt((r - 1) ** 2 + (a - 1) ** 2 + (b - 1) ** 2)


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    df = load()
    X = features(df).astype("float64")
    y = df[f"stage_{TARGET}"]

    rows = []
    preds_holdout = {}
    for h in HORIZONS:
        target = y.shift(-h).rename("y")
        data = X.join(target).dropna()
        tr = data[data.index <= TRAIN_END]
        ho = data[(data.index >= HOLDOUT[0]) & (data.index <= HOLDOUT[1])]
        if len(ho) < 50 or len(tr) < 500:
            continue

        model = xgb.XGBRegressor(
            n_estimators=600, max_depth=5, learning_rate=0.03,
            subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0,
            tree_method="hist", n_jobs=4, random_state=0)
        model.fit(tr.drop(columns="y"), tr["y"])

        for name, sub in (("holdout_2016_17", ho), ("train", tr)):
            if len(sub) < 30:
                continue
            Xs, ys = sub.drop(columns="y"), sub["y"].values
            p = model.predict(Xs)
            persist = Xs[f"{TARGET}_s0"].values
            clim = np.full_like(ys, tr["y"].mean())
            rows += [
                dict(horizon_days=h, window=name, model="xgboost", n=len(ys),
                     rmse=float(np.sqrt(np.mean((ys - p) ** 2))), mae=float(np.mean(np.abs(ys - p))),
                     nse=float(nse(ys, p)), kge=float(kge(ys, p))),
                dict(horizon_days=h, window=name, model="persistence", n=len(ys),
                     rmse=float(np.sqrt(np.mean((ys - persist) ** 2))), mae=float(np.mean(np.abs(ys - persist))),
                     nse=float(nse(ys, persist)), kge=float(kge(ys, persist))),
                dict(horizon_days=h, window=name, model="climatology", n=len(ys),
                     rmse=float(np.sqrt(np.mean((ys - clim) ** 2))), mae=float(np.mean(np.abs(ys - clim))),
                     nse=float(nse(ys, clim)), kge=float(kge(ys, clim))),
            ]
        preds_holdout[h] = {"dates": [str(d.date()) for d in ho.index],
                            "obs": [round(float(v), 2) for v in ho["y"]],
                            "pred": [round(float(v), 2) for v in model.predict(ho.drop(columns="y"))]}

    res = pd.DataFrame(rows)
    res.to_csv(DERIVED / "model_forecast_benchmark.csv", index=False)

    print("=== holdout 2016–2017 ===")
    print(f"{'h(d)':>4} {'model':>12} {'RMSE':>7} {'MAE':>7} {'NSE':>7} {'KGE':>7}")
    ho = res[res.window == "holdout_2016_17"]
    for h in HORIZONS:
        for m in ("xgboost", "persistence", "climatology"):
            r = ho[(ho.horizon_days == h) & (ho.model == m)]
            if len(r):
                r = r.iloc[0]
                print(f"{h:>4} {m:>12} {r.rmse:7.3f} {r.mae:7.3f} {r.nse:7.3f} {r.kge:7.3f}")

    # feature importance at +2 days (the near-upstream lead time)
    if 2 in preds_holdout:
        target = y.shift(-2).rename("y")
        data = X.join(target).dropna()
        tr = data[data.index <= TRAIN_END]
        m = xgb.XGBRegressor(n_estimators=600, max_depth=5, learning_rate=0.03,
                             subsample=0.8, colsample_bytree=0.8, tree_method="hist",
                             n_jobs=4, random_state=0).fit(tr.drop(columns="y"), tr["y"])
        imp = sorted(zip(tr.drop(columns="y").columns, m.feature_importances_),
                     key=lambda t: -t[1])[:10]
        print("\n=== top features, +2 day horizon ===")
        for k, v in imp:
            print(f"  {k:<14} {v:.3f}")

    (DERIVED / "model_forecast.json").write_text(json.dumps({
        "horizons_days": HORIZONS, "train_end": TRAIN_END, "holdout": HOLDOUT,
        "benchmark": rows, "sample_predictions_h2": preds_holdout.get(2, {}),
    }, indent=2))
    print("\nWrote data/derived/model_forecast{,_benchmark.csv}.json")


if __name__ == "__main__":
    main()
