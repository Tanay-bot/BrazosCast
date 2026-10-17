#!/usr/bin/env node
/* Mutation test for scripts/check-offline.mjs: break app/public/sw.js in thirteen ways, one at
 * a time, and require the check to fail at the stage that owns the break.
 *
 * Run through `scripts/check-mutants.sh`, which builds the app first — this reads and writes
 * `app/dist/sw.js` and then runs `scripts/check-offline.mjs` against it, because a service
 * worker's behaviour is not in its text and the shipped copy is what answers an outage.
 *
 * The stage in each definition is the assertion the mutation must break, not just "something
 * failed": a mutation that fails the wrong stage means the check caught it for the wrong
 * reason, which is not the same as the check being sound.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = `${ROOT}/app/public/sw.js`;
const DIST = `${ROOT}/app/dist/sw.js`;
const original = readFileSync(SRC, "utf8");
copyFileSync(SRC, DIST);

const M = (name, stage, from, to) => ({ name, stage, from, to });

const mutations = [
  M("install precaches the payload", "install",
    `  const stored = await Promise.all(assets.map((u) => fetchInto(cache, u)));`,
    `  await fetchInto(cache, new URL("data/ensemble.json", ROOT).href);\n  const stored = await Promise.all(assets.map((u) => fetchInto(cache, u)));`),
  // The shell is the one stored response rebuilt from text, so it is where a header the worker
  // forgot to strip shows up as a page the browser refuses to parse. Anchored on `cacheable`,
  // which is the single place the stripping happens (it was inline in two functions once).
  M("shell keeps the host's headers", "install",
    `  const headers = cacheable(res);`,
    `  const headers = new Headers(res.headers);`),
  M("cache hits are not marked", "offline reload",
    `  headers.set(MARK, state);\n  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });\n}`,
    `  headers.set(MARK, state);\n  return res;\n}`),
  M("stored data keeps the host's headers", "data",
    `    status: res.status, statusText: res.statusText, headers: cacheable(res),`,
    `    status: res.status, statusText: res.statusText, headers: res.headers,`),
  M("gauge has no fallback", "gauge",
    `    if (!hit) throw err;              // nothing cached: let the app take its own fallback`,
    `    throw err;`),
  // The data path answering from the network first. The cache read moved behind the refresh,
  // which is the whole of what stale-while-revalidate is for: the answer must not wait.
  M("data waits for the network", "swr",
    `    const hit = await caches.match(req, MATCH);\n    if (hit) return tag(hit, "swr");`,
    `    const first = await fresh;\n    if (first) return first;\n    const hit = await caches.match(req, MATCH);\n    if (hit) return tag(hit, "swr");`),
  M("tiles are intercepted too", "third party",
    `  /* Everything else goes straight to the browser, untouched.`,
    `  event.respondWith(fetch(req));\n  /* Everything else goes straight to the browser, untouched.`),
  M("the old build is never pruned", "deploy",
    `    await cache.put(SHELL_URL, shellResponse(res, html));\n    await pruneShell(cache, assets);`,
    `    await cache.put(SHELL_URL, shellResponse(res, html));`),
  M("an incomplete build is swapped in", "deploy incomplete",
    `    if (stored.some((ok) => !ok)) return;\n    await cache.put(SHELL_URL, shellResponse(res, html));`,
    `    await cache.put(SHELL_URL, shellResponse(res, html));`),
  M("navigation is not special-cased", "offline reload",
    `    if (req.mode === "navigate") {`,
    `    if (req.mode === "never-branches") {`),
  // Warm-up downloads instead of copying. The worker deliberately does NOT use
  // `only-if-cached` any more — the comment at the call records why that mode rejects for
  // every file these hosts serve — so the defect is now expressed by the mode that comment
  // contrasts with: `no-cache` must revalidate, and a response with no validator comes back
  // as the whole body again, which is exactly the download the warm-up exists to avoid.
  M("warm-up downloads instead of copying", "warm",
    `      const res = await fetch(url.href);`,
    `      const res = await fetch(new Request(url.href, { cache: "no-cache" }));`),
  M("an already-cached file is copied again", "warm",
    `      if (await caches.match(url.href, MATCH)) return;`,
    `      if (false) return;`),
  M("the handed-over body is dropped", "warm",
    `      if (typeof entry.body === "string") {`,
    `      if (false) {`),
];

let bad = 0;
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`  ?? ${m.name}: the code to mutate is gone — update this script`);
    bad++;
    continue;
  }
  writeFileSync(DIST, original.replace(m.from, m.to));
  let out = "", code = 0;
  try {
    out = execFileSync("node", [`${ROOT}/scripts/check-offline.mjs`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const failedStage = /FAILED \[([^\]]+)\]/.exec(out)?.[1];
  const ok = code !== 0 && failedStage === m.stage;
  console.log(`  ${ok ? "ok  " : "MISS"} ${m.name.padEnd(38)} exit=${code} stage=${failedStage ?? "-"} (want ${m.stage})`);
  if (!ok) {
    bad++;
    console.log(out.split("\n").filter(Boolean).slice(0, 3).map((l) => `        ${l}`).join("\n"));
  }
}

writeFileSync(DIST, original);
if (readFileSync(DIST, "utf8") !== original) { console.log("  ?? dist/sw.js was not restored"); bad++; }
copyFileSync(SRC, DIST);
console.log(bad === 0
  ? `\nAll ${mutations.length} mutations were caught, and dist/sw.js is byte-identical to app/public/sw.js.`
  : `\n${bad} of ${mutations.length} mutations were NOT caught.`);
process.exit(bad === 0 ? 0 : 1);
