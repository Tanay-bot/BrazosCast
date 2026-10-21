#!/usr/bin/env python3
"""
BrazosCast — HAND inundation bands for the Richmond corridor (NEXT-PLAN § 5.1–5.4).

Inundation rule (NOAA-OWP HAND): a cell is under water when its height above nearest
drainage is below the water surface stage of its own reach.

WHAT CHANGED, AND WHY IT IS NOT PROVISIONAL IN THE SAME WAY
  The raster's unit was the open question, and it is settled by measurement:
  `hand_unit_resolution.py` compares both readings against two independent counts (the
  hydrotable's own per-reach cell counts, and the 2016 Sentinel-1 water edge) and both
  pick millimetres, by a margin no plausible bug could forge (ratio 1.000 vs 0.05). The
  scale is READ from that artifact, not typed here, so the product cannot drift back to
  the old guess.

  The stage is per reach now. The hydrotable's `stage` column is measured above each
  reach's own bed, so the old uniform gauge reading applied one reach's depth to all 225.
  Each reach gets the stage its own synthetic rating curve needs to pass the flood
  discharge, obtained from the observed Richmond rating (stage -> discharge) and then the
  SRC (discharge -> stage). Steady-state: the mainstem carries the same discharge from
  one reach to the next, which is the standard HAND simplification and is stated in the
  output rather than assumed silently.

WHAT IS STILL PROVISIONAL
  The extent over-predicts. Against the one observation (212.7 km2 mapped at 49.40 ft),
  this maps 1,064 km2 at the same stage: 5x the water, IoU 0.19. Two reasons, both in
  `docs/FINDINGS.md` § 9: HAND treats every low cell as connected to the channel, and
  C-band SAR under-maps water under the floodplain forest. The bands carry that number in
  `meta.validation`; the app prints it. They are an UPPER BOUND with a measured bias, not
  a footprint.

Usage : <env>/bin/python pipeline/derive/inundation.py
Output: data/derived/flood_extent.json   (GeoJSON, shipped to the app)
        data/derived/stage_area_curve.json
"""
import datetime as dt
import json
import pathlib
import sys

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize, shapes
from rasterio.windows import Window, from_bounds
from shapely import set_precision
from shapely.errors import GEOSException
from shapely.geometry import shape
from shapely.ops import transform as reproject
from shapely.ops import unary_union

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hand
import second_event_validation as sev

DERIVED = hand.DERIVED
PUBLIC = hand.ROOT / "app" / "public" / "data"
MIN_POLY_M2 = 80_000     # 8 ha: below this a sliver is a raster edge, not water at this zoom
SIMPLIFY_M = 60.0        # 6 cells; the corridor is viewed at 1:100k or coarser
COORD_DECIMALS = 4       # ~11 m, without the 15-digit float tail


def category(stage_ft: float) -> str:
    """The NWS category, from the app's own thresholds.

    Restated rather than imported from TypeScript — there is no shared source for these
    three numbers — so the test that guards the payload also pins them: if the app's
    cards and this file ever disagree about which band is "major", the card says one
    thing and draws another.
    """
    if stage_ft >= 50:
        return "major"
    if stage_ft >= 48:
        return "moderate"
    if stage_ft >= 45:
        return "flood"
    return "below_flood"


def corridor(rem_path: pathlib.Path) -> tuple[np.ndarray, np.ndarray, object, Window]:
    """The corridor window, clipped to the raster.

    Clipped because `read` past the edge fills with 0, and 0 is a valid HAND value: an
    unclipped window would count the void outside the branch as a cell at the channel and
    flood it at every stage.
    """
    t = Transformer.from_crs(4326, 5070, always_xy=True)
    xs, ys = t.transform([hand.BBOX[0], hand.BBOX[2]], [hand.BBOX[1], hand.BBOX[3]])
    with rasterio.open(rem_path) as src:
        w = from_bounds(min(xs), min(ys), max(xs), max(ys), src.transform)
        w = w.round_offsets().round_lengths()
        c0, r0 = max(0, w.col_off), max(0, w.row_off)
        c1 = min(src.width, w.col_off + w.width)
        r1 = min(src.height, w.row_off + w.height)
        if c1 <= c0 or r1 <= r0:
            sys.exit("the corridor does not overlap the HAND raster — one of them has moved")
        win = Window(c0, r0, c1 - c0, r1 - r0)
        grid = src.read(1, window=win)
        transform = src.window_transform(win)
        meta = {"transform": src.transform, "shape": src.shape, "crs": str(src.crs)}
        nodata = src.nodata
    return grid, (grid != nodata), transform, win, meta


def band_mask(grid: np.ndarray, valid: np.ndarray, catch: np.ndarray,
              stages: dict[int, float], per_m: float) -> tuple[np.ndarray, dict]:
    """Cells below their own reach's stage, and the threshold raster that decided it."""
    # One indexing operation, not 225 comparisons over 19M cells: the first version of
    # this looped per reach and took 20 s per band for a lookup that is O(n).
    lookup = np.zeros(int(catch.max()) + 1, dtype=np.float64)
    for idx, stage_m in stages.items():
        if idx < lookup.size:
            lookup[idx] = stage_m * per_m
    thr = lookup[catch]
    unassigned = int((valid & (thr == 0)).sum())
    mask = valid & (thr > 0) & (grid < thr)
    return mask, {"unassigned_cells": unassigned}


def polygons(mask: np.ndarray, grid_transform, stage_ft: float,
             cat: str) -> tuple[list[dict], list[str]]:
    # FROM EPSG:5070 TO WGS84 BEFORE WRITING. The mask is polygonised on the raster's own
    # projected grid (simplification in metres is the only meaningful kind here), and the
    # first version of this function stopped there — writing metre coordinates into a file
    # that says "crs": "EPSG:4326". MapLibre accepted it and drew nothing, because every
    # polygon was 43,000 km west of the map. The test now asserts the range.
    to_wgs84 = Transformer.from_crs(5070, 4326, always_xy=True)
    feats, dropped = [], []
    for geom, val in shapes(mask.astype("uint8"), mask=mask, transform=grid_transform):
        if val != 1:
            continue
        g = shape(geom)
        # Area and simplification are METRES, so both happen before the reprojection: a
        # square degree is ~9.5e9 m2 at this latitude, and the first attempt filtered the
        # transformed polygons by `area < 80,000` and dropped every one of them.
        g = g.simplify(SIMPLIFY_M)
        if g.area < MIN_POLY_M2:
            continue
        # `valid_output` because snapping a curved coastline to a grid can orphan a hole
        # (GEOS raises rather than guessing which shell it belonged to), and a raster edge
        # is exactly the shape that produces those.
        try:
            g = set_precision(reproject(to_wgs84.transform, g),
                              10.0 ** -COORD_DECIMALS, mode="valid_output")
        except GEOSException as exc:
            # Only topology: snapping can orphan a hole. A TypeError here is a bug in this
            # file and must not be turned into "one polygon fewer" — which it was, until the
            # catch was narrowed and the shadowed `transform` name showed itself.
            dropped.append(str(exc))
            continue
        if g.is_empty:
            continue
        gj = g.__geo_interface__
        gj["coordinates"] = round_coords(gj["coordinates"])
        feats.append({"type": "Feature",
                      "properties": {"stage_ft": stage_ft, "category": cat},
                      "geometry": gj})
    return feats, dropped


def round_coords(c):
    if isinstance(c[0], (int, float)):
        return [round(float(x), COORD_DECIMALS) for x in c[:2]]
    return [round_coords(part) for part in c]


def observed_score(grid, valid, catch, transform, per_m: float,
                   stage_ft: float | None = None) -> dict:
    """Score the SHIPPED method (per-reach stage) against the 2016 water edge.

    The unit-resolution artifact scores the same observation with a UNIFORM stage, because
    that file's job is to compare two readings of the raster and not to endorse this
    file's method. Re-using its IoU here would print a number for a map this file does not
    produce. So the score is recomputed with the per-reach stages, on this domain.

    The domain is the study corridor, and the observation is clipped to it: the radar's
    polygon reaches further upstream than the corridor carries addresses, and water the
    product does not claim to map cannot count as a miss.
    """
    layer = sev.read_layer()
    poly = unary_union([g.buffer(0) for g in layer.to_crs(5070).geometry if g is not None])
    series = sev.gauge_series()
    when = sev.acquisition_time(layer)
    nearest = series.index[np.argmin(np.abs(series.index - when))]
    at = float(series.loc[nearest]) if stage_ft is None else float(stage_ft)
    obs = rasterize([(poly, 1)], out_shape=grid.shape, transform=transform,
                    fill=0).astype(bool) & valid
    stages, extrapolated = hand.reach_stages(hand.q_at_stage(at))
    mask, _ = band_mask(grid, valid, catch, stages, per_m)
    tp = int((mask & obs).sum())
    fp = int((mask & ~obs).sum())
    fn = int((~mask & obs).sum())
    return {
        "stage_ft": round(at, 2),
        "acquired": str(when) if stage_ft is None else None,
        "observed_km2": round(obs.sum() * hand.CELL_KM2, 1),
        "modelled_km2": round(mask.sum() * hand.CELL_KM2, 1),
        "area_ratio": round(mask.sum() / max(1, obs.sum()), 2),
        "iou": round(tp / (tp + fp + fn), 4) if (tp + fp + fn) else 0.0,
        "recall": round(tp / (tp + fn), 4) if (tp + fn) else 0.0,
        "precision": round(tp / (tp + fp), 4) if (tp + fp) else 0.0,
        "reaches_with_extrapolated_rating": len(extrapolated),
    }


def main():
    per_m = hand.units_per_metre()          # the measured unit, not a constant here
    res = json.loads(hand.RESOLUTION.read_text())
    p = hand.require_raw()
    grid, valid, transform, win, meta = corridor(p["rem"])
    with rasterio.open(p["catchments"]) as cs:
        # The same window, because the two rasters are one grid by construction. Asserted
        # rather than assumed: a future archive whose catchment tile is cropped would
        # otherwise pair each HAND value with another reach's catchment, which is exactly
        # the kind of silent misalignment this file exists to rule out.
        if (str(cs.crs) != meta["crs"] or cs.transform != meta["transform"]
                or cs.shape != meta["shape"]):
            sys.exit("the HAND raster and the catchment raster are no longer on the same grid")
        catch = cs.read(1, window=win)
    print(f"corridor {grid.shape[1]}x{grid.shape[0]} cells, {valid.sum() * hand.CELL_KM2:,.1f} km² valid, "
          f"unit {res['chosen']} ({per_m:.0f}/m)")

    feats: list[dict] = []
    curve = []
    for stage_ft in hand.BAND_STAGES_FT:
        q_cms = hand.q_at_stage(stage_ft)
        stages, extrapolated = hand.reach_stages(q_cms)
        mask, extra = band_mask(grid, valid, catch, stages, per_m)
        n = int(mask.sum())
        cat = category(stage_ft)
        band, dropped = polygons(mask, transform, stage_ft, cat)
        feats += band
        st = np.array(list(stages.values()))
        curve.append({
            "stage_ft": stage_ft, "category": cat,
            "discharge_cms": round(q_cms, 1), "cells": n,
            "area_km2": round(n * hand.CELL_KM2, 1),
            "polygons": len(band),
            "polygons_dropped_for_topology": len(dropped),
            "reach_stage_m": {"min": round(float(st.min()), 3),
                              "median": round(float(np.median(st)), 3),
                              "max": round(float(st.max()), 3)},
            "reaches_with_extrapolated_rating": len(extrapolated),
            "unassigned_cells": extra["unassigned_cells"],
        })
        print(f"  {stage_ft:5.2f} ft ({cat:<11}) Q {q_cms:7.0f} m³/s -> "
              f"{n * hand.CELL_KM2:7.1f} km² in {len(band)} polygons; reach stage "
              f"{st.min():.2f}-{st.max():.2f} m; {len(extrapolated)} extrapolated")

    # Scored where the product makes its claim: the corridor, with the radar clipped to it.
    # The unit-resolution artifact's 0.19 was a UNIFORM-stage score over a much larger
    # window; this is the number for this map, so it is computed here rather than quoted.
    at = observed_score(grid, valid, catch, transform, per_m)
    peak = observed_score(grid, valid, catch, transform, per_m,
                          stage_ft=float(res["usfimr_overlap"]["harvey_peak_ft"]))
    print(f"\nagainst 2016-05-30 (stage {at['stage_ft']:.2f} ft, corridor): "
          f"observed {at['observed_km2']:.1f} km², modelled {at['modelled_km2']:.1f} km² "
          f"({at['area_ratio']:.1f}x), IoU {at['iou']:.3f}, recall {at['recall']:.3f}, "
          f"precision {at['precision']:.3f}")
    print(f"at Harvey's peak ({peak['stage_ft']:.2f} ft, not like-for-like): "
          f"modelled {peak['modelled_km2']:.1f} km², IoU {peak['iou']:.3f}")

    validation = {
        "observation": "USFIMR Sentinel-1 water edge, 2016-05-30T00:26:20Z",
        "domain": ("the study corridor, with the radar extent clipped to it — the polygon "
                   "reaches further upstream than the corridor does"),
        "observed_stage_ft": at["stage_ft"],
        "observed_km2": at["observed_km2"],
        "modelled_km2_at_that_stage": at["modelled_km2"],
        "area_ratio": at["area_ratio"],
        "iou_at_that_stage": at["iou"],
        "recall": at["recall"],
        "precision": at["precision"],
        "harvey_peak_ft": peak["stage_ft"],
        "iou_at_harvey_peak": peak["iou"],
        "peak_is_not_like_for_like": (
            f"the image was taken at {at['stage_ft']:.2f} ft; the crest three days later was "
            f"{peak['stage_ft']:.2f} ft, so comparing the crest to it charges the map for "
            "water the image could never have shown"),
        "reading": ("an upper bound with a measured bias: at the one observed stage this maps "
                    f"{at['area_ratio']:.1f}x the radar's area, with recall {at['recall']:.2f} and "
                    f"precision {at['precision']:.2f}. The radar is a water edge under a "
                    "forested floodplain, which C-band under-maps, and HAND treats every low "
                    "cell as connected to its channel. Use the outline, not the waterline."),
    }
    meta = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "crs": "EPSG:4326",
        "source": ("NOAA-OWP HAND FIM, HUC 12070104 branch 3125000011 — "
                   "rem_zeroed_masked + hydroTable, 10 m, CC BY 4.0 via the Texas "
                   "Pin2Flood archive"),
        "unit": res["chosen"],
        "method": ("per-reach stage from the hydrotable SRC at the mainstem discharge the "
                   "observed Richmond rating gives for the band's stage; a cell is wet when "
                   "its HAND is below its own reach's stage"),
        "bands_ft": hand.BAND_STAGES_FT,
        # Keyed `:g` (45, 48, 50, 54.74) because that is what String(number) produces in
        # the app: a "45.0" key here would render the card's area as an em dash and the
        # test would pass while the number was missing.
        "band_areas_km2": {f"{c['stage_ft']:g}": c["area_km2"] for c in curve},
        "cell_m": 10,
        "min_polygon_ha": MIN_POLY_M2 / 10_000,
        "simplify_m": SIMPLIFY_M,
        "provisional": True,
        "validation": validation,
        "limits": [
            "steady state: the same discharge on every mainstem reach, no wave travel time",
            "no backwater: HAND's level-pool assumption per reach",
            "no connectivity test across catchments (HAND's known over-prediction)",
            "one observation, three days before the crest, in a forested floodplain",
        ],
    }
    # Everything the app needs to describe the layer travels with it, so the card cannot
    # print a number that this run did not measure. `features` stays at the top level where
    # every GeoJSON reader expects it; MapLibre ignores the sibling member.
    doc = {"type": "FeatureCollection", "features": feats, "meta": meta}
    out = DERIVED / "flood_extent.json"
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n")

    curve_doc = {
        "generated_at": meta["generated_at"],
        "bbox": list(hand.BBOX), "unit": res["chosen"], "provisional": True,
        "note": meta["method"],
        "validation": validation,
        "curve": curve,
    }
    (DERIVED / "stage_area_curve.json").write_text(json.dumps(curve_doc, indent=2) + "\n")

    if not PUBLIC.exists():
        sys.exit(f"{PUBLIC} missing — this exports into the app's payload")
    (PUBLIC / "flood_extent.json").write_text(out.read_text())
    gz = __import__("gzip").compress(out.read_bytes(), 9)
    print(f"\nWrote data/derived/flood_extent.json and app/public/data/flood_extent.json")
    print(f"  {len(feats)} polygons, {out.stat().st_size / 1000:.1f} KB raw, "
          f"{len(gz) / 1000:.1f} KB gzipped")
    # Gzipped, because that is what a compressing host sends and what check-text-mode.mjs
    # counts for every other byte in this app: the budget is about what crosses the wire.
    if len(gz) > 300_000:
        sys.exit(f"the extent is {len(gz) / 1000:.0f} KB gzipped, over the 300 KB budget "
                 "(NEXT-PLAN § 5.4) — raise SIMPLIFY_M or MIN_POLY_M2, or cut a band")


if __name__ == "__main__":
    main()
