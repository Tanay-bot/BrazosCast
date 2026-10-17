#!/usr/bin/env node
/**
 * BrazosCast — the `?text=1` budget, checked against the BUILD.
 *
 * The text-only route is a claim about bytes, and a claim about bytes has to be
 * measured against what is actually shipped, not against the source that was meant to
 * ship it. This runs after `vite build` (see scripts/check.sh) and reads dist/ only.
 *
 * It asserts the three things that decide the budget, each of which is one edit away
 * from silently regressing:
 *
 *   1. MapLibre is a SEPARATE chunk, and its code is not in the entry chunk. A static
 *      `import maplibregl from "maplibre-gl"` puts 218 KB back into the entry and turns
 *      the text-only route into a link that downloads the map it promised to skip.
 *   2. The webfonts are attached from an inline guard, not a static <link>. As a
 *      <link> they are fetched before any script could object — measured 85 KB.
 *   3. The budget: text mode is smaller by at least MIN_SAVING_BYTES of gzipped
 *      same-origin bytes. The model of what each route fetches is the entry assets
 *      plus the WHOLE shipped payload, which is exact rather than an estimate because
 *      pipeline/tests/test_payload_contract.py already asserts every exported file is
 *      fetched by the app. The delta is therefore the map, nothing else.
 *
 * Byte counts are gzip -9 of the files on disk, because that is what a compressing
 * host sends and it is the number that compares fairly across asset types. The
 * uncompressed figures for the same two routes, measured in a browser, are in the
 * README; both are real, and they differ only in what the server does to JSON.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "app", "dist");
const DATA = join(ROOT, "app", "public", "data");

/* Measured in the browser: MapLibre's JS (217,790) + its CSS (9,220) gzipped is
 * 227,010. The floor is set below that so a minor version bump does not fail the
 * build, while dropping the split (~0 saved) fails unmistakably. */
const MIN_SAVING_BYTES = 200_000;

/* Tokens that appear in MapLibre's own code and nowhere in this app, so finding one in
 * the entry chunk means the library was bundled in rather than split out. */
const MAPLIBRE_FINGERPRINT = "maplibregl-ctrl-group";
const ML_CSS_FINGERPRINT = /\.maplibregl-map\{/;

/* Measured by refetching them; used only for the closing line. */
const FONTS_BYTES = 84_628;

const fail = (msg) => { console.error(`\nFAILED: ${msg}`); process.exit(1); };
const gz = (p) => gzipSync(readFileSync(p), { level: 9 }).length;
const kb = (n) => `${(n / 1000).toFixed(1)} KB`;

if (!existsSync(DIST)) fail("app/dist is missing — this check runs after `vite build`");

/* ---- what the build produced ------------------------------------------------- */
const html = readFileSync(join(DIST, "index.html"), "utf8");
const assets = readdirSync(join(DIST, "assets"));
const entryJs = assets.filter((f) => /^index-.*\.js$/.test(f));
const entryCss = assets.filter((f) => /^index-.*\.css$/.test(f));
const mlJs = assets.filter((f) => /^maplibre-gl-.*\.js$/.test(f));
const mlCss = assets.filter((f) => /^maplibre-gl-.*\.css$/.test(f));

if (entryJs.length !== 1 || entryCss.length !== 1) {
  fail(`expected exactly one entry js and one entry css in dist/assets, found ` +
       `${entryJs.length} and ${entryCss.length} — the split changed shape`);
}
if (mlJs.length === 0) {
  fail("dist/assets has no maplibre-*.js chunk: the library is no longer code-split, so " +
       "it is either in the entry or missing entirely. Either way the text-only route is " +
       "no longer skipping it.");
}
if (mlCss.length === 0) {
  fail("dist/assets has no maplibre-*.css chunk: the map stylesheet is merged into the " +
       "entry stylesheet, so every text-only visitor downloads the map's CSS.");
}
const entryJsFile = entryJs[0], entryCssFile = entryCss[0];
const mlJsFile = mlJs[0], mlCssFile = mlCss[0];

/* ---- 1. the entry must not pull the map in -----------------------------------
 * Three ways it can, and they are checked separately because they fail separately:
 * the library's code inlined into the entry, a STATIC import of the maplibre chunk, or
 * the map's CSS in the entry stylesheet. Any of them means a text-only visitor pays. */
const entrySrc = readFileSync(join(DIST, "assets", entryJsFile), "utf8");
if (entrySrc.includes(MAPLIBRE_FINGERPRINT)) {
  fail(`${entryJsFile} contains MapLibre's own code (${MAPLIBRE_FINGERPRINT}), so it is ` +
       `bundled into the entry and text mode pays for it. Check for a static ` +
       `\`import maplibregl from "maplibre-gl"\` used outside buildMap() in app/src/main.ts.`);
}
const mlSrc = readFileSync(join(DIST, "assets", mlJsFile), "utf8");
if (!mlSrc.includes(MAPLIBRE_FINGERPRINT)) {
  fail(`the maplibre chunk (${mlJsFile}) does not contain ${MAPLIBRE_FINGERPRINT} — the ` +
       `fingerprint is stale, so the check above cannot detect anything. Update it.`);
}

/* A static import is `import"./x.js"` or `from"./x.js"`; the dynamic form is
 * `import("./x.js")`, which is the whole point of the split. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const staticImport = new RegExp(
  `(?:^|[^\\w.$])(?:import|from)\\s*["']\\./${esc(mlJsFile)}["']`);
if (staticImport.test(entrySrc)) {
  fail(`${entryJsFile} statically imports ${mlJsFile}, so the browser fetches the 218 KB ` +
       `map on page load and ?text=1 skips nothing. The dynamic import() inside buildMap() ` +
       `is what keeps it out of the entry.`);
}

const entryCssSrc = readFileSync(join(DIST, "assets", entryCssFile), "utf8");
if (ML_CSS_FINGERPRINT.test(entryCssSrc)) {
  fail(`${entryCssFile} contains MapLibre's stylesheet (${ML_CSS_FINGERPRINT}), so the map's ` +
       `CSS rides along in the entry. It must be imported inside buildMap() alongside the JS.`);
}
if (!ML_CSS_FINGERPRINT.test(readFileSync(join(DIST, "assets", mlCssFile), "utf8"))) {
  fail(`the maplibre CSS chunk (${mlCssFile}) does not contain ${ML_CSS_FINGERPRINT} — the ` +
       `fingerprint is stale, so the check above cannot detect anything. Update it.`);
}

/* ---- 2. the fonts must be behind the inline guard ---------------------------- */
/* Only a STYLESHEET link fetches the fonts. A `<link rel=preconnect>` is a DNS/TLS
 * warmup and costs no bytes, so it is not a failure — but it is also not wanted in text
 * mode, where the guard attaches neither, so the shapes are checked separately. */
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/i;
const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
const staticFontSheets = linkTags.filter(
  (t) => FONT_HOST.test(t) && /rel=["']?stylesheet/i.test(t));
if (staticFontSheets.length) {
  fail(`dist/index.html loads the webfonts from a static <link` +
       `${staticFontSheets.length > 1 ? " each" : ""}>, which the browser fetches before ` +
       "any script can check the URL — the text-only route would download 85 KB of woff2. " +
       "Attach them from an inline script guarded on ?text=1 (see index.html).");
}
const insideAScript = (needle) =>
  new RegExp(`<script[\\s\\S]*?${esc(needle)}[\\s\\S]*?</script>`, "i").test(html);
for (const host of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
  if (!linkTags.some((t) => t.includes(host))) continue;
  // A preconnect is allowed only if the guard creates it rather than the markup.
  if (!insideAScript(host)) {
    fail(`dist/index.html preconnects to ${host} outside the text-mode guard, so a ` +
         "text-only visitor still opens a connection to a font host the app will not use");
  }
}
/* The guard has to be one inline script that reads location.search, looks for the flag
 * and attaches the font stylesheet — all three, because any two of them without the
 * third is a guard that does not guard. Asserted on the built HTML rather than the
 * source, where the flag appears in prose and inside a regex literal. */
const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
const guard = scripts.find((s) =>
  /location\.search/.test(s) && /text=1/.test(s) && FONT_HOST.test(s));
if (!guard) {
  fail("dist/index.html has no inline script that reads location.search for `text=1` and " +
       "attaches the webfonts, so the 85 KB of woff2 is no longer skipped in text mode");
}
if (!FONT_HOST.test(html)) {
  fail("dist/index.html never attaches the webfonts at all — the font CSS has been " +
       "dropped, which changes the app's typography rather than its budget");
}

/* ---- 3. the budget ----------------------------------------------------------- */
const payload = readdirSync(DATA).map((f) => join(DATA, f));
const payloadBytes = payload.reduce((a, f) => a + gz(f), 0);
const entryBytes = gz(join(DIST, "assets", entryJsFile)) + gz(join(DIST, "assets", entryCssFile));
const mapBytes = gz(join(DIST, "assets", mlJsFile)) + gz(join(DIST, "assets", mlCssFile));

const textTotal = entryBytes + payloadBytes;
const fullTotal = textTotal + mapBytes;
const saving = fullTotal - textTotal;

console.log(`   entry (js+css, gzipped)   ${kb(entryBytes).padStart(10)}`);
console.log(`   payload (${String(payload.length).padStart(2)} files)      ${kb(payloadBytes).padStart(10)}`);
console.log(`   text-only same-origin     ${kb(textTotal).padStart(10)}`);
console.log(`   full same-origin          ${kb(fullTotal).padStart(10)}   (+${kb(mapBytes)} map)`);
console.log(`   saved                     ${kb(saving).padStart(10)}   ` +
            `(${((saving / fullTotal) * 100).toFixed(1)}%, floor ${kb(MIN_SAVING_BYTES)})`);

if (saving < MIN_SAVING_BYTES) {
  fail(`text mode saves only ${kb(saving)} of gzipped same-origin bytes, below the ` +
       `${kb(MIN_SAVING_BYTES)} floor — MapLibre is not out of the text-only path`);
}

console.log(`   index.html is ${kb(gz(join(DIST, "index.html")))} (the ${kb(FONTS_BYTES)} of ` +
            `fonts and the map tiles are third-party; text mode requests neither)`);
