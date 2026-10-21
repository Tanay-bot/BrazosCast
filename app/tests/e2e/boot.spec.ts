import { expect, test } from "@playwright/test";
import { booted, NWPS, stubGauge, text } from "./helpers";

/**
 * What the app does at boot, under a gauge it can read and a gauge it cannot.
 *
 * These are the states a user actually meets, and none of them was reachable from a test
 * before: everything the app decides about a reading is derived at runtime from the
 * response it just parsed.
 */

test("a live gauge boots the live view and says where it read to", async ({ page }) => {
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await booted(page);

  await expect(page.locator("#mReplay")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#stageVal")).toHaveText("29.40");
  // 29.4 is above action (20) and below minor (45).
  await expect(page.locator("#catVal")).toHaveText("Action stage");
  await expect(page.locator("#srcTag")).toHaveText(
    /^NOAA NWPS RMOT2 · observed to .+ · forecast to .+$/);

  // No street chosen yet, and the app must not guess one.
  await expect(page.locator("#verdict")).toHaveText("Enter an address to see your lead time");
  await expect(page.locator("#hours")).toHaveText("—");
  await expect(page.locator("#ens")).toBeHidden();

  // The sentences that survive without the map, which text mode relies on.
  await expect(page.locator("#mapNote")).toHaveText(/^\d+ of 1614 segments under water$/);
  expect(await text(page, "chartText")).toMatch(/observed and forecast points/);
});

test("the model card shows its record, including where it loses", async ({ page }) => {
  // Every number on this card is computed in renderModelCross() from the payload, so the
  // assertions are about the two halves that matter: that the table pairs the model with
  // persistence in that order, and that the losses survive to the screen. A card that
  // rendered only the wins would pass a looser test and be exactly the failure this blocks.
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await booted(page);

  await expect(page.locator("#mdCard")).toBeVisible();
  const table = page.locator("#mdTable");
  // The published holdout at +3 d: 3.568 ft against persistence's 3.672, which is the
  // narrowest margin in the table and therefore the row most likely to be quietly rounded
  // into a win it is not.
  await expect(table).toContainText("3.57/3.67");
  await expect(table).toContainText("2022-26");
  // The losses are marked in the DOM, not only in prose.
  expect(await page.locator("#mdTable td.bad").count()).toBe(3);
  await expect(page.locator("#mdSum")).toContainText("loses on 3");
  await expect(page.locator("#mdSum")).toContainText("never as the answer");
  // Harvey is the one flood where the model is the worse of the two at +1 day.
  await expect(page.locator("#mdLoss")).toContainText("August 2017 flood");
  await expect(page.locator("#mdLoss")).toContainText("the model 6.1 ft off");
  // The per-stage rates carry their counts, and a stage nothing reached says so rather
  // than printing a rate of zero.
  await expect(page.locator("#mdStages")).toContainText("20 ft action CSI 0.68");
  await expect(page.locator("#mdStages")).toContainText("no rate to report");
  // And the tie-in: the ensemble block's own error curve is this model's.
  await expect(page.locator("#mdHint")).toContainText("+7 d 6.1 ft");
});

test("a replay link boots 2017 without asking the live gauge anything", async ({ page }) => {
  let gaugeCalls = 0;
  await page.route(NWPS, async (route) => {
    gaugeCalls++;
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await booted(page, "?mode=replay");

  await expect(page.locator("#mReplay")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#srcTag")).toHaveText(/^Replay · .+ · USGS \d+ observed$/);
  await expect(page.locator("#bcCard")).toBeVisible();
  await expect(page.locator("#bcSum")).toContainText("before the crest");

  // The whole point of reading the URL before the first fetch (D2): a shared replay link
  // must not make a live request only to throw the answer away.
  expect(gaugeCalls, "a replay link reached the live gauge").toBe(0);
});

test("the router agrees with the pipeline's own cut stages", async ({ page }) => {
  // The app computes each segment's cut stage twice over: the pipeline with a descending
  // union-find pass (routing.py → segment_route_cut_ft) and the browser with a max-min
  // Dijkstra. `parityCheck()` runs once per boot and says so in the console; nothing asserted
  // it, so "the two implementations agree" was a message nobody read — the same gap the
  // verification grids had. This is the cheap half of closing it: the number is already
  // computed, it just needed a reader.
  const lines: string[] = [];
  page.on("console", (m) => { if (m.text().includes("[routing]")) lines.push(m.text()); });

  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await booted(page);
  await expect.poll(() => lines.length, { message: "no parity line was logged" }).toBe(1);

  const m = /parity vs pipeline: (\d+) segments, (\d+) mismatches, max \|diff\| ([\d.]+) ft/
    .exec(lines[0]);
  expect(m, `unexpected parity line: ${lines[0]}`).not.toBeNull();
  // 30 segments are sampled by construction, so a smaller number means the check degraded
  // rather than that the app got better.
  expect(Number(m![1])).toBeGreaterThanOrEqual(20);
  expect(lines[0], "the app routes on a graph the pipeline's numbers were not computed on")
    .toContain("0 mismatches");
  expect(Number(m![3])).toBeLessThanOrEqual(0.15);
});

test("a gauge that cannot be read falls back to the replay, and is labelled", async ({ page }) => {
  await stubGauge(page, "fail");
  await booted(page);

  await expect(page.locator("#mReplay")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#srcTag")).toHaveText(/^Replay ·/);
  await expect(page.locator("#verdict")).toHaveText("Enter an address to see your lead time");
  // The provenance line still names the gauge the app is wired to, so the fallback is
  // visible in the header rather than silently pretending 2017 is the current river.
  expect(await text(page, "srcTag")).not.toContain("connecting");
});
