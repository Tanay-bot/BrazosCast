#!/usr/bin/env node
/**
 * BrazosCast — one command for every public source.
 *
 *   node pipeline/ingest/refresh.mjs                 # all three, then a receipt table
 *   node pipeline/ingest/refresh.mjs --source=nwps   # one of nwps | usgs_ogc | usace
 *   node pipeline/ingest/refresh.mjs --dry-run       # print the requests, fetch nothing
 *   node pipeline/ingest/refresh.mjs --days=10       # widen the window (default 7)
 *   node pipeline/ingest/refresh.mjs --check-stale=36 # offline: is the standing snapshot old?
 *
 * Exit code is the contract: **1 if any source failed**, with the failing source named. The
 * alternative — a script that prints warnings and exits 0 — is how a pipeline ends up
 * serving a week-old gauge to someone deciding whether to move their car.
 *
 * Receipts merge into data/raw/_receipt.json rather than replacing it, so a single-source
 * run cannot erase what the other sources last fetched.
 */
import * as nwps from "./nwps.mjs";
import * as usgs from "./usgs_ogc.mjs";
import * as usace from "./usace_cwms.mjs";
import { printReceipts, readReceipt, writeReceipt } from "./lib.mjs";

const SOURCES = { nwps, usgs_ogc: usgs, usace };

const USAGE =
  "usage: node pipeline/ingest/refresh.mjs [--source=nwps|usgs_ogc|usace] [--dry-run] [--days=7] " +
  "[--check-stale=<hours>]";

function args(argv) {
  const out = { source: null, dryRun: false, days: 7, staleHours: null };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a.startsWith("--days=")) out.days = Number(a.slice("--days=".length));
    else if (a.startsWith("--check-stale=")) out.staleHours = Number(a.slice("--check-stale=".length));
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/**
 * The cadence's other half: a schedule that fetches is worth nothing if nothing notices that
 * the fetches stopped. Reads the receipts and answers one question — how old is the standing
 * snapshot — without touching the network, so it can run before a deploy or on a timer that
 * has no business pulling 21 endpoints to answer it.
 *
 * Ages are reported per SOURCE FAMILY (`nwps`, `usgs_ogc`, `usace_cwms`), because "one gauge is
 * 40 h old" and "the NWPS chain has not answered in 40 h" are different findings and only the
 * second one is a reason to stop.
 */
async function checkStale(hours) {
  const { sources } = await readReceipt();
  const families = new Map();
  for (const [name, s] of Object.entries(sources)) {
    const family = name.split("/")[0];
    const ageH = (Date.now() - Date.parse(s.fetched_at)) / 3600_000;
    if (!Number.isFinite(ageH)) {
      console.error(`   ${name}: fetched_at is not a date (${s.fetched_at})`);
      process.exitCode = 1;
      return;
    }
    const cur = families.get(family);
    if (!cur || ageH > cur.ageH) families.set(family, { family, ageH, oldest: name });
  }

  if (!families.size) {
    console.error("   data/raw/_receipt.json has no sources — nothing has ever been fetched");
    process.exitCode = 1;
    return;
  }

  const rows = [...families.values()].sort((a, b) => b.ageH - a.ageH);
  console.log(`   ${Object.keys(sources).length} receipts across ${rows.length} source families`);
  for (const r of rows) {
    console.log(`   ${r.family.padEnd(11)} oldest ${r.ageH.toFixed(1).padStart(6)} h  (${r.oldest})`);
  }

  const stale = rows.filter((r) => r.ageH > hours);
  if (stale.length) {
    console.error(
      `\n   FAILED: ${stale.map((r) => `${r.family} (${r.ageH.toFixed(1)} h)`).join(", ")} ` +
        `older than the ${hours} h threshold — run: node pipeline/ingest/refresh.mjs`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n   fresh: every family is inside ${hours} h`);
}

async function main() {
  let opts;
  try {
    opts = args(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.staleHours !== null) {
    // Zero is allowed on purpose: "nothing may be older than now" is the strict form, and it
    // is the one a test can assert without pinning a wall-clock time.
    if (!Number.isFinite(opts.staleHours) || opts.staleHours < 0) {
      console.error(`--check-stale needs a number of hours (0 or more)\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    await checkStale(opts.staleHours);
    return;
  }
  if (opts.source && !SOURCES[opts.source]) {
    console.error(`unknown source ${opts.source}; expected one of ${Object.keys(SOURCES).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    console.error("--days must be a positive number");
    process.exitCode = 2;
    return;
  }

  const names = opts.source ? [opts.source] : Object.keys(SOURCES);
  const entries = [];
  const failures = [];

  for (const name of names) {
    console.log(`\n== ${name}${opts.dryRun ? " (dry run)" : ""}`);
    try {
      const { entries: got } = await SOURCES[name].run({ dryRun: opts.dryRun, days: opts.days });
      entries.push(...got);
      if (!opts.dryRun) console.log(`   ${got.length} receipt${got.length === 1 ? "" : "s"}`);
    } catch (e) {
      /* An adapter that failed partway still returns the receipts it did produce — losing
       * those would make a partial run look like no run at all. */
      if (Array.isArray(e.entries)) entries.push(...e.entries);
      failures.push(`${name}: ${e.message}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n   dry run: nothing fetched, no receipt written");
    return;
  }

  if (entries.length) {
    console.log("\n== receipts");
    printReceipts(entries);
    await writeReceipt(entries);
  }

  if (failures.length) {
    console.error("\nFAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
    return;
  }

  const all = await readReceipt();
  const stale = Object.values(all.sources).filter(
    (s) => Date.now() - Date.parse(s.fetched_at) > 24 * 3600_000,
  );
  if (stale.length) console.log(`\n   note: ${stale.length} receipt(s) are older than 24 h`);

  console.log(`\n${entries.length} source${entries.length === 1 ? "" : "s"} refreshed — data/raw/_receipt.json`);
}

await main();
