"""The artifacts behind the post-submission bets (ACTION-PLAN.md §4, I2–I6) and the
quiet-river answer (F1's second half).

Four app-side features read artifacts this file is about, and each one has a failure mode that
is invisible in the browser:

  * the quiet-river answer needs a peak record that is chronological, in feet and long enough
    that "last reached" means something — and an annual peak filtered from the wrong parameter
    (the same USGS file carries discharge) would still look like a plausible series of numbers;
  * the per-street backcast reads `street_lead_time.per_segment_h` POSITIONALLY, so an array
    that is short, or in a different order from the road layer, would answer about another
    street's flood and read perfectly;
  * the live gauge cross-check is only meaningful if the transfer has knots and a lag per
    upstream gauge, and if the band it compares against came from a measurement;
  * the responder view reads `segment_route_cut_ft` positionally too, alongside the same road
    layer, so those two have to agree on the population before either number means anything.

None of this is reachable from a TypeScript test: it is about what the pipeline wrote.
"""
import json

import pytest

from conftest import DERIVED, PUBLIC, read_json


def test_the_peak_record_is_one_series_of_one_quantity():
    """"Last reached" is a claim about the record, so the record has to be a record: in feet,
    chronological, deduplicated, and long enough that the answer is not the whole history."""
    h = read_json(DERIVED, "gauge_history.json")
    peaks = h["peaks"]
    assert h["unit"] == "ft", "the quiet-river sentence is in feet; the discharge peaks are not"
    assert len(peaks) >= 50, f"only {len(peaks)} annual peaks — 'never in the record' would be a short claim"
    assert [p["at"] for p in peaks] == sorted(p["at"] for p in peaks), "peaks are not chronological"
    assert len({p["at"] for p in peaks}) == len(peaks), "duplicate peak dates"
    assert all(0 < p["ft"] < 100 for p in peaks), "a stage peak outside a plausible range"
    highest = max(peaks, key=lambda p: p["ft"])
    assert highest["at"] == h["highest"]["at"] and highest["ft"] == h["highest"]["ft"], (
        "the recorded highest is not the highest in the series the app searches")
    assert int(h["from"][:4]) < 1950, "the record does not reach back far enough to be a history"


def test_the_record_agrees_with_the_flood_the_repo_publishes_the_app_replays():
    """The 2017 peak is the one figure three artifacts now quote: harvey_validation.json's
    observed peak, the replay series' peak, and this record's 2017 entry."""
    h = read_json(DERIVED, "gauge_history.json")
    v = read_json(DERIVED, "harvey_validation.json")
    replay = read_json(PUBLIC, "replay-harvey.json")
    own = max((p["ft"] for p in h["peaks"] if p["at"].startswith("2017-")), default=None)
    assert own is not None, "2017 is missing from the peak record"
    assert abs(own - replay["peak_ft"]) <= 0.1, (
        f"the record says 2017 peaked at {own} ft and the app's replay series says "
        f"{replay['peak_ft']} ft")
    assert abs(own - v["peak"]["stage_ft"]) <= 0.1, (
        f"the record says 2017 peaked at {own} ft and harvey_validation.json says "
        f"{v['peak']['stage_ft']} ft")


def test_the_quiet_river_answer_is_the_rule_the_app_runs():
    """The app answers "the gauge would need X ft; it last reached that in YYYY". The rule is
    one scan backwards over the record, so it is short enough to state here and compare: the
    no-forecast case is the one a judge loads on a dry day, and it must not be the one state
    that says nothing.

    The corridor's own median threshold is used, so the assertion is about a number the
    product really quotes rather than a value chosen to make the test agree.
    """
    h = read_json(DERIVED, "gauge_history.json")
    thresholds = [f["properties"]["flood_stage_ft"]
                  for f in read_json(PUBLIC, "road_thresholds.geojson")["features"]]
    median = sorted(thresholds)[len(thresholds) // 2]

    def last_at_or_above(thr):
        for p in sorted(h["peaks"], key=lambda p: p["at"], reverse=True):
            if p["ft"] >= thr:
                return p
        return None

    found = last_at_or_above(median)
    assert found is not None, f"no peak in the record reached the median threshold {median:.1f} ft"
    assert int(found["at"][:4]) >= 1980, (
        f"the median street's threshold was last reached in {found['at'][:4]} — if that is true "
        "the sentence is fine, but a 19th-century answer this prominent is worth re-reading")
    assert found["ft"] >= median, "the rule returned a peak below the threshold it was asked about"
    # And the highest possible threshold is still answerable, which is the point of keeping the
    # whole record: the app must be able to say "never in 141 years" honestly.
    assert last_at_or_above(h["highest"]["ft"] + 1) is None, (
        "a threshold above the highest peak must have no year, or the app would name one")


def test_the_per_street_backcast_is_the_same_population_as_the_road_layer():
    """`per_segment_h` is read by POSITION, so its length and its order are part of the
    contract, and its non-null count is the population the published percentiles came from."""
    bc = read_json(DERIVED, "harvey_backcast.json")
    lt = bc["street_lead_time"]
    per = lt["per_segment_h"]
    served = read_json(PUBLIC, "road_thresholds.geojson")["features"]

    assert len(per) == len(served) == lt["segments"], (
        f"per_segment_h has {len(per)} entries, the road layer has {len(served)}, and the "
        f"headline quotes {lt['segments']} — the app reads this array by index")
    reached = [x for x in per if x is not None]
    assert len(reached) == lt["segments_reaching_threshold"], (
        f"{len(reached)} segments have a lead time but the artifact says "
        f"{lt['segments_reaching_threshold']} reached their threshold")
    assert min(reached) == lt["min_h"] and max(reached) == lt["max_h"], (
        "the per-segment array's extremes are not the published min/max")
    ordered = sorted(reached)
    mid = ordered[len(ordered) // 2] if len(ordered) % 2 else \
        (ordered[len(ordered) // 2 - 1] + ordered[len(ordered) // 2]) / 2
    assert abs(mid - lt["median_h"]) < 0.05, "the per-segment array's median is not the published one"
    assert all(x is None or x >= 0 for x in per), "a negative lead time (an alert after the crest)"


def test_the_named_segment_grid_rows_are_the_array_the_app_reads():
    """The browser recomputes the selected street's own lead time and compares it with the
    artifact — but a grid that disagrees with the array the app READS would pass while the
    number on screen came from somewhere else."""
    bc = read_json(DERIVED, "harvey_backcast.json")
    per = bc["street_lead_time"]["per_segment_h"]
    grid = bc["verification_grid"]["segment_lead_h"]
    assert grid, "no per-segment rows are named for the browser cross-check"
    bad = {i: (v, per[int(i)]) for i, v in grid.items() if per[int(i)] != v}
    assert not bad, f"verification_grid.segment_lead_h disagrees with per_segment_h at {bad}"
    assert any(v is None for v in grid.values()), (
        "every named segment reached its threshold, so the null branch — the street that was "
        "never flooded in 2017, which is most of the corridor — is not checked at all")
    assert any(v is not None for v in grid.values()), "no named segment has a lead time"


def test_the_cross_check_has_something_to_cross_check_with():
    """I2 compares an upstream estimate against the live Richmond reading using the same transfer
    the failure path uses. Two gauges, a lag and knots each, and a measured band: without any of
    those the card would show one gauge beside itself and call it agreement."""
    r = read_json(DERIVED, "gauge_redundancy.json")
    transfer = r["transfer"]
    assert len(transfer) >= 2, (
        f"only {len(transfer)} upstream gauge(s) in the transfer — a cross-check needs a second")
    for lid, t in transfer.items():
        assert t["lag_h_used"] > 0, f"{lid} has no lag, so 'the upstream value then' is 'now'"
        assert len(t["u_ft"]) == len(t["r_ft"]) >= 5, f"{lid} has too few knots to interpolate"
        assert t["u_ft"] == sorted(t["u_ft"]), f"{lid}'s knots are not monotone"
    band = r["uncertainty"]["band_ft"]
    assert band[0] < 0 < band[1], (
        "the band is not two-sided, so a divergence in one direction could never be flagged")
    assert r["validation"]["regimes"]["persistence_until_h"] > 0
    assert r["validation"]["evaluated_rows"] > 1000, "the band was not measured on held-out events"


def test_the_responder_view_reads_arrays_that_match_the_road_layer():
    """I5 lists the segments whose route to a responder is already cut while their own street is
    still dry. It reads `segment_route_cut_ft` and the road layer by the same index, so they are
    required to be the same length — and there have to be some such segments, or the card is a
    permanent zero."""
    gj = read_json(PUBLIC, "road_thresholds.geojson")["features"]
    g = read_json(PUBLIC, "routing_graph.json")
    for key in ("segment_route_cut_ft", "segment_route_cut_medical_ft"):
        assert len(g[key]) == len(gj), (
            f"{key} has {len(g[key])} entries against {len(gj)} segments")
    merged = [
        (f["properties"]["flood_stage_ft"], g["segment_route_cut_ft"][i])
        for i, f in enumerate(gj)
        if g["segment_route_cut_ft"][i] is not None
    ]
    trapped = [x for x in merged if x[1] < x[0] - 0.05]
    assert trapped, (
        "no segment loses its route to help before its own street floods, so the responder view "
        "would be empty at every stage — the graph has been diluted or the merge is wrong")
    assert len(merged) <= len(gj)
    # A cut above the slider's ceiling is a real state — it means the route out survives the
    # whole range the app explores — and it is why the app compares against the STAGE rather
    # than assuming every cut is reachable by dragging.
    assert all(cut > 0 for _, cut in merged), "a route cut at or below zero feet"
    assert max(cut for _, cut in merged) > 56, (
        "no route out survives past the slider's ceiling, so the 'not cut in this range' case "
        "the app renders would never occur in the data")
