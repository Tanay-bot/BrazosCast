#!/usr/bin/env node
/**
 * BrazosCast — one command for every public source.
 *
 *   node pipeline/ingest/refresh.mjs                 # all three, then a receipt table
 *   node pipeline/ingest/refresh.mjs --source=nwps   # one of nwps | usgs_ogc | usace
 *   node pipeline/ingest/refresh.mjs --dry-run       # print the requests, fetch nothing
 *   node pipeline/ingest/refresh.mjs --days=10       # widen the window (default 7)
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

function args(argv) {
  const out = { source: null, dryRun: false, days: 7 };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a.startsWith("--days=")) out.days = Number(a.slice("--days=".length));
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  let opts;
  try {
    opts = args(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node pipeline/ingest/refresh.mjs [--source=nwps|usgs_ogc|usace] [--dry-run] [--days=7]`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log("usage: node pipeline/ingest/refresh.mjs [--source=nwps|usgs_ogc|usace] [--dry-run] [--days=7]");
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
