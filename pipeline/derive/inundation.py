#!/usr/bin/env python3
"""
BrazosCast — HAND inundation bands for the Richmond area.

Inundation rule (NOAA-OWP HAND): a cell is under water when its height above
nearest drainage (HAND) is below the water surface stage for its reach.

PROVISIONAL — the HAND raster's scale is unresolved:
  - the hydrotable `stage` column is unambiguously METRES (0.3048 m steps).
  - the `rem_zeroed_masked` raster is int16 with values 0..32766. Reading it as
    MILLIMETRES reproduces the hydrotable's cell counts to ~2% at a 12 m stage,
    but implies 383 km2 inundated at a 45 ft stage inside the Richmond window
    (65% of the domain) — physically absurd.
  - Reading it as CENTIMETRES gives ~13 km2 at 45 ft — plausible for the Brazos
    floodplain — but does not reproduce the hydrotable cell counts.
  Neither is confirmed against NOAA-OWP documentation. This script uses the
  CENTIMETRE reading because it is the physically credible one, and labels every
  output `provisional: true`. Do NOT present these extents as authoritative until
  the raster scale is confirmed. See docs/FINDINGS.md.

Also uses a uniform stage across the mainstem branch — HAND's own assumption of a
level water surface normal to the channel. It does NOT model backwater per reach.

Usage : <env>/bin/python pipeline/derive/inundation.py
Output: data/derived/inundation_bands.geojson, stage_area_curve.json
"""
import json
import pathlib
import numpy as np
import pandas as pd
import rasterio
from rasterio.windows import from_bounds
from rasterio.features import shapes
from shapely.geometry import shape
import geopandas as gpd
from pyproj import Transformer

ROOT = pathlib.Path(__file__).resolve().parents[2]
B = ROOT / "data" / "raw" / "hand" / "12070104" / "branches" / "3125000011"
DERIVED = ROOT / "data" / "derived"
REM = B / "rem_zeroed_masked_3125000011.tif"
HT = B / "hydroTable_3125000011.csv"
LEVEE = ROOT / "data" / "raw" / "hand" / "12070104" / "LeveeProtectedAreas_subset.gpkg"

BBOX = (-96.10, 29.44, -95.55, 29.76)
HAND_PER_M = 100.0   # PROVISIONAL: centimetres. See module docstring.
# Richmond gauge stages (ft) -> water surface (m) above the gauge zero datum
STAGE_FT = [40, 45, 48, 50]
FT_TO_M = 0.3048
MIN_POLY_M2 = 30_000   # drop slivers below 3 hectares


def main():
    DERIVED.mkdir(parents=True, exist_ok=True)

    # ---- window covering the Richmond corridor ----
    tr = Transformer.from_crs(4326, 5070, always_xy=True)
    xs, ys = [], []
    for lon, lat in [(BBOX[0], BBOX[1]), (BBOX[2], BBOX[3])]:
        x, y = tr.transform(lon, lat)
        xs.append(x); ys.append(y)
    with rasterio.open(REM) as src:
        win = from_bounds(min(xs), min(ys), max(xs), max(ys), src.transform)
        win = win.round_offsets().round_lengths()
        hand = src.read(1, window=win)
        transform = src.window_transform(win)
        nodata = src.nodata
    print(f"window shape {hand.shape}, valid {(hand != nodata).sum():,} cells "
          f"({(hand != nodata).sum()*100/1e6:.1f} km2)")

    valid = hand != nodata
    feats = []
    curve = []
    for stg_ft in STAGE_FT:
        stage_m = stg_ft * FT_TO_M
        thr = stage_m * HAND_PER_M
        mask = valid & (hand < thr)
        n = int(mask.sum())
        area_km2 = n * 100 / 1e6
        # vectorize
        geoms = [shape(g) for g, v in shapes(mask.astype("uint8"), mask=mask, transform=transform) if v == 1]
        polys = [g.simplify(15) for g in geoms if g.area >= MIN_POLY_M2]
        for g in polys:
            feats.append({"type": "Feature",
                          "properties": {"stage_ft": stg_ft, "stage_m": round(stage_m, 2)},
                          "geometry": g.__geo_interface__})
        curve.append({"stage_ft": stg_ft, "stage_m": round(stage_m, 2),
                      "cells": n, "area_km2": round(area_km2, 2), "polygons": len(polys)})
        print(f"  {stg_ft} ft ({stage_m:.2f} m): {area_km2:7.2f} km2, {len(polys)} polygons")

    gdf = gpd.GeoDataFrame.from_features(feats, crs=5070).to_crs(4326)
    # levee overlay
    lev = gpd.read_file(LEVEE).to_crs(4326)[["SYSTEM_NAME", "geometry"]]
    hit = gpd.sjoin(gdf, lev, how="inner", predicate="intersects").index.unique()
    gdf["levee"] = gdf.index.isin(hit)
    gdf.to_file(DERIVED / "inundation_bands.geojson", driver="GeoJSON")
    print(f"levee-overlapping bands: {int(gdf['levee'].sum())}")

    (DERIVED / "stage_area_curve.json").write_text(json.dumps({
        "bbox": BBOX, "provisional": True,
        "units": {"hand_raster": "cm (provisional)", "hydrotable_stage": "m"},
        "note": "uniform stage across mainstem branch; HAND level-water assumption",
        "curve": curve}, indent=2))
    print("Wrote data/derived/inundation_bands.geojson + stage_area_curve.json")


if __name__ == "__main__":
    main()
