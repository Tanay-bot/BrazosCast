import { expect, test } from "@playwright/test";
import { booted, stageflow, text } from "./helpers";

/**
 * F6, in a browser, with the origin taken away.
 *
 * Three things this suite deliberately does NOT use, each because it would have made a
 * passing test mean something else:
 *
 *   `context.setOffline(true)` — it stops the page, not the worker. Measured: the worker's
 *      inner fetches still left the machine, so a missing file came back with a STATUS rather
 *      than a network error and the "offline" reload was still refreshing from a live origin.
 *   a stubbed gauge — Playwright cannot route a request the WORKER makes, so once a page is
 *      controlled the real NWPS response arrives (468 KB, and nothing to do with the test).
 *   the assumption that a reading exists — the gauge host is unresolvable for this project
 *      at the DNS layer (playwright.config.ts), for page and worker alike.
 *
 * So the outage is an outage: `origin-gate.mjs` serves the app and, on command, stops
 * answering by destroying the socket. What is asserted below is therefore the cache doing
 * the work with nothing behind it. The one claim that cannot be made here — that the app's
 * own bytes reach the cache in the first place — is asserted in scripts/check-offline.mjs,
 * where the worker is executed directly and the message can be inspected.
 */

const GAUGE_URL = "https://api.water.noaa.gov/nwps/v1/gauges/RMOT2/stageflow";
const ADDR = "/?addr=1600+Jackson+Street&stage=50";

/** Take the origin down (or bring it back). The gate runs in this process's sibling server,
 *  reached over Playwright's own request context, which is deliberately outside the browser:
 *  the switch has to keep working while the browser's network is gone. */
async function gate(request: import("@playwright/test").APIRequestContext, down: boolean) {
  const res = await request.get(`/__gate?${down ? "down" : "up"}=1`);
  expect(res.ok()).toBe(true);
  expect((await res.json()).down).toBe(down);
}

/** Every test leaves the origin answering, so one failure cannot cascade into the next. */
test.afterEach(async ({ request }) => { await gate(request, false); });

/**
 * The copy is written by the worker after the page has loaded, asynchronously. Wait for it
 * to be IN the cache rather than sleeping: the assertions below are about what is cached.
 *
 * `needs` is checked by URL, not by a count. A count is satisfied by the payload alone, and
 * the map's chunk is exactly the part a count cannot see: it arrives through the hand-over,
 * later than everything else, and a reload that raced it would fail as a blank map — the
 * first bug this spec found.
 */
async function waitForCopy(page: import("@playwright/test").Page, needs: RegExp[]) {
  await page.waitForFunction(async (patterns: string[]) => {
    if (!navigator.serviceWorker.controller) return false;
    const c = await caches.open("brazoscast-runtime-v1");
    const keys = (await c.keys()).map((r) => r.url);
    return patterns.every((p) => keys.some((u) => new RegExp(p).test(u)));
  }, needs.map((r) => r.source), { timeout: 20_000 });
}

test("a first visit is enough: the reload with the origin gone still answers", async ({ page, request }) => {
  await booted(page, ADDR);
  // Wait for the ADDRESS to resolve before recording the answer. The first render happens
  // before applyUrl() runs, so "the source line is not connecting" is not "the answer is
  // up" — and comparing against a half-built page would make this test vacuous.
  await expect(page.locator("#addrOut")).toHaveText("Jackson Street");
  const online = {
    verdict: await text(page, "verdict"),
    stage: await text(page, "stageVal"),
  };
  expect(online.verdict).toBe("Water is on your street now");
  // The payload, AND the map's own chunk and stylesheet: content-hashed files no list in the
  // source can name, which the app hands over from its resource timeline once the map has
  // loaded. Without that, the first visit caches a shell whose map cannot be built at all.
  await waitForCopy(page, [/\/data\/ensemble\.json$/, /assets\/maplibre-gl-.*\.js$/, /assets\/maplibre-gl-.*\.css$/]);
  expect(await page.locator("#map").evaluate((el) => el.childElementCount)).toBeGreaterThan(0);

  // The origin goes, for the page and for the worker both.
  await gate(request, true);
  await page.reload();

  // The same answer, from the cache.
  await expect(page.locator("#verdict")).toHaveText(online.verdict);
  await expect(page.locator("#stageVal")).toHaveText(online.stage);
  await expect(page.locator("#askHint")).toContainText("Read as 1600 Jackson Street");
  // The ways-out panel, computed from the cached graph at this stage. Its full text is
  // assembled from several branches and compared too brittlely as a string, so what is
  // required here is the substance: a real destination, a distance, and the isolation
  // number that only exists in the payload.
  await expect(page.locator("#exitNote")).toHaveText("at 50.00 ft");
  const exits = await text(page, "exits");
  expect(exits).toMatch(/\d+(\.\d+)? km/);
  expect(exits).toContain("Your last route out is cut at");
  expect(exits).not.toContain("Enter an address");
  // The map itself, from the cache: a blank map was the second real bug this spec found,
  // because MapLibre's chunk had been fetched before the worker controlled the page.
  await expect.poll(() => page.locator("#map").evaluate((el) => el.childElementCount))
    .toBeGreaterThan(0);

  // Provenance, from the page: which bytes came from storage and which could not come at
  // all. An uncached URL must still fail, or "it worked with the origin gone" proves nothing
  // — and with the gate down, a request that reached the network at all would fail here.
  const probe = await page.evaluate(async () => {
    const get = async (url: string) => {
      try {
        const r = await fetch(url);
        return { status: r.status, marker: r.headers.get("x-brazoscast-cache") };
      } catch (e) { return { failed: String(e).slice(0, 40) }; }
    };
    return {
      shell: await get("./index.html"),
      data: await get("./data/ensemble.json"),
      layer: await get("./data/road_thresholds.geojson"),
      miss: await get("./data/not-a-real-file.json"),
    };
  });
  expect(probe.shell.marker).toBe("hit");
  expect(probe.data.marker).toBe("swr");
  expect(probe.layer.marker).toBe("swr");
  expect(probe.miss.failed).toContain("Failed to fetch");
});

test("a reading in storage is served, and its age is still labelled", async ({ page, request }) => {
  // The state a storm leaves behind: the last reading is in the worker's cache and the gauge
  // cannot be reached. The gauge is unreachable for real here (its host does not resolve),
  // so the reading is put into the cache directly — which is also the only way this can be
  // deterministic, since the worker fetches the live gauge for real once it controls a page.
  await booted(page, ADDR);
  await page.evaluate(async ([url, body]: readonly string[]) => {
    const c = await caches.open("brazoscast-runtime-v1");
    await c.put(url, new Response(body, { headers: { "content-type": "application/json" } }));
  }, [GAUGE_URL, stageflow({ value: 29.4, lastObsHoursAgo: 6 })] as const);
  await waitForCopy(page, [/\/data\/ensemble\.json$/]);

  await gate(request, true);
  // Navigate to the LIVE view rather than reloading, and the difference is the whole test:
  // the app writes `mode=replay` into its own URL when it falls back, so reloading what is
  // in the address bar after a gauge-less first visit asks for 2017 and would prove nothing
  // about a reading in storage. `mode=live` is the view a storm actually interrupts.
  await page.goto(`${ADDR}&mode=live`);

  // The reading survived, and it came from storage rather than from a request: the worker
  // marks what it had to serve while the network was gone.
  const gauge = await page.evaluate(async () => {
    try {
      const r = await fetch("https://api.water.noaa.gov/nwps/v1/gauges/RMOT2/stageflow");
      return { ok: r.ok, marker: r.headers.get("x-brazoscast-cache") };
    } catch (e) { return { failed: String(e).slice(0, 40) }; }
  });
  expect(gauge.ok).toBe(true);
  expect(gauge.marker).toBe("offline");

  // The live reading, not the Harvey replay the app falls back to when a gauge cannot be read
  // at all: without this, an outage that quietly degraded to 2017 would look like a pass.
  await expect(page.locator("#srcTag")).toHaveText(/^NOAA NWPS RMOT2/);
  // The line names the observation it is standing on. Its age is asserted below through the
  // app's own measurement rather than by parsing a locale-formatted time with no year in it.
  await expect(page.locator("#srcTag")).toContainText("observed to");

  // ...and the app still measures that reading's age rather than presenting it as current:
  // the honest-labelling rule survives the cache. Six hours is inside the measured
  // persistence regime, so the answer is the last observation, named as such.
  const sub = await text(page, "sub");
  expect(sub).toContain("RMOT2 has not reported for 6 h — showing its last observation");
  expect(sub).not.toContain("ESTIMATED");
  // The answer itself is still on screen.
  await expect(page.locator("#verdict")).toHaveText("Water is on your street now");
});

test("the offline tag says what it can actually know", async ({ page, context }) => {
  await booted(page, ADDR);
  await waitForCopy(page, [/\/data\/ensemble\.json$/]);

  // The origin gone, the browser believing it is connected: the tag stays hidden, because
  // it reports the browser's own signal and not an inference about the server. An outage
  // that this app cannot detect must not be described as one.
  await expect(page.locator("#offlineTag")).toBeHidden();

  // The browser's signal itself, which is the storm this feature is for: now it shows, with
  // its own words rather than a claim about the network.
  await context.setOffline(true);
  await expect(page.locator("#offlineTag")).toBeVisible();
  await expect(page.locator("#offlineTag")).toHaveAttribute("title", /no connection/);

  await context.setOffline(false);
  await expect(page.locator("#offlineTag")).toBeHidden();
});

test("the light route is also the one that survives an outage", async ({ page, request }) => {
  await booted(page, "?text=1&addr=1600+Jackson+Street&stage=50");
  await waitForCopy(page, [/\/data\/ensemble\.json$/]);

  await gate(request, true);
  await page.reload();

  await expect(page.locator("#verdict")).toHaveText("Water is on your street now");
  await expect(page.locator("#mapNote")).toHaveText(/^\d+ of 1614 segments under water$/);
  // The chart's text summary, from the cached payload alone. Which summary it is depends on
  // whether a reading could be read at all (the gauge is unreachable in this project), so
  // what is asserted is the substance: real points, a real low and high, and no canvas.
  const chart = await text(page, "chartText");
  expect(chart).toMatch(/^\d+ observed points?, /);
  expect(chart).toMatch(/Lowest \d+(\.\d+)? ft/);
  expect(chart).toMatch(/Highest \d+(\.\d+)? ft/);
  // Text mode is not merely styled: no map was built, so no tiles were ever requested.
  await expect(page.locator("#map")).toBeHidden();
  expect(await page.locator("#map").evaluate((el) => el.childElementCount)).toBe(0);
});

test("with nothing cached, an offline load cannot pretend", async ({ page, request }) => {
  // The control for the tests above. A fresh context has no worker and no cache; if this DID
  // load, the reloads above would be proving nothing about the cache.
  await gate(request, true);
  await expect(page.goto("/")).rejects.toThrow();
});
