#!/usr/bin/env python3
"""
The premise, measured.

Counts Fort Bend NFIP claims rated OUTSIDE the mapped 100-year floodplain (X zones)
using the cached OpenFEMA v3 snapshot. This is the app's empirical justification:
the county's floodplain map did not warn most residents who actually claimed.

Input : data/raw/openfema/nfip_claims_48157_v3.json
Usage : python3 pipeline/analyze/nfip_xzone.py
License: this project's own code; data (c) FEMA OpenFEMA, public domain terms.
"""
import json
import collections
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "raw" / "openfema" / "nfip_claims_48157_v3.json"


def is_x(z):
    return bool(z) and str(z).upper().startswith("X")


def money(rows):
    return sum((r.get("amountPaidOnBuildingClaim") or 0) for r in rows)


def main():
    rows = json.loads(SRC.read_text())["NfipClaims"]
    n = len(rows)
    x = [r for r in rows if is_x(r.get("ratedFloodZone"))]

    print(f"Fort Bend NFIP claims: {n}")
    print(f"dateOfLoss span: {min(r.get('dateOfLoss') or 'z' for r in rows)[:10]}"
          f" .. {max(r.get('dateOfLoss') or '' for r in rows)[:10]}")
    print()
    print("ratedFloodZone distribution:")
    for z, c in collections.Counter(r.get("ratedFloodZone") for r in rows).most_common(10):
        print(f"  {str(z):>6}  {c:5}  {c / n * 100:5.1f}%")
    print()
    print(f"X-zone (outside 100-yr SFHA): {len(x)}  ({len(x) / n * 100:.1f}%)")
    print(f"  building $: ${money(x):,.0f} of ${money(rows):,.0f} "
          f"({money(x) / money(rows) * 100:.1f}%)")

    harvey = [r for r in rows if str(r.get("dateOfLoss") or "").startswith(("2017-08", "2017-09"))]
    if harvey:
        hx = sum(1 for r in harvey if is_x(r.get("ratedFloodZone")))
        print(f"\nHarvey (Aug-Sep 2017): {len(harvey)} claims, {hx} X-zone ({hx / len(harvey) * 100:.1f}%)")


if __name__ == "__main__":
    main()
