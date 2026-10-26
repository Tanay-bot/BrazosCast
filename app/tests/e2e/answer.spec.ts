import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * The answer itself: does a typed address reach a street, a way out of it, and an honest
 * uncertainty block?
 *
 * D1's address resolution, the routing stage and the ensemble are all exercised here for
 * the first time through the interface a user has: a URL and a rendered card.
 */

test("a typed address resolves to a street, a verdict and a route out", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=1600+Jackson+Street&stage=50");

  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(page.locator("#askHint")).toContainText("Read as 1600 Jackson Street");
  await expect(page.locator("#verdict")).toHaveText("Modelled threshold crossed — water may be on your street");
  await expect(page.locator("#hoursLab")).toHaveText(/hours of lead time|until you are cut off/);

  // Ways out: a real destination with a distance, computed on the road graph at this stage.
  await expect(page.locator("#exitNote")).toHaveText("at 50.00 ft");
  const exits = await text(page, "exits");
  expect(exits).toMatch(/\d+(\.\d+)? km/);
  expect(exits).toMatch(/crosses water|dry/);

  // The selected street travels in the URL, so the answer can be sent to someone.
  expect(new URL(page.url()).searchParams.get("addr")).toBe("1600 Jackson Street");

  // And the disclosure that the threshold is biased is on the answer, not only in the docs.
  expect(await text(page, "sub")).toContain("over-predict");
});

test("a street the app does not model is refused, and the refusal says why", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=Nowhere+Street");

  await expect(page.locator("#addrOut")).toHaveText("no street selected");
  await expect(page.locator("#verdict")).toHaveText("Enter an address to see your lead time");
  const hint = await text(page, "askHint");
  expect(hint).toContain("No street");
  expect(hint).toContain("models the Brazos corridor");
});

/* The stripe is the fastest thing on the page to read, and it used to read the RIVER.
 *
 * At 42 ft the gauge's official category is "Action stage" — amber — while a street that
 * floods at 36.1 ft is under water and the headline says "Do not drive out". Colour is read
 * before text, so the one place the design argued against the product was the place everyone
 * looks first. These two tests hold the stripe to the street. */
test("the stripe follows the street, not the river's official category", async ({ page }) => {
  const stripe = () => page.locator("#sevStripe")
    .evaluate((el) => getComputedStyle(el).backgroundColor);

  // No street selected: there is nothing to speak for but the river, so the card wears the
  // river's official category. This is also the colour the street case must NOT reuse.
  await stubGauge(page, { value: 42 });
  await booted(page, "?stage=42");
  await expect(page.locator("#sevPill")).toHaveText("Action stage");
  await expect(page.locator("#answer")).toHaveAttribute("data-urgency", "river");
  const river = await stripe();

  // The same 42 ft against 1600 Jackson Street (floods at 36.1 ft): the river is officially
  // at "action" and the street is under water, and the stripe has to say the second thing.
  await booted(page, "?addr=1600+Jackson+Street&stage=42");
  await expect(page.locator("#verdict")).toHaveText("Modelled threshold crossed — water may be on your street");
  await expect(page.locator("#sevPill")).toHaveText("Threshold crossed");
  await expect(page.locator("#answer")).toHaveAttribute("data-urgency", "flooded");
  expect(await stripe(), "the stripe is still the river's amber at a flooded street")
    .not.toBe(river);

  // A street the forecast never reaches is green, not the river's category: that is the
  // product's answer, and it is the one the stripe should be carrying.
  await stubGauge(page, { value: 10 });
  await booted(page, "?addr=1600+Jackson+Street&stage=30");
  await expect(page.locator("#sevPill")).toHaveText("Your street is dry");
  await expect(page.locator("#answer")).toHaveAttribute("data-urgency", "dry");
});

/* The live river is low almost every day, so the bare link is a page of zeroes. */
test("a low river says so, and points at the day it was not", async ({ page }) => {
  await stubGauge(page, { value: 8.38 });
  await booted(page);

  const note = page.locator("#lowWater");
  await expect(note).toBeVisible();
  await expect(note).toContainText("8.38 ft");
  await expect(note).toContainText("below the 20 ft action stage");
  const href = await page.locator("#lowWaterLink").getAttribute("href");
  expect(href, "the low-water link does not open the replay").toContain("mode=replay");
  expect(href, "the low-water link does not open where the answer works").toContain("stage=30");

  // Above the action stage there is something to look at, so the line is out of the way...
  await stubGauge(page, { value: 42 });
  await booted(page, "?stage=42");
  await expect(note).toBeHidden();

  // ...and it never appears in replay, where 2017 is already on screen.
  await booted(page, "?mode=replay");
  await expect(note).toBeHidden();

  // The link does what it says: the household travels with it, the event and stage change,
  // and the page it lands on is the honest version of this one — a river with hours to give.
  await stubGauge(page, { value: 8.38 });
  await booted(page, "?addr=1600+Jackson+Street");
  await expect(note).toBeVisible();
  await Promise.all([
    page.waitForURL(/mode=replay/),
    page.locator("#lowWaterLink").click(),
  ]);
  await expect(page.locator("#mReplay")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(page.locator("#stageVal")).toHaveText("30.00");
  await expect(page.locator("#verdict")).toContainText("Water is modelled to reach this street");
  await expect(page.locator("#answer")).toHaveAttribute("data-urgency", "coming");
  // Hours, not "too late": the whole reason it opens before the crest. 145 h at the gauge's
  // own first crossing of this street's 36.1 ft — the number the demo is built on.
  expect(Number(await text(page, "hours"))).toBeGreaterThan(24);
});

test("when no run reaches a street the ensemble says exactly that", async ({ page }) => {
  // A low river against a street that floods at 40.6 ft: the degenerate case the ensemble
  // has to render without pretending to have a distribution.
  await stubGauge(page, { value: 10 });
  await booted(page, "?addr=1600+Jackson+Street");

  await expect(page.locator("#ens")).toBeVisible();
  await expect(page.locator("#ensCount")).toHaveText("0 of 50");
  await expect(page.locator("#ensRange")).toHaveText("no run reaches it within the window");
  await expect(page.locator("#ensNever")).toHaveText("50 of 50 never reach it in the window");

  // One square per run, none of them filled — the count and the grid cannot disagree.
  const grid = page.locator("#ensGrid i");
  await expect(grid).toHaveCount(50);
  await expect(page.locator("#ensGrid i.on")).toHaveCount(0);

  await expect(page.locator("#hours")).toHaveText("—");
  await expect(page.locator("#hoursLab")).toHaveText("no crossing forecast");
});

/* Switching modes replaces everything but the chrome, so it also has to replace the position.
 * Clicking Harvey replay from halfway down the page left the reader in a statistics table
 * with no answer on screen — the mode had changed and nothing visible had. */
test("a mode change returns to the top of the page", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=1600+Jackson+Street&stage=50");

  await page.evaluate(() => window.scrollTo(0, 2200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // The header is sticky, so the control is reachable from wherever the reader is.
  await page.locator("#mReplay").click();
  await expect(page.locator("#bcCard")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator("#verdict")).toBeInViewport();
});

/* The robustness card's hardest case, in the direction that used to be wrong.
 *
 * A forecast that peaks just under a street's threshold is a "not reached" answer, and the card
 * used to skip the forecast rows entirely for it — reporting that the answer survived, when an
 * upward-shifted forecast is exactly how a near miss becomes a crossing. The stub below peaks at
 * 40.0 ft against 1600 Jackson Street's 40.6 ft, so the point estimate is "not reached", and the
 * +1σ envelope has to reach it, be marked as a reversal, and say where it came from. */
test("a forecast that peaks under the threshold is still perturbed, and can come back reached", async ({ page }) => {
  await stubGauge(page, { value: 30, forecastTo: 40, forecastHours: 48 });
  await booted(page, "?addr=1600+Jackson+Street");

  await expect(page.locator("#robCard")).toBeVisible();
  await expect(page.locator("#robHead")).toContainText("does NOT reach this street");

  const hi = page.locator(".rob-row", { hasText: "Forecast 1σ high" });
  await expect(hi).not.toHaveClass(/skip/);
  await expect(hi).toHaveClass(/bad/);                      // a reversal, marked as one
  await expect(hi.locator("span").first()).not.toHaveText("not reached");
  await expect(hi.locator("span").nth(1)).toHaveText("from never");
  await expect(page.locator("#robVerdict")).toContainText("do not all preserve the answer");

  // And the curve's provenance is on the card, not only in the docs: an assumption, never a
  // calibration of NOAA's uncertainty.
  await expect(page.locator("#robNote")).toContainText("assumption about NOAA's error");
});
