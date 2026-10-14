#!/usr/bin/env python3
"""
BrazosCast — sub-daily crest travel times (hours)

Daily resolution is too coarse for a "you have 31 hours" product. This pulls
15-minute gage height for each major Richmond flood event and measures the
actual peak-to-peak offset to each upstream gauge.

Input : data/raw/usgs/08114000_daily.json (to pick events)
Cache : data/raw/usgs/iv/<site>_<eventStart>.json (so re-runs are free)
Output: data/derived/travel_time_subdaily.json + figure
Usage : <env>/bin/python pipeline/analyze/travel_time_subdaily.py [maxEvents]
"""
import json
import pathlib
import sys
import time
import numpy as np
import pandas as pd
import requests

_SESSION = requests.Session()


def _get(url: str, tries: int = 4):
    """GET with exponential backoff on 429/5xx."""
    import random
    for a in range(tries):
        r = _SESSION.get(url, timeout=60)
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(2 * 2 ** a + random.random())
            continue
        r.raise_for_status()
        return r
    r.raise_for_status()
    return r


def series_from_props(rows):
    df = pd.DataFrame([f["properties"] for f in rows])
    df["time"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return (df.dropna(subset=["time", "value"])
              .drop_duplicates("time").set_index("time")["value"])


def fetch_iv_legacy(site: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    """Fallback: legacy NWIS IV endpoint (separate rate limit; retires 2027-02-22)."""
    url = ("https://waterservices.usgs.gov/nwis/iv/?format=json"
           f"&sites={site}&parameterCd={PARAM}"
           f"&startDT={start:%Y-%m-%d}&endDT={end:%Y-%m-%d}")
    r = _get(url)
    data = r.json()
    rows = []
    for ts in data.get("value", {}).get("timeSeries", []):
        for block in ts.get("values", []):
            for v in block.get("value", []):
                rows.append({"time": v.get("dateTime"), "value": v.get("value")})
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return (df.dropna(subset=["time", "value"])
              .drop_duplicates("time").set_index("time")["value"])

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "usgs"
IV = RAW / "iv"
DERIVED = ROOT / "data" / "derived"
FIGS = DERIVED / "figures"

UPSTREAM = [("HPDT2", "08111500", "Hempstead"), ("BAWT2", "08111850", "San Felipe"),
            ("BBZT2", "08108700", "Bryan"), ("HIBT2", "08098290", "Highbank"),
            ("WBAT2", "08096500", "Waco")]
TARGET = ("RMOT2", "08114000", "Richmond")
BASE = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items"
PARAM = "00065"          # gage height, ft
EVENT_THRESH = 35.0      # Richmond daily stage that qualifies as an event
PRE_DAYS, POST_DAYS = 9, 1


def fetch_iv(site: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    """15-min gage height for [start, end], cached on disk."""
    IV.mkdir(parents=True, exist_ok=True)
    tag = start.strftime("%Y%m%d")
    cache = IV / f"{site}_{tag}.json"
    if cache.exists():
        rows = json.loads(cache.read_text())
        return series_from_props(rows) if rows else pd.Series(dtype=float)
    # primary: new USGS API (rate-limits anonymous clients; a free key raises the limit)
    try:
        rows, url = [], (
            f"{BASE}?monitoring_location_id=USGS-{site}&parameter_code={PARAM}"
            f"&datetime={start:%Y-%m-%d}/{end:%Y-%m-%d}&limit=20000&f=json"
        )
        while url:
            page = _get(url).json()
            rows += page.get("features", [])
            nxt = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
            url = nxt
            time.sleep(0.4)
        if rows:
            cache.write_text(json.dumps(rows))
            return series_from_props(rows)
    except requests.HTTPError as e:
        print(f"    (new API unavailable for {site} {start:%Y-%m-%d} -> {e}; using legacy)")
    # fallback: legacy NWIS IV (separate rate limit; retires 2027-02-22)
    s = fetch_iv_legacy(site, start, end)
    if not s.empty:
        cache.write_text(json.dumps(
            [{"properties": {"time": str(t), "value": str(v)}} for t, v in s.items()]))
    return s


def find_events() -> list[pd.Timestamp]:
    d = json.loads((RAW / "08114000_daily.json").read_text())
    s = pd.DataFrame(d["stage_daily"])[["time", "value"]]
    s["time"] = pd.to_datetime(s["time"])
    s["value"] = pd.to_numeric(s["value"], errors="coerce")
    s = s.dropna().set_index("time")["value"].sort_index()
    events, in_ev, seg_start = [], False, None
    for i in range(len(s)):
        if s.iloc[i] >= EVENT_THRESH and not in_ev:
            in_ev, seg_start = True, i
        elif in_ev and s.iloc[i] < EVENT_THRESH * 0.85:
            events.append(s.iloc[seg_start:i].idxmax())
            in_ev = False
    return sorted(set(events))


def main():
    max_events = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    events = find_events()
    # keep the largest events, but always include Harvey and the 2016 flood
    events = sorted(events, key=lambda t: t)
    print(f"Richmond events >= {EVENT_THRESH} ft: {len(events)}")
    chosen = events[-max_events:]
    for must in ("2016-06-01", "2017-09-01"):
        near = [t for t in events if abs((t - pd.Timestamp(must)).days) < 40]
        for n in near:
            if n not in chosen:
                chosen.append(n)
    chosen = sorted(set(chosen))
    print(f"Analyzing {len(chosen)} events")

    recs = []
    for ev in chosen:
        start, end = ev - pd.Timedelta(days=PRE_DAYS), ev + pd.Timedelta(days=POST_DAYS)
        try:
            rt = fetch_iv(TARGET[1], start, end)
            if rt.empty:
                continue
            t_rt = rt.idxmax()
            row = {"date": str(ev.date()), "richmond_peak_ft": round(float(rt.max()), 2)}
            for lid, site, name in UPSTREAM:
                ut = fetch_iv(site, start, end)
                if ut.empty:
                    row[lid] = None
                    continue
                # peak within the pre-window only (upstream must lead)
                pre = ut.loc[:t_rt]
                if pre.empty:
                    row[lid] = None
                    continue
                t_up = pre.idxmax()
                lag_h = (t_rt - t_up).total_seconds() / 3600.0
                row[lid] = round(lag_h, 1) if 0 <= lag_h <= 24 * PRE_DAYS else None
            recs.append(row)
            print(f"  {row['date']}  peak {row['richmond_peak_ft']:>6} ft  " +
                  "  ".join(f"{lid} {row.get(lid)}h" for lid, _, _ in UPSTREAM))
            time.sleep(0.6)
        except Exception as e:
            print(f"  {ev.date()} FAILED: {e}")

    df = pd.DataFrame(recs)
    out = {"generated_at": pd.Timestamp.now("UTC").isoformat(),
           "threshold_ft": EVENT_THRESH, "n_events": len(df), "gauges": {}}
    print("\n=== median sub-daily lead time to Richmond ===")
    for lid, site, name in UPSTREAM:
        if lid not in df:
            continue
        vals = df[lid].dropna().values
        if len(vals) == 0:
            continue
        out["gauges"][lid] = {
            "name": name, "n": int(len(vals)),
            "median_h": round(float(np.median(vals)), 1),
            "p25_h": round(float(np.percentile(vals, 25)), 1),
            "p75_h": round(float(np.percentile(vals, 75)), 1),
            "min_h": round(float(vals.min()), 1), "max_h": round(float(vals.max()), 1),
        }
        g = out["gauges"][lid]
        print(f"  {lid:<8} {name:<12} {g['median_h']:>6} h  "
              f"[{g['p25_h']}–{g['p75_h']}]  n={g['n']}")

    DERIVED.mkdir(parents=True, exist_ok=True)
    (DERIVED / "travel_time_subdaily.json").write_text(json.dumps(out, indent=2))
    (DERIVED / "travel_time_events.csv").write_text(df.to_csv(index=False))
    print("\nWrote data/derived/travel_time_subdaily.json + travel_time_events.csv")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        present = [(lid, name) for lid, _, name in UPSTREAM if lid in out["gauges"]]
        labels = [f"{lid}\n{name}" for lid, name in present]
        meds = [out["gauges"][lid]["median_h"] for lid, _ in present]
        p25 = [out["gauges"][lid]["p25_h"] for lid, _ in present]
        p75 = [out["gauges"][lid]["p75_h"] for lid, _ in present]
        fig, ax = plt.subplots(figsize=(9, 5))
        x = np.arange(len(meds))
        ax.errorbar(x, meds, yerr=[np.array(meds) - np.array(p25), np.array(p75) - np.array(meds)],
                    fmt="o", capsize=5, color="#1a6d93", ecolor="#879596")
        ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=9)
        ax.set_ylabel("hours ahead of Richmond crest")
        ax.set_title("Sub-daily crest lead time to Richmond (median, IQR)")
        ax.grid(True, axis="y", alpha=0.3)
        fig.tight_layout(); fig.savefig(FIGS / "travel_time_subdaily.png", dpi=130)
        print("Wrote data/derived/figures/travel_time_subdaily.png")
    except Exception as e:
        print("figure skipped:", e)


if __name__ == "__main__":
    main()
