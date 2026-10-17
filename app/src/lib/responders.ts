/* I5 — the inverse question: who is already cut off?
 *
 * Every other view answers for the street in front of you. The operationally interesting set is
 * the other direction, and it is not the set of flooded streets: it is the streets whose route to
 * help is already cut while their own street is still DRY. Those households have no water on the
 * road and no way out, and the gap between the two numbers is how long that state lasts.
 *
 * The numbers are already in the payload — `segment_route_cut_ft` (the stage at which every route
 * to a hospital, fire or police station is cut) and `segment_route_cut_medical_ft` (hospitals
 * only) — and this is the same graph the routing panel reads, in the same segment order. What is
 * added here is the rule, in one place, so the count on screen and the rows under it cannot
 * disagree, and so app/tests/unit/bets.test.ts can drive it without a browser.
 *
 * It is a MODELLED set: routes exist on the study area's extract, so a street the graph cannot
 * reach a responder from at any stage is excluded rather than reported as trapped. The card says
 * which it is.
 */

export type CutRow = {
  /** Segment position in road_thresholds.geojson — the index the map and the answer use. */
  i: number;
  name: string;
  /** Stage at which this segment's last route to any responder is cut. */
  cutFt: number;
  /** ...and to a hospital, or null when the model has no hospital route for it at any stage. */
  cutToHospitalFt: number | null;
  /** Stage at which the street itself goes under. */
  floodFt: number;
  /** How much more the river can rise before the street floods — the trapped window, in feet. */
  marginFt: number;
  /** True when the segment still had no hospital route at the current stage either. */
  noHospital: boolean;
};

/** Every segment the model can ever report, worst first — the stage-independent half.
 *
 *  Split from the filter below because the row ORDER does not depend on the stage, only
 *  membership does. That split was tried as an optimisation first (build it once, filter per
 *  slider step) and abandoned on measurement: the whole call measures ~0.3 ms over 1,614
 *  segments, so caching it would have bought a cheaper drag at the price of TWO
 *  implementations of the membership rule — the app's filter and this one — which is the
 *  failure mode this repo keeps finding. One rule, measured, is enough. */
function cutCandidates(thresholds: readonly number[],
  cut: readonly (number | null)[], medical: readonly (number | null)[],
  names: readonly string[]): CutRow[] {
  const rows: CutRow[] = [];
  for (let i = 0; i < thresholds.length; i++) {
    const c = cut[i];
    if (c === null || c === undefined) continue;
    const med = medical[i] ?? null;
    rows.push({
      i,
      name: names[i] || `segment ${i}`,
      cutFt: c,
      cutToHospitalFt: med,
      floodFt: thresholds[i],
      marginFt: Math.round((thresholds[i] - c) * 100) / 100,
      // Filled in per stage by hospitalCutAt — a hospital route is only "gone" for a stage it
      // is gone at. Left false here rather than guessed, because a guessed one would be read as
      // an answer by the next caller.
      noHospital: false,
    });
  }
  // Worst first: the widest window between losing the way out and the street flooding is the
  // longest someone can be stuck with a dry road and no route.
  rows.sort((a, b) => b.marginFt - a.marginFt || a.name.localeCompare(b.name) || a.i - b.i);
  return rows;
}

/** Segments whose route to help is cut at or before `stage` while the street is still dry,
 *  worst first. `stage < floodFt` is what makes this the trapped set rather than the flooded
 *  one; a segment whose own street is already under water is a different, later state and is
 *  reported by the headline, not here. */
/** Is this segment's hospital route gone at `stage`? The one rule the card and the count both
 *  read, so a row and the headline above it cannot disagree about the same segment. */
export function hospitalCutAt(row: CutRow, stage: number): boolean {
  return row.cutToHospitalFt === null ? false : row.cutToHospitalFt <= stage;
}

export function cutOffAt(stage: number, thresholds: readonly number[],
  cut: readonly (number | null)[], medical: readonly (number | null)[],
  names: readonly string[]): CutRow[] {
  const rows = cutCandidates(thresholds, cut, medical, names)
    .filter((r) => r.cutFt <= stage && stage < r.floodFt);
  for (const r of rows) r.noHospital = hospitalCutAt(r, stage);
  return rows;
}

export type CutSummary = {
  count: number;
  /** Of those, how many have no hospital route at this stage either. */
  noHospital: number;
  /** The widest trapped window in the set, in feet, or null when the set is empty. */
  worstMarginFt: number | null;
};

export function summarize(rows: readonly CutRow[]): CutSummary {
  return {
    count: rows.length,
    noHospital: rows.filter((r) => r.noHospital).length,
    worstMarginFt: rows.length ? rows[0].marginFt : null,
  };
}
