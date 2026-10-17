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
  await expect(page.locator("#verdict")).toHaveText("Water is on your street now");
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
