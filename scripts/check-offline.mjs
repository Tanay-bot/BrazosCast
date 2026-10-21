#!/usr/bin/env node
/**
 * BrazosCast — the offline route, checked by RUNNING the service worker.
 *
 * F6's promise is "offline, a reload still answers". A service worker is the one part of
 * this app that cannot be checked by reading it: its behaviour is entirely in how it
 * answers requests, and its answers depend on state (which cache, how old, whether the
 * network was there at all). So this loads `app/dist/sw.js` in Node inside a fake world — a
 * `fetch` backed by the real `dist/` tree, a Cache API shim, and an on/off switch for the
 * network — and drives it through install, a navigation, the data path, the gauge, a deploy
 * and a cache purge.
 *
 * Why not a browser: DevTools offline cannot be automated from here (T7 is still open), and
 * a check only a human can run is a check that stops running. This harness sees the shipped
 * artefact, not the source that was meant to ship it, and it fails when the worker stops
 * doing what the docs say it does.
 *
 * The assertions that matter most, in order:
 *
 *   1. INSTALL FETCHES THE SHELL AND NOTHING ELSE. The payload is 1.6 MB and `?text=1`
 *      exists for phones where 85 KB of fonts was the difference between an answer and a
 *      spinner — precaching `data/*` at install would take that back. Asserted on the
 *      requests the worker actually made, not on the text of the source.
 *   2. A RELOAD WITH NO NETWORK ANSWERS. Navigation and already-fetched data both come
 *      back with the network off; an uncached URL fails loudly rather than pretending.
 *   3. A CACHED READING NEVER BEATS A FRESH ONE, and the last one is still served when
 *      there is no fresh one.
 *   4. A DEPLOY THAT CHANGES THE SHELL'S HASHED ASSETS DOES NOT STRAND THE CACHE: the new
 *      shell is stored only after the files it names, and the old ones are dropped.
 *      Getting this wrong is invisible until an offline reload serves a blank page.
 *
 * The body bytes it counts are uncompressed, because they are read off disk; a browser
 * reuses its HTTP cache for the hashed assets, so the measured per-visit cost is a
 * conditional revalidation of the HTML, not a re-download. The browser figures are in the
 * README and in docs/ACTION-PLAN.md.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "app", "dist");

const ORIGIN = "http://localhost:4173";
const SW_URL = `${ORIGIN}/sw.js`;
/* Two documents ship now: the landing at `/` and the app at `/app`. The harness treats the
 * app as the shell it has always tested, and asserts the landing is cached alongside it —
 * a cached landing served for an app reload is the bug this split could introduce. */
const SHELL_URL = `${ORIGIN}/app.html`;
const LANDING_URL = `${ORIGIN}/index.html`;
const DATA_DIR = `${ORIGIN}/data/`;
const GAUGE = "https://api.water.noaa.gov/nwps/v1/gauges/RMOT2/stageflow";
/* The tile the app actually asks for: OpenFreeMap's vector planet (the basemap), with the
 * OSM raster style as the fallback. Only the shape matters here — a third-party URL that is
 * not payload — but naming the real host keeps the failure message honest. */
const TILE = "https://tiles.openfreemap.org/planet/20250122_001001_pt/12/940/1702.pbf";
const FONT = "https://fonts.gstatic.com/s/publicsans/v1/xyz.woff2";
const SHELL_CACHE = "brazoscast-shell-v1";
const RUNTIME_CACHE = "brazoscast-runtime-v1";
const MARK = "x-brazoscast-cache";

let stage = "setup";
const fail = (msg) => {
  console.error(`\nFAILED [${stage}]: ${msg}`);
  process.exit(1);
};
const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
const outcome = async (p) => {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; }
};

if (!existsSync(join(DIST, "sw.js"))) {
  fail("app/dist/sw.js is missing — this check runs after `vite build`, which copies public/. Without " +
       "the file the app registers nothing and is offline-capable on paper only.");
}
const DIST_ASSETS = readdirSync(join(DIST, "assets"));
const MAP_CHUNK = DIST_ASSETS.find((f) => /^maplibre-gl-.*\.js$/.test(f));
if (!MAP_CHUNK) fail("dist/assets has no maplibre-gl-*.js chunk; the text-mode check should have failed first");

/* ------------------------------------------------------------------- the world --- */

/** A fake fetch/caches pair over the real dist tree.
 *
 *  `content-encoding: gzip` is stamped on the text responses on purpose: that is what a
 *  compressing host like Cloudflare Pages sends, and a worker that stores such a body while
 *  keeping the header produces a cached page the browser refuses to parse. This makes that
 *  reachable without a network. */
function makeWorld() {
  const requests = [];                     // network requests that produced a body
  const attempts = [];                     // every URL that left the worker for the network
  const httpCacheHits = [];                // served from the browser's HTTP cache, no request
  const overlay = new Map();               // url -> { body, type } — stands in for a deploy
  const httpCache = new Map();             // url -> { body, type, mustRevalidate } — the browser's own
  const stores = new Map();                // cache name -> Map(url -> stored entry)
  let offline = false;

  const typeFor = (path) =>
    path.endsWith(".json") ? "application/json" :
    path.endsWith(".geojson") ? "application/geo+json" :
    path.endsWith(".html") ? "text/html; charset=utf-8" :
    path.endsWith(".css") ? "text/css" :
    path.endsWith(".js") ? "text/javascript" : "application/octet-stream";

  const urlOf = (key) =>
    typeof key === "string" ? key : key && key.url ? key.url : String(key);

  function bodyFor(url) {
    if (overlay.has(url)) return overlay.get(url);
    const u = new URL(url);
    if (u.hostname === "api.water.noaa.gov") {
      const body = JSON.stringify({ observed: { data: [{ validTime: "2026-10-15T00:00:00Z", primary: 29.4 }] } });
      return { body: Buffer.from(body), type: "application/json" };
    }
    if (u.origin !== ORIGIN) return null;          // nothing else is ours to serve
    const path = join(DIST, decodeURIComponent(u.pathname));
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return { body: readFileSync(path), type: typeFor(u.pathname) };
  }

  const fakeFetch = async (input) => {
    const url = urlOf(input);
    /* The browser's own HTTP cache, consulted by EVERY request — which is what a browser
     * does, and the mechanism the warm-up rests on.
     *
     * It used to be modelled as a special case of `only-if-cached`, and that is exactly how
     * this harness blessed a warm-up that copied nothing: `only-if-cached` cannot be
     * satisfied by a response that has to be REVALIDATED, and every static host (and the
     * preview server this suite runs against) sends `Cache-Control: no-cache`. Measured in
     * a real browser, the worker's `only-if-cached` copy rejected for every file. A plain
     * fetch does not: the browser answers from what it holds, with a conditional request at
     * worst.
     *
     * This model is generous in one direction worth naming: it reuses any entry it holds,
     * while a real browser also weighs freshness, `Vary` and the request's shape. Whether
     * that generosity ever matters is not decidable from inside the worker (see the note in
     * the warm section below), so the check asserts the mechanism and reports the cost. */
    const held = httpCache.get(url);
    /* `only-if-cached` asks for bytes the browser can produce WITHOUT the network. A
     * response the host marked `no-cache` — which is what the preview server and every
     * static host send — cannot be produced that way: it has to be revalidated, and this
     * mode forbids the request that would do it. That distinction is modelled here on
     * purpose. Treating the mode as a plain cache lookup is how this harness came to bless
     * a warm-up that copied nothing at all, which only a real browser could show. */
    if (input && input.cache === "only-if-cached") {
      if (input.mode !== "same-origin") {
        throw new TypeError("only-if-cached can be set only with same-origin mode");
      }
      if (!held || held.mustRevalidate) {
        throw new TypeError(`only-if-cached: ${url} cannot be served without revalidating`);
      }
      httpCacheHits.push(url);
      return new Response(held.body, { status: 200, headers: new Headers({ "content-type": held.type }) });
    }
    /* The other two modes a request can ask for, and the reason they are modelled rather than
     * waved through: a held entry is not automatically a cache READ. `reload` bypasses the HTTP
     * cache outright, and `no-cache` may reuse an entry only if it does not have to be
     * revalidated first. Treating every held entry as a hit made "the copy came out of the
     * browser's cache" unobservable — the warm stage below counts these reads, so a warm-up that
     * re-downloaded the payload would have passed it. Measured by mutation: replacing the warm-up's
     * plain `fetch(url.href)` with `cache: "no-cache"` is a defect the warm stage only sees once
     * this distinction exists. */
    const mode = input && typeof input === "object" ? input.cache : undefined;
    const heldIsUsable = held
      && (mode === "reload" ? false : mode === "no-cache" ? !held.mustRevalidate : true);
    if (heldIsUsable) {
      httpCacheHits.push(url);
      return new Response(held.body, { status: 200, headers: new Headers({ "content-type": held.type }) });
    }
    attempts.push(url);
    if (offline) throw new TypeError(`fetch failed: no network (${url})`);
    const found = bodyFor(url);
    if (!found) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const headers = new Headers({ "content-type": found.type });
    if (new URL(url).origin === ORIGIN && /json|html|javascript|css/.test(found.type)) {
      headers.set("content-encoding", "gzip");
    }
    requests.push({ url, bytes: found.body.length });
    return new Response(found.body, { status: 200, headers });
  };

  const toEntry = async (url, res) => ({
    url,
    status: res.status,
    statusText: res.statusText,
    headers: new Headers(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  });
  const toResponse = (e) =>
    new Response(e.body, { status: e.status, statusText: e.statusText, headers: new Headers(e.headers) });

  function cacheNamed(name) {
    const map = stores.get(name) ?? new Map();
    stores.set(name, map);
    return {
      async match(key) {
        const e = map.get(urlOf(key));
        return e ? toResponse(e) : undefined;
      },
      async put(key, res) { map.set(urlOf(key), await toEntry(urlOf(key), res)); },
      async delete(key) { return map.delete(urlOf(key)); },
      async keys() { return [...map.keys()].map((url) => ({ url })); },
    };
  }

  const caches = {
    async open(name) { return cacheNamed(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(key) {
      const url = urlOf(key);
      for (const map of stores.values()) if (map.has(url)) return toResponse(map.get(url));
      return undefined;
    },
  };

  const listeners = {};
  const self = {
    location: new URL(SW_URL),
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    clients: { claim: async () => {} },
  };

  // The shipped worker, executed. `new Function` rather than import() because a service
  // worker is a classic script, and because the shims have to be in scope under their
  // real names.
  // eslint-disable-next-line no-new-func
  new Function("self", "caches", "fetch", readFileSync(join(DIST, "sw.js"), "utf8"))(self, caches, fakeFetch);

  const fire = async (type, ev) => {
    for (const fn of listeners[type] ?? []) fn(ev);
  };

  return {
    requests,
    attempts,
    httpCacheHits,
    httpCache,
    stores,
    overlay,
    caches,
    requestsFrom: (n) => requests.slice(n),
    attemptsFrom: (n) => attempts.slice(n),
    setOffline: (v) => { offline = v; },
    async install() {
      const waits = [];
      await fire("install", { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    },
    async activate() {
      const waits = [];
      await fire("activate", { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    },
    /** One request, as the browser would hand it to the worker: `respondWith` is called
     *  synchronously by the handler, so whether the worker answered is known at once, and
     *  the answer (which may be a rejection) is awaited by the caller. */
    async request(url, { mode = "cors", method = "GET" } = {}) {
      const waits = [];
      let answer = null;
      const req = new Request(url, { method });
      if (mode === "navigate") Object.defineProperty(req, "mode", { value: "navigate" });
      await fire("fetch", {
        request: req,
        waitUntil: (p) => waits.push(p),
        respondWith: (p) => { answer = p; },
      });
      return { intercepted: answer !== null, response: answer, waits };
    },
    async drain(waits) { await outcome(Promise.all(waits)); },
    /** A postMessage from the page, as the worker receives it. */
    async message(data) {
      const waits = [];
      await fire("message", { data, waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}

/* ---------------------------------------------------------------- the checks --- */

const world = makeWorld();
const read = (p) => readFileSync(join(DIST, p));
const htmlFile = read("app.html").toString("utf8");
const landingHtml = read("index.html").toString("utf8");
const assetsOf = (html) => [...new Set([...html.matchAll(/["']\.?\/?(assets\/[^"']+\.(?:js|css))["']/g)].map((m) => m[1]))];
const entryAssets = assetsOf(htmlFile);
const landingAssets = assetsOf(landingHtml);
const shellCache = () => world.stores.get(SHELL_CACHE) ?? new Map();
const runtimeCache = () => world.stores.get(RUNTIME_CACHE) ?? new Map();
/* The entries of a cache, read through the shim's own Map rather than through the
 * worker's view of it: this is the check looking at storage, not the worker reporting
 * on itself. */
const cacheKeys = (name) => [...(world.stores.get(name) ?? new Map()).keys()];

/* --- 1. install fetches the shell, and nothing else ---------------------------- */
stage = "install";
await world.install();
await world.activate();

const installed = world.requests.map((r) => r.url);
const installBytes = world.requests.reduce((a, r) => a + r.bytes, 0);
const eagerPayload = installed.filter((u) => u.startsWith(DATA_DIR));
if (eagerPayload.length) {
  fail(`install fetched ${eagerPayload.length} payload file(s), starting with ${eagerPayload[0]}. The eager ` +
       `set must be the shell only: data is cached when the app asks for it, which costs a visitor nothing ` +
       `because the app asks for all of it on every boot anyway. This is the ?text=1 budget, spent.`);
}
const foreign = installed.filter((u) => new URL(u).origin !== ORIGIN);
if (foreign.length) {
  fail(`install fetched cross-origin ${foreign[0]}. Fonts and tiles must not be in the eager set — the fonts ` +
       `are exactly what ?text=1 refuses to download.`);
}
if (installed.some((u) => u.includes("maplibre"))) {
  fail("install fetched the MapLibre chunk. It is a dynamic import, deliberately not referenced by index.html, " +
       "so the map arrives after the answer rather than with it.");
}
if (!entryAssets.some((a) => /\/app-[^/]+\.js$/.test(a))) {
  fail(`dist/app.html names no app-*.js entry chunk (found ${entryAssets.join(", ")})`);
}
if (!landingAssets.some((a) => /\/landing-[^/]+\.js$/.test(a))) {
  fail(`dist/index.html names no landing-*.js entry chunk (found ${landingAssets.join(", ")})`);
}

for (const [which, url, wanted] of [["the app", SHELL_URL, htmlFile], ["the landing", LANDING_URL, landingHtml]]) {
  const doc = await shellCache().get(url);
  if (!doc) fail(`install did not cache ${which} document (${url}) — an offline reload would have nothing to load`);
  if (doc.body.toString("utf8") !== wanted) fail(`the cached ${which} document is not the built file`);
}
const shell = await shellCache().get(SHELL_URL);
if (shell.headers.get("content-encoding")) {
  fail("the cached shell keeps content-encoding from the host. Its stored body is decoded, so a browser " +
       "replaying it tries to gunzip plain text and renders nothing — plain()/shellResponse() exist for this.");
}
if (!/text\/html;\s*charset=utf-8/i.test(shell.headers.get("content-type") ?? "")) {
  fail(`the cached shell has content-type ${JSON.stringify(shell.headers.get("content-type"))}; it must restate ` +
       `utf-8, because the document is not ASCII (em dashes, "·") and the meta tag is the only other guarantee.`);
}
for (const a of [...entryAssets, ...landingAssets]) {
  if (!(await shellCache().get(`${ORIGIN}/${a}`))) {
    fail(`install did not cache ${a}, which a document names. A cached shell whose entry chunk is missing renders ` +
         `a blank page offline — worse than not being offline-capable at all.`);
  }
}
/* What install actually stored, used below as the invariant a failed revalidation must not
 * change. Taken from storage rather than predicted from the HTML, because the documents also
 * name their favicon and any other same-origin file the worker resolves. */
const shellAfterInstall = cacheKeys(SHELL_CACHE).sort();
console.log(`   install: ${installed.length} requests, ${kb(installBytes)} uncompressed — ` +
            `2 documents + ${shellAfterInstall.length - 2} hashed assets, no payload, no fonts, no tiles`);

/* --- 1b. the first visit hands over what it has already paid for --------------- */
/* Without this, offline works from the SECOND visit: the page fetches its payload before
 * the worker controls it, so nothing is cached until the worker sees a fetch — and the map's
 * chunks, which the page loads before the worker controls it too, are never cached at all.
 * The warm-up therefore asks for each URL the app reports, and the browser answers out of
 * its own cache: the cost is a request, never the file again. */
stage = "warm";
/* `mustRevalidate` is what the host says about the response, not a property of this world:
 * the preview server, and every static host worth deploying to, send `Cache-Control:
 * no-cache` for HTML and JSON. It is the reason a plain fetch is cheap and `only-if-cached`
 * is impossible. */
const warmData = { body: read("data/address_index.json"), type: "application/json", mustRevalidate: true };
world.httpCache.set(`${ORIGIN}/data/address_index.json`, warmData);
// The entry chunk is already in the shell cache from install, and is offered again here to
// prove the already-cached check happens BEFORE the copy: it is in the HTTP cache too, so a
// missing guard would show up as a hit.
const already = `${ORIGIN}/${entryAssets[0]}`;
world.httpCache.set(already, { body: read(entryAssets[0]), type: "text/javascript", mustRevalidate: true });
const warmGauge = "https://api.water.noaa.gov/nwps/v1/gauges/WARM1/stageflow";
const warmGaugeBody = JSON.stringify({ observed: { data: [{ validTime: "2026-10-15T00:00:00Z", primary: 27.1 }] } });

const beforeWarm = world.requests.length;
const beforeHits = world.httpCacheHits.length;
const beforeAttempts = world.attempts.length;
await world.message({
  type: "offline-copy",
  entries: [
    { url: "./data/address_index.json" },                             // in the HTTP cache
    { url: "./data/harvey_backcast.json" },                            // NOT in the HTTP cache
    { url: already },                                                  // already cached
    { url: warmGauge, body: warmGaugeBody, type: "application/json" },  // the gauge body
    { url: "https://tiles.example/1/2/3.png" },                        // not ours to copy
    { junk: true },                                                    // malformed
  ],
});
const warmRequests = world.requestsFrom(beforeWarm);
const warmHits = world.httpCacheHits.slice(beforeHits);
const warmed = await runtimeCache().get(`${ORIGIN}/data/address_index.json`);
if (!warmed) {
  fail("the warm-up did not copy a file the page had already loaded out of the HTTP cache, so a first " +
       "visit still has no offline payload — the cache would only start mattering on the second load.");
}
if (!warmed.body.equals(warmData.body)) fail("the warmed copy is not the file the browser had");
if (!warmHits.includes(`${ORIGIN}/data/address_index.json`)) {
  fail("the warm-up did not read the file out of the browser's HTTP cache, so the copy came from " +
       "somewhere that can spend the bytes again.");
}
if (warmHits.includes(already)) {
  fail("an already-cached file was copied again; the cache lookup must come first");
}
/* A URL the browser does NOT hold is the one case where this can spend real bytes, and it is
 * asserted as a BOUND rather than forbidden, because it cannot be detected from inside the
 * worker: `only-if-cached` is the only cache mode that answers the question, and it cannot
 * be satisfied by a response that must be revalidated. The app only offers URLs it has just
 * fetched, so what lands here is a no-store response or a cache key the worker's request
 * does not reproduce. What it must never be is the payload re-downloaded on every visit, or
 * a file that cost more than it does. */
const notHeld = `${ORIGIN}/data/harvey_backcast.json`;
if (warmRequests.length !== 1 || warmRequests[0].url !== notHeld) {
  fail(`the warm-up re-downloaded ${warmRequests.map((r) => r.url).join(", ") || "nothing"}. Only a URL the ` +
       `browser does not already hold may cost a body, and only one was offered; anything else means the ` +
       `HTTP-cache path stopped working, or the app is offering files it never fetched.`);
}
const warmBodyBytes = warmRequests.reduce((a, r) => a + r.bytes, 0);
if (warmBodyBytes > read("data/harvey_backcast.json").length) {
  fail(`the warm-up spent ${kb(warmBodyBytes)} on one file that is ` +
       `${kb(read("data/harvey_backcast.json").length)} uncompressed`);
}
const warmGaugeStored = await runtimeCache().get(warmGauge);
if (!warmGaugeStored) {
  fail("the gauge body was not stored. Its response is 468 KB with no validator, so an HTTP-cache copy is " +
       "impossible and a re-fetch is the whole thing again — the bytes in hand are the only cheap copy.");
}
if (JSON.parse(warmGaugeStored.body.toString())?.observed?.data?.[0]?.primary !== 27.1) {
  fail("the stored gauge body is not the one the app handed over");
}
const foreignAttempts = world.attemptsFrom(beforeAttempts).filter((u) => new URL(u).origin !== ORIGIN);
if (foreignAttempts.length) {
  fail(`the warm-up tried to fetch cross-origin ${foreignAttempts[0]}. Tiles and fonts are skipped on ` +
       `purpose — the fonts are exactly what ?text=1 refuses to download, and a tile is not the app's to ` +
       `collect. (Counted as an ATTEMPT, not a body: a refusal from the other host is still a request the ` +
       `visitor's browser made on this app's behalf.)`);
}
await world.message({ type: "offline-copy" });            // no entries: must be ignored quietly
await world.message({ type: "something-else", entries: [1] });
await world.message(null);
console.log(`   warm:     6 entries offered, 1 read out of the HTTP cache, 1 body from memory, ` +
            `1 not held (${kb(warmBodyBytes)} re-downloaded), ${warmHits.length} HTTP-cache reads`);

/* --- 2. a reload with no network answers -------------------------------------- */
stage = "offline reload";
world.setOffline(true);
for (const [label, url, wanted] of [
  ["a plain reload", SHELL_URL, htmlFile],
  ["a legacy `/app` reload", `${ORIGIN}/app`, htmlFile],
  ["a text-only link", `${ORIGIN}/app?text=1`, htmlFile],
  ["the landing", `${ORIGIN}/`, landingHtml],
]) {
  const r = await world.request(url, { mode: "navigate" });
  if (!r.intercepted) fail(`${label} was not intercepted by the worker, so there is nothing offline about it`);
  const res = await outcome(r.response);
  if (!res.ok) fail(`${label} failed with the network off: ${res.error}`);
  if (res.value.status !== 200) fail(`${label} answered ${res.value.status} with the network off`);
  if (res.value.headers.get(MARK) !== "hit") {
    fail(`${label} was not answered from the cache (marker ${JSON.stringify(res.value.headers.get(MARK))})`);
  }
  if ((await res.value.text()) !== wanted) {
    fail(`${label} returned the wrong document — an offline reload must land on the page it asked for`);
  }
}
// A navigation also starts a revalidation. Offline that must settle quietly: a rejection
// here is an unhandled promise inside waitUntil, which is a console error in production.
const quiet = await world.request(SHELL_URL, { mode: "navigate" });
await world.drain(quiet.waits);
// ...and it must leave the cache exactly as it was. A revalidation that fails offline and
// then prunes, or overwrites the shell with an empty body, turns three failed reloads into
// a page that no longer loads at all — which is the one way this worker could make things
// worse than having no worker.
const intact = cacheKeys(SHELL_CACHE).sort();
const expected = shellAfterInstall;
if (intact.join(" ") !== expected.join(" ")) {
  fail(`after three offline reloads the shell cache holds ${intact.join(", ")}; expected ` +
       `${expected.join(", ")}. A failed revalidation must be a no-op.`);
}

/* --- 3. the data path: cached once asked for, honest when not ------------------ */
stage = "data";
const ensemble = `${DATA_DIR}ensemble.json`;
const ensembleBytes = read("data/ensemble.json");

const cold = await outcome((await world.request(`${DATA_DIR}travel_time_subdaily.json`)).response);
if (cold.ok) {
  fail("an uncached data file answered with the network off. It must fail loudly: the app reports a load error, " +
       "and an invented empty series would be a silent wrong answer.");
}

world.setOffline(false);
const firstRes = await outcome((await world.request(ensemble)).response);
if (!firstRes.ok || !firstRes.value.ok) fail("a cache-miss data request failed while online");
if (firstRes.value.headers.get(MARK)) fail("a network response was wrongly marked as coming from the cache");
const stored = await runtimeCache().get(ensemble);
if (!stored) fail("the data response was not cached, so the next offline reload has no answer");
if (stored.headers.get("content-encoding")) {
  fail("the stored data copy keeps content-encoding over a decoded body — see plain() in sw.js");
}
if (!stored.body.equals(ensembleBytes)) fail("the stored copy of ensemble.json is not the shipped file");

world.setOffline(true);
const hit = await world.request(ensemble);
const hitRes = await outcome(hit.response);
if (!hitRes.ok) fail(`an offline data request failed: ${hitRes.error}`);
if (hitRes.value.headers.get(MARK) !== "swr") {
  fail(`an offline data request was not served from the cache (marker ${JSON.stringify(hitRes.value.headers.get(MARK))})`);
}
const served = JSON.parse(await hitRes.value.text());
if (!served || typeof served !== "object") fail("the cached data did not parse as JSON");
await world.drain(hit.waits);
console.log(`   data: ${kb(ensembleBytes.length)} of ensemble.json served with the network off, marker "swr"`);

/* --- 4. stale-while-revalidate is stale AND revalidating ---------------------- */
stage = "swr";
world.setOffline(false);
const newer = Buffer.from(JSON.stringify({ ...served, injected: "from the next pipeline run" }));
world.overlay.set(ensemble, { body: newer, type: "application/json" });
const before = world.requests.length;
const swr = await world.request(ensemble);
const swrRes = await outcome(swr.response);
const servedNow = JSON.parse(await swrRes.value.text());
if (servedNow.injected === "from the next pipeline run") {
  fail("a data request waited for the network. That is cache-first with a slow first paint; answering from the " +
       "cache immediately is the entire point of this strategy.");
}
await world.drain(swr.waits);
const refreshed = await runtimeCache().get(ensemble);
if (refreshed.body.toString("utf8") !== newer.toString("utf8")) {
  fail("the background refresh did not update the cache, so the cached copy would stay stale for ever");
}
const calls = world.requestsFrom(before).filter((r) => r.url === ensemble).length;
if (calls !== 1) fail(`one data request made ${calls} network requests; the refresh and the miss path must share one`);
console.log(`   swr: answered instantly from the cache, refreshed behind it, 1 network request`);

/* --- 5. hashed assets are cache-first ----------------------------------------- */
stage = "assets";
const chunkUrl = `${ORIGIN}/assets/${MAP_CHUNK}`;
world.setOffline(true);
const unvisited = await outcome((await world.request(chunkUrl)).response);
if (unvisited.ok) {
  fail(`the unvisited ${MAP_CHUNK} was served offline. It is not precached by design, and a cache miss must ` +
       `surface as a failure rather than as an empty script that the map then fails to start from.`);
}
world.setOffline(false);
const online = await outcome((await world.request(chunkUrl)).response);
if (!online.ok || !online.value.ok) fail("the MapLibre chunk did not load online");
world.setOffline(true);
const visited = await outcome((await world.request(chunkUrl)).response);
if (!visited.ok) fail(`the cached chunk failed offline: ${visited.error}`);
if (visited.value.headers.get(MARK) !== "hit") {
  fail("a hashed asset visited once was not served from the cache on the second, offline visit");
}
if (!(await runtimeCache().get(chunkUrl))) fail("the asset was not written to the runtime cache");

/* --- 6. the gauge: fresh first, last reading second --------------------------- */
stage = "gauge";
world.setOffline(false);
const live = await outcome((await world.request(GAUGE)).response);
if (!live.ok || !live.value.ok) fail("the live gauge request failed while online");
if (!(await runtimeCache().get(GAUGE))) {
  fail("the gauge response was not cached, so an outage has nothing to fall back to");
}
world.setOffline(true);
const last = await outcome((await world.request(GAUGE)).response);
if (!last.ok) fail(`with no network the gauge failed outright instead of serving the last reading: ${last.error}`);
if (last.value.headers.get(MARK) !== "offline") {
  fail(`with no network the gauge answered ${last.value.status}, marker ` +
       `${JSON.stringify(last.value.headers.get(MARK))}, instead of the last reading`);
}
const reading = await last.value.json();
if (reading?.observed?.data?.[0]?.primary !== 29.4) fail("the cached gauge reading came back changed");
const unknown = await outcome((await world.request("https://api.water.noaa.gov/nwps/v1/gauges/ABC123/stageflow")).response);
if (unknown.ok) {
  fail("a gauge that was never fetched answered offline. A reading from nowhere is a wrong answer dressed as a " +
       "reliable one — the app's own fallback is the honest path.");
}
console.log(`   gauge: fresh while online, the last reading (29.4 ft) offline, an unknown gauge still fails`);

/* --- 7. tiles and fonts are not ours to cache ---------------------------------- */
stage = "third party";
const tile = await world.request(TILE);
const font = await world.request(FONT);
if (tile.intercepted || font.intercepted) {
  fail("the worker intercepted a map tile or a webfont. Tiles are unbounded in number and neither tile service " +
       "is ours to collect for offline use; the fonts are what ?text=1 exists to avoid downloading.");
}
if ([...world.stores.values()].some((m) => m.has(TILE) || m.has(FONT))) {
  fail("a tile or a webfont ended up in a cache");
}
if (world.requests.some((r) => r.url === TILE || r.url === FONT)) {
  fail("the worker requested a tile or a webfont itself");
}
if ((await world.request(`${ORIGIN}/nothing`, { method: "POST" })).intercepted) {
  fail("a non-GET request was intercepted; only GET is cacheable here");
}

/* --- 8. a deploy must not strand the cache ------------------------------------ */
/* A deploy is noticed on the next visit WITH a connection: this is that visit. */
stage = "deploy";
world.setOffline(false);
const newJs = `${ORIGIN}/assets/app-DEPLOY01.js`;
const newCss = `${ORIGIN}/assets/app-DEPLOY02.css`;
const previous = cacheKeys(SHELL_CACHE).filter((u) => u !== SHELL_URL && u !== LANDING_URL);
const expectedAssets = shellAfterInstall.filter((u) => u !== SHELL_URL && u !== LANDING_URL).length;
if (previous.length !== expectedAssets) {
  fail(`the shell cache holds ${previous.length} asset entries before the deploy, expected ${expectedAssets}`);
}
/* Only the app's OWN assets are expected to disappear: the landing names some of the same
 * tokens files, so those must survive the prune. */
const appOnly = entryAssets.filter((a) => !landingAssets.includes(a));
world.overlay.set(newJs, { body: Buffer.from("/* the next build */"), type: "text/javascript" });
world.overlay.set(newCss, { body: Buffer.from("/* the next build */"), type: "text/css" });
const nextHtml = htmlFile
  .replace(/(["'][^"']*assets\/)app-[^"']+\.js/, "$1app-DEPLOY01.js")
  .replace(/(["'][^"']*assets\/)app-[^"']+\.css/, "$1app-DEPLOY02.css");
if (nextHtml === htmlFile) fail("could not build a new shell for the deploy test — the asset reference pattern moved");
world.overlay.set(SHELL_URL, { body: Buffer.from(nextHtml), type: "text/html; charset=utf-8" });

const nav = await world.request(SHELL_URL, { mode: "navigate" });
const navRes = await outcome(nav.response);
if ((await navRes.value.text()) !== htmlFile) {
  fail("a navigation waited for the network instead of answering from the cache");
}
await world.drain(nav.waits);
const after = cacheKeys(SHELL_CACHE);
if (!after.includes(newJs) || !after.includes(newCss)) {
  fail("the new build's entry chunk was not cached before the new shell. An offline reload would then ask for a " +
       `file nothing holds and render nothing — the failure this ordering exists to prevent. ` +
       `Shell cache now holds: ${after.map((u) => u.replace(ORIGIN, "")).join(", ")}`);
}
if ((await shellCache().get(SHELL_URL)).body.toString("utf8") !== nextHtml) {
  fail("the shell in the cache is still the previous build");
}
for (const old of appOnly) {
  const url = `${ORIGIN}/${old}`;
  if (after.includes(url)) {
    fail(`the previous build's ${url} is still in the shell cache; nothing will ever request it again`);
  }
}
if (!(await runtimeCache().get(ensemble))) fail("the deploy dropped the runtime cache");

/* --- 8b. a deploy nobody finished must not be swapped in ----------------------- */
/* The case that makes the ordering matter: the new HTML is live but one of the files it
 * names is not (a half-finished upload, a CDN edge that has the page and not the chunk).
 * Storing that shell leaves a cache that is *worse* than the previous build, because the
 * previous build still works offline. */
stage = "deploy incomplete";
const partialJs = `${ORIGIN}/assets/index-PARTIAL1.js`;
const partialCss = `${ORIGIN}/assets/index-PARTIAL2.css`;
world.overlay.set(partialJs, { body: Buffer.from("/* half a build */"), type: "text/javascript" });
// partialCss is deliberately absent from the overlay: it 404s.
const partialHtml = nextHtml
  .replace("index-DEPLOY01.js", "index-PARTIAL1.js")
  .replace("index-DEPLOY02.css", "index-PARTIAL2.css");
world.overlay.set(SHELL_URL, { body: Buffer.from(partialHtml), type: "text/html; charset=utf-8" });
const halfway = await world.request(SHELL_URL, { mode: "navigate" });
const halfwayRes = await outcome(halfway.response);
if (!halfwayRes.ok) fail("a navigation failed outright while a deploy was half-finished");
if ((await halfwayRes.value.text()) !== nextHtml) {
  fail("a navigation stopped answering from the last complete build while a deploy was half-finished");
}
await world.drain(halfway.waits);
const stillWhole = await shellCache().get(SHELL_URL);
if (stillWhole.body.toString("utf8") !== nextHtml) {
  fail("an incomplete build was swapped in: the cached shell now names a file this cache does not hold, so an " +
       "offline reload renders nothing. The swap must be all-or-nothing — see fetchInto()'s return value.");
}
for (const u of [newJs, newCss]) {
  if (!cacheKeys(SHELL_CACHE).includes(u)) {
    fail(`a failed deploy dropped ${u} from the shell cache, taking the last working build with it`);
  }
}

/* --- 9. an unknown cache is purged on activate -------------------------------- */
stage = "activate";
await world.caches.open("brazoscast-shell-v0");
await world.activate();
if (world.stores.has("brazoscast-shell-v0")) {
  fail("activate left a stale cache behind, so bumping VERSION would not clean anything up");
}
if (!world.stores.has(SHELL_CACHE) || !world.stores.has(RUNTIME_CACHE)) {
  fail("activate deleted a cache it needs");
}

/* ------------------------------------------------------------------ the report --- */
const swBytes = statSync(join(DIST, "sw.js")).size;
const swGz = gzipSync(read("sw.js"), { level: 9 }).length;
const cached = [...world.stores.values()].reduce((a, m) => a + m.size, 0);
console.log(`   worker:   ${kb(swBytes)} source, ${kb(swGz)} gzipped — fetched once, revalidated after`);
console.log(`   caches:   ${cached} entries across ${world.stores.size} caches after the run`);
if (swBytes > 30_000) {
  console.error(`\nNOTE: sw.js is ${kb(swBytes)} unminified. It is fetched on the first visit and revalidated with ` +
                `a conditional request afterwards, but for a low-bandwidth product that is worth trimming.`);
}
console.log(`\nAll offline checks passed.`);
