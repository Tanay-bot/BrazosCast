import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * I8 — the modelled extent on the map.
 *
 * Two things are asserted, and the second is the one that matters: that the layer draws the
 * band at or below the stage (never a band the river has not reached), and that the score
 * against the one observation reaches the screen. A flood layer whose own error is only in
 * the pipeline is a layer that tells a user the water is where it is not.
 */

test("the extent draws the band at or below the stage, and states its score", async ({ page }) => {
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await booted(page, "?stage=50");

  const note = page.locator("#floodNote");
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("data-band", "50");
  await expect(note).toContainText("288.7 km²");
  await expect(note).toContainText("upper bound");
  await expect(note).toContainText("2.3× the water");
  await expect(note).toContainText("IoU 0.31");

  // 49.9 ft is below major and above moderate: the band drawn must be 48, not 50.
  await page.locator("#stage").fill("49.9");
  await expect(note).toHaveAttribute("data-band", "48");
  await expect(note).toContainText("276.9 km²");

  // 45.0 exactly is the flood band — the boundary is inclusive, like the NWS category.
  await page.locator("#stage").fill("45");
  await expect(note).toHaveAttribute("data-band", "45");

  // Below flood stage the layer draws nothing, and the card says why rather than going
  // silent: an empty map with no explanation reads as "no water anywhere".
  await page.locator("#stage").fill("30");
  await expect(note).toHaveAttribute("data-band", "none");
  expect(await text(page, "floodNote")).toContain("No extent is drawn below the flood stage");
});

test("the replay's crest draws the top band", async ({ page }) => {
  // The stage is in the link because replay no longer OPENS at the crest (REPLAY_OPEN_FT in
  // main.ts): it opens at 30 ft, where the answer still has hours to give. The crest is one
  // drag away, and this is what it must draw when the slider gets there.
  await booted(page, "?mode=replay&stage=55");
  // Harvey's crest at Richmond is 55.01 ft, above the top band (54.74), so the top band
  // stays drawn rather than the layer disappearing at the one moment it matters most.
  await expect(page.locator("#floodNote")).toHaveAttribute("data-band", "54.74");
  await expect(page.locator("#floodNote")).toContainText("330.8 km²");
});

test("the map route pays for the extent and the text-only route does not", async ({ page }) => {
  let floodRequests = 0;
  page.on("request", (r) => { if (r.url().includes("flood_extent.json")) floodRequests++; });
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await booted(page, "?stage=50");
  await expect(page.locator("#floodNote")).toHaveAttribute("data-band", "50");
  expect(floodRequests, "the map never asked for the extent it draws").toBe(1);

  const before = floodRequests;
  await booted(page, "?stage=50&text=1");
  // The text-only route's claim is that it downloads neither the map nor its data.
  expect(floodRequests, "text mode fetched the map's extent").toBe(before);
});
