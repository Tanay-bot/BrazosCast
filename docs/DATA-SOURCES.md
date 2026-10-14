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
