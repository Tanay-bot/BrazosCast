/**
 * Which HAND extent band to draw at a stage.
 *
 * The bands are nested and cut at the NWS categories plus Harvey's crest (45 / 48 / 50 /
 * 54.74 ft, written by pipeline/derive/inundation.py). The map draws exactly one of them —
 * the nearest at or BELOW the stage — because drawing the next band up would show water the
 * river has not reached, and drawing all bands at once would over-plot the same polygons.
 *
 * Pure, and separate from main.ts, so the boundaries are tested without a browser: 45.0 must
 * pick 45 (the category boundary is inclusive, like the NWS threshold), 47.99 must still pick
 * 45, and above the top band the top band stays drawn rather than the layer vanishing at the
 * crest — which is the one moment it matters.
 */
export function bandFor(stage: number, bands: readonly number[]): number | null {
  let pick: number | null = null;
  // Sorted rather than trusted: the caller passes the artifact's own array, and an editor
  // reordering bands in the payload must not silently pick the wrong one.
  for (const b of [...bands].sort((x, y) => x - y)) {
    if (b <= stage + 1e-9) pick = b;
  }
  return pick;
}
