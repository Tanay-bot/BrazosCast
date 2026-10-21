/**
 * BrazosCast ingestion — the shared half.
 *
 * Every adapter that talks to a public host goes through this file, so the rules that
 * protect the app from a quiet failure live in one place rather than four:
 *
 *   * a 200 with zero rows is a FAILURE, not a success. An empty series is the shape a
 *     broken upstream takes, and it is indistinguishable from a dry river downstream.
 *   * a receipt is written for every request: url, status, bytes, rows, sha256. That is
 *     what makes "the number moved because the source changed" a claim that can be checked
 *     instead of argued about.
 *   * retries are bounded and spaced, so a 429 from a public service is respected rather
 *     than hammered. USGS documents 50 requests/hour per IP unauthenticated (1,000 with a
 *     key), and NWPS publishes no number at all — which is a reason to be careful, not a
 *     licence to be fast.
 *
 * No dependencies. Node >= 18 (global fetch, AbortSignal.timeout).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RAW = join(ROOT, "data", "raw");
export const RECEIPT_PATH = join(RAW, "_receipt.json");

/** A version string in the UA is the courtesy both services' docs ask for; a bare `curl`
 *  from a script is what gets a shared IP blocked. */
export const UA = "BrazosCast/0.1 (flood lead-time app; +https://brazos-cast.vercel.app)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch text with bounded retries.
 *
 * 429 and 5xx are retried with exponential backoff; a 4xx other than 429 is permanent —
 * retrying a 404 three times does not make the resource exist, and it hides the real error
 * behind a delay. `Retry-After` is honoured when the host sends one.
 */
export async function fetchText(url, { retries = 3, timeoutMs = 25_000, headers = {} } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", "user-agent": UA, ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true, wait });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { permanent: true });
      }
      return { body: await res.text(), status: res.status, url };
    } catch (e) {
      last = e;
      if (e.permanent || attempt === retries) break;
      await sleep(e.wait ?? 500 * 2 ** attempt);
    }
  }
  throw last;
}

export async function fetchJson(url, opts) {
  const { body, status } = await fetchText(url, opts);
  try {
    return { json: JSON.parse(body), status, bytes: Buffer.byteLength(body) };
  } catch {
    throw new Error(`not JSON: ${url} returned ${body.slice(0, 80).replace(/\s+/g, " ")}…`);
  }
}

/** Write a cache file and return what the receipt needs to describe it. */
export async function saveRaw(relPath, data) {
  const full = join(RAW, relPath);
  await mkdir(dirname(full), { recursive: true });
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await writeFile(full, text);
  return {
    path: `data/raw/${relPath}`,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

/** One source's outcome. `rows` is required: a source that cannot say how many records it
 *  produced has not proved it produced any. */
export function entry(source, { url, status = 200, rows, saved, note }) {
  if (!Number.isInteger(rows)) {
    throw new Error(`receipt for ${source} has no integer row count (${rows})`);
  }
  return { source, url, status, rows, ...saved, ...(note ? { note } : {}), fetched_at: new Date().toISOString() };
}

export async function readReceipt() {
  try {
    return JSON.parse(await readFile(RECEIPT_PATH, "utf8"));
  } catch {
    return { generated_at: null, sources: {} };
  }
}

/**
 * Merge this run's entries into data/raw/_receipt.json.
 *
 * Merged, not replaced, and that is deliberate: `refresh --source usgs_ogc` must not erase
 * the NWPS receipts and leave the file claiming those sources were never fetched. Each
 * source keeps its own `fetched_at`, so staleness is per-source and the app can say which
 * one is old.
 */
export async function writeReceipt(entries) {
  const current = await readReceipt();
  const sources = { ...current.sources };
  for (const e of entries) sources[e.source] = e;
  const out = { generated_at: new Date().toISOString(), sources };
  await saveRaw("_receipt.json", out);
  return out;
}

/** A UTC window ending now, as the ISO strings both USGS and CWMS accept. */
export function window(days) {
  const end = new Date();
  const begin = new Date(end.getTime() - days * 86_400_000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { begin: iso(begin), end: iso(end) };
}

/** Print a table of receipts without pretending a failed source is a row. */
export function printReceipts(entries) {
  const name = Math.max(...entries.map((e) => e.source.length), 12);
  console.log(`   ${"source".padEnd(name)}  rows  bytes     sha`);
  for (const e of entries) {
    console.log(
      `   ${e.source.padEnd(name)}  ${String(e.rows).padStart(4)}  ${String(e.bytes ?? "-").padStart(7)}  ${e.sha256 ?? "-"}`,
    );
  }
}
