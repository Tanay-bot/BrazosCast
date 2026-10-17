#!/usr/bin/env python3
"""
BrazosCast — offline address index.

Turns "4710 Jackson Street, Richmond, TX" into the app's own road-segment index,
with no geocoding API, no key, and no network at run time.

Why this exists (all measured, see docs/ACTION-PLAN.md §D1):
  - the US Census geocoder sends NO Access-Control-Allow-Origin header, so a
    browser cannot call it at all;
  - and it returns zero matches for this corridor across all four valid
    benchmarks, while matching DC/Austin/Houston addresses;
  - Mapbox works but needs a token, and the app's placeholder invited an address
    the app could not resolve.
The source instead is the county's own road centerlines with TIGER-style address
ranges (LF/LT/RF/RT_ADDR), cached by pipeline/fetch/fetch_fbcad_roads.mjs.

MAPPING RULE — name agreement, not nearest-neighbour.
A first cut snapped every county segment to its geometrically nearest mainstem
segment. That is wrong, and measurably so: "THOMPSON FERRY RD" snapped to
"Oilfield Road" and "Lake Olympia Parkway" — different streets, because the app
only models 1,614 segments near the Brazos, and a county road that the app does
not model is not made model-able by being close to one that is. An address on
Thompson Ferry Rd would have been told another street's flood answer.

So a county segment contributes an address range ONLY to an app segment of the
same street name (canonicalised, with alias and parenthetical handling). The
distance test survives only to pick WHICH same-named segment a range belongs to
(a long street becomes many segments with different thresholds). County streets
the app does not model get no range at all, and the app says so instead of
inventing an answer.

The app addresses road segments by their POSITION in road_thresholds.geojson —
that ordering is what ties a click to a route — so this index stores positions
and must be rebuilt whenever that file changes. The reference block records
enough of it to make a stale index detectable.

Usage: <env>/bin/python pipeline/derive/address_index.py
Output: data/derived/address_index.json  (copied to app/public/data by app_data.py)
"""
import hashlib
import json
import pathlib
import re

import numpy as np
from pyproj import Transformer
from shapely import STRtree, transform as shp_transform
from shapely.geometry import LineString, Point

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
RAW = ROOT / "data" / "raw"
THRESHOLDS_GEOJSON = DERIVED / "road_thresholds.geojson"
THRESHOLDS_JSON = DERIVED / "road_thresholds.json"
FBCAD = RAW / "fbcad_roads.json"
OUT = DERIVED / "address_index.json"

# How far a same-named county segment may sit from an app segment and still be
# taken as describing it. This is a QUALITY gate, and the value is measured:
# agreement between this index and a map click falls off monotonically with the
# snap distance, so a generous radius buys coverage by buying wrong answers.
#   snap       n     same street as a map click
#   0-10 m   788    79.7%
#   10-50 m  111    79.3%
#   50-100 m  55    67.3%
#   100-400 m 197   45.7%
#   400-1000 170    29.4%
#   1000-2000 157   16.6%
# 50 m keeps the band that agrees ~80% of the time and drops the speculative
# tail: a county road in a different city that shares a name is a different road.
NEAR_M = 50.0

# Real addresses, asserted on every build so a change to the canonicalisation or
# to the county fetch cannot silently break the app's headline interaction.
# The expected value is the app street the address must land on. Segment indices
# are deliberately NOT asserted: they shift whenever road_thresholds is rebuilt,
# and pinning them would make this gate fail for the wrong reason.
KNOWN_ADDRESSES = [
    ("1600 Jackson Street, Richmond, TX", "Jackson Street"),
    ("2100 Avenue I, Rosenberg, TX", "Avenue I"),
    ("1100 Brooks Street, Richmond, TX", "Brooks Street"),
    ("2500 FM 762, Richmond, TX", "FM 762"),
    ("3350 Skinner Lane, Richmond, TX", "Skinner Lane"),
    ("300 Collins Road, Richmond, TX", "Collins Road"),
]
# A street the app does not model must NOT resolve to some other street's
# answer, and a small typo must still find its street.
UNMODELLED_ADDRESS = "4710 Thompson Ferry Rd, Richmond, TX"
TYPO_ADDRESS = "1600 Jacson Street, Richmond, TX"

# --- street-name canonicalisation -----------------------------------------
# The county abbreviates where OSM does not, and people do neither consistently,
# so both sides map to one canonical form. Expanding (not abbreviating) is the
# direction that collapses the most variants: "FM 762" and "Farm to Market 762"
# and "Farm to Market 762 Road" all become the same key.
TOKEN_MAP = {
    "RD": "ROAD", "ST": "STREET", "AVE": "AVENUE", "AV": "AVENUE",
    "DR": "DRIVE", "BLVD": "BOULEVARD", "LN": "LANE", "HWY": "HIGHWAY",
    "PKWY": "PARKWAY", "CT": "COURT", "CIR": "CIRCLE", "PL": "PLACE",
    "TRL": "TRAIL", "TER": "TERRACE", "FWY": "FREEWAY", "EXPY": "EXPRESSWAY",
    "N": "NORTH", "S": "SOUTH", "E": "EAST", "W": "WEST",
    "NE": "NORTHEAST", "NW": "NORTHWEST", "SE": "SOUTHEAST", "SW": "SOUTHWEST",
    "RM": "RANCH ROAD", "RR": "RANCH ROAD", "FM": "FARM TO MARKET",
    "IH": "INTERSTATE", "SH": "STATE HIGHWAY", "US": "US",
}
# Trailing tokens that may be dropped to make one key, so "Jackson Street" and
# "Jackson" find each other. Only dropped from the END, and only when something
# is left, because "Farm to Market 1093 Road" and "Farm to Market 1093" are the
# same street while "Highway" alone is not a street.
TYPE_TOKENS = {
    "ROAD", "STREET", "AVENUE", "DRIVE", "LANE", "HIGHWAY", "BOULEVARD",
    "PARKWAY", "COURT", "CIRCLE", "PLACE", "TRAIL", "TERRACE", "FREEWAY",
    "EXPRESSWAY",
}
DIRECTIONALS = {"NORTH", "SOUTH", "EAST", "WEST", "NORTHEAST", "NORTHWEST",
                "SOUTHEAST", "SOUTHWEST"}

# City / state / ZIP tails people paste in, which are not part of the street name.
ADDRESS_TAIL = re.compile(
    r"\s*,?\s*(?:RICHMOND|ROSENBERG|SUGAR\s*LAND|MISSOURI\s*CITY|NEEDVILLE|"
    r"FULSHEAR|KATY|STAFFORD|HOUSTON|THOMPSONS|SIMONTON|BEASLEY|PLEAK|"
    r"EAST\s*BERNARD|SAN\s*FELIPE|FRESNO|CRAIG|ARCOLA|DAMON)\b.*$",
    re.IGNORECASE,
)
STATE_ZIP = re.compile(
    r"\s*,?\s*\bTEXAS\b.*$|\s*,?\s*\bTX\b.*$|\s+\d{5}(?:-\d{4})?\s*$",
    re.IGNORECASE,
)


def canonical(name: str) -> str:
    s = name.upper()
    s = re.sub(r"[^A-Z0-9]+", " ", s)
    return " ".join(TOKEN_MAP.get(t, t) for t in s.split())


def name_keys(raw_name: str) -> set[str]:
    """Every canonical key a street may be looked up by.

    Variants generated per name: the name itself; with any parenthetical dropped
    and with it kept (counties file "THOMPSONS RD (FM 762)" but drivers say
    "FM 762"); a leading "STATE" dropped so "State Highway 6" meets "Highway 6";
    "US" expanded so "US 90A" meets "US Highway 90A"; a trailing road-type token
    dropped so "Jackson Street" meets "Jackson"; and each of those with a leading
    directional dropped so "East US Highway 90A" meets "US Highway 90A".
    """
    variants = [raw_name, re.sub(r"\([^)]*\)", " ", raw_name),
                *re.findall(r"\(([^)]*)\)", raw_name)]
    keys: set[str] = set()
    for variant in variants:
        c = canonical(variant)
        if not c:
            continue
        base = [c]
        if c.startswith("STATE "):
            base.append(c[len("STATE "):])
        base.append(re.sub(r"\bUS\b", "US HIGHWAY", c))
        for b in list(base):
            toks = b.split()
            if len(toks) > 1 and toks[-1] in TYPE_TOKENS:
                base.append(" ".join(toks[:-1]))
        for b in list(base):
            toks = b.split()
            if len(toks) > 2 and toks[0] in DIRECTIONALS:
                base.append(" ".join(toks[1:]))
        for b in base:
            if b and b not in TYPE_TOKENS:
                keys.add(b)
    return keys


def parse_address(text: str) -> tuple[int | None, str]:
    """'4710 Jackson Street, Richmond, TX 77469' -> (4710, 'JACKSON STREET')."""
    s = STATE_ZIP.sub(" ", text.strip())
    s = ADDRESS_TAIL.sub(" ", s)
    m = re.match(r"^\s*(\d+)\s+(.*)$", s)
    if m:
        return int(m.group(1)), canonical(m.group(2))
    return None, canonical(s)


def edit_distance(a: str, b: str) -> int:
    """Levenshtein, for the app's 'did you mean' tier. Iterative and bounded by
    the shorter string so a long name cannot blow this up."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def resolve(streets, keys, ranges, text):
    """The app's lookup rule, in Python, so the build can assert it works.

    Returns (status, street_index, matched_entry). A segment may carry several
    address ranges (several county segments snap to the same app segment), so
    the MATCHED entry is returned rather than looked up again by segment —
    looking it up again hands back an arbitrary one of them.
    """
    num, key = parse_address(text)
    target = keys.get(key)
    if not target:
        return "street_unknown", None, None
    cand = [e for e in ranges if e[0] in target]
    if not cand:
        return "street_has_no_ranges", None, None
    if num is None:
        return "ok", cand[0][0], cand[0]
    hits = [e for e in cand if e[1] <= num <= e[2]]
    if not hits:
        return "number_outside_range", None, None
    hits.sort(key=lambda e: (e[2] - e[1], e[3]))
    return "ok", hits[0][0], hits[0]


# --- geometry ---------------------------------------------------------------
def project(geoms, transformer):
    """Project shapely geometries to metres without the deprecated ops.transform."""

    def fn(coords):
        x, y = transformer.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    return [shp_transform(g, fn) for g in geoms]


def main():
    thresh = json.loads(THRESHOLDS_GEOJSON.read_text())
    thresh_list = json.loads(THRESHOLDS_JSON.read_text())
    feats = thresh["features"]

    # The app indexes by position, so any mismatch between the two artifacts
    # would silently resolve addresses to the wrong street.
    if len(feats) != len(thresh_list):
        raise SystemExit(
            f"road_thresholds.geojson has {len(feats)} features but "
            f"road_thresholds.json has {len(thresh_list)} — rebuild one.")
    bad = [i for i, (f, r) in enumerate(zip(feats, thresh_list))
           if f["properties"]["osmid"] != r["id"]]
    if bad:
        raise SystemExit(f"feature order differs between the two road_thresholds "
                         f"artifacts at {len(bad)} positions (first: {bad[0]})")

    main_geoms = [
        LineString(f["geometry"]["coordinates"][0])
        if f["geometry"]["type"] == "LineString"
        else LineString(max(f["geometry"]["coordinates"], key=len))
        for f in feats
    ]
    tf = Transformer.from_crs("EPSG:4326", "EPSG:32614", always_xy=True)
    main_m = project(main_geoms, tf)

    # --- app streets: name -> the segments that carry it -------------------
    streets: list[dict] = []
    street_of_name: dict[str, int] = {}
    key_owner: dict[str, list[int]] = {}   # canonical key -> street indices
    for i, r in enumerate(thresh_list):
        nm = r["name"]
        if not nm:
            continue
        si = street_of_name.get(nm)
        if si is None:
            si = len(streets)
            street_of_name[nm] = si
            streets.append({"n": nm, "k": [], "s": []})
            for k in name_keys(nm):
                key_owner.setdefault(k, []).append(si)
                streets[si]["k"].append(k)
        streets[si]["s"].append(i)

    for st in streets:
        st["k"].sort()

    # --- county segments: attach a range to a SAME-NAMED app segment -------
    app_key_to_segs: dict[str, list[int]] = {}
    for st in streets:
        for k in st["k"]:
            app_key_to_segs.setdefault(k, []).extend(st["s"])
    app_key_to_segs = {k: sorted(set(v)) for k, v in app_key_to_segs.items()}

    fbcad = json.loads(FBCAD.read_text())
    roads = fbcad["roads"]

    street_tree = STRtree(main_m)
    ranges: list[list[int]] = []
    seen: set[tuple[int, int, int, int]] = set()
    matched_names: set[str] = set()
    unmatched = 0
    too_far = 0

    for r in roads:
        county_keys = set(name_keys(r["name"]))
        if r.get("alias"):
            county_keys |= name_keys(r["alias"])
        hit_keys = county_keys & app_key_to_segs.keys()
        if not hit_keys:
            unmatched += 1
            continue
        matched_names.add(r["name"])

        candidates = sorted({s for k in hit_keys for s in app_key_to_segs[k]})
        (lon1, lat1), (lon2, lat2) = r["pts"]
        p = Point(*tf.transform((lon1 + lon2) / 2.0, (lat1 + lat2) / 2.0))
        # The distance test is a correctness requirement, not a tie-break: the
        # county has a "JACKSON STREET" in more than one city, and without this
        # the far one's house numbers (13417-13499) attach themselves to
        # Richmond's Jackson Street segments. A same-named road that is not
        # physically here is a DIFFERENT road, so it gets no range.
        near = street_tree.query_nearest(p, max_distance=NEAR_M, return_distance=True)
        pool = [s for s in candidates if s in set(int(j) for j in near[0])]
        if not pool:
            too_far += 1
            continue
        # Same street name, several segments: the range belongs on the one
        # physically nearest the county segment it came from.
        best = min(pool, key=lambda s: main_m[s].distance(p))

        # A county name that is not the app's own name (an alias, a
        # parenthetical, a different abbreviation) is still a key people type,
        # so it is recorded against the street it resolved to.
        si = street_of_name[thresh_list[best]["name"]]
        for k in sorted(county_keys):
            if k not in app_key_to_segs:
                key_owner.setdefault(k, [])
                if si not in key_owner[k]:
                    key_owner[k].append(si)

        tag = (si, int(r["lo"]), int(r["hi"]), best)
        if tag not in seen:
            seen.add(tag)
            ranges.append([si, int(r["lo"]), int(r["hi"]), best])

    ranges.sort(key=lambda e: (e[0], e[1], e[3]))

    # Keys that resolve to more than one app street (OSM splits one road into
    # "US Highway 90A" and "East US Highway 90A") are kept: the address range is
    # what then decides which segment is right.
    ambiguous = {k: v for k, v in key_owner.items() if len(v) > 1}
    key_owner = {k: sorted(v) for k, v in sorted(key_owner.items())}

    osmid_hash = hashlib.sha256(
        ",".join(str(f["properties"]["osmid"]) for f in feats).encode()
    ).hexdigest()[:16]

    payload = {
        "version": 1,
        "source": fbcad["source"],
        "note": (
            "Offline address index: house number -> county road segment -> the app's "
            "road_thresholds.geojson position. No geocoder, no API key, no network. "
            "Coordinates are not stored; the position is resolved at build time."
        ),
        "method": (
            "county address range attached to an APP SEGMENT OF THE SAME STREET NAME "
            f"(canonicalised; among same-named segments, the nearest within {NEAR_M:.0f} m). "
            "Streets the app does not model get no range and are reported as outside "
            "coverage rather than snapped to a different street."
        ),
        # Recorded in the payload, not just in this script, because it is what
        # bounds the index's accuracy: a consumer seeing a range attached across
        # a long snap should be able to tell how loose the mapping rules were.
        "max_distance_m": NEAR_M,
        "reference": {
            "file": "road_thresholds.geojson",
            "segments": len(feats),
            "osmid_sha256_16": osmid_hash,
        },
        "streets": [{"n": st["n"], "s": st["s"]} for st in streets],
        # canonical key -> the app streets it names. County spellings that
        # resolved to an app street are in here too, which is what lets a
        # driver's "FM 762" reach the segment OSM files as "FM 762".
        "keys": key_owner,
        "ranges": ranges,
        "scope": {
            "county_segments": len(roads),
            "county_streets_matching_app": len(matched_names),
            "county_segments_outside_app_coverage": unmatched,
            "county_segments_too_far_from_same_name": too_far,
            "app_streets": len(streets),
            "lookup_keys": len(key_owner),
            "ambiguous_keys": len(ambiguous),
        },
    }

    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    size_kb = OUT.stat().st_size / 1024
    sc = payload["scope"]
    print(f"app streets: {sc['app_streets']}  lookup keys: {sc['lookup_keys']} "
          f"({sc['ambiguous_keys']} ambiguous)")
    print(f"county: {sc['county_streets_matching_app']} street names matched, "
          f"{sc['county_segments_outside_app_coverage']} segments outside app coverage, "
          f"{sc['county_segments_too_far_from_same_name']} too far from a same-named segment")
    print(f"{len(ranges)} address ranges attached to app segments")
    print(f"-> {OUT} ({size_kb:.0f} KB)")

    # --- gates -------------------------------------------------------------
    if size_kb > 250:
        raise SystemExit(f"address index is {size_kb:.0f} KB — too heavy for a static payload")
    if not ranges:
        raise SystemExit("no address ranges attached — the name mapping is broken")
    # Every range must name an app segment whose canonical keys include the
    # street key it was filed under, or the mapping rule was not honoured.
    names = [st["n"] for st in streets]
    for si, lo, hi, sj in ranges:
        if not (thresh_list[sj]["name"] == names[si]):
            raise SystemExit(f"range filed under '{names[si]}' but points at "
                             f"segment {sj} named '{thresh_list[sj]['name']}'")
        if lo > hi:
            raise SystemExit(f"inverted address range {lo}..{hi} on {names[si]}")
    print(f"gate: every one of {len(ranges)} ranges points at a same-named app segment")

    # The app must be able to answer for the streets it advertises, so at least
    # one street has to survive with a usable span.
    with_span = len({e[0] for e in ranges})
    print(f"gate: {with_span}/{len(streets)} app streets carry at least one address range")
    if with_span < 20:
        raise SystemExit(f"only {with_span} app streets have address ranges — "
                         f"the canonicalisation is not converging")
    # Every lookup key must land on a real street, or the app would match a key
    # and then have nothing to select.
    for k, v in key_owner.items():
        if not v or any(si < 0 or si >= len(streets) for si in v):
            raise SystemExit(f"key '{k}' points at street indices {v}")
    print(f"gate: all {len(key_owner)} keys land on a real street")

    # The headline interaction: real addresses must resolve, to the RIGHT
    # street, with the number inside the range that was used.
    names_by_idx = [st["n"] for st in streets]
    for text, expected_street in KNOWN_ADDRESSES:
        status, si, entry = resolve(streets, key_owner, ranges, text)
        if status != "ok":
            raise SystemExit(f"known address did not resolve: {text!r} -> {status}")
        got = names_by_idx[si]
        if got != expected_street:
            raise SystemExit(f"known address resolved to the wrong street: "
                             f"{text!r} -> {got!r}, expected {expected_street!r}")
        num, _ = parse_address(text)
        if not (entry[1] <= num <= entry[2]):
            raise SystemExit(f"{text!r} landed on {got} via range "
                             f"{entry[1]}..{entry[2]}, which excludes {num}")
    print(f"gate: all {len(KNOWN_ADDRESSES)} known addresses resolve to the right street")

    # A street the app does not model must be refused rather than answered with
    # a different street's threshold.
    status, _, _ = resolve(streets, key_owner, ranges, UNMODELLED_ADDRESS)
    # (returns the refusal status; asserted below)
    if status != "street_unknown":
        raise SystemExit(f"unmodelled address was not refused: "
                         f"{UNMODELLED_ADDRESS!r} -> {status}")
    print(f"gate: an unmodelled street is refused ({UNMODELLED_ADDRESS!r})")

    # The typo tier depends on these being close but not equal, so assert the
    # distance the app will rely on rather than the mechanism.
    _, typo_key = parse_address(TYPO_ADDRESS)
    close = [k for k in key_owner if edit_distance(k, typo_key) <= 2]
    if not close:
        raise SystemExit(f"no suggestion within edit distance 2 of {typo_key!r} — "
                         f"the typo tier would have nothing to offer")
    print(f"gate: a typo ({typo_key!r}) suggests {close[0]!r}")


if __name__ == "__main__":
    main()
