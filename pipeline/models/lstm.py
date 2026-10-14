#!/usr/bin/env python3
"""
BrazosCast — LSTM forecast (headline model).

Same features and holdout as pipeline/models/forecast.py, so the comparison is
apples-to-apples. A sliding window of the gauge chain feeds a single-layer LSTM
with a multi-horizon linear head.

Methodological provenance: Kratzert et al. 2019, "Towards learning universal,
regional, and local hydrological behaviors via machine learning applied to large
sample datasets", HESS 23, 5089 (arXiv:1907.08456). We implement ~120 lines of
plain PyTorch rather than adopting NeuralHydrology's CAMELS-centric loaders.

Usage: <env>/bin/python pipeline/models/lstm.py
Output: data/derived/lstm_benchmark.csv, lstm_compare.json
"""
import json
import pathlib
import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
DERIVED = ROOT / "data" / "derived"

CHAIN = {"WBAT2": "08096500", "HIBT2": "08098290", "BBZT2": "08108700",
         "HPDT2": "08111500", "BAWT2": "08111850", "RMOT2": "08114000", "ROST2": "08116650"}
TARGET = "RMOT2"
HORIZONS = [1, 2, 3, 5, 7]
WINDOW = 14
TRAIN_END = np.datetime64("2015-12-31")
HOLDOUT = (np.datetime64("2016-01-01"), np.datetime64("2017-12-31"))


def load_frame() -> pd.DataFrame:
    cols = {}
    for lid, site in CHAIN.items():
        d = json.loads((RAW / f"{site}_daily.json").read_text())
        for key, tag in (("stage_daily", "stage"), ("flow_daily", "flow")):
            s = pd.DataFrame(d.get(key) or [])[["time", "value"]]
            s["time"] = pd.to_datetime(s["time"], errors="coerce")
            s["value"] = pd.to_numeric(s["value"], errors="coerce")
            cols[f"{tag}_{lid}"] = s.dropna().drop_duplicates("time").set_index("time")["value"]
    return pd.DataFrame(cols).sort_index().loc["1990-01-01":]


def nse(o, s):
    return 1 - np.sum((o - s) ** 2) / np.sum((o - np.mean(o)) ** 2)


def kge(o, s):
    r = np.corrcoef(o, s)[0, 1]
    return 1 - np.sqrt((r - 1) ** 2 + (np.std(s) / np.std(o) - 1) ** 2 +
                       (np.mean(s) / np.mean(o) - 1) ** 2)


def main():
    import torch
    import torch.nn as nn

    torch.manual_seed(0)
    df = load_frame()
    data = df.dropna().copy()
    feat_cols = [c for c in data.columns]
    F = data[feat_cols].values.astype("float32")
    y = data[f"stage_{TARGET}"].values.astype("float32")
    dates = data.index.values
    n = len(data)
    H = max(HORIZONS)

    # sequences: window ending at i predicts y at i+h for each h
    idx = np.arange(WINDOW - 1, n - H)
    end_dates = dates[idx]
    Xs = np.stack([F[i - WINDOW + 1:i + 1] for i in idx])
    Ys = np.stack([[y[i + h] for h in HORIZONS] for i in idx])

    tr_m = end_dates <= TRAIN_END
    ho_m = (end_dates >= HOLDOUT[0]) & (end_dates <= HOLDOUT[1])
    # validation slice = last 15% of train for early stopping
    tr_idx = np.where(tr_m)[0]
    cut = int(len(tr_idx) * 0.85)
    fit_idx, val_idx = tr_idx[:cut], tr_idx[cut:]
    ho_idx = np.where(ho_m)[0]

    mu = Xs[fit_idx].reshape(-1, Xs.shape[2]).mean(0)
    sd = Xs[fit_idx].reshape(-1, Xs.shape[2]).std(0) + 1e-6
    Xn = (Xs - mu) / sd
    # Predict the CHANGE from the last observed stage, not the absolute level.
    # This makes persistence the trivial solution and is the standard fix when a
    # sequence model underperforms an autoregressive baseline.
    tgt_col = feat_cols.index(f"stage_{TARGET}")
    base = Xs[:, -1, tgt_col]
    D = Ys - base[:, None]
    ym, ysd = D[fit_idx].mean(0), D[fit_idx].std(0) + 1e-6
    Yn = (D - ym) / ysd

    class Net(nn.Module):
        def __init__(s, nf):
            super().__init__()
            s.lstm = nn.LSTM(nf, 64, num_layers=1, batch_first=True)
            s.head = nn.Linear(64, len(HORIZONS))
        def forward(s, x):
            out, _ = s.lstm(x)
            return s.head(out[:, -1, :])

    net = Net(Xs.shape[2])
    opt = torch.optim.Adam(net.parameters(), lr=3e-3)
    lossf = nn.MSELoss()
    Xt = torch.tensor(Xn[fit_idx]); Yt = torch.tensor(Yn[fit_idx])
    Xv = torch.tensor(Xn[val_idx]); Yv = torch.tensor(Yn[val_idx])

    best, best_state, patience = 1e9, None, 0
    for epoch in range(300):
        net.train(); opt.zero_grad()
        loss = lossf(net(Xt), Yt); loss.backward(); opt.step()
        net.eval()
        with torch.no_grad():
            vl = lossf(net(Xv), Yv).item()
        if vl < best - 1e-5:
            best, patience = vl, 0
            best_state = {k: v.clone() for k, v in net.state_dict().items()}
        else:
            patience += 1
            if patience >= 30:
                break
    net.load_state_dict(best_state)

    def predict(ix):
        net.eval()
        with torch.no_grad():
            p = net(torch.tensor(Xn[ix])).numpy()
        return base[ix][:, None] + (p * ysd + ym)

    rows = []
    for j, h in enumerate(HORIZONS):
        for name, ix in (("holdout_2016_17", ho_idx), ("train", fit_idx)):
            if len(ix) < 30:
                continue
            obs = Ys[ix][:, j]
            p = predict(ix)[:, j]
            persist = base[ix]
            bases = {"persistence": persist,
                     "climatology": np.full_like(obs, Ys[fit_idx][:, j].mean())}
            rows.append(dict(horizon_days=h, window=name, model="lstm", n=len(obs),
                             rmse=float(np.sqrt(np.mean((obs - p) ** 2))),
                             mae=float(np.mean(np.abs(obs - p))),
                             nse=float(nse(obs, p)), kge=float(kge(obs, p))))
            for bname, bp in bases.items():
                rows.append(dict(horizon_days=h, window=name, model=bname, n=len(obs),
                                 rmse=float(np.sqrt(np.mean((obs - bp) ** 2))),
                                 mae=float(np.mean(np.abs(obs - bp))),
                                 nse=float(nse(obs, bp)), kge=float(kge(obs, bp))))

    res = pd.DataFrame(rows)
    res.to_csv(DERIVED / "lstm_benchmark.csv", index=False)
    print(f"epochs run, best val loss {best:.4f}")
    print("=== LSTM, holdout 2016–2017 ===")
    ho = res[res.window == "holdout_2016_17"]
    for h in HORIZONS:
        for m in ("lstm", "persistence", "climatology"):
            r = ho[(ho.horizon_days == h) & (ho.model == m)]
            if len(r):
                r = r.iloc[0]
                print(f"  h={h:<2} {m:>12}  RMSE {r.rmse:6.3f}  MAE {r.mae:6.3f}  NSE {r.nse:6.3f}  KGE {r.kge:6.3f}")

    # head-to-head vs the XGBoost baseline
    try:
        xgbres = pd.read_csv(DERIVED / "model_forecast_benchmark.csv")
        print("\n=== head-to-head, holdout 2016–2017 (RMSE / NSE) ===")
        cmp = []
        for h in HORIZONS:
            l = ho[(ho.horizon_days == h) & (ho.model == "lstm")].iloc[0]
            x = xgbres[(xgbres.horizon_days == h) & (xgbres.model == "xgboost") &
                       (xgbres.window == "holdout_2016_17")].iloc[0]
            print(f"  h={h:<2}  LSTM {l.rmse:6.3f}/{l.nse:5.3f}   XGB {x.rmse:6.3f}/{x.nse:5.3f}  "
                  f"-> {'LSTM' if l.rmse < x.rmse else 'XGB'} wins")
            cmp.append({"horizon_days": h, "lstm_rmse": l.rmse, "xgb_rmse": x.rmse,
                        "lstm_nse": l.nse, "xgb_nse": x.nse})
        (DERIVED / "lstm_compare.json").write_text(json.dumps(cmp, indent=2))
    except FileNotFoundError:
        print("(xgboost benchmark not found; run forecast.py first)")
    print("\nWrote data/derived/lstm_benchmark.csv")


if __name__ == "__main__":
    main()
