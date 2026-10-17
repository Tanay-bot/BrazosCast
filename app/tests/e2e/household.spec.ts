import { expect, test, type Browser, type Page } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * F3 — the household card: three addresses, three answers, ranked by which comes first.
 *
 * The plan's done-when is "three addresses produce three rows and the earliest onset is first", and
 * both halves of that are properties rather than fixtures: the rows are read off the card, and the
 * ranking is checked as an ORDER over the numbers the card itself shows. The address list is typed
 * in an order that is deliberately NOT the answer's order, so a card that simply echoed the input
 * would fail rather than pass by luck.
 *
 * The addresses come from the app's own index and the hours from the committed Harvey replay, so
 * the three onsets are far apart by construction (18.3 ft, 33.4 ft, 60.6 ft against a crest of
 * 55.13 ft — the third is never reached, which is the boundary case the ranking has to place last).
 *
 * Replay mode throughout, for the same reason the backcast is replay-only: in live mode the
 * ranking would depend on a forecast the stub invents, and the claim being tested is the ranking,
 * not the forecast.
 */

/** In the input in an order that is deliberately NOT the answer's order — see the note above:
 *  typed first, and ranked last, so the two orders cannot be confused for one another. */
const HOUSEHOLD = ["1 Missouri Street", "100 Thompson Oil Field Road", "2500 Holmes Road"];
const QUERY = `?mode=replay&stage=40&addr=${encodeURIComponent(HOUSEHOLD.join("|"))}`;
const FIRST_TYPED = "1 Missouri Street";
const SOONEST = "100 Thompson Oil Field Road";
const NEVER = "1 Missouri Street";

type Row = { address: string; hours: string; what: string; you: boolean; miss: boolean };

async function rows(page: Page): Promise<Row[]> {
  return page.locator("#hhList .hh-row").evaluateAll((els) =>
    els.map((el) => ({
      address: el.querySelector("b")?.textContent ?? "",
      hours: el.querySelector(".t")?.textContent ?? "",
      what: el.querySelector(".m")?.textContent ?? "",
      you: el.classList.contains("you"),
      miss: el.classList.contains("miss"),
    })),
  );
}

/** The hours a row states, as a number. `—` is "this window never reaches it", i.e. last. */
const hoursOf = (row: Row) => (row.hours === "—" ? Infinity : Number(/\d+/.exec(row.hours)?.[0]));

test("three addresses become three rows, and the earliest onset is first", async ({ page }) => {
  await stubGauge(page, { value: 40 });
  await booted(page, QUERY);

  await expect(page.locator("#hhCard")).toBeVisible();
  const list = await rows(page);
  expect(list, "three addresses did not produce three rows").toHaveLength(3);

  // The ranking: non-decreasing, and the never-reached address last rather than first.
  const hours = list.map(hoursOf);
  expect(hours[0], `the first row states no hours: ${JSON.stringify(list[0])}`)
    .toBeGreaterThan(0);
  for (let i = 1; i < hours.length; i++) {
    expect(hours[i], `row ${i + 1} (${list[i].hours}) comes after a later one (${list[i - 1].hours})`)
      .toBeGreaterThanOrEqual(hours[i - 1]);
  }
  expect(list[0].address, "the earliest onset is not first").toBe(SOONEST);
  expect(list[2].address, "the address no run reaches is not ranked last").toBe(NEVER);
  expect(list[2].address).toBe(FIRST_TYPED);
  expect(list[2].hours).toBe("—");
  expect(list[2].what, "the unreachable row does not say why it has no hours")
    .toContain("not reached inside this window");

  // Two different orders, and the card keeps them apart. The RANKING is by urgency; the ANSWER
  // above follows the order the addresses were given in, because that is the one the user chose.
  // So the marked row is the first-typed address, which here ranks LAST — and if the app instead
  // selected the soonest address, this is the assertion that fails.
  expect(list.map((r) => r.address)).toEqual([SOONEST, "2500 Holmes Road", NEVER]);
  expect(list.filter((r) => r.you).map((r) => r.address)).toEqual([NEVER]);
  expect(list[2].you, "the marked row is not the last one, so this test no longer distinguishes " +
    "the two orders").toBe(true);
  await expect(page.locator("#addrOut")).toHaveText("Missouri Street");
  await expect(page.locator("#askHint")).toContainText("Read as 1 Missouri Street");
  expect(await text(page, "hhNote")).toContain("3 addresses · soonest first");

  // Every address the user typed is still in the box and in the link, in the order typed: the card
  // ranks them, it does not rewrite what they asked about.
  expect(await page.locator("#addr").inputValue()).toBe(HOUSEHOLD.join(" | "));
  expect(new URL(page.url()).searchParams.get("addr")).toBe(HOUSEHOLD.join("|"));
});

test("clicking a row makes it the answer above, and the ranking does not move", async ({ page }) => {
  await stubGauge(page, { value: 40 });
  await booted(page, QUERY);
  const before = (await rows(page)).map((r) => r.address);

  await page.locator("#hhList .hh-row", { hasText: "2500 Holmes Road" }).click();
  await expect(page.locator("#addrOut")).toHaveText("Holmes Road");
  await expect(page.locator("#askHint")).toContainText("Showing 2500 Holmes Road");

  // The ranking is about the addresses, not about which one is being shown: clicking must not
  // reorder the list, or the "soonest first" the card promises would depend on the last click.
  expect((await rows(page)).map((r) => r.address)).toEqual(before);
  const list = await rows(page);
  expect(list.find((r) => r.you)?.address).toBe("2500 Holmes Road");

  // And the link follows the SCREEN: the clicked address leads, the rest of the household follows,
  // so a recipient opens on the street the sender was looking at.
  const shared = new URL(page.url()).searchParams.get("addr") as string;
  expect(shared.split("|")[0]).toBe("2500 Holmes Road");
  expect(shared.split("|").sort()).toEqual([...HOUSEHOLD].sort());
});

test("an address that cannot be placed keeps its own row and its own reason", async ({ page }) => {
  await stubGauge(page, { value: 40 });
  const withBad = [...HOUSEHOLD, "Nowhere Street"];
  await booted(page, `?mode=replay&stage=40&addr=${encodeURIComponent(withBad.join("|"))}`);

  const list = await rows(page);
  expect(list, "the unplaceable address was dropped instead of shown").toHaveLength(4);
  const bad = list.find((r) => r.address === "Nowhere Street");
  expect(bad, "no row for the address that could not be resolved").toBeTruthy();
  expect(bad!.miss, "the failed row is not marked as a miss").toBe(true);
  expect(bad!.hours).toBe("—");
  // The refusal is the app's own, not a generic one: it names the street it could not find.
  expect(bad!.what).toContain("NOWHERE STREET");
  expect(bad!.what).toContain("models the Brazos corridor");
  expect(await text(page, "hhNote")).toContain("1 could not be placed");

  // A row that failed is not a control: it cannot be clicked into the answer.
  await expect(page.locator("#hhList .hh-row.miss")).not.toHaveAttribute("role", "button");
});

test("one address is the answer above, and there is no household card", async ({ page }) => {
  // The card is a comparison, so with nothing to compare it is not shown — and the row it would
  // hold is the answer already on screen.
  await stubGauge(page, { value: 29.4 });
  await booted(page, "?addr=1600+Jackson+Street");
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(page.locator("#hhCard")).toBeHidden();
  expect(await page.locator("#hhList .hh-row").count()).toBe(0);
  // And two of the same address is still one row.
  await page.fill("#addr", "1600 Jackson Street | 1600 Jackson Street");
  await page.locator("#go").click();
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(page.locator("#hhCard")).toBeHidden();
});

test("the household travels in the link", async ({ page, browser }) => {
  await stubGauge(page, { value: 40 });
  await booted(page, QUERY);
  await page.locator("#hhList .hh-row", { hasText: "2500 Holmes Road" }).click();
  await expect(page.locator("#addrOut")).toHaveText("Holmes Road");
  const url = page.url();

  const context = await browser.newContext();
  const stranger = await context.newPage();
  await stubGauge(stranger, { value: 40 });
  await stranger.goto(url);
  // The link is applied after boot, so wait for the answer rather than reading too early.
  await expect(stranger.locator("#addrOut")).toHaveText("Holmes Road");
  await expect(stranger.locator("#hhCard")).toBeVisible();
  const list = await rows(stranger);
  expect(list.map((r) => r.address).sort()).toEqual([...HOUSEHOLD].sort());
  expect(list.find((r) => r.you)?.address, "the link did not restore which address was on screen")
    .toBe("2500 Holmes Road");
  // The ranking is recomputed, not carried: it is the same order the first page had.
  expect(list.map(hoursOf)).toEqual([...list.map(hoursOf)].sort((a, b) => a - b));
  await context.close();
});
