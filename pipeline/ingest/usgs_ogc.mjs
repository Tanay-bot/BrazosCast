/**
 * USGS — continuous stage and discharge, on the API that survives 2027.
 *
 * The repo's older fetcher uses `waterservices.usgs.gov/nwis/iv`, which USGS retires in
 * Q1 2027. Building more on it would be building a known expiry date into the pipeline, so
 * this adapter uses the OGC API (`api.waterdata.usgs.gov/ogcapi/v1`) instead.
 *
 * Auth: none required. USGS documents **50 requests/hour per IP** unauthenticated and
 * **1,000 with an api_key**, so `USGS_API_KEY` is honoured when present and the chained
 * plan below stays under 50: seven sites x two parameters is fourteen requests.
 *
 * `datetime` accepts an ISO interval here, not the `PT24H` duration that the older
 * services accepted — measured, not assumed: `datetime=PT2H` is rejected with
 * "Unknown string format". A 7-day window at an hourly step is also the window the models
 * and the staleness regimes are written against.
 */
import { GAUGE_CHAIN } from "../fetch/fetch.mjs";
import { entry, fetchJson, saveRaw, window as isoWindow } from "./lib.mjs";

const ITEMS = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items";

/** 00065 gage height, 00060 discharge. Named rather than inlined because the app's own
 *  parsing and the pipeline's cross-checks both refer to these codes. */
export const PARAMS = { stage: "00065", discharge: "00060" };

export const NAME = "usgs_ogc";

export function itemUrl(site, code, begin, end) {
  const q = new URLSearchParams({
    f: "json",
    monitoring_location_id: `USGS-${site}`,
    parameter_code: code,
    datetime: `${begin}/${end}`,
    limit: "10000",
  });
  return `${ITEMS}?${q}`;
}

export async function run({ dryRun = false, days = 7 } = {}) {
  const { begin, end } = isoWindow(days);
  const headers = process.env.USGS_API_KEY ? { "x-api-key": process.env.USGS_API_KEY } : {};
  const entries = [];
  const failures = [];

  for (const g of GAUGE_CHAIN) {
    const plan = Object.entries(PARAMS).map(([key, code]) => ({ key, code, url: itemUrl(g.usgs, code, begin, end) }));
    if (dryRun) {
      for (const p of plan) console.log(`   would fetch ${p.url}`);
      continue;
    }
    try {
      const series = {};
      for (const p of plan) {
        const { json } = await fetchJson(p.url, { headers });
        const features = json?.features ?? [];
        series[p.key] = features.map((f) => ({
          t: f.properties.time,
          v: Number(f.properties.value),
          unit: f.properties.unit_of_measure,
          approval: f.properties.approval_status,
        })).filter((r) => Number.isFinite(r.v));
      }
      /* Stage is required; discharge is not. Some gages in the chain are stage-only, and a
       * missing discharge there is a property of the site, not a broken fetch — but a
       * missing stage is the failure this adapter exists to catch. */
      if (series.stage.length === 0) throw new Error(`${g.usgs}: no stage rows in ${begin}…${end}`);
      const saved = await saveRaw(`usgs/ogc/${g.usgs}.json`, {
        site: g.usgs, lid: g.lid, name: g.name, window: { begin, end }, ...series,
      });
      entries.push(entry(`usgs_ogc/${g.usgs}`, {
        url: plan[0].url, saved, rows: series.stage.length + series.discharge.length,
        note: `${series.stage.length} stage + ${series.discharge.length} discharge, ${begin}…${end}`,
      }));
    } catch (e) {
      failures.push(`${g.usgs}: ${e.message}`);
    }
  }

  if (failures.length) throw Object.assign(new Error(failures.join("; ")), { entries });
  return { entries };
}
