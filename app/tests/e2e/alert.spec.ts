import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * F7 — the alert, through the interface a person uses.
 *
 * The unit suite proves the two renderers agree character for character; this proves the
 * card is reachable, says what it is (simulated), survives a reload in Spanish, and keeps
 * the same numbers when the language changes. A language toggle that loses a digit between
 * the two views would pass every test that only reads one of them.
 *
 * Replay mode, because the crossing is observed history there rather than a stub's
 * forecast — and the card's whole claim is a lead time.
 */

const URL_EN = "?mode=replay&addr=1600+Jackson+Street&stage=50";

/** The numbers in a string, sorted, so two languages can be compared without their
 *  words matching. */
const digits = (s: string) => (s.match(/\d/g) ?? []).sort().join("");

test("the alert card renders three tiers for the selected street", async ({ page }) => {
  await stubGauge(page, { value: 10 });
  await booted(page, URL_EN);

  await expect(page.locator("#alertCard")).toBeVisible();
  await expect(page.locator("#alTitle")).toHaveText("The alert you would get");
  await expect(page.locator("#alNote")).toContainText("simulated");
  await expect(page.locator("#langEn")).toHaveAttribute("aria-pressed", "true");

  const rows = page.locator(".al-row");
  await expect(rows).toHaveCount(3);
  for (const tier of ["3 days out", "1 day out", "6 hours out"]) {
    await expect(page.locator(".al-row .al-meta b").filter({ hasText: tier })).toHaveCount(1);
  }

  const first = await text(page, "alList");
  expect(first).toContain("Jackson Street");
  expect(first).toContain("72 h");
  expect(first).toContain("12 inches");
  // A template that reached the browser unfilled is the failure this catches.
  expect(first).not.toContain("{");
});

test("switching to Spanish keeps the numbers and travels in the link", async ({ page }) => {
  await stubGauge(page, { value: 10 });
  await booted(page, URL_EN);

  const en = await page.locator(".al-text").allInnerTexts();
  await page.locator("#langEs").click();

  await expect(page.locator("#langEs")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#alTitle")).toHaveText("La alerta que recibiría");
  await expect(page.locator("#alertCard")).toHaveAttribute("lang", "es");

  const es = await page.locator(".al-text").allInnerTexts();
  expect(es).toHaveLength(en.length);
  for (let i = 0; i < en.length; i++) {
    expect(es[i]).not.toBe(en[i]);
    expect(es[i]).toContain("pies");
    expect(digits(es[i])).toBe(digits(en[i]));
  }
  expect(new URL(page.url()).searchParams.get("lang")).toBe("es");

  // The language is part of the answer, not a preference on this device: a reload keeps it.
  await page.reload();
  await expect(page.locator("#srcTag")).not.toHaveText(/connecting/i);
  await expect(page.locator("#alTitle")).toHaveText("La alerta que recibiría");
  const after = await page.locator(".al-text").allInnerTexts();
  expect(after).toEqual(es);
});

test("the text-only route still carries the alert", async ({ page }) => {
  await stubGauge(page, { value: 10 });
  await booted(page, `${URL_EN}&text=1`);

  await expect(page.locator("body")).toHaveClass(/text-only/);
  await expect(page.locator("#alertCard")).toBeVisible();
  await expect(page.locator(".al-row")).toHaveCount(3);
});
