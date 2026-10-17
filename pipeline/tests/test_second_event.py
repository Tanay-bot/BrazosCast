"""I1 — the second observed flood, and what it is allowed to conclude.

`harvey_validation.py` scored the thresholds against one observation: an event MAXIMUM
at the record peak, and it says in its own output the thing that observation cannot do —
"a segment observed wet at the record peak is equally consistent with flooding at 17 ft
and at 55 ft". `second_event_validation.py` scores them against a second, independent
observation at a LOWER stage, which can refute instead of merely agree.

This file holds the two things that make that comparison trustworthy rather than a
second set of numbers to be taken on faith:

  * that the observation is the dataset it claims to be and is pinned to the right
    instant — the stage is recomputed here from the raw shapefile's own acquisition
    time and the cached gauge series, so a stale artifact fails rather than agreeing
    with itself; and
  * that the correction it tests is THE correction, read from `harvey_validation.json`
    rather than restated, so the two artifacts cannot drift into testing different
    lifts while both look self-consistent.

The numbers that decide anything are quoted in the docs, so they are asserted against
the artifact in both directions — the same rule the rest of this suite follows.
"""
import json

import pytest

from conftest import DERIVED, ROOT, get, read_json

SECOND = "second_event_validation.json"
HARVEY = "harvey_validation.json"
ZIP = ROOT / "data" / "raw" / "usfimr" / "05302016_Brazos_River_at_Richmond_TX.zip"


def test_the_observation_is_the_dataset_the_receipt_describes():
    """A water-edge analysis is only as good as which water edge it is."""
    receipt = read_json(ROOT / "data" / "raw" / "usfimr", "_receipt.json")
    art = read_json(DERIVED, SECOND)["observation"]

    assert "SDML" in receipt["provider"] or "Surface Dynamics" in receipt["provider"], (
        f"the receipt does not name the provider this analysis cites: {receipt['provider']!r}")
    assert receipt["licence"].startswith("CC BY"), (
        "the receipt must carry the licence the data is published under, or an adaptation "
        "of it has no stated terms")
    assert "CC BY" in art["licence"], "the artifact dropped the licence it is published under"
    assert receipt["acquired"] == art["acquired"][:10], (
        f"the receipt says the image is {receipt['acquired']} and the artifact says "
        f"{art['acquired']} — they describe different observations")
    assert float(receipt["stage_at_acquisition_ft"]["min_ft"]) > 40.0, (
        "the receipt's stage band is not a flood stage, so the observation is not the one "
        "this analysis is about")
    # Sentinel-1 is the reason a water edge exists at all on a day with no Landsat pass:
    # if the platform changes, every limit about radar failure modes changes with it.
    assert "Sentinel-1" in art["platform"], (
        f"the platform is {art['platform']!r}; the radar-specific limits in the artifact "
        f"and the docs are written for Sentinel-1")


def test_the_stage_is_recomputed_from_the_image_time_and_the_cached_gauge():
    """The one number the whole comparison hangs on, checked against its sources.

    A stale artifact is the failure mode this catches: the stage would still look
    plausible, and every count derived from it would be wrong together.
    """
    gpd = pytest.importorskip("geopandas")
    import numpy as np
    import pandas as pd

    member = ("/vsizip/" + str(ZIP) + "/05302016_Brazos_River_at_Richmond_TX/"
              "05302016_Brazos_River_at_Richmond_TX.shp")
    layer = gpd.read_file(member)
    row = layer.iloc[0]
    when = pd.Timestamp(f"{pd.Timestamp(row['Flood_Date']).date()}T{row['Start_Time']}", tz="UTC")

    iv = ROOT / "data" / "raw" / "usgs" / "iv" / "08114000_20160524.json"
    assert iv.exists(), (
        f"{iv.relative_to(ROOT)} is missing, so the stage this comparison is scored at "
        f"cannot be re-derived. It is an ignored event cache, re-created by "
        f"`python pipeline/analyze/travel_time_subdaily.py` — a clone without it fails this "
        f"test loudly rather than skipping the check, which is the rule everywhere else in "
        f"this suite (docs/DATA-SOURCES.md \u00a7 \"Raw inputs\").")
    rows = json.loads(iv.read_text())
    df = pd.DataFrame([r["properties"] for r in rows])
    df["t"] = pd.to_datetime(df["time"], errors="coerce", utc=True)
    df["v"] = pd.to_numeric(df["value"], errors="coerce")
    s = df.dropna(subset=["t", "v"]).drop_duplicates("t").set_index("t")["v"].sort_index()
    nearest = s.index[np.argmin(np.abs(s.index - when))]
    stage = float(s.loc[nearest])

    art = read_json(DERIVED, SECOND)
    assert art["observation"]["acquired"] == when.isoformat(), (
        f"the artifact pins the image to {art['observation']['acquired']} and the "
        f"shapefile's own attributes say {when.isoformat()}")
    assert abs(get(art, "stage_basis.stage_ft") - stage) < 0.005, (
        f"the artifact scores the comparison at {get(art, 'stage_basis.stage_ft')} ft and "
        f"the cached series says {stage} ft at {nearest.isoformat()} — re-run "
        f"pipeline/derive/second_event_validation.py")
    assert get(art, "stage_basis.minutes_from_the_image") <= 20, (
        "the nearest gauge reading is not close to the image time, so the comparison is "
        "not being scored at the stage the water was photographed at")


def test_the_two_events_are_different_events_at_different_stages():
    """The whole reason this observation was worth fetching."""
    second = read_json(DERIVED, SECOND)
    harvey = read_json(DERIVED, HARVEY)
    stage = get(second, "stage_basis.stage_ft")
    peak = get(harvey, "peak.stage_ft")

    assert stage < peak - 3.0, (
        f"the second observation is at {stage} ft against Harvey's {peak} ft: a second "
        f"HIGH-stage extent adds nothing about low thresholds, so the choice of this image "
        f"would no longer be justified")
    assert "2016" in second["observation"]["event"], "the artifact no longer names the event"
    assert second["observation"]["acquired"].startswith("2016-05-30"), (
        "the observation date moved; every stage and count in the artifact descends from it")


def test_the_refutations_are_quantified_and_survive_the_under_mapping_objection():
    """What a lower-stage extent can say that a maximum cannot.

    A segment shown dry at this stage had not flooded yet, so its true threshold is above
    the stage — and a radar water edge is the kind of observation that can miss water. So
    the artifact has to carry both the count and the number that would be needed to
    explain it away, rather than the count alone.
    """
    art = read_json(DERIVED, SECOND)
    ref = get(art, "refutations")
    under = get(art, "under_mapping_sensitivity")

    assert ref["refuted_by_this_image"] > 0, (
        "the observation refutes nothing, which would mean it is not a lower-stage "
        "observation or the join has broken")
    assert under["water_would_have_to_be_under_mapped_by_a_factor_of"] > 3.0, (
        f"erasing the refutations needs only a "
        f"{under['water_would_have_to_be_under_mapped_by_a_factor_of']}x under-mapping of "
        f"water, so the count cannot carry the conclusion drawn from it")
    # The identity that ties the headline to the confusion matrix: a refutation is a segment the
    # model submerges at this stage that the image does NOT show wet, so the count is the
    # modelled-wet total less the true positives — never the modelled-wet total on its own.
    assert ref["refuted_by_this_image"] == (
        ref["shipped_thresholds_below_the_stage"] - get(art, "confusion_matrix.tp")), (
        f"{ref['refuted_by_this_image']} refutations against "
        f"{ref['shipped_thresholds_below_the_stage']} modelled-wet segments and "
        f"{get(art, 'confusion_matrix.tp')} true positives — the refutations are not being "
        f"taken as the modelled-wet segments the image shows dry")
    assert ref["refuted_and_fixed_by_the_harvey_lift"] <= ref["refuted_by_this_image"], (
        "the Harvey lift cannot fix more refutations than exist")
    assert "cannot" in ref["why_this_is_the_point"] or "could not" in ref["why_this_is_the_point"], (
        "the artifact no longer says WHY a maximum extent could not produce this evidence")


def test_the_correction_tested_is_the_correction_harvey_measured():
    """The out-of-sample claim, held against drift.

    If the lift in this file were restated rather than read, the two artifacts could
    diverge and the out-of-sample test would silently become a test of some other number.
    """
    second = read_json(DERIVED, SECOND)
    harvey = read_json(DERIVED, HARVEY)
    probit = get(harvey, "estimators_of_the_same_lift.probit_mle_ft")

    assert abs(second["harvey_lift_ft"] - probit) < 0.005, (
        f"the second-event test applies {second['harvey_lift_ft']} ft and Harvey's probit "
        f"lift is {probit} ft — the out-of-sample claim would be testing a different lift")
    assert get(second, "confusion_matrix.n") == get(second, "with_the_harvey_lift_applied.n"), (
        "the shipped and corrected rules were scored on different populations")
    assert abs(second["lift_difference_ft"]
               - (second["implied_lift_from_this_event_ft"] - probit)) < 0.02, (
        "the reported difference between the two events' implied lifts does not equal the "
        "difference of the two numbers next to it")
    # The claim that makes this a finding rather than a second measurement: the offset
    # does not transfer. If a future run produced a matching lift, that would be news and
    # the artifact must say so rather than keep the old prose.
    assert second["lift_difference_ft"] < -5.0, (
        f"this event now implies a lift within {second['lift_difference_ft']} ft of "
        f"Harvey's, which contradicts the artifact's conclusion that the constant does not "
        f"transfer — re-read the finding before changing this")


def test_the_ranking_comparison_uses_matched_populations():
    """An AUC is a property of a population, so the two events' must not be compared
    across two different evaluated sets — which is a mistake the first version made."""
    d = read_json(DERIVED, SECOND)["discrimination_at_this_stage"]

    assert d["n_harveys_evaluated_set"] == 1187, (
        f"Harvey's evaluated set is {d['n_harveys_evaluated_set']} segments and its own "
        f"artifact scored 1,187 — the like-for-like comparison would not be like-for-like")
    assert d["n_corridor"] == 1614, "the corridor population changed"
    # Two populations, two numbers. If they ever agree, one of them is not being computed
    # over the population it is labelled with — which is the mistake that made the first
    # version of this comparison look like a like-for-like one.
    assert d["auc_on_harveys_evaluated_set"] != d["auc"], (
        f"the corridor AUC and the Harvey-evaluated-set AUC are both "
        f"{d['auc']} — the restriction to Harvey's population is not being applied, so "
        f"the like-for-like comparison is against the wrong set")
    assert d["auc_on_harveys_evaluated_set"] < d["harvey_auc"] - 0.1, (
        "the ranking at the second event is no worse than at Harvey's peak, which would "
        "remove the reason the constant cannot be the fix")
    # A constant offset is rank-preserving, so the AUC statement is the strongest one in
    # the file: no shift of the thresholds can move it.
    assert "rank" in d["why_it_matters"] or "ranking" in d["why_it_matters"], (
        "the artifact no longer explains why an AUC argument is stronger than a confusion "
        "matrix for deciding whether a constant offset can work")


def test_the_limits_name_what_this_observation_cannot_do():
    """One instant, a radar edge, a polygon that bounds water rather than ground."""
    art = read_json(DERIVED, SECOND)
    limits = " ".join(art["limits"]).lower()

    for needle, why in (
        ("rising limb", "the image is not the event peak and the artifact must say so"),
        ("radar", "the radar failure modes are the reason the refutation count needs its "
                  "own sensitivity"),
        ("water, not the scene", "the polygon bounds water, not the ground the dry reading "
                                 "depends on"),
        ("gauge", "one gauge on a reach whose crest travels downstream"),
        ("hand-as-stage", "the defect under test is not fixed by testing it"),
    ):
        assert needle in limits, f"the limits no longer state that {why}"


def test_the_documents_quote_this_observation():
    """The docs are where a reader meets these numbers, so they are held to the artifact."""
    art = read_json(DERIVED, SECOND)
    readme = (ROOT / "README.md").read_text()
    # The documents are typeset with a unicode minus in front of negative numbers, so
    # normalise it: this test is about the number being stated, not about the glyph.
    findings = (ROOT / "docs" / "FINDINGS.md").read_text().replace("\u2212", "-")

    refuted = get(art, "refutations.refuted_by_this_image")
    stage = get(art, "stage_basis.stage_ft")
    implied = art["implied_lift_from_this_event_ft"]
    harvey_lift = art["harvey_lift_ft"]
    under = get(art, "under_mapping_sensitivity.water_would_have_to_be_under_mapped_by_a_factor_of")

    assert f"{refuted:,}" in readme or f"{refuted}" in readme, (
        f"the README never states the {refuted} refuted segments, which is this step's result")
    assert f"{stage:.2f}" in findings, (
        f"FINDINGS never states the {stage:.2f} ft the second observation was taken at")
    assert f"{implied:+.2f}" in findings or f"{implied:.2f}" in findings, (
        f"FINDINGS never states the {implied:.2f} ft lift this event implies on its own")
    assert f"{harvey_lift:.2f}" in findings, (
        f"FINDINGS never states Harvey's {harvey_lift:.2f} ft lift beside it, so the "
        f"comparison that is the finding would not be visible")
    assert f"{under:.1f}" in findings or f"{under:.0f}" in findings, (
        f"FINDINGS never states the {under}x under-mapping that would erase the refutations")
    assert "Sentinel-1" in findings and "USFIMR" in findings, (
        "FINDINGS does not name the observation or its platform")
