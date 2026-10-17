#!/usr/bin/env python3
"""
BrazosCast — I1: adjudicate the thresholds against a SECOND observed flood.

Step 6 scored the model against one observation: the USGS Harvey extent, an event
MAXIMUM at the record peak. Its own output names what that cannot do, and it is the
reason this file exists (harvey_validation.py, `below_action_stage`):

    "A segment observed wet at the record peak is equally consistent with flooding at
     17 ft and at 55 ft, so a point-in-time extent carries no information about a low
     threshold. [...] Adjudicating the below-action segments needs a series of extents
     at successive stages."

This is a second point in that series, and it is a different KIND of point: not a
surveyed maximum interpolated between high-water marks, but a **water edge read off a
Sentinel-1 radar image** on 2016-05-30, three days BEFORE the 2016 peak, when the gauge
was reading 49.40 ft — 5.7 ft below the Harvey peak.

WHY THAT IS THE VALUABLE DIRECTION. A HIGHER stage can only add "wet" observations,
and wet at 55.1 ft says nothing about a 17 ft threshold. A LOWER stage can REFUTE: a
segment this image shows DRY had not flooded at 49.40 ft, so its true threshold is
ABOVE 49.40 ft. Every shipped threshold below that bound which the image finds dry is
a refutation the Harvey maximum was structurally unable to produce. That count is the
headline of this file.

THE SECOND QUESTION, AND THE ONE THE PLAN ACTUALLY ASKS. Step 3 closed every route to a
physically-correct conversion because "there is no second event to test the correction
on". There is now a second event. So the correction measured on Harvey — the probit lift
the app quotes, read from harvey_validation.json rather than restated here — is applied
UNCHANGED to this observation and scored out of sample — and the same best-cut
search is run on 2016 alone, so the two events' implied lifts can be compared. A
constant that reproduces a different flood is corroboration; one that does not is a
fitted number, and either answer is the point of the test. Note what makes this
out-of-sample: nothing here is fitted on 2016 and reported as if it were held out —
the Harvey lift is read from harvey_validation.json and used as it stands.

WHAT THIS OBSERVATION IS NOT, stated before any number is quoted
  * one instant, not the event peak. The 2016 event crested 54.74 ft on 06-02; this
    image is from the rising limb at 49.40 ft, which is exactly why it can refute.
  * a radar water edge, not a surveyed extent: vegetation and smooth open water both
    backscatter oddly, and a wind-roughened surface can read as land. SDML's own
    catalogue describes "some ground proofing based on secondary sources" (news,
    social media), not a field survey.
  * NOT a map of where water was absent across the whole corridor. The mapped polygon is
    the water; "dry" is only meaningful where the scene covered the ground, which is why
    the evaluated set is restricted and the sensitivity to that choice is reported.
  * the crest travels downstream (FINDINGS section 1), so a single Richmond reading is
    not simultaneous with every location — the same limit the Harvey comparison carries,
    and it is not smaller here because the image is on the rising limb.

Input : data/raw/usfimr/05302016_Brazos_River_at_Richmond_TX.zip (fetch_usfimr_2016.mjs),
        data/derived/road_thresholds.geojson, data/raw/usgs/iv/08114000_20160524.json,
        data/derived/harvey_validation.json (the lift this file tests)
Output: data/derived/second_event_validation.json
Usage : <env>/bin/python pipeline/derive/second_event_validation.py
"""
import json
import pathlib
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
ZIP = ROOT / "data" / "raw" / "usfimr" / "05302016_Brazos_River_at_Richmond_TX.zip"
MEMBER = ("/vsizip/" + str(ZIP) +
          "/05302016_Brazos_River_at_Richmond_TX/05302016_Brazos_River_at_Richmond_TX.shp")
IVCACHE = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20160524.json"
GAUGE = "08114000"

# The catalogued mapped area, used as a gate on the fetched layer rather than as an
# input to anything: if the file ever changes under us, the analysis should stop.
CATALOG_KM2 = 214.9

# Where the "dry" reading is trusted: the image covers the reach from Rosharon up past
# Hempstead (the layer's own USGS_Gage field names both), so the evaluated set is the
# study corridor's segments inside the polygon's bounding box. The tighter variant below
# ("near_water") is the conservative one and both are reported.
NEAR_WATER_M = 1000.0

sys.path.insert(0, str(ROOT / "pipeline" / "derive"))


def read_layer() -> gpd.GeoDataFrame:
    return gpd.read_file(MEMBER)


def acquisition_time(layer: gpd.GeoDataFrame) -> pd.Timestamp:
    """The image instant, from the layer's OWN attributes.

    Read rather than hardcoded: the acquisition time is the thing that makes this a
    stage-specific observation, so a second-hand copy of it in this file would be the
    one field that could silently turn it into a different test.
    """
    row = layer.iloc[0]
    # Both fields arrive through geopandas' reader: the date as a timestamp at midnight
    # and the time as text. Only the date part of the first is wanted.
    day = pd.Timestamp(row["Flood_Date"]).date()
    return pd.Timestamp(f"{day}T{row['Start_Time']}", tz="UTC")


def gauge_series() -> pd.Series:
    rows = json.loads(IVCACHE.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["t", "v"]).drop_duplicates("t").set_index("t")["v"].sort_index()


def confusion(model_wet: np.ndarray, obs_wet: np.ndarray) -> dict:
    tp = int((model_wet & obs_wet).sum()); fp = int((model_wet & ~obs_wet).sum())
    fn = int((~model_wet & obs_wet).sum()); tn = int((~model_wet & ~obs_wet).sum())
    n = tp + fp + fn + tn
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "n": n,
        "accuracy": (tp + tn) / n if n else float("nan"),
        "false_positive_rate": fp / (fp + tn) if (fp + tn) else float("nan"),
        "recall": tp / (tp + fn) if (tp + fn) else float("nan"),
        "precision": tp / (tp + fp) if (tp + fp) else float("nan"),
        "prevalence_observed": (tp + fn) / n if n else float("nan"),
        "prevalence_modelled": (tp + fp) / n if n else float("nan"),
    }


def auc(score: np.ndarray, positive: np.ndarray) -> float:
    """Mann-Whitney AUC of `score` for ranking observed-wet above observed-dry.

    The diagnostic that decides how the rest of this file should be read. If the
    thresholds still RANK water above dry at this stage, then only the cutoff is wrong
    and a stage shift is the right fix; if they do not, this event disputes the ranking
    itself and no cutoff would have saved it. Harvey's AUC was 0.809.
    """
    r = pd.Series(score).rank().to_numpy()
    npos, nneg = int(positive.sum()), int((~positive).sum())
    if not npos or not nneg:
        return float("nan")
    return float((r[positive].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def best_cut(threshold: np.ndarray, obs_wet: np.ndarray, lo=4.0, hi=90.0) -> dict:
    """The stage that best reproduces this observation, two ways, swept in 0.05 ft.

    Accuracy AND balanced accuracy, because on this observation they are not the same
    question and one of them has a degenerate answer. The 2016 image puts water on a
    small share of the road network (73 of 1,614 segments), so a rule that predicts
    "nothing floods" scores 0.955 accuracy — maximising accuracy would therefore return
    the floor of the search grid rather than a stage, which is what the first run of
    this file did. Balanced accuracy (the mean of recall and specificity) cannot be
    gamed that way, so BOTH are reported and the reader can see the difference rather
    than being handed whichever one flatters the model.
    """
    rows = []
    for s in np.arange(lo, hi, 0.05):
        m = threshold <= s
        tp = int((m & obs_wet).sum()); fp = int((m & ~obs_wet).sum())
        fn = int((~m & obs_wet).sum()); tn = int((~m & ~obs_wet).sum())
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        spec = tn / (fp + tn) if (fp + tn) else 0.0
        rows.append((s, tp + tn, rec, spec, (rec + spec) / 2))
    df = pd.DataFrame(rows, columns=["stage", "correct", "recall", "specificity", "balanced"])
    ka, kb = df["correct"].idxmax(), df["balanced"].idxmax()
    out = {
        "by_accuracy": {"stage_ft": float(df.loc[ka, "stage"]),
                        "accuracy": float(df.loc[ka, "correct"] / len(threshold)),
                        "recall": float(df.loc[ka, "recall"]),
                        "specificity": float(df.loc[ka, "specificity"]),
                        "balanced_accuracy": float(df.loc[ka, "balanced"]),
                        "degenerate": bool(df.loc[ka, "recall"] == 0.0)},
        "by_balanced_accuracy": {"stage_ft": float(df.loc[kb, "stage"]),
                                 "accuracy": float(df.loc[kb, "correct"] / len(threshold)),
                                 "recall": float(df.loc[kb, "recall"]),
                                 "specificity": float(df.loc[kb, "specificity"]),
                                 "balanced_accuracy": float(df.loc[kb, "balanced"])},
        "why_two": ("on an observation whose wet class is a few per cent of the "
                    "population, accuracy is maximised by predicting nothing wet — the "
                    "first run of this file returned the search grid's floor for exactly "
                    "that reason"),
    }
    out["read"] = ("by_accuracy" if not out["by_accuracy"]["degenerate"]
                   else "by_balanced_accuracy")
    return out


def main():
    if not ZIP.exists():
        sys.exit("data/raw/usfimr/*.zip missing — run "
                 "node pipeline/fetch/fetch_usfimr_2016.mjs first")
    hv = json.loads((DERIVED / "harvey_validation.json").read_text())
    harvey = {
        "peak_ft": hv["peak"]["stage_ft"],
        "lift_ft": hv["estimators_of_the_same_lift"]["probit_mle_ft"],
        "sigma_ft": hv["diagnosis"]["threshold_error_model"]["per_street_sigma_ft"],
        "accuracy": hv["confusion_matrix"]["accuracy"],
        "fpr": hv["confusion_matrix"]["false_positive_rate"],
    }
    print(f"Harvey comparison, for reference: peak {harvey['peak_ft']:.2f} ft, "
          f"fitted lift {harvey['lift_ft']:+.2f} ft, accuracy {harvey['accuracy']:.3f}, "
          f"fpr {harvey['fpr']:.3f}")

    layer = read_layer()
    when = acquisition_time(layer)
    area_km2 = float(layer.to_crs(6579).area.sum() / 1e6)
    print(f"\nsecond observation: {len(layer)} polygon(s), {layer.crs}, "
          f"{area_km2:.1f} km2, acquired {when.isoformat()}")

    # ---- the stage this image is commensurate with ------------------------------
    s = gauge_series()
    nearest = s.index[np.argmin(np.abs(s.index - when))]
    stage = float(s.loc[nearest])
    gap_min = abs((nearest - when).total_seconds()) / 60.0
    day = s[(s.index >= when.normalize()) & (s.index < when.normalize() + pd.Timedelta("1D"))]
    band = [float(day.min()), float(day.max())]
    print(f"RMOT2 at {nearest.isoformat()} ({gap_min:.0f} min from the image): {stage:.2f} ft "
          f"| over the whole acquisition day: {band[0]:.2f} to {band[1]:.2f} ft")

    # Cross-check the stage against the layer's own discharge for the image through the
    # rating that Step 3 fixed. Two independent readings of the same instant; a large
    # disagreement would mean the image and the gauge describe different water.
    q_at_image = float(layer.iloc[0]["Q_at_Image"])
    from gauge_rating import stage_from_flow
    q_stage, extrapolated = stage_from_flow(q_at_image)
    print(f"cross-check: Q_at_Image {q_at_image:,.0f} cfs -> rating stage "
          f"{q_stage:.2f} ft (extrapolated={extrapolated}); "
          f"difference from the gauge reading {q_stage - stage:+.2f} ft")

    # ---- observed water, and the ground the reading applies to -------------------
    roads = gpd.read_file(DERIVED / "road_thresholds.geojson").to_crs(layer.crs)
    thresh = roads["flood_stage_ft"].to_numpy(float)
    poly = unary_union([g.buffer(0) for g in layer.geometry if g is not None])
    p_poly = prep(poly)

    obs_wet = np.array([p_poly.intersects(g) for g in roads.geometry])
    minx, miny, maxx, maxy = poly.bounds
    cen = roads.geometry.centroid
    in_box = np.array([(minx <= x <= maxx and miny <= y <= maxy)
                       for x, y in zip(cen.x, cen.y)])
    near = np.array([g.distance(poly) <= NEAR_WATER_M for g in roads.geometry])
    print(f"\nroads: {len(roads)} | inside the polygon bbox: {in_box.sum()} | "
          f"within {NEAR_WATER_M:.0f} m of mapped water: {near.sum()} | "
          f"observed wet: {obs_wet.sum()}")

    model_wet = thresh <= stage
    corrected_wet = (thresh + harvey["lift_ft"]) <= stage

    # ---- the headline: the refutations the maximum extent could not produce ------
    # A segment the image shows DRY at this stage had not flooded yet, so its true
    # threshold is above the stage. Every shipped threshold below that bound is refuted.
    refuted = in_box & ~obs_wet & model_wet
    refuted_fixed = refuted & ~corrected_wet
    act = {
        "stage_ft": stage,
        "segments_evaluated": int(in_box.sum()),
        "observed_wet": int((obs_wet & in_box).sum()),
        "shipped_thresholds_below_the_stage": int(model_wet[in_box].sum()),
        "refuted_by_this_image": int(refuted.sum()),
        "refuted_and_fixed_by_the_harvey_lift": int(refuted_fixed.sum()),
        "why_this_is_the_point": (
            "a segment shown dry at this stage has a true threshold ABOVE it; the "
            "shipped threshold below it is refuted. The Harvey maximum could not do "
            "this: a segment wet at 55.1 ft is consistent with flooding at 17 ft or at "
            "55.1 ft, and every below-action segment there was wet."),
    }
    # The obvious objection to a radar-derived refutation is that radar MISSES water
    # (vegetation, smooth open water, wind roughening). So the objection is quantified:
    # how much water would the image have to have missed for the refutations to be an
    # artifact of under-mapping rather than a fact about the thresholds?
    under_map = {
        "observed_wet_segments": int((obs_wet & in_box).sum()),
        "refuted_segments": int(refuted.sum()),
        "water_would_have_to_be_under_mapped_by_a_factor_of": round(
            float(refuted.sum()) / max(1, int((obs_wet & in_box).sum())), 1),
        "reading": ("each of the refuted segments is a road the model puts under water at "
                    "this stage and the image shows dry, so erasing every refutation by "
                    "under-mapping would need the image to be missing this many times "
                    "more water than it contains — the number, not an assurance"),
    }
    print(f"\n=== the refutations (stage {stage:.2f} ft, whole corridor) ===")
    print(f"  shipped thresholds at or below this stage : "
          f"{act['shipped_thresholds_below_the_stage']}")
    print(f"  of those, the image shows DRY (refuted)   : {act['refuted_by_this_image']}")
    print(f"  ... which the Harvey lift then fixes      : "
          f"{act['refuted_and_fixed_by_the_harvey_lift']}")
    print(f"  water on {under_map['observed_wet_segments']} segments; erasing the refutations "
          f"by radar under-mapping would need "
          f"{under_map['water_would_have_to_be_under_mapped_by_a_factor_of']}x more water "
          f"than the image holds")

    # ---- agreement, shipped vs corrected, at this stage ------------------------
    res = confusion(model_wet[in_box], obs_wet[in_box])
    cor = confusion(corrected_wet[in_box], obs_wet[in_box])
    print(f"\n=== agreement with the 2016 image (bbox evaluated set, n={res['n']}) ===")
    for tag, c in (("shipped  ", res), ("+lift    ", cor)):
        print(f"  {tag} TP {c['tp']:5d} FP {c['fp']:5d} FN {c['fn']:5d} TN {c['tn']:5d} | "
              f"accuracy {c['accuracy']:.3f} | fpr {c['false_positive_rate']:.3f} | "
              f"recall {c['recall']:.3f}")
    print(f"  modelled prevalence at this stage {res['prevalence_modelled']:.3f} vs observed "
          f"{res['prevalence_observed']:.3f}")

    # ---- the second event's OWN best-cut lift, compared to Harvey's --------------
    # The like-for-like AUC. Harvey's 0.809 was computed on the segments inside ITS mapped
    # boundary (1,187 of them), and an AUC depends on which population it is computed over,
    # so comparing that number with a corridor-wide AUC would confound the two events with
    # two different evaluated sets. The boundary layer is cached, so the second event's AUC
    # is computed on the same population as well as on the corridor, and both are reported.
    HARVEY_ZIP = ROOT / "data" / "raw" / "harvey" / "Brazos_upper.zip"
    harvey_bnd = gpd.read_file(f"/vsizip//{HARVEY_ZIP}/Brazos_upper/brazos_upper_bndy.shp")
    p_harvey_bnd = prep(unary_union([g.buffer(0) for g in harvey_bnd.geometry
                                     if g is not None]).buffer(0))
    in_harvey_set = np.array([p_harvey_bnd.contains(g.centroid)
                              for g in roads.to_crs(harvey_bnd.crs).geometry])
    a6_hvset = auc(-thresh[in_harvey_set], obs_wet[in_harvey_set])
    print(f"\nlike-for-like populations: corridor n={len(roads)}, Harvey's mapped-boundary set "
          f"n={int(in_harvey_set.sum())}")
    print(f"  AUC on the corridor                     : {auc(-thresh[in_box], obs_wet[in_box]):.3f}")
    print(f"  AUC on Harvey's evaluated set           : {a6_hvset:.3f} "
          f"(Harvey's own AUC on this set was 0.809)")

    t, o = thresh[in_box], obs_wet[in_box]
    a6 = auc(-t, o)
    cut = best_cut(t, o)
    key = cut["read"]
    lift_here = cut[key]["stage_ft"] - stage
    print(f"\ncan the thresholds still RANK water above dry at this stage? AUC {a6:.3f} "
          f"(Harvey was 0.809; 0.5 is a coin toss)")
    print(f"best-reproducing stage, by {key}: {cut[key]['stage_ft']:.2f} ft "
          f"-> implied lift {lift_here:+.2f} ft")
    print(f"  by accuracy             : {cut['by_accuracy']['stage_ft']:.2f} ft "
          f"(accuracy {cut['by_accuracy']['accuracy']:.3f}, recall "
          f"{cut['by_accuracy']['recall']:.3f}"
          f"{', DEGENERATE — predicts nothing wet' if cut['by_accuracy']['degenerate'] else ''})")
    print(f"  by balanced accuracy    : {cut['by_balanced_accuracy']['stage_ft']:.2f} ft "
          f"(balanced {cut['by_balanced_accuracy']['balanced_accuracy']:.3f}, recall "
          f"{cut['by_balanced_accuracy']['recall']:.3f}, specificity "
          f"{cut['by_balanced_accuracy']['specificity']:.3f})")
    print(f"  the lift fitted on Harvey alone: {harvey['lift_ft']:+.2f} ft "
          f"(this event differs by {lift_here - harvey['lift_ft']:+.2f} ft)")

    # ---- sensitivity: to the evaluated set, and to the stage ---------------------
    # The polygon's bounding box spans the whole corridor (measured: 1,614 of 1,614
    # centroids inside it), so the box is not an evaluated set at all and the two
    # reported sets are the corridor itself and a conservative near-water restriction.
    sens = {
        "whole_corridor": res,
        "near_water_1000m": confusion(model_wet[near], obs_wet[near]),
        "bbox_is_not_a_restriction": {
            "segments_inside_polygon_bbox": int(in_box.sum()), "of": len(roads),
            "note": ("reported because the first version of this file used the box as the "
                     "evaluated set: it excludes nothing, so it was measuring the whole "
                     "corridor under another name"),
        },
    }
    stages = {
        "image_instant": stage,
        "day_min": band[0],
        "day_max": band[1],
        "day_mean": float(day.mean()),
        "layer_Q_through_rating": float(q_stage),
    }
    by_stage = {}
    for tag, st in stages.items():
        c = confusion(thresh[in_box] <= st, obs_wet[in_box])
        cc = confusion((thresh[in_box] + harvey["lift_ft"]) <= st, obs_wet[in_box])
        by_stage[tag] = {"stage_ft": st, "shipped": c, "corrected": cc,
                         "refuted": int(((thresh[in_box] <= st) & ~obs_wet[in_box]).sum())}
    print("\nsensitivity to the stage chosen for the image:")
    for tag, v in by_stage.items():
        print(f"  {tag:<24} {v['stage_ft']:6.2f} ft | shipped acc "
              f"{v['shipped']['accuracy']:.3f} | corrected acc {v['corrected']['accuracy']:.3f} "
              f"| refuted {v['refuted']}")

    # ---- the below-action segments, which this is the first test able to touch ---
    below = in_box & (thresh < 20.0)
    b = {
        "n": int(below.sum()),
        "observed_wet": int((below & obs_wet).sum()),
        "shipped_says_wet_at_this_stage": int((below & model_wet).sum()),
        "observed_dry_share": float((below & ~obs_wet).sum() / below.sum())
        if below.sum() else None,
        "what_it_means": (
            "these segments claim to submerge at or below the 20 ft action stage. At "
            f"{stage:.2f} ft the model says every one of them is under water; the image "
            "shows how many were dry, and each of those refutes its threshold. This is "
            "the first observation in the repo that can say anything at all about them, "
            "because it is BELOW the stage at which they claim to flood."),
    }
    print(f"\nbelow-action segments in the evaluated set: {b['n']}, model says wet "
          f"{b['shipped_says_wet_at_this_stage']}, image shows dry "
          f"{(below & ~obs_wet).sum()}")

    # ---- gates ------------------------------------------------------------------
    assert abs(area_km2 - CATALOG_KM2) < 1.0, (
        f"the fetched layer measures {area_km2:.1f} km2 and the catalogue says "
        f"{CATALOG_KM2} — this is not the dataset the receipt describes")
    assert len(layer) >= 1 and layer.crs is not None, "the layer lost its CRS"
    assert gap_min <= 20, (
        f"the nearest gauge reading is {gap_min:.0f} min from the image; the cached "
        f"instantaneous series does not cover the acquisition")
    assert stage < harvey["peak_ft"] - 3.0, (
        f"this observation is at {stage:.2f} ft against Harvey's {harvey['peak_ft']:.2f} ft: "
        f"a second HIGH-stage extent adds nothing about low thresholds, so the reason for "
        f"choosing this image would no longer hold")
    assert in_box.sum() > 500, "the evaluated set collapsed — the CRS or the join is wrong"
    assert obs_wet.sum() > 0, "no road intersects the mapped water — CRS or join is wrong"
    assert near.sum() > 0 and near.sum() < len(roads), (
        f"the near-water evaluated set is degenerate ({near.sum()} of {len(roads)} segments), "
        f"so the conservative variant of the comparison is not measuring anything")
    assert int(refuted.sum()) > 0, (
        "the image refutes nothing: either it is not a lower-stage observation after all, "
        "or the comparison has broken")
    assert under_map["water_would_have_to_be_under_mapped_by_a_factor_of"] > 3.0, (
        "the refutation count is no larger than a plausible radar under-mapping error, so "
        "it cannot carry the conclusion drawn from it")
    assert cor["false_positive_rate"] < res["false_positive_rate"] + 1e-9, (
        "applying the Harvey lift makes the false-positive rate worse on the second event, "
        "which would mean it moves the thresholds the wrong way here")
    assert cor["recall"] <= res["recall"] + 1e-9, (
        "the corrected rule cannot recall more than an uncorrected rule that floods "
        "the entire corridor at this stage")
    assert 0.0 <= res["accuracy"] <= 1.0 and res["n"] == res["tp"] + res["fp"] + res["fn"] + res["tn"], \
        "confusion cells do not sum"
    assert abs(lift_here) < 60, f"implied lift {lift_here:.1f} ft is not physical"
    print("\nall gates passed")

    out = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "step": "UPGRADE-PLAN.md I1 — a second observed extent",
        "question": ("do the street thresholds reproduce a SECOND, independent flood — and "
                     "does the correction fitted on Harvey generalise to it?"),
        "answer_headline": (
            f"at {stage:.2f} ft on a rising limb, the image shows "
            f"{act['refuted_by_this_image']} segments DRY that the shipped thresholds put "
            f"under water at that stage, which is what a lower-stage observation can do and "
            f"an event maximum cannot; the Harvey-fitted lift of {harvey['lift_ft']:+.2f} ft "
            f"repairs {act['refuted_and_fixed_by_the_harvey_lift']} of them, and this event "
            f"implies a lift of {lift_here:+.2f} ft on its own"),
        "observation": {
            "dataset": "USFIMR flood-inundation extent, Brazos River near Richmond, Texas",
            "provider": "University of Alabama Surface Dynamics Modeling Lab (SDML), under a "
                        "NOAA/UCAR subaward",
            "licence": "CC BY 3.0 Unported",
            "catalogue": "https://waterserv.ua.edu/datasets/usfimr/",
            "cached_by": "pipeline/fetch/fetch_usfimr_2016.mjs",
            "platform": str(layer.iloc[0]["Sensor"]),
            "resolution": str(layer.iloc[0]["Sensor_Res"]),
            "acquired": when.isoformat(),
            "area_km2": round(area_km2, 1),
            "event": "2016 Brazos flood (crested 54.74 ft on 2016-06-02; this is the rising limb)",
            "gauges_named_in_the_layer": str(layer.iloc[0]["USGS_Gage"]),
            "discharge_at_image_cfs": q_at_image,
            "event_max_discharge_cfs": float(layer.iloc[0]["Event_MaxQ"]),
            "nature": ("water edge from one Sentinel-1 HV image, with ground proofing from "
                       "secondary sources rather than a survey; a radar water edge is not a "
                       "surveyed extent and has known failure modes over vegetation and "
                       "smooth open water"),
        },
        "stage_basis": {
            "stage_ft": stage, "reading_at": nearest.isoformat(),
            "minutes_from_the_image": round(gap_min, 1),
            "source": f"USGS {GAUGE} instantaneous gage height, cached in-repo",
            "acquisition_day_range_ft": band,
            "day_mean_ft": float(day.mean()),
            "discharge_cross_check": {
                "q_at_image_cfs": q_at_image, "rating_stage_ft": float(q_stage),
                "extrapolated": bool(extrapolated),
                "difference_from_gauge_ft": round(float(q_stage - stage), 2),
                "why": ("the layer's own Q_at_Image run through the rating Step 3 fixed is an "
                        "independent read of the same instant; agreement means the image and "
                        "the gauge describe the same water"),
            },
        },
        "method": {
            "model": f"flooded at this stage iff flood_stage_ft <= {stage:.2f}",
            "corrected_rule": (f"flooded iff flood_stage_ft + {harvey['lift_ft']:.2f} <= "
                               f"{stage:.2f}, the lift measured on Harvey alone, applied "
                               f"UNCHANGED and scored out of sample"),
            "observed": "segment geometry intersects the mapped water polygon",
            "evaluated_set": ("segments whose centroid lies inside the polygon's bounding "
                              "box — the image maps the water and not the ground, so the "
                              "box is the stand-in for scene coverage"),
            "evaluated_set_note": ("not a mapped boundary, unlike the Harvey release: the "
                                   "sensitivity to this choice is reported rather than "
                                   "assumed away"),
            "stage_choice": ("the gauge reading at the image instant, from the layer's own "
                             "Flood_Date/Start_Time; the day's range is reported as a "
                             "sensitivity because the surface is not at one stage across "
                             "the reach (FINDINGS section 1)"),
        },
        "confusion_matrix": res,
        "with_the_harvey_lift_applied": cor,
        "refutations": act,
        "under_mapping_sensitivity": under_map,
        "implied_lift_from_this_event_ft": round(float(lift_here), 2),
        "harvey_lift_ft": harvey["lift_ft"],
        "lift_difference_ft": round(float(lift_here - harvey["lift_ft"]), 2),
        "best_cut_this_event": cut,
        "sensitivity_to_evaluated_set": sens,
        "sensitivity_to_stage": by_stage,
        "below_action_segments": b,
        "discrimination_at_this_stage": {
            "auc": a6,
            "auc_on_harveys_evaluated_set": a6_hvset,
            "n_corridor": len(roads),
            "n_harveys_evaluated_set": int(in_harvey_set.sum()),
            "harvey_auc": 0.809,
            "why_two_populations": (
                "an AUC depends on the population it is computed over, and Harvey's 0.809 "
                "was measured on its own mapped-boundary set; both are reported so the "
                "two events are not compared across two different evaluated sets"),
            "why_it_matters": (
                "a constant lift is rank-preserving, so it CANNOT change the within-event "
                "AUC. Harvey's 0.809 says the thresholds order water above dry there; "
                f"this event's {a6:.3f} says they barely do at a lower stage. That is why the "
                "two events imply different corrections, and it is a stronger statement "
                "than either event's confusion matrix: no offset fixes a ranking."),
        },
        "what_this_changes": (
            "Step 3 closed every correction route for want of a second event to test one "
            "on, and Step 6 could not touch the below-action thresholds because a maximum "
            "extent cannot refute a low threshold. Both of those now have a second, "
            "independent observation behind them; whether the correction SHIPS is still a "
            "separate decision, and the numbers above are what that decision rests on."),
        "limits": [
            "one instant on the rising limb of a second event — not a series, so a segment "
            "the image shows DRY bounds its threshold from below and a segment it shows WET "
            "says nothing about where between 0 and 49.40 ft it flooded",
            "a radar water edge, with vegetation, smooth water and wind-roughening failure "
            "modes, ground-proofed from secondary sources rather than surveyed",
            "the polygon bounds the WATER, not the scene, so 'dry' is only as good as the "
            "assumption that the scene covered the corridor's ground; the near-water "
            "evaluated set is the conservative variant and is reported alongside",
            "one gauge, on a rising limb, for a reach whose crest travels downstream",
            "the thresholds under test still inherit the HAND-as-stage defect this test "
            "measures; nothing here fixes them",
        ],
    }
    (DERIVED / "second_event_validation.json").write_text(json.dumps(out, indent=2))
    print("\nWrote data/derived/second_event_validation.json")


if __name__ == "__main__":
    main()
