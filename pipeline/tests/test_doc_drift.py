"""T2 — documentation / artifact drift.

The project's stated fear is docs and artifacts telling different stories. Every
published figure exists in two places: a JSON artifact and a sentence. This test
holds the sentence to the artifact.

Each claim names the document that must carry it. An earlier version searched the
two documents CONCATENATED, which meant a number could drift out of the README and
still pass because FINDINGS.md still mentioned it — a deliberate-mutation check
caught that, and the per-document assertion is the fix.

This is not hypothetical: the first real catch was the README listing
"State Highway 6" among the ways below action stage, when the artifact puts SH 6's
minimum at 29.3 ft — above action stage at 20 — and names it only for
OVER-prediction. `test_the_sh6_error_stays_fixed` is the regression on that.
"""
import collections
import json
import re

import pytest

from conftest import PUBLIC, ROOT, get

README = "README.md"
FINDINGS = "docs/FINDINGS.md"


def doc(name: str) -> str:
    path = ROOT / name
    assert path.exists(), f"{name} is missing"
    return path.read_text()


def assert_number_stated(text: str, value: float, pattern: str, tol: float, label: str):
    """Assert a document states an artifact value, to the precision it states it.

    Comparing formatted strings is brittle in a way that hides real drift: a doc
    writing "+22.3" and an artifact holding 22.30 must agree, while a doc writing
    "+22.3" against an artifact holding 22.34 must NOT. So extract the numbers the
    document actually contains and compare them within the stated precision.
    """
    found = [float(m) for m in re.findall(pattern, text)]
    assert found, f"{label} ({value}) is not stated in the document at all"
    if not any(abs(f - value) <= tol for f in found):
        closest = min(found, key=lambda f: abs(f - value))
        raise AssertionError(
            f"{label}: the artifact says {value}, the document's closest value is {closest}"
            f" (stated: {sorted(set(found))[:6]})")


def test_segment_count_is_stated(derived_json):
    records = derived_json("road_thresholds.json")
    n = len(records)
    assert n == 1614, f"segment count moved to {n}; the docs and gates assume 1,614"
    assert f"{n:,}" in doc(README), f"the README never states the shipped segment count {n:,}"


def test_median_threshold_is_stated(derived_json):
    records = derived_json("road_thresholds.json")
    thresholds = sorted(r["at"] for r in records)
    median = thresholds[len(thresholds) // 2]
    assert f"{median:.1f}" in doc(README), (
        f"the artifact's median threshold is {median:.1f} ft and the README does not state it")


def test_low_confidence_count_is_stated(derived_json):
    summary = derived_json("road_thresholds.summary.json")
    n = summary["low_confidence_segments"]
    actual = sum(1 for r in derived_json("road_thresholds.json") if r["conf"] != "modelled")
    assert actual == n, (
        "road_thresholds.summary.json disagrees with road_thresholds.json on low-confidence: "
        f"{n} vs {actual}")
    assert f"{n} segments are flagged" in doc(README), (
        f"the summary says {n} flagged segments; the README does not state that")


def test_below_action_highways_match_the_defect_list(derived_json):
    """Counts AND the named ways, because the way list was the part that drifted."""
    summary = derived_json("road_thresholds.summary.json")
    listed = summary["known_defect"]["classified_highways_below_action"]
    records = derived_json("road_thresholds.json")
    primary = [r for r in records
               if r["hw"] == "primary" and r["at"] < summary["action_stage_ft"]]

    # Segments and WAYS are different numbers and the difference is the point: one
    # osmid can carry several segments. The defect list is deduplicated by way, so
    # compare way sets and assert the duplication that makes the counts differ.
    primary_ways = {r["id"] for r in primary}
    listed_ways = {c["osmid"] for c in listed}
    assert primary_ways == listed_ways, (
        "the defect list and the data disagree on which ways are below action: "
        f"only in data {sorted(primary_ways - listed_ways)}, "
        f"only in list {sorted(listed_ways - primary_ways)}")
    assert len(primary) > len(primary_ways), (
        "no way carries more than one below-action segment, so the shipped "
        f"'{len(primary)} segments / {len(primary_ways)} ways' pairing no longer holds")

    text = doc(README)
    for way in {c["name"] for c in listed}:
        assert way in text, f"the defect list names {way!r} and the README does not"


def test_the_sh6_error_stays_fixed(derived_json):
    """Regression on the specific drift this test first caught."""
    summary = derived_json("road_thresholds.summary.json")
    ways = {c["name"] for c in summary["known_defect"]["classified_highways_below_action"]}
    assert not any("Highway 6" in w for w in ways), (
        "State Highway 6 is in the below-action list again")

    match = re.search(r"\d+ classified highway segments[^\n]*", doc(README))
    assert match, "the below-action paragraph disappeared from the README"
    assert "State Highway 6" not in match.group(0), (
        "the README names State Highway 6 among the below-action ways; the artifact says "
        "its minimum is 29.3 ft, above action stage")


def test_harvey_error_model_is_stated(derived_json):
    v = derived_json("harvey_validation.json")
    best_cut = get(v, "estimators_of_the_same_lift.best_cut_ft")
    probit = get(v, "estimators_of_the_same_lift.probit_mle_ft")
    sigma = get(v, "diagnosis.threshold_error_model.per_street_sigma_ft")

    readme = doc(README)
    # The README states these at one decimal place, so compare to half a unit there.
    assert_number_stated(readme, best_cut, r"\+(\d+\.\d+) ft", 0.05, "best-cut lift")
    assert_number_stated(readme, probit, r"\+(\d+\.\d+) ft", 0.05, "probit lift")
    # Sigma is documented where the estimator is: FINDINGS carries the method. The
    # README states its consequence instead, which the next test checks.
    assert_number_stated(doc(FINDINGS), sigma, r"(\d+\.\d+) ft", 0.005,
                         "per-street sigma")


def test_ensemble_claims_match_the_verification_grid(derived_json):
    """The README quotes ensemble counts; they must be rows of the shipped grid."""
    grid = derived_json("ensemble.json")["verification_grid"]
    assert grid, "the ensemble verification grid is empty"
    readme = doc(README)

    # The README's strongest claim is that at the top of the modelled range nobody
    # should act on the point estimate. That is only honest if a grid row says so.
    certain_never = [r for r in grid if r["crossing"] == 0]
    assert certain_never, (
        "no grid row has zero crossings, so the README's '0 of 50' claim is unsupported")
    assert any(r["never_h"] == r["of"] for r in certain_never), (
        "the zero-crossing rows do not have every member never reaching the street")
    assert f"0 of {certain_never[0]['of']}" in readme, (
        "the README no longer states the 0-of-50 result the grid supports")

    # Every grid row must carry the distribution, not just a count, or the
    # "distribution not a point" claim is only half true.
    for row in grid:
        assert "median_h" in row and "never_h" in row
        if row["crossing"] == 0:
            assert row["median_h"] is None, "a never-crossing row reports a median"
        else:
            assert row["median_h"] is not None


def test_backcast_headline_numbers_are_stated(derived_json):
    bc = derived_json("harvey_backcast.json")
    median = get(bc, "street_lead_time.median_h")
    action = get(bc, "tiers.0.hours_before_crest")
    flags = get(bc, "correction_tradeoff.flags_at_crest.shipped")
    total = get(bc, "correction_tradeoff.flags_at_crest.of")
    text = doc(README)
    assert f"{median:.0f}" in text, f"the backcast's median street lead time ({median:.0f} h) is not stated"
    assert f"{action:.0f}" in text, f"the action-stage onset ({action:.0f} h) is not stated"
    assert f"{flags:,}" in text, f"the {flags:,} shipped flags at the crest are not stated"
    assert f"{total:,}" in text, f"the segment total {total:,} is not stated"


def test_the_island_table_matches_the_ladder_it_came_from(derived_json):
    """FINDINGS §14 lays all nine rungs out in one table, which is exactly the shape that gets
    left behind by a re-run: the prose numbers are checked elsewhere, the table is not."""
    rows = derived_json("routing.summary.json")["islands"]["ladder"]
    assert len(rows) == 9, f"the ladder has {len(rows)} rungs and the table nine"
    text = doc(FINDINGS)
    for r in rows:
        stage = f"| {r['stage_ft']:g} ft"
        cells = [f"{r[k]:,}" for k in
                 ("components", "largest_component_nodes", "largest_component_segments",
                  "segments_dry", "segments_dry_with_a_responder", "islands_touching_the_clip",
                  "segments_touching_more_than_one_island")]
        assert stage in text, f"FINDINGS §14's table has no row for {r['stage_ft']} ft"
        missing = [c for c in cells if f"| {c} |" not in text]
        assert not missing, (
            f"the {r['stage_ft']} ft row of the §14 table does not state {missing} — the table "
            f"and the ladder have drifted apart")


def test_the_multi_part_feature_count_is_the_layer_s_own():
    """§14 explains the straddling-segment rule by the road layer's multi-part features, so the
    count that explanation rests on has to come from the layer rather than from a probe run once.
    It is the number a reader would quote to justify the rule existing at all."""
    layer = json.loads((PUBLIC / "road_thresholds.geojson").read_text())
    ways = collections.Counter(f["properties"]["osmid"] for f in layer["features"])
    multi = sum(1 for n in ways.values() if n > 1)
    assert multi > 0, "no way in the layer carries more than one segment, so the rule is moot"
    text = doc(FINDINGS)
    assert f"{multi} of the {len(ways):,} distinct ways" in text, (
        f"the road layer holds {len(layer['features']):,} segments on {len(ways):,} distinct "
        f"ways, {multi} of which carry more than one — FINDINGS §14 does not state that")


def test_isolation_and_routing_counts_are_stated(derived_json):
    iso = derived_json("isolation.summary.json")
    routing = derived_json("routing.summary.json")
    text = doc(README)
    trapped = iso["trapped_before_flood"]
    assert str(trapped) in text, f"the trapped-before-flood count {trapped} is not stated"
    cut = routing["segments_cut_off_before_their_street_floods"]
    assert str(cut) in text, f"the routing figure {cut} is not stated"


def test_every_findings_reference_resolves_to_a_section():
    """A citation of a section that does not exist is the cheapest drift there is.

    `app/src/lib/islands.ts` and the README both pointed the reader at a FINDINGS section while
    the document stopped one short of it: the method is cited, the method is not written down,
    and every other check in this file reads numbers rather than cross-references. So each "§N"
    that names FINDINGS has to name a heading that exists.
    """
    findings = doc(FINDINGS)
    headings = {int(m.group(1)) for m in re.finditer(r"^## (\d+)\.", findings, re.M)}
    assert headings, "docs/FINDINGS.md no longer has numbered sections"

    # Read from text: a source file that cites a section is stating that the method is
    # written down there, and that claim is checkable without executing anything.
    scan = ([ROOT / "README.md"] + sorted((ROOT / "docs").glob("*.md"))
            + sorted((ROOT / "app" / "src").rglob("*"))
            + sorted((ROOT / "app" / "tests").rglob("*"))
            + sorted((ROOT / "pipeline").rglob("*.py"))
            + sorted((ROOT / "pipeline").rglob("*.mjs"))
            + sorted((ROOT / "scripts").glob("*")))
    refs: dict[int, set[str]] = {}
    for path in scan:
        if path.is_dir() or path.suffix not in {".md", ".ts", ".py", ".mjs", ".html", ".css"}:
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):   # a binary or unreadable file cites nothing
            continue
        for m in re.finditer(r"FINDINGS(?:\.md)?\)?\s*§\s*(\d+)", text):
            refs.setdefault(int(m.group(1)), set()).add(str(path.relative_to(ROOT)))
    assert refs, "nothing cites FINDINGS.md by section any more, so this check is vacuous"

    missing = {n: sorted(who) for n, who in refs.items() if n not in headings}
    assert not missing, (
        f"these sections are cited but do not exist: {missing} — FINDINGS.md has "
        f"{sorted(headings)}. A reference to a method that is not written down is drift "
        f"whether or not a number moved")


def test_the_landing_bias_is_the_artifact_s_too(root):
    """The landing states the threshold bias as well, and it typed "24 ft" into its prose.

    Two documents holding one measured number is drift whether or not anyone re-runs the
    pipeline, so the landing must read it from the same artifact the app discloses it from and
    leave the sentence as an empty slot a script fills. The slot is what is asserted, not the
    wording: a sentence that can still be written without the number is fine, a sentence with
    the number in it is not.
    """
    html = (root / "app" / "index.html").read_text()
    src = (root / "app" / "src" / "landing.ts").read_text()
    assert 'id="biasFt"' in html, "the landing's bias sentence lost the element the script fills"

    # The sentence specifically, tags stripped: the shipped wording put the number inside <b>,
    # so searching the markup for the phrase would have missed the very thing it is guarding.
    section = re.search(r'id="planning".*?</section>', html, re.S)
    assert section, "the landing's planning section is gone"
    sentence = re.sub(r"<[^>]+>", " ", section.group(0))
    assert re.search(r"biased low", sentence), "the bias sentence is gone from the landing"
    assert not re.search(r"\d+\s*(?:ft\s*)?low|low\s*(?:by\s*)?\d+", sentence), \
        "the landing types the measured lift into its markup; it drifts the moment the fit moves"
    assert "harvey_validation.json" in src, \
        "the landing no longer reads the artifact the app discloses the bias from"
    assert "biasFt" in src, "nothing fills the landing's bias sentence"


def test_the_app_disclosure_is_driven_by_the_artifact(derived_json, root):
    """The app tells the user their threshold runs low. That sentence must be
    computed from the artifact rather than hard-coded, or it will drift silently."""
    src = (root / "app" / "src" / "main.ts").read_text()
    assert re.search(r"run about \$\{[^}]*\} ft low", src), (
        "the app's threshold-error disclosure no longer interpolates the measured lift; "
        "check it is not a hard-coded number that will drift from harvey_validation.json")
