/* The island partition — the app's half of `pipeline/derive/routing.py`'s island sweep.
 *
 * F4 asks the graph a question the routing panel cannot: not "can I reach a destination"
 * but "which roads can I still move between at all". At a given stage the edges still above
 * their threshold (dry) partition the network; the set your street is in is the ground a
 * driver can still reach from that street without crossing water, and the wet segments at
 * its edge are the ways off it. That is what "which side of the cut am I on" means.
 *
 * What the measurement forced (see docs/FINDINGS.md §14): the road extract is ALREADY 116
 * separate networks at 0 ft, and only 806 of 1,614 segments sit on a fragment that holds a
 * responder — the bounding-box clip, not flooding. So this is reachability, never
 * enclosure, and `touchesClip` exists so the app can say when an island ends at the edge of
 * the study area rather than at water.
 *
 * Two readings of one implementation. `sweep()` computes the partition once; `ladderRow()`
 * reports the pipeline's own row shape from it (recomputed here, row by row, in
 * app/tests/unit/islands.test.ts, which is what makes the duplicated Python implementation
 * a checked claim rather than two algorithms); `islandForSegment()` reports the one island a
 * household is asking about. Nothing here re-derives an answer from a threshold the caller
 * did not supply — the stage comparison `ft > stage` is the same one the map filter and
 * isolation.widest_path use, and agreement between those is gated in the pipeline.
 */

export type IslandSpec = {
  nodeCount: number;
  /** Edge endpoints, parallel arrays, as `routing_graph.json` exports them. */
  edgeA: Int32Array;
  edgeB: Int32Array;
  /** Each edge's threshold in ft — its segment's flood stage. */
  edgeFt: Float64Array;
  /** Flood stage per segment, in segment order. */
  thresholds: number[];
  /** Node indices per segment, in segment order. */
  segNodes: number[][];
  /** Graph nodes holding an accepted hospital, fire or police station. */
  facilityNodes: number[];
  /** Nodes within the clip band: where a road leaves the study area. */
  clipNodes: number[];
};

export type Sweep = {
  /** Island id per node. */
  island: Int32Array;
  /** How many islands the network is in at this stage. */
  count: number;
  /** Nodes per island. */
  size: Int32Array;
  /** DRY segments attributed to each island: the roads still drivable there. A partition —
   *  `sum(segs) === dryCount` — with the attribution rule stated on `sweep`. */
  segs: Int32Array;
  /** DRY segments merely TOUCHING each island, which may exceed `segs`: a segment can have
   *  parts on two islands (the clip cuts road features into pieces) and then counts for both
   *  here but is attributed to only one below. It is what the attribution rule ranks by, and
   *  what the ladder publishes, so a straddling segment cannot silently move between islands. */
  reach: Int32Array;
  /** DRY segments whose parts do not all land on one island. Published, because it is the size
   *  of the over-count above and the reason the attribution rule has to exist at all. */
  spanning: number;
  /** Per segment: 1 if it is passable at this stage. */
  dry: Uint8Array;
  /** How many segments are passable at all. */
  dryCount: number;
  /** Per island: does it hold a responder? */
  withResponder: Uint8Array;
  /** Per island: does it reach the edge of the study area? */
  touchesClip: Uint8Array;
};

/** One row of the pipeline's ladder, in the pipeline's own field names — so a test can
 *  compare it to `routing.summary.json` islands.ladder as an object, not a paraphrase. */
export type IslandRow = {
  stage_ft: number;
  components: number;
  largest_component_nodes: number;
  largest_component_segments: number;
  largest_component_reach: number;
  islands_touching_the_clip: number;
  segments_dry: number;
  segments_dry_with_a_responder: number;
  segments_on_an_island_without_one: number;
  segments_touching_more_than_one_island: number;
};

/** The island a selected street is on, as the answer panel needs it. */
export type IslandView = {
  /** Island id, or -1 when the segment has no nodes in the graph at all. */
  island: number;
  /** Is this street itself still passable? */
  dry: boolean;
  /** How many islands this street's parts land on: 1 usually, 2 when it is the crossing or when
   *  the clip cut it into pieces. */
  islandsTouched: number;

  /** Nodes and dry segments on the island. */
  nodes: number;
  segments: number;
  /** Is a modelled responder on this island? */
  responder: boolean;
  /** Does the island reach the edge of the study area? */
  touchesClip: boolean;
  /** The wet segments that lead off the island to a different one: its boundary. */
  crossingSegs: number[];
  /** The highest threshold among them — the crossing that closed most recently. */
  lastCrossingFt: number | null;
};

/** Union-find over the dry edges. Exported for the parity test, which needs the partition
 *  itself rather than a statistic derived from it. */
export function componentsAt(spec: IslandSpec, stage: number): Int32Array {
  const n = spec.nodeCount;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    while (parent[a] !== root) { const next = parent[a]; parent[a] = root; a = next; }
    return root;
  };

  const E = spec.edgeA.length;
  for (let e = 0; e < E; e++) {
    if (spec.edgeFt[e] > stage) {
      const ra = find(spec.edgeA[e]), rb = find(spec.edgeB[e]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const label = new Int32Array(n);
  for (let i = 0; i < n; i++) label[i] = find(i);
  return label;
}

/** Which island a set of nodes is "on", when they are not all on one.
 *
 * Deliberately independent of the ORDER the nodes arrive in, because for a stretch of road the
 * pipeline cut into parts, that order is an artefact of the builder rather than a fact about the
 * road (Python's `isolation.build` collects them in a `set`). The rule reads only the partition:
 * most dry segments touching, then most nodes, then the lowest island id. Every input to it is a
 * property of the partition, so reversing a segment's node list cannot move the answer — which is
 * asserted from both sides (`routing.py`'s own gate, and islands.test.ts).
 */
function attribute(reach: Int32Array, size: Int32Array, touched: number[]): number {
  let best = touched[0];
  for (const other of touched) {
    if (reach[other] > reach[best] ||
        (reach[other] === reach[best] && size[other] > size[best]) ||
        (reach[other] === reach[best] && size[other] === size[best] && other < best)) {
      best = other;
    }
  }
  return best;
}

export function sweep(spec: IslandSpec, stage: number): Sweep {
  const label = componentsAt(spec, stage);
  const n = spec.nodeCount;
  // Compact the arbitrary roots into 0..count-1, in node order. The order matters: it is
  // the same order the pipeline's Counter assigns, which is what makes the tie-break in
  // ladderRow's "largest island" identical on both sides.
  const idOf = new Int32Array(n).fill(-1);
  const island = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = label[i];
    if (idOf[r] < 0) idOf[r] = count++;
    island[i] = idOf[r];
  }

  const size = new Int32Array(count);
  for (let i = 0; i < n; i++) size[island[i]]++;

  const dry = new Uint8Array(spec.thresholds.length);
  const reach = new Int32Array(count);
  const touchedBy: number[][] = [];
  let dryCount = 0;
  for (let s = 0; s < spec.thresholds.length; s++) {
    const nodes = spec.segNodes[s];
    if (spec.thresholds[s] > stage && nodes.length) {
      dry[s] = 1;
      dryCount++;
      const touched = [...new Set(nodes.map((u) => island[u]))];
      touchedBy.push(touched);
      for (const i of touched) reach[i]++;
    } else {
      touchedBy.push([]);
    }
  }

  // One pass with the counts in hand, so the attribution can be "the side this road mostly is"
  // rather than "the first end of it". `sum(segs) === dryCount` is the identity that makes this a
  // partition; a straddling segment counts for one island only, and `spanning` says how many did.
  const segs = new Int32Array(count);
  let spanning = 0;
  for (let s = 0; s < spec.thresholds.length; s++) {
    const touched = touchedBy[s];
    if (!dry[s]) continue;
    if (touched.length > 1) spanning++;
    segs[attribute(reach, size, touched)]++;
  }

  const withResponder = new Uint8Array(count);
  for (const f of spec.facilityNodes) withResponder[island[f]] = 1;
  const touchesClip = new Uint8Array(count);
  for (const c of spec.clipNodes) touchesClip[island[c]] = 1;

  return { island, count, size, segs, reach, spanning, dry, dryCount, withResponder, touchesClip };
}

/** The pipeline's ladder row for one stage, computed from `sweep` — the same partition the
 *  per-street view reads, so the two cannot describe different networks. */
export function ladderRow(spec: IslandSpec, stage: number): IslandRow {
  const sw = sweep(spec, stage);
  let largest = 0, clip = 0, served = 0;
  for (let i = 0; i < sw.count; i++) {
    if (sw.size[i] > sw.size[largest]) largest = i;
    if (sw.touchesClip[i]) clip++;
    if (sw.withResponder[i]) served += sw.segs[i];
  }
  return {
    stage_ft: stage,
    components: sw.count,
    largest_component_nodes: sw.size[largest],
    largest_component_segments: sw.segs[largest],
    largest_component_reach: sw.reach[largest],
    islands_touching_the_clip: clip,
    segments_dry: sw.dryCount,
    segments_dry_with_a_responder: served,
    segments_on_an_island_without_one: sw.dryCount - served,
    segments_touching_more_than_one_island: sw.spanning,
  };
}

/** The island one street is on at one stage. */
export function islandForSegment(spec: IslandSpec, stage: number, si: number): IslandView {
  const sw = sweep(spec, stage);
  const nodes = spec.segNodes[si] ?? [];
  if (!nodes.length) {
    return { island: -1, dry: false, islandsTouched: 0, nodes: 0, segments: 0,
             responder: false, touchesClip: false, crossingSegs: [], lastCrossingFt: null };
  }
  const touched = [...new Set(nodes.map((u) => sw.island[u]))];
  const islandsTouched = touched.length;
  // Which island a street is "on" is ambiguous whenever its parts land on more than one: 1,614
  // segments include features the clip cut into pieces (measured: 1–4 segments per rung), and a
  // flooded street's own segment is the crossing between its two sides. The rule is the same one
  // `sweep` uses, and it reads nothing but the partition — most dry segments touching, then most
  // nodes, then the lowest island id — so the answer cannot depend on the order a builder happened
  // to enumerate a segment's nodes in. Measured rather than reasoned: the first version reported
  // the first node's island, and a street at 45 ft was told its island held 0 of 1,614 dry
  // segments while the other side of the same flooded road held more.
  const me = attribute(sw.reach, sw.size, touched);

  // The ways off the island are the wet segments that move you BETWEEN islands. A wet
  // segment whose nodes all land on this island is flooded road you can drive around, and
  // counting it as an exit would make the boundary look larger than the cut is.
  const crossingSegs: number[] = [];
  let lastCrossingFt: number | null = null;
  for (let s = 0; s < spec.thresholds.length; s++) {
    if (sw.dry[s]) continue;
    const ns = spec.segNodes[s];
    if (!ns.length) continue;
    let mine = false, other = false;
    for (const u of ns) {
      if (sw.island[u] === me) mine = true; else other = true;
      if (mine && other) break;
    }
    if (mine && other) {
      crossingSegs.push(s);
      const t = spec.thresholds[s];
      if (lastCrossingFt === null || t > lastCrossingFt) lastCrossingFt = t;
    }
  }

  return {
    island: me,
    dry: sw.dry[si] === 1,
    islandsTouched,
    nodes: sw.size[me],
    segments: sw.segs[me],
    responder: sw.withResponder[me] === 1,
    touchesClip: sw.touchesClip[me] === 1,
    crossingSegs,
    lastCrossingFt,
  };
}
