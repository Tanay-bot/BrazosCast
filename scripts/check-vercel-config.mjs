#!/usr/bin/env node
/* The Vercel host config, held to the same cache rules the Worker was written for.
 *
 * app/vercel.json replaces sites/worker.js as the deployed edge. It sits in `app/` because that is
 * the directory a Vercel Git import deploys, while the CLI path copies it into app/dist. That Worker existed for
 * three headers a plain static host does not necessarily send, and they are load-bearing:
 *
 *   * `sw.js` must not be cached, or a browser can be pinned to an old service worker.
 *   * `/data/*` must be revalidated, because a stale thresholds file answers about a river
 *     the app no longer models.
 *   * hashed `/assets/*` should be immutable, since the HTML that names them changes with them.
 *
 * A host migration that silently drops one of these is invisible in a screenshot and shows up
 * days later as an app serving last week's numbers. So this check reads the config, applies
 * the rules the way a request would, and fails if a SHIPPED file gets the wrong header. It also
 * refuses a catch-all rewrite: without one, a missing payload is an honest 404, whereas an SPA
 * fallback answers `200 text/html` to a JSON fetch and turns a typo into a parse error.
 *
 * What it cannot prove: that Vercel's matcher is exactly this one. The authoritative check is
 * `curl -I` against the deployed origin, which scripts/deploy-vercel.sh runs after uploading.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "app/dist");
const CONFIG = join(ROOT, "app/vercel.json");

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

/* Vercel's `source` is path-to-regexp: literal text is literal, and `(.*)` captures the rest.
 * Translating that is deliberately narrow — only the one construct this config uses. */
function matcher(source) {
  const parts = source.split("(.*)").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("(.*)")}$`);
}

const rules = (config.headers ?? []).map((r) => ({ ...r, re: matcher(r.source) }));

/** Headers a request for `path` would carry, later rules overriding earlier ones. */
function headersFor(path) {
  const out = {};
  for (const rule of rules) {
    if (!rule.re.test(path)) continue;
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

/* No rewrite may swallow a missing file: the app routes on the query string only, so every
 * path it requests is a real file. */
check(!config.rewrites, "app/vercel.json has a rewrite — a missing payload would answer 200 text/html");
check(!config.routes, "app/vercel.json uses the legacy `routes` key, which bypasses `headers`");

const cases = [
  ["/sw.js", "cache-control", /no-store/],
  ["/sw.js", "service-worker-allowed", /^\/$/],
  ["/", "cache-control", /no-cache/],
  ["/index.html", "cache-control", /no-cache/],
  ["/data/ensemble.json", "cache-control", /no-cache/],
  ["/data/ensemble.json", "content-type", /^application\/json/],
  ["/data/road_thresholds.geojson", "cache-control", /no-cache/],
  ["/data/road_thresholds.geojson", "content-type", /^application\/geo\+json/],
  ["/assets/index-CEfCI0XV.js", "cache-control", /immutable/],
  ["/assets/maplibre-gl-BV_7zrgh.css", "cache-control", /immutable/],
];

for (const [path, key, want] of cases) {
  const got = headersFor(path)[key];
  check(got && want.test(got), `${path} does not get ${key}: ${want} (got ${got ?? "nothing"})`);
}

/* Every shipped payload file and hashed chunk, not just the examples above. */
const data = readdirSync(join(DIST, "data"));
check(data.length === 11, `app/dist/data has ${data.length} files; the app fetches 11`);
for (const f of data) {
  const h = headersFor(`/data/${f}`);
  check(/no-cache/.test(h["cache-control"] ?? ""), `/data/${f} is served without no-cache`);
  const want = f.endsWith(".geojson") ? /^application\/geo\+json/ : /^application\/json/;
  check(want.test(h["content-type"] ?? ""), `/data/${f} has content-type ${h["content-type"] ?? "unset"}`);
}

const assets = readdirSync(join(DIST, "assets")).filter((f) => /\.(js|css)$/.test(f));
check(assets.length > 0, "app/dist/assets has no js/css — the bundle is missing");
for (const f of assets) {
  const h = headersFor(`/assets/${f}`);
  check(/immutable/.test(h["cache-control"] ?? ""), `/assets/${f} is not immutable (got ${h["cache-control"] ?? "nothing"})`);
  check(/-[A-Za-z0-9_]{8}\.(js|css)$/.test(f), `/assets/${f} is not content-hashed, so immutable caching is unsafe`);
}

/* The config is copied into the deploy root, so a stale copy would deploy stale rules. */
const copied = join(DIST, "vercel.json");
try {
  check(statSync(copied).size > 0, "app/dist/vercel.json is empty");
  check(readFileSync(copied, "utf8") === readFileSync(CONFIG, "utf8"),
    "app/dist/vercel.json differs from app/vercel.json — the next upload would ship old rules");
} catch {
  /* Absent before a deploy: deploy-vercel.sh copies it in. Not a failure by itself. */
}

if (problems.length) {
  console.error("Vercel host config:");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}  console.log(`   app/vercel.json: ${rules.length} rules, ${data.length} payload files, ${assets.length} hashed chunks`);
