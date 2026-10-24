# BrazosCast data sources — verified ledger

All endpoints below were probed **live and unauthenticated on 2026-10-13/14** from this machine.
Status is what actually came back, not what a doc claims. Re-run `node pipeline/fetch/fetch.mjs`
to refresh `data/raw/` and rewrite `data/raw/manifest.json`.

| Source | Endpoint used | Auth | Status | Notes |
|---|---|---|---|---|
| NOAA NWPS gauge | `https://api.water.noaa.gov/nwps/v1/gauges/{LID}` | none | ✅ 200 | Flood categories, datums, observed/forecast series, impact statements. |
| NWS riv_gauges (bulk) | `mapservices.weather.noaa.gov/.../water/riv_gauges/MapServer/0/query` | none | ✅ 200 | `waterbody like 'Brazos%'` → **20 TX Brazos gauges** w/ thresholds in one call. |
| USGS Water Services (new) | `https://api.waterdata.usgs.gov/ogcapi/v0/...` | none | ✅ 200 | Build against this; the legacy host retires **2027-02-22**. |
| USGS legacy (temporary) | `https://waterservices.usgs.gov/nwis/iv/` | none | ✅ 200 | Intentional slowdowns begin Jan 2027. Fine for one-off historical pulls now. |
| **OpenFEMA NFIP claims v3** | `https://www.fema.gov/api/open/v3/NfipClaims` | none | ✅ 200 | **7,389 Fort Bend claims cached.** See corrections below. |
| OpenFEMA v2 (deprecated) | `.../api/open/v2/FimaNfipClaims` | none | ⚠️ 200 | Removed **2026-10-15**; data frozen since 2026-06-01. Do not build on it. |
| Fort Bend County GIS | `gisweb.fortbendcountytx.gov/arcgis/rest/services` | none | ❌ **522** | Origin down on every retry. Blocks the county FEMA-zone FeatureServer. |
| **FEMA NFHL (national)** | `hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer` | none | ✅ 200 | Point query at Richmond → `FLD_ZONE AE, ZONE_SUBTY FLOODWAY`. Layer **28 = Flood Hazard Zones**. |
| FBCAD open data hub | `fbcad-open-data-hub-fortbend.hub.arcgis.com` | none | ✅ 200 | Parcels via ArcGIS Hub (`?f=geojson`). Its DCAT catalog lists **26 datasets and no address-point layer**; the parcels are ZIP-only (no queryable service). |
| **FBCAD road centerlines (the address index)** | `services2.arcgis.com/D4saGHECICkCeoJm/arcgis/rest/services/Roads_view/FeatureServer/0` | none | ✅ **200, CORS `*`** | **The address source.** Every segment carries TIGER-style address ranges — `LF_ADDR`/`LT_ADDR` (left), `RF_ADDR`/`RT_ADDR` (right) — plus `RD_PRE`/`RD_NAME`/`RD_TYPE`/`FULL_NAME`/`ALIAS` and the polyline. `access-control-allow-origin: *` verified, so it is browser-callable, but it is **cached and shipped offline** so the app answers with no network. Probed 2026-10-15: **37,866** segments intersect the padded corridor bbox, **24,005** carry a usable range, **9,962** distinct street names; `maxRecordCount` 2000, pagination supported (order by `FID` — paging without a stable order duplicates and drops rows). Cached by `pipeline/fetch/fetch_fbcad_roads.mjs` → `data/raw/fbcad_roads.json` (2.5 MB, geometry reduced to segment endpoints). **Powering the app's address box via `pipeline/derive/address_index.py`.** |
| **US Census Geocoder** | `geocoding.geo.census.gov/geocoder/**` | none | ❌ **unusable** | **Rejected by measurement, not preference.** No `Access-Control-Allow-Origin` on two tested origins, so a browser cannot call it at all; and `Public_AR_Current` / `ACS2026` / `Census2020` / `LUCA` all return **0 matches** for Richmond, TX addresses while matching Washington DC, Austin and Houston. This is the source `docs/PLAN.md` §5 originally recommended; that recommendation is now corrected. **Scope of the coverage result:** it is bounded by the queries run and cannot separate "no county coverage" from "that house number is not in the file" — the CORS finding is the unambiguous part. |
| **USGS Harvey inundation (Brazos, upper reach)** | `sciencebase.gov/catalog/file/get/5aa02374e4b0b1c392e68400` | none | ✅ 200 | **Validation layer.** Item of data release doi:**10.5066/F7VH5N3N** (SIR 2018-5070). `pipeline/fetch/fetch_harvey_inundation.mjs` caches the 2 MB `Brazos_upper.zip` + readme to `data/raw/harvey/` with a receipt. Three layers, **EPSG:6579**: mapped inundation extent (`brazos_upper_final`, 576 km², **not OGC-valid as shipped**), mapped area boundary (948 km², the evaluated-set definition), 44 surveyed high-water marks with NAVD88 water-surface elevations (35 on the Brazos main stem). USGS public domain (CC0). **Nature, and it bounds every conclusion drawn from it:** the extent is a water surface *interpolated between the surveyed high-water marks* and clipped to the boundary — a survey-anchored estimate, **not satellite-observed water edges**, and one maximum extent rather than a time series. The 377 MB `Depth_Brazos_upper.zip` is deliberately **not** fetched (no raster is needed to intersect polygons, and it would dwarf `data/raw/`). Used by `pipeline/derive/harvey_validation.py`; see [FINDINGS.md](./FINDINGS.md) §11. The same cached gauge record is replayed hourly by `pipeline/derive/backcast.py` to produce the lead time the app would have given in 2017 (§13). |
| **OpenStreetMap (Overpass)** | `overpass-api.de/api/interpreter` | none | ⚠️ **only light queries** | Routing destinations: 59 hospitals / fire / police stations cached to `data/raw/osm_facilities.json` by `pipeline/fetch/fetch_facilities.mjs`. **Node-only queries over this box return in ~2 s; the same query with `way` added returns 502/504 on every endpoint tried.** Mirrors `overpass.kumi.systems`, `maps.mail.ru/osm/tools/overpass` refused or timed out. A missing User-Agent is refused. Data © OpenStreetMap contributors, **ODbL** — attribution is in the app footer and each cached record keeps its raw tags. |

## Corrections to the plan/spec (important)

1. **OpenFEMA v3 entity is renamed again.** The spec guessed `FimaNfipClaims` at `/v3` → **404**.
   FEMA's own metadata (`depNewUrl`) points to the *NFIP Redacted Claims v3* page, whose real
   **API Endpoint is `https://www.fema.gov/api/open/v3/NfipClaims`** — the `Fima` prefix was dropped,
   and the entity is **`NfipClaims`**, not `NFIPRedactedClaims`. Verified: 200.
2. **v3 schema renames.** `censusTract` + `censusBlockGroupFips` are gone → single **`censusGeoid`**.
   Selecting the old names returns `OF_OQP_003` HTTP 400. 84 fields total.
3. **Fort Bend County GIS is down.** Use **FEMA NFHL** (already the spec's fallback floor) for flood
   zones. Note the county FeatureServer, when it returns, is richer (local parcels) — keep it as an
   optional upgrade, not a dependency.

## Raw inputs — what is tracked, and why

The rule, as `.gitignore` states it:

> The unit of decision is the tree or file a rule covers, because that is the unit a command
> re-creates and the unit someone has to download. A raw input is **committed** when that unit is
> small **and** one of: a receipt or manifest of what was fetched; a stable historical record a
> published number descends from; or a snapshot of a live product the artifacts were derived from —
> re-fetching a live product returns *different* data, so the artifacts would stop being derivable
> from the cache. It is **ignored** when that unit is bulk and one committed command re-creates it.
> Exceptions are file-sized units carved out of a bulk tree.

Naming the unit is what makes the rule and its application agree rather than nearly agree: the USGS
receipt (`usgs/_summary.json`, 4 KB) is ignored **with the tree it describes**, because it is worth
nothing in the repo while the 46 MB it accounts for is excluded and the one command restores both;
and `usgs/iv/08114000_20170822.json` is committed although it sits inside that same tree, because
it is a single closed event record and not a cache bulk.

That rule is not a tidying preference; it is what decides whether the shipped numbers can be
checked by anyone who clones the repo. So every rule in the raw-inputs section of `.gitignore`
carries the command that re-creates what it ignores, and a rule with nothing above it is a
half-made decision that `pipeline/tests/test_raw_input_policy.py` refuses.

**Committed — 13.7 MB across 20 files.** Everything the app fetches, plus the inputs a shipped
artifact descends from:

| path | size | why it is committed |
|---|---|---|
| `manifest.json`, `harvey/_receipt.json` | 12 KB | the receipts. They record what was fetched and with which counts, and `test_source_integrity.py` holds the caches to them. |
| `harvey/Brazos_upper.zip` | 2.0 MB | the observed Harvey extent, and the only copy of it (see I1). A re-fetch is a different request to a different host, not a re-computation. |
| `usfimr/05302016_Brazos_River_at_Richmond_TX.zip`, `usfimr/_receipt.json` | 4.7 MB | **the second observed extent** — the Sentinel-1 water edge `second_event_validation.py` refutes thresholds against, and the only copy of it, on the same argument as the Harvey extent above. It is a fixed release file of a closed 2016 event on a university host, so it is neither re-computable nor guaranteed re-fetchable. |
| `usgs/iv/08114000_20170822.json` | 493 KB | **the 2017 interval record.** The only input to `backcast.py`, `ensemble.py` and `harvey_validation.py`, and the series the app replays. A closed historical event, so it can never be re-fetched to the same value. |
| `fbcad_roads.json` | 2.8 MB | **the FBCAD road centerlines with TIGER address ranges.** The sole input to `address_index.py`, whose output ships inside the app — so it is the provenance of the address box, not an optional cache. |
| `nwps/*.json`, `nws/riv_gauges_brazos.json` | 0.6 MB | snapshots of live products. A re-fetch returns the *current* forecast, which is not what any shipped figure was computed from. |
| `openfema/nfip_claims_48157_v3.json` | 2.8 MB | the premise measurement (4,895 of 7,389 claims rated in an X zone). Same argument as the NWPS files — and the v2 entity it would otherwise be re-fetched from was withdrawn 2026-10-15. |
| `osm_facilities.json` | 24 KB | routing destinations; Overpass answers `502` often enough that a re-fetch is a gamble, not a fallback. |

**Ignored — 162 MB, each re-created by one committed command:**

| path | size | re-created by |
|---|---|---|
| `hand/` | 66 MB / 14 files | `node pipeline/ingest/hand.mjs --huc8=12070104 --extract` — **with a caveat that is the whole point of this row**: what that fetches is the keyless Texas Pin2Flood HUC8 package (1.7 GB zipped, 2.08 GB unpacked, **CC BY 4.0**, hosted at TACC), and what is committed is NOAA-OWP HAND v2's per-BRANCH layout for the same HUC, branch 3125000011. They are the same HAND family in two packagings, so the command reproduces the *product* and the licence, not the bytes; NOAA's own bucket (`s3://noaa-nws-owp-fim`) needs ESIP credentials and answers 403 without them. Read by `road_thresholds.py`, `hand_unit_resolution.py` and `inundation.py`; the last two read the 40 MB REM raster, its catchment raster and the branch hydrotable, and refuse to run without them. The fetcher writes `data/raw/hand/_receipt.json` (licence, manifest rows, sha256) and merges the same record into `data/raw/_receipt.json` unless given `--no-merge`. |
| `usgs/*.json` | 46 MB / 15 files | `node pipeline/fetch/fetch_usgs_history.mjs 1985` |
| `usgs/iv/*.json` | 50 MB / 124 files | `python pipeline/analyze/travel_time_subdaily.py` |

**What a fresh clone can actually run — measured, not assumed.** The clone content was
materialised — every tracked file that exists on disk plus every file that is to be committed,
**136 files / 19 MB** (re-measured when I1 added `data/raw/usfimr/`) — and each suite run against
it:

| the clone has | what happens |
|---|---|
| nothing further | the golden regression fails on **three** stages: `road_thresholds.py`, for the missing `data/raw/hand/12070104/osm_roads_fimpact.csv`; `gauge_redundancy.py`, which dies as `KeyError: ['HPDT2']` — an illegible symptom of a missing `data/raw/usgs/*_daily.json`, naming neither the file nor the fetch command; and `second_event_validation.py`, for the missing `data/raw/usgs/iv/08114000_20160524.json`. The fast suite fails three tests: `test_source_integrity.py` (`missing artifact …/usgs/_summary.json`), `test_grid_parity.py` (no `app/node_modules`), and `test_second_event.py`, whose message names the file and the command that re-creates it. |
| the USGS daily/peak caches (`node pipeline/fetch/fetch_usgs_history.mjs 1985`) and `app/node_modules` | **one** failure left: `test_second_event.py`. The 2016 event's 15-minute series is a cached event, not a history fetch, so the stage that comparison is scored at cannot be re-derived yet. |
| also the event caches (`python pipeline/analyze/travel_time_subdaily.py 24`) | the fast suite passes — **82 passed, 2 skipped**. The skips are `test_raw_input_policy.py`'s two `git check-ignore` tests, which skip outside a git checkout by design. |
| also the HAND archive | the golden regression passes, reproducing all **13** artifacts (the XGBoost benchmark is one of them since NEXT-PLAN § 4.1). |

**What the HAND archive is, and is not.** Four of its files are load-bearing and nothing else in
the tree can stand in for them: `rem_zeroed_masked_<branch>.tif` (height above nearest drainage,
10 m), `gw_catchments_reaches_filtered_addedAttributes_<branch>.tif` (which reach each cell
belongs to), `hydroTable_<branch>.csv` (the synthetic rating curve per reach — stage, discharge,
wetted cells) and the NWM stream/catchment subsets. The REM's unit is not documented anywhere in
the archive, which is why it is a measurement in the pipeline (FINDINGS § 8a) and not a constant:
`hand_unit_resolution.py` compares both candidate readings against the hydrotable's own cell
counts and against the 2016 USFIMR water edge before anything downstream may read the raster.

So the bootstrap is two commands, one HUC8 package, and one install, and nothing else is missing in
between. That is the trade the criterion makes deliberately: 162 MB is not going into git to make a
test feel self-contained.

The raw inputs the policy commits that a `git status` still shows as untracked are exactly four —
`git ls-files --others --exclude-standard -- data/raw` lists `usgs/iv/08114000_20170822.json`,
`fbcad_roads.json`, `usfimr/05302016_Brazos_River_at_Richmond_TX.zip` and `usfimr/_receipt.json`,
and nothing else. The first two have a rule in `.gitignore` because they sit inside an excluded
tree; the two USFIMR files are outside every excluded tree, so they need no rule — but a new raw
input that is neither tracked nor ignored is the half-made decision this whole section refuses, and
that is what `fetch_usfimr_2016.mjs` creates when it runs.

**Why this section exists — two inputs were in the wrong class, and an audit found them.** Both
were found by reading every rule against what actually reads the file, not by a hunch:

1. **The 2017 interval record was ignored.** `data/raw/usgs/` was excluded wholesale, and the
   hydrograph the 2017 backcast replays sits inside it — so a clone could not re-derive the
   backcast or the ensemble, and `test_source_integrity.py` (which asserts that record is
   present, precisely because the backcast has no other source) could not pass. It is now
   committed through a negation rule, which is fragile in a specific way: broadening the rule
   above it back to the directory form silently re-ignores it. `test_raw_input_policy.py` holds it.
2. **`fbcad_roads.json` was neither tracked nor ignored.** It showed up as `??` on every
   `git status`, which is how a 2.8 MB file that a shipped feature depends on stays undecided.
   It is now declared committed.

Unrelated but found while measuring: the `.gitignore` rule `data/raw/*.tmp` guarded a pattern that
**nothing in the repo writes** (the only reference to `.tmp` anywhere is that line itself), so it
was dropped rather than left looking like it protected something.

**Not a raw-input problem, but it shows up in the same measurement:** the fast suite also needs
`app/node_modules`. Without it `test_grid_parity.py` fails inside `npx vitest run` with
`ERR_MODULE_NOT_FOUND` rather than taking its own `vitest is not installed — run \`cd app && npm
install\`` skip path, because that path tests for the presence of `npx` and not for a resolvable
`vitest`. Left as it is: a loud failure is what the suite wants when the cross-language claim
goes unchecked, and the README already requires `npm install`.

## The ingestion layer (`pipeline/ingest/`)

One command refreshes every public source, and the exit code is the contract: **non-zero if
any source failed**, with the source named. Receipts merge into `data/raw/_receipt.json`
(`{source, url, status, rows, bytes, sha256, fetched_at}` per request) so a single-source run
cannot erase what the others last fetched.

```bash
node pipeline/ingest/refresh.mjs                    # nwps + usgs_ogc + usace
node pipeline/ingest/refresh.mjs --source=nwps      # one source
node pipeline/ingest/refresh.mjs --dry-run          # print the requests, fetch nothing
```

| adapter | host | auth | what is cached |
|---|---|---|---|
| `nwps.mjs` | `api.water.noaa.gov/nwps/v1` | none, no published limit | stageflow (observed + forecast) for the 7-gauge chain → `data/raw/nwps/` |
| `usgs_ogc.mjs` | `api.waterdata.usgs.gov/ogcapi/v1` | none; **50 req/hour per IP**, `USGS_API_KEY` raises it to 1,000 | 7 days of `00065` stage + `00060` discharge → `data/raw/usgs/ogc/` |
| `usace_cwms.mjs` | `cwms-data.usace.army.mil/cwms-data` | none for low-risk public data | the SWF project inventory for the 7 Brazos reservoirs, plus pool elevation → `data/raw/usace/` |

**Two measured facts that shaped the USACE adapter, both recorded because they are not
what the documentation implies:**

1. `/projects?office=SWF` answers 200 and carries every project's USGS number in `long-name`
   — that is the inventory, and it is asserted against an explicit Brazos allow-list
   (`GGLT2, GNGT2, BLNT2, STIT2, WTYT2, ACTT2, SOMT2`). Addicks and Barker are **San Jacinto**
   basin and are deliberately absent; `test_ingest_contract.py` refuses their ids.
2. The CDA time-series endpoints do **not** expose pool elevation for these projects:
   `ORA-20998: No such base parameter` for `Elev`/`Stor`, and
   `ORA-20034: Time series profile "SWF/ACTT2/Elev" does not exist`. So the level series
   comes from USGS `62614` (lake surface elevation, ft) at each project's own USGS number,
   and every receipt says so. Granger is the one override: CDA's project location is the
   downstream stream station `08105700` (0 rows of 62614), while the lake surface is
   `08105600` (503.96 ft when measured).

**One warning that cost a measurement:** `data/raw/nwps/{HPDT2,BAWT2}_stageflow.json` are
committed because they are the redundancy gauges `gauge_redundancy.py` fits its transfer on,
so `--source=nwps` rewrites a **derivation input** and the artifacts must be re-derived in the
same breath (`gauge_redundancy.py` → `app_data.py`). The fetches here were run to prove the
adapters work, and the two committed caches were restored afterwards so the working tree's
data and the committed artifacts stay consistent.

**Not migrated yet:** `pipeline/fetch/fetch_usgs_history.mjs` still calls the legacy
`waterservices.usgs.gov` API, which USGS retires in **Q1 2027**. The ingest contract test is
scoped to `pipeline/ingest/` so it does not fail for a file that predates the migration; the
migration itself is listed in [NEXT-PLAN.md](./NEXT-PLAN.md).

## The premise, measured (from the cached claims)

From `data/raw/openfema/nfip_claims_48157_v3.json` (7,389 claims, 1978-05 → 2026-06):

- **4,895 claims (66.2%)** were rated in an **X zone** — outside the mapped 100-year floodplain.
- Those X-zone claims account for **$231.3M of $343.8M (67.3%)** of building payments.
- **Aug–Sep 2017 (Harvey): 2,920 of 3,959 claims (73.8%)** were X-zone.
- Top `floodEvent` codes: Hurricane Harvey (3,928), Flooding (506), early-summer severe storms (448).

This is the single best justification chart for the app: *the county's floodplain map did not warn
the two-thirds of residents who actually claimed.* Reproduce with `pipeline` once we add the
analysis step.

## The observed-flooding layer, and what it turned out to be

The Harvey extent above was fetched to close the one open QC item left in `FINDINGS.md` §5 —
*"validate thresholds against the USGS Harvey observed-inundation layer before shipping"* — after
the route through OpenFEMA claim points was closed by their 0.1° privacy coarsening (§5, R5). It
found that the thresholds run low as a uniform constant — **+22.3 ft** by a best-cut search and
**+23.7 ft** by a probit fit, which also measures a **per-street spread of 11.4 ft (1 sd)** — with
**zero false negatives** and an **AUC of 0.809**. It also independently corroborated the **+24.7 ft** datum gap that
`threshold_correction.py` had discarded as irreconcilable — which is the one thing the "datum trap"
below was always warning about, arriving from the opposite direction.

**What applying it would score** is measured on the same 1,187 outcomes and recorded as
`correction_would_score`: accuracy 0.422 → 0.760 and the false-positive rate 0.887 → 0.153, against
**167 segments that flooded and would be called dry**. It is in-sample on one event — an upper bound,
not a result — and no correction has been applied; see §11.

## The datum trap (still live, handle on ingest)

San Felipe `BAWT2` publishes thresholds on an **elevation** datum (~113–129 ft) while Richmond `RMOT2`
uses **local stage** (20–50 ft). Any multi-gauge ingest that does not normalize **per gauge** produces
nonsense. The NWPS payload carries a per-gauge `datums` object for exactly this; the fetcher already
stores it in `manifest.nwps_chain[].datums`.

## Toolchain reality on this machine

| Tool | Present | Consequence |
|---|---|---|
| Node | **v24.18.0**, npm 11 | Frontend + JS pipeline: ready now. |
| Python | **3.9.6** (system) | Too old for modern geospatial/ML wheels. |
| conda / mamba | **absent** | Must install (or use `uv`/venv + a newer Python). |
| `aws` CLI | **absent** | Needed for `--no-sign-request` S3 (HAND, NWM, 3DEP). |
| GDAL | **absent** | The known install sink for `fimserve` / `rasterio`. Time-box it. |

**Implication:** the static app + real-data wiring can proceed immediately on Node. The heavy
geospatial rungs (fimserve HAND, NWM Zarr, pysheds) need a purpose-built environment first.
