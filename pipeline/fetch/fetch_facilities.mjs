#!/usr/bin/env node
/**
 * BrazosCast — response facilities (real OSM destinations)
 * ------------------------------------------------------------------
 * Step 4 routes to real destinations, not to whichever street happens to be
 * nearest. This pulls every hospital, fire station and police station inside a
 * box around the Richmond/Rosenberg corridor from OpenStreetMap via Overpass,
 * and caches the raw response so the routing step is reproducible offline.
 *
 * Zero dependencies, Node >=18 (global fetch).
 * Run: node pipeline/fetch/fetch_facilities.mjs
 *
 * Overpass notes (learned the hard way, recorded so this does not get
 * "simplified" back into a failure):
 *   - The main instance answers, but only for LIGHT queries. Adding `way` to the
 *     same amenity query (to catch area-mapped sites) returns a 502/504 gateway
 *     timeout on overpass-api.de and on every open mirror tried.
 *   - Node-only queries over this box return in ~2 s. So we ask for nodes, with
 *     a 25 s server timeout, and try the mirrors in order.
 *   - A missing User-Agent gets the request refused, so one is sent.
 *
 * Output: data/raw/osm_facilities.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "raw", "osm_facilities.json");

/* The corridor bbox from road_thresholds.geojson, padded ~2 km so a facility
 * just outside the clip still gets considered (the routing step rejects it if
 * it is not on the modelled network). */
const BBOX = "29.42,-96.20,29.85,-95.45";
const AMENITIES = ["hospital", "fire_station", "police"];

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const QUERY = `[out:json][timeout:25];
(
${AMENITIES.map((a) => `  node["amenity"="${a}"](${BBOX});`).join("\n")}
);
out center;`;

async function tryEndpoint(url, { timeoutMs = 60000, tries = 2 } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "BrazosCast/0.1 (student project; contact via repo)",
        },
        body: new URLSearchParams({ data: QUERY }).toString(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  let payload = null;
  let used = null;
  for (const ep of ENDPOINTS) {
    try {
      process.stdout.write(`- ${ep} ... `);
      payload = await tryEndpoint(ep);
      used = ep;
      console.log(`${payload.elements?.length ?? 0} elements`);
      break;
    } catch (e) {
      console.log(`failed (${e})`);
    }
  }
  if (!payload) throw new Error("every Overpass endpoint failed");

  // Keep the raw OSM tags, drop Overpass bookkeeping.
  const facilities = (payload.elements ?? [])
    .filter((e) => e.type === "node" && e.tags?.amenity && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({
      id: `node/${e.id}`,
      kind: e.tags.amenity,
      name: e.tags.name ?? null,
      lon: e.lon,
      lat: e.lat,
      tags: e.tags,
    }));

  const byKind = {};
  for (const f of facilities) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  await writeFile(OUT, JSON.stringify({
    source: "OpenStreetMap via Overpass API (ODbL)",
    endpoint: used,
    bbox: BBOX,
    amenities: AMENITIES,
    fetchedAt: new Date().toISOString(),
    counts: byKind,
    facilities,
  }, null, 1));

  console.log(`\n${facilities.length} facilities -> ${OUT}`);
  for (const [k, v] of Object.entries(byKind)) console.log(`   ${k}: ${v}`);
}

main();
