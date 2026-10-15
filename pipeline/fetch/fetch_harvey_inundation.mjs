#!/usr/bin/env node
/**
 * BrazosCast — USGS observed Harvey flood inundation (Brazos River, upper reach)
 * -----------------------------------------------------------------------------
 * Step 6 of docs/UPGRADE-PLAN.md: adjudicate the street thresholds against
 * observed flooding. The only in-repo observation before this was OpenFEMA NFIP
 * claims, whose coordinates are privacy-coarsened to 0.1 deg (~11 km per cell),
 * so no per-segment validation was possible offline (threshold_correction.py, R5).
 *
 * Source: USGS data release doi:10.5066/F7VH5N3N, "Brazos River" item
 *   5aa02374e4b0b1c392e68400 — supporting
 *   Watson and others (2018), USGS Scientific Investigations Report 2018-5070.
 *
 * Three layers are cached, all EPSG:6579 (Texas Centric Albers Equal Area):
 *   brazos_upper_final.shp  mapped flood-inundation extent (the adjudication layer)
 *   brazos_upper_hwm.shp    surveyed high-water marks, with water-surface elevations
 *   brazos_upper_bndy.shp   mapped area boundary (the study area for the extent)
 *
 * WHAT THIS LAYER IS, AND IS NOT. The readme shipped with the release states the
 * extent is "derived from the water-surface elevation surveyed at high-water
 * marks" — 44 HWMs in this reach, interpolated with ESRI Topo to Raster and
 * clipped to the mapped boundary. It is a survey-anchored water-surface estimate,
 * not a satellite-observed water edge, and it is a single maximum extent for the
 * event rather than a time series. That distinction is carried into
 * docs/FINDINGS.md and into the validation output, because it bounds what the
 * comparison can prove: it can show the thresholds are biased, but a segment
 * inside the polygon is not thereby proven to have been flooded in the way the
 * user experienced it.
 *
 * The depth raster (Depth_Brazos_upper.zip, 377 MB) is deliberately not fetched:
 * the polygon intersection needs no raster, and it would dwarf data/raw/.
 *
 * Output: data/raw/harvey/{Brazos_upper.zip, README.txt, _receipt.json}
 * Run:    node pipeline/fetch/fetch_harvey_inundation.mjs [--force]
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "raw", "harvey");
const FORCE = process.argv.includes("--force");

const ITEM = "5aa02374e4b0b1c392e68400";
const FILES = [
  {
    name: "Brazos_upper.zip",
    url: "https://www.sciencebase.gov/catalog/file/get/" + ITEM +
      "?f=__disk__00%2F4f%2Fc5%2F004fc5fc7d29a97ddcb36f98211938a12c357b49",
    bytes: 2088560,
    contains: ["brazos_upper_final.shp", "brazos_upper_hwm.shp", "brazos_upper_bndy.shp"],
  },
  {
    name: "README.txt",
    url: "https://www.sciencebase.gov/catalog/file/get/" + ITEM +
      "?f=__disk__1f%2F7f%2Ff9%2F1f7ff973008125700d1c3f14230f1d749b905ca8",
    bytes: 2985,
    contains: ["F7VH5N3N"],
  },
];

async function get(url, tries = 4) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, { headers: { accept: "*/*" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (a < tries) await new Promise((r) => setTimeout(r, 800 * 2 ** a));
    }
  }
  throw last;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const results = [];

  for (const f of FILES) {
    const dst = join(OUT, f.name);
    let existing = null;
    try { existing = await stat(dst); } catch { /* not cached yet */ }

    if (existing && !FORCE) {
      console.log(`- ${f.name}: cached (${existing.size} bytes), skipping`);
      results.push({ name: f.name, bytes: existing.size, source: "cache" });
      continue;
    }

    const buf = await get(f.url);
    await writeFile(dst, buf);

    // Content checks: a ScienceBase error page is a 200 with HTML, so size and
    // payload signatures are asserted rather than trusting the status code.
    if (f.name.endsWith(".zip")) {
      const magic = buf.subarray(0, 2).toString("latin1");
      if (magic !== "PK") throw new Error(`${f.name}: not a zip (magic ${JSON.stringify(magic)})`);
      if (buf.length !== f.bytes) throw new Error(`${f.name}: ${buf.length} bytes, expected ${f.bytes}`);
    }
    const text = buf.toString("latin1");
    for (const needle of f.contains) {
      if (!text.includes(needle)) {
        throw new Error(`${f.name}: payload does not mention "${needle}" — not the expected file`);
      }
    }
    // .shp member names live in the zip's central directory; latin1 view is enough
    // to confirm all three expected shapefiles are present without unzipping.
    console.log(`- ${f.name}: ${buf.length} bytes, verified`);
    results.push({ name: f.name, bytes: buf.length, source: "sciencebase" });
  }

  const receipt = {
    fetchedAt: new Date().toISOString(),
    source: "USGS ScienceBase",
    item: ITEM,
    citation: "Watson, K.M., and others, 2018, Characterization of peak streamflows and flood " +
      "inundation of selected areas in southeastern Texas and southwestern Louisiana from the " +
      "August and September 2017 flood resulting from Hurricane Harvey: USGS Scientific " +
      "Investigations Report 2018-5070",
    doi: "10.5066/F7VH5N3N",
    license: "USGS public domain (CC0)",
    crs: "EPSG:6579 (Texas Centric Albers Equal Area)",
    layer_nature: "survey-anchored water-surface estimate interpolated from 44 high-water marks " +
      "and clipped to the mapped boundary; a single maximum extent, not a satellite water edge " +
      "and not a time series",
    use: "pipeline/derive/harvey_validation.py",
    files: results,
  };
  await writeFile(join(OUT, "_receipt.json"), JSON.stringify(receipt, null, 2));
  console.log("\nReceipt -> data/raw/harvey/_receipt.json");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exitCode = 1;
});
