#!/usr/bin/env node
/**
 * BrazosCast data acquisition
 * ------------------------------------------------------------------
 * Caches every live, unauthenticated source the app depends on into
 * data/raw/, plus a manifest.json recording what succeeded, when, and
 * how many records came back.
 *
 * Zero dependencies, Node >=18 (global fetch). Run: node pipeline/fetch/fetch.mjs
 *
 * Verified live 2026-10-13/14. See docs/DATA-SOURCES.md for the ledger
 * and for the gotchas (OpenFEMA entity rename, FBC county GIS outage,
 * San Felipe datum trap).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW = join(ROOT, "data", "raw");

/* ---------------- gauge chain (NWPS LID -> USGS site) ---------------- */
/* Order matters: upstream -> Richmond (target) -> downstream. */
export const GAUGE_CHAIN = [
  { lid: "WBAT2", usgs: "08096500", name: "Brazos River at Waco",        role: "far upstream" },
  { lid: "HIBT2", usgs: "08098290", name: "Brazos River near Highbank",  role: "upstream" },
  { lid: "BBZT2", usgs: "08108700", name: "Brazos River near Bryan",     role: "upstream" },
  { lid: "HPDT2", usgs: "08111500", name: "Brazos River near Hempstead", role: "key upstream" },
  { lid: "BAWT2", usgs: "08111850", name: "Brazos River above San Felipe", role: "nearest upstream" },
  { lid: "RMOT2", usgs: "08114000", name: "Brazos River at Richmond",    role: "TARGET" },
  { lid: "ROST2", usgs: "08116650", name: "Brazos River near Rosharon",  role: "downstream" },
];

/* Fort Bend County FIPS for OpenFEMA filtering. */
const FBC_FIPS = "48157";

/* Gauges whose observed stage/flood series are cached as well as their metadata.
 * The gauge-failure redundancy path (pipeline/derive/gauge_redundancy.py) estimates
 * the Richmond stage from these upstream gauges when RMOT2 is stale, and a run-time
 * gate there checks that NWPS and USGS report the SAME datum for them — the
 * "San Felipe trap" documented in docs/DATA-SOURCES.md is exactly a silent offset
 * between sources, and it must not be discovered by a wrong flood forecast. */
const STAGEFLOW_LIDS = ["HPDT2", "BAWT2"];

/* ---------------- helpers ---------------- */
async function fetchJson(url, { tries = 3, timeoutMs = 45000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { accept: "application/json", "user-agent": "BrazosCast/0.1 (student project)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

async function save(relPath, data) {
  const full = join(RAW, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2));
  return full;
}

/* ---------------- sources ---------------- */
async function fetchNwpsChain(manifest) {
  const out = [];
  for (const g of GAUGE_CHAIN) {
    const url = `https://api.water.noaa.gov/nwps/v1/gauges/${g.lid}`;
    try {
      const data = await fetchJson(url);
      await save(`nwps/${g.lid}.json`, data);
      if (STAGEFLOW_LIDS.includes(g.lid)) {
        // Metadata alone is not enough to verify a datum; the observed series is.
        try {
          const sf = await fetchJson(`${url}/stageflow`);
          await save(`nwps/${g.lid}_stageflow.json`, sf);
        } catch (e) {
          console.log(`    (stageflow cache for ${g.lid} failed: ${e})`);
        }
      }
      const obs = data?.status?.observed;
      const fc = data?.status?.forecast;
      out.push({
        lid: g.lid, usgs: g.usgs, name: g.name, role: g.role,
        ok: true,
        observed_ft: obs?.primary ?? null,
        observed_category: obs?.floodCategory ?? null,
        observed_valid: obs?.validTime ?? null,
        forecast_ft: fc?.primary ?? null,
        thresholds: {
          action: data?.flood?.categories?.action?.stage ?? null,
          minor: data?.flood?.categories?.minor?.stage ?? null,
          moderate: data?.flood?.categories?.moderate?.stage ?? null,
          major: data?.flood?.categories?.major?.stage ?? null,
        },
        // NOTE: `datums` is the per-gauge normalize key (San Felipe trap).
        datums: data?.datums ?? null,
      });
    } catch (err) {
      out.push({ lid: g.lid, usgs: g.usgs, ok: false, error: String(err) });
    }
  }
  manifest.nwps_chain = out;
  const okCount = out.filter((g) => g.ok).length;
  console.log(`  NWPS chain: ${okCount}/${out.length} gauges`);
  const target = out.find((g) => g.lid === "RMOT2");
  if (target?.ok) {
    console.log(`  RMOT2 observed: ${target.observed_ft} ft (${target.observed_category}) ` +
      `[action ${target.thresholds.action} / flood ${target.thresholds.minor} / ` +
      `mod ${target.thresholds.moderate} / major ${target.thresholds.major}]`);
  }
}

async function fetchRivGaugesBulk(manifest) {
  const where = encodeURIComponent("waterbody like 'Brazos%'");
  const fields = "gaugelid,location,action,flood,moderate,major,latitude";
  const url =
    `https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query` +
    `?where=${where}&outFields=${fields}&returnGeometry=false&f=json`;
  const data = await fetchJson(url);
  await save("nws/riv_gauges_brazos.json", data);
  const n = data?.features?.length ?? 0;
  manifest.riv_gauges_brazos = { ok: true, count: n };
  console.log(`  NWS riv_gauges (Brazos): ${n} gauges with thresholds`);
}

async function fetchOpenFema(manifest) {
  // v2 FimaNfipClaims is removed 2026-10-15; v3 entity renamed to NfipClaims.
  const BASE = "https://www.fema.gov/api/open/v3/NfipClaims";
  // v3 schema notes (verified 2026-10-14): entity renamed FimaNfipClaims -> NfipClaims;
  // censusTract + censusBlockGroupFips collapsed into a single `censusGeoid`.
  const select = [
    "countyCode", "censusGeoid", "ratedFloodZone",
    "floodZoneCurrent", "latitude", "longitude", "dateOfLoss", "waterDepth",
    "floodWaterDuration", "causeOfDamage", "floodEvent", "amountPaidOnBuildingClaim",
  ].join(",");
  const pageSize = 1000;
  let skip = 0, total = null, rows = [];
  for (;;) {
    const url =
      `${BASE}?$top=${pageSize}&$skip=${skip}&$count=true` +
      `&$filter=${encodeURIComponent(`countyCode eq '${FBC_FIPS}'`)}` +
      `&$select=${select}`;
    const data = await fetchJson(url, { tries: 4 });
    if (total === null) total = data?.metadata?.count ?? null;
    const batch = data?.NfipClaims ?? [];
    rows = rows.concat(batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
    process.stdout.write(`\r  OpenFEMA v3 NfipClaims (Fort Bend): ${rows.length}/${total ?? "?"}`);
  }
  process.stdout.write("\n");
  await save("openfema/nfip_claims_48157_v3.json", { metadata: { total, fetchedAt: new Date().toISOString(), countyCode: FBC_FIPS }, NfipClaims: rows });
  manifest.openfema_nfip_claims = { ok: true, count: rows.length, reportedCount: total, entity: "NfipClaims", version: "v3" };
  console.log(`  OpenFEMA v3: cached ${rows.length} Fort Bend claims (reported ${total})`);
}

/* ---------------- main ---------------- */
async function main() {
  const manifest = { generatedAt: new Date().toISOString(), sources: {} };
  console.log("BrazosCast fetch ->", RAW);

  for (const [name, fn] of [
    ["NWPS gauge chain", fetchNwpsChain],
    ["NWS riv_gauges bulk", fetchRivGaugesBulk],
    ["OpenFEMA v3 NFIP claims", fetchOpenFema],
  ]) {
    try {
      console.log(`- ${name}`);
      await fn(manifest);
      manifest.sources[name] = "ok";
    } catch (err) {
      console.error(`  FAILED: ${err}`);
      manifest.sources[name] = `failed: ${err}`;
    }
  }

  await save("manifest.json", manifest);
  console.log("\nManifest -> data/raw/manifest.json");
  const failed = Object.entries(manifest.sources).filter(([, v]) => v !== "ok");
  if (failed.length) {
    console.error("Completed with failures:", failed.map(([k]) => k).join(", "));
    process.exitCode = 1;
  }
}

main();
