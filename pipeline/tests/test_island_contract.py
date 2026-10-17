"""F4 — the island layer's contract, from the artifact down to the legend.

The island partition is arithmetic and is checked where arithmetic can be checked:
`routing.py` gates it against a second implementation and against the published cut field,
and `app/tests/unit/islands.test.ts` recomputes the whole ladder from the graph the app is
served. What is left is the half a Node test cannot see and a browser cannot falsify without
reaching into WebGL: that the artifact the app reads is the one `road_thresholds.py` clipped
to, and that the boundary the partition produces is the boundary the MAP and the LEGEND are
wired to draw.

That last one is why this file exists at all. A layer whose colour drifts from the legend's
swatch, or a source that is created and never fed, is invisible to every other check here:
the partition is right, the panel is right, and the map silently shows nothing. The assertions
are therefore written against the specific mechanism each claim depends on — the same style as
test_text_mode.py and test_offline.py, and for the same reason.
"""
import json
import re

from conftest import DERIVED, ROOT, get, read_json


def test_the_clip_band_is_the_box_that_did_the_clipping():
    """`routing.py` reads the box from road_thresholds.summary.json rather than restating it.

    A second copy of the clip would be free to drift from the one the road extract was actually
    clipped to, and the drift would be silent: the island boundary would simply move, and every
    number in the ladder would still be self-consistent.
    """
    roads = read_json(DERIVED, "road_thresholds.summary.json")
    graph = read_json(DERIVED, "routing_graph.json")
    summary = read_json(DERIVED, "routing.summary.json")

    islands = summary["islands"]
    assert graph["clip"]["bbox"] == roads["bbox"], (
        f"routing_graph.json clips to {graph['clip']['bbox']} and the road extract was clipped "
        f"to {roads['bbox']} — the island band is measuring the edge of a different box")
    assert graph["clip"]["band_m"] == islands["clip_boundary"]["band_m"]
    assert len(graph["clip"]["nodes"]) == islands["clip_boundary"]["nodes_in_band"], (
        "the nodes the app is told are at the clip are not the set the ladder counted")
    assert len(graph["clip"]["nodes"]) > 0, (
        "no node is within the band of the study area's boundary, so the app can never say that "
        "an island ends at the edge of the model")


def test_the_ladder_is_monotone_and_the_numbers_agree():
    """Raising the water can only split the network and only take routes away."""
    graph = read_json(DERIVED, "routing_graph.json")
    summary = read_json(DERIVED, "routing.summary.json")
    islands = summary["islands"]
    rows = islands["ladder"]

    assert [r["stage_ft"] for r in rows] == list(islands["stages"])
    assert len(rows) >= 8, "the ladder is too short to show a trend"

    for a, b in zip(rows, rows[1:]):
        assert b["components"] >= a["components"], (
            f"{b['stage_ft']} ft has fewer components ({b['components']}) than "
            f"{a['stage_ft']} ft ({a['components']}): water merged two islands")
        assert b["largest_component_nodes"] <= a["largest_component_nodes"], (
            f"the largest island grew as the stage rose, {a['stage_ft']} → {b['stage_ft']} ft")
        assert b["segments_dry_with_a_responder"] <= a["segments_dry_with_a_responder"], (
            f"more segments can reach a responder at {b['stage_ft']} ft than at {a['stage_ft']} ft")

    low, high = rows[0], rows[-1]
    assert low["stage_ft"] == 0.0, "the ladder no longer starts with no water on the network"
    # Nothing is flooded at 0 ft, so every threshold is above the stage and every segment is
    # dry there: the rung is a statement about the network itself rather than about the river.
    assert low["segments_dry"] == 1614, (
        f"at 0 ft only {low['segments_dry']} segments are dry; every threshold is above 0, so a "
        f"segment is being called wet before any water is on the network")
    assert low["segments_dry_with_a_responder"] == summary["segments_with_route_to_responder"], (
        f"at 0 ft the island sweep finds {low['segments_dry_with_a_responder']} segments with a "
        f"dry route to a responder and the published cut field finds "
        f"{summary['segments_with_route_to_responder']} — two numbers for one question")
    # The finding the app's wording rests on: the extract is fragmented before any flooding.
    assert low["components"] > 1, (
        "the road extract is one connected network at 0 ft, so 'island' no longer means what the "
        "panel and this plan say it means")
    assert high["largest_component_nodes"] < low["largest_component_nodes"], (
        "the largest island is the same size at the top of the ladder as at the bottom")


def test_the_reading_quotes_the_ladder_it_descends_from():
    """The sentence in the artifact must not outlive the numbers it states."""
    summary = read_json(DERIVED, "routing.summary.json")
    islands = summary["islands"]
    rows = islands["ladder"]
    reading = islands["reading"]
    low, high = rows[0], rows[-1]
    at_action = next(r for r in rows if r["stage_ft"] == 20.0)

    for value, what in ((low["components"], "components at 0 ft"),
                        (low["segments_dry_with_a_responder"], "segments with a responder at 0 ft"),
                        (summary["graph"]["segments"], "the segment total"),
                        (high["components"], "components at the top rung"),
                        (low["largest_component_nodes"], "the largest island at 0 ft"),
                        (high["largest_component_nodes"], "the largest island at the top rung"),
                        (low["islands_touching_the_clip"], "islands at the clip, low water"),
                        (at_action["islands_touching_the_clip"], "islands at the clip, action stage"),
                        (high["islands_touching_the_clip"], "islands at the clip, top rung")):
        assert f"{value}" in reading or f"{value:,}" in reading, (
            f"the reading does not state {value} ({what}), which the ladder now holds — the "
            f"prose and the numbers have drifted apart: {reading!r}")
    assert "reachable without crossing water" in reading, (
        "the reading no longer defines what an island is here, which is the one thing that stops "
        "'island' being read as 'walled in'")
    assert "<" not in reading and "{" not in reading, (
        f"the reading looks like an unformatted f-string: {reading!r}")


def test_the_attribution_rule_is_held_on_a_fixture_the_shipped_data_cannot_express():
    """Which island a cut road feature belongs to, on the one fixture that can tell the rule
    from its two simpler rivals.

    Measured rather than assumed: replacing `_attribute` with "the lowest island id touching the
    segment" leaves the whole artifact byte-identical — all 20-odd dry segments that straddle two
    islands happen to have their lowest-id island be the one with the most dry segments, so the
    rule and the naive rule cannot be told apart on this dataset at all. Nothing over the
    published numbers can therefore hold the rule, and a later edit could change a published
    count with every artifact gate still green. This graph separates them: island 1 is touched by
    three dry segments and island 0 by two, and segment 0's nodes straddle the two, so the larger
    side is the HIGHER id and "lowest id" / "first node" both put that road on the wrong side.
    """
    import isolation
    import routing

    # Nodes 0-2 and 3-6, joined only by the 10 ft edge 2-3: at 30 ft the two sides are separate
    # islands, at 61 ft no edge is dry at all. The facility sits at node 4, on island 1.
    edges = [(0, 1, 60.0), (1, 2, 60.0), (2, 3, 10.0),
             (3, 4, 60.0), (4, 5, 60.0), (5, 6, 60.0)]
    seeds = {4}
    # The cut field is built the way main() builds it, seed convention included, because the
    # ladder cross-checks its own partition against it at every rung.
    cut = isolation.widest_path(7, edges, seeds)
    incident = {}
    for a, b, t in edges:
        incident[a] = max(incident.get(a, 0.0), t)
        incident[b] = max(incident.get(b, 0.0), t)
    for s in seeds:
        cut[s] = incident[s]
    assert cut[2] == 10.0 and cut[4] == 60.0, (
        f"the fixture's own cut field is not what the graph says: {cut}")

    seg_nodes = [[0, 3], [1], [4], [5]]   # segment 0 is the feature the clip cut into pieces
    thresholds = [60.0] * 4
    adj = routing.adjacency(7, edges)
    rows = routing.island_ladder(7, edges, adj, seg_nodes, thresholds, seeds, cut, {6},
                                 [30.0, 61.0], 3)

    top, last = rows
    assert top["components"] == 2, f"the fixture is not two islands at 30 ft: {top}"
    assert top["segments_touching_more_than_one_island"] == 1, (
        "the straddling segment the fixture is built around is gone")
    # The assertion the rule exists for: the straddling road is attributed to the side it mostly
    # is (three dry segments, on island 1, the higher id), not to the side its lowest node is on.
    assert top["segments_dry_with_a_responder"] == 3, (
        f"the straddling segment was attributed to the lower-id island: {top}")
    assert top["largest_component_segments"] == 3 and top["largest_component_reach"] == 3, (
        f"the largest island holds three dry segments: {top}")
    assert last["segments_dry"] == 0 and last["components"] == 7, (
        f"the top rung of the fixture should have no dry road at all: {last}")

    # And the same ladder when the straddling segment's nodes are listed the other way round,
    # which is the one property the rule is chosen for.
    flipped = routing.island_ladder(7, edges, adj, [[3, 0], [1], [4], [5]], thresholds, seeds,
                                    cut, {6}, [30.0, 61.0], 3)
    assert flipped == rows, (
        "the fixture's ladder reads the order a segment's nodes are listed in")


def test_the_map_layer_and_the_legend_are_wired_to_the_same_colour(root):
    """A boundary drawn in one colour and keyed in another is a boundary nobody can find."""
    src = (root / "app" / "src" / "main.ts").read_text()
    html = (root / "app" / "app.html").read_text()
    # Tokens moved to tokens.css when the landing began sharing them.
    css = ((root / "app" / "src" / "tokens.css").read_text()
           + (root / "app" / "src" / "style.css").read_text())

    token = re.search(r"--island:\s*(#[0-9a-fA-F]{3,8})", css)
    assert token, "style.css no longer defines an --island colour, so the legend has no swatch"
    hexes = set(re.findall(r"#[0-9a-fA-F]{6}", src))
    assert token.group(1).lower() in {h.lower() for h in hexes}, (
        f"the island boundary layer paints {sorted(hexes)} and the legend swatch is "
        f"{token.group(1)} — the map and the key describe the same thing in different colours")

    assert 'addSource("island"' in src and 'id: "island-edge"' in src, (
        "the island boundary layer is gone from buildMap(), so the partition has no picture")
    assert re.search(r"updateIslandLine", src), "nothing draws the boundary any more"
    body = src[src.index("function updateIslandLine"):]
    body = body[:body.index("\n}")]
    assert "v.crossingSegs" in body, (
        "updateIslandLine no longer feeds the source the crossing segments, so the layer is "
        "created and never drawn on")
    assert "var(--island)" in html, (
        "the legend has lost the island entry, so the orange line on the map has no key")


def test_an_island_with_no_drivable_road_is_not_described_by_its_size(root):
    """The contradiction a measurement caught, held so it cannot come back.

    In replay at 40 ft, a street whose own segment the local fire station sits on reported
    "0 of 1,614 segments … a fire or police station is on it": true of the graph (the station's
    node is on that island) and false of the road (its doorstep is under water). The responder
    clause is now guarded on the island having a drivable segment, and the empty island says
    what it is instead of quoting a size.
    """
    src = (root / "app" / "src" / "main.ts").read_text()
    assert "every road connected to this street is under water" in src, (
        "the empty-island case is no longer stated, so an island with nothing drivable on it "
        "would be described only by a count")
    assert re.search(r"if \(v\.segments > 0\) \{", src), (
        "the responder clause is no longer conditional on the island having a drivable segment, "
        "which is how a flooded fire station came to be reported as reachable")


def test_the_shipped_payload_carries_the_clip_the_app_reads():
    """The app reads `clip.nodes`; a field the export dropped is a silently blind island."""
    public = read_json(ROOT / "app" / "public" / "data", "routing_graph.json")
    derived = read_json(DERIVED, "routing_graph.json")
    assert "clip" in public and public["clip"] == derived["clip"], (
        "app/public/data/routing_graph.json and data/derived/routing_graph.json disagree on the "
        "clip band — re-run pipeline/export/app_data.py")
    nodes = get(public, "clip.nodes")
    count = get(public, "nodes")
    assert all(0 <= i < len(count) // 2 for i in nodes), (
        "a clip node index is outside the exported node array")
