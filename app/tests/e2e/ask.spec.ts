import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/* Ask BrazosCast — the half of its contract a browser can prove without a key.
 *
 * The suite runs against the built app with no serverless function behind it: `/api/ask` is a
 * static host answering 404 (or an HTML page), which is exactly the shape of a deployment where
 * the key was never set. What must hold there is the fallback — one sentence, and every other
 * number on the page exactly as it was.
 *
 * The happy path is deliberately not here. It needs a live key, the model is a third party, and a
 * test that only passes when someone's API key is funded and a model is not busy is a test that
 * will be skipped or, worse, quietly deleted. The logic behind the happy path — resolution,
 * figures, the number guard, the two calls, the endpoint's own validation — is covered by
 * tests/unit/ask.test.ts and tests/unit/ask-endpoint.test.ts with the network stubbed.
 */

test("with no Ask endpoint the panel says so, and the answer is untouched", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=1600+Jackson+Street&stage=42");

  const verdict = await text(page, "verdict");
  const sub = await text(page, "sub");
  const hours = await text(page, "hours");
  await expect(page.locator("#askCard")).toBeVisible();

  await page.locator("#askQ").fill("When is Jackson Street cut off?");
  await page.locator("#askGo").click();

  await expect(page.locator("#askWhy")).toHaveText("Ask is unavailable right now. Every number on this page is unaffected.");
  await expect(page.locator("#askFigs")).toBeHidden();
  await expect(page.locator("#askProse")).toBeHidden();

  // Nothing else moved: the fallback is a sentence in one card, not a degraded page.
  expect(await text(page, "verdict")).toBe(verdict);
  expect(await text(page, "sub")).toBe(sub);
  expect(await text(page, "hours")).toBe(hours);
  await expect(page.locator("#stageVal")).toHaveText("42.00");
});

test("the panel says what the model does and does not do, before anyone types", async ({ page }) => {
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=1600+Jackson+Street");

  const foot = await text(page, "askFoot");
  // The claim the whole feature rests on, stated where a reader meets the box.
  expect(foot).toContain("never produces a number");
  expect(foot).toContain("hypothetical");
  expect(foot).toContain("refused rather than guessed at");
  // And it is a question box, reachable and labelled — not a link to a chatbot.
  await expect(page.locator("#askQ")).toHaveAttribute("aria-label", /street/);
  await expect(page.locator("#askGo")).toBeEnabled();
});
