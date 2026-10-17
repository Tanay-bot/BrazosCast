#!/usr/bin/env python3
"""
BrazosCast — Step 7: what the app would have said during Harvey.

Everything in this repo is a forecast of a flood that has not happened yet, scored
against a single observed extent at one instant. The app's headline is a LEAD TIME —
"water reaches your street in 31 hours" — and no artifact so far has produced a lead
time for the one flood that actually occurred. This module does, by running the app's
own rule backwards over the observed gauge record.

THE QUESTION
  On 2017-08-22..09-01, at every hour, what would BrazosCast have told a household,
  and how much of that warning is it entitled to claim?

WHAT IS MEASURED, AND FROM WHAT
  * Tier onsets  — the hour the observed gauge crossed action / minor / moderate /
    major, and how long before the observed crest. Purely observed: the series is the
    USGS record the app's replay already uses, so nothing is modelled here.
  * Street lead time — for every segment, hours between the app's own alert (first
    observed hour at or above its threshold) and the crest. Also purely observed.
  * What the rule would flag — segments flagged as the river rises, at the shipped
    thresholds and at the measured-corrected ones (harvey_validation.json's probit
    lift). This is where the defect lands: at the action stage the shipped rule flags
    22 segments and the corrected rule flags none.

WHAT IT CANNOT MEASURE — the limit that shapes the whole artifact
  The only observation of street-level inundation in this repo is a SINGLE event-maximum
  extent. It cannot say WHEN water reached a street, so no per-street timing here is
  validated: the lead time below is time to the GAUGE CREST, which is an observation,
  and the street-level onset that precedes it is the model. The backcast is therefore
  an honest statement of what the product would have said, with the one adjudicable
  instant (the peak) taken from harvey_validation.json rather than recomputed. And the
  replay window ends two hours after the crest, so the recession is not observed at all:
  "clears" is not reported rather than extrapolated.

Input : data/raw/usgs/iv/08114000_20170822.json, data/derived/harvey_validation.json,
        data/derived/road_thresholds.geojson
Output: data/derived/harvey_backcast.json
Usage : <env>/bin/python pipeline/derive/backcast.py
"""
import json
import pathlib

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
IVCACHE = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20170822.json"
GEOJSON = DERIVED / "road_thresholds.geojson"

# The app's own category thresholds (app/src/main.ts TH). Kept in step by the grid.
TIERS = [("action", 20.0), ("minor", 45.0), ("moderate", 48.0), ("major", 50.0)]

# Stages the app must reproduce flag counts at. Spans below the corridor's minimum
# threshold through the crest, so the grid exercises both the empty and the full case.
GRID_STAGES = [10.0, 15.0, 20.0, 25.0, 30.0, 33.4, 35.0, 40.0, 45.0, 48.0, 50.0, 52.0, 55.0]


def replay_series() -> pd.Series:
    """The hourly Harvey series, built exactly as pipeline/export/app_data.py builds the
    replay payload, so the backcast is computed on the app's own series rather than a
    second resample of the same file."""
    rows = json.loads(IVCACHE.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["t", "v"]).drop_duplicates("t").sort_values("t")
    return df.set_index("t").resample("1h")["v"].mean().dropna()


def thresholds() -> np.ndarray:
    """Per-segment flood stages, read from the same GeoJSON the browser loads — so the
    flag counts here and the counts the app computes are over the identical population,
    not two files that happen to agree today."""
    gj = json.loads(GEOJSON.read_text())
    return np.array([f["properties"]["flood_stage_ft"] for f in gj["features"]], float)


def first_hour_at_or_above(v: np.ndarray, hours: np.ndarray, thr: float):
    idx = np.where(v >= thr)[0]
    return None if idx.size == 0 else float(hours[idx[0]])


def main():
    hv_path = DERIVED / "harvey_validation.json"
    if not hv_path.exists():
        raise SystemExit("run pipeline/derive/harvey_validation.py first")
    hv = json.loads(hv_path.read_text())
    tm = hv["diagnosis"]["threshold_error_model"]
    lift = float(tm["lift_ft"])
    peak_published = float(hv["peak"]["stage_ft"])
    print(f"measured lift {lift:+.2f} ft; published Harvey peak {peak_published:.2f} ft")

    s = replay_series()
    # Rounded to the 2 dp the app is SERVED, with Python's round — the same call
    # pipeline/export/app_data.py makes on every point it ships — because the per-segment array
    # below is read positionally by the browser and compared with its own recomputation. The
    # difference is not cosmetic: an hour reading 52.298 ft in the raw cache ships as 52.30, and
    # a street with a 52.3 ft threshold crosses there rather than an hour later. numpy's round
    # is NOT the same function at a tie (55.135 became 55.14 here and 55.13 in the payload), and
    # that one-off moved the crest, which moves every lead time at once. Both numbers were
    # self-consistent and only one could be shown.
    s = s.map(lambda x: round(float(x), 2))
    v = s.to_numpy(float)
    t = s.index
    hours = np.array((t - t[0]).total_seconds() / 3600.0, float)
    crest_i = int(np.argmax(v))
    crest_h, crest_ft = float(hours[crest_i]), float(v[crest_i])
    print(f"series: {len(s)} hourly points, {t[0]} -> {t[-1]} "
          f"(span {hours[-1]:.0f} h); crest {crest_ft:.2f} ft at {t[crest_i]} (+{crest_h:.0f} h)")

    # ---- tier onsets: the only part of this artifact that is pure observation ----
    tiers = []
    for name, thr in TIERS:
        above = np.where(v >= thr)[0]
        if above.size == 0:
            tiers.append({"tier": name, "stage_ft": thr, "onset_h": None, "onset_at": None,
                          "hours_before_crest": None, "hours_above": 0,
                          "peak_above_ft": round(crest_ft - thr, 2)})
            continue
        i0, i1 = int(above[0]), int(above[-1])
        tiers.append({
            "tier": name, "stage_ft": thr,
            "onset_h": float(hours[i0]), "onset_at": t[i0].isoformat(),
            "hours_before_crest": round(crest_h - float(hours[i0]), 1),
            "hours_above": int(above.size),
            "last_above_at": t[i1].isoformat(), "last_above_h": float(hours[i1]),
            "peak_above_ft": round(crest_ft - thr, 2),
        })
        print(f"  {name:9s} {thr:>4.0f} ft -> onset {t[i0]} (+{hours[i0]:.0f} h), "
              f"{crest_h - hours[i0]:.0f} h before the crest, above it {above.size} h")

    # ---- how much warning a street actually got ---------------------------------
    # For each segment: hours between its own alert and the crest. Measured against the
    # GAUGE crest — the street-level onset that precedes it is the model, and no observed
    # time series exists to check it (see the module docstring).
    thr = thresholds()
    lead, ship_h = [], []
    for x in thr:
        h = first_hour_at_or_above(v, hours, x)
        ship_h.append(h)
        if h is not None:
            lead.append(crest_h - h)
    lead = np.array(lead, float)
    ship_h = np.array(ship_h, dtype=object)
    n_reach = int(lead.size)
    # Per segment, not just the corridor: "what would MY alert have said in 2017" is the
    # question a household actually has, and it is the same array the percentiles above
    # were taken from — so the block and the selection cannot disagree.
    seg_lead = [None if h is None else round(crest_h - float(h), 1) for h in ship_h]
    print(f"\nsegments reaching their own threshold within the window: {n_reach} of {thr.size}")
    print(f"  lead time to the crest: median {np.median(lead):.0f} h, "
          f"p10 {np.percentile(lead, 10):.0f} h, p90 {np.percentile(lead, 90):.0f} h, "
          f"max {lead.max():.0f} h")

    # ---- what the rule would have flagged, and what correcting it costs ----------
    # The correction is NOT applied anywhere in the app. Its cost had never been priced:
    # a later alert for every street, and some streets getting no alert in the window
    # at all. Both are measured here so the decision to leave the thresholds alone is
    # made against a number rather than a principle alone.
    shipped_flags, corrected_flags = {}, {}
    for st in GRID_STAGES:
        shipped_flags[st] = int((thr <= st).sum())
        corrected_flags[st] = int(((thr + lift) <= st).sum())
    print(f"\nflags at the crest ({crest_ft:.2f} ft): shipped "
          f"{int((thr <= crest_ft).sum())} of {thr.size}, corrected "
          f"{int(((thr + lift) <= crest_ft).sum())}")

    corr_h = np.array([first_hour_at_or_above(v, hours, x + lift) for x in thr], dtype=object)
    both = np.array([(a is not None) and (b is not None) for a, b in zip(ship_h, corr_h)])
    gave_up = np.array([b - a for a, b in zip(ship_h[both], corr_h[both])], float)
    silent = int(sum(1 for a, b in zip(ship_h, corr_h) if a is not None and b is None))
    print(f"  applying it: {silent} of {n_reach} streets get no alert in the window at all; "
          f"the rest alert {np.median(gave_up):.0f} h later (p90 {np.percentile(gave_up, 90):.0f} h)")

    correction_tradeoff = {
        "not_applied": True,
        "lift_ft": lift,
        "flags_at_crest": {"stage_ft": round(crest_ft, 2),
                           "shipped": int((thr <= crest_ft).sum()),
                           "corrected": int(((thr + lift) <= crest_ft).sum()),
                           "of": int(thr.size)},
        "streets_reaching_threshold_shipped": n_reach,
        "streets_silent_in_window_after_correction": silent,
        "hours_of_warning_given_up": {
            "p10": round(float(np.percentile(gave_up, 10)), 1),
            "median": round(float(np.median(gave_up)), 1),
            "p90": round(float(np.percentile(gave_up, 90)), 1),
            "n": int(gave_up.size)},
        "adjudication_at_the_peak": hv.get("correction_would_score"),
        "reading": ("the correction is not applied, and this is what that decision buys: "
                    "applying it would silence the alert entirely for "
                    f"{silent} of the {n_reach} streets that the shipped rule warns in "
                    "time, and delay the rest by a median of "
                    f"{np.median(gave_up):.0f} h. What it would buy back is measured on "
                    "the peak in harvey_validation.json's correction_would_score: "
                    "accuracy 0.422 -> 0.760 and the false-positive rate 0.887 -> 0.153, "
                    "at the cost of 167 segments that flooded and would now be called "
                    "dry. Trading a false alarm for a miss is not free in a life-safety "
                    "product, and one event cannot say which trade is right."),
    }

    # ---- verification grid the browser must reproduce ----------------------------
    grid = [{"stage_ft": st, "shipped": shipped_flags[st], "corrected": corrected_flags[st]}
            for st in GRID_STAGES]
    # The rows of the per-segment array the browser re-derives for the selected street:
    # every 137th segment (a fixed stride, so the sample is reproducible), plus the
    # earliest and latest onsets, which are the rows most likely to catch an off-by-one
    # in "the first hour at or above the threshold". Also the highest threshold in the
    # corridor and one segment that was never reached, because the null branch — most of the
    # corridor in 2017 — is otherwise never exercised by the cross-check.
    sample_idx = sorted(set(list(range(0, int(thr.size), 137))
                            + ([int(np.argmin(lead)), int(np.argmax(lead))] if lead.size else [])))
    sample_idx = sorted(set(sample_idx + [x for x, v in enumerate(seg_lead) if v is None][:1]
                            + [int(np.argmax(thr))]))
    segment_grid = {str(int(i)): seg_lead[int(i)] for i in sample_idx}
    print(f"per-segment lead times: {n_reach} of {thr.size} segments reached their threshold; "
          f"{len(segment_grid)} of them named for the browser cross-check")
    tier_grid = {f"{name}_{thr:g}": (None if x["onset_h"] is None else round(x["onset_h"], 1))
                 for (name, thr), x in zip(TIERS, tiers)}
    print(f"\nverification grid: {len(grid)} stages + {len(tier_grid)} tier onsets "
          f"for the browser cross-check")

    # ---- gates -------------------------------------------------------------------
    assert len(s) > 100 and abs((hours[-1] / (len(s) - 1)) - 1.0) < 1e-9, \
        "the series is not hourly"
    assert abs(crest_ft - peak_published) < 0.05, (
        f"the hourly crest {crest_ft:.2f} disagrees with the published peak "
        f"{peak_published:.2f} — two artifacts about one flood")
    assert crest_i > len(s) // 2, \
        "the crest is not in the second half of the window; this is not the build-up phase"
    onsets = [x["onset_h"] for x in tiers]
    assert all(o is not None for o in onsets), "a tier was never crossed — the event is trivial"
    assert onsets == sorted(onsets), "higher tiers must cross later, not earlier"
    assert all(0 <= o <= crest_h for o in onsets), "a tier onset lies outside the event"
    assert all(0 <= x["hours_before_crest"] <= hours[-1] for x in tiers), \
        "lead time to the crest is not inside the window"
    assert all(x["hours_above"] > 0 for x in tiers), "a tier onset has no hours above it"
    seq = [g["shipped"] for g in grid]
    assert seq == sorted(seq) and [g["corrected"] for g in grid] == \
        sorted(g["corrected"] for g in grid), "flag counts are not monotone in stage"
    assert all(g["corrected"] <= g["shipped"] for g in grid), (
        "a higher threshold cannot flag more segments — the correction is inverted")
    assert grid[-1]["shipped"] > grid[0]["shipped"], "the flag curve is flat — nothing rose"
    assert grid[0]["shipped"] == 0, "some segment claims to flood below the grid's floor"
    assert n_reach > 0 and lead.min() >= 0, "lead times must be non-negative"
    assert len(seg_lead) == int(thr.size) and \
        sum(1 for x in seg_lead if x is not None) == n_reach, \
        "the per-segment lead array is not the population the percentiles were taken from"
    assert (len(lead) == 0) or (abs(float(np.median(lead)) - float(np.median(
        [x for x in seg_lead if x is not None]))) < 0.1), \
        "the per-segment array disagrees with the published median"
    assert float(np.percentile(lead, 10)) <= float(np.median(lead)) <= \
        float(np.percentile(lead, 90)), "lead-time quantiles are not ordered"
    assert gave_up.min(initial=0) >= 0, "correcting a threshold cannot alert EARLIER"
    assert 0 < silent < n_reach, (
        "the correction either silences nothing or silences everything; "
        "the trade-off is not being measured")
    cs = hv.get("correction_would_score")
    assert cs and cs["variants"]["probit_lift"]["accuracy"] > 0.5, \
        "harvey_validation.json carries no usable in-sample correction score"
    print("all gates passed (observed onsets ordered, flag curve monotone, "
          "trade-off measured on both sides)")

    out = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "step": "UPGRADE-PLAN.md Step 7 — Harvey backcast alert timeline",
        "question": ("on the only real flood in the record, what would BrazosCast have "
                     "told a household, and how much of that warning is it entitled to "
                     "claim?"),
        "answer": (f"the action stage was crossed {crest_h - onsets[0]:.0f} h before the "
                   f"observed crest and the median street's threshold "
                   f"{float(np.median(lead)):.0f} h before it, so the lead time the product "
                   f"promises is real in the one event where it can be counted — but the "
                   f"rule would have flagged {int((thr <= crest_ft).sum())} of {thr.size} "
                   f"segments at the crest, and the measured correction would silence "
                   f"{silent} streets that the shipped rule warned in time"),
        "event": {"name": hv["peak"].get("gauge", "RMOT2"),
                  "label": "Hurricane Harvey (Aug–Sep 2017)",
                  "gauge": {"lid": "RMOT2", "usgs": "08114000"},
                  "source": "USGS 08114000 observed gage height, cached in-repo",
                  "window": {"from": t[0].isoformat(), "to": t[-1].isoformat(),
                             "hours": float(hours[-1]), "n_points": int(len(s)),
                             "resample": "1-hour mean, as app/public/data/replay-harvey.json"},
                  "crest": {"stage_ft": round(crest_ft, 2), "at": t[crest_i].isoformat(),
                            "hours_from_start": round(crest_h, 1),
                            "note": ("the window ends "
                                     f"{hours[-1] - crest_h:.0f} h after the crest, so the "
                                     "recession is not observed and 'clears' is not "
                                     "reported rather than extrapolated")}},
        "tiers": tiers,
        "street_lead_time": {
            "definition": ("hours between a segment's own alert (first observed hour at or "
                           "above its shipped threshold) and the observed gauge crest"),
            "measured_against": "the GAUGE crest, which is observed",
            "validated_per_street": False,
            "why_not": ("the only street-level observation is a single event-maximum extent "
                        "(harvey_validation.py); it cannot say when water arrived at a "
                        "street, so the onset that precedes the crest is the model"),
            "segments": int(thr.size),
            "segments_reaching_threshold": n_reach,
            "p10_h": round(float(np.percentile(lead, 10)), 1),
            "median_h": round(float(np.median(lead)), 1),
            "p90_h": round(float(np.percentile(lead, 90)), 1),
            "min_h": round(float(lead.min()), 1),
            "max_h": round(float(lead.max()), 1),
            "per_segment_h": seg_lead,
            "per_segment_note": ("indexed by position in road_thresholds.geojson, the same "
                                 "order the app addresses segments by; null means the "
                                 "segment's threshold was never reached inside the window"),
            "note": ("the crest moves downstream during the event, so a street below "
                     "Richmond crests later than the gauge it is keyed to "
                     "(FINDINGS section 1) — this number is against the gauge"),
        },
        "correction_tradeoff": correction_tradeoff,
        "method": {
            "tiers": "the first and last observed hour at or above each NWS category stage",
            "flags": "a segment is flagged iff its flood_stage_ft is at or below the stage; "
                     "the corrected rule uses flood_stage_ft + the measured probit lift",
            "population": f"all {thr.size} segments in road_thresholds.geojson, the same "
                          "population the app counts over",
            "adjudication": "the peak is the only adjudicable instant and is read from "
                            "harvey_validation.json, never recomputed here",
        },
        "sources": {
            "hydrograph": "data/raw/usgs/iv/08114000_20170822.json (USGS 08114000)",
            "thresholds": "data/derived/road_thresholds.geojson (OWP HAND, isolation-enriched)",
            "threshold_error": "data/derived/harvey_validation.json "
                              "(USGS SIR 2018-5070 extent, doi:10.5066/F7VH5N3N)",
        },
        "verification_grid": {"flag_counts": grid, "tier_onsets_h": tier_grid,
                              "segment_lead_h": segment_grid},
        "reference_algorithm": (
            "tier_onset(tier) = hours of the first hourly point with stage >= tier; "
            "hours_before_crest = crest_h - tier_onset; flags(stage) = count of segments "
            "with flood_stage_ft <= stage; corrected flags(stage) = count with "
            "flood_stage_ft + lift <= stage; street_lead(segment) = crest_h minus the hours "
            "of the first hourly point at or above that segment's own flood_stage_ft, null "
            "when it is never reached. The app recomputes all of these from its own "
            "replay series and its own road list, and must match verification_grid exactly."),
        "limits": [
            "no per-street timing is validated: the only street-level observation is one "
            "event-maximum extent, so the tier onsets are observed but the street onset "
            "that precedes the crest is the model",
            "the lead time is measured to the gauge crest, and the crest travels downstream "
            "during the event, so a street away from the gauge has a different (later) crest",
            "the replay window ends "
            f"{hours[-1] - crest_h:.0f} h after the crest, so the falling limb is not "
            "observed: the artifact reports when tiers were crossed, not when they cleared",
            "the flag counts inherit the threshold defect this module measures rather than "
            "fixes; the corrected counts apply one event's fitted constant, which is exactly "
            "why the app does not apply it",
            "one event: this is a backcast of Harvey, and cannot be repeated on another "
            "flood from data in this repo",
        ],
    }
    (DERIVED / "harvey_backcast.json").write_text(json.dumps(out, indent=2))
    print("\nWrote data/derived/harvey_backcast.json")


if __name__ == "__main__":
    main()
