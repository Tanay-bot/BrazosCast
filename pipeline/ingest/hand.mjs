#!/usr/bin/env node
/**
 * BrazosCast — the HAND archive, fetched one basin at a time.
 *
 *   node pipeline/ingest/hand.mjs --manifest --huc8=12070104        # what is in it, no download
 *   node pipeline/ingest/hand.mjs --huc8=12070104 --dry-run         # print the plan, fetch nothing
 *   node pipeline/ingest/hand.mjs --huc8=12070104 --extract         # 1.7 GB, then verify and unzip
 *   node pipeline/ingest/hand.mjs --huc8=12070104 --variant=full --yes
 *
 * WHY THIS IS NOT PART OF `refresh.mjs`. The other three sources are kilobytes of JSON on a
 * daily cadence. This one is 1.7 GB (prod) or 9 GB (full) per basin, published once and not
 * revised, so putting it in the nightly refresh would re-download a static archive forever.
 * It is a custody step: run it when the archive is missing, not when it is old.
 *
 * WHERE THE BYTES COME FROM. The committed `data/raw/hand/12070104/` tree is NOAA-OWP HAND
 * v2's per-BRANCH output for this HUC, and the only route to it is the credentialed
 * `s3://noaa-nws-owp-fim` bucket (ESIP keys; verified 403 without them). The keyless route is
 * the Texas Pin2Flood HUC8 package — UT Austin's Center for Water and the Environment,
 * hosted at TACC, **CC BY 4.0** — which is the same HAND family published as one archive per
 * basin. That is what this fetches. Be precise about the consequence: the package is NOT
 * byte-identical to the committed branch tree, so this fetches and verifies the archive
 * rather than pretending to reproduce a layout it does not have.
 *
 * WHAT MAKES IT SAFE TO RUN UNATTENDED. The 1.9 KB manifest (`<huc8>.txt`, a `unzip -l`
 * listing with a description after each name) is fetched first and parsed before a byte of
 * the archive moves. It carries the row count and every file's uncompressed size, so a
 * truncated download and a changed package are both failures with a name — not a 1.7 GB
 * file that looks fine because it exists. A 200 with no body is a failure, by the same rule
 * as every other adapter in this directory.
 *
 * `--base` exists so the whole path — manifest, download, hash, verify, extract, receipt —
 * can be exercised against a fixture archive in the test suite instead of against 1.7 GB.
 * It is not a way to point the fetcher at a different product.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RAW, ROOT, UA, entry, fetchText, printReceipts, writeReceipt } from "./lib.mjs";

const run = promisify(execFile);

/** TACC's public mirror of the Texas Pin2Flood products. Keyless, HTTP range capable. */
export const DEFAULT_BASE = "https://web.corral.tacc.utexas.edu/nfiedata/pin2flood/texas";

export const VARIANTS = {
  prod: "the standard package: healed HAND, both hydrotables, the crosswalked catchments and flowlines",
  full: "the extras: also the unhealed HAND raster, the catchment RASTER, DEM and flow direction",
};

/** The layers a downstream stage reads. Matched as patterns, not as exact names, because the
 *  `prod` and `full` packages name the same layer differently and a rename must fail loudly. */
export const REQUIRED = [
  { what: "HAND raster", re: /(^|\/)rem_.*\.tif$/i },
  { what: "hydrotable", re: /(^|\/)hydroTable\.csv$/i },
  { what: "catchments", re: /(^|\/)gw_catchments_reaches.*\.(gpkg|tif)$/i },
  { what: "reaches", re: /(^|\/)demDerived_reaches.*\.gpkg$/i },
];

const LICENCE = "CC BY 4.0";
const ATTRIBUTION =
  "NOAA-OWP HAND FIM for HUC {huc8} via the Texas Pin2Flood archive — UT Austin Center for " +
  "Water and the Environment, hosted at TACC";

/* ---- the manifest ---------------------------------------------------------------- */

const ROW = /^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(\S+?)(?:\s+:\s*(.*))?\s*$/;
const TOTAL = /^\s*(\d+)\s+(\d+)\s+files?\s*$/;

/**
 * Parse a `unzip -l`-shaped listing into rows that can be checked against a real archive.
 *
 * Both the Pin2Flood `.txt` manifest and `unzip -l`'s output are the same shape, which is the
 * point: the declaration and the delivery are parsed by one function, so "the download matches
 * the manifest" is a comparison of two of the same thing rather than two parsers that could
 * disagree. The trailing `NNN  N files` line is the row count and the sum, and a listing that
 * disagrees with itself is refused here rather than trusted downstream.
 */
export function parseManifest(text) {
  const archive = text.match(/^Archive:\s+(\S+)/m)?.[1] ?? null;
  const files = [];
  let declared = null;

  for (const line of text.split(/\r?\n/)) {
    const row = line.match(ROW);
    if (row && /\./.test(row[2]) && !row[2].endsWith("/")) {
      files.push({ bytes: Number(row[1]), name: row[2], note: row[3] ?? null });
      continue;
    }
    const total = line.match(TOTAL);
    if (total) declared = { bytes: Number(total[1]), count: Number(total[2]) };
  }

  if (!declared) {
    throw new Error(
      "the listing has no `NNN  N files` trailer, so it cannot say how many files it declares — " +
        "either the format changed or this is not a manifest",
    );
  }
  if (files.length !== declared.count) {
    throw new Error(
      `the manifest declares ${declared.count} files and ${files.length} rows parsed — ` +
        "the row format changed, and a parse that silently loses rows would verify nothing",
    );
  }
  const sum = files.reduce((a, f) => a + f.bytes, 0);
  if (sum !== declared.bytes) {
    throw new Error(
      `the manifest's rows sum to ${sum} bytes and its trailer claims ${declared.bytes} — ` +
        "one of them is wrong, so neither can be used to verify a download",
    );
  }
  return { archive, files, totalBytes: declared.bytes, count: declared.count };
}

export function plan(huc8, variant, base = DEFAULT_BASE) {
  return {
    huc8,
    variant,
    manifestUrl: `${base}/${variant}/${huc8}.txt`,
    zipUrl: `${base}/${variant}/${huc8}.zip`,
  };
}

export function huc8List(spec) {
  const list = [...new Set(String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!list.length) throw new Error("--huc8 is required: one 8-digit HUC, or a comma-separated list");
  for (const h of list) {
    if (!/^\d{8}$/.test(h)) throw new Error(`--huc8=${h} is not a HUC8: expected 8 digits`);
  }
  return list;
}

/* ---- the network ----------------------------------------------------------------- */

async function head(url) {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return {
    status: res.status,
    bytes: Number(res.headers.get("content-length") ?? 0),
    ranges: (res.headers.get("accept-ranges") ?? "").toLowerCase() === "bytes",
  };
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;

/**
 * Stream one archive to disk, resuming a `.part` if the host allows ranges.
 *
 * The hash is taken over the finished file rather than over the chunks, so a resumed download
 * and a fresh one produce the same value — a hash that depends on how the bytes arrived is a
 * hash that cannot be compared to anything.
 */
async function download(url, dest, { resume = true, log = () => {} } = {}) {
  const part = `${dest}.part`;
  let have = 0;
  try {
    have = (await stat(part)).size;
  } catch {
    /* no partial file: a fresh download */
  }

  const headers = { "user-agent": UA };
  if (have && resume) headers.range = `bytes=${have}-`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(45 * 60_000) });
  if (res.status === 416 && have) {
    // The .part is longer than the object: it is not a prefix of this file. Start over.
    have = 0;
    const retry = await fetch(url, { headers: { "user-agent": UA } });
    if (!retry.ok) throw new Error(`HTTP ${retry.status} for ${url}`);
    await pipeline(Readable.fromWeb(retry.body), createWriteStream(part, { flags: "w" }));
  } else {
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const appending = res.status === 206 && have > 0;
    let got = 0;
    const started = Date.now();
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => {
      got += chunk.length;
      log({ got: (appending ? have : 0) + got, at: Date.now() - started });
    });
    await pipeline(body, createWriteStream(part, { flags: appending ? "a" : "w" }));
  }

  const { size } = await stat(part);
  if (!size) throw new Error(`the download of ${url} produced zero bytes — a 200 is not a file`);
  await rename(part, dest);
  return { bytes: size, resumedFrom: have };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/* ---- the checks that make a download a fact -------------------------------------- */

/**
 * Compare the archive on disk with the manifest that was fetched before it.
 *
 * This is the only step that can tell a complete 1.7 GB file from a truncated one, because
 * both are 1.7 GB-ish and both unzip to something. `unzip -l` reports uncompressed sizes, so
 * the comparison is against the manifest's own numbers.
 */
export async function verifyArchive(zipPath, manifest) {
  let listing;
  try {
    listing = (await run("unzip", ["-l", zipPath], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (e) {
    throw new Error(
      `cannot read ${zipPath} as a zip (${e.code === "ENOENT" ? "unzip is not installed" : e.message}) — ` +
        "the archive was not verified, so it is not committed to the receipt",
    );
  }
  const got = parseManifest(listing);
  const byName = new Map(got.files.map((f) => [f.name, f.bytes]));
  const missing = [];
  const wrong = [];
  for (const f of manifest.files) {
    if (!byName.has(f.name)) missing.push(f.name);
    else if (byName.get(f.name) !== f.bytes) wrong.push(`${f.name} (${byName.get(f.name)} ≠ ${f.bytes})`);
  }
  if (missing.length || wrong.length) {
    throw new Error(
      `the archive does not match its manifest: ${missing.length} missing, ${wrong.length} the ` +
        `wrong size${missing.length ? ` — missing ${missing.slice(0, 3).join(", ")}` : ""}` +
        `${wrong.length ? ` — wrong ${wrong.slice(0, 3).join(", ")}` : ""}`,
    );
  }
  return { files: got.files.length, uncompressedBytes: got.totalBytes };
}

async function extract(zipPath, destDir) {
  await mkdir(destDir, { recursive: true });
  await run("unzip", ["-q", "-o", zipPath, "-d", destDir], { maxBuffer: 64 * 1024 * 1024 });
}

export function missingLayers(files) {
  const names = files.map((f) => f.name);
  return REQUIRED.filter((r) => !names.some((n) => r.re.test(n))).map((r) => r.what);
}

/* ---- the receipt ----------------------------------------------------------------- */

const DETAIL_RECEIPT = join(RAW, "hand", "_receipt.json");

function args(argv) {
  const out = {
    huc8: null,
    variant: "prod",
    base: DEFAULT_BASE,
    out: null,
    receipt: DETAIL_RECEIPT,
    dryRun: false,
    manifestOnly: false,
    extract: false,
    yes: false,
    merge: true,
    maxBytes: 2_500_000_000,
    help: false,
  };
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--manifest") out.manifestOnly = true;
    else if (a === "--extract") out.extract = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--no-merge") out.merge = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (k === "--huc8") out.huc8 = v;
    else if (k === "--variant") out.variant = v;
    else if (k === "--base") out.base = v.replace(/\/+$/, "");
    else if (k === "--out") out.out = v;
    else if (k === "--receipt") out.receipt = v;
    else if (k === "--max-bytes") out.maxBytes = Number(v);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const USAGE =
  "usage: node pipeline/ingest/hand.mjs --huc8=<8 digits[,8 digits]> [--variant=prod|full] " +
  "[--extract] [--manifest | --dry-run] [--yes] [--out=<dir>] [--max-bytes=<n>]";

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
  if (!VARIANTS[opts.variant]) {
    console.error(`unknown --variant=${opts.variant}; expected one of ${Object.keys(VARIANTS).join(", ")}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  let huc8s;
  try {
    huc8s = huc8List(opts.huc8);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const outDir = opts.out ?? join(RAW, "hand", "pin2flood", opts.variant);
  const entries = [];

  for (const huc8 of huc8s) {
    const p = plan(huc8, opts.variant, opts.base);
    console.log(`\n== hand ${huc8} (${opts.variant}) — ${VARIANTS[opts.variant]}`);
    console.log(`   manifest ${p.manifestUrl}`);

    if (opts.dryRun) {
      console.log(`   archive  ${p.zipUrl}`);
      continue;
    }

    let manifest;
    try {
      const { body } = await fetchText(p.manifestUrl, { headers: { accept: "text/plain" } });
      manifest = parseManifest(body);
    } catch (e) {
      throw new Error(`${p.manifestUrl}: ${e.message} — refusing to download an archive whose contents cannot be declared first`);
    }
    const layers = missingLayers(manifest.files);
    console.log(
      `   ${manifest.count} files, ${gb(manifest.totalBytes)} uncompressed` +
        ` — ${manifest.files.map((f) => f.name.split("/").pop()).join(", ")}`,
    );
    if (layers.length) {
      throw new Error(`the package is missing the ${layers.join(", ")} layer(s) this pipeline reads`);
    }

    if (opts.manifestOnly) {
      console.log(`   archive  ${p.zipUrl}`);
      continue;
    }

    const probe = await head(p.zipUrl);
    if (!probe.bytes) throw new Error(`${p.zipUrl} answered ${probe.status} with no content-length`);
    if (probe.bytes > opts.maxBytes && !opts.yes) {
      throw new Error(
        `${p.zipUrl} is ${gb(probe.bytes)}, above the ${gb(opts.maxBytes)} ceiling — pass --yes if ` +
          "you meant to pull an archive that size",
      );
    }
    console.log(`   archive  ${gb(probe.bytes)}${probe.ranges ? " (resumable)" : ""}`);

    const zipPath = join(outDir, `${huc8}.zip`);
    await mkdir(outDir, { recursive: true });

    let have = 0;
    try {
      have = (await stat(zipPath)).size;
    } catch {
      /* not fetched yet */
    }
    if (have) {
      console.log(`   ${gb(have)} already on disk — verifying it before fetching anything`);
    } else {
      let last = -1;
      const t0 = Date.now();
      const got = await download(p.zipUrl, zipPath, {
        resume: probe.ranges,
        log: ({ got: n }) => {
          const pct = Math.floor((n / probe.bytes) * 10) * 10;
          if (pct !== last && pct < 100) {
            last = pct;
            const secs = (Date.now() - t0) / 1000;
            const rate = n / secs / 1e6;
            console.log(`   … ${String(pct).padStart(2)}%  ${gb(n)} of ${gb(probe.bytes)}  ${rate.toFixed(1)} MB/s`);
          }
        },
      });
      if (got.bytes !== probe.bytes) {
        throw new Error(
          `${zipPath} is ${got.bytes} bytes and the host declared ${probe.bytes} — a short body ` +
            "from a 200 is the failure this check exists for; re-run to resume",
        );
      }
    }

    const verified = await verifyArchive(zipPath, manifest);
    const digest = await sha256(zipPath);
    console.log(`   verified ${verified.files} files, ${gb(verified.uncompressedBytes)} sha256 ${digest.slice(0, 16)}…`);

    if (opts.extract) {
      const destDir = join(outDir, huc8);
      await extract(zipPath, destDir);
      console.log(`   extracted to ${relative(ROOT, destDir)}/`);
    }

    const record = {
      source: `hand/${huc8}`,
      huc8,
      variant: opts.variant,
      url: p.zipUrl,
      manifest_url: p.manifestUrl,
      fetched_at: new Date().toISOString(),
      http_status: probe.status,
      bytes: probe.bytes,
      sha256: digest,
      rows: manifest.count,
      path: relative(ROOT, zipPath),
      licence: LICENCE,
      attribution: ATTRIBUTION.replace("{huc8}", huc8),
      files: manifest.files.map((f) => ({ name: f.name, bytes: f.bytes })),
      verified: {
        manifest_rows: manifest.count,
        manifest_bytes: manifest.totalBytes,
        layers: REQUIRED.map((r) => r.what),
        extracted: opts.extract,
      },
    };

    let detail = { generated_at: null, archives: {} };
    try {
      detail = JSON.parse(await readFile(opts.receipt, "utf8"));
    } catch {
      /* first fetch recorded at this path */
    }
    detail.archives[`${huc8}/${opts.variant}`] = record;
    detail.generated_at = record.fetched_at;
    await mkdir(dirname(opts.receipt), { recursive: true });
    await writeFile(opts.receipt, `${JSON.stringify(detail, null, 2)}\n`);

    entries.push(
      entry(`hand/${huc8}`, {
        url: p.zipUrl,
        status: probe.status,
        rows: manifest.count,
        saved: { path: relative(ROOT, zipPath), bytes: probe.bytes, sha256: digest.slice(0, 16) },
        note: `${opts.variant}, ${gb(probe.bytes)}, ${LICENCE} — ${ATTRIBUTION.replace("{huc8}", huc8)}`,
      }),
    );
  }

  if (opts.dryRun) {
    console.log("\n   dry run: nothing fetched, no receipt written");
    return;
  }
  if (opts.manifestOnly) {
    console.log("\n   manifest only: nothing downloaded, no receipt written");
    return;
  }

  if (entries.length) {
    console.log("\n== receipts");
    printReceipts(entries);
    if (opts.merge) await writeReceipt(entries);
    else console.log(`   --no-merge: data/raw/_receipt.json untouched (detail: ${relative(ROOT, opts.receipt)})`);
  }
}

/* Run only when invoked as a command. The suite imports `parseManifest` to check the parser
 * against a real manifest; a module that downloads 1.7 GB on import cannot be tested. */
const invoked = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invoked) {
  main().catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  });
}
