import { expect, test, type Browser, type Page } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * D2/F2 — the link, and the three ways it leaves the page.
 *
 * These were the last human checks in the README: a link copied in one tab and opened in
 * another, both copy paths, and the text toggle. Each is a claim about a *browser* — a clipboard
 * that can refuse, a share sheet that may or may not exist, a URL that has to survive a page it
 * has never seen — so none of them can be checked by reading source or running a module in Node.
 *
 * Four things this file deliberately does that a simpler version would not:
 *
 *   a FRESH CONTEXT, not a reload — a reload keeps the module's state and the history entry, and
 *      "the link restored it" would then be unfalsifiable. A new context is what a neighbour
 *      opening the link in their browser has: the URL and nothing else.
 *   the CLIPBOARD is read back, not assumed — `writeText` rejecting is the normal outcome on a
 *      browser that refuses it, and the app's answer to that is to print the link instead of
 *      showing a button that appears to work.
 *   a CANCELLED share is asserted to do nothing — not to fall through to copying, which would
 *      silently put someone else's link on the clipboard after a deliberate dismissal.
 *   the app's own SUGGESTION LIST supplies the second address, so the test does not depend on
 *      which streets the county happens to have numbered.
 */

const VIEW = "/?addr=1600+Jackson+Street&stage=50";

/** Stub the gauge, boot, and wait for the ADDRESS to resolve: the first render happens before
 *  `applyUrl()` runs, so a link copied off that page would describe the default view instead of
 *  the one on screen — a bug this app has already had once. */
async function opened(page: Page, query = VIEW): Promise<void> {
  await stubGauge(page, { value: 30, lastObsHoursAgo: 0.25 });
  await booted(page, query);
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
}

const here = (page: Page) => page.evaluate(() => location.href);

/** Open a URL the way someone who received it would: a new context, no state, no history. */
async function received(browser: Browser, url: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubGauge(page, { value: 30, lastObsHoursAgo: 0.25 });
  await page.goto(url);
  return { context, page };
}

test("a copied link restores the street, the stage and the mode in a fresh page", async ({ page, context, browser }) => {
  await opened(page);
  const verdict = await text(page, "verdict");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(await here(page)).origin,
  });

  await page.locator("#share").click();
  await expect(page.locator("#shareNote")).toContainText("Link copied");

  // The clipboard is the interface, so it is read back rather than trusted: the summary line
  // first (what a chat message shows) and the URL second (what a browser follows).
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  const [summary, url] = shared.split("\n");
  expect(summary).toContain("Jackson Street");
  expect(summary).toContain("50.0 ft on the Richmond gauge");
  expect(url).toBe(await here(page));
  expect(url).toContain("addr=1600+Jackson+Street");
  expect(url).toContain("stage=50");

  const { context: fresh, page: stranger } = await received(browser, url);
  await expect(stranger.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(stranger.locator("#stageVal")).toHaveText("50.00");
  await expect(stranger.locator("#verdict")).toHaveText(verdict);
  // Live, not the replay the app falls back to when a gauge cannot be read: the mode travels
  // only when it is `replay`, so its absence has to mean live rather than mean nothing.
  await expect(stranger.locator("#srcTag")).toHaveText(/^NOAA NWPS/);
  await fresh.close();
});

test("two different answers produce two different links, each restoring its own", async ({ page, browser }) => {
  await opened(page);
  const first = await here(page);

  // A second street from the app's own datalist — the streets it knows have addresses, rather
  // than a name this test would have to keep in step with the county.
  const options = await page.locator("#samples option").evaluateAll(
    (els) => els.map((e) => (e as HTMLOptionElement).value),
  );
  const other = options.find((o) => !/jackson/i.test(o));
  expect(other, "the suggestion list offers no second street").toBeTruthy();
  await page.fill("#addr", other as string);
  await page.locator("#go").click();
  await expect(page.locator("#addrOut")).not.toHaveText("Jackson Street");
  const second = await here(page);
  const otherStreet = await text(page, "addrOut");

  // Two answers, two links — and the parameters are the reason they differ, not the host or a
  // fragment the app adds for its own bookkeeping.
  expect(second).not.toBe(first);
  expect(new URL(first).searchParams.get("addr")).toBe("1600 Jackson Street");
  // The second link carries the TYPED address rather than the dataset's canonical street name:
  // the house number pins the exact segment, which is why typed text wins when it resolves to
  // the street on screen. The datalist option is not in the URL as typed by accident — it is the
  // address the user asked about, and it is what a shared link has to preserve.
  expect(new URL(second).searchParams.get("addr")).toBe(other as string);
  expect(otherStreet).not.toBe("Jackson Street");

  const { context: fresh, page: stranger } = await received(browser, second);
  // Wait for the link to be APPLIED before reading what it resolved to: the address is resolved
  // asynchronously after boot, so an immediate read catches "no street selected" and would make
  // this a race rather than an assertion. The typed address landing in the box is that moment.
  await expect(stranger.locator("#addr")).toHaveValue(other as string);
  // Read the fresh page the SAME way the street was read off the first: `#addrOut` sits in the
  // eyebrow, which is `text-transform: uppercase`, so `innerText` ("SKINNER LANE", what the
  // screen shows) and `textContent` ("Skinner Lane", the county's own casing) disagree — and
  // Playwright's `toHaveText` compares the latter. Mixing the two readings is how this assertion
  // failed first, on an app that was right both times.
  expect(await text(stranger, "addrOut")).toBe(otherStreet);
  await fresh.close();
});

test("a refused clipboard prints the link instead of a button that appears to work", async ({ page }) => {
  // The refusal is what a browser without a secure context, or with the permission denied,
  // actually does. Simulated here because the granted case is also worth testing above.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
    });
  });
  await opened(page);

  await page.locator("#share").click();
  const url = await here(page);
  // The link itself is on screen, so it can still be selected and copied by hand.
  await expect(page.locator("#shareNote")).toHaveText(`Copy this link: ${url}`);
  await expect(page.locator("#shareNote")).not.toContainText("copied");
});

test("a cancelled share is not a failure and does not silently copy", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __clipboardWrites: number };
    w.__clipboardWrites = 0;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { w.__clipboardWrites++; } },
    });
  });
  await opened(page);

  await page.locator("#share").click();
  // Nothing observable happens on this path — that IS the behaviour — so the handler is given
  // time to run before asserting that it left no trace.
  await page.waitForTimeout(250);
  await expect(page.locator("#shareNote")).toHaveText("the address, stage and mode travel in the link");
  expect(await page.evaluate(() => (window as unknown as { __clipboardWrites: number }).__clipboardWrites)).toBe(0);
});

test("the share sheet is used where it exists, with the answer in hand", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: Record<string, string> | null };
    w.__shared = null;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: Record<string, string>) => { w.__shared = data; return Promise.resolve(); },
    });
  });
  await opened(page);

  await page.locator("#share").click();
  await expect(page.locator("#shareNote")).toHaveText("Shared.");
  const payload = await page.evaluate(() => (window as unknown as { __shared: Record<string, string> }).__shared);
  expect(payload).not.toBeNull();
  expect(payload?.title).toBe("BrazosCast");
  expect(payload?.url).toBe(await here(page));
  // The text is the answer, not the app's name, because the sheet's preview is all a recipient
  // sees before deciding to open it.
  expect(payload?.text).toContain("Jackson Street");
  expect(payload?.text).toContain("50.0 ft on the Richmond gauge");
});

test("the light view travels in the link, in both directions", async ({ page, context, browser }) => {
  await opened(page);
  const toText = await page.locator("#viewToggle").getAttribute("href");
  expect(toText).toContain("text=1");
  expect(toText).toContain("addr=1600+Jackson+Street");
  expect(toText).toContain("stage=50");

  await page.goto(toText as string);
  await expect(page.locator("body")).toHaveClass(/text-only/);
  await expect(page.locator("#map")).toBeHidden();
  await expect(page.locator("#viewToggle")).toHaveText("Full view");
  // The page's OWN address bar, not only the toggle's href: the href is built for the switch,
  // while this is the string the copy path puts on the clipboard — and the claim being tested is
  // that a light view shares a light link. Only the URL can be shared at all.
  expect(new URL(await here(page)).searchParams.get("text")).toBe("1");
  // The light route is a lighter page, not a lost one: the street, the stage and the answer
  // cross with it, and the toggle back carries them home again.
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(page.locator("#stageVal")).toHaveText("50.00");
  await expect(page.locator("#verdict")).toHaveText("Modelled threshold crossed — water may be on your street");

  // Share it from HERE — the recipient of a light link must not be handed the heavy view.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(await here(page)).origin,
  });
  await page.locator("#share").click();
  await expect(page.locator("#shareNote")).toContainText("Link copied");
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  const sharedUrl = shared.split("\n")[1];
  expect(new URL(sharedUrl).searchParams.get("text")).toBe("1");

  const { context: fresh, page: stranger } = await received(browser, sharedUrl);
  await expect(stranger.locator("body")).toHaveClass(/text-only/);
  await expect(stranger.locator("#map")).toBeHidden();
  await expect(stranger.locator("#addrOut")).toHaveText("Jackson Street");

  const back = await stranger.locator("#viewToggle").getAttribute("href");
  expect(back).not.toContain("text=1");
  await stranger.goto(back as string);
  await expect(stranger.locator("#viewToggle")).toHaveText("Text-only");
  await expect(stranger.locator("#addrOut")).toHaveText("Jackson Street");
  await expect(stranger.locator("#map")).toBeVisible();
  expect(new URL(await here(stranger)).searchParams.has("text")).toBe(false);
  await fresh.close();
});
