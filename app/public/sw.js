/* BrazosCast service worker — the storm case.
 *
 * TWO DOCUMENTS, one insight: the landing at `/` and the app at `/app` are both addresses this
 * site publishes, and a cached landing served for an app reload (or the reverse) would look
 * exactly like a broken deploy. So the shell is a pair, keyed by the path that was asked for,
 * and both are stored all-or-nothing with the files they name.
 *
 * The app exists for the hours when the river is rising, which is also when the
 * connection is most likely to be the thing that fails. This caches what the page has
 * already been asked for, so a reload with no network still answers.
 *
 * THE EAGER SET IS THE SHELL, AND ONLY THE SHELL. The payload is 1.6 MB and `?text=1`
 * exists for phones where 85 KB of fonts decided whether there was an answer at all —
 * so precaching `data/*` at install would take back with one hand what the text-only
 * route bought with the other. The shell is cached at install; everything else is cached
 * the first time the app actually asks for it, which costs a visitor ZERO additional
 * bytes, because the app fetches all nine data files on every boot anyway.
 * `scripts/check-offline.mjs` holds that line: it runs this file and asserts no payload
 * file is fetched before the app requests it.
 *
 * Four strategies, because the four kinds of thing are not alike:
 *
 *   navigation          cache first, revalidated in the background. A reload during an
 *                       outage must not first wait for a connection to time out.
 *   data/*.json         stale-while-revalidate. These keep their filenames across
 *                       pipeline runs, so cache-first would pin a stale threshold for
 *                       ever; serving the cached copy immediately and refreshing for
 *                       the *next* visit is both fast and eventually current.
 *   assets/*            cache first. Vite content-hashes them, so the URL is the
 *                       version — a different file is a different URL, and a cached one
 *                       can never be the wrong bytes.
 *   the live gauge      network first. A cached reading must never beat a fresh one, and
 *                       when it does have to be served the app already knows how to say
 *                       so: it measures the age of the last observation and labels the
 *                       stage estimated once that age passes its own measured
 *                       thresholds. This cache stores a reading; the app remains the
 *                       thing that decides what an old reading is worth.
 *
 * Map tiles and webfonts are deliberately not cached, and not even intercepted: see the
 * comment in the fetch handler.
 *
 * A new sw.js installs only when this file's bytes change, which is not every deploy, so
 * the shell is revalidated on navigation rather than on install (revalidateShell). The
 * cache names carry a version: bumping it is the escape hatch that forces every entry to
 * be rebuilt from the network.
 */

const VERSION = "v1";
const SHELL = `brazoscast-shell-${VERSION}`;
const RUNTIME = `brazoscast-runtime-${VERSION}`;
const KEEP = [SHELL, RUNTIME];

/* Diagnostic only, never stored: a response carrying this came from the cache rather
 * than the network. That difference is the whole claim, so a check has to see it. */
const MARK = "x-brazoscast-cache";

const ROOT = new URL("./", self.location).href;   // the app may be deployed at a subpath
const DOCS = {
  landing: new URL("index.html", ROOT).href,
  app: new URL("app.html", ROOT).href,
};
const SHELL_DOCS = [DOCS.landing, DOCS.app];
/* `/app` is a rewrite in production and a dev-server middleware locally; the worker answers
 * the same two addresses, because an offline reload has to land on the page it asked for. */
const DOC_FOR_PATH = new Map([
  [new URL("./", ROOT).pathname, DOCS.landing],
  [new URL("index.html", ROOT).pathname, DOCS.landing],
  [new URL("app", ROOT).pathname, DOCS.app],
  [new URL("app.html", ROOT).pathname, DOCS.app],
]);
const DATA_DIR = new URL("data/", ROOT).href;
const GAUGE_HOST = "api.water.noaa.gov";

/* ------------------------------------------------------------------- install --- */

self.addEventListener("install", (event) => {
  // No skipWaiting: a tab that is mid-answer keeps the version it booted with, and the
  // new one takes over on the next visit. Nothing here is urgent enough to be worth
  // pulling the cache out from under a page that is already rendering.
  event.waitUntil(storeShell());
});

/** Fetch the shell and cache it together with every same-origin file it names.
 *
 *  ALL OR NOTHING, and the HTML last. A cached shell whose entry chunk is missing renders
 *  a blank page offline, which is worse than not being offline-capable at all — so if any
 *  file the shell names cannot be cached, the shell is not stored and install fails, which
 *  leaves the page behaving exactly as it did before. */
async function storeShell() {
  const cache = await caches.open(SHELL);
  const fetched = [];
  for (const url of SHELL_DOCS) {
    const res = await fetch(new Request(url, { cache: "no-cache" }));
    if (!res.ok) throw new Error(`shell ${res.status} ${url}`);
    fetched.push({ url, res, html: await res.text() });
  }
  const assets = fetched.flatMap((d) => shellAssets(d.html, d.url));
  const stored = await Promise.all(assets.map((u) => fetchInto(cache, u)));
  if (stored.some((ok) => !ok)) throw new Error("an asset a document names could not be cached");
  for (const d of fetched) await cache.put(d.url, shellResponse(d.res, d.html));
  await pruneShell(cache);
}

/** The same-origin files one document names — its entry chunk and stylesheet.
 *
 *  Read from the built HTML rather than listed here, because those filenames are content
 *  hashes that change on every build, and a list maintained by hand is a list that
 *  silently stops matching. Cross-origin links are skipped on purpose: the only one present
 *  is the webfont stylesheet, which text mode does not load and which the stylesheet's own
 *  font stacks fall back from anyway. `base` is the document the URLs resolve against, so the
 *  landing and the app can each name their own chunk. */
function shellAssets(html, base) {
  const found = new Set();
  const tag = /<(?:script|link)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = tag.exec(html))) {
    let url;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;                       // not a URL at all; nothing to cache
    }
    if (url.origin !== self.location.origin) continue;
    if (url.href === base) continue;
    found.add(url.href.split("#")[0]);
  }
  return [...found];
}

/** Strip the headers that describe a transfer this cache is deliberately not a party to.
 *
 *  `content-encoding`: a body read inside a worker is DECODED, while the headers it arrived
 *  with may still say gzip. Passing that on with that body announces a compression that is
 *  no longer there, and the browser fails to parse the page it was just served.
 *
 *  `vary`: the Cache API keys on Vary by default, comparing the response's Vary header
 *  against the STORED request's headers. This cache holds exactly one variant per URL on
 *  purpose — the decoded one, which every client can read — so a Vary only turns into a
 *  false miss. It is not theoretical: a preview server sends `Vary: Origin`, the install
 *  stored the shell's files from a request with no Origin, and the document's `crossorigin`
 *  module and stylesheet requests carry one, so every replay missed and, offline, the asset
 *  failed outright. Found by the Playwright offline spec; no in-process shim can show it.
 *
 *  Reads pass `ignoreVary` as well, because entries stored by an earlier version of this
 *  worker are still in the cache after an update.
 *
 *  The shell is rebuilt from text (shellResponse) because its content-type has to be
 *  restated: the document is UTF-8 and says so in a meta tag nothing else guarantees. */
function cacheable(res) {
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("vary");
  return headers;
}

function plain(res) {
  return new Response(res.body, {
    status: res.status, statusText: res.statusText, headers: cacheable(res),
  });
}

function shellResponse(res, html) {
  const headers = cacheable(res);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

/** Every read, for the reason above and for the entries an older worker stored. */
const MATCH = { ignoreVary: true };

/** Cache a URL if it is not already there, and report whether it is there afterwards.
 *  Assets are content-hashed, so a hit is the same bytes. The caller decides what a
 *  failure means — it must not silently proceed with a shell whose files are missing. */
async function fetchInto(cache, url) {
  try {
    if (await cache.match(url, MATCH)) return true;
    const res = await fetch(new Request(url, { cache: "no-cache" }));
    if (!res.ok) return false;
    await cache.put(url, plain(res));
    return true;
  } catch {
    return false;
  }
}

/** Drop the shell entries the stored documents no longer name, so a deploy cannot leave the
 *  previous build's chunks in the cache for ever. Read from what is actually stored rather
 *  than from a list passed in: two documents have two asset sets, and the union is only
 *  knowable after both are in place. */
async function pruneShell(cache) {
  const alive = new Set();
  for (const url of SHELL_DOCS) {
    const hit = await cache.match(url, MATCH);
    if (!hit) continue;
    alive.add(url);
    for (const a of shellAssets(await hit.text(), url)) alive.add(a);
  }
  for (const req of await cache.keys()) {
    if (!alive.has(req.url)) await cache.delete(req);
  }
}

/* ------------------------------------------------------------------ activate --- */

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!KEEP.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();       // the tab that registered is the tab that needs it
  })());
});

/* -------------------------------------------------------------------- warm-up --- */

/* The first visit is the one the ordinary paths cannot cover: the page fetches its payload
 * before this worker controls it, so none of it passes through the fetch handler. Rather
 * than guess filenames here — the eager set stays the shell, see the header — the app says
 * what it just loaded, and this asks for each of those again on the page's behalf. Every
 * URL in that message was downloaded moments ago, so the browser answers from its own
 * cache: the cost is the request, not the file.
 *
 * The exception is the live gauge, whose response is 468 KB with no validator and answers a
 * conditional request with all of it again; the app hands those bytes over in the message
 * rather than have this ask for them twice. Warm-up is best-effort in every case: anything
 * it skips is cached by the ordinary paths on the next visit, so a failure here costs a
 * visit and never an answer. */
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "offline-copy" || !Array.isArray(msg.entries)) return;
  event.waitUntil(warm(msg.entries));
});

async function warm(entries) {
  const cache = await caches.open(RUNTIME);
  await Promise.all(entries.map(async (entry) => {
    if (!entry || typeof entry.url !== "string") return;
    try {
      const url = new URL(entry.url, self.location);
      // Any cache, not just this one: the shell cache already holds the entry chunk and the
      // stylesheet, and copying those again would be work with no reader.
      if (await caches.match(url.href, MATCH)) return;
      if (typeof entry.body === "string") {
        // Already in hand, and already downloaded once. Stored plain, like everything else.
        const headers = new Headers({ "content-type": entry.type || "application/json" });
        await cache.put(url.href, new Response(entry.body, { headers }));
        return;
      }
      if (url.origin !== self.location.origin) return;
      // NOT `only-if-cached`. That mode can never be satisfied by anything these hosts
      // serve: `Cache-Control: no-cache` means the response has to be REVALIDATED, and a
      // cache mode that forbids the network can never revalidate, so it rejects for every
      // file — a warm-up that copied nothing while a Node harness whose model of the cache
      // said otherwise reported it as working. What does work is asking for the file the
      // way the page asked for it: the browser answers out of its own cache (a conditional
      // request at worst, and never the body again) and the copy in hand is what gets
      // stored here.
      const res = await fetch(url.href);
      if (res.ok) await cache.put(url.href, plain(res));
    } catch {
      /* a URL that cannot be fetched for its copies: skipped, and cached by the ordinary
       * paths on the next visit */
    }
  }));
}

/* --------------------------------------------------------------------- fetch --- */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") {
      event.respondWith(shellFor(req));
      // Not in front of the render: the page comes from the cache while the check for a
      // newer build happens behind it. Offline this settles quietly.
      event.waitUntil(revalidateShell());
      return;
    }
    if (url.href.startsWith(DATA_DIR)) {
      const [answer, refresh] = staleWhileRevalidate(req);
      event.respondWith(answer);
      event.waitUntil(refresh);
      return;
    }
    event.respondWith(cacheFirst(req));
    return;
  }

  if (url.hostname === GAUGE_HOST) {
    event.respondWith(gauge(req));
    return;
  }

  /* Everything else goes straight to the browser, untouched. Base-map tiles are opaque
   * cross-origin requests to tile.openstreetmap.org: unbounded in number (a pan across the
   * county is hundreds), uninspectable, and the OpenStreetMap tile service is explicitly
   * not for bulk or offline collection. The webfonts are skipped for the reason `?text=1`
   * exists — caching them would make every later visit download what text mode refuses to
   * download now. Neither is needed to answer the question: a text-only page needs no
   * tiles, and the stylesheet's font stacks already fall back to system faces. */
});

async function shellFor(req) {
  const doc = DOC_FOR_PATH.get(new URL(req.url).pathname);
  /* A navigation to something this site does not publish is not the app's to answer: the
   * host 404s it, and so does this. Serving the shell there would invent a page. */
  if (!doc) return fetch(req);
  const hit = await caches.match(doc, MATCH);
  if (hit) return tag(hit, "hit");
  /* Nothing cached yet — a first visit, or the shell was evicted: go to the network and
   * let a failure look like a failure, rather than serve an empty page that looks loaded. */
  return fetch(req);
}

/** Look for a newer build and swap it in only when it is complete. Runs on every
 *  navigation, which is what a browser does for the page anyway; the difference is that
 *  this one is not holding up the render. */
async function revalidateShell() {
  const cache = await caches.open(SHELL);
  let changed = false;
  for (const url of SHELL_DOCS) {
    try {
      const res = await fetch(new Request(url, { cache: "no-cache" }));
      if (!res.ok) continue;
      const html = await res.text();
      const cached = await cache.match(url, MATCH);
      if (cached && (await cached.text()) === html) continue;   // same build; nothing to do
      const assets = shellAssets(html, url);
      const stored = await Promise.all(assets.map((u) => fetchInto(cache, u)));
      // A partly-cached new build is not a new build: swapping in a shell that names a file
      // this cache does not hold is how an offline reload ends up blank. Keep the document
      // that is complete and try again on the next navigation.
      if (stored.some((ok) => !ok)) continue;
      await cache.put(url, shellResponse(res, html));
      changed = true;
    } catch {
      /* offline, or a deploy mid-flight: the cached document stands */
    }
  }
  if (changed) await pruneShell(cache);
}

/** Serve the cached copy at once; refresh it for next time. One request, not two: the
 *  refresh is started first and the miss path reuses it rather than fetching again. The
 *  refresh is handed to waitUntil, or the worker can be stopped before it lands. */
function staleWhileRevalidate(req) {
  const fresh = fetch(req).then(async (res) => {
    if (res.ok) {
      const cache = await caches.open(RUNTIME);
      await cache.put(req, plain(res.clone()));
    }
    return res;
  }, () => null);                     // offline: no newer copy exists

  const answer = (async () => {
    const hit = await caches.match(req, MATCH);
    if (hit) return tag(hit, "swr");
    const res = await fresh;
    if (res) return res;
    throw new Error(`offline, and no cached copy of ${new URL(req.url).pathname}`);
  })();

  return [answer, fresh.then(() => {})];
}

async function cacheFirst(req) {
  const hit = await caches.match(req, MATCH);
  if (hit) return tag(hit, "hit");
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(RUNTIME);
    await cache.put(req, plain(res.clone()));
  }
  return res;
}

/** The live gauge: fresh if the network has it, the last reading if it does not. The app,
 *  not this worker, decides what an old reading is worth — it labels the stage estimated
 *  once the observation age passes its measured thresholds, and a byte here cannot talk it
 *  out of that. */
async function gauge(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(req);
    // Only a readable response is worth storing: an opaque one has no status to check and
    // cannot be replayed as JSON.
    if (res.ok && res.type !== "opaque") await cache.put(req, plain(res.clone()));
    return res;
  } catch (err) {
    const hit = await cache.match(req, MATCH);
    if (!hit) throw err;              // nothing cached: let the app take its own fallback
    return tag(hit, "offline");
  }
}

/** Copy a stored response out with a marker on it. Stored entries keep their own headers;
 *  the marker exists only on the way out, because a cache that answers questions about
 *  itself with a header is a cache whose behaviour can be tested from the outside. */
function tag(res, state) {
  const headers = new Headers(res.headers);
  headers.set(MARK, state);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
