#!/usr/bin/env node
/**
 * BrazosCast — a SECOND observed extent: the 2016 Brazos flood, from satellite SAR
 * ---------------------------------------------------------------------------------
 * docs/UPGRADE-PLAN.md Step 6 validated the street thresholds against one observation:
 * the USGS Harvey extent (doi:10.5066/F7VH5N3N), an event MAXIMUM at the record peak,
 * interpolated between 44 surveyed high-water marks. Its own limits say the thing it
 * cannot do — and the reason I1 was left open — is **adjudicate a low threshold**:
 *
 *   "A segment observed wet at the record peak is equally consistent with flooding at
 *    17 ft and at 55 ft, so a point-in-time extent carries no information about a low
 *    threshold."  (harvey_validation.py, below_action_stage)
 *
 * This is the second observation that does carry that information, because it is at a
 * DIFFERENT and LOWER stage on a DIFFERENT event:
 *
 *   platform   Sentinel-1 SAR, 10 m
 *   acquired   2016-05-30
 *   mapped     214.9 km² of the Brazos near Richmond
 *   source     USFIMR (University of Alabama Surface Dynamics Modeling Lab), developed
 *              under a NOAA/UCAR subaward; SDML publishes the data under CC BY 3.0
 *
 * WHY A LOWER STAGE IS THE POINT. The gauge (RMOT2, 08114000) was between 49.31 and
 * 52.20 ft through 2016-05-30 — 3 to 6 ft below the Harvey peak of 55.13 ft. A segment
 * the SAR image shows DRY therefore had not flooded at that stage, which puts a LOWER
 * BOUND on its true threshold and can REFUTE a threshold the model puts below it. That
 * is a different kind of evidence from the maximum extent, and the two together are the
 * beginning of the "series of extents at successive stages" harvey_validation.py asks for.
 *
 * WHAT THIS IS NOT. It is a water EDGE read off one radar image, not a surveyed maximum,
 * so: it is one instant (not the event peak — the 2016 event crested three days later at
 * 54.74 ft); radar water edges have known failure modes (vegetation and smooth open water
 * both backscatter oddly, and a wind-roughened surface can read as land); and the SDML
 * layer carries "some ground proofing based on secondary sources" rather than a survey.
 * The acquisition TIME is not published in the catalog entry — but the layer's own
 * dbf attributes carry it (Flood_Date + Start_Time, 2016-05-30 00:26 UTC), so
 * second_event_validation.py reads it from there and scores against the gauge reading
 * at that instant. What this receipt carries, from fetch time alone, is the band the
 * gauge moved through that day; the validation reports its sensitivity to the choice.
 *
 * Output: data/raw/usfimr/{05302016_Brazos_River_at_Richmond_TX.zip, _receipt.json}
 * Run:    node pipeline/fetch/fetch_usfimr_2016.mjs [--force]
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "raw", "usfimr");
const FORCE = process.argv.includes("--force");

const NAME = "05302016_Brazos_River_at_Richmond_TX.zip";
// The catalog page links this over plain http; https is tried first because the same
// host serves it (verified), and a redirect/404 falls through to the next candidate.
const URLS = [
  `https://waterserv.ua.edu/wp-content/uploads/content/datasets/usfimr/US-TX/${NAME}`,
  `http://waterserv.ua.edu/wp-content/uploads/content/datasets/usfimr/US-TX/${NAME}`,
];
const LISTING = "https://waterserv.ua.edu/datasets/usfimr/";

/** The stage the gauge was reading through the acquisition day, from the cached USGS
 *  instantaneous series — read here rather than restated, so the receipt cannot drift
 *  from the series the validation actually compares against. */
async function stageBand() {
  const p = join(ROOT, "data", "raw", "usgs", "iv", "08114000_20160524.json");
  const rows = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
  const values = rows
    .map((r) => r.properties)
    .filter((r) => String(r.time).startsWith("2016-05-30"))
    .map((r) => Number(r.value))
    .filter((v) => Number.isFinite(v));
  if (!values.length) throw new Error("no RMOT2 readings cached for 2016-05-30");
  return { min_ft: Math.min(...values), max_ft: Math.max(...values), n: values.length };
}

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
  const dst = join(OUT, NAME);

  let existing = null;
  try { existing = await stat(dst); } catch { /* not cached yet */ }

  let result;
  if (existing && !FORCE) {
    console.log(`- ${NAME}: cached (${existing.size} bytes), skipping`);
    // The canonical URL even on the cached path: these are the bytes that URL served,
    // and a receipt that says "cache" is missing the provenance it exists to record.
    result = { name: NAME, bytes: existing.size, source: URLS[0] };
  } else {
    let buf = null;
    let from = null;
    const errors = [];
    for (const url of URLS) {
      try {
        buf = await get(url);
        from = url;
        break;
      } catch (e) {
        errors.push(`${url}: ${e}`);
      }
    }
    if (!buf) throw new Error(`all candidate URLs failed:\n${errors.join("\n")}`);

    // A withheld file on this host answers 200 with an HTML page, so the payload is
    // checked rather than the status code: zip magic, a floor on size, and the
    // shapefile member names the catalog promises.
    const magic = buf.subarray(0, 2).toString("latin1");
    if (magic !== "PK") throw new Error(`${NAME}: not a zip (magic ${JSON.stringify(magic)})`);
    if (buf.length < 20_000) throw new Error(`${NAME}: only ${buf.length} bytes — not the dataset`);
    const members = buf.toString("latin1");
    for (const needle of [".shp", ".dbf"]) {
      if (!members.includes(needle)) {
        throw new Error(`${NAME}: no ${needle} member — the payload is not the shapefile`);
      }
    }
    await writeFile(dst, buf);
    console.log(`- ${NAME}: ${buf.length} bytes, zip with a shapefile, from ${from}`);
    result = { name: NAME, bytes: buf.length, source: from };
  }

  const band = await stageBand();
  const receipt = {
    fetchedAt: new Date().toISOString(),
    dataset: "USFIMR flood-inundation extent — Brazos River near Richmond, Texas",
    provider: "University of Alabama, Surface Dynamics Modeling Lab (SDML)",
    developed_under: "NOAA/UCAR subaward, Cooperative Agreement Z16-23487",
    licence: "CC BY 3.0 Unported (SDML datasets portal)",
    catalogue: LISTING,
    platform: "Sentinel-1 SAR, 10 m",
    acquired: "2016-05-30",
    mapped_area_km2: 214.9,
    event: {
      name: "2016 Brazos River flood (late May – early June 2016)",
      observed_peak_ft: 54.74,
      observed_peak_at: "2016-06-02",
      peak_source: "USGS annual peaks, site 08114000 (data/raw/usgs/08114000_peaks.json)",
      note: "the image is three days BEFORE this peak, so it is a mid-rise observation",
    },
    stage_at_acquisition_ft: band,
    stage_at_acquisition_note:
      "the catalog does not publish the acquisition time; the LAYER does, in its own " +
      "attributes (Flood_Date + Start_Time = 2016-05-30T00:26:20Z), and the validation " +
      "pins the comparison to the gauge reading at that instant. This band is the " +
      "fetch-time fallback, and the validation reports the sensitivity to the choice",
    nature: "water edge read from one radar image — not a surveyed maximum, not an event " +
      "peak, and subject to the usual SAR failure modes (vegetation and smooth open " +
      "water both backscatter oddly; a wind-roughened surface can read as land)",
    use: "pipeline/derive/second_event_validation.py",
    files: [result],
  };
  await writeFile(join(OUT, "_receipt.json"), JSON.stringify(receipt, null, 2));
  console.log("\nReceipt -> data/raw/usfimr/_receipt.json");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exitCode = 1;
});
