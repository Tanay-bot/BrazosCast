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
                                    its own Dijkstra against node_cut_ft).
  data/derived/routing.summary.json the numbers, the rejections, the caveats.

Usage: <env>/bin/python pipeline/derive/routing.py   (run AFTER isolation.py)
"""
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
    print(f"all gates passed ({len(stages)} stages cross-checked by BFS, {n} nodes each)")

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
        "caveats": ("A route is a road-network path on the modelled corridor, not a driving "
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
