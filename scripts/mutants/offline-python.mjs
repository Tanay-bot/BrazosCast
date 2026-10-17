#!/usr/bin/env node
/* Mutation test for pipeline/tests/test_offline.py: break the source in fifteen ways, one at
 * a time, and require the NAMED test to fail — a mutation that fails some other test means the
 * check caught it for the wrong reason. Three files are touched and all three are restored
 * byte-identical (the script verifies that rather than assuming it).
 *
 * Run through `scripts/check-mutants.sh`, which resolves the interpreter the same way
 * scripts/check.sh does. */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PY = process.env.BRAZOSCAST_PYTHON
  ?? `${process.env.HOME}/miniforge3/envs/brazoscast/bin/python`;
const FILES = {
  sw: `${ROOT}/app/public/sw.js`,
  main: `${ROOT}/app/src/main.ts`,
  html: `${ROOT}/app/index.html`,
};
const original = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]));

const M = (name, file, test, from, to) => ({ name, file, test, from, to });

const mutations = [
  M("no production guard on registration", "main", "test_the_worker_is_registered_only_for_a_real_build",
    `  if (!import.meta.env.PROD) return;\n`, ``),
  M("registration is awaited", "main", "test_registration_cannot_hold_up_the_answer",
    `  void navigator.serviceWorker.register("./sw.js").catch(() => {`,
    `  await navigator.serviceWorker.register("./sw.js").catch(() => {`),
  M("absolute worker path", "main", "test_the_worker_is_registered_only_for_a_real_build",
    `register("./sw.js")`, `register("/sw.js")`),
  M("the payload is precached", "sw", "test_the_eager_set_is_the_shell_and_nothing_else",
    `  const assets = shellAssets(html);`,
    `  await fetchInto(cache, new URL("data/ensemble.json", ROOT).href);\n  const assets = shellAssets(html);`),
  // The stripping lives in one function (`cacheable`) now, so the mutation is one call site:
  // storing the response with the host's own headers, which still say gzip over a decoded body.
  M("encoding headers kept", "sw", "test_nothing_is_stored_with_the_hosts_encoding_headers",
    `    status: res.status, statusText: res.statusText, headers: cacheable(res),`,
    `    status: res.status, statusText: res.statusText, headers: res.headers,`),
  M("gauge is cache-first", "sw", "test_the_live_gauge_is_never_answered_from_the_cache_first",
    `  try {\n    const res = await fetch(req);\n    // Only a readable response is worth storing`,
    `  const early = await cache.match(req);\n  if (early) return tag(early, "offline");\n  try {\n    const res = await fetch(req);\n    // Only a readable response is worth storing`),
  // The data path answering from the network first: the cache read moved behind the refresh,
  // which is the whole of what stale-while-revalidate is for.
  M("data waits for the network", "sw", "test_data_is_answered_from_the_cache_before_it_is_refreshed",
    `    const hit = await caches.match(req, MATCH);\n    if (hit) return tag(hit, "swr");`,
    `    const first = await fresh;\n    if (first) return first;\n    const hit = await caches.match(req, MATCH);\n    if (hit) return tag(hit, "swr");`),
  M("tiles are named in the worker", "sw", "test_tiles_and_fonts_are_left_to_the_browser",
    `const GAUGE_HOST = "api.water.noaa.gov";`,
    `const GAUGE_HOST = "api.water.noaa.gov";\nconst TILES = "tile.openstreetmap.org";`),
  M("the offline tag is never wired", "main", "test_the_offline_tag_reports_the_browser_rather_than_guessing",
    `  wireOfflineTag();\n`, ``),
  M("the offline tag is not hidden at load", "html", "test_the_offline_tag_reports_the_browser_rather_than_guessing",
    `id="offlineTag" hidden`, `id="offlineTag"`),
  // The hand-over no longer lists filenames: it reports what the page actually loaded, read out
  // of the browser's own resource timing. So the defect "the payload is never handed over" is now
  // the missing call, and "a file drops out of the list" is a filter that hides the JSON.
  M("the payload is never handed over", "main", "test_the_first_visit_hands_over_what_it_already_paid_for",
    `  keepOfflineCopy(loadedHere());\n  state.roads = gj.features as Road[];`,
    `  state.roads = gj.features as Road[];`),
  // "A file drops out of the warm list" is no longer expressible: the list is the resource
  // timeline, not filenames (see the owning test, which says so in its own contract). The defect
  // of the same family that the contract CAN see is a filter that stops being about this origin,
  // which offers the worker the tile hosts and the gauge to fetch.
  M("the warm list is not this origin's", "main", "test_the_first_visit_hands_over_what_it_already_paid_for",
    `    .filter((u) => u.startsWith(\`\${location.origin}/\`))`,
    `    .filter((u) => u.startsWith("http"))`),
  M("the gauge body is not handed over", "main", "test_the_gauge_is_handed_over_rather_than_fetched_twice",
    `  const raw = await r.text();\n  const j = JSON.parse(raw);\n  keepOfflineCopy([{ url, body: raw, type: "application/json" }]);`,
    `  const j = await r.json();`),
  M("the hand-over re-downloads", "main", "test_the_gauge_is_handed_over_rather_than_fetched_twice",
    `function keepOfflineCopy(entries: OfflineEntry[]) {\n  if (!("serviceWorker" in navigator)) return;`,
    `function keepOfflineCopy(entries: OfflineEntry[]) {\n  void fetch(entries[0].url);\n  if (!("serviceWorker" in navigator)) return;`),
  // `only-if-cached` is gone from the worker on purpose (see its comment: that mode rejects for
  // every file these hosts serve), so the defect "downloaded instead of copied" is now expressed
  // by the mode that comment contrasts with: `no-cache` must revalidate.
  // The owning test is the source-level one: it asserts the warm-up asks for the URL the way the
  // page asked for it (`await fetch(url.href)`), which is the mechanism that makes the browser
  // answer out of what it holds. A mode that forces revalidation fails it — verified, not assumed.
  M("the warm-up downloads instead", "sw", "test_the_warm_up_asks_for_what_the_browser_already_has",
    `      const res = await fetch(url.href);`,
    `      const res = await fetch(new Request(url.href, { cache: "no-cache" }));`),
];

let bad = 0;
for (const m of mutations) {
  const path = FILES[m.file];
  if (!original[m.file].includes(m.from)) {
    console.log(`  ?? ${m.name}: the code to mutate is gone — update this script`);
    bad++;
    continue;
  }
  writeFileSync(path, original[m.file].replace(m.from, m.to));
  let out = "", code = 0;
  try {
    out = execFileSync(PY, ["-m", "pytest", "pipeline/tests/test_offline.py", "-q"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  writeFileSync(path, original[m.file]);
  const failed = /(test_\w+)\s+_____/.exec(out)?.[1] ?? /FAILED [^\s]*::(test_\w+)/.exec(out)?.[1];
  const ok = code !== 0 && failed === m.test;
  console.log(`  ${ok ? "ok  " : "MISS"} ${m.name.padEnd(34)} exit=${code} failed=${failed ?? "-"}`);
  if (!ok) {
    bad++;
    console.log(out.split("\n").filter((l) => /^E /.test(l)).slice(0, 2).map((l) => `        ${l}`).join("\n"));
  }
}

let restored = 0;
for (const [k, p] of Object.entries(FILES)) if (readFileSync(p, "utf8") === original[k]) restored++;
console.log(bad === 0 && restored === 3
  ? `\nAll ${mutations.length} mutations were caught, and all three files are byte-identical.`
  : `\n${bad} of ${mutations.length} mutations were NOT caught (${restored}/3 files restored).`);
process.exit(bad === 0 && restored === 3 ? 0 : 1);
