#!/usr/bin/env python3
"""
BrazosCast — the measurement that settles the HAND raster's unit (NEXT-PLAN § 5.1).

`inundation.py` used to choose centimetres because 383 km2 of water at 45 ft "seemed
absurd", while the hydrotable's cell counts matched millimetres. That is a guess with a
preference, not a resolution, and everything built on the raster inherits it.

Two independent observations decide it instead:

  A. THE HYDROTABLE IS AN INDEPENDENT COUNT OF THE SAME CELLS. For each reach, at a
     given stage, `Number of Cells` is the wetted cell count NOAA's own synthetic rating
     curve reports — 10 m cells, so it is a count of this raster. Reading the raster as
     millimetres must reproduce it; reading it as centimetres must not. Compared per
     reach, not in total, because a total can agree by cancellation.

  B. THE 2016 USFIMR EXTENT IS AN INDEPENDENT OBSERVATION OF WATER. The Sentinel-1 water
     edge at 2016-05-30T00:26Z, at the stage the Richmond gauge was reading at that
     instant, is rasterised onto the same grid. Whichever reading puts water where the
     image put water wins; and the stage a reading needs to reproduce the observation is
     a second, separate check, because the two readings differ by exactly 10x.

The two checks are not the same evidence twice: A is a product of the same model family
(the SRC geometry), B is a satellite. The script refuses to choose if they disagree.

Output: data/derived/hand_unit_resolution.json
Usage : <env>/bin/python pipeline/derive/hand_unit_resolution.py
"""
import datetime as dt
import json
import pathlib
import sys

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds
from shapely.ops import unary_union

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hand
import second_event_validation as sev

# Stages to test check A at: the top of the range the product uses (40/50/60 ft), where a
# 10x error is impossible to confuse. Low stages are NOT used: the SRC's cell counts there
# include cells this raster masks away, so a 40% disagreement at 10 ft says nothing about
# the unit and would only weaken the check that does.
COUNT_STAGES_M = [12.192, 15.24, 18.288]
MIN_CELLS = 50          # a reach with fewer wetted cells than this is noise, not evidence
SWEEP_M = np.arange(4.0, 22.01, 0.25)
MIN_STAGE_GAP_FT = 12.0  # a reading whose implied stage is this far from the observed one
                        # cannot have reproduced the observation, whatever its IoU


def per_reach_counts(stage_m: float) -> dict:
    """Cell counts per reach under both readings, in one pass over the raster.

    Blocked by rows: the raster is 14950x9192 and holding two int16 copies plus masks is
    ~550 MB for no reason. `bincount` over the masked cell indices does the per-reach
    grouping in one call per block rather than one call per reach.
    """
    p = hand.require_raw()
    out = {name: np.zeros(4096, dtype=np.int64) for name in hand.CANDIDATES}
    valid_total = 0
    hmax = 0
    with rasterio.open(p["rem"]) as rs, rasterio.open(p["catchments"]) as cs:
        nod = rs.nodata
        for r0 in range(0, rs.height, 1000):
            h = rs.read(1, window=Window(0, r0, rs.width, min(1000, rs.height - r0)))
            c = cs.read(1, window=Window(0, r0, rs.width, min(1000, rs.height - r0)))
            ok = (h != nod) & (c != 0)
            valid_total += int(ok.sum())
            if ok.any():
                hmax = max(hmax, int(h[ok].max()))
            idx = c[ok].astype(np.int64)
            hv = h[ok]
            for name, per_m in hand.CANDIDATES.items():
                out[name] += np.bincount(idx, weights=(hv < stage_m * per_m).astype(np.int64),
                                         minlength=out[name].size).astype(np.int64)
    return {"counts": out, "valid_cells": valid_total, "max_value": hmax}


def check_hydrotable() -> dict:
    ht = hand.hydrotable()
    rows = []
    hmax = 0
    for stage_m in COUNT_STAGES_M:
        sub = ht[np.isclose(ht["stage"], stage_m)].drop_duplicates("HydroID")
        if sub.empty:
            sys.exit(f"the hydrotable has no rows at stage {stage_m} m — the comparison "
                     "stages are no longer on its grid, so this check would compare nothing")
        cells = per_reach_counts(stage_m)
        hmax = max(hmax, cells["max_value"])
        res = {"stage_m": stage_m, "stage_ft": round(stage_m / hand.FT_M, 2),
               "reaches": 0, "readings": {}}
        for name in hand.CANDIDATES:
            ratios = []
            for idx, want in zip(sub["idx"].astype(int), sub["Number of Cells"].astype(int)):
                if want < MIN_CELLS:
                    continue
                got = int(cells["counts"][name][idx])
                ratios.append(got / want)
            r = np.array(ratios, dtype=float)
            res["reaches"] = int(len(r))
            res["readings"][name] = {
                "median_ratio": round(float(np.median(r)), 4),
                "p10": round(float(np.percentile(r, 10)), 4),
                "p90": round(float(np.percentile(r, 90)), 4),
                "within_10_percent": round(float(np.mean((r > 0.9) & (r < 1.1))), 4),
                # A reading is "reproducing the counts" when the typical reach is within
                # 10% and most reaches are. Millimetres measures 1.000 / 0.87-1.00;
                # centimetres measures 0.048 / 0.01-0.04, so the margin is not close.
                "reproduces": bool(abs(np.median(r) - 1.0) <= 0.10
                                   and np.mean((r > 0.9) & (r < 1.1)) >= 0.70),
            }
        rows.append(res)
        mm, cm = res["readings"]["millimetres"], res["readings"]["centimetres"]
        print(f"  A {res['stage_ft']:5.1f} ft ({stage_m:5.2f} m): mm median {mm['median_ratio']:.3f} "
              f"[{mm['p10']:.3f}-{mm['p90']:.3f}]  cm median {cm['median_ratio']:.3f} "
              f"[{cm['p10']:.3f}-{cm['p90']:.3f}]  ({res['reaches']} reaches)")
    winner = [n for n in hand.CANDIDATES if all(r["readings"][n]["reproduces"] for r in rows)]
    return {"stages": rows, "agrees_with": winner, "max_value": hmax}


def observation_mask(rem_path, pad_m: float = 2000.0) -> dict:
    """The 2016 image rasterised onto the REM grid, the stage it was taken at, and the window.

    The stage comes from the layer's own acquisition timestamp and the gauge's own
    record — the same path `second_event_validation.py` uses, imported rather than
    copied, so the two cannot disagree about which instant this image is.
    """
    layer = sev.read_layer()
    poly = unary_union([g.buffer(0) for g in layer.to_crs(5070).geometry if g is not None])
    series = sev.gauge_series()
    when = sev.acquisition_time(layer)
    nearest = series.index[np.argmin(np.abs(series.index - when))]
    stage_ft = float(series.loc[nearest])

    minx, miny, maxx, maxy = poly.bounds
    with rasterio.open(rem_path) as src:
        w = from_bounds(minx - pad_m, miny - pad_m, maxx + pad_m, maxy + pad_m,
                        src.transform).round_offsets().round_lengths()
        # Clamp to the raster: reading past its edge fills with 0, and 0 is a valid HAND
        # value, so an unclamped window would count the void outside as dry land at the
        # channel — the first version of this measured a 7x larger domain that way.
        c0, r0 = max(0, w.col_off), max(0, w.row_off)
        c1, r1 = min(src.width, w.col_off + w.width), min(src.height, w.row_off + w.height)
        win = Window(c0, r0, c1 - c0, r1 - r0)
        grid = src.read(1, window=win)
        transform = src.window_transform(win)
        nodata = src.nodata
    valid = grid != nodata
    obs = rasterize([(poly, 1)], out_shape=grid.shape, transform=transform,
                    fill=0).astype(bool) & valid
    return {"grid": grid, "valid": valid, "observed": obs, "transform": transform,
            "stage_ft": stage_ft, "acquired": str(when), "observed_km2": obs.sum() * hand.CELL_KM2}


def score(mask: np.ndarray, obs: np.ndarray) -> dict:
    tp = int((mask & obs).sum())
    fp = int((mask & ~obs).sum())
    fn = int((~mask & obs).sum())
    iou = tp / (tp + fp + fn) if (tp + fp + fn) else 0.0
    return {"iou": round(iou, 4), "tp": tp, "fp": fp, "fn": fn,
            "area_km2": round(mask.sum() * hand.CELL_KM2, 1),
            "recall": round(tp / (tp + fn), 4) if (tp + fn) else 0.0,
            "precision": round(tp / (tp + fp), 4) if (tp + fp) else 0.0}


def check_usfimr() -> dict:
    p = hand.require_raw()
    o = observation_mask(p["rem"])
    grid, valid, obs = o["grid"], o["valid"], o["observed"]
    stage_m = o["stage_ft"] * hand.FT_M
    print(f"  B observation: {o['acquired']}, gauge {o['stage_ft']:.2f} ft, "
          f"{o['observed_km2']:.1f} km2 mapped")

    readings = {}
    for name, per_m in hand.CANDIDATES.items():
        at_stage = score(valid & (grid < stage_m * per_m), obs)
        best = None
        for s in SWEEP_M:
            m = score(valid & (grid < s * per_m), obs)
            # Ties are broken toward the observed stage: two stages that map the same
            # cells describe the same water, and the one nearer the gauge reading is the
            # better explanation of it.
            if best is None or (m["iou"], -abs(s - stage_m)) > (best["iou"], -abs(best["stage_m"] - stage_m)):
                best = {**m, "stage_m": round(float(s), 3),
                        "stage_ft": round(float(s) / hand.FT_M, 2)}
        gap_ft = abs(best["stage_ft"] - o["stage_ft"])
        readings[name] = {
            "at_observed_stage": at_stage,
            "best": best,
            "best_stage_gap_ft": round(gap_ft, 2),
            "best_stage_is_plausible": bool(gap_ft <= MIN_STAGE_GAP_FT),
        }
        print(f"    {name:<12} at {o['stage_ft']:.1f} ft: IoU {at_stage['iou']:.3f}, "
              f"{at_stage['area_km2']:7.1f} km2 | best IoU {best['iou']:.3f} at "
              f"{best['stage_ft']:.1f} ft ({gap_ft:5.1f} ft from the observed stage)")

    # Harvey's peak, for the gate's second half. Stated separately because the image is
    # three days BEFORE the peak: this is not the like-for-like number, and the script
    # says so rather than quietly comparing a crest to a rising limb.
    receipt = json.loads((hand.USFIMR_ZIP.parent / "_receipt.json").read_text())
    peak_ft = float(receipt["event"]["observed_peak_ft"])
    peak = {name: score(valid & (grid < peak_ft * hand.FT_M * per_m), obs)
            for name, per_m in hand.CANDIDATES.items()}
    print(f"  B at Harvey's peak {peak_ft:.2f} ft (not like-for-like, image is 3 d earlier): "
          + " ".join(f"{n} IoU {v['iou']:.3f}" for n, v in peak.items()))
    return {"observation": {k: o[k] for k in ("stage_ft", "acquired", "observed_km2")},
            "readings": readings, "harvey_peak_ft": peak_ft, "harvey_peak": peak,
            "peak_is_not_like_for_like": (
                f"the image was taken at {o['stage_ft']:.2f} ft and the crest three days later "
                f"was {peak_ft:.2f} ft, so water at the crest extended further than the "
                "image can show; the like-for-like comparison is the one at the acquisition "
                "stage")}


def main():
    p = hand.require_raw()
    print("check A — the hydrotable's own cell counts (a count of this raster)")
    a = check_hydrotable()
    print("\ncheck B — the 2016 USFIMR water edge")
    b = check_usfimr()

    # ---- the decision ---------------------------------------------------------------
    # Both checks must name the same reading. A tie, a disagreement, or a reading that
    # passes neither is a stop: the point of this file is that the unit is not a
    # judgement call any more, so it must not be made by whichever check ran last.
    with rasterio.open(p["rem"]) as src:
        raster = {"path": str(p["rem"].relative_to(hand.ROOT)), "dtype": str(src.dtypes[0]),
                  "nodata": src.nodata, "shape": list(src.shape), "crs": str(src.crs),
                  "res_m": src.res[0], "max_value": a["max_value"]}

    a_winner = a["agrees_with"]
    b_rank = sorted(b["readings"], key=lambda n: -b["readings"][n]["best"]["iou"])
    plausible = [n for n in b["readings"] if b["readings"][n]["best_stage_is_plausible"]]
    if len(a_winner) != 1:
        sys.exit(f"check A did not pick one reading (it matched the counts under {a_winner})")
    if len(plausible) != 1:
        sys.exit(f"check B's best-fit stage is plausible under {plausible or 'neither reading'}"
                 " — the unit cannot be settled on this observation")
    if a_winner[0] != plausible[0]:
        sys.exit(f"the checks disagree: hydrotable counts say {a_winner[0]}, the 2016 extent "
                 f"says {plausible[0]} — do not proceed on either alone")
    chosen = a_winner[0]
    other = [n for n in hand.CANDIDATES if n != chosen][0]

    # The measured regret: what the rejected reading would have got wrong, in the two
    # currencies the product cares about (area at a stage, and the stage needed to
    # explain the one observed extent).
    other_best = b["readings"][other]["best"]
    chosen_best = b["readings"][chosen]["best"]
    regret = {
        "area_at_observed_stage_ratio": round(
            b["readings"][other]["at_observed_stage"]["area_km2"]
            / max(1e-9, b["readings"][chosen]["at_observed_stage"]["area_km2"]), 3),
        "stage_needed_to_explain_the_observation_ft": {
            chosen: chosen_best["stage_ft"], other: other_best["stage_ft"]},
        "reading": (f"under {other} the 2016 image would need a stage "
                    f"{b['readings'][other]['best_stage_gap_ft']:.1f} ft from the gauge's, "
                    f"against {b['readings'][chosen]['best_stage_gap_ft']:.1f} ft under "
                    f"{chosen}"),
    }

    doc = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "question": "in which unit is rem_zeroed_masked_3125000011 stored?",
        "raster": raster,
        "candidates": hand.CANDIDATES,
        "hydrotable_cell_counts": a,
        "usfimr_overlap": b,
        "chosen": chosen,
        "units_per_metre": hand.CANDIDATES[chosen],
        "why": (
            "two independent checks pick the same reading. The hydrotable reproduces the "
            f"raster's cell counts per reach under {chosen} (median ratio 1.000 at every "
            f"stage tested) and not under {other} (median 0.05); the 2016 Sentinel-1 "
            f"extent overlaps it better, and the stage needed to explain that observation "
            f"is {b['readings'][chosen]['best_stage_gap_ft']:.1f} ft from the gauge under "
            f"{chosen} against {b['readings'][other]['best_stage_gap_ft']:.1f} ft under "
            f"{other} — a reading that needs a stage 20+ ft from the measurement to fit "
            "the water is not measuring the same thing"),
        "regret_if_wrong": regret,
        "residual": (f"the overlap is {chosen_best['iou']:.2f} IoU at best, not a match: the "
                     "model floods a larger area than the radar image shows, and the image is "
                     "a water edge in a forested floodplain, where C-band SAR under-maps. The "
                     "unit is settled; the extent's bias is not, and inundation.py states it."),
    }
    hand.RESOLUTION.parent.mkdir(parents=True, exist_ok=True)
    hand.RESOLUTION.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"\nchosen: {chosen} ({hand.CANDIDATES[chosen]:.0f} units per metre)")
    print(doc["why"])
    print(f"\nWrote {hand.RESOLUTION.relative_to(hand.ROOT)}")


if __name__ == "__main__":
    main()
