#!/usr/bin/env python3
"""
BrazosCast — Step 3: can the street-threshold defect be corrected?

The thresholds treat `threshold_hand_ft` — a HAND height referenced to the nearest
drainage cell — as the Richmond gauge stage. Five routes to replacing that with a
physically-correct conversion were tested here. **All five are closed by
measurement, and this module does not apply a correction.** What it does instead:

  1. Reproduces each closure as a number, so a route cannot be re-proposed without
     confronting the measurement that killed it.
  2. Ships the one asset the investigation produced that DOES validate: a relative
     channel-bed profile recovered by integrating NWM reach slopes, checked against
     the six gauge bed elevations in `usgs_elev_table.csv` (r = 0.986). It is
     datum-free, needs no DEM, and is what a future DEM-based re-run would be
     checked against.
  3. Refuses to write a corrected threshold set it cannot defend, and records
     exactly what would be required to reopen the question.

THE FIVE CLOSURES (all reproduced below, values printed at run time)

  R1  Discharge through a rating curve — the review's proposed fix #2.
      `threshold_discharge_cfs` is a cross-reach mixture (rejected earlier), but
      each reach's OWN synthetic rating is on disk in the branch hydrotable, and
      the fimpact table carries the HydroID that set each threshold, so every
      segment maps to exactly one sub-reach rating. Tested properly, the route
      WORKS where it can be applied and it fixes the defect:

        * all 225 sub-reach ratings are monotone (an earlier version of this
          module reported them as non-monotone; that was an artifact of grouping
          by `feature_id`, which interleaves 2-9 sub-reaches into one curve);
        * at the gauge's own sub-reach the chain returns HAND within 2.6 ft for
          HAND 15-30 ft, which is the intrinsic anchor test;
        * applied to the corridor it moves State Highway 6 14.2 -> 27.5 ft,
          Grand Parkway 15.2 -> 28.8 ft and US Highway 90A 16.5 -> 30.5 ft, all
          clear of the 20 ft action stage, and it lifts 17 of the 18 classified
          highways that sit below action.

      It still cannot ship, for two measured reasons:

        * It is not a lift. In-record it moves 645 segments up and 117 down
          (median +8.3 ft), because each reach's rating is stretched differently.
          So it does not remove the below-action set, it redistributes it: 17 of
          the 18 are lifted, and 17 different ones (Jimmy Phillips Blvd, South
          Brooks Street, East Brazos Avenue) are pushed below action. Net 18.
        * Two thirds of segments (1,014 of 1,776) need a discharge beyond the
          gauged record, and the hybrid — convert in range, keep HAND otherwise —
          is non-monotone: converted values reach 25 ft above the lowest kept
          values, so 637 segments would report a LATER flood stage than higher
          ground nearby.

      The machinery is correct and internally anchored; the validation that
      would justify shipping it is the missing part (see `to_reopen`).

  R2  Per-reach channel bed elevations, absolute.
      `usgs_elev_table.csv` does hold `dem_adj_elevation` per gauge reach, and the
      six mainstem values form a clean monotone profile (Hempstead 35.71 m down to
      West Columbia 0.16 m). But those elevations and the gauge's own zero datum
      (`nws_data_zero_datum` = 26.73 ft, NAVD88) cannot be reconciled with
      anything in this repo: taking them at face value shifts every threshold by
      +24.7 ft, which puts the median corridor road above any flood on record.
      The relative profile is sound; the datum is not resolvable here.

  R3  The flat-pool correction the review asked for.
      Premise corrected rather than route implemented. Applying
      s = HAND + [bed(x) - bed(gauge)] ADDS slope to the output instead of
      removing it: the bed drops ~1.4 ft/mile downstream with the same sign as
      the observed -0.92 ft/mile threshold trend. Under normal flow the physical
      correction is a constant offset, not a distance correction, so "kill the
      slope artifact" was aiming at the wrong target.

  R4  Re-reference to the Brazos where HAND is referenced to a tributary.
      The mechanism is real and confirmed: every segment below 20 ft sits 2,000+
      m from the Brazos but 8-200 m from a mapped tributary. Implementing it from
      the NWM flowlines over-corrects the median by +28.5 ft — enough to push the
      median threshold above the Harvey peak — because NWM flowlines are not
      HAND's reference drainage. Checking against the actual HAND raster: of the
      1,614 segments, only ~670 have any drainage cell within 2.5 km, none of
      those references lies outside the mainstem branch, and the remaining ~945
      cannot be re-referenced at all. The reference cannot be identified reliably
      from the data in this repo.

  R5  Validate a correction against observed flooding.
      The only in-repo observation of actual flood depths is the OpenFEMA NFIP
      claims set (7,389 Fort Bend claims, 3,928 of them Harvey). Its coordinates
      are privacy-coarsened to 0.1 degrees: 7,387 claims collapse onto SIX
      distinct latitudes and EIGHT longitudes, about 11 km per cell. There is no
      point-level validation available offline.

TO REOPEN STEP 3, one of these must be acquired:
  * a DEM, to re-run HAND so that each cell is referenced to the correct drainage
    (and the gauge's vertical datum must be documented alongside it), or
  * per-reach channel bed elevations in the gauge's own vertical datum, or
  * USGS/NOAA observed inundation extent for Harvey (polygons, not rounded points).
Whichever arrives must be checked against the bed profile in `bed_profile.json`
and must reproduce the gauge's own reach as unchanged (HAND = stage there).

R1 is the closest to reopening: its conversion is written and its machinery is
validated at the gauge, so an observed extent would be enough to settle whether
the conversion's magnitude is right — and if it is, the route can ship whole.

Usage: <env>/bin/python pipeline/derive/threshold_correction.py
Output: data/derived/bed_profile.json, data/derived/threshold_correction.json
"""
import json
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
HAND = ROOT / "data" / "raw" / "hand" / "12070104"
BRANCH = HAND / "branches" / "3125000011"
DERIVED = ROOT / "data" / "derived"

MAINSTEM_LEVELPATH = 3125000011
GAUGE_REACH = 3123784          # RMOT2 / USGS 08114000
GAUGE_ZERO_DATUM_FT = 26.73    # as published in usgs_elev_table.csv (NAVD88)
FT_PER_M = 3.28084
CFS_PER_CMS = 35.3146667
BED_SLOPE_SANITY_FT_PER_MILE = (0.5, 2.5)   # plausible water-surface/bed slope here


# --------------------------------------------------------------------------
# The validated asset: a relative channel-bed profile from NWM reach slopes
# --------------------------------------------------------------------------
def bed_profile() -> dict:
    """Integrate NWM reach slope x length downstream to the outlet. Datum-free:
    only differences are meaningful, and those are what validate against the
    gauge bed elevations."""
    import geopandas as gpd

    st = gpd.read_file(HAND / "nwm_subset_streams.gpkg")
    to_of = dict(zip(st["ID"], st["to"]))
    sl = dict(zip(st["ID"], st["Slope"]))
    ln = dict(zip(st["ID"], st["Length"]))

    def rise_to_outlet(fid, limit=4000):
        total, seen, cur = 0.0, set(), fid
        while cur in to_of and len(seen) < limit:
            if cur in seen:
                return None
            seen.add(cur)
            total += float(sl[cur]) * float(ln[cur])
            nxt = to_of[cur]
            if nxt == cur or nxt not in to_of:
                break
            cur = nxt
        return total

    anchors = pd.read_csv(HAND / "usgs_elev_table.csv", low_memory=False)
    anchors = anchors[(anchors["levpa_id"] == MAINSTEM_LEVELPATH)].copy()
    anchors["feature_id"] = anchors["feature_id"].astype("int64")
    anchors["dem_adj_elevation"] = pd.to_numeric(anchors["dem_adj_elevation"], errors="coerce")
    anchors["zero_datum_ft"] = pd.to_numeric(anchors["nws_data_zero_datum"], errors="coerce")

    rows = []
    for _, a in anchors.iterrows():
        r = rise_to_outlet(int(a["feature_id"]))
        if r is None:
            continue
        rows.append({"feature_id": int(a["feature_id"]), "lid": a.get("nws_lid"),
                     "integrated_rise_m": r, "dem_adj_elevation_m": float(a["dem_adj_elevation"]),
                     "zero_datum_ft": None if pd.isna(a["zero_datum_ft"]) else float(a["zero_datum_ft"])})
    if len(rows) < 4:
        raise SystemExit(f"only {len(rows)} gauge anchors resolved — refusing to fit a profile")

    x = np.array([r["integrated_rise_m"] for r in rows])
    y = np.array([r["dem_adj_elevation_m"] for r in rows])
    r_val = float(np.corrcoef(x, y)[0, 1])
    off = y - x
    order = [r["feature_id"] for r in sorted(rows, key=lambda r: -r["dem_adj_elevation_m"])]
    elev = [r["dem_adj_elevation_m"] for r in sorted(rows, key=lambda r: -r["dem_adj_elevation_m"])]
    monotone = all(b <= a for a, b in zip(elev, elev[1:]))

    # does the integrated profile reproduce the observed bed slope, in ft/mile?
    st_m = st.set_index("ID")
    slope_sanity = None
    path = []
    cur, seen = GAUGE_REACH, set()
    while cur in st_m.index and len(seen) < 4000:
        if cur in seen:
            break
        seen.add(cur)
        row = st_m.loc[cur]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        path.append((float(row["Slope"]), float(row["Length"])))
        nxt = row["to"]
        if nxt == cur or nxt not in st_m.index:
            break
        cur = nxt
    if path:
        drop_ft = sum(s * l for s, l in path) * FT_PER_M
        miles = sum(l for _, l in path) / 1609.344
        slope_sanity = drop_ft / miles if miles > 0 else None

    return {
        "method": ("integrate NWM reach Slope x Length downstream from each reach to the outlet; "
                   "a datum-free relative profile (only differences are meaningful)"),
        "anchors": rows,
        "anchor_count": len(rows),
        "anchor_elevations_monotone_downstream": bool(monotone),
        "anchor_order": order,
        "correlation_integrated_vs_dem_m": r_val,
        "offset_spread_m": {"mean": float(np.mean(off)), "min": float(np.min(off)),
                            "max": float(np.max(off)), "std": float(np.std(off))},
        "implied_slope_from_gauge_to_outlet_ft_per_mile": None if slope_sanity is None else float(slope_sanity),
        "gauge_zero_datum_ft": GAUGE_ZERO_DATUM_FT,
        "verdict": ("relative profile validated (r above the gate); absolute elevations are NOT "
                    "usable because the gauge zero datum and dem_adj_elevation are in "
                    "irreconcilable vertical references"),
    }


# --------------------------------------------------------------------------
# R1 — the per-reach synthetic ratings
# --------------------------------------------------------------------------
def rating_closure(roads: list) -> dict:
    """The discharge route, tested properly this time.

    An earlier version of this closure claimed the per-reach ratings are
    non-monotone. They are not: all 225 sub-reach curves are monotone. That
    reading was an artifact of grouping by `feature_id`, which merges 2-9
    sub-reaches into one interleaved curve. Corrected here.

    What IS true: the chain is implementable (the fimpact table carries the
    HydroID that set each threshold, so a segment maps to exactly one sub-reach
    rating), it reproduces the known-good case at the gauge's own sub-reach, and
    it fixes the defect where it is in range. It just cannot be applied to the
    whole corridor, and the hybrid is not monotone.
    """
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import gauge_rating as G

    fp = pd.read_csv(HAND / "osm_roads_fimpact.csv")
    sub = fp[fp["branch"] == MAINSTEM_LEVELPATH].copy()
    ht = pd.read_csv(BRANCH / "hydroTable_3125000011.csv",
                     usecols=["HydroID", "feature_id", "stage", "discharge_cms"])
    rat = {int(h): (g.sort_values("stage")["stage"].to_numpy(),
                    g.sort_values("stage")["discharge_cms"].to_numpy())
           for h, g in ht.groupby("HydroID")}

    nonmono = sum(1 for _, g in ht.groupby("HydroID")
                  if np.any(np.diff(g.sort_values("stage")["discharge_cms"].to_numpy()) < 0))
    merged_nonmono = sum(1 for _, g in ht.groupby("feature_id")
                         if np.any(np.diff(g.sort_values("stage")["discharge_cms"].to_numpy()) < 0))

    # intrinsic validation: at the gauge's own sub-reach the chain must return HAND
    d0, q0 = rat[24770118]
    calib = []
    for h_ft in (15, 20, 25, 30, 35, 40):
        s, _ = G.stage_from_flow(float(np.interp(h_ft * 0.3048, d0, q0)) * CFS_PER_CMS)
        calib.append({"hand_ft": h_ft, "implied_stage_ft": round(s, 2), "error_ft": round(s - h_ft, 2)})

    idx = sub.groupby("osmid")["threshold_hand_ft"].idxmin()
    key = sub.loc[idx, ["osmid", "HydroID", "threshold_hand_ft", "highway", "name"]].copy()

    def conv(r):
        d, q = rat[int(r["HydroID"])]
        qc = float(np.interp(r["threshold_hand_ft"] * 0.3048, d, q)) * CFS_PER_CMS
        s, ex = G.stage_from_flow(qc)
        return pd.Series({"q_cfs": qc, "s_star": s, "extrap": ex})

    key = pd.concat([key, key.apply(conv, axis=1)], axis=1)
    inn, out = key[~key["extrap"]], key[key["extrap"]]
    cls = ("motorway", "trunk", "primary")
    named = {}
    for nm, hw in (("State Highway 6", "primary"), ("Grand Parkway", "primary"), ("US Highway 90A", "primary")):
        m = key[key["name"].astype(str).str.contains(nm, na=False)]
        if len(m):
            named[nm] = {"n": int(len(m)),
                         "hand_min_ft": round(float(m["threshold_hand_ft"].min()), 1),
                         "converted_min_ft": round(float(m["s_star"].min()), 1)}

    # The conversion is not a lift: it moves a segment to the stage its own reach
    # needs, and that can be up OR down. So count both directions and both
    # effects on the defect, rather than reporting a single net change.
    c = key[key["highway"].isin(cls)]
    ci = c[~c["extrap"]]
    a_off = c[c["threshold_hand_ft"] < 20.0]
    a_in = a_off[~a_off["extrap"]]
    lifted = a_in[a_in["s_star"] >= 20.0]
    still = a_in[a_in["s_star"] < 20.0]
    newly = ci[(ci["threshold_hand_ft"] >= 20.0) & (ci["s_star"] < 20.0)]

    return {
        "sub_reaches": int(ht["HydroID"].nunique()),
        "feature_ids": int(ht["feature_id"].nunique()),
        "levels_per_sub_reach": int(ht.groupby("HydroID").size().mode().iloc[0]),
        "non_monotone_sub_reach_ratings": int(nonmono),
        "non_monotone_if_grouped_by_feature_id": int(merged_nonmono),
        "hydroids_shared_with_the_road_table": int(len(set(sub["HydroID"].unique()) & set(rat))),
        "hydroids_in_the_road_table": int(sub["HydroID"].nunique()),
        "segments_resolved_to_a_sub_reach": int(len(key)),
        "intrinsic_validation_at_the_gauge_sub_reach": calib,
        "segments_within_the_gauged_record": int(len(inn)),
        "segments_beyond_it": int(len(out)),
        "classified_highways": int(len(c)),
        "classified_highways_below_action": {
            "hand_as_stage": int(len(a_off)),
            "of_which_in_record": int(len(a_in)),
            "lifted_above_action": int(len(lifted)),
            "still_below_after_conversion": int(len(still)),
            "newly_below_after_conversion": int(len(newly)),
            "net_after_conversion": int(len(still) + len(newly)),
        },
        "conversion_direction": {
            "up": int((inn["s_star"] > inn["threshold_hand_ft"]).sum()),
            "down": int((inn["s_star"] < inn["threshold_hand_ft"]).sum()),
            "median_delta_in_record_ft": float(np.median(inn["s_star"] - inn["threshold_hand_ft"])),
            "median_delta_all_ft": float(np.median(key["s_star"] - key["threshold_hand_ft"])),
        },
        "named_highways": named,
        "hybrid_is_monotone": bool(inn["s_star"].max() <= out["threshold_hand_ft"].min()),
        "hybrid_overlap_ft": float(inn["s_star"].max() - out["threshold_hand_ft"].min()),
        "hybrid_inverted_segments": int((inn["s_star"] > out["threshold_hand_ft"].min()).sum()),
        "verdict": ("implementable, anchored, and it moves the named offenders to realistic stages, "
                    "but it cannot be shipped: it is not a lift (it moves some segments DOWN), so it "
                    "redistributes the below-action set rather than removing it, and the hybrid "
                    "(convert in range, keep HAND otherwise) is non-monotone because two thirds of "
                    "segments need a discharge beyond the gauged record"),
    }


# --------------------------------------------------------------------------
# R4 — can HAND be re-referenced to the Brazos?
# --------------------------------------------------------------------------
def rereference_closure(roads: list) -> dict:
    """Two measurements: what NWM-proximity re-referencing would do to the
    thresholds, and whether the HAND raster supports a correct re-reference."""
    import geopandas as gpd
    from shapely.strtree import STRtree

    st = gpd.read_file(HAND / "nwm_subset_streams.gpkg").to_crs(32614)
    to_of = dict(zip(st["ID"], st["to"]))
    sl = dict(zip(st["ID"], st["Slope"]))
    ln = dict(zip(st["ID"], st["Length"]))

    def rise(fid, limit=4000):
        total, seen, cur = 0.0, set(), fid
        while cur in to_of and len(seen) < limit:
            if cur in seen:
                return None
            seen.add(cur)
            total += float(sl[cur]) * float(ln[cur])
            nxt = to_of[cur]
            if nxt == cur or nxt not in to_of:
                break
            cur = nxt
        return total

    geoms = gpd.GeoDataFrame.from_features(roads, crs=4326).to_crs(32614)
    main = st[st["mainstem"].astype(bool)]
    all_tree = STRtree(list(st.geometry))
    main_tree = STRtree(list(main.geometry))
    st_ids, main_ids = st["ID"].to_numpy(), main["ID"].to_numpy()

    cache, deltas = {}, []
    for geom in geoms.geometry:
        c = geom.centroid
        ref = int(st_ids[all_tree.nearest(c)])
        mid = int(main_ids[main_tree.nearest(c)])
        for k in (ref, mid):
            if k not in cache:
                cache[k] = rise(k)
        b_ref, b_main = cache[ref], cache[mid]
        if b_ref is not None and b_main is not None:
            deltas.append((b_ref - b_main) * FT_PER_M)
    deltas = np.array(deltas)

    # raster check: is the actual reference drainage identifiable?
    raster = {"segments_checked": 0, "reference_within_2_5km": 0,
              "reference_outside_mainstem_branch": 0}
    try:
        import rasterio
        from pyproj import Transformer

        with rasterio.open(BRANCH / "rem_zeroed_masked_3125000011.tif") as h, \
                rasterio.open(BRANCH / "gw_catchments_reaches_filtered_addedAttributes_3125000011.tif") as c:
            H, C, tr = h.read(1), c.read(1), h.transform
            t = Transformer.from_crs(4326, h.crs, always_xy=True)
            at = np.array([f["properties"]["flood_stage_ft"] for f in roads])
            # the segments the correction is actually for, plus a fixed sample
            idx = sorted(set(np.flatnonzero(at < 20).tolist()
                             + list(range(0, len(roads), len(roads) // 120 or 1))))
            win = 200
            for i in idx:
                g = roads[i]["geometry"]
                cs = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
                pts = [p for part in cs for p in part]
                lon = sum(p[0] for p in pts) / len(pts)
                lat = sum(p[1] for p in pts) / len(pts)
                x, y = t.transform(lon, lat)
                col, row = int((x - tr.c) / tr.a), int((y - tr.f) / tr.e)
                if not (0 <= row < H.shape[0] and 0 <= col < H.shape[1]):
                    continue
                raster["segments_checked"] += 1
                r0, r1 = max(0, row - win), min(H.shape[0], row + win)
                c0, c1 = max(0, col - win), min(H.shape[1], col + win)
                w = H[r0:r1, c0:c1]
                zr, zc = np.nonzero(w == 0)
                if not len(zr):
                    continue
                d2 = (zr - (row - r0)) ** 2 + (zc - (col - c0)) ** 2
                k = int(np.argmin(d2))
                raster["reference_within_2_5km"] += 1
                if int(C[r0 + zr[k], c0 + zc[k]]) == 0:
                    raster["reference_outside_mainstem_branch"] += 1
    except Exception as e:                                   # pragma: no cover
        raster["error"] = str(e)

    return {
        "nwm_proximity_correction_ft": {
            "median": float(np.median(deltas)), "mean": float(np.mean(deltas)),
            "p90": float(np.percentile(deltas, 90)), "min": float(deltas.min()),
            "max": float(deltas.max()),
        },
        "hand_raster_reference_check": raster,
        "offenders_below_action": int(sum(1 for f in roads
                                          if f["properties"]["flood_stage_ft"] < 20.0)),
        "verdict": ("unimplementable in-repo: the NWM-proximity form over-corrects the median "
                    "past any flood on record, and the HAND raster cannot identify the reference "
                    "drainage for most segments"),
    }


# --------------------------------------------------------------------------
# R5 — is any observation available to validate a correction?
# --------------------------------------------------------------------------
def validation_closure() -> dict:
    j = json.loads((ROOT / "data" / "raw" / "openfema" / "nfip_claims_48157_v3.json").read_text())
    rows = j["NfipClaims"]
    lat = [r["latitude"] for r in rows if isinstance(r.get("latitude"), (int, float))]
    lon = [r["longitude"] for r in rows if isinstance(r.get("longitude"), (int, float))]
    wd = [r["waterDepth"] for r in rows if isinstance(r.get("waterDepth"), (int, float))]
    harvey = sum(1 for r in rows if r.get("floodEvent") == "Hurricane Harvey")
    return {
        "claims": len(rows), "claims_with_depth": len(wd), "harvey_claims": harvey,
        "distinct_latitudes": len(set(lat)), "distinct_longitudes": len(set(lon)),
        "max_coordinate_decimals": 1,
        "coordinate_cell_km": 11.1,
        "verdict": ("no point validation available FROM CLAIMS: their coordinates are privacy-coarsened to "
                    "0.1 degrees, so per-segment validation is impossible offline. This closure is about "
                    "the claim-point route only — the polygon route named in to_reopen was "
                    "obtained and is scored in pipeline/derive/harvey_validation.py "),
    }


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)
    roads = json.loads((DERIVED / "road_thresholds.geojson").read_text())["features"]
    print(f"segments: {len(roads)}")

    print("\n=== the validated asset: relative bed profile from NWM slopes ===")
    bp = bed_profile()
    print(f"  gauge anchors resolved: {bp['anchor_count']} "
          f"(monotone downstream: {bp['anchor_elevations_monotone_downstream']})")
    for r in bp["anchors"]:
        print(f"    {str(r['lid']):6s} reach {r['feature_id']:>8}  integrated {r['integrated_rise_m']:7.2f} m"
              f"   dem_adj {r['dem_adj_elevation_m']:7.2f} m   diff {r['integrated_rise_m']-r['dem_adj_elevation_m']:6.2f}")
    print(f"  correlation integrated vs DEM: r = {bp['correlation_integrated_vs_dem_m']:.4f}")
    print(f"  offset spread: {bp['offset_spread_m']['min']:.2f} .. {bp['offset_spread_m']['max']:.2f} m "
          f"(this is the unresolvable datum gap)")
    print(f"  implied bed slope gauge->outlet: "
          f"{bp['implied_slope_from_gauge_to_outlet_ft_per_mile']:.2f} ft/mile")
    (DERIVED / "bed_profile.json").write_text(json.dumps(bp, indent=2))

    print("\n=== R1: the discharge route, tested properly ===")
    r1 = rating_closure(roads)
    print(f"  {r1['sub_reaches']} sub-reach ratings ({r1['levels_per_sub_reach']} levels each), "
          f"all monotone: {r1['non_monotone_sub_reach_ratings'] == 0}")
    print(f"  non-monotone only if merged by feature_id: {r1['non_monotone_if_grouped_by_feature_id']} "
          f"of {r1['feature_ids']} (an artifact of grouping, not of the data)")
    print(f"  each segment resolves to one rating: {r1['hydroids_shared_with_the_road_table']} of "
          f"{r1['hydroids_in_the_road_table']} road-table HydroIDs found")
    print("  intrinsic validation at the gauge's own sub-reach (should return ~HAND):")
    for c in r1["intrinsic_validation_at_the_gauge_sub_reach"]:
        print(f"     HAND {c['hand_ft']:5.1f} -> {c['implied_stage_ft']:6.2f} ft   "
              f"(error {c['error_ft']:+.2f} ft)")
    print(f"  in the gauged record: {r1['segments_within_the_gauged_record']} segments; "
          f"beyond it: {r1['segments_beyond_it']}")
    d = r1["conversion_direction"]
    print(f"  the conversion is not a lift: in-record it moves {d['up']} up and {d['down']} down "
          f"(median {d['median_delta_in_record_ft']:+.2f} ft)")
    ch = r1["classified_highways_below_action"]
    print(f"  classified highways below action ({r1['classified_highways']} classified total):")
    print(f"     HAND-as-stage {ch['hand_as_stage']} -> lifted above action {ch['lifted_above_action']}, "
          f"still below {ch['still_below_after_conversion']}, newly below {ch['newly_below_after_conversion']}"
          f"  => net {ch['net_after_conversion']}")
    for nm, v in r1["named_highways"].items():
        print(f"     {nm}: HAND min {v['hand_min_ft']} ft -> converted min {v['converted_min_ft']} ft")
    print(f"  hybrid monotone? {r1['hybrid_is_monotone']} — overlap {r1['hybrid_overlap_ft']:.1f} ft, "
          f"{r1['hybrid_inverted_segments']} segments would invert")

    print("\n=== R4: re-reference to the Brazos ===")
    r4 = rereference_closure(roads)
    c = r4["nwm_proximity_correction_ft"]
    print(f"  NWM-proximity correction: median {c['median']:.1f} ft, p90 {c['p90']:.1f} ft, "
          f"max {c['max']:.1f} ft")
    rc = r4["hand_raster_reference_check"]
    print(f"  HAND-raster reference check: {rc['segments_checked']} segments sampled, "
          f"{rc['reference_within_2_5km']} with a drainage cell within 2.5 km, "
          f"{rc['reference_outside_mainstem_branch']} of those referencing another branch")

    print("\n=== R5: observation available to validate? ===")
    r5 = validation_closure()
    # R5 closed the OBSERVATION route on claims alone. That remains true of claims;
    # the polygon route was closed separately and is now satisfied by
    # harvey_validation.py, which is cross-checked below.
    r5["closed_only_for_claims"] = (
        "this closure is about OpenFEMA claim coordinates and still holds for them; "
        "observed inundation as POLYGONS (USGS SIR 2018-5070) is now available and is "
        "used in pipeline/derive/harvey_validation.py")
    print(f"  {r5['claims']} claims ({r5['harvey_claims']} Harvey), "
          f"{r5['claims_with_depth']} with depth")
    print(f"  distinct coordinates: {r5['distinct_latitudes']} latitudes x "
          f"{r5['distinct_longitudes']} longitudes -> ~{r5['coordinate_cell_km']:.1f} km cells")

    print("\n=== R2/R3: bed datum and the flat-pool premise ===")
    ga = next((r for r in bp["anchors"] if r["feature_id"] == GAUGE_REACH), None)
    gauge_anchor_ft = None if ga is None else ga["dem_adj_elevation_m"] * FT_PER_M
    if gauge_anchor_ft is not None:
        print(f"  at the gauge itself: dem_adj_elevation {gauge_anchor_ft:.1f} ft vs its own zero datum "
              f"{bp['gauge_zero_datum_ft']} ft -> taking it literally shifts every threshold by "
              f"{gauge_anchor_ft - bp['gauge_zero_datum_ft']:+.1f} ft")
    print(f"  bed slope {bp['implied_slope_from_gauge_to_outlet_ft_per_mile']:.2f} ft/mile has the "
          f"same sign as the -0.92 ft/mile threshold trend, so a flat-pool correction ADDS slope")

    # --- gates: the closures must stay closed, and the asset must stay validated ---
    assert bp["correlation_integrated_vs_dem_m"] > 0.95, \
        "the slope-integrated bed profile no longer reproduces the gauge bed elevations"
    assert bp["anchor_count"] >= 5, "too few gauge anchors to validate the profile"
    assert bp["anchor_elevations_monotone_downstream"], \
        "gauge bed elevations are no longer monotone downstream — profile invalid"
    lo, hi = BED_SLOPE_SANITY_FT_PER_MILE
    s = bp["implied_slope_from_gauge_to_outlet_ft_per_mile"]
    assert s is not None and lo < s < hi, f"implied bed slope {s} outside the plausible range"
    assert r1["non_monotone_sub_reach_ratings"] == 0, \
        "a sub-reach rating is now non-monotone — re-check the discharge route"
    assert abs(r1["intrinsic_validation_at_the_gauge_sub_reach"][2]["error_ft"]) < 3.0, \
        "the chain no longer reproduces HAND at the gauge's own sub-reach — its anchor is broken"
    assert r1["hydroids_shared_with_the_road_table"] == r1["hydroids_in_the_road_table"], \
        "some road-table HydroIDs have no rating — the chain is no longer fully resolvable"
    _ch = r1["classified_highways_below_action"]
    assert _ch["lifted_above_action"] + _ch["still_below_after_conversion"] \
        == _ch["of_which_in_record"], "the below-action accounting does not partition"
    assert _ch["lifted_above_action"] > 0, \
        "the conversion no longer lifts any offender — re-examine whether it works at all"
    assert _ch["newly_below_after_conversion"] > 0, \
        "the conversion no longer creates new offenders — it may now be shippable, re-examine"
    assert not r1["hybrid_is_monotone"], \
        "the hybrid IS monotone now — re-examine whether the correction can be shipped"
    assert r4["nwm_proximity_correction_ft"]["median"] > 10.0, \
        "the NWM-proximity correction is no longer large — re-examine R4"
    assert rc["reference_outside_mainstem_branch"] <= max(1, rc["segments_checked"] // 50), \
        "the HAND raster now resolves off-branch references — re-referencing may be viable"
    assert r4["offenders_below_action"] > 0, \
        "no segments are below action stage — the defect this module documents is gone"
    assert r5["distinct_latitudes"] <= 10 and r5["distinct_longitudes"] <= 10, \
        "claim coordinates are no longer coarsened — point validation may now be possible"
    print("\nall gates passed: every closure still holds, the bed profile is still validated")
    print("NO correction applied — thresholds unchanged. See threshold_correction.json.")

    # --- cross-check against the observed Harvey extent, if it has been built ---------
    # One of the to_reopen items was "observed inundation extent for Harvey as polygons".
    # When that exists, this records what it settled so the two artifacts cannot drift
    # into telling different stories about the same thresholds.
    hv_path = DERIVED / "harvey_validation.json"
    harvey_xref = {"available": False,
                   "module": "pipeline/derive/harvey_validation.py"}
    if hv_path.exists():
        hv = json.loads(hv_path.read_text())
        needed = hv["corroboration_of_closed_routes"]["required_lift_ft"]
        r1_all = hv["corroboration_of_closed_routes"]["R1_median_lift_all_segments_ft"]
        r2_gap = hv["corroboration_of_closed_routes"]["R2_datum_gap_ft"]
        harvey_xref = {
            "available": True,
            "module": "pipeline/derive/harvey_validation.py",
            "measured_lift_required_ft": needed,
            "R2_datum_gap_ft": r2_gap,
            "R2_difference_ft": float(r2_gap - needed),
            "R1_median_lift_all_segments_ft": r1_all,
            "R1_difference_ft": float(r1_all - needed),
            "R1_named_highway_shortfall_ft": hv["corroboration_of_closed_routes"]
                ["named_highways"],
            "settled": (
                "the magnitude is real and is a CONSTANT: the observed extent requires each "
                "segment to flood about 22 ft later than its threshold says, R2's discarded "
                "datum gap (+24.7 ft) and R1's median lift (+25.1 ft) both land within 3 ft "
                "of that, and a linear along-river correction does not generalise off-sample "
                "where the constant does (0.709/0.844 test accuracy, against 0.622/0.831 with "
                "a slope term and 0.440/0.387 uncorrected)"),
            "and_it_also_settled": (
                "R1's magnitude is NOT enough: for the three named highways its conversion "
                "lands 8-9 ft short of what the observation requires, which is the opposite "
                "of the R1-is-unusable argument and independently confirms why R1 "
                "redistributes the below-action set instead of lifting it"),
            "still_applied": False,
            "why_still_not_applied": (
                "one event, one extent; the observation bounds the correction but a constant "
                "fitted to a single flood, with no second flood to test it on, is a new "
                "unvalidated number in place of an old one"),
        }
        print(f"\nHarvey extent cross-check: required lift {needed:+.2f} ft | "
              f"R2 {r2_gap:+.2f} | R1 {r1_all:+.2f}")

    out = {
        "applied": False,
        "reason": ("the one workable route (R1) is written and internally anchored but cannot be "
                   "validated with the data in this repo, and applying it to part of the corridor "
                   "would make the published thresholds internally inconsistent; a correction that "
                   "cannot be validated would be worse than a declared defect"),
        "shipped_thresholds": "unchanged (HAND-as-stage, crossing repair, low-confidence flags)",
        "closures": {
            "R1_discharge_rating": r1,
            "R2_absolute_bed_elevation": {
                "gauge_reach_anchor_elevation_ft": gauge_anchor_ft,
                "gauge_zero_datum_ft": bp["gauge_zero_datum_ft"],
                "constant_shift_if_taken_literally_ft": (None if gauge_anchor_ft is None
                                                         else gauge_anchor_ft - bp["gauge_zero_datum_ft"]),
                "verdict": "unusable as an absolute correction: the gauge zero datum and "
                           "dem_adj_elevation are in irreconcilable vertical references",
            },
            "R3_flat_pool_premise": {
                "bed_slope_ft_per_mile": bp["implied_slope_from_gauge_to_outlet_ft_per_mile"],
                "observed_threshold_trend_ft_per_mile": -0.9187395806950794,
                "verdict": "premise corrected: the bed profile has the same sign as the threshold "
                           "trend, so adding it increases slope; under normal flow the physical "
                           "correction is a constant offset",
            },
            "R4_bed_reference": r4,
            "R5_observation": r5,
        },
        "validated_asset": "data/derived/bed_profile.json",
        "harvey_validation_cross_check": harvey_xref,
        "to_reopen": [
            "the R1 conversion is written and anchored; an observed Harvey inundation extent "
            "would settle whether its magnitude is right, after which it can ship for the whole corridor",
            "a DEM, to re-run HAND against the correct drainage (with the gauge's vertical datum documented)",
            "per-reach channel bed elevations in the gauge's own vertical datum",
            "observed inundation extent for Harvey as polygons (USGS/NOAA), not coarsened points"
            + (" — SATISFIED by pipeline/derive/harvey_validation.py (USGS SIR 2018-5070 extent, "
               "doi:10.5066/F7VH5N3N); see harvey_validation_cross_check for what it settled"
               if harvey_xref.get("available") else " (not yet run)"),
        ],
        "acceptance_for_any_future_correction": [
            "the gauge's own reach must come back unchanged (HAND = stage there)",
            "the corrected profile must agree with bed_profile.json",
            "it must be validated against observed extent, with a reported false-positive rate",
        ],
    }
    (DERIVED / "threshold_correction.json").write_text(json.dumps(out, indent=2))
    print("Wrote data/derived/bed_profile.json + data/derived/threshold_correction.json")


if __name__ == "__main__":
    main()
