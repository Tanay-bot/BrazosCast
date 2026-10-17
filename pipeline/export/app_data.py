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


def app_data_streets(gj: dict, index: dict) -> dict:
    """Every address-index lookup key, with the stage its street first floods at.

    The keys are the index's own (the county's short and long suffix forms both appear), so a
    street typed on the landing resolves exactly as it would in the app. `keys` maps a name to
    STREET positions in `streets` (not to segments — that was the first bug here: reading them
    as segments gave Chew Road Skinner Lane's threshold), and `streets[i].s` is the segment
    list. The stage is the minimum over those segments, which is the one the app leads with
    when no house number is given. Nothing here is invented: it is a join of two artifacts.
    """
    stages = [f["properties"]["flood_stage_ft"] for f in gj["features"]]
    # The app's own rule for a bare street name (main.ts, `located`): among the segments the
    # county files house numbers on, take the one that floods first. Segments the county files
    # no addresses for are not in that set, so a copy of "all segments named X" would disagree
    # with the app by a few tenths of a foot and by a different segment count.
    addressed: dict[int, set[int]] = {}
    for si, _lo, _hi, seg in index["ranges"]:
        addressed.setdefault(si, set()).add(seg)
    by_key = {}
    for key, street_idx in index["keys"].items():
        segs = sorted({s for i in street_idx for s in addressed.get(i, index["streets"][i]["s"])})
        vals = [stages[s] for s in segs if 0 <= s < len(stages)]
        if not vals:
            continue
        name = index["streets"][street_idx[0]]["n"]
        by_key[key] = {"name": name, "min_ft": round(float(min(vals)), 2), "segments": len(segs)}
    return {
        "source": "road_thresholds.geojson joined to address_index.json",
        "note": "min_ft is the earliest segment on that street to flood — what the app shows "
                "for a bare street name. A house number is resolved to the nearest segment by "
                "the app itself.",
        "segments": len(gj["features"]),
        "streets": len(index["streets"]),
        "by_key": by_key,
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Only what the app actually fetches. road_thresholds.json (287 KB) and
    # stage_area_curve.json were being exported and read by nothing in the app;
    # a regression test now fails if an unused file reappears here.
    payload = ["road_thresholds.geojson",
               "travel_time_subdaily.json",
               "routing_graph.json", "gauge_redundancy.json",
               "harvey_validation.json",
               "harvey_backcast.json",
               "ensemble.json",
               "address_index.json",
               "notifications.json",
               "gauge_history.json"]
    for name in payload:
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

    # Prune anything this step no longer exports. Without this a removed artifact
    # stays in the shipped bundle forever, because app_data.py only ever added
    # files — which is how road_thresholds.json kept being deployed after it
    # stopped being read.
    expected = set(payload) | {"replay-harvey.json", "street_thresholds.json"}
    for stale in sorted(OUT.glob("*.json")):
        if stale.name in expected:
            continue
        kb = stale.stat().st_size // 1024
        stale.unlink()
        print(f"pruned stale {stale.name} ({kb} KB) — no longer part of the app payload")

    # The app asserts a threshold per street, so the measurement of how wrong those
    # thresholds are has to travel with them; a missing validation is a build error
    # rather than a silently undisclosed one.
    # The app's address box is only as good as this index: without it the box
    # falls back to matching street names, which is the bug it exists to fix.
    ai = DERIVED / "address_index.json"
    if not ai.exists():
        raise SystemExit("data/derived/address_index.json missing — run "
                         "pipeline/derive/address_index.py before exporting app data.")
    a = json.loads(ai.read_text())
    ref = a["reference"]
    # The index stores segment POSITIONS, so an index built against a different
    # road_thresholds.geojson would resolve every address to the wrong street.
    gj = json.loads((OUT / "road_thresholds.geojson").read_text())
    if len(gj["features"]) != ref["segments"]:
        raise SystemExit(
            f"address_index.json was built against {ref['segments']} segments but "
            f"road_thresholds.geojson now has {len(gj['features'])} — rebuild the index.")
    print(f"address_index.json: {len(a['ranges'])} address ranges on "
          f"{a['scope']['app_streets']} streets, {len(a['keys'])} lookup keys")

    # The landing page puts a street on the gauge, and it must use the same threshold the app
    # will answer with — not a second copy, and not a fetch of the 1 MB road layer. So this is
    # the address index's own keys joined to the segments they name: one row per lookup key,
    # carrying the EARLIEST segment's stage, which is exactly what the app shows for a bare
    # street name. A house number still goes to the app, which resolves the nearest segment.
    st = app_data_streets(gj, a)
    (OUT / "street_thresholds.json").write_text(json.dumps(st, separators=(",", ":")))
    print(f"street_thresholds.json: {len(st['by_key'])} lookup keys on {st['streets']} streets, "
          f"lowest {min(v['min_ft'] for v in st['by_key'].values()):.1f} ft, "
          f"{(OUT / 'street_thresholds.json').stat().st_size // 1024} KB")

    # What the river would have to do: the app answers "stays dry" on most days, and the
    # honest version of that sentence needs the peak record. A missing history is a build
    # error, not a quietly missing sentence.
    gh = DERIVED / "gauge_history.json"
    if not gh.exists():
        raise SystemExit("data/derived/gauge_history.json missing — run "
                         "pipeline/derive/gauge_history.py before exporting app data.")
    g = json.loads(gh.read_text())
    if not g["peaks"]:
        raise SystemExit("gauge_history.json carries no peaks — the quiet-river answer "
                         "would have nothing to say")
    print(f"gauge_history.json: {g['n_peaks']} annual stage peaks, "
          f"{g['from']} .. {g['to']}, highest {g['highest']['ft']:.2f} ft "
          f"({g['highest']['at']})")

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

    # F7 — the alert text is compiled, not written at runtime: a missing template would
    # render an empty SMS on the one screen that tells someone to leave.
    nt = DERIVED / "notifications.json"
    if not nt.exists():
        raise SystemExit("data/derived/notifications.json missing — run "
                         "pipeline/derive/notifications.py before exporting app data.")
    n = json.loads(nt.read_text())
    keys = set(n["templates"]["en"])
    missing = {lang: sorted(keys ^ set(n["templates"][lang]))
               for lang in ("en", "es")}
    if any(missing.values()):
        raise SystemExit(f"notifications.json has an incomplete language: {missing}")
    print(f"notifications.json: {n['simulation']['streets_warned']:,} streets, "
          f"{n['simulation']['sends']:,} messages, longest "
          f"{n['policy']['measured_longest_message']} chars, "
          f"{len(n['verification'])} verification streets")


if __name__ == "__main__":
    main()
