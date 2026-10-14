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

Why HAND height, not discharge:
  HAND stage is "feet of water above the nearest drainage reference". For road
  segments on the mainstem levelpath — the same levelpath as the Richmond gauge
  (levpa_id 3125000011) — that reference is the Brazos channel, so
  `threshold_hand_ft` is directly interpretable as the Richmond gauge stage at
  which the segment floods.

  We deliberately do NOT map `threshold_discharge_cfs` through the Richmond
  rating curve: the data spans 442 distinct NWM reaches and a tributary's
  discharge is not comparable to the mainstem's. Doing so under-estimated
  thresholds and implied 38% of streets flood at action stage — implausible.
  Segments with `branch == 0` are off-mainstem and are marked `mainstem=False`;
  their threshold is relative to their own drainage, not the Brazos.

Usage: <env>/bin/python pipeline/derive/road_thresholds.py
Output: data/derived/road_thresholds.geojson, .json, .summary.json
"""
import json
import pathlib
import pandas as pd
import geopandas as gpd

ROOT = pathlib.Path(__file__).resolve().parents[2]
HAND = ROOT / "data" / "raw" / "hand" / "12070104"
DERIVED = ROOT / "data" / "derived"

MAINSTEM_LEVELPATH = 3125000011   # Brazos mainstem levelpath (shared with RMOT2)
BBOX = (-96.10, 29.44, -95.55, 29.76)   # Richmond / Rosenberg corridor
GAUGE_ZERO_DATUM_FT = 26.73


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)

    fp = pd.read_csv(HAND / "osm_roads_fimpact.csv")
    fp["osmid"] = fp["osmid"].astype("int64")

    # A road has one row per catchment it crosses, and those rows reference
    # DIFFERENT reaches. A row referenced to a small tributary reports a tiny
    # HAND ("2.6 ft above that creek") and would poison a Brazos-stage
    # interpretation. So keep only rows on the Brazos mainstem levelpath before
    # aggregating — then take the minimum (a road floods at its lowest point).
    main = fp[fp["branch"] == MAINSTEM_LEVELPATH]
    print(f"rows: {len(fp)} total, {len(main)} on the Brazos mainstem levelpath")
    thr = (main.groupby("osmid")
               .agg(flood_stage_ft=("threshold_hand_ft", "min"),
                    flood_cfs=("threshold_discharge_cfs", "min"),
                    mainstem=("branch", lambda s: True),
                    reach=("feature_id", lambda s: int(s.mode().iloc[0])),
                    n=("threshold_hand_ft", "size")).reset_index())
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

    g = g.to_crs(4326).cx[BBOX[0]:BBOX[2], BBOX[1]:BBOX[3]]
    print(f"after Richmond bbox clip: {len(g)} (mainstem {int(g['mainstem'].sum())}, "
          f"levee {int(g['levee'].sum())})")

    keep = g[["osmid", "highway", "name", "flood_stage_ft", "flood_cfs", "mainstem",
              "reach", "levee", "levee_system", "geometry"]].copy()
    keep["flood_stage_ft"] = keep["flood_stage_ft"].astype(float).round(1)
    keep["flood_cfs"] = keep["flood_cfs"].astype(float).round(0)
    keep.to_file(DERIVED / "road_thresholds.geojson", driver="GeoJSON")

    payload = [{
        "id": int(r["osmid"]), "hw": r["highway"],
        "name": None if r["name"] in (None, "unnamed") else r["name"],
        "at": round(float(r["flood_stage_ft"]), 1),
        "mainstem": bool(r["mainstem"]), "levee": bool(r["levee"]),
    } for _, r in keep.iterrows()]
    (DERIVED / "road_thresholds.json").write_text(json.dumps(payload))

    ms = keep[keep["mainstem"]]["flood_stage_ft"]
    summary = {
        "bbox": BBOX, "gauge_zero_datum_ft": GAUGE_ZERO_DATUM_FT,
        "segments": len(keep), "mainstem_segments": int(keep["mainstem"].sum()),
        "levee_segments": int(keep["levee"].sum()),
        "mainstem_flood_stage_ft": {
            "min": float(ms.min()), "p25": float(ms.quantile(.25)),
            "median": float(ms.median()), "p75": float(ms.quantile(.75)),
            "max": float(ms.max()),
        },
        "method": "threshold_hand_ft treated as Richmond gauge stage on the mainstem levelpath; "
                  "off-mainstem segments marked mainstem=false.",
    }
    (DERIVED / "road_thresholds.summary.json").write_text(json.dumps(summary, indent=2))
    print("\nmainstem flood_stage_ft:", json.dumps(summary["mainstem_flood_stage_ft"], indent=1))
    for label, stg in [("action 20", 20), ("minor 45", 45), ("moderate 48", 48), ("major 50", 50)]:
        n = int((ms <= stg).sum())
        print(f"  mainstem segments under by {label} ft: {n} ({n/len(ms)*100:.1f}%)")
    print("Wrote data/derived/road_thresholds.{geojson,json}")


if __name__ == "__main__":
    main()
