#!/usr/bin/env python3
"""
BrazosCast — export artifacts for the web app.

Copies the derived pipeline outputs into app/public/data/ and builds the Harvey
replay series from the REAL cached USGS observations (no synthetic curve), so the
demo can show an actual flood while the live river is quiet.

Usage: <env>/bin/python pipeline/export/app_data.py
"""
import json
import pathlib
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
OUT = ROOT / "app" / "public" / "data"
IVCACHE = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20170822.json"
SITE = "08114000"


def harvey_series() -> dict:
    rows = json.loads(IVCACHE.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["t", "v"]).drop_duplicates("t").sort_values("t")
    # hourly to keep the payload small
    df = df.set_index("t").resample("1h")["v"].mean().dropna()
    pts = [{"t": t.isoformat(), "v": round(float(v), 2)} for t, v in df.items()]
    peak = max(pts, key=lambda p: p["v"])
    return {"site": SITE, "lid": "RMOT2", "event": "Hurricane Harvey (Aug–Sep 2017)",
            "source": "USGS 08114000 observed gage height, cached in-repo",
            "peak_ft": peak["v"], "peak_at": peak["t"], "points": pts}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ["road_thresholds.geojson", "road_thresholds.json",
                 "travel_time_subdaily.json", "stage_area_curve.json"]:
        src = DERIVED / name
        if src.exists():
            (OUT / name).write_text(src.read_text())
            print(f"copied {name} ({(OUT/name).stat().st_size//1024} KB)")
        else:
            print(f"MISSING {name}")
    rep = harvey_series()
    (OUT / "replay-harvey.json").write_text(json.dumps(rep))
    print(f"replay-harvey.json: {len(rep['points'])} hourly points, peak {rep['peak_ft']} ft at {rep['peak_at']}")


if __name__ == "__main__":
    main()
