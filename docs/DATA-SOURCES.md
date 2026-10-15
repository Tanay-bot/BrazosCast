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
| FBCAD open data hub | `fbcad-open-data-hub-fortbend.hub.arcgis.com` | none | ✅ 200 | Parcels via ArcGIS Hub (`?f=geojson`). |
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
