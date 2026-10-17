import { expect, test } from "@playwright/test";
import { NWPS, stubGauge } from "./helpers";

/**
 * The landing page at `/` — the river read before the map.
 *
 * Three claims live only here, and none of them is covered by the app's own suite:
 *
 *   1. The page puts the live gauge on a scale that is actually drawn. The ticks are
 *      `transform: scaleX(0)` under `html.js` until an ancestor carries `.in`; the rail never
 *      enters the reveal observer, so "a gauge with no tick marks" shipped and only a
 *      screenshot caught it. The computed transform is the assertion.
 *   2. A street resolves onto that scale from the same payload the app uses, and the hand-off
 *      carries the typed address to `/app` — the landing must not re-implement the answer.
 *   3. A link from the old world (`/?addr=…`) still opens the app, because every link already
 *      sent has that shape.
 */

test("the landing puts a live stage on a drawn scale", async ({ page }) => {
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await page.goto("/");

  await expect(page.locator("#stageNow")).toHaveText("29.40");
  await expect(page.locator("#heroSub")).toContainText("Above action stage");
  await expect(page.locator("#railNow")).toHaveText("29.40 ft");
  await expect(page.locator("#railTrack")).toHaveAttribute("aria-valuenow", "29.4");
  await expect(page.locator("#railNeedle")).toBeVisible();

  // Every five feet, and the official stages replace the five-foot tick they land on:
  // 0,5,10,15,20,25,30,35,40,45,48,50,55,60,61.2,65.
  const ticks = page.locator("#railTicks .tick");
  await expect(ticks).toHaveCount(16);
  await expect(page.locator("#railTicks .tick.major")).toHaveCount(5);

  // The bug this test exists for: an un-transformed tick is a tick you can see. Polled rather
  // than read once, because the ticks draw in one by one over half a second and reading during
  // the entry animation would pass on a page that never finishes it. A tick stuck at scaleX(0)
  // is exactly what shipped, and it never reaches `none`.
  const undrawn = () => ticks.evaluateAll((els) => els
    .map((el) => getComputedStyle(el).transform)
    .filter((t) => t !== "none"));
  await expect.poll(undrawn, { timeout: 5000, message: "ticks never finished drawing" })
    .toEqual([]);

  // Dragged to the record, the caption must say the record was reached — the number is the
  // artifact's, so a threshold or a peak list that drifts shows up as a sentence.
  await page.locator("#railTrack").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#railTrack")).toHaveAttribute("aria-valuenow", "66.0");
  await expect(page.locator("#railCap")).toContainText("Never reached since 1884");
});

test("a street resolves onto the gauge and hands off to the app", async ({ page }) => {
  await stubGauge(page, { value: 29.4, peak: 31.2, forecastTo: 30.1 });
  await page.goto("/");

  await page.locator("#addr").fill("Skinner Lane");
  await page.locator("#probe button[type=submit]").click();

  await expect(page.locator("#probeNote")).toContainText("floods at 26.90 ft");
  // The anchor itself is a zero-height line whose dot and label are absolutely positioned, so
  // "visible" is a question about the dot, not the anchor.
  await expect(page.locator("#railYou")).not.toHaveAttribute("hidden", "");
  await expect(page.locator("#railYouLab")).toHaveText("26.90");
  await expect(page.locator(".rail-you-dot")).toBeVisible();
  await expect(page.locator("#probeHref")).toHaveAttribute("href", "./app?addr=Skinner%20Lane");

  // Tapping through must land on the app with the address intact — the landing answers the
  // river's question, the app answers the household's.
  await page.locator("#probeHref").click();
  await expect(page).toHaveURL(/\/app\?addr=Skinner%20Lane$/);
  await expect(page.locator("#addr")).toHaveValue("Skinner Lane");
});

test("a street the corridor does not model is refused, not snapped", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await page.goto("/");

  await page.locator("#addr").fill("Zzyzx Road");
  await page.locator("#probe button[type=submit]").click();

  await expect(page.locator("#probeNote")).toContainText(/not one of the modelled streets/);
  // A refusal must not leave a dot on the scale: a threshold for a street nobody typed is
  // worse than no threshold at all.
  await expect(page.locator("#railYou")).toBeHidden();
  await expect(page.locator("#probeLink")).toBeHidden();
});

test("a house number still resolves, and says which segment it will use", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await page.goto("/");

  await page.locator("#addr").fill("1600 Jackson Street");
  await page.locator("#probe button[type=submit]").click();

  await expect(page.locator("#probeNote")).toContainText("Jackson Street floods at 35.60 ft");
  await expect(page.locator("#probeHref")).toHaveAttribute("href", "./app?addr=1600%20Jackson%20Street");
});

test("a link from the old front door still opens the answer", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await page.goto("/?addr=Skinner%20Lane&stage=45");

  // The app owns URL normalisation from here (it writes the state it restored), so assert the
  // address survived the hand-off rather than the exact spelling of the query.
  await expect(page).toHaveURL(/\/app\?/);
  await expect(page.locator("#addr")).toHaveValue("Skinner Lane");
  await expect(page.locator("#stageVal")).toHaveText("45.00");
});

test("the app's brand leads back to the landing", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await page.goto("/app");
  await page.locator(".hdr .brand").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#stageNow")).not.toHaveText("—");
});

test("a gauge that cannot be read still leaves a readable page", async ({ page }) => {
  await page.route(NWPS, (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/");

  await expect(page.locator("#stageNow")).toHaveText("—");
  await expect(page.locator("#heroSub")).toContainText("could not be read");
  // The measure still stands without a reading — that is what the scale is for.
  await expect(page.locator("#railTicks .tick")).toHaveCount(16);
  await expect(page.locator("#railNeedle")).toBeHidden();
});
