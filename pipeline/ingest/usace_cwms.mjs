/**
 * USACE — the Brazos reservoirs that move the Richmond stage.
 *
 * The CWMS Data API (`cwms-data.usace.army.mil/cwms-data`) is public for low-risk data and
 * needs no credentials. Two things were measured rather than assumed:
 *
 *   1. `/projects?office=SWF` answers 200 and lists every project with its location id and
 *      the USGS number in `long-name`. That is the inventory, and it is what this caches.
 *   2. `/timeseries` and `/timeseries/profile/{location}/{param}` do **not** expose pool
 *      elevation for these projects (`ORA-20998: No such base parameter` for `Elev`, and
 *      `ORA-20034: Time series profile "SWF/ACTT2/Elev" does not exist`). So the level series
 *      comes from USGS `62614` (lake surface elevation, ft) at each project's own USGS
 *      number, which is published and is the same water surface the dam is operated to.
 *
 * The gap is stated in every receipt rather than hidden: USACE for the project inventory,
 * USGS for the elevation. If CDA opens those profiles later, the `pool` fetch below is the
 * one function to change.
 *
 * **Basin assertion, and why the list is explicit.** Addicks and Barker are San Jacinto
 * basin, not Brazos, and they are 40 km from this corridor — exactly the kind of neighbour a
 * future contributor adds because it is nearby. So the Brazos projects are an allow-list and
 * every one must appear in the CDA inventory with a USGS number matching this table. A
 * project that silently disappeared upstream fails the run rather than quietly dropping out.
 */
import { itemUrl } from "./usgs_ogc.mjs";
import { entry, fetchJson, saveRaw, window as isoWindow } from "./lib.mjs";

const CDA = "https://cwms-data.usace.army.mil/cwms-data";
export const OFFICE = "SWF";

export const NAME = "usace_cwms";

/** Brazos basin, in river order. `cda` is the CWMS location id from /projects. */
export const BRAZOS_PROJECTS = [
  { cda: "GGLT2", name: "Lake Georgetown", usgs: "08104650" },
  /* CDA's project location for Granger is the downstream San Gabriel station (08105700, a
   * stream site with no lake elevation). The lake surface is 08105600 — measured: 62614 at
   * 08105700 returns 0 rows, at 08105600 it returns 503.96 ft. Hence the override. */
  { cda: "GNGT2", name: "Granger Lake", usgs: "08105700", poolUsgs: "08105600" },
  { cda: "BLNT2", name: "Belton Lake", usgs: "08102000" },
  { cda: "STIT2", name: "Stillhouse Hollow Lake", usgs: "08104050" },
  { cda: "WTYT2", name: "Whitney Lake", usgs: "08092500" },
  { cda: "ACTT2", name: "Waco Lake", usgs: "08095550" },
  { cda: "SOMT2", name: "Somerville Lake", usgs: "08109900" },
];

/** Lake surface elevation above NGVD 1929, in feet. */
const POOL_PARAM = "62614";

export const urls = () => {
  const { begin, end } = isoWindow(1);
  return [
    `${CDA}/projects?office=${OFFICE}`,
    ...BRAZOS_PROJECTS.map((p) => itemUrl(p.usgs, POOL_PARAM, begin, end)),
  ];
};

export async function run({ dryRun = false, days = 7 } = {}) {
  if (dryRun) {
    for (const u of urls()) console.log(`   would fetch ${u}`);
    return { entries: [] };
  }
  const { begin, end } = isoWindow(days);

  const inventory = await fetchJson(`${CDA}/projects?office=${OFFICE}`);
  const projects = inventory.json?.projects ?? [];
  if (projects.length === 0) throw new Error("CDA /projects answered 200 with no projects");

  const entries = [];
  const failures = [];

  for (const p of BRAZOS_PROJECTS) {
    const found = projects.find((x) => x.location?.name === p.cda);
    if (!found) {
      failures.push(`${p.cda}: absent from the SWF project inventory — the allow-list and CDA disagree`);
      continue;
    }
    const longName = found.location["long-name"] ?? "";
    if (!longName.includes(p.usgs)) {
      failures.push(`${p.cda}: CDA says ${JSON.stringify(longName)}, which does not carry USGS ${p.usgs}`);
      continue;
    }
    const poolSite = p.poolUsgs ?? p.usgs;
    try {
      const { json } = await fetchJson(itemUrl(poolSite, POOL_PARAM, begin, end));
      const pool = (json?.features ?? []).map((f) => ({
        t: f.properties.time, v: Number(f.properties.value), unit: f.properties.unit_of_measure,
      })).filter((r) => Number.isFinite(r.v));
      if (pool.length === 0) throw new Error(`no pool elevation rows for USGS ${poolSite}`);
      const saved = await saveRaw(`usace/${p.cda}.json`, {
        project: {
          cda: p.cda, office: OFFICE, name: found.location["public-name"] ?? p.name,
          long_name: longName, usgs: p.usgs, pool_usgs: poolSite, basin: "Brazos",
        },
        parameter: { code: POOL_PARAM, what: "lake surface elevation above NGVD 1929", unit: "ft" },
        source: { inventory: `${CDA}/projects?office=${OFFICE}`, series: "USGS OGC continuous 62614" },
        window: { begin, end },
        pool,
      });
      entries.push(entry(`usace_cwms/${p.cda}`, {
        url: itemUrl(poolSite, POOL_PARAM, begin, end), saved, rows: pool.length,
        note: `CDA inventory + USGS ${POOL_PARAM}; CDA exposes no Elev profile for this project`,
      }));
    } catch (e) {
      failures.push(`${p.cda}: ${e.message}`);
    }
  }

  if (failures.length) throw Object.assign(new Error(failures.join("; ")), { entries });
  return { entries };
}
