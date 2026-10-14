#!/usr/bin/env node
/**
 * BrazosCast — historical USGS record for the gauge chain
 * ------------------------------------------------------------------
 * Pulls, for each gauge in the chain:
 *   - daily mean gage height  (parameter 00065, statistic 00003)
 *   - daily mean discharge    (parameter 00060, statistic 00003)
 *   - annual peaks            (peaks collection: peak stage + flow)
 *
 * Uses the NEW USGS API (api.waterdata.usgs.gov). The legacy host
 * slows in Jan 2027 and shuts down 2027-02-22.
 *
 * Output: data/raw/usgs/<usgsSite>_{daily,peaks}.json
 * Run:    node pipeline/fetch/fetch_usgs_history.mjs [startYear]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "raw", "usgs");

const CHAIN = [
  ["WBAT2", "08096500", "Waco"],
  ["HIBT2", "08098290", "Highbank"],
  ["BBZT2", "08108700", "Bryan"],
  ["HPDT2", "08111500", "Hempstead"],
  ["BAWT2", "08111850", "San Felipe"],
  ["RMOT2", "08114000", "Richmond"],
  ["ROST2", "08116650", "Rosharon"],
];

const START_YEAR = Number(process.argv[2]) || 1985;
const BASE = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";

async function getJson(url, tries = 4) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (a < tries) await new Promise((r) => setTimeout(r, 400 * 2 ** a));
    }
  }
  throw last;
}

/** Follow OGC-API `next` links, collecting properties from every page. */
async function paged(url) {
  const rows = [];
  let next = url;
  let guard = 0;
  while (next && guard++ < 200) {
    const page = await getJson(next);
    for (const f of page.features ?? []) rows.push(f.properties);
    const link = (page.links ?? []).find((l) => l.rel === "next");
    next = link ? link.href : null;
    if (rows.length % 5000 < 1) process.stdout.write(`\r    ...${rows.length}`);
  }
  process.stdout.write(`\r    ...${rows.length}\n`);
  return rows;
}

async function daily(site, paramCode, startYear) {
  const url =
    `${BASE}/daily/items?monitoring_location_id=USGS-${site}` +
    `&parameter_code=${paramCode}&statistic_id=00003` +
    `&datetime=${startYear}-01-01/..&limit=10000&f=json`;
  return paged(url);
}

async function peaks(site) {
  const url = `${BASE}/peaks/items?monitoring_location_id=USGS-${site}&limit=10000&f=json`;
  return paged(url);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`USGS historical (from ${START_YEAR}) -> ${OUT}`);
  const summary = [];

  for (const [, site, name] of CHAIN) {
    console.log(`- ${site} ${name}`);
    try {
      const [stage, flow, pk] = await Promise.all([
        daily(site, "00065", START_YEAR),
        daily(site, "00060", START_YEAR),
        peaks(site),
      ]);
      await writeFile(join(OUT, `${site}_daily.json`),
        JSON.stringify({ site, stage_daily: stage, flow_daily: flow }));
      await writeFile(join(OUT, `${site}_peaks.json`), JSON.stringify({ site, peaks: pk }));
      summary.push({ site, name, stage_days: stage.length, flow_days: flow.length, peaks: pk.length });
      console.log(`    stage ${stage.length}d · flow ${flow.length}d · peaks ${pk.length}`);
    } catch (e) {
      console.error(`    FAILED: ${e}`);
      summary.push({ site, name, error: String(e) });
    }
  }

  await writeFile(join(OUT, "_summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), startYear: START_YEAR, summary }, null, 2));
  console.log("\nSummary -> data/raw/usgs/_summary.json");
}

main();
