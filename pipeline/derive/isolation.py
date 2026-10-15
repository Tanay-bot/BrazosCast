#!/usr/bin/env python3
"""
BrazosCast — isolation stage: "when can I no longer leave?"

The app's existing question is "when does my street flood?". The question that
actually kills people is "when do I lose my last way out?" — a different number,
and always <= the first.

Reads data/derived/road_thresholds.geojson and adds two fields per feature:

    isolation_ft      the Richmond-gauge stage at which this segment's last route
                      to ground that stays dry at major stage is cut. null when
                      no such route exists at any stage.
    isolation_gap_ft  flood_stage_ft - isolation_ft. Positive means you are
                      trapped BEFORE your own street goes under, and the size of
                      the gap is the warning you currently do not get.

METHOD
  Graph      every vertex of every segment is a node; consecutive vertices of a
             segment are edges carrying that segment's flood threshold. The
             extract turns out to be already fully noded — every intersection is
             an exact shared vertex, and shapely's unary_union inserts ZERO new
             points — so no geometric noding is needed. What is needed is using
             ALL vertices. The obvious "one edge per segment, endpoints only"
             graph collapses 8,987 vertices to 2,430 and fragments the corridor
             into 177 components (largest 275 nodes) instead of 116 (largest
             2,148). That is the under-connection the earlier prototype admitted
             to, quantified: under-connecting removes paths, so it reports
             isolation too early.

  Refuge     a node incident to an edge whose threshold exceeds the gauge's major
             stage (50 ft) — ground the modelled water does not reach at major
             flood. This is a statement about the data rather than a heuristic:
             a segment's threshold IS the water level that reaches that ground.

  Isolation  the widest-path bottleneck from a node to the refuge set — the
             highest stage at which some route to dry ground still exists. It is
             computed in ONE pass, not one pass per stage: edges are added in
             descending threshold order and a node is stamped the moment its
             component first joins a refuge component. Monotone by construction,
             O(E log E) overall.

             isolation_ft is null when no dry ground is reachable from the
             segment's fragment at ANY stage. That is the most severe answer
             this stage can give, not missing data, and it is labelled
             isolation_status="no_dry_refuge" so nothing reads as a silent hole.
             883 of 1,614 segments are in that state — fragments of the corridor
             whose highest modelled road is still below major stage.

  Segment    isolation_ft = min(flood_stage_ft, MAX over the segment's nodes of
             their bottleneck). Two deliberate choices there:

             max, not min, because the question is "do I still have a way out?"
             — that is an existence question, so the last exit to go is the one
             that matters. (min would report you trapped the moment your
             best-connected point was cut, which over-reports.)

             the min against flood_stage_ft is not a fudge to make a gate pass:
             once your own street is under water you cannot leave either, so the
             street's own threshold bounds "you lose every exit". Both terms are
             reported separately (isolation.summary.json) so a reader can see
             which one binds.

             Note 196 of the 1,614 features are multipart with parts that do not
             touch — genuinely separate road fragments sharing one osmid. Edges
             are built per part, so no phantom link is drawn between them, and a
             segment's vertices legitimately span more than one component.

CAVEATS (written into the summary, not hidden)
  Reachability is a road-network property, not a guarantee of safety. A refuge
  node is ground the modelled water does not reach at 50 ft — not a shelter, not
  a destination, and not validated against where people actually went. It
  inherits every threshold error documented in road_thresholds.py, including the
  -0.92 ft/mile along-river slope, so the absolute stages here move when the
  threshold primitive is fixed (see UPGRADE-PLAN.md step 3). The structure — who
  is trapped before they flood, and by how much — is what this stage contributes.

Usage: <env>/bin/python pipeline/derive/isolation.py   (run AFTER road_thresholds.py)
Output: rewrites data/derived/road_thresholds.{geojson,json} with the new fields,
        writes data/derived/isolation.summary.json
"""
import json
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
IN_GJ = DERIVED / "road_thresholds.geojson"
IN_JS = DERIVED / "road_thresholds.json"
OUT_SUM = DERIVED / "isolation.summary.json"

REFUGE_FT = 50.0    # NWS major stage at RMOT2 — ground dry at major flood
SNAP = 7            # ~1 cm, the extract's own coordinate precision
CHECK_STAGES = (5.0, 9.2, 12.0, 20.0, 25.0, 30.0, 33.4, 40.0, 45.0, 48.0, 50.0, 55.0)


def build(feats, mode):
    """Node the road network. mode='all' uses every vertex; 'endpoint' is the
    one-edge-per-segment baseline the prototype used (for the diagnostic only).

    Edges are built strictly WITHIN each part of a geometry. Chaining across
    parts would invent a link between fragments that do not touch, of which
    there are 196 among these features."""
    idx, edges, seg_nodes = {}, [], []

    def node(c):
        k = (round(c[0], SNAP), round(c[1], SNAP))
        i = idx.get(k)
        if i is None:
            i = idx[k] = len(idx)
        return i

    for f in feats:
        g = f["geometry"]
        at = float(f["properties"]["flood_stage_ft"])
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        if mode == "endpoint":
            ks = [node(parts[0][0]), node(parts[-1][-1])]
            if ks[0] != ks[1]:
                edges.append((ks[0], ks[1], at))
            seg_nodes.append(ks)
            continue
        here = set()
        for p in parts:
            ks = [node(c) for c in p]
            here.update(ks)
            for a, b in zip(ks, ks[1:]):
                if a != b:
                    edges.append((a, b, at))
        seg_nodes.append(sorted(here))
    return idx, edges, seg_nodes


def components_of(n, edges):
    """Connected-component root for every node (ignoring thresholds)."""
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for u, v, _ in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    return [find(i) for i in range(n)]


def widest_path(n, edges, seeds):
    """One pass, descending by threshold. Returns access[i] = the highest stage
    at which node i can still reach a refuge, or None if it never can. Refuge
    nodes themselves stay None (they are the destination, never isolated)."""
    parent = list(range(n))
    size = [1] * n
    has = [False] * n
    members = [[i] for i in range(n)]
    access = [None] * n

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for s in seeds:
        has[s] = True

    for u, v, t in sorted(edges, key=lambda e: -e[2]):
        ru, rv = find(u), find(v)
        if ru == rv:
            continue
        if size[ru] < size[rv]:          # keep the larger tree as the root
            ru, rv = rv, ru
        hu, hv = has[ru], has[rv]
        # Exactly one side already touches dry ground: the other side is stamping
        # in at this threshold, which is the smallest edge on its widest path.
        if hu and not hv:
            for m in members[rv]:
                access[m] = t
        elif hv and not hu:
            for m in members[ru]:
                access[m] = t
        members[ru].extend(members[rv])
        members[rv] = []
        parent[rv] = ru
        size[ru] += size[rv]
        has[ru] = hu or hv
    return access


def bfs_reachable(n, edges, seeds, stage):
    """Independent re-implementation of 'reachable at this stage', used as a
    cross-check on the union-find pass. Deliberately a different algorithm."""
    adj = [[] for _ in range(n)]
    for u, v, t in edges:
        if t > stage:                    # edge is passable below its threshold
            adj[u].append(v)
            adj[v].append(u)
    seen = bytearray(n)
    stack = list(seeds)
    for s in stack:
        seen[s] = 1
    while stack:
        a = stack.pop()
        for b in adj[a]:
            if not seen[b]:
                seen[b] = 1
                stack.append(b)
    return seen


def main():
    doc = json.loads(IN_GJ.read_text())
    feats = doc["features"]
    for f in feats:                      # idempotent: re-runs do not stack
        f["properties"].pop("isolation_ft", None)
        f["properties"].pop("isolation_gap_ft", None)
    print(f"segments: {len(feats)}")

    idx, edges, seg_nodes = build(feats, "all")
    n = len(idx)
    comp_of = components_of(n, edges)
    comps = len(set(comp_of))
    print(f"all-vertex graph: {n} nodes, {len(edges)} edges, {comps} components")

    bidx, bedges, _ = build(feats, "endpoint")
    bcomps = len(set(components_of(len(bidx), bedges)))
    print(f"endpoint-only baseline: {len(bidx)} nodes, {len(bedges)} edges, {bcomps} components")
    print(f"  -> using every vertex merges {bcomps} -> {comps} components "
          f"(the under-connection the prototype warned about, quantified)")

    seeds = {i for e in edges if e[2] > REFUGE_FT for i in (e[0], e[1])}
    print(f"refuge nodes (incident to an edge surviving {REFUGE_FT:.0f} ft): {len(seeds)}")

    access = widest_path(n, edges, seeds)

    # A refuge node is the destination, so it must never be stamped as isolated.
    assert all(access[i] is None for i in seeds), "a refuge node was stamped as isolated"

    at = np.array([float(f["properties"]["flood_stage_ft"]) for f in feats])
    node_iso, no_refuge = [], 0
    for nodes in seg_nodes:
        # "Do I still have a way out?" is an existence question, so the segment's
        # answer is the LAST exit to go: max over its vertices. A vertex that can
        # never reach refuge at any stage contributes nothing (it is not an exit),
        # and a vertex that is itself refuge ground makes the segment never isolated.
        best = None
        for i in nodes:
            if i in seeds:
                best = np.inf
                break
            if access[i] is not None:
                best = access[i] if best is None else max(best, access[i])
        if best is None:
            node_iso.append(None)
            no_refuge += 1
        else:
            node_iso.append(best)

    iso = [None if v is None else min(float(v), float(a))
           for v, a in zip(node_iso, at)]
    gap = [None if v is None else float(a) - v for v, a in zip(iso, at)]

    defined = [v for v in iso if v is not None]
    gaps = [g for g in gap if g is not None]
    trapped = [i for i, g in enumerate(gap) if g is not None and g > 0.05]
    in_defined = sum(1 for i, v in enumerate(node_iso)
                     if v is not None and float(v) > float(at[i]) + 1e-9)
    print(f"\nNO dry refuge reachable at any stage: {no_refuge} segments "
          f"(isolation_status=no_dry_refuge — the most severe answer, not missing data)")
    print(f"isolation defined for {len(defined)} segments; "
          f"median {np.median(defined):.1f} ft, p25 {np.percentile(defined, 25):.1f}, "
          f"p75 {np.percentile(defined, 75):.1f}")
    print(f"trapped BEFORE the street floods (gap > 0): {len(trapped)} segments")
    if gaps:
        print(f"  gap: median {np.median(gaps):.1f} ft, p75 {np.percentile(gaps, 75):.1f} ft, "
              f"max {max(gaps):.1f} ft")
    print(f"  of those with a defined answer, {in_defined} are bounded by their own street — "
          f"the road network outlasts the flood there, so nothing is cut early")

    worst = sorted((i for i in range(len(feats)) if gap[i] is not None and gap[i] > 0.05),
                   key=lambda i: -gap[i])
    show, seen = [], set()
    for i in worst:
        nm = feats[i]["properties"].get("name")
        key = nm or f"osmid {feats[i]['properties']['osmid']}"
        if key in seen:
            continue
        seen.add(key)
        show.append({"name": nm, "osmid": int(feats[i]["properties"]["osmid"]),
                     "highway": feats[i]["properties"]["highway"],
                     "flood_stage_ft": round(float(at[i]), 1),
                     "isolation_ft": round(float(iso[i]), 1),
                     "gap_ft": round(float(gap[i]), 1)})
        if len(show) >= 12:
            break
    print("\nlargest gaps (you are cut off at X, your street floods at Y):")
    for s in show:
        print(f"   {(s['name'] or 'unnamed')[:34]:34s} street {s['flood_stage_ft']:5.1f} ft   "
              f"cut off {s['isolation_ft']:5.1f} ft   gap {s['gap_ft']:5.1f} ft")

    # --- write the fields back onto both artifacts -----------------------------
    # A null isolation_ft is NOT missing data: it means no modelled ground dry at
    # major stage is reachable from this segment at any stage — the most severe
    # answer this stage can give. It is labelled so the app can say so.
    status = ["no_dry_refuge" if v is None else "computed" for v in iso]
    for f, v, g, st in zip(feats, iso, gap, status):
        # Key order here is deliberately status-first: it is the order already in
        # the checked-in artifact, and matching it keeps regenerating this 1 MB
        # single-line GeoJSON from showing up as a whole-file diff.
        f["properties"]["isolation_status"] = st
        f["properties"]["isolation_ft"] = None if v is None else round(float(v), 1)
        f["properties"]["isolation_gap_ft"] = None if g is None else round(float(g), 1)
    head = ('{\n"type": "FeatureCollection",\n"name": "road_thresholds",\n'
            '"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n'
            '"features": [\n')
    IN_GJ.write_text(head + ",\n".join(json.dumps(f, separators=(",", ":")) for f in feats) + "\n]\n}\n")

    payload = json.loads(IN_JS.read_text())
    for p, v, g, st in zip(payload, iso, gap, status):
        p["iso"] = None if v is None else round(float(v), 1)
        p["gap"] = None if g is None else round(float(g), 1)
        p["isoStatus"] = st
    IN_JS.write_text(json.dumps(payload))

    # How much does the refuge bar itself drive the answer? Recomputed from the
    # edge set, so the reader can see the choice rather than take it on faith.
    comp_max = {}
    for u, v, t in edges:
        comp_max[comp_of[u]] = max(comp_max.get(comp_of[u], 0.0), t)
    sensitivity = {}
    for bar in (35.0, 40.0, 45.0, 50.0, 55.0):
        sensitivity[str(bar)] = sum(
            1 for nodes in seg_nodes if comp_max.get(comp_of[nodes[0]], 0.0) <= bar)
    print("\nrefuge-bar sensitivity (segments in fragments with no road above the bar):")
    for bar, k in sensitivity.items():
        print(f"   {bar:>5} ft -> {k:4d} segments")

    # --- gates -----------------------------------------------------------------
    # 1. isolation can never exceed the segment's own flood stage.
    for i, v in enumerate(iso):
        assert v is None or v <= float(at[i]) + 1e-9, \
            f"segment {i} is isolated after it floods ({v} > {at[i]})"
    # 2. the whole point: some segments really are trapped early. If this ever hits
    #    zero the computation is broken, not the river.
    assert len(defined) > 0.25 * len(feats), "no dry refuge is reachable from most segments — graph bug"
    assert len(trapped) > 0, "no segment is trapped before it floods — the stage produced no signal"
    # 3. independent cross-check: BFS reachability must agree with the union-find
    #    bottleneck at every sampled stage, boundaries included.
    uniq = sorted({round(float(t), 1) for t in at})
    stages = sorted(set(CHECK_STAGES) | set(uniq[:: max(1, len(uniq) // 8)][:8]))
    for s in stages:
        reach = bfs_reachable(n, edges, seeds, float(s))
        for i in range(n):
            expect = i in seeds or (access[i] is not None and float(s) < access[i])
            assert bool(reach[i]) == expect, \
                f"reachability disagrees with the bottleneck at {s} ft for node {i}"
    # 4. the topology fix must actually connect more than the endpoint-only graph.
    assert comps < bcomps, "the all-vertex graph did not improve on endpoint-only connectivity"
    # 5. every segment is reported either way — no silent nulls, and status must
    #    agree with the value it describes.
    for f, v, st in zip(feats, iso, status):
        assert f["properties"]["isolation_status"] == st, "status does not match the value"
        assert (v is None) == (st == "no_dry_refuge"), \
            "a null isolation_ft is not labelled no_dry_refuge"
    assert sum(1 for s in status if s == "no_dry_refuge") == no_refuge
    print(f"\nall gates passed ({len(stages)} stages cross-checked by BFS, "
          f"{n} nodes each)")
    print("Wrote data/derived/isolation.summary.json + added isolation_ft to road_thresholds.{geojson,json}")

    summary = {
        "refuge_stage_ft": REFUGE_FT,
        "segments": len(feats),
        "graph": {"nodes": n, "edges": len(edges), "components": comps,
                  "refuge_nodes": len(seeds), "snap_decimals": SNAP,
                  "baseline_endpoint_only": {"nodes": len(bidx), "edges": len(bedges),
                                             "components": bcomps}},
        "isolation_defined": len(defined),
        "no_dry_refuge_reachable": no_refuge,
        "trapped_before_flood": len(trapped),
        "network_outlasts_street": in_defined,
        "refuge_bar_sensitivity_no_dry_refuge": sensitivity,
        "isolation_ft": {"median": float(np.median(defined)),
                         "p25": float(np.percentile(defined, 25)),
                         "p75": float(np.percentile(defined, 75)),
                         "min": float(min(defined)), "max": float(max(defined))},
        # gap over ALL segments with a defined answer (mostly zeros), and over the
        # trapped subset only — the second is the one quoted in README/FINDINGS.
        "gap_ft": {"median": float(np.median(gaps)), "p75": float(np.percentile(gaps, 75)),
                   "max": float(max(gaps))} if gaps else None,
        "trapped_gap_ft": {"n": len(trapped),
                           "median": float(np.median([gap[i] for i in trapped])),
                           "p75": float(np.percentile([gap[i] for i in trapped], 75)),
                           "max": float(max(gap[i] for i in trapped))} if trapped else None,
        "largest_gaps": show,
        "checks": {"stages_cross_checked": len(stages), "nodes_per_check": n,
                   "isolation_le_flood_stage": True,
                   "bfs_agrees_with_bottleneck": True,
                   "topology_improves_on_endpoint_only": True},
        "method": ("road graph with a node at every vertex; refuge = a node incident to a segment "
                   "surviving the 50 ft major stage; isolation = widest-path bottleneck to that set, "
                   "computed by one descending union-find pass and cross-checked by BFS at every "
                   "sampled stage. Segment isolation is capped by the segment's own flood stage."),
        "method_segment_aggregation": "max over the segment's vertices (last exit to go), capped by the segment's own flood_stage_ft",
        "caveats": ("Reachability is a road-network property, not a safety guarantee: a refuge node is "
                    "ground the modelled water does not reach at 50 ft, not a shelter, and not validated "
                    "against where people actually went. Absolute values inherit the -0.92 ft/mile "
                    "HAND-as-stage error documented in road_thresholds.py, so they move when that "
                    "primitive is fixed; the structure of who is trapped first is what this stage adds. "
                    "The corridor is a bounding-box clip, so roads are cut at its edge: escape to high "
                    "ground outside the study area is NOT counted as an exit, which under-reports "
                    "reachability for fragments touching the boundary. Treating the box edge as an exit "
                    "instead moves no_dry_refuge from 883 to 674 and trapped_before_flood from 230 to "
                    "408; the numbers here use the stricter reading."),
    }
    OUT_SUM.write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
