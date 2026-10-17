"""T4 — payload contract.

The app reads these artifacts by field path. When a field disappears the app does
not throw: it silently renders a blank, so a lost number looks like a quiet river
rather than a build error. (`app_data.py` already hard-fails on a missing
`isolation_ft` for exactly that reason; this generalises it.)

Each entry below is a field path taken from the TypeScript types in
app/src/main.ts, so this test and the app's contract are the same list.
"""
import json
import pathlib

import pytest

from conftest import DERIVED, PUBLIC, ROOT, get

# ---- required field paths, per artifact -----------------------------------
REQUIRED = {
    "harvey_validation.json": [
        "peak.stage_ft",
        "confusion_matrix.accuracy", "confusion_matrix.false_positive_rate",
        "confusion_matrix.recall", "confusion_matrix.prevalence_observed",
        "confusion_matrix.prevalence_modelled", "confusion_matrix.n",
        "diagnosis.auc_discrimination", "diagnosis.offset_vs_observed_peak_ft",
        "diagnosis.threshold_error_model.lift_ft",
        "diagnosis.threshold_error_model.per_street_sigma_ft",
        "observation.extent_area_km2", "observation.hwm.n",
    ],
    "ensemble.json": [
        "parameters.members", "parameters.seed", "parameters.lift_ft",
        "parameters.per_street_sigma_ft", "parameters.forecast_rmse_knots_ft",
        "parameters.forecast_rmse_beyond_measured_ft",
        "verification_grid.0.threshold_ft", "verification_grid.0.mode",
        "verification_grid.0.members", "verification_grid.0.crossing",
        "verification_grid.0.of", "verification_grid.0.never_h",
    ],
    "harvey_backcast.json": [
        "answer", "event.label", "event.crest.stage_ft", "event.crest.at",
        "event.crest.hours_from_start", "event.crest.note",
        "event.window.from", "event.window.to", "event.window.hours",
        "event.window.n_points",
        "tiers.0.tier", "tiers.0.stage_ft", "tiers.0.onset_h",
        "tiers.0.hours_before_crest", "tiers.0.hours_above", "tiers.0.peak_above_ft",
        "street_lead_time.segments", "street_lead_time.segments_reaching_threshold",
        "street_lead_time.p10_h", "street_lead_time.median_h", "street_lead_time.p90_h",
        "street_lead_time.min_h", "street_lead_time.max_h", "street_lead_time.note",
        "correction_tradeoff.lift_ft", "correction_tradeoff.flags_at_crest.stage_ft",
        "correction_tradeoff.flags_at_crest.shipped",
        "correction_tradeoff.flags_at_crest.corrected",
        "correction_tradeoff.flags_at_crest.of",
        "correction_tradeoff.streets_reaching_threshold_shipped",
        "correction_tradeoff.streets_silent_in_window_after_correction",
        "correction_tradeoff.hours_of_warning_given_up.median",
        "correction_tradeoff.hours_of_warning_given_up.n",
        "correction_tradeoff.reading",
        "verification_grid.flag_counts.0.stage_ft",
        "verification_grid.flag_counts.0.shipped",
        "verification_grid.flag_counts.0.corrected",
        "verification_grid.tier_onsets_h",
    ],
    "routing_graph.json": [
        "coord_decimals", "max_snap_m", "nodes", "edges", "edge_seg", "segments",
        "facilities", "node_cut_ft", "node_cut_medical_ft",
        "segment_route_cut_ft", "segment_route_cut_medical_ft",
    ],
    "gauge_redundancy.json": [
        "transfer", "validation.regimes.persistence_until_h",
        "validation.regimes.anchor_until_h", "validation.regimes.shift_beyond_h",
        "uncertainty.band_ft",
    ],
    "travel_time_subdaily.json": ["gauges"],
    "address_index.json": [
        "streets", "keys", "ranges", "max_distance_m", "reference.segments",
    ],
    "notifications.json": [
        "tiers.0.id", "tiers.0.hours_before", "tiers.0.label.en", "tiers.0.label.es",
        "templates.en.early", "templates.es.early",
        "templates.en.soon", "templates.es.soon",
        "templates.en.now", "templates.es.now",
        "placeholders", "fallback_street.en", "fallback_street.es",
        "category_es", "ui.en.title", "ui.es.title",
        "policy.quiet_hours.from_local_hour", "policy.quiet_hours.to_local_hour",
        "policy.quiet_hours.exempt", "policy.max_chars",
        "simulation.streets_warned", "simulation.sends", "simulation.duplicates",
        "simulation.sent_after_the_water", "simulation.per_tier.0.tier",
        "verification.0.sends.0.en", "verification.0.sends.0.es",
    ],
    "replay-harvey.json": [
        "points", "peak_ft", "peak_at", "site", "lid", "event", "source",
    ],
    "gauge_history.json": [
        "site", "lid", "unit", "n_peaks", "from", "to", "highest.at", "highest.ft",
        "peaks.0.at", "peaks.0.ft",
    ],
}

ROAD_PROPERTIES = [
    "osmid", "highway", "name", "flood_stage_ft", "mainstem", "levee",
    "confidence", "crossing", "isolation_ft", "isolation_gap_ft", "isolation_status",
]


@pytest.mark.parametrize("artifact", sorted(REQUIRED))
def test_every_required_field_path_exists(artifact, public_json):
    """Each path the app reads is present, and the test names the one that is not."""
    obj = public_json(artifact)
    for path in REQUIRED[artifact]:
        get(obj, path)


def test_road_geojson_properties(public_json):
    gj = public_json("road_thresholds.geojson")
    props = gj["features"][0]["properties"]
    missing = [k for k in ROAD_PROPERTIES if k not in props]
    assert not missing, f"road_thresholds.geojson properties missing {missing}"


def test_road_artifacts_agree_on_segment_count_and_order(public_json, derived_json):
    """The app indexes segments by POSITION, so order is part of the contract.

    The geojson is the half the app fetches; road_thresholds.json stays in
    data/derived as the pipeline's record and is not part of the app payload.
    """
    gj = public_json("road_thresholds.geojson")
    records = derived_json("road_thresholds.json")
    assert len(gj["features"]) == len(records), (
        f"{len(gj['features'])} geojson features vs {len(records)} json records")
    bad = [i for i, (f, r) in enumerate(zip(gj["features"], records))
           if f["properties"]["osmid"] != r["id"]]
    assert not bad, f"geojson and json disagree on osmid at {len(bad)} positions, first {bad[0]}"


def test_thresholds_and_ranges_are_sane(public_json, derived_json):
    records = derived_json("road_thresholds.json")
    lo = min(r["at"] for r in records)
    hi = max(r["at"] for r in records)
    assert 0 < lo < hi < 100, f"flood thresholds outside a plausible range: {lo}..{hi}"
    assert all(r["conf"] in ("modelled", "low") for r in records)
    assert all(r["hw"] for r in records)

    idx = public_json("address_index.json")
    assert idx["ranges"], "address index has no ranges"
    for si, a, b, seg in idx["ranges"]:
        assert 0 <= si < len(idx["streets"]), f"street index {si} out of range"
        assert 0 <= seg < len(records), f"segment index {seg} out of range"
        assert a <= b, f"inverted address range {a}..{b}"
    assert idx["max_distance_m"] > 0
    assert idx["reference"]["segments"] == len(records), (
        "address index was built against a different road_thresholds — "
        "every address would resolve to the wrong street")


def test_probabilities_and_rates_are_in_range(public_json):
    v = public_json("harvey_validation.json")
    for key in ("accuracy", "false_positive_rate", "recall", "prevalence_observed",
                "prevalence_modelled"):
        val = get(v, f"confusion_matrix.{key}")
        assert 0.0 <= val <= 1.0, f"confusion_matrix.{key} = {val} is not a rate"
    assert 0.0 <= get(v, "diagnosis.auc_discrimination") <= 1.0
    sigma = get(v, "diagnosis.threshold_error_model.per_street_sigma_ft")
    assert sigma > 0, "a zero per-street sigma would make the ensemble certain"


def test_exported_files_are_the_derived_files(public_json):
    """The export step copies, it does not transform — except the replay series."""
    copied = ["road_thresholds.geojson", "travel_time_subdaily.json",
              "routing_graph.json", "gauge_redundancy.json",
              "harvey_validation.json", "harvey_backcast.json", "ensemble.json",
              "address_index.json", "notifications.json", "gauge_history.json"]
    for name in copied:
        src = (DERIVED / name).read_bytes()
        dst = (PUBLIC / name).read_bytes()
        assert src == dst, f"{name} differs between data/derived and app/public/data"


def test_no_exported_file_is_unused_by_the_app(root):
    """Every file shipped to the browser must be fetched by the app.

    An exported artifact the app never reads is payload on every page load and a
    deploy that looks successful while carrying dead weight. This test exists
    because it caught exactly that: road_thresholds.json (287 KB) and
    stage_area_curve.json were being shipped and are read by nothing in the app.
    """
    source = ((root / "app" / "src" / "main.ts").read_text()
              + (root / "app" / "index.html").read_text())
    unused = []
    for path in sorted((root / "app" / "public" / "data").iterdir()):
        if path.name not in source:
            unused.append(f"{path.name} ({path.stat().st_size // 1024} KB)")
    assert not unused, (
        "exported to app/public/data but never fetched by the app: " + ", ".join(unused) +
        " — remove them from the export list in pipeline/export/app_data.py")
