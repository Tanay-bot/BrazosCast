import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * F4 — the island, on screen.
 *
 * The partition itself is arithmetic and is checked as arithmetic: `routing.py` gates its sweep
 * against a second implementation and against the published cut field, and
 * `app/tests/unit/islands.test.ts` recomputes the whole ladder from the graph the app is served.
 * What is left is what only a browser can answer — that the number on the panel is the number for
 * the stage being shown, that it MOVES the way the water moves, and that the sentence stays true in
 * the two cases where a size on its own would be misleading: an island with nothing drivable left,
 * and one whose edge is the study area rather than water.
 *
 * Every assertion is a property, not a fixture. The panel's number is never compared against a
 * constant, because a constant here would be a second copy of the pipeline's answer that could
 * drift from it silently; it is compared against what the same panel said one stage earlier.
 */

const JACKSON = "1600 Jackson Street";
/** The one street in the corpus whose own segment sits in the clip band and has county addresses:
 *  found by intersecting routing_graph.json's `clip.nodes` with the address index. */
const AT_THE_EDGE = "3200 Glenn Lakes Lane";
/** A street whose whole neighbourhood is under water at 40 ft — the case that produced the
 *  "0 of 1,614 segments … a fire or police station is on it" contradiction before the sentence
 *  was rewritten. */
const SUBMERGED = "100 Thompson Oil Field Road";

const url = (addr: string, stage: number) =>
  `?mode=replay&stage=${stage}&addr=${encodeURIComponent(addr)}`;

/** The size the island line reports, or null when the line is hidden. */
async function islandSize(page: import("@playwright/test").Page): Promise<number | null> {
  const el = page.locator("#islandNote");
  if (await el.isHidden()) return null;
  const m = /(\d+) of the corridor's 1614 segments/.exec(await text(page, "islandNote"));
  return m ? Number(m[1]) : null;
}

test("a dry street reports the island it can still drive on", async ({ page }) => {
  await stubGauge(page, { value: 28 });
  await booted(page, url(JACKSON, 28));

  const note = await text(page, "islandNote");
  expect(note, `the island line is not a size for this street: ${note}`)
    .toMatch(/^Your island: \d+ of the corridor's 1614 segments are still reachable from this street without crossing water\./);
  // 1,614 segments at most, and never zero: the street's own segment is on it and is dry here.
  const n = await islandSize(page);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(1614);

  // The second clause is one of exactly two states, and both are checkable against the first
  // (an island with a responder on it is not described as having every way off under water).
  expect(note).toMatch(/ A hospital, fire or police station is on it\.| No modelled responder is on it(, and every way off it crosses water: \d+ flooded segments form its edge, the last of which closed at [\d.]+ ft)?\.$/);
});

test("the island only ever shrinks as the river rises", async ({ page }) => {
  // The property that makes the number mean anything: it is a function of the stage, and the
  // direction is fixed — water can take a road out of your island and cannot put one back.
  await stubGauge(page, { value: 28 });
  await booted(page, url(JACKSON, 20));

  const stages = [20, 25, 30, 35, 40, 45];
  const sizes: (number | null)[] = [];
  for (const stage of stages) {
    await page.locator("#stage").fill(String(stage));
    await page.locator("#stage").dispatchEvent("input");
    await expect(page.locator("#stageVal")).toHaveText(`${stage.toFixed(2)}`);
    sizes.push(await islandSize(page));
  }

  const known = sizes.filter((s): s is number => s !== null);
  expect(known.length, "the island line vanished at a stage where the street exists")
    .toBeGreaterThanOrEqual(4);
  for (let i = 1; i < known.length; i++) {
    expect(known[i], `the island grew from ${known[i - 1]} to ${known[i]} segments between ` +
      `${stages[i - 1]} and ${stages[i]} ft`).toBeLessThanOrEqual(known[i - 1]);
  }
  // Non-vacuous: the river really does dissolve it across this range rather than the number
  // sitting still and passing a non-strict comparison.
  expect(known[known.length - 1]).toBeLessThan(known[0]);
});

test("an island with nothing drivable left says so instead of quoting a size", async ({ page }) => {
  await stubGauge(page, { value: 40 });
  await booted(page, url(SUBMERGED, 40));

  const note = await text(page, "islandNote");
  expect(note, `an emptied island is being described by its size: ${note}`)
    .toContain("every road connected to it is under water");
  expect(note).not.toMatch(/of the corridor's 1614 segments are still reachable/);
  // And with no drivable road there is no claim about a responder: the nearest one stood on this
  // very street, which is the contradiction this case exists to prevent.
  expect(note, "a responder is claimed over an island with no drivable road")
    .not.toContain("is on it");
  expect(await islandSize(page)).toBeNull();
});

test("an island that reaches the edge of the study area says so", async ({ page }) => {
  await stubGauge(page, { value: 20 });
  await booted(page, url(AT_THE_EDGE, 20));

  const note = await text(page, "islandNote");
  expect(note, `an island bounded by the extract claims to be bounded by water: ${note}`)
    .toContain("reaches the edge of the study area");
  expect(note).toContain("a road continues outside what is modelled");
  // It is still an island with a size: the caveat is added to the answer, not instead of it.
  expect(await islandSize(page)).toBeGreaterThan(0);
});

test("with no street there is no island, and the map has nothing to draw", async ({ page }) => {
  await stubGauge(page, { value: 28 });
  await booted(page, "?mode=replay&stage=28&addr=Nowhere+Street");
  // A refused address must not leave the previous street's island on screen — the same rule the
  // answer card follows, held here because the island is a second place the selection shows.
  await expect(page.locator("#addrOut")).toHaveText("no street selected");
  await expect(page.locator("#islandNote")).toBeHidden();
  await expect(page.locator("#islandNote")).toHaveText("");
  // The legend entry is static chrome and stays: it keys a layer that has data again as soon as a
  // street is chosen, and removing it per-selection would make the map unreadable in the meantime.
  await expect(page.locator(".legend")).toContainText("Edge of your island");
});
