#!/usr/bin/env python3
"""
BrazosCast — routing stage: "how do I get out, and can help get in?"

Step 2 answered "when do I lose my last way out?" against *any* dry ground. That
is the right survival question but not an actionable one: it does not say where
to go, and it does not answer the question a household actually asks in an
emergency — *can an ambulance reach me?* This stage puts real destinations on the
same graph and measures the route to them.

METHOD
  Graph       reconstructed by importing isolation.build(), NOT re-implemented.
              That is the point: the routes the app draws must lie on the same
              8,987-node / every-vertex graph the isolation numbers were computed
              on, or the two panels would describe different road networks. A gate
              asserts the node and edge counts match isolation.summary.json, so
              the coupling fails loudly if either builder drifts.

  Destinations real OpenStreetMap facilities (hospital / fire_station / police)
              cached by pipeline/fetch/fetch_facilities.mjs, snapped to the nearest
              graph node. A facility is only accepted if that node is within
              MAX_SNAP_M. This matters: the road extract is a bounding-box clip, so
              a Sugar Land hospital snapped to the corridor edge would advertise a
              "route" along roads that were never modelled. Facilities off the
              network are rejected and reported rather than silently connected.

  Cut stage   the highest Richmond-gauge stage at which a route to a facility still
              exists — the widest-path (max-min) bottleneck from each node to the
              facility set. Computed with isolation.widest_path, the same one-pass
              descending union-find, seeded with the facility nodes instead of all
              dry ground. Cross-checked by BFS at sampled stages.

  Segment     route_cut_ft = max over the segment's vertices of their bottleneck —
              "do I still have a route?" is an existence question, so the last
              route to stay open is the one that matters (isolation.py uses the
              same aggregation and explains why).

  Islands     the same graph, asked a different question: not "can I get to a
              destination" but "which roads can I still move between at all". At
              each rung of a stage ladder the dry edges (threshold above the
              stage) partition the network, and the partition is reported — how
              many pieces, how big the largest is, how many segments can still
              reach a responder without crossing water. This is CHEAPER than the
              cut field above and answers a question it cannot: the cut field says
              whether a destination is reachable, the partition says how much of
              the corridor is still one connected place, which is what "which side
              of the cut am I on" actually means.

              **What the numbers forced, measured before they were written:** the
              corridor is already 116 separate networks at 0 ft, and only 806 of
              1,614 segments sit on a fragment that holds a responder. That is the
              bounding-box clip, not flooding — roads leave the box and come back,
              and this model cannot join them. So "island" is defined here as
              *roads reachable without crossing water*, never as *ground walled
              in*, and every rung reports how many islands touch the clip so the
              difference is visible rather than assumed away.

  Reverse     the same field answers both directions. Because the road graph is
              undirected, the physical path from your street to the hospital is
              identical to the path from the hospital to your street; what differs
              is the question ("can I get out" vs "can help get in") and the
              framing. This is stated here rather than dressed up as an asymmetry
              the data does not have.

OUTPUT
  data/derived/routing_graph.json   the graph, the accepted facilities and the
                                    per-node cut stage, exported for the app so it
                                    routes on exactly this topology (and can check
                                    its own Dijkstra against node_cut_ft) — plus
                                    `clip`: the box edge and the nodes within a
                                    band of it, so the app can say when an island
                                    reaches the study area's own boundary.
  data/derived/routing.summary.json the numbers, the rejections, the islands, the
                                    caveats.

Usage: <env>/bin/python pipeline/derive/routing.py   (run AFTER isolation.py)
"""
import collections
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DERIVED = ROOT / "data" / "derived"
RAW_FACILITIES = ROOT / "data" / "raw" / "osm_facilities.json"
IN_GJ = DERIVED / "road_thresholds.geojson"
ISO_SUM = DERIVED / "isolation.summary.json"
OUT_GRAPH = DERIVED / "routing_graph.json"
OUT_SUM = DERIVED / "routing.summary.json"

sys.path.insert(0, str(HERE))
import isolation  # noqa: E402  (shares build/bfs_reachable/widest_path — deliberate)

MAX_SNAP_M = 400.0     # a facility further than this from any modelled road is not
                       # on the network: connecting it would invent a route.
COORD_DECIMALS = 6     # export precision, ~0.11 m — display only, well under MAX_SNAP_M
CHECK_STAGES = (5.0, 12.0, 20.0, 30.0, 40.0, 45.0, 50.0, 55.0)
EARTH_R = 6_371_000.0

# The island ladder. 0.0 is the rung that makes the finding legible: it is the network
# with no water on it at all, so everything below the top rung is the river's doing and
# everything at 0 ft is the clip's. The rest spans action (20) to above major (50).
ISLAND_STAGES = (0.0, 5.0, 12.0, 20.0, 30.0, 40.0, 45.0, 50.0, 55.0)
# A node this close to the study area's boundary is where a road leaves the extract.
# 250 m is a little over two city blocks: wide enough to catch an endpoint snapped to
# the box edge, narrow enough not to relabel the corridor's interior as an edge.
CLIP_BAND_M = 250.0
ROAD_SUMMARY = DERIVED / "road_thresholds.summary.json"


def build_with_seg(feats, idx):
    """Mirror isolation.build()'s edge construction exactly, but also record which
    segment each edge came from. Duplicating the rule would risk drift, so the
    caller asserts this reproduces isolation.build()'s edge list byte for byte —
    the mapping is only usable if the two agree."""
    edges, seg_of_edge = [], []
    for si, f in enumerate(feats):
        g = f["geometry"]
        at = float(f["properties"]["flood_stage_ft"])
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for p in parts:
            ks = [idx[(round(c[0], isolation.SNAP), round(c[1], isolation.SNAP))] for c in p]
            for a, b in zip(ks, ks[1:]):
                if a != b:
                    edges.append((a, b, at))
                    seg_of_edge.append(si)
    return edges, seg_of_edge


def meters(lon1, lat1, lon2, lat2):
    """Vectorised haversine. Small distances only, so a spherical earth is exact
    enough here (sub-metre over a 40 km corridor)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(a))


# --- islands ---------------------------------------------------------------

def adjacency(node_count, edges):
    """Undirected dry-edge adjacency, built once and shared by every rung."""
    adj = [[] for _ in range(node_count)]
    for a, b, t in edges:
        adj[a].append((b, t))
        adj[b].append((a, t))
    return adj


def union_find_components(node_count, edges, stage):
    """The partition of the network into the regions a driver can move within.

    An edge is passable while the stage is BELOW its threshold (`t > stage`), the same
    comparison isolation.widest_path and the app's map filter use — three places that
    would otherwise be free to disagree about which side of equality is water.
    """
    parent = list(range(node_count))

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:            # second pass, path compression
            parent[a], a = root, parent[a]
        return root

    for a, b, t in edges:
        if t > stage:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    return [find(i) for i in range(node_count)]


def flood_fill_components(node_count, adj, stage):
    """The same partition by breadth-first flooding. Deliberately a different
    algorithm: this exists to disagree, not to be faster."""
    label = [-1] * node_count
    next_label = 0
    for start in range(node_count):
        if label[start] >= 0:
            continue
        label[start] = next_label
        queue = collections.deque([start])
        while queue:
            u = queue.popleft()
            for v, t in adj[u]:
                if t > stage and label[v] < 0:
                    label[v] = next_label
                    queue.append(v)
        next_label += 1
    return label


def canonical(labels):
    """Relabel a partition in order of first appearance.

    Two implementations of "same component" label their groups with arbitrary numbers,
    so the partitions can only be compared once both are numbered by the order the nodes
    are visited. If the relabelled sequences are equal the partitions are identical —
    and if two nodes that belong together are labelled apart, the sequences diverge at
    the first node where it matters.
    """
    seen, out = {}, []
    for x in labels:
        if x not in seen:
            seen[x] = len(seen)
        out.append(seen[x])
    return out


def clip_band(node_lon, node_lat, bbox, band_m):
    """Nodes within `band_m` of the study area's boundary.

    The road extract is a bounding-box clip, so a road that reaches the box edge may well
    continue outside it — where this model has no roads, no thresholds and no
    destinations. Distances go to the four box edges rather than to a convex hull of the
    nodes: the clip IS a rectangle, and a hull would round its corners and call a road in
    a corner "interior", which is the one thing this flag exists to prevent.
    """
    west, south, east, north = bbox
    d = np.full(len(node_lon), np.inf)
    for edge_lon, edge_lat in ((west, None), (east, None), (None, south), (None, north)):
        if edge_lat is None:
            d = np.minimum(d, meters(node_lon, node_lat, edge_lon, node_lat))
        else:
            d = np.minimum(d, meters(node_lon, node_lat, node_lon, edge_lat))
    return d <= band_m


def _attribute(reach, size, touched):
    """Which island a segment is on, when its parts do not all land on one.

    Reads only the partition — most dry segments touching, then most nodes, then the lowest
    island id — so it cannot depend on the order a segment's nodes were enumerated in. That is
    not a style preference: `isolation.build` collects a segment's nodes into a `set`, so the
    order is a property of the builder, and a published count that descended from it would be
    an artefact. The same three comparisons are in app/src/lib/islands.ts, and the ladder is
    checked from both sides against a reversal of every node list.
    """
    best = touched[0]
    for other in touched:
        if (reach[other] > reach[best]
                or (reach[other] == reach[best] and size[other] > size[best])
                or (reach[other] == reach[best] and size[other] == size[best] and other < best)):
            best = other
    return best


def island_ladder(node_count, edges, adj, seg_nodes, thresholds, seed_nodes, cut,
                  clip_set, stages, published_reach):
    """One row per rung of the stage ladder: how the corridor fragments as the river rises.

    The per-island SEGMENT counts need one more decision, and it is the one this whole
    function is arranged around. A road feature can have parts the clip separated, so a dry
    segment's nodes can land on two islands (measured: 1-4 segments per rung); which island
    "the segment is on" is then genuinely ambiguous. The rule is [[attribute]]'s — most dry
    segments touching, then most nodes, then the lowest island id — and every input to it is
    a property of the PARTITION rather than of the order the nodes were enumerated in, because
    the builder collects a segment's nodes in a Python `set` and the app collects them in edge
    order. Without that, a published count would depend on an implementation detail of the
    builder; with it, the reversal gate below can hold the whole ladder still.

    Gates, in the order they run, because each one makes the next meaningful:
      1. two independent partitions (union-find, flood fill) agree at every rung;
      2. the partition agrees with the PUBLISHED cut field — "this segment's component
         holds a responder" must equal "cut_ft is above this stage" — which is how a new
         statistic is tied to a number that already had a gate;
      3. the segment attribution does not depend on the ORDER a segment's nodes are listed in;
      4. the attribution is a partition: every dry segment lands on exactly one island;
      5. the rung at 0 ft reproduces segments_with_route_to_responder exactly;
      6. it is monotone: components only multiply, the largest only shrinks, and segments
         with a responder only lose it as the stage rises;
      7. it is not vacuous, at either end: the network is fragmented below any flooding,
         and the top rung is more fragmented than the bottom.
    """
    rows = []
    for stage in stages:
        uf = union_find_components(node_count, edges, stage)
        fill = flood_fill_components(node_count, adj, stage)
        assert canonical(uf) == canonical(fill), (
            f"union-find and the flood fill disagree on the network's components at "
            f"{stage} ft — the island statistic is describing a partition one of its two "
            f"implementations does not agree with")

        # Island ids compacted in node order: arbitrary labels are not comparable across the
        # two implementations, and the app compacts the same way, so the final tie-break below
        # means the same thing on both sides.
        id_of, island_of = {}, [0] * node_count
        for i in range(node_count):
            r = uf[i]
            if r not in id_of:
                id_of[r] = len(id_of)
            island_of[i] = id_of[r]
        island_count = len(id_of)
        size = [0] * island_count
        for i in range(node_count):
            size[island_of[i]] += 1

        with_responder = {island_of[i] for i in seed_nodes}
        for i in range(node_count):
            # The seed convention from above: a facility node is stamped with its own
            # road's threshold, so "reachable" for a station means "it is the station"
            # rather than "stage < cut".
            here = island_of[i] in with_responder
            published = i in seed_nodes or (cut[i] is not None and stage < cut[i])
            assert here == published, (
                f"at {stage} ft node {i} is on an island with a responder = {here}, but "
                f"segment_route_cut_ft/node_cut_ft says {published} — the island sweep and "
                f"the published cut field describe different networks")

        dry = [i for i in range(len(seg_nodes)) if thresholds[i] > stage and seg_nodes[i]]
        # Sorted lists rather than sets: the rule below is a total order and does not need it, but
        # a set's iteration order is exactly the thing this whole arrangement is refusing to read.
        touched = [sorted({island_of[u] for u in seg_nodes[i]}) for i in dry]
        reach = [0] * island_count
        for islands_here in touched:
            for r in islands_here:
                reach[r] += 1
        seg_island = [_attribute(reach, size, t) for t in touched]
        assert len(seg_island) == len(dry) and all(-1 < r < island_count for r in seg_island), \
            "a dry segment was attributed to an island that does not exist"
        served = sum(1 for r in seg_island if r in with_responder)
        largest = max(range(island_count), key=lambda r: size[r])
        rows.append({
            "stage_ft": stage,
            "components": island_count,
            "largest_component_nodes": size[largest],
            "largest_component_segments": sum(1 for r in seg_island if r == largest),
            "largest_component_reach": reach[largest],
            "islands_touching_the_clip": len({island_of[i] for i in clip_set}),
            "segments_dry": len(dry),
            "segments_dry_with_a_responder": served,
            "segments_on_an_island_without_one": len(dry) - served,
            "segments_touching_more_than_one_island": sum(1 for t in touched if len(t) > 1),
        })

    for a, b in zip(rows, rows[1:]):
        assert b["components"] >= a["components"], (
            f"the corridor has FEWER components at {b['stage_ft']} ft than at "
            f"{a['stage_ft']} ft: raising the water merged two islands")
        assert b["largest_component_nodes"] <= a["largest_component_nodes"], (
            f"the largest island grew from {a['largest_component_nodes']} to "
            f"{b['largest_component_nodes']} nodes as the stage rose")
        assert b["segments_dry_with_a_responder"] <= a["segments_dry_with_a_responder"], (
            f"more segments can reach a responder at {b['stage_ft']} ft than at "
            f"{a['stage_ft']} ft")

    first = rows[0]
    assert first["segments_dry_with_a_responder"] == published_reach, (
        f"at 0 ft the island sweep finds {first['segments_dry_with_a_responder']} segments "
        f"with a dry route to a responder and the cut field finds {published_reach} — the "
        f"two describe different graphs")
    assert first["components"] > 1, (
        "the road extract is a single connected network, so the 'island' language in the "
        "app and the docs no longer describes anything")
    assert rows[-1]["largest_component_nodes"] < first["largest_component_nodes"], (
        "the largest island is the same size at the top of the ladder as at the bottom, so "
        "the sweep is not measuring the river")
    # The attribution is a partition, not a count of touches: every dry segment lands on exactly
    # one island. `largest_component_reach` is the touches, which can exceed it, and the two
    # numbers are published separately so the difference is visible rather than assumed away.
    for row in rows:
        assert row["segments_dry_with_a_responder"] + row["segments_on_an_island_without_one"] \
            == row["segments_dry"], (
            f"the rung at {row['stage_ft']} ft does not account for every dry segment: "
            f"{row['segments_dry_with_a_responder']} with a responder + "
            f"{row['segments_on_an_island_without_one']} without != {row['segments_dry']}")
        assert row["largest_component_segments"] <= row["largest_component_reach"], (
            f"the largest island at {row['stage_ft']} ft is credited with more segments than "
            f"touch it")
    return rows


def main():
    doc = json.loads(IN_GJ.read_text())
    feats = doc["features"]

    # --- the graph, from the one builder that defines it -----------------------
    idx, edges, seg_nodes = isolation.build(feats, "all")
    n = len(idx)
    keys = [None] * n
    for k, i in idx.items():
        keys[i] = k
    node_lon = np.array([k[0] for k in keys])
    node_lat = np.array([k[1] for k in keys])
    print(f"graph (reused from isolation.build): {n} nodes, {len(edges)} edges, "
          f"{len(feats)} segments")

    # --- the study area's own boundary -----------------------------------------
    # BBOX is read from road_thresholds.summary.json rather than restated: that is the
    # box the road extract was clipped to, and a second copy of it here would be free to
    # drift from the one that actually did the clipping.
    bbox = tuple(json.loads(ROAD_SUMMARY.read_text())["bbox"])
    clip_set = {i for i, near in enumerate(clip_band(node_lon, node_lat, bbox, CLIP_BAND_M))
                if near}
    print(f"clip band: {len(clip_set)} of {n} nodes within {CLIP_BAND_M:.0f} m of the "
          f"extract boundary {bbox}")

    # --- destinations ----------------------------------------------------------
    raw = json.loads(RAW_FACILITIES.read_text())
    want = {"hospital", "fire_station", "police"}
    accepted, rejected = [], []
    for f in raw["facilities"]:
        if f["kind"] not in want:
            continue
        d = meters(f["lon"], f["lat"], node_lon, node_lat)
        j = int(np.argmin(d))
        near = float(d[j])
        rec = {"id": f["id"], "kind": f["kind"], "name": f["name"],
               "lon": round(float(f["lon"]), 6), "lat": round(float(f["lat"]), 6),
               "snap_m": round(near, 1), "node": j}
        (accepted if near <= MAX_SNAP_M else rejected).append(rec)

    print(f"\nfacilities: {len(accepted)} on the modelled network "
          f"(<= {MAX_SNAP_M:.0f} m from a graph node), {len(rejected)} rejected")
    for r in sorted(accepted, key=lambda r: (r["kind"], r["snap_m"])):
        print(f"   OK    {r['kind']:12s} {str(r['name'])[:38]:38s} snap {r['snap_m']:6.1f} m")
    for r in sorted(rejected, key=lambda r: r["snap_m"]):
        print(f"   drop  {r['kind']:12s} {str(r['name'])[:38]:38s} snap {r['snap_m']:7.1f} m")

    assert accepted, "no facility landed on the modelled network — routing would be vacuous"

    # --- cut stage to the nearest reachable facility, for every node -----------
    seeds = {r["node"] for r in accepted}
    print(f"facility graph nodes: {len(seeds)}")
    # The highest threshold on any edge touching each node: standing AT a facility,
    # the route to it is usable exactly while its own road holds. widest_path leaves
    # seed nodes None ("you are the destination"), which in the per-segment max below
    # would read as "no route" for a street that touches the station itself — the
    # opposite of the truth. Isolation.py avoids this with an explicit seed branch;
    # here the same intent is expressed as a finite value, which keeps the field
    # comparable and keeps the summary numeric.
    incident = {}
    for a, b, t in edges:
        incident[a] = max(incident.get(a, 0.0), t)
        incident[b] = max(incident.get(b, 0.0), t)

    cut = isolation.widest_path(n, edges, seeds)
    assert all(cut[i] is None for i in seeds), \
        "a facility node was stamped as cut off from itself"
    for s in seeds:
        cut[s] = incident[s]

    # class == "hospital" is what "an ambulance can reach you" turns on; compute
    # that separately so the app can say which kind of help is still available.
    med_nodes = {r["node"] for r in accepted if r["kind"] == "hospital"}
    if med_nodes:
        cut_med = isolation.widest_path(n, edges, med_nodes)
        assert all(cut_med[i] is None for i in med_nodes)
        for s in med_nodes:
            cut_med[s] = incident[s]
    else:
        cut_med = [None] * n

    # --- per-segment answer ----------------------------------------------------
    at = np.array([float(f["properties"]["flood_stage_ft"]) for f in feats])
    route_cut, med_cut = [], []
    for nodes in seg_nodes:
        route_cut.append(max((cut[i] for i in nodes if cut[i] is not None), default=None))
        med_cut.append(max((cut_med[i] for i in nodes if cut_med[i] is not None), default=None))

    reach = sum(1 for v in route_cut if v is not None)
    med_reach = sum(1 for v in med_cut if v is not None)
    trapped = sum(1 for i, v in enumerate(route_cut)
                  if v is not None and v < float(at[i]) - 0.05)
    print(f"\nsegments with a route to a responder at some stage: {reach} of {len(feats)}")
    print(f"segments with a route to a HOSPITAL at some stage:   {med_reach} of {len(feats)}")
    print(f"lose that route BEFORE their own street floods:      {trapped} segments")
    if reach:
        vals = [v for v in route_cut if v is not None]
        print(f"  route cut stage: median {np.median(vals):.1f} ft, "
              f"p25 {np.percentile(vals, 25):.1f}, p75 {np.percentile(vals, 75):.1f}")
    worst = sorted((i for i, v in enumerate(route_cut)
                    if v is not None and v < float(at[i]) - 0.05),
                   key=lambda i: float(at[i]) - (route_cut[i] or 0), reverse=True)
    shown, seen = [], set()
    for i in worst:
        nm = feats[i]["properties"].get("name")
        key = nm or f"osmid {feats[i]['properties']['osmid']}"
        if key in seen:
            continue
        seen.add(key)
        shown.append({"name": nm, "flood_stage_ft": round(float(at[i]), 1),
                      "route_cut_ft": round(route_cut[i], 1),
                      "gap_ft": round(float(at[i]) - route_cut[i], 1)})
        if len(shown) >= 10:
            break
    print("\nlargest gaps (help stops reaching you at X, your street floods at Y):")
    for s in shown:
        print(f"   {str(s['name'] or 'unnamed')[:34]:34s} street {s['flood_stage_ft']:5.1f} ft   "
              f"route cut {s['route_cut_ft']:5.1f} ft   gap {s['gap_ft']:5.1f} ft")

    # --- export for the app ----------------------------------------------------
    # Nodes as 6-decimal fixed-point integers: the app snaps a click to the
    # nearest node and draws the route from these coordinates, so they only need
    # display precision (0.11 m), which halves the payload against float text.
    scale = 10 ** COORD_DECIMALS
    nodes_flat = []
    for i in range(n):
        nodes_flat.append(int(round(node_lon[i] * scale)))
        nodes_flat.append(int(round(node_lat[i] * scale)))
    edges_flat = []
    for a, b, t in edges:
        edges_flat.extend((a, b, int(round(t * 10))))  # threshold in 0.1 ft
    segs = [{"osmid": int(f["properties"]["osmid"]),
             "ft": round(float(f["properties"]["flood_stage_ft"]), 1),
             "hw": f["properties"]["highway"]} for f in feats]
    # segment index per edge, so the app can weight an edge by its own threshold.
    # Derived by replaying the builder and asserting it reproduces it exactly.
    mirror, edge_seg = build_with_seg(feats, idx)
    assert mirror == edges, (
        f"the edge replay does not reproduce isolation.build() "
        f"({len(mirror)} vs {len(edges)} edges) — the edge/segment map is not trustworthy")
    assert len(edge_seg) == len(edges)

    payload = {
        "generated_by": "pipeline/derive/routing.py",
        "note": ("graph identical to the one isolation.py computed on; nodes are "
                 "lon/lat x 1e6; edges are (a, b, threshold_0.1ft) triples in the "
                 "same order as edge_seg, which maps each edge to road_thresholds "
                 "segment index"),
        "coord_decimals": COORD_DECIMALS,
        "max_snap_m": MAX_SNAP_M,
        "stage_ft": {"action": 20.0, "minor": 45.0, "major": 50.0},
        "nodes": nodes_flat,
        "edges": edges_flat,
        "edge_seg": edge_seg,
        "segments": segs,
        "facilities": accepted,
        "clip": {"bbox": list(bbox), "band_m": CLIP_BAND_M, "nodes": sorted(clip_set)},
        "node_cut_ft": [None if v is None else round(float(v), 1) for v in cut],
        "node_cut_medical_ft": [None if v is None else round(float(v), 1) for v in cut_med],
        "segment_route_cut_ft": [None if v is None else round(float(v), 1) for v in route_cut],
        "segment_route_cut_medical_ft": [None if v is None else round(float(v), 1) for v in med_cut],
    }
    OUT_GRAPH.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"\nwrote routing_graph.json ({(OUT_GRAPH.stat().st_size)/1024:.0f} KB)")

    # --- gates -----------------------------------------------------------------
    # 1. the graph is the same one isolation reported. If either builder drifts,
    #    the app's routes and the isolation panel would describe different roads.
    if ISO_SUM.exists():
        iso = json.loads(ISO_SUM.read_text())
        g = iso.get("graph", {})
        assert g.get("nodes") == n and g.get("edges") == len(edges), \
            (f"routing graph {n}/{len(edges)} != isolation graph "
             f"{g.get('nodes')}/{g.get('edges')} — the two stages disagree on the road network")
        print(f"graph matches isolation.summary.json ({n} nodes, {len(edges)} edges)")
    # 2. every accepted facility really is on the network, and the rejections are real.
    for r in accepted:
        assert r["snap_m"] <= MAX_SNAP_M
    for r in rejected:
        assert r["snap_m"] > MAX_SNAP_M
    # 3. a facility node carries its own road's threshold, never None: standing at
    #    the station, the route to it is open while its own road holds. None here
    #    would make a street that touches the station read as having no route.
    assert all(cut[i] == incident[i] for i in seeds), \
        "a facility node does not carry its own incident threshold"
    # 3b. hospital-only field follows the same convention.
    assert all(cut_med[i] == incident[i] for i in med_nodes), \
        "a hospital node does not carry its own incident threshold"
    # 4. independent cross-check: BFS reachability must agree with the bottleneck.
    uniq = sorted({round(float(t), 1) for t in at})
    stages = sorted(set(CHECK_STAGES) | set(uniq[:: max(1, len(uniq) // 8)][:8]))
    for s in stages:
        reach_nodes = isolation.bfs_reachable(n, edges, seeds, float(s))
        for i in range(n):
            expect = i in seeds or (cut[i] is not None and float(s) < cut[i])
            assert bool(reach_nodes[i]) == expect, \
                f"route reachability disagrees with the bottleneck at {s} ft for node {i}"
    # 5. the answer must be monotone in the threshold data it is built from: no
    #    route can survive above the highest threshold on the graph.
    max_t = max(t for _, _, t in edges)
    assert all(v is None or v <= max_t + 1e-9 for v in cut), \
        "a route outlives the highest threshold on the graph"
    # 5b. hospitals are a SUBSET of the responder set, so the best route to any
    #     responder can never be cut before the best route to a hospital: adding
    #     destinations cannot shorten a widest path. Catches any aggregation slip.
    for i, (c, m) in enumerate(zip(route_cut, med_cut)):
        if m is not None:
            assert c is not None and c >= m - 1e-9, \
                f"segment {i} reaches a hospital at {m} ft but no responder at {c} ft"
    # 6. the step is not vacuous: some help really is reachable when the river is low.
    low = isolation.bfs_reachable(n, edges, seeds, 5.0)
    assert sum(low) > 0, "no node can reach a responder at 5 ft — routing is dead"
    # 7. the exported payload round-trips and its arrays line up.
    assert len(nodes_flat) == 2 * n and len(edges_flat) == 3 * len(edges)
    assert len(payload["node_cut_ft"]) == n and len(payload["edge_seg"]) == len(edges)
    assert len(payload["segment_route_cut_ft"]) == len(feats)
    assert {e["node"] for e in payload["facilities"]} == seeds
    assert payload["clip"]["nodes"] and all(0 <= i < n for i in payload["clip"]["nodes"])
    assert payload["clip"]["nodes"] == sorted(clip_set), \
        "the exported clip nodes are not the set the island sweep used"
    print(f"all gates passed ({len(stages)} stages cross-checked by BFS, {n} nodes each)")

    # --- islands ---------------------------------------------------------------
    adj = adjacency(n, edges)
    islands = island_ladder(n, edges, adj, seg_nodes, at, seeds, cut, clip_set,
                            ISLAND_STAGES, reach)
    # The gate that makes the structure safe rather than lucky: a road feature cut into pieces has
    # its nodes collected in a `set`, so the ladder must not read their order. Reversed, every
    # node list, and the ladder has to come out identical — if a future edit reintroduced a
    # first-node rule, this is what refuses to write the artifact.
    reversed_islands = island_ladder(n, edges, adj, [list(reversed(s)) for s in seg_nodes], at,
                                     seeds, cut, clip_set, ISLAND_STAGES, reach)
    assert reversed_islands == islands, (
        "the ladder changes when each segment's node list is reversed, so a published island "
        "count depends on the order the builder happened to enumerate a segment's nodes in")
    print("\nislands — the corridor as connected pieces, dry edges only:")
    print(f"   {'stage':>6}  {'pieces':>7}  {'largest':>8}  {'segs':>6}  {'with help':>9}")
    for r in islands:
        print(f"   {r['stage_ft']:6.1f}  {r['components']:7d}  "
              f"{r['largest_component_nodes']:8d}  {r['largest_component_segments']:6d}  "
              f"{r['segments_dry_with_a_responder']:9d}")
    low, high = islands[0], islands[-1]
    at_action = next(r for r in islands if r["stage_ft"] == 20.0)
    islands_reading = (
        f"Before any flooding the road extract is already {low['components']} separate "
        f"networks, and only {low['segments_dry_with_a_responder']} of {len(feats)} segments "
        f"sit on one that holds a responder: roads leave the bounding box and return, and "
        f"this model cannot join them across the gap. Raising the stage splits what is left "
        f"— {high['components']} pieces at {high['stage_ft']:.0f} ft, the largest island down "
        f"from {low['largest_component_nodes']} to {high['largest_component_nodes']} nodes. "
        f"Islands touching the study area's own boundary, where a road continues outside "
        f"what is modelled: {low['islands_touching_the_clip']} at low water, "
        f"{at_action['islands_touching_the_clip']} at action stage, "
        f"{high['islands_touching_the_clip']} at {high['stage_ft']:.0f} ft. So an island "
        f"here means *roads reachable without crossing water*, never *ground walled in*.")

    summary = {
        "step": "Step 4 — routing and reverse routing",
        "graph": {"nodes": n, "edges": len(edges), "segments": len(feats),
                  "source": "isolation.build(feats, 'all') — the same builder isolation.py uses"},
        "max_snap_m": MAX_SNAP_M,
        "facilities": {
            "accepted": len(accepted),
            "rejected_off_network": len(rejected),
            "by_kind": {k: sum(1 for r in accepted if r["kind"] == k)
                        for k in sorted({r["kind"] for r in accepted})},
            "accepted_list": accepted,
            "rejected_list": rejected,
        },
        "segments_with_route_to_responder": reach,
        "segments_with_route_to_hospital": med_reach,
        "segments_cut_off_before_their_street_floods": trapped,
        "islands": {
            "definition": ("Roads connected to each other at a given stage over edges whose "
                           "threshold is ABOVE that stage — i.e. the ground a driver can "
                           "still move within without crossing water. A cold network is "
                           "already fragmented by the bounding-box clip, so this is "
                           "reachability, not enclosure; `islands_touching_the_clip` counts "
                           "the islands where a road leaves the study area."),
            "clip_boundary": {"bbox": list(bbox), "band_m": CLIP_BAND_M,
                              "nodes_in_band": len(clip_set), "nodes": n,
                              "source": "bbox read from road_thresholds.summary.json — the "
                                        "box the extract was clipped to, not a second copy of it"},
            "stages": list(ISLAND_STAGES),
            "ladder": islands,
            "reading": islands_reading,
        },
        "route_cut_ft": {"median": float(np.median([v for v in route_cut if v is not None])),
                         "p25": float(np.percentile([v for v in route_cut if v is not None], 25)),
                         "p75": float(np.percentile([v for v in route_cut if v is not None], 75))}
        if reach else None,
        "largest_gaps_to_help": shown,
        "reverse_routing": ("the road graph is undirected, so the path from your street to a "
                            "responder is the same physical path as the responder's path to you. "
                            "The two queries differ in framing, not in geometry: forward asks "
                            "'can I get out to help', reverse asks 'can help get in to me'. "
                            "Both are answered from one cut-stage field; the app runs the "
                            "multi-source search outward from the facilities for the reverse view."),
        "checks": {"stages_cross_checked": len(stages), "nodes_per_check": n,
                   "graph_identical_to_isolation": True,
                   "facilities_verified_on_network": True,
                   "bfs_agrees_with_bottleneck": True,
                   "non_vacuous_at_5ft": True},
        "caveats": ("Islands measure drivability, not enclosure: the extract is fragmented "
                    "before any flooding at all (see islands.ladder at 0 ft), so a street on "
                    "an island with no responder is a limit of the bounding-box clip before "
                    "it is a cut-off. A route is a road-network path on the modelled corridor, not a driving "
                    "instruction and not a safety guarantee. The extract is a bounding-box clip, "
                    "so a route cannot leave the study area and a destination outside it is "
                    "rejected rather than connected. Thresholds inherit the -0.92 ft/mile "
                    "HAND-as-stage error documented in road_thresholds.py, so cut stages move "
                    "when that primitive is fixed. OSM facility positions are volunteer-mapped "
                    "and a station may be closed or relocated; nothing here is checked against "
                    "an operational dispatch feed."),
    }
    OUT_SUM.write_text(json.dumps(summary, indent=2))
    print("wrote routing.summary.json")


if __name__ == "__main__":
    main()
