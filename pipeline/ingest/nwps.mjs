/**
 * NWPS — the gauge chain's observed and forecast stage.
 *
 * `api.water.noaa.gov/nwps/v1` is unauthenticated and publishes no rate limit. The one
 * request per gauge that the app itself makes at runtime is the same request this caches,
 * which is the point: what the app shows live is what the adapter records, so a disagreement
 * is a real disagreement rather than two different endpoints.
 *
 * The gauge list is imported from pipeline/fetch/fetch.mjs rather than repeated. It is the
 * same seven gauges the models train on and the routing graph is anchored to; a second copy
 * would be a drift waiting to happen.
 */
import { GAUGE_CHAIN } from "../fetch/fetch.mjs";
import { entry, fetchJson, saveRaw } from "./lib.mjs";

const HOST = "https://api.water.noaa.gov/nwps/v1/gauges";

export const NAME = "nwps";

export const urls = () => GAUGE_CHAIN.map((g) => ({ lid: g.lid, url: `${HOST}/${g.lid}/stageflow` }));

export async function run({ dryRun = false } = {}) {
  const plan = urls();
  if (dryRun) {
    for (const p of plan) console.log(`   would fetch ${p.url}`);
    return { entries: [] };
  }

  const entries = [];
  const failures = [];
  for (const { lid, url } of plan) {
    try {
      const { json } = await fetchJson(url);
      const observed = json?.observed?.data ?? [];
      const forecast = json?.forecast?.data ?? [];
      const rows = observed.length + forecast.length;
      /* Empty is a failure. A gauge with no observed record is either broken or upstream of
       * the sensor, and caching it would make the app's "no reading" path look like weather. */
      if (rows === 0) throw new Error(`${lid}: 200 with no observations and no forecast`);
      const saved = await saveRaw(`nwps/${lid}_stageflow.json`, json);
      entries.push(entry(`nwps/${lid}`, {
        url, rows, saved,
        note: `${observed.length} observed + ${forecast.length} forecast`,
      }));
    } catch (e) {
      failures.push(`${lid}: ${e.message}`);
    }
  }
  if (failures.length) throw Object.assign(new Error(failures.join("; ")), { entries });
  return { entries };
}

export async function check({ entries }) {
  const missing = GAUGE_CHAIN.map((g) => g.lid).filter((lid) => !entries.some((e) => e.source === `nwps/${lid}`));
  if (missing.length) throw new Error(`no NWPS series for ${missing.join(", ")}`);
}
