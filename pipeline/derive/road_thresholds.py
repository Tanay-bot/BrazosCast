#!/usr/bin/env python3
"""
BrazosCast — street-level flood thresholds for the Richmond area.

For each OSM road segment: the Richmond-gauge stage (ft) at which its lowest
point goes under. This is the primitive the whole app is built from.

Source (no invented numbers):
  data/raw/hand/12070104/osm_roads_fimpact.csv
      NOAA-OWP HAND FIM already computed, per road segment, the HAND height at
      which it floods (`threshold_hand_ft`) and the NWM-reach discharge that
      produces that stage (`threshold_discharge_cfs`).

METHOD, AND ITS KNOWN DEFECT — READ BEFORE TRUSTING ANY NUMBER
  `threshold_hand_ft` is a HAND height: feet above the *nearest drainage*. For a
  road segment on the Brazos mainstem levelpath that is treated here as the
  Richmond gauge stage. That is an approximation with a known systematic error:
  the HAND reference changes bed elevation by roughly a foot per mile along the
  corridor, while the Richmond gauge measures one fixed point.

  Three repair routes were tried and REJECTED, each on measured evidence:

  1. Convert `threshold_discharge_cfs` through the gauge's measured USGS
     stage/discharge rating (see gauge_rating.py). Rejected: the source's
     threshold discharges sit mostly ABOVE the gauge's observed record, so the
     conversion is dominated by extrapolation. A plain power-law rating gives a
     41 ft median but errs 15.7 ft at the largest observed event; a shifted
     power-law rating fits the record to 0.34 ft median error but yields a 78.65
     ft median threshold across these segments — i.e. it asserts that the median
     corridor road needs a flood larger than any on record. Both are unusable.

  2. Treat `threshold_discharge_cfs` as a gauge discharge at all. Rejected: it is
     not one. The mainstem levelpath's hydrotable carries 225 sub-reaches whose
     discharges at any single stage span three orders of magnitude (at 25.3 ft:
     3,229 to 232,824 cms). The column is not comparable across reaches.

  3. Drop bridge decks. Not possible from tags: `osm_roads_subset.gpkg` has no
     `bridge`, `layer` or `tunnel` column. The geometric substitute — repairing
     segments that cross a stream from their neighbours — is implemented below
     and DOES fix State Highway 6 (14.2 -> 30.2 ft), but it cannot fix US 90A or
     the Grand Parkway, because their 16-19 ft values run along the whole
     corridor rather than concentrating at a crossing.

  What remains, and what is shipped: HAND-as-stage with the crossing repair
  applied, plus a `confidence` flag. Every segment below action stage, and every
  crossing segment that could not be repaired, is marked `low` and reported in
  the summary. The defect is declared, not silenced.

  Closing it properly needs one of: a HAND re-run from the DEM (the DEM is not in
  this repo), or per-reach channel bed elevations to convert local HAND depth to
  gauge stage (not in this repo — usgs_elev_table.csv has 15 rows, one per gauge).

Usage: <env>/bin/python pipeline/derive/road_thresholds.py
Output: data/derived/road_thresholds.geojson, .json, .summary.json
"""
import json
import pathlib

import numpy as np
import pandas as pd
import geopandas as gpd

from gauge_rating import fit as fit_rating, stage_from_flow

ROOT = pathlib.Path(__file__).resolve().parents[2]
HAND = ROOT / "data" / "raw" / "hand" / "12070104"
DERIVED = ROOT / "data" / "derived"

MAINSTEM_LEVELPATH = 3125000011   # Brazos mainstem levelpath (shared with RMOT2)
BBOX = (-96.10, 29.44, -95.55, 29.76)   # Richmond / Rosenberg corridor

ACTION_FT = 20.0        # NWS action stage at RMOT2
FLOOD_FT = 45.0         # NWS flood stage at RMOT2
CROSSING_M = 15.0       # a segment this close to a stream line covers a crossing
DONOR_R_M = 300.0       # radius for borrowing a threshold from non-crossing neighbours
CLASSIFIED = ("motorway", "trunk", "primary")


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)

    fp = pd.read_csv(HAND / "osm_roads_fimpact.csv")
    fp["osmid"] = fp["osmid"].astype("int64")

    # A road has one row per catchment it crosses, and those rows reference
    # DIFFERENT reaches. A row referenced to a small tributary reports a tiny
    # HAND ("2.6 ft above that creek") and would poison a Brazos-stage
    # interpretation. So keep only rows on the Brazos mainstem levelpath before
    # aggregating — then take the minimum (a road floods at its lowest point).
    main = fp[fp["branch"] == MAINSTEM_LEVELPATH].copy()
    print(f"rows: {len(fp)} total, {len(main)} on the Brazos mainstem levelpath")
    thr = (main.groupby("osmid")
               .agg(flood_stage_ft=("threshold_hand_ft", "min"),
                    flood_cfs=("threshold_discharge_cfs", "min"),
                    reach=("feature_id", lambda s: int(s.mode().iloc[0])),
                    n=("threshold_hand_ft", "size")).reset_index())
    thr["mainstem"] = True
    print(f"segments with mainstem HAND thresholds: {len(thr)}")

    roads = gpd.read_file(HAND / "osm_roads_subset.gpkg")
    roads["osmid"] = roads["osmid"].astype("int64")
    g = roads.merge(thr, on="osmid", how="inner")
    print(f"with geometry: {len(g)}")

    lev = gpd.read_file(HAND / "LeveeProtectedAreas_subset.gpkg")[
        ["SYSTEM_NAME", "FEMA_ACCREDITATION_RATING", "geometry"]]
    g = gpd.sjoin(g, lev, how="left", predicate="within")
    g["levee_system"] = g["SYSTEM_NAME"]
    g["levee"] = g["levee_system"].notna()

    g = g.to_crs(4326).cx[BBOX[0]:BBOX[2], BBOX[1]:BBOX[3]].reset_index(drop=True)
    print(f"after Richmond bbox clip: {len(g)} (mainstem {int(g['mainstem'].sum())}, "
          f"levee {int(g['levee'].sum())})")
    n = len(g)

    # --- crossings, identified geometrically because the tags do not exist ------
    streams = gpd.read_file(HAND / "nwm_subset_streams.gpkg").to_crs(32614)
    sgeom = streams.geometry.union_all()
    u = g.to_crs(32614)
    g["dist_stream_m"] = np.round(u.geometry.distance(sgeom).to_numpy(), 1)
    g["crossing"] = g["dist_stream_m"] < CROSSING_M
    print(f"crossing segments (within {CROSSING_M:.0f} m of a stream line): {int(g['crossing'].sum())}")

    # --- crossing repair: borrow from non-crossing neighbours within DONOR_R_M --
    before = g["flood_stage_ft"].to_numpy().copy()
    cen = u.geometry.centroid
    g["_x"], g["_y"] = cen.x.to_numpy(), cen.y.to_numpy()
    non = g[~g["crossing"]]
    nx, ny, nv = non["_x"].to_numpy(), non["_y"].to_numpy(), non["flood_stage_ft"].to_numpy()
    repaired = 0
    for i in np.flatnonzero(g["crossing"].to_numpy()):
        near = np.hypot(nx - g["_x"].iat[i], ny - g["_y"].iat[i]) < DONOR_R_M
        if not near.any():
            continue
        donor = float(nv[near].min())
        if donor > g["flood_stage_ft"].iat[i]:
            g.loc[i, "flood_stage_ft"] = round(donor, 1)
            repaired += 1
    g["crossing_repaired"] = g["flood_stage_ft"].to_numpy() > before
    print(f"crossing segments repaired from neighbours within {DONOR_R_M:.0f} m: {repaired}")
    g = g.drop(columns=["_x", "_y"])

    # --- confidence: declare the defect rather than hide it --------------------
    low = (g["flood_stage_ft"] < ACTION_FT) | (g["crossing"] & ~g["crossing_repaired"])
    g["confidence"] = np.where(low, "low", "modelled")
    g.loc[g["levee"], "confidence"] = "low"      # HAND does not model levees
    print(f"low-confidence segments: {int((g['confidence'] == 'low').sum())} "
          f"(below action {int((g['flood_stage_ft'] < ACTION_FT).sum())}, "
          f"unrepaired crossing {int((g['crossing'] & ~g['crossing_repaired']).sum())}, "
          f"levee {int(g['levee'].sum())})")

    ms = g["flood_stage_ft"]
    for s in (9.2, ACTION_FT, 33.4, FLOOD_FT, 50.0, 55.1):
        k = int((ms <= s).sum())
        print(f"  {s:5.1f} ft -> {k:5d}/{n} ({k/n*100:5.1f}%)")

    keep = g[["osmid", "highway", "name", "flood_stage_ft", "flood_cfs", "mainstem",
              "reach", "levee", "levee_system", "crossing", "crossing_repaired",
              "dist_stream_m", "confidence", "geometry"]].copy()
    keep["flood_stage_ft"] = keep["flood_stage_ft"].astype(float).round(1)
    keep["flood_cfs"] = keep["flood_cfs"].astype(float).round(0)
    keep.to_file(DERIVED / "road_thresholds.geojson", driver="GeoJSON")

    def nm(v):
        return None if v in (None, "unnamed") or (isinstance(v, float) and np.isnan(v)) else v

    payload = [{
        "id": int(r["osmid"]), "hw": r["highway"], "name": nm(r["name"]),
        "at": round(float(r["flood_stage_ft"]), 1),
        "mainstem": bool(r["mainstem"]), "levee": bool(r["levee"]),
        "conf": r["confidence"],
    } for _, r in keep.iterrows()]
    (DERIVED / "road_thresholds.json").write_text(json.dumps(payload))

    # --- evidence for the rejected conversion routes (recomputed, not asserted) --
    rating = fit_rating()
    rmed, rext = [], 0
    for q in keep["flood_cfs"]:
        s, e = stage_from_flow(float(q))
        rmed.append(s)
        rext += int(e)
    rmed = np.array(rmed)
    ht = pd.read_parquet(HAND / "hydrotable.parquet")
    ms_ht = ht[ht["branch_id"] == MAINSTEM_LEVELPATH]
    spread = (ms_ht.groupby("stage")["discharge_cms"]
                   .agg(["min", "median", "max", "size"]).sort_index())
    cap = spread.iloc[-1]

    glon = -95.7575
    mlon = np.cos(np.radians(29.6)) * 69.172
    cen4326 = g.to_crs(4326).geometry.centroid
    east = (cen4326.x.to_numpy() - glon) * mlon
    cur = g["flood_stage_ft"].to_numpy()
    slope, _ = np.polyfit(east, cur, 1)
    r = float(np.corrcoef(east, cur)[0, 1])

    cls_bad = keep[keep["highway"].isin(CLASSIFIED)
                  & (keep["flood_stage_ft"] < ACTION_FT)].drop_duplicates("osmid")
    summary = {
        "bbox": BBOX,
        "segments": int(len(keep)),
        "mainstem_segments": int(keep["mainstem"].sum()),
        "levee_segments": int(keep["levee"].sum()),
        "crossing_segments": int(keep["crossing"].sum()),
        "crossing_repaired": int(keep["crossing_repaired"].sum()),
        "low_confidence_segments": int((keep["confidence"] == "low").sum()),
        "action_stage_ft": ACTION_FT,
        "flood_stage_ft": {"min": float(ms.min()), "p25": float(ms.quantile(.25)),
                           "median": float(ms.median()), "p75": float(ms.quantile(.75)),
                           "max": float(ms.max())},
        "flooded_by_stage": {str(s): int((ms <= s).sum())
                             for s in (9.2, ACTION_FT, 33.4, FLOOD_FT, 50.0, 55.1)},
        "along_river_slope_ft_per_mile": {"value": float(slope), "r": r,
                                          "note": "systematic error of HAND-as-stage; not yet corrected"},
        "known_defect": {
            "summary": ("threshold_hand_ft is a HAND height referenced to the nearest drainage, "
                        "not the Richmond gauge stage; the HAND reference changes bed elevation "
                        "along the corridor, so a systematic along-river error remains."),
            "classified_highways_below_action": [
                {"osmid": int(x["osmid"]), "highway": x["highway"], "name": nm(x["name"]),
                 "flood_stage_ft": float(x["flood_stage_ft"]), "crossing": bool(x["crossing"])}
                for _, x in cls_bad.iterrows()],
            "rejected_route_discharge_rating": {
                "reason": "source threshold discharges lie mostly above the gauge's observed record",
                "rating_model": rating["model"], "rating_median_abs_error_ft": rating["median_abs_error_ft"],
                "rating_median_abs_error_ft_stage_above_35": rating["median_abs_error_ft_stage_above_35"],
                "observed_flow_cfs_max": rating["observed_flow_cfs"]["max"],
                "resulting_median_threshold_ft": float(np.median(rmed)),
                "extrapolated_segments": int(rext),
            },
            "rejected_route_discharge_column": {
                "reason": "the source discharge is not a single-reach gauge discharge",
                "levelpath": MAINSTEM_LEVELPATH,
                "sub_reaches_per_stage": int(cap["size"]),
                "discharge_cms_spread_at_max_stage": {"stage_ft": float(spread.index[-1]),
                                                      "min": float(cap["min"]),
                                                      "median": float(cap["median"]),
                                                      "max": float(cap["max"])},
            },
            "closing_it_needs": ("a HAND re-run from the DEM (DEM not in this repo) or per-reach "
                                 "channel bed elevations to convert local HAND depth to gauge stage "
                                 "(usgs_elev_table.csv has 15 rows, one per gauge)"),
        },
        "method": ("threshold_hand_ft on the Brazos mainstem levelpath treated as Richmond gauge "
                   "stage, with crossing segments (within 15 m of an NWM stream line) repaired from "
                   "non-crossing neighbours within 300 m. Segments below action stage, unrepaired "
                   "crossings and levee-protected segments are flagged confidence=low. See "
                   "known_defect for the residual systematic error and the rejected alternatives."),
    }
    (DERIVED / "road_thresholds.summary.json").write_text(json.dumps(summary, indent=2))
    print("\nflood_stage_ft:", json.dumps(summary["flood_stage_ft"], indent=1))
    print(f"along-river slope: {slope:.3f} ft/mile (r={r:.3f})")
    print(f"rejected rating route: median {np.median(rmed):.2f} ft, "
          f"{rext} of {len(rmed)} segments extrapolated")
    print(f"classified highways still below action: {int((keep['highway'].isin(CLASSIFIED) & (keep['flood_stage_ft'] < ACTION_FT)).sum())} segments")

    # --- gates ------------------------------------------------------------------
    # The review's proposed gate ("no classified highway floods below action stage")
    # cannot pass on this data, and is not faked here: those segments are reported
    # instead. What IS asserted is that the defect is surfaced, quantified, and
    # that nothing below action stage ships unflagged.
    assert keep.loc[keep["flood_stage_ft"] < ACTION_FT, "confidence"].eq("low").all(), \
        "a segment below action stage is not flagged low confidence"
    assert keep.loc[keep["crossing"] & ~keep["crossing_repaired"], "confidence"].eq("low").all(), \
        "an unrepaired crossing is not flagged low confidence"
    assert keep["flood_stage_ft"].between(0, 200).all(), "a threshold is outside (0, 200) ft"
    declared = sorted((d["osmid"], d["flood_stage_ft"])
                      for d in summary["known_defect"]["classified_highways_below_action"])
    actual = sorted((int(a), float(b)) for a, b in
                    zip(cls_bad["osmid"], cls_bad["flood_stage_ft"]))
    assert declared == actual, "the reported known-defect set does not match the data"
    assert abs(float(r)) < 0.75, "along-river correlation moved outside the documented range"
    print("\nall gates passed (defect declared and quantified, not silenced)")
    print("Wrote data/derived/road_thresholds.{geojson,json} + .summary.json")


if __name__ == "__main__":
    main()
