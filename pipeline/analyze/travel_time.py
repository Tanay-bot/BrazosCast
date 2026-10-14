#!/usr/bin/env python3
"""
BrazosCast — flow-dependent travel-time matrix (v0, daily resolution)

No published table says how long a Brazos crest takes to travel from each
upstream gauge to Richmond. The county names 13 upstream gauges and publishes
zero hour figures. This derives lags empirically.

Method
  1. Align daily stage/flow for the 7-gauge chain on a common index.
  2. Cross-correlate upstream stage(t) against Richmond stage(t+lag),
     overall and split by Richmond discharge regime (low / medium / high).
  3. Event-based check: match Richmond daily peaks above a threshold to the
     nearest upstream peak and record the day offset (+ Pearson r).
  4. Write data/derived/travel_time.json and a figure.

Input : data/raw/usgs/<site>_{daily,peaks}.json
Usage : <env>/bin/python pipeline/analyze/travel_time.py
"""
import json
import pathlib
import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
DERIVED = ROOT / "data" / "derived"
FIGS = DERIVED / "figures"

CHAIN = [
    ("WBAT2", "08096500", "Waco",        True),
    ("HIBT2", "08098290", "Highbank",    True),
    ("BBZT2", "08108700", "Bryan",       True),
    ("HPDT2", "08111500", "Hempstead",   True),
    ("BAWT2", "08111850", "San Felipe",  True),
    ("RMOT2", "08114000", "Richmond",    False),   # target
    ("ROST2", "08116650", "Rosharon",    False),   # downstream
]
TARGET = "RMOT2"
MAX_LAG_DAYS = 12
RICHMOND_FLOOD_STAGE = 30.0   # below the 45 ft NWS flood stage: a meaningful rise


def series(site: str) -> pd.DataFrame:
    """Daily stage + flow for one site, indexed by date."""
    d = json.loads((RAW / f"{site}_daily.json").read_text())
    frames = {}
    for key, col in (("stage_daily", "stage"), ("flow_daily", "flow")):
        rows = d.get(key) or []
        if not rows:
            continue
        s = pd.DataFrame(rows)[["time", "value"]]
        s["time"] = pd.to_datetime(s["time"], errors="coerce")
        s["value"] = pd.to_numeric(s["value"], errors="coerce")
        s = s.dropna().drop_duplicates("time").set_index("time")["value"]
        frames[col] = s
    return pd.DataFrame(frames)


def zscore(s: pd.Series) -> pd.Series:
    m, sd = s.mean(), s.std()
    return (s - m) / sd if sd else s * 0.0


def xcorr_lag(up: pd.Series, target: pd.Series, mask: pd.Series | None = None):
    """Lag (days) maximising correlation of up(t) vs target(t+lag). >0 = upstream leads."""
    best = (None, -2.0)
    for lag in range(-MAX_LAG_DAYS, MAX_LAG_DAYS + 1):
        shifted = target.shift(-lag)
        a, b = up, shifted
        if mask is not None:
            m = mask.reindex(b.index).fillna(False) & a.notna() & b.notna()
        else:
            m = a.notna() & b.notna()
        if m.sum() < 60:
            continue
        r = np.corrcoef(a[m], b[m])[0, 1]
        if r > best[1]:
            best = (lag, float(r))
    return best


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    FIGS.mkdir(parents=True, exist_ok=True)

    stages, flows = {}, {}
    for lid, site, name, _ in CHAIN:
        df = series(site)
        stages[lid] = df["stage"] if "stage" in df else pd.Series(dtype=float)
        flows[lid] = df["flow"] if "flow" in df else pd.Series(dtype=float)

    S = pd.DataFrame(stages).sort_index()
    F = pd.DataFrame(flows).sort_index()
    # keep a sensible modern window with dense coverage
    S = S.loc["1990-01-01":]
    F = F.loc["1990-01-01":]
    print(f"Aligned daily record: {S.index.min().date()} .. {S.index.max().date()} ({len(S)} days)")
    coverage = (S.notna().mean() * 100).round(0).astype(int)
    print("stage coverage %:", coverage.to_dict())

    rs = zscore(S[TARGET].dropna())
    rf = F[TARGET]

    # discharge regime masks (terciles of Richmond flow over the record)
    q1, q2 = rf.quantile([0.33, 0.66])
    low = rf <= q1
    mid = (rf > q1) & (rf <= q2)
    high = rf > q2
    regimes = {"low": low, "medium": mid, "high": high}
    print(f"Richmond flow terciles: q33={q1:.0f} q66={q2:.0f} cfs")

    result = {"generated_at": pd.Timestamp.utcnow().isoformat(),
              "record": {"start": str(S.index.min().date()), "end": str(S.index.max().date())},
              "richmond_flow_terciles_cfs": {"q33": float(q1), "q66": float(q2)},
              "overall": {}, "by_regime": {}, "events": {}}

    print("\n=== cross-correlation lag (days; + = upstream leads Richmond) ===")
    print(f"{'gauge':<10} {'overall':>14} {'low':>12} {'medium':>12} {'high':>12}")
    for lid, site, name, upstream in CHAIN:
        if not upstream:
            continue
        up = zscore(S[lid].dropna())
        lag_o, r_o = xcorr_lag(up, rs)
        row = {"name": name, "overall_lag_days": lag_o, "overall_r": round(r_o, 3), "regimes": {}}
        cells = []
        for key, mask in regimes.items():
            lag, r = xcorr_lag(up, rs, mask)
            row["regimes"][key] = {"lag_days": lag, "r": round(r, 3), "n": int(mask.sum())}
            cells.append(f"{lag:>4}d r{r:+.2f}")
        result["overall"][lid] = {"name": name, "lag_days": lag_o, "r": round(r_o, 3)}
        result["by_regime"][lid] = row
        print(f"{lid:<10} {f'{lag_o:>4}d r{r_o:+.2f}':>14} " + " ".join(f"{c:>12}" for c in cells))

    # ---- event-based check: Richmond peaks -> nearest upstream peak ----
    print(f"\n=== event peaks (Richmond daily stage >= {RICHMOND_FLOOD_STAGE} ft) ===")
    rich = S[TARGET].dropna()
    peaks = []
    in_event = False
    start = None
    for i in range(1, len(rich) - 1):
        if rich.iloc[i] >= RICHMOND_FLOOD_STAGE and not in_event:
            in_event, start = True, i
        if in_event and (i == len(rich) - 2 or rich.iloc[i] < RICHMOND_FLOOD_STAGE * 0.8):
            seg = rich.iloc[start:i + 1]
            peaks.append(seg.idxmax())
            in_event = False
    peaks = sorted(set(peaks))
    print(f"Richmond events >= {RICHMOND_FLOOD_STAGE} ft: {len(peaks)}")

    for lid, site, name, upstream in CHAIN:
        if not upstream:
            continue
        ups = S[lid].dropna()
        kn = {"0-24h": 0, "24-48h": 0, "48-72h": 0, ">72h": 0, "none": 0}
        lags = []
        for tp in peaks:
            win = ups.loc[tp - pd.Timedelta(days=MAX_LAG_DAYS): tp]
            if win.notna().sum() < 3:
                continue
            tu = win.idxmax()
            lag_d = (tp - tu).total_seconds() / 86400.0
            lags.append(lag_d)
            if lag_d < 1: kn["0-24h"] += 1
            elif lag_d < 2: kn["24-48h"] += 1
            elif lag_d < 3: kn["48-72h"] += 1
            else: kn[">72h"] += 1
        if lags:
            result["events"][lid] = {
                "name": name, "n_events": len(lags),
                "median_lag_days": round(float(np.median(lags)), 2),
                "p25": round(float(np.percentile(lags, 25)), 2),
                "p75": round(float(np.percentile(lags, 75)), 2),
                "buckets": kn,
            }
            print(f"  {lid:<8} median {np.median(lags):+.2f}d  "
                  f"[p25 {np.percentile(lags,25):+.2f} / p75 {np.percentile(lags,75):+.2f}]  "
                  f"{kn}")

    (DERIVED / "travel_time.json").write_text(json.dumps(result, indent=2))
    print("\nWrote data/derived/travel_time.json")

    # ---- figure ----
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        ups = [c for c in CHAIN if c[3]]
        fig, axes = plt.subplots(1, 2, figsize=(12, 5))
        labels = [c[0] for c in ups]
        overall = [result["overall"][c[0]]["lag_days"] for c in ups]
        axes[0].barh(labels, overall, color="#1a6d93")
        axes[0].invert_yaxis()
        axes[0].set_xlabel("travel time to Richmond (days)")
        axes[0].set_title("Crest lead time by gauge (overall)")

        w = 0.25
        idx = np.arange(len(ups))
        for k, (reg, col) in enumerate(zip(["low", "medium", "high"], ["#49b589", "#d3a13f", "#c4621c"])):
            vals = [result["by_regime"][c[0]]["regimes"][reg]["lag_days"] for c in ups]
            axes[1].barh(idx + (k - 1) * w, vals, height=w, label=reg, color=col)
        axes[1].set_yticks(idx)
        axes[1].set_yticklabels(labels)
        axes[1].invert_yaxis()
        axes[1].set_xlabel("travel time to Richmond (days)")
        axes[1].set_title("Flow-dependent: lag by discharge regime")
        axes[1].legend(title="Richmond flow")
        for ax in axes:
            ax.grid(True, axis="x", alpha=0.3)
        fig.tight_layout()
        fig.savefig(FIGS / "travel_time.png", dpi=130)
        print("Wrote data/derived/figures/travel_time.png")
    except Exception as e:  # figure is optional
        print("figure skipped:", e)


if __name__ == "__main__":
    main()
