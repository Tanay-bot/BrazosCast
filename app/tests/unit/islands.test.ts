import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  componentsAt, islandForSegment, ladderRow, sweep, type IslandSpec,
} from "../../src/lib/islands";

/**
 * T3/F4 — the island ladder, reproduced in the language the app runs.
 *
 * `pipeline/derive/routing.py` sweeps the road graph at nine stages and publishes the result as
 * `routing.summary.json` islands.ladder, because the app has to answer "which side of the cut am
 * I on" for the stage the user is looking at and cannot ship an answer per stage per segment. So
 * the partition is computed twice — Python union-find plus a Python flood fill, cross-checked
 * against each other and against the published cut field before the artifact is written, and this
 * TypeScript union-find, checked here against the rows that came out the other end.
 *
 * What this file is for is the pair of things a Python-side gate cannot see: that the app's
 * partition is built from the graph the app is actually served (`public/data/`, which the build
 * copies into `dist/`), and that the per-street view the app renders is the same partition the
 * ladder counts. The ladder rows are exact equality, not a tolerance: both sides compare the same
 * 1-decimal thresholds against the same integer stage rungs, so a difference here is a difference
 * in the algorithm rather than in floating point.
 */

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

type Graph = {
  coord_decimals: number;
  nodes: number[];
  edges: number[];
  edge_seg: number[];
  segments: { osmid: number; ft: number; hw: string }[];
  facilities: { node: number }[];
  clip?: { bbox: number[]; band_m: number; nodes: number[] };
};

type Ladder = {
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

const graph = read("../../public/data/routing_graph.json") as Graph;
const summary = read("../../../data/derived/routing.summary.json") as {
  seeds: never;
  segments_with_route_to_responder: number;
  islands: {
    stages: number[];
    ladder: Ladder[];
    clip_boundary: { nodes_in_band: number };
  };
};
/** The thresholds the app counts over, straight off the road layer it fetches. */
const thresholds: number[] = (
  read("../../public/data/road_thresholds.geojson") as {
    features: { properties: { flood_stage_ft: number } }[];
  }
).features.map((f) => f.properties.flood_stage_ft);

const E = graph.edges.length / 3;

const edgeA = new Int32Array(E);
const edgeB = new Int32Array(E);
const edgeFt = new Float64Array(E);
for (let e = 0; e < E; e++) {
  edgeA[e] = graph.edges[3 * e];
  edgeB[e] = graph.edges[3 * e + 1];
  edgeFt[e] = graph.segments[graph.edge_seg[e]].ft;
}

/** Node indices per segment, in the same order `main.ts` builds them — because a WET segment
 *  can have its nodes on two different islands, and the view has to pick one to report. */
const segNodes: number[][] = graph.segments.map(() => []);
for (let e = 0; e < E; e++) {
  const list = segNodes[graph.edge_seg[e]];
  if (!list.includes(edgeA[e])) list.push(edgeA[e]);
  if (!list.includes(edgeB[e])) list.push(edgeB[e]);
}

const spec: IslandSpec = {
  nodeCount: graph.nodes.length / 2,
  edgeA,
  edgeB,
  edgeFt,
  thresholds,
  segNodes,
  facilityNodes: graph.facilities.map((f) => f.node),
  clipNodes: graph.clip?.nodes ?? [],
};

describe("the inputs the ladder is computed on", () => {
  test("the app's graph is the one the ladder swept", () => {
    // Every edge names a segment and every segment's own threshold is what the ladder used;
    // a graph exported from a different run would make the rows below agree by accident only
    // if it were a coincidence of arithmetic.
    expect(spec.nodeCount).toBe(8987);
    expect(E).toBe(8970);
    expect(thresholds).toHaveLength(1614);
    expect(graph.edge_seg.every((s) => s >= 0 && s < thresholds.length)).toBe(true);
    for (let i = 0; i < thresholds.length; i++) {
      expect(graph.segments[i].ft).toBe(thresholds[i]);
    }
    // A stride mismatch here would silently mis-map edges to thresholds, which is the one
    // way to compute a partition of a network that does not exist.
    expect(Math.max(...edgeA, ...edgeB)).toBeLessThan(spec.nodeCount);
  });

  test("the clip band the pipeline measured is the set the app was given", () => {
    expect(spec.clipNodes.length).toBe(summary.islands.clip_boundary.nodes_in_band);
    expect(spec.clipNodes.length).toBeGreaterThan(0);
    expect(spec.clipNodes.every((i) => i >= 0 && i < spec.nodeCount)).toBe(true);
  });

  test("the ladder has the rungs the app is asked to reproduce", () => {
    // Guards the check itself: a ladder that shrank would otherwise let this file pass by
    // comparing fewer and fewer rows.
    expect(summary.islands.stages).toEqual([0, 5, 12, 20, 30, 40, 45, 50, 55]);
    expect(summary.islands.ladder).toHaveLength(summary.islands.stages.length);
    expect(summary.islands.ladder.some((r) => r.components > 5000)).toBe(true);
    expect(summary.islands.ladder.some((r) => r.largest_component_nodes < 1000)).toBe(true);
  });
});

describe("the island ladder (pipeline/derive/routing.py)", () => {
  test.each(summary.islands.ladder.map((row, i) => [i, row] as const))(
    "rung %i (%s ft) is reproduced exactly",
    (_i, row) => {
      expect(ladderRow(spec, row.stage_ft)).toEqual(row);
    },
  );

  test("the rung with no water on it reproduces the published cut field's count", () => {
    // The coupling that makes this a second implementation rather than a parallel universe:
    // "segments whose component holds a responder" at 0 ft must be the same 806 the routing
    // stage published from its max-min bottleneck, which the Python side gates too.
    expect(ladderRow(spec, 0).segments_dry_with_a_responder)
      .toBe(summary.segments_with_route_to_responder);
    expect(summary.segments_with_route_to_responder).toBe(806);
  });

  test("fragmentation is monotone in the stage, on the app's side too", () => {
    const rows = summary.islands.stages.map((s) => ladderRow(spec, s));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].components).toBeGreaterThanOrEqual(rows[i - 1].components);
      expect(rows[i].largest_component_nodes).toBeLessThanOrEqual(rows[i - 1].largest_component_nodes);
      expect(rows[i].segments_dry_with_a_responder)
        .toBeLessThanOrEqual(rows[i - 1].segments_dry_with_a_responder);
    }
    // And the extract is fragmented before any flooding at all, which is the finding the
    // app's wording depends on: "island" means reachability, not enclosure.
    expect(rows[0].components).toBeGreaterThan(1);
    expect(rows[0].segments_on_an_island_without_one).toBe(808);
  });
});

/** How many DRY segments an island (given as a node set) carries, at a stage. The island's own
 *  size as the app reports it, and the one quantity the larger-side rule below is about. */
function drySegmentsIn(side: Set<number>, stage: number): number {
  let n = 0;
  for (let s = 0; s < thresholds.length; s++) {
    if (thresholds[s] > stage && segNodes[s].some((u) => side.has(u))) n++;
  }
  return n;
}

/** An independent island lookup, by flooding rather than by union-find — the same duplication
 *  the pipeline's own two implementations have, but here it is the boundary definition that is
 *  under test rather than the partition. */
function floodFrom(start: number[], stage: number): Set<number> {
  const adj: number[][] = Array.from({ length: spec.nodeCount }, () => []);
  for (let e = 0; e < E; e++) {
    if (edgeFt[e] > stage) { adj[edgeA[e]].push(edgeB[e]); adj[edgeB[e]].push(edgeA[e]); }
  }
  const seen = new Set<number>(start);
  const stack = [...start];
  while (stack.length) {
    for (const v of adj[stack.pop() as number]) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  return seen;
}

describe("the island a household is on", () => {
  test("nothing is cut off at 0 ft, because nothing is flooded at 0 ft", () => {
    // Every threshold is above 0, so every edge exists: the components are the extract's own
    // fragments and no wet segment can touch one. If this failed, the boundary would be
    // reporting the clip as if it were water.
    for (const si of [0, 100, 800, 1613]) {
      const v = islandForSegment(spec, 0, si);
      expect(v.dry).toBe(true);
      expect(v.crossingSegs).toEqual([]);
      expect(v.lastCrossingFt).toBeNull();
    }
  });

  test("the boundary is the wet segments that leave the island, checked by flooding", () => {
    // The definition under test: a way off the island is a flooded segment whose nodes are on
    // two different islands. A flooded segment whose nodes are ALL on this island is water you
    // can drive around, and reporting it as an exit would overstate the cut.
    const stage = 30;
    for (const si of [3, 400, 1200]) {
      const v = islandForSegment(spec, stage, si);
      const mine = floodFrom(segNodes[si], stage);
      const expected: number[] = [];
      for (let s = 0; s < thresholds.length; s++) {
        if (thresholds[s] > stage) continue;
        const ns = segNodes[s];
        if (ns.some((u) => mine.has(u)) && ns.some((u) => !mine.has(u))) expected.push(s);
      }
      expect(v.crossingSegs).toEqual(expected);
      // The number the panel shows is this island's own size, and the chain of reasoning is
      // that its dry segments are exactly the flooded-out ones' complement within the flood.
      expect(v.nodes).toBeGreaterThanOrEqual(mine.size);
      expect(v.lastCrossingFt).toBe(Math.max(...expected.map((s) => thresholds[s])));
    }
  });

  test("a flooded street reports the LARGER of the two islands it joins", () => {
    // Which side of a flooded street is reported is a rule, not an accident. Not every street can
    // see the difference — the first version of this test picked one whose first node happened to
    // be on the larger side already, and a mutation that deleted the rule passed it. So the fixture
    // is SEARCHED for: a wet segment whose two sides really do differ in how much dry road they
    // touch, with the first node on the smaller side.
    const stage = 55;
    // The islands compared below are the ids the VIEW reports, so the labels come from `sweep`
    // rather than from `componentsAt`, whose values are union-find roots: two different label
    // spaces, and comparing across them would be comparing nothing.
    const label = sweep(spec, stage).island;
    let found: { si: number; mine: number; best: number; first: number; bestReach: number } | null = null;
    for (let si = 0; si < thresholds.length && !found; si++) {
      if (thresholds[si] > stage) continue;
      // A wet street at 55 ft does not have "two sides": with 7,978 islands, a polyline's vertices
      // can land on dozens of them. The rule is a maximum over all of them, so the fixture needs a
      // UNIQUE maximum that the first node is not on — otherwise the assertion would be testing the
      // tie-break rather than the rule.
      const reachOf = new Map<number, number>();
      for (const u of segNodes[si]) {
        const island = label[u];
        if (!reachOf.has(island)) reachOf.set(island, drySegmentsIn(floodFrom([u], stage), stage));
      }
      const ranked = [...reachOf.entries()].sort((a, b) => b[1] - a[1]);
      const mine = label[segNodes[si][0]];
      if (ranked.length > 1 && ranked[0][1] > ranked[1][1] && ranked[0][0] !== mine) {
        found = { si, mine, best: ranked[0][0], first: reachOf.get(mine) as number,
                  bestReach: ranked[0][1] };
      }
    }
    expect(found, "no flooded street touches one island more than all the others, so the rule that " +
      "picks between them is unobservable in the shipped data").not.toBeNull();

    const v = islandForSegment(spec, stage, found!.si);
    expect(v.dry).toBe(false);
    expect(v.island, `street ${found!.si} is flooded: its first node's island touches ` +
      `${found!.first} dry segments and another island it touches has ${found!.bestReach}, so the ` +
      `larger side is the one a household is driving towards`).toBe(found!.best);
  });

  test("a flooded street still reports an island, and says the street itself is under water", () => {
    const wet = thresholds.findIndex((t) => t <= 55);
    expect(wet, "no segment is under water at 55 ft").toBeGreaterThanOrEqual(0);
    const v = islandForSegment(spec, 55, wet);
    // Which of a wet street's two islands is reported is arbitrary by construction; what is
    // not arbitrary is that the view must not claim the street is drivable.
    expect(v.dry).toBe(false);
    expect(v.island).toBeGreaterThanOrEqual(0);
    expect(v.nodes).toBeGreaterThan(0);
    expect(v.crossingSegs.every((s) => thresholds[s] <= 55)).toBe(true);
    // An island can hold no DRY segment at all once most of the corridor is under water: the
    // count the panel reports is dry roads, so 0 here is a fact about the flood rather than a
    // missing answer. The ladder above never gets there — it counts 1,614 segments at 0 ft
    // and the last rung still has some dry ones, which is what makes this case reachable only
    // by asking a specific street.
    expect(ladderRow(spec, 55).segments_dry).toBeGreaterThan(0);
    expect(v.segments).toBeGreaterThanOrEqual(0);
  });
});

describe("how a segment is attributed to an island", () => {
  test("the ladder does not read the order a segment's nodes are listed in", () => {
    // The claim this whole arrangement exists for. A road feature the clip cut into pieces has its
    // parts on different islands — measured, 1-4 DRY segments per rung — and the pipeline's builder
    // collects a segment's nodes in a Python `set` while the app collects them in edge order. A
    // first-node rule therefore reads the builder's enumeration order, and it passed every test in
    // this file on this dataset: the reversal below is what makes it fail.
    const flipped: IslandSpec = { ...spec, segNodes: segNodes.map((ns) => [...ns].reverse()) };
    for (const row of summary.islands.ladder) {
      expect(ladderRow(flipped, row.stage_ft), `rung ${row.stage_ft} reads the node order`)
        .toEqual(row);
    }
  });

  test("the ladder's attribution is the larger side, on a fixture the shipped data cannot express", () => {
    // The shipped ladder cannot tell the rule from "the lowest island id touching the segment":
    // measured, every published number comes out byte-identical that way, because all 1-4 of the
    // dry segments that straddle two islands per rung happen to have their lowest-id island be the
    // side with the most dry segments. A rule nothing can observe is a rule nothing can protect, so
    // this fixture is built to separate them — island 1 is touched by three dry segments, island 0
    // by two, and the straddling segment's parts are on both. The larger side is the HIGHER id,
    // which is the case "lowest id" and "first node" both get wrong.
    //
    // Two sides joined only by a 10 ft edge, so at 30 ft they are separate islands; the facility is
    // on island 1; segment 0 is the road feature the clip cut into pieces.
    const synth: IslandSpec = {
      nodeCount: 7,
      edgeA: new Int32Array([0, 1, 2, 3, 4, 5]),
      edgeB: new Int32Array([1, 2, 3, 4, 5, 6]),
      edgeFt: new Float64Array([60, 60, 10, 60, 60, 60]),
      thresholds: [60, 60, 60, 60],
      segNodes: [[0, 3], [1], [4], [5]],
      facilityNodes: [4],
      clipNodes: [6],
    };
    const sw = sweep(synth, 30);
    expect(sw.count).toBe(2);
    // The straddling segment touches both islands, so it is counted in both reaches but attributed
    // to one — island 0 has two dry segments touching it, island 1 three.
    expect([...sw.reach]).toEqual([2, 3]);
    expect(sw.spanning).toBe(1);
    expect([...sw.segs], "the straddling segment went to the smaller side").toEqual([1, 3]);
    expect([...sw.segs].reduce((a, b) => a + b, 0)).toBe(sw.dryCount);

    const row = ladderRow(synth, 30);
    expect(row.segments_dry_with_a_responder, "the responder's island is the larger side")
      .toBe(3);
    expect(row.segments_on_an_island_without_one).toBe(1);
    expect(row.largest_component_segments).toBe(3);

    // And the same answer when the straddling segment's nodes arrive the other way round, which is
    // the property the rule is chosen for.
    const flipped = sweep({ ...synth, segNodes: [[3, 0], [1], [4], [5]] }, 30);
    expect([...flipped.segs]).toEqual([...sw.segs]);
  });

  test("every dry segment lands on exactly one island, and some really do straddle two", () => {
    const stage = 30;
    const sw = sweep(spec, stage);
    expect([...sw.segs].reduce((a, b) => a + b, 0), "the attribution is not a partition")
      .toBe(sw.dryCount);
    expect(sw.spanning).toBe(ladderRow(spec, stage).segments_touching_more_than_one_island);
    // Non-vacuous: the ambiguity is a fact about this road layer, not a hypothetical, which is why
    // the rule and its gate exist at all.
    expect(sw.spanning).toBeGreaterThan(0);
    // And the two numbers are different kinds of thing: how many segments touch the largest island
    // can exceed how many are attributed to it, by exactly those straddling segments.
    const row = ladderRow(spec, stage);
    expect(row.largest_component_reach).toBeGreaterThanOrEqual(row.largest_component_segments);
  });
});

describe("the partition itself", () => {
  test("every node is in exactly one island, and the sizes add up", () => {
    const label = componentsAt(spec, 30);
    const sizes = new Map<number, number>();
    for (let i = 0; i < label.length; i++) sizes.set(label[i], (sizes.get(label[i]) ?? 0) + 1);
    expect([...sizes.values()].reduce((a, b) => a + b, 0)).toBe(spec.nodeCount);
    expect(sizes.size).toBe(ladderRow(spec, 30).components);
  });
});
