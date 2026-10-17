"""T5 — source integrity.

Every published number descends from a cached raw file. Nothing checked those
files, so a silent re-fetch or a truncated download could change a number in the
README and no gate would notice. The receipts already record what should be
there; this holds them to it.
"""
import json
import pathlib

import pytest

from conftest import RAW, read_json


def test_harvey_receipt_matches_the_cached_files(raw_json):
    receipt = raw_json("harvey/_receipt.json")
    assert receipt["files"], "the Harvey receipt lists no files"
    for entry in receipt["files"]:
        path = RAW / "harvey" / entry["name"]
        assert path.exists(), f"{entry['name']} is in the receipt but not on disk"
        assert path.stat().st_size == entry["bytes"], (
            f"{entry['name']} is {path.stat().st_size} bytes, receipt says {entry['bytes']}"
            f" — a re-fetch would move every number scored against it")


def test_usfimr_receipt_matches_the_cached_image(raw_json):
    """The second observation, held to the same rule as the first.

    `second_event_validation.py` scores the thresholds at a stage derived from one
    Sentinel-1 image, and the stage, the refutation count and the out-of-sample claim
    all move with that image. The receipt is what says which bytes were scored.
    """
    receipt = raw_json("usfimr/_receipt.json")
    assert len(receipt["files"]) == 1, "the USFIMR receipt should cover exactly one image"
    for entry in receipt["files"]:
        path = RAW / "usfimr" / entry["name"]
        assert path.exists(), f"{entry['name']} is in the receipt but not on disk"
        assert path.stat().st_size == entry["bytes"], (
            f"{entry['name']} is {path.stat().st_size} bytes, receipt says {entry['bytes']}"
            f" — a re-fetch would move the refutation count")
    # The licence is not decoration: an adaptation of a CC BY dataset has to say so,
    # and the artifact the app and the docs quote restates it from here.
    assert receipt["licence"].startswith("CC BY"), (
        f"the receipt records licence {receipt['licence']!r}, which is not the CC BY the "
        f"validation adapts the data under")


def test_manifest_counts_match_the_cached_data(raw_json):
    manifest = raw_json("manifest.json")

    claims = manifest["openfema_nfip_claims"]
    cached = raw_json("openfema/nfip_claims_48157_v3.json")
    rows = cached["NfipClaims"]
    assert len(rows) == claims["count"], (
        f"manifest says {claims['count']} NFIP claims, cache holds {len(rows)}")
    assert cached["metadata"]["total"] == len(rows), (
        "the cache's own metadata disagrees with the rows it stored — an earlier "
        "fetch was truncated")
    assert all(r["countyCode"] == "48157" for r in rows), (
        "a Fort Bend claim query returned a claim from another county")

    riv = raw_json("nws/riv_gauges_brazos.json")["features"]
    assert len(riv) == manifest["riv_gauges_brazos"]["count"], (
        f"manifest says {manifest['riv_gauges_brazos']['count']} Brazos gauges, "
        f"cache holds {len(riv)}")
    assert all("action" in f["attributes"] for f in riv), (
        "a gauged river came back without the thresholds this project is built on")


def test_usgs_summary_matches_the_cached_series(raw_json):
    """The gauge record every stage descends from, held to its own summary."""
    summary = raw_json("usgs/_summary.json")
    assert summary["summary"], "the USGS summary is empty"
    for row in summary["summary"]:
        site = row["site"]
        peaks = read_json(RAW / "usgs", f"{site}_peaks.json")
        assert peaks["site"] == site, f"{site}_peaks.json is for {peaks['site']}"
        assert len(peaks["peaks"]) == row["peaks"], (
            f"{site}: summary says {row['peaks']} peaks, cache holds {len(peaks['peaks'])}")

        daily = read_json(RAW / "usgs", f"{site}_daily.json")
        assert daily["site"] == site
        assert len(daily["stage_daily"]) == row["stage_days"], (
            f"{site}: summary says {row['stage_days']} stage days, "
            f"cache holds {len(daily['stage_daily'])}")
        assert len(daily["flow_daily"]) == row["flow_days"], (
            f"{site}: summary says {row['flow_days']} flow days, "
            f"cache holds {len(daily['flow_daily'])}")


def test_fbcad_cache_is_internally_consistent(raw_json):
    """The address index is built from this file, so its counts must be true."""
    fbcad = raw_json("fbcad_roads.json")
    roads = fbcad["roads"]
    assert len(roads) == fbcad["counts"]["withAddressRangeAndGeometry"], (
        "the FBCAD receipt's count does not match the records actually cached")
    assert roads, "the FBCAD road cache is empty"
    for r in roads:
        assert r["lo"] <= r["hi"], f"{r['name']}: inverted range {r['lo']}..{r['hi']}"
        assert r["pts"] and len(r["pts"]) == 2, f"{r['name']}: geometry was not reduced to endpoints"
        lon, lat = r["pts"][0]
        assert -97 < lon < -95 and 29 < lat < 30, f"{r['name']} sits outside the corridor"


def test_interval_cache_the_backcast_replays_still_exists(raw_json):
    """The 2017 backcast replays this file; without it the replay has no source."""
    path = RAW / "usgs" / "iv" / "08114000_20170822.json"
    assert path.exists(), (
        "the cached 2017 interval record is missing — backcast.py and the app's replay "
        "series both read it")
    rows = read_json(RAW / "usgs" / "iv", "08114000_20170822.json")
    assert len(rows) > 200, f"only {len(rows)} interval rows cached for the Harvey window"
