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


def check_isolation(dst: pathlib.Path) -> None:
    """isolation.py enriches road_thresholds.geojson in place. If it has not been
    run, the app would quietly lose the isolation number and still build, so this
    fails loudly instead of shipping a half-populated payload."""
    feats = json.loads(dst.read_text())["features"]
    missing = [f["properties"]["osmid"] for f in feats
               if "isolation_ft" not in f["properties"]
               or "isolation_status" not in f["properties"]]
    if missing:
        raise SystemExit(
            f"{len(missing)} features carry no isolation_ft (first: osmid {missing[0]}). "
            f"Run pipeline/derive/isolation.py before exporting app data.")
    cut = [f["properties"] for f in feats
           if f["properties"].get("isolation_gap_ft") is not None
           and f["properties"]["isolation_gap_ft"] > 0.05]
    no_ref = sum(1 for f in feats if f["properties"]["isolation_status"] == "no_dry_refuge")
    print(f"isolation present on all {len(feats)} features: {len(cut)} cut off before their "
          f"street floods, {no_ref} with no dry refuge at all")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ["road_thresholds.geojson", "road_thresholds.json",
                 "travel_time_subdaily.json", "stage_area_curve.json",
                 "routing_graph.json", "gauge_redundancy.json",
                 "harvey_validation.json",
                 "harvey_backcast.json",
                 "ensemble.json"]:
        src = DERIVED / name
        if src.exists():
            (OUT / name).write_text(src.read_text())
            print(f"copied {name} ({(OUT/name).stat().st_size//1024} KB)")
        else:
            print(f"MISSING {name}")
    check_isolation(OUT / "road_thresholds.geojson")
    rep = harvey_series()
    (OUT / "replay-harvey.json").write_text(json.dumps(rep))
    print(f"replay-harvey.json: {len(rep['points'])} hourly points, peak {rep['peak_ft']} ft at {rep['peak_at']}")

    # The app asserts a threshold per street, so the measurement of how wrong those
    # thresholds are has to travel with them; a missing validation is a build error
    # rather than a silently undisclosed one.
    hv = DERIVED / "harvey_validation.json"
    if not hv.exists():
        raise SystemExit("data/derived/harvey_validation.json missing — run "
                         "pipeline/derive/harvey_validation.py before exporting app data.")
    v = json.loads(hv.read_text())
    print(f"harvey_validation.json: FPR {v['confusion_matrix']['false_positive_rate']:.3f}, "
          f"required lift {v['corroboration_of_closed_routes']['required_lift_ft']:+.1f} ft")

    # The backcast is the app's only claim about a flood that happened, and it is what the
    # replay timeline is drawn from. Exporting without it leaves the timeline blank rather
    # than wrong, but the export still fails: a payload missing its own validation story is
    # not something to ship quietly.
    bc = DERIVED / "harvey_backcast.json"
    if not bc.exists():
        raise SystemExit("data/derived/harvey_backcast.json missing — run "
                         "pipeline/derive/backcast.py before exporting app data.")
    b = json.loads(bc.read_text())
    print(f"harvey_backcast.json: action stage {b['tiers'][0]['hours_before_crest']:.0f} h "
          f"before the crest, median street {b['street_lead_time']['median_h']:.0f} h, "
          f"flags at crest {b['correction_tradeoff']['flags_at_crest']['shipped']} shipped / "
          f"{b['correction_tradeoff']['flags_at_crest']['corrected']} corrected")


if __name__ == "__main__":
    main()
