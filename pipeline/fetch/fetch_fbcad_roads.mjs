#!/usr/bin/env node
/**
 * BrazosCast — Fort Bend County road centerlines *with address ranges*
 * ------------------------------------------------------------------
 * The app's headline interaction is "type your address, get your street's lead
 * time". Until now that was impossible without a third-party geocoder: the US
 * Census geocoder sends no CORS header at all (so a browser cannot call it) and
 * returns zero matches for this corridor, and Mapbox needs a token. Both facts
 * are measured in docs/ACTION-PLAN.md §D1.
 *
 * Fort Bend County's own appraisal district publishes a road centerline file
 * with TIGER-style address ranges on every segment:
 *
 *     LF_ADDR / LT_ADDR   house-number range on the left side
 *     RF_ADDR / RT_ADDR   house-number range on the right side
 *     RD_PRE / RD_NAME / RD_TYPE / FULL_NAME
 *
 * That is an address index: "4710 THOMPSON FERRY RD" is on the segment whose
 * range brackets 4710. No key, no quota, and `access-control-allow-origin: *`
 * (verified) means it could even be called live — but we cache it, so the app
 * ships a static index and keeps working when the network does not.
 *
 * The FBCAD open-data hub carries 26 datasets and none of them is an
 * "Address Points" layer; this is the one that actually resolves a house number.
 *
 * Zero dependencies, Node >=18 (global fetch).
 * Run: node pipeline/fetch/fetch_fbcad_roads.mjs
 *
 * Output: data/raw/fbcad_roads.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "raw", "fbcad_roads.json");

const SERVICE =
  "https://services2.arcgis.com/D4saGHECICkCeoJm/arcgis/rest/services/Roads_view/FeatureServer/0";

/* The corridor bbox from road_thresholds.summary.json, padded ~5 km so an
 * address just outside the clip still resolves to the segment that serves it.
 * xmin,ymin,xmax,ymax in WGS84. */
const BBOX = [-96.15, 29.4, -95.5, 29.8];

const OUT_FIELDS = [
  "FULL_NAME",
  "RD_PRE",
  "RD_NAME",
  "RD_TYPE",
  "ALIAS",
  "LF_ADDR",
  "LT_ADDR",
  "RF_ADDR",
  "RT_ADDR",
  "CITY",
].join(",");

const PAGE = 2000; // service maxRecordCount is 2000 and supportsPagination is true

async function getJson(url, { tries = 3, timeoutMs = 60000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { accept: "application/json", "user-agent": "BrazosCast/0.1 (student project)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // ArcGIS reports failures inside a 200 body; do not let that pass as data.
      if (j.error) throw new Error(`ArcGIS ${j.error.code}: ${j.error.message}`);
      return j;
    } catch (err) {
      last = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 700 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

/* /query with pagination. The service caps a page at 2000 and does not
 * guarantee stable ordering without an ORDER BY, so order by the object id —
 * an unstable order with resultOffset silently duplicates and drops rows. */
async function query({ where = "1=1", countOnly = false, offset = 0, withGeometry = true } = {}) {
  // returnCountOnly is only honoured by f=json; asking geojson for a count
  // returns a FeatureCollection and `.count` silently comes back undefined.
  const p = new URLSearchParams({
    f: countOnly ? "json" : "geojson",
    where,
    outFields: OUT_FIELDS,
    returnGeometry: String(withGeometry),
    outSR: "4326",
    geometry: BBOX.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    orderByFields: "FID",
  });
  if (countOnly) {
    p.set("returnCountOnly", "true");
    p.set("returnGeometry", "false");
    p.delete("outFields");
  } else {
    p.set("resultOffset", String(offset));
    p.set("resultRecordCount", String(PAGE));
  }
  return getJson(`${SERVICE}/query?${p.toString()}`);
}

/* Keep only segments that can actually answer a house number: at least one side
 * with a real range. Zero/zero means "not addressed" in this file and would
 * otherwise match every number. */
function usable(f) {
  const a = f.properties ?? {};
  const nums = [a.LF_ADDR, a.LT_ADDR, a.RF_ADDR, a.RT_ADDR]
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const lo = Math.min(...nums.filter((v) => v !== null && v > 0));
  const hi = Math.max(...nums.filter((v) => v !== null && v > 0));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return null;
  const name = (a.FULL_NAME ?? "").trim();
  if (!name) return null;
  return {
    name,
    lo,
    hi,
    // The county's ALIAS column carries the name people actually say for a road
    // filed under a different one, so keeping it is what lets a driver's address
    // resolve as well as the filed one.
    alias: (a.ALIAS ?? "").trim() || null,
    city: a.CITY ?? null,
    pts: endpoints(f.geometry),
  };
}

/* 32,829 full polylines is ~40 MB of cache for geometry the derivation only
 * needs a position from. Keep the two endpoints: every segment here is short
 * (it is one side of one block), so the midpoint of the endpoints lands on the
 * segment, which is all the distance-to-mainstem test needs. Coordinates are
 * rounded to 5 dp (~1 m) — well inside the ~2 km tolerance of that test. */
function endpoints(geom) {
  const c = geom?.coordinates;
  if (!Array.isArray(c) || c.length === 0) return null;
  const flat = geom.type === "MultiLineString" ? c.flat() : c;
  if (!Array.isArray(flat) || !flat.length) return null;
  const r = (p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))];
  return [r(flat[0]), r(flat[flat.length - 1])];
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true });

  const meta = await getJson(`${SERVICE}?f=json`);
  console.log(`- service: ${meta.name} (maxRecordCount ${meta.maxRecordCount})`);

  const count = (await query({ countOnly: true })).count;
  if (!Number.isFinite(count)) throw new Error("service did not return a feature count");
  console.log(`- ${count} segments intersect the padded corridor bbox`);

  const rows = [];
  for (let offset = 0; offset < count; offset += PAGE) {
    const page = await query({ offset });
    const feats = page.features ?? [];
    if (!feats.length) break;
    rows.push(...feats);
    process.stdout.write(`\r  fetched ${rows.length}/${count}`);
  }
  process.stdout.write("\n");

  // A short page before the advertised count means the service lied about the
  // total, or paging is not actually supported. Either way, do not write a
  // truncated index that silently drops streets.
  if (rows.length !== count) {
    throw new Error(`paged ${rows.length} of ${count} segments — refusing to cache a partial index`);
  }

  // Segments whose geometry the service did not return cannot be placed, and a
  // misplaced segment resolves an address to the wrong street. Drop them and say
  // how many, rather than guessing.
  const addressed = rows.map(usable).filter(Boolean);
  const usableRows = addressed.filter((r) => r.pts);
  const noGeom = addressed.length - usableRows.length;
  const names = new Set(usableRows.map((r) => r.name));
  console.log(
    `- ${usableRows.length} carry an address range and geometry, ${names.size} distinct street names` +
      (noGeom ? ` (${noGeom} dropped: no geometry)` : ""),
  );

  await writeFile(
    OUT,
    JSON.stringify(
      {
        source: "Fort Bend Central Appraisal District (FBCAD) road centerlines, public open-data hub",
        licence: "Fort Bend County open data",
        service: SERVICE,
        note:
          "Address ranges (LF/LT/RF/RT_ADDR) are the point of this file — they let a house " +
          "number resolve to a street segment with no geocoding API and no key.",
        cors: "access-control-allow-origin: * (verified)",
        bbox: BBOX,
        fetchedAt: new Date().toISOString(),
        counts: {
          segments: rows.length,
          withAddressRangeAndGeometry: usableRows.length,
          droppedNoGeometry: noGeom,
          streetNames: names.size,
        },
        geometry: "endpoints only (first + last vertex, 5 dp) — see endpoints() for why",
        roads: usableRows,
      },
      null,
      0,
    ),
  );
  console.log(`\n${usableRows.length} addressed segments -> ${OUT}`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
