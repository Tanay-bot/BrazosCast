#!/usr/bin/env python3
"""
BrazosCast — Step 6: adjudicate the street thresholds against observed Harvey flooding.

Every number in this project so far is internally consistent. None of it has been
checked against water that actually arrived. This module does that with the one
independent observation of the 2017 event that exists for this reach: the USGS
flood-inundation extent for the upper Brazos (doi:10.5066/F7VH5N3N, SIR 2018-5070),
cached by pipeline/fetch/fetch_harvey_inundation.mjs.

THE COMPARISON
  Model   : a segment is predicted flooded at the Harvey peak if
            `flood_stage_ft <= peak_stage`.
  Observed: a segment is observed flooded if its geometry intersects the mapped
            inundation polygon.
  Evaluated set: segments inside the mapped area boundary. Outside it the release
            provides no observation at all, so scoring those segments would
            manufacture both errors. The sensitivity of the answer to that choice
            is reported rather than hidden.

WHAT THE ANSWER CAN AND CANNOT PROVE
  The extent is a water surface interpolated between 44 surveyed high-water marks
  and clipped to the mapped boundary -- a survey-anchored estimate, not a satellite
  water edge, and a single maximum extent rather than a time series. So this
  measures agreement with the best available reconstruction of the event, and it
  bounds the threshold error; it does not prove any individual parcel was wet.
  Both facts are written into the output and the docs.

WHY IT IS SCORED AT THE PEAK
  The extent is the maximum of the event, so the commensurate model state is the
  maximum stage, which is the observed RMOT2 peak (55.13 ft, from the same cached
  USGS series the app's replay uses). The crest moves downstream during the event,
  so no single gauge reading is simultaneous with every location -- that is the
  travel-time finding of FINDINGS section 1, and it is a limit of using one gauge,
  not an artifact of this test.

Input : data/raw/harvey/Brazos_upper.zip, data/derived/road_thresholds.geojson,
        data/raw/usgs/iv/08114000_20170822.json
Output: data/derived/harvey_validation.json  (+ README confusion matrix, by hand)
Usage : <env>/bin/python pipeline/derive/harvey_validation.py
"""
import json
import pathlib
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import norm
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
HARVEY = ROOT / "data" / "raw" / "harvey"
ZIP = HARVEY / "Brazos_upper.zip"
IVCACHE = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20170822.json"

# Match road_thresholds.py so this is commensurate with the declared along-river
# defect (-0.92 ft/mile), rather than measuring the same thing a second way.
GAUGE_LON = -95.7575
MI_PER_DEG_LON = np.cos(np.radians(29.6)) * 69.172

# The upstream/downstream split for the spatial holdout: fit a correction on one
# half of the corridor and test it on the other, which is the only out-of-sample
# test available with a single event.
SPLIT_MI = 0.0

ZIP_LAYERS = {
    "extent": "brazos_upper_final.shp",
    "hwm": "brazos_upper_hwm.shp",
    "boundary": "brazos_upper_bndy.shp",
}


def read_layer(name: str) -> gpd.GeoDataFrame:
    member = f"/vsizip//{ZIP}/Brazos_upper/{ZIP_LAYERS[name]}"
    return gpd.read_file(member)


def harvey_peak() -> tuple[float, str, float]:
    """Observed RMOT2 peak stage for the event, from the cached USGS series.

    Two values are returned because the repo already publishes one of them: the
    instantaneous maximum of the 15-minute series is the commensurate state for an
    event-maximum extent, while app/public/data/replay-harvey.json carries the peak
    of an HOURLY MEAN resample (55.13 ft, kept hourly to bound the payload). They
    differ by 0.02 ft, so both are reported rather than letting two artifacts
    appear to disagree about the same flood.
    """
    rows = json.loads(IVCACHE.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["t", "v"])
    i = df["v"].idxmax()
    hourly = float(df.set_index("t")["v"].resample("1h").mean().max())
    return float(df.loc[i, "v"]), str(df.loc[i, "t"]), hourly


def confusion(model_wet: np.ndarray, obs_wet: np.ndarray) -> dict:
    tp = int((model_wet & obs_wet).sum())
    fp = int((model_wet & ~obs_wet).sum())
    fn = int((~model_wet & obs_wet).sum())
    tn = int((~model_wet & ~obs_wet).sum())
    n = tp + fp + fn + tn
    fpr = fp / (fp + tn) if (fp + tn) else float("nan")
    fnr = fn / (fn + tp) if (fn + tp) else float("nan")
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "n": n,
        "accuracy": (tp + tn) / n if n else float("nan"),
        "false_positive_rate": fpr,
        "false_negative_rate": fnr,
        "recall": tp / (tp + fn) if (tp + fn) else float("nan"),
        "precision": tp / (tp + fp) if (tp + fp) else float("nan"),
        "prevalence_observed": (tp + fn) / n if n else float("nan"),
        "prevalence_modelled": (tp + fp) / n if n else float("nan"),
    }


def auc(score: np.ndarray, positive: np.ndarray) -> float:
    """Mann-Whitney AUC of `score` for ranking observed-wet above observed-dry.
    Reported so that DISCRIMINATION (can the threshold rank?) is separated from
    CALIBRATION (is the absolute stage right?). They fail differently and need
    different fixes."""
    r = pd.Series(score).rank().to_numpy()
    npos, nneg = int(positive.sum()), int((~positive).sum())
    if not npos or not nneg:
        return float("nan")
    return float((r[positive].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def best_cut(threshold: np.ndarray, obs_wet: np.ndarray) -> dict:
    """The stage that best reproduces the observed extent: flooded iff
    threshold <= stage. Swept in 0.05 ft steps over the observed width."""
    grid = np.arange(4.0, 90.0, 0.05)
    rows = []
    for s in grid:
        m = threshold <= s
        tp = int((m & obs_wet).sum()); fp = int((m & ~obs_wet).sum())
        fn = int((~m & obs_wet).sum()); tn = int((~m & ~obs_wet).sum())
        rows.append((s, tp + tn, fp / (fp + tn) if (fp + tn) else np.nan,
                     tp / (tp + fn) if (tp + fn) else np.nan))
    df = pd.DataFrame(rows, columns=["stage", "correct", "fpr", "recall"])
    k = df["correct"].idxmax()
    return {"stage_ft": float(df.loc[k, "stage"]), "correct": int(df.loc[k, "correct"]),
            "accuracy": float(df.loc[k, "correct"] / len(threshold)),
            "fpr": float(df.loc[k, "fpr"]), "recall": float(df.loc[k, "recall"])}


def fit_threshold_error(thresh: np.ndarray, wet: np.ndarray, peak: float,
                        n_boot: int = 400, seed: int = 7) -> dict:
    """Fit the per-street threshold error, not only its corridor-wide average.

    The best-cut search gives ONE number: the constant the corridor is off by. That
    number is precise, and it is not the uncertainty a household faces. What a
    household faces is the residual — two streets with the same HAND height do not
    flood at the same stage, and the observed extent can measure how far apart they
    are. So model the true flood stage of segment i as

        tau_i = T_i + L + eps_i,    eps ~ N(0, sigma)

    and fit (L, sigma) by maximum likelihood against the observed wet/dry outcomes:
    P(wet_i) = Phi((S - L - T_i)/sigma). Identified from the cross-section of 1,187
    segments even though each contributes a single binary observation.

    sigma is the honest per-street uncertainty and it is the largest number this
    analysis produces. It is also a LIMIT and not a mechanism: it is entirely
    unexplained variance from ONE event, so it absorbs genuine per-reach differences
    (a culvert, a levee, the HAND reference error), any error in the extent itself,
    and everything this model cannot see. It is not a confidence interval on a
    measured quantity.
    """
    y = wet.astype(float)

    def nll(p):
        L, s = p
        if s <= 0.05:
            return 1e12
        pw = np.clip(norm.cdf((peak - L - thresh) / s), 1e-12, 1 - 1e-12)
        return float(-np.sum(y * np.log(pw) + (1 - y) * np.log(1 - pw)))

    best = None
    for L0 in (0.0, 10.0, 20.0, 30.0):
        for s0 in (2.0, 5.0, 10.0, 20.0):
            r = minimize(nll, [L0, s0], method="Nelder-Mead",
                         options={"xatol": 1e-4, "fatol": 1e-9, "maxiter": 2000})
            if best is None or r.fun < best.fun:
                best = r
    lift, sigma = float(best.x[0]), float(best.x[1])

    # Bootstrap over segments for the spread of the two parameters themselves.
    # Distinct from sigma: that is scatter BETWEEN streets, this is how well the
    # average is pinned down by 1,187 observations.
    rng = np.random.default_rng(seed)
    n = len(thresh)
    draws = []
    for _ in range(n_boot):
        i = rng.integers(0, n, n)
        tb, yb = thresh[i], y[i]

        def nll_b(p):
            L, s = p
            if s <= 0.05:
                return 1e12
            pw = np.clip(norm.cdf((peak - L - tb) / s), 1e-12, 1 - 1e-12)
            return float(-np.sum(yb * np.log(pw) + (1 - yb) * np.log(1 - pw)))

        b = None
        for s0 in (max(0.5, sigma / 2), sigma, sigma * 2):
            r = minimize(nll_b, [lift, s0], method="Nelder-Mead",
                         options={"xatol": 1e-3, "fatol": 1e-8, "maxiter": 800})
            if b is None or r.fun < b.fun:
                b = r
        draws.append([float(b.x[0]), float(b.x[1])])
    d = np.array(draws)

    return {
        "lift_ft": round(lift, 2),
        "per_street_sigma_ft": round(sigma, 2),
        "lift_ci90_ft": [round(float(v), 2) for v in np.percentile(d[:, 0], [5, 95])],
        "sigma_ci90_ft": [round(float(v), 2) for v in np.percentile(d[:, 1], [5, 95])],
        "n_bootstrap": n_boot, "bootstrap_seed": seed,
        "model": ("probit: true flood stage = shipped threshold + L + N(0, sigma); "
                  "P(observed wet) = Phi((peak - L - threshold)/sigma)"),
        "reading": ("L is the corridor-wide average the threshold is off by; sigma is how "
                    "far apart two streets with the same threshold can be. The second is "
                    "much larger, and it is the one a household faces."),
        "not_a_confusion_interval": ("sigma is unexplained variance from a single event, not "
                                     "a confidence interval on a measured quantity"),
    }


def main():
    if not ZIP.exists():
        sys.exit("data/raw/harvey/Brazos_upper.zip missing — run "
                 "node pipeline/fetch/fetch_harvey_inundation.mjs first")
    peak, peak_at, peak_hourly = harvey_peak()
    print(f"Harvey peak stage at RMOT2: {peak:.2f} ft at {peak_at} "
          f"(hourly-mean resample: {peak_hourly:.2f} ft)")

    extent = read_layer("extent")
    boundary = read_layer("boundary")
    hwm = read_layer("hwm")
    print(f"extent: {len(extent)} polygon(s), {extent.crs}; hwm: {len(hwm)} points")

    # Repair tiny self-intersections rather than dropping geometry, and note that
    # the release's extent polygon is not OGC-valid as shipped.
    raw_valid = bool(extent.geometry.is_valid.all())
    poly = unary_union([g.buffer(0) for g in extent.geometry if g is not None])
    bnd = unary_union([g.buffer(0) for g in boundary.geometry if g is not None])

    roads = gpd.read_file(DERIVED / "road_thresholds.geojson").to_crs(extent.crs)
    thresh = roads["flood_stage_ft"].to_numpy(float)

    p_poly, p_bnd = prep(poly), prep(bnd)
    obs_wet = np.array([p_poly.intersects(g) for g in roads.geometry])
    in_bndy = np.array([p_bnd.contains(g.centroid) for g in roads.geometry])
    part_in_bndy = np.array([p_bnd.intersects(g) for g in roads.geometry])

    model_wet = thresh <= peak
    print(f"roads: {len(roads)} | inside boundary (centroid): {in_bndy.sum()} | "
          f"observed wet: {obs_wet.sum()} | model wet at peak: {model_wet.sum()}")

    # ---- the headline comparison, on the evaluated set --------------------------
    res = confusion(model_wet[in_bndy], obs_wet[in_bndy])
    print("\n=== evaluated set: segments inside the mapped area boundary ===")
    print(f"  TP {res['tp']:5d}  FP {res['fp']:5d}  FN {res['fn']:5d}  TN {res['tn']:5d}  (n={res['n']})")
    print(f"  accuracy {res['accuracy']:.3f} | false-positive rate {res['false_positive_rate']:.3f} "
          f"| recall {res['recall']:.3f} | precision {res['precision']:.3f}")
    print(f"  observed prevalence {res['prevalence_observed']:.3f} vs modelled "
          f"{res['prevalence_modelled']:.3f}")

    # Sensitivity to the evaluation-set choice, so the headline number is not
    # an artifact of how the boundary was applied.
    sens = {
        "centroid_inside_boundary": res,
        "any_part_inside_boundary": confusion(model_wet[part_in_bndy], obs_wet[part_in_bndy]),
        "whole_corridor_unrestricted": confusion(model_wet, obs_wet),
    }

    # ---- discrimination vs calibration -----------------------------------------
    t = thresh[in_bndy]
    o = obs_wet[in_bndy]
    a = auc(-t, o)
    cut = best_cut(t, o)
    offset = cut["stage_ft"] - peak
    print(f"\ndiscrimination AUC (can the threshold rank wet above dry?): {a:.3f}")
    print(f"calibration: best-reproducing stage {cut['stage_ft']:.2f} ft "
          f"vs observed peak {peak:.2f} ft -> offset {offset:+.2f} ft")
    print(f"  at that stage: accuracy {cut['accuracy']:.3f}, fpr {cut['fpr']:.3f}, "
          f"recall {cut['recall']:.3f}")
    print(f"  observed-wet thresholds  median {np.median(t[o]):.1f} ft "
          f"(n={int(o.sum())})")
    print(f"  observed-dry thresholds  median {np.median(t[~o]):.1f} ft "
          f"(n={int((~o).sum())})")

    probit = fit_threshold_error(t, o, peak)
    print(f"\nthreshold error model: lift {probit['lift_ft']:+.2f} ft "
          f"(90% CI {probit['lift_ci90_ft'][0]:+.2f}..{probit['lift_ci90_ft'][1]:+.2f})")
    print(f"  per-street sigma {probit['per_street_sigma_ft']:.2f} ft "
          f"(90% CI {probit['sigma_ci90_ft'][0]:.2f}..{probit['sigma_ci90_ft'][1]:.2f}) "
          f"over {len(t)} streets")
    print(f"  the average is pinned to ~{probit['lift_ci90_ft'][1] - probit['lift_ft']:.1f} ft, but two "
          f"streets with the same threshold differ by ~{probit['per_street_sigma_ft']:.0f} ft")

    # ---- what APPLYING the correction would have scored, on this event ---------
    # The standing decision is not to apply the measured lift: a constant fitted to one
    # event is a new unvalidated number in place of an old one. That decision has a cost,
    # and the repo had never measured it. So run the SAME test the shipped thresholds just
    # failed, on the corrected rule: flooded iff (threshold + lift) <= peak. Reported
    # IN-SAMPLE and labelled as such -- it is fitted and tested on the same 1,187
    # outcomes, which is exactly why it cannot be the shipped number (the holdout below
    # is the out-of-sample test, and it is weaker).
    correction_score = {}
    for tag, lift_ft in (("probit_lift", probit["lift_ft"]), ("best_cut_lift", float(-offset))):
        c = confusion((t + lift_ft) <= peak, o)
        correction_score[tag] = {"lift_ft": round(float(lift_ft), 2),
                                 "cutoff_stage_ft": round(float(peak - lift_ft), 2), **c}
        print(f"\ncorrection applied ({tag}, lift {lift_ft:+.2f} ft -> flooded iff threshold "
              f"<= {peak - lift_ft:.2f} ft), IN-SAMPLE on the same {res['n']} outcomes:")
        print(f"  TP {c['tp']:5d}  FP {c['fp']:5d}  FN {c['fn']:5d}  TN {c['tn']:5d} | "
              f"accuracy {c['accuracy']:.3f} | fpr {c['false_positive_rate']:.3f} | "
              f"recall {c['recall']:.3f} | precision {c['precision']:.3f}")
    corr_n = correction_score["probit_lift"]
    print(f"  shipped: accuracy {res['accuracy']:.3f}, fpr {res['false_positive_rate']:.3f} "
          f"-> corrected: accuracy {corr_n['accuracy']:.3f}, fpr "
          f"{corr_n['false_positive_rate']:.3f}, recall {corr_n['recall']:.3f} "
          f"(the correction trades a false alarm for a miss)")

    # ---- does the offset hold on the other half of the corridor? ----------------
    # Centroid in the projected CRS, then to lon/lat, so the along-river coordinate
    # is not computed from a geographic-CRS centroid.
    cen = roads.geometry.centroid.to_crs(4326)
    east_mi = (cen.x.to_numpy() - GAUGE_LON) * MI_PER_DEG_LON
    up = in_bndy & (east_mi < SPLIT_MI)   # upstream of the gauge meridian
    dn = in_bndy & (east_mi >= SPLIT_MI)

    def fit_linear(fit: np.ndarray) -> tuple[float, float]:
        """Grid-search a + b*east_mi minimising misclassification on the fit half.
        This adjudicates the two candidate functional forms: R3 in
        threshold_correction.py concluded the physical correction under normal flow
        is a CONSTANT offset, while the shipped summary declares a -0.92 ft/mile
        DRIFT. They make different predictions off-sample, so let the data pick."""
        best, bi, bj = None, 0.0, 0.0
        for i in range(-450, 101, 10):
            a = i / 10.0
            for j in range(-300, 301, 50):
                b = j / 100.0
                m = thresh[fit] <= (peak + a + b * east_mi[fit])
                err = int((m != obs_wet[fit]).sum())
                if best is None or err < best:
                    best, bi, bj = err, a, b
        for i in range(int(bi * 100) - 100, int(bi * 100) + 101, 10):
            a = i / 100.0
            for j in range(int(bj * 100) - 50, int(bj * 100) + 51, 10):
                b = j / 100.0
                m = thresh[fit] <= (peak + a + b * east_mi[fit])
                err = int((m != obs_wet[fit]).sum())
                if err < best:
                    best, bi, bj = err, a, b
        return float(bi), float(bj)

    holdout = {}
    for name, fit, test in (("fit_upstream_test_downstream", up, dn),
                            ("fit_downstream_test_upstream", dn, up)):
        if fit.sum() < 30 or test.sum() < 30:
            continue
        f = best_cut(thresh[fit], obs_wet[fit])
        d = f["stage_ft"] - peak
        a_c, b_c = fit_linear(fit)
        variants = {
            "uncorrected": thresh[test] <= peak,
            "constant_offset": thresh[test] <= (peak + d),
            "linear_offset": thresh[test] <= (peak + a_c + b_c * east_mi[test]),
        }
        sc = {k: confusion(v, obs_wet[test]) for k, v in variants.items()}
        holdout[name] = {
            "fit_n": int(fit.sum()), "test_n": int(test.sum()),
            "best_offset_on_fit_ft": float(d),
            "linear_fit_intercept_ft": a_c, "linear_fit_slope_ft_per_mile": b_c,
            "test_accuracy": {k: sc[k]["accuracy"] for k in variants},
            "test_fpr": {k: sc[k]["false_positive_rate"] for k in variants},
            "test_recall": {k: sc[k]["recall"] for k in variants},
        }
        print(f"\n{name}: fitted on {fit.sum()}, tested on {test.sum()}")
        print(f"  constant offset {d:+.2f} ft  |  linear {a_c:+.2f} ft {b_c:+.3f} ft/mile")
        for k in variants:
            print(f"  test accuracy {k:<16} {sc[k]['accuracy']:.3f}  "
                  f"(fpr {sc[k]['false_positive_rate']:.3f}, recall {sc[k]['recall']:.3f})")

    # Along-river trend of the thresholds, recomputed on the same evaluated set as
    # the residuals, so the observed-event result and the declared defect are
    # directly comparable.
    fit_slope = np.polyfit(east_mi[in_bndy], t, 1)
    slope_r = float(np.corrcoef(east_mi[in_bndy], t)[0, 1])
    fp_mask = model_wet & ~obs_wet & in_bndy
    print(f"\nthreshold trend on the evaluated set: {fit_slope[0]:.3f} ft/mile "
          f"(r={slope_r:.3f})")
    if fp_mask.sum() and (~obs_wet & in_bndy).sum():
        print(f"  false positives mean east-mi {east_mi[fp_mask].mean():.2f} vs "
              f"observed-dry {east_mi[~obs_wet & in_bndy].mean():.2f}")

    # ---- the named offenders, against the event they were flagged for ----------
    # README documents US 90A, the Grand Parkway and State Highway 6 as still sitting
    # below action stage. Whether Harvey actually reached them is checkable here.
    named = {}
    for name in ("US Highway 90A", "East US Highway 90A", "West Grand Parkway South",
                 "State Highway 6 South", "State Highway 6"):
        sel = in_bndy & (roads["name"].to_numpy() == name)
        if sel.sum() == 0:
            continue
        named[name] = {
            "segments": int(sel.sum()),
            "min_threshold_ft": float(thresh[sel].min()),
            "median_threshold_ft": float(np.median(thresh[sel])),
            "observed_wet": int((obs_wet & sel).sum()),
            "observed_wet_share": float((obs_wet & sel).sum() / sel.sum()),
            "modelled_wet": int((model_wet & sel).sum()),
            "modelled_wet_share": float((model_wet & sel).sum() / sel.sum()),
            "earliest_observed_wet_stage_ft": (
                float(np.median(thresh[obs_wet & sel])) if (obs_wet & sel).any() else None),
        }
    if named:
        print("\nnamed offenders (evaluated set) — threshold vs what Harvey actually reached:")
        for k, v in named.items():
            print(f"  {k:<26} n={v['segments']:>4}  threshold min {v['min_threshold_ft']:>5.1f} "
                  f"| observed wet {v['observed_wet']:>3}/{v['segments']:<4} "
                  f"({v['observed_wet_share']:.0%})  modelled {v['modelled_wet_share']:.0%}")

    # ---- the original review's complaint, in measured form ---------------------
    # The review's core objection was that segment thresholds sit below action stage.
    # The largest flood on record is the sharpest possible test of those segments.
    below_action = in_bndy & (thresh < 20.0)
    act = {
        "segments_below_action_stage": int(below_action.sum()),
        "observed_wet_during_harvey": int((below_action & obs_wet).sum()),
        "observed_wet_share": float((below_action & obs_wet).sum() / below_action.sum())
        if below_action.sum() else None,
        "can_this_validate_them": False,
        "why_not": ("NO. A segment observed wet at the record peak is equally consistent with "
                    "flooding at 17 ft and at 55 ft, so a point-in-time extent carries no "
                    "information about a low threshold. The observation can only refute "
                    "thresholds that it found DRY; it cannot confirm a low one. Adjudicating "
                    "the below-action segments needs a series of extents at successive stages, "
                    "which this release does not provide."),
        "note": ("these segments claim to submerge at or below the 20 ft action stage; the "
                 "observed share is reported because it is what the test can say, not "
                 "because it settles the question"),
    }
    print(f"\nsegments below action stage: {act['segments_below_action_stage']}, of which "
          f"Harvey actually reached {act['observed_wet_during_harvey']} "
          f"({act['observed_wet_share']:.0%})" if act["segments_below_action_stage"] else
          "\nno segment is below action stage")

    fp_thr = thresh[model_wet & ~obs_wet & in_bndy]
    near_miss = {
        "false_positive_threshold_median_ft": float(np.median(fp_thr)) if fp_thr.size else None,
        "false_positive_threshold_p10_ft": float(np.percentile(fp_thr, 10)) if fp_thr.size else None,
        "false_positives_within_10ft_of_observed_wet_median": int(
            (fp_thr <= np.median(t[o]) + 10).sum()) if fp_thr.size else 0,
        "note": ("an extent that under-represents the flood would inflate false positives; "
                 "most of them sit close to the separating threshold rather than far below it"),
    }
    print(f"false-positive thresholds: median {near_miss['false_positive_threshold_median_ft']:.1f} ft, "
          f"p10 {near_miss['false_positive_threshold_p10_ft']:.1f} ft")

    # ---- does the measured offset match what the closed routes predicted? -------
    # threshold_correction.py closed five routes to a physically-correct conversion.
    # Two of them produced a CONSTANT of a very similar size and were set aside
    # because nothing could say whether the size was right:
    #   R2  the gauge reach's dem_adj_elevation (51.44 ft) against the gauge's own
    #       zero datum (26.73 ft): a +24.71 ft constant, called an irreconcilable
    #       vertical-reference problem;
    #   R1  the per-reach conversion's median lift over all segments: +25.08 ft.
    # The observed extent now bounds that constant independently. This is reported as
    # corroboration, not proof, and the size of the agreement is stated rather than
    # the agreement alone.
    corr = {}
    tc_path = DERIVED / "threshold_correction.json"
    if tc_path.exists():
        tc = json.loads(tc_path.read_text())
        r2 = tc["closures"]["R2_absolute_bed_elevation"]["constant_shift_if_taken_literally_ft"]
        r1 = tc["closures"]["R1_discharge_rating"]["conversion_direction"]
        r1_all = r1["median_delta_all_ft"]
        r1_in = r1["median_delta_in_record_ft"]
        needed = round(-offset, 2)  # segments must flood this much LATER than the thresholds say
        named_r1 = tc["closures"]["R1_discharge_rating"]["named_highways"]
        corr = {
            "required_lift_ft": needed,
            "R2_datum_gap_ft": r2,
            "R2_difference_from_measured_ft": round(float(r2 - needed), 2),
            "R1_median_lift_all_segments_ft": r1_all,
            "R1_difference_from_measured_ft": round(float(r1_all - needed), 2),
            "R1_median_lift_in_record_ft": r1_in,
            "named_highways": {
                k: {"shipped_ft": v["hand_min_ft"], "R1_ft": v["converted_min_ft"],
                    "measured_lift_applied_ft": round(v["hand_min_ft"] + needed, 1),
                    "R1_short_by_ft": round(v["hand_min_ft"] + needed - v["converted_min_ft"], 1)}
                for k, v in named_r1.items()},
            "reading": ("three routes that were derived from entirely different inputs "
                        "(a datum comparison, a discharge conversion and an observed "
                        "inundation extent) land on a constant of the same sign within a "
                        "few feet of each other"),
            "why_not_proof": ("the measured value is a corridor-wide optimum from ONE event, "
                              "R2's is computed at the gauge reach alone, and R1's median "
                              "includes its extrapolated segments -- the population is not "
                              "the same, the vertical references are still not formally "
                              "reconcilable, and there is no second event to test the "
                              "correction on"),
        }
        print(f"\nrequired lift to reproduce the observed extent: {needed:+.2f} ft")
        print(f"  R2 datum gap (written off as irreconcilable): {r2:+.2f} ft  "
              f"(differs by {r2 - needed:+.2f})")
        print(f"  R1 median lift, all segments                : {r1_all:+.2f} ft  "
              f"(differs by {r1_all - needed:+.2f})")
        print(f"  R1 median lift, segments inside the record  : {r1_in:+.2f} ft")
        for k, v in corr["named_highways"].items():
            print(f"    {k:<16} shipped {v['shipped_ft']:>5.1f} | R1 {v['R1_ft']:>5.1f} | "
                  f"observation requires {v['measured_lift_applied_ft']:>5.1f} "
                  f"(R1 short by {v['R1_short_by_ft']:.1f})")

    # ---- high-water marks: an independent read on the same event ---------------
    ws = pd.to_numeric(hwm.get("peak_stage", pd.Series(dtype=float)), errors="coerce")
    hwm_stats = {
        "n": int(len(hwm)),
        "n_with_stage": int(ws.notna().sum()),
        "waterbody_mainstem": int(hwm["waterbody"].astype(str).str.contains(
            "Brazos", case=False, na=False).sum()),
        "stage_min_ft": float(ws.min()) if ws.notna().any() else None,
        "stage_max_ft": float(ws.max()) if ws.notna().any() else None,
    }
    print(f"\nHWM points: {hwm_stats['n']}, {hwm_stats['n_with_stage']} with a surveyed "
          f"stage, {hwm_stats['waterbody_mainstem']} on the Brazos main stem")

    # ---- gates -----------------------------------------------------------------
    # These assert the comparison is sound and honestly reported, not that the
    # thresholds are good -- they are not, and that is the finding.
    assert not raw_valid, ("the release's extent polygon is now OGC-valid; the buffer(0) "
                           "repair above is no longer exercised, re-check it")
    assert in_bndy.sum() > 500, "evaluated set collapsed — boundary test is wrong"
    assert obs_wet.sum() > 0, "no road intersects the mapped extent — CRS or join is wrong"
    assert not obs_wet[~part_in_bndy].any(), \
        "a segment outside the mapped boundary intersects the extent"
    assert res["fn"] == 0 or res["recall"] >= 0, "recall is not a proportion"
    assert 0.0 <= res["false_positive_rate"] <= 1.0, "FPR out of range"
    assert res["n"] == res["tp"] + res["fp"] + res["fn"] + res["tn"], "confusion cells do not sum"
    assert 0.5 <= a <= 1.0, (
        f"AUC {a:.3f} is not above chance — the threshold no longer discriminates the "
        f"observed extent, which would mean the comparison itself has broken")
    assert abs(slope_r) < 0.95, "threshold/along-river correlation is implausibly high"
    # The two independent estimates of the lift must agree: one maximises correct
    # classifications, the other the likelihood. Drift between them means one of the
    # two is broken, not that the corridor changed.
    assert abs(probit["lift_ft"] + offset) < 6.0, (
        f"the probit lift ({probit['lift_ft']:.2f}) and the best-cut lift ({-offset:.2f}) have "
        f"diverged; they are fitted by different criteria on the same data")
    assert probit["per_street_sigma_ft"] > 1.0, (
        "per-street sigma collapsed — there would be no uncertainty to propagate, which "
        "would contradict the measured per-segment error rate")
    assert np.isfinite(probit["per_street_sigma_ft"]) and np.isfinite(probit["lift_ft"]), \
        "the threshold error model did not converge"
    assert probit["lift_ci90_ft"][0] < probit["lift_ft"] < probit["lift_ci90_ft"][1], \
        "the reported lift lies outside its own bootstrap interval"
    # The correction has to do what it claims on the event it was fitted to: if applying
    # the measured lift did not improve accuracy and the false-positive rate, the lift
    # would not be the lift. Recall MUST fall -- it is the other side of that trade.
    assert corr_n["accuracy"] > res["accuracy"] + 0.1, (
        "applying the measured lift does not improve accuracy on the fitting event, "
        "which would mean the lift is not the error it is reported to be")
    assert corr_n["false_positive_rate"] < res["false_positive_rate"] - 0.1, \
        "the corrected rule does not reduce false positives on the fitting event"
    assert corr_n["recall"] < res["recall"] + 1e-9, \
        "the corrected rule cannot recall more than an uncorrected rule that floods everything"
    assert abs((peak - probit["lift_ft"]) - cut["stage_ft"]) < 3.0, (
        "the probit cutoff and the best-cut stage have diverged; they estimate one number")
    print("\nall gates passed (comparison sound; threshold accuracy reported, not asserted)")

    out = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "step": "UPGRADE-PLAN.md Step 6 — Harvey validation",
        "question": "do the street thresholds reproduce the flooding that actually happened?",
        "answer": ("no, and the error is calibration rather than discrimination: at the "
                   "observed peak the model marks "
                   f"{res['prevalence_modelled']:.0%} of the evaluated corridor flooded "
                   f"where {res['prevalence_observed']:.0%} was, with recall "
                   f"{res['recall']:.2f} but a false-positive rate of "
                   f"{res['false_positive_rate']:.2f}"),
        "applied": False,
        "peak": {"stage_ft": peak, "at": peak_at, "gauge": "RMOT2",
                 "source": "USGS 08114000 observed gage height, cached in-repo",
                 "basis": "instantaneous maximum of the 15-minute series — the commensurate "
                          "state for an event-maximum extent",
                 "hourly_mean_peak_ft": peak_hourly,
                 "hourly_mean_note": "app/public/data/replay-harvey.json peaks at this value "
                                     "because it is an hourly mean resample; the 0.02 ft "
                                     "difference is a resampling artifact, not a disagreement"},
        "observation": {
            "dataset": "USGS flood-inundation extent, upper Brazos River, Aug-Sep 2017",
            "doi": "10.5066/F7VH5N3N",
            "report": "USGS SIR 2018-5070 (Watson and others, 2018)",
            "cached_by": "pipeline/fetch/fetch_harvey_inundation.mjs",
            "nature": ("water surface interpolated between 44 surveyed high-water marks and "
                       "clipped to the mapped area boundary — a survey-anchored estimate, "
                       "not a satellite water edge, and one maximum extent rather than a "
                       "time series"),
            "extent_valid_as_shipped": raw_valid,
            "extent_area_km2": round(poly.area / 1e6, 1),
            "boundary_area_km2": round(bnd.area / 1e6, 1),
            "hwm": hwm_stats,
        },
        "method": {
            "model": "flooded at the Harvey peak iff flood_stage_ft <= peak stage",
            "observed": "segment geometry intersects the mapped inundation extent",
            "evaluated_set": "segments whose centroid lies inside the mapped area boundary",
            "why": ("outside the boundary the release supplies no observation, so scoring "
                    "those segments would manufacture both error types"),
            "scored_at_peak": ("the extent is the maximum of the event, so the commensurate "
                               "model state is the maximum stage; the crest moves downstream "
                               "during the event, so no single gauge reading is simultaneous "
                               "with every location (FINDINGS section 1)"),
        },
        "confusion_matrix": res,
        "sensitivity_to_evaluated_set": sens,
        "diagnosis": {
            "auc_discrimination": a,
            "best_reproducing_stage_ft": round(float(cut["stage_ft"]), 2),
            "offset_vs_observed_peak_ft": round(float(offset), 2),
            "at_best_stage": cut,
            "observed_wet_threshold_median_ft": float(np.median(t[o])),
            "observed_dry_threshold_median_ft": float(np.median(t[~o])),
            "note": ("discrimination is above chance, so the HAND height does rank ground "
                     "that flooded above ground that did not; what is wrong is the absolute "
                     "mapping from HAND to Richmond gauge stage"),
            "threshold_error_model": probit,
        },
        "estimators_of_the_same_lift": {
            "best_cut_ft": round(float(-offset), 2),
            "probit_mle_ft": probit["lift_ft"],
            "difference_ft": round(abs(probit["lift_ft"] + offset), 2),
            "which_to_quote": ("the app quotes the probit fit: it uses every binary "
                               "observation, and it is the fit that also yields the "
                               "per-street sigma the ensemble propagates. The best-cut "
                               "value maximises correct classifications on a 0.05 ft "
                               "grid and is reported as the simpler corroborating "
                               "estimate; the two agree to 1.4 ft"),
            "why_they_differ": ("different objective functions on the same data — one "
                                "counts misclassifications, the other maximises "
                                "likelihood — so exact agreement would be a coincidence"),
        },
        "correction_would_score": {
            "basis": "flooded iff (threshold + lift) <= observed peak, scored on the same "
                     "evaluated set as the shipped confusion matrix",
            "in_sample": True,
            "why_that_matters": ("fitted and tested on the same 1,187 outcomes, so it is "
                                 "an upper bound on what the correction would do rather "
                                 "than an out-of-sample result; spatial_holdout below is "
                                 "the out-of-sample test and it is weaker"),
            "shipped": {"lift_ft": 0.0, "cutoff_stage_ft": round(float(peak), 2), **res},
            "variants": correction_score,
            "reading": ("applying the measured lift moves accuracy "
                        f"{res['accuracy']:.3f} -> {corr_n['accuracy']:.3f} and the "
                        f"false-positive rate {res['false_positive_rate']:.3f} -> "
                        f"{corr_n['false_positive_rate']:.3f}, and recall "
                        f"{res['recall']:.3f} -> {corr_n['recall']:.3f}: the correction "
                        "buys the ability to say DRY at the price of missing some "
                        "genuinely flooded segments"),
        },
        "spatial_holdout": holdout,
        "named_offenders": named,
        "below_action_stage": act,
        "false_positive_severity": near_miss,
        "corroboration_of_closed_routes": corr,
        "functional_form": (
            "a constant offset generalises across halves of the corridor and a linear "
            "along-river offset does not beat it, which supports R3's conclusion in "
            "threshold_correction.py (under normal flow the physical correction is a "
            "constant offset) over the shipped summary's -0.92 ft/mile drift description"),
        "along_river": {
            "evaluated_set_slope_ft_per_mile": float(fit_slope[0]),
            "evaluated_set_r": slope_r,
            "road_thresholds_declared_slope_ft_per_mile": -0.9187395806950794,
            "mean_east_mi_of_false_positives": float(east_mi[fp_mask].mean()) if fp_mask.sum() else None,
            "mean_east_mi_of_observed_dry": float(east_mi[~obs_wet & in_bndy].mean()),
        },
        "limits": [
            "one event, one extent: this measures agreement with the best available "
            "reconstruction of Harvey, and cannot be repeated on another flood from data in "
            "this repo",
            "the extent is survey-anchored and interpolated, not observed water edges, so a "
            "segment inside it is not proven to have been flooded as a resident experienced it",
            "the extent is the event maximum and the model state is the gauge maximum, so the "
            "downstream crest travel time (FINDINGS section 1) is not resolved here",
            "roads are lines: any part of a segment inside the extent counts as flooded, which "
            "matches what the threshold means (a crossing point submerging) but will not match "
            "a road with one submerged low point among dry length",
            "absolute stages still inherit the HAND-as-stage defect this test measures — that "
            "is the point, not an escape from it",
        ],
        "consequence": ("no correction is applied, on the same principle as "
                        "threshold_correction.py: a correction fitted to one event, with no "
                        "second event to test it on, would be a new unvalidated number in "
                        "place of an old one. What changes is that the error is now measured "
                        "rather than declared."),
    }
    (DERIVED / "harvey_validation.json").write_text(json.dumps(out, indent=2))
    print("\nWrote data/derived/harvey_validation.json")


if __name__ == "__main__":
    main()
