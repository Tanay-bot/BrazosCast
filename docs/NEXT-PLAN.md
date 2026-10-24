# BrazosCast — the next phase

> Written against `main` @ `0da8a60`. Five asks, and the first job of this document is to say
> which of them are already done, because three of the five are further along than they look
> and one is already complete. Every claim below names the file or the command that shows it.

---

## Status — what has landed

| item | state | where |
|---|---|---|
| 0.2 public-access gate | **done** | `scripts/check-public-access.mjs`, `scripts/check.sh --public`; both hosts report 4/4 open, and the validator's own gated fixture is asserted on every run |
| 1.3 keyless vector basemap | **done** | OpenFreeMap `liberty` in `buildMap()`, OSM raster as a one-shot fallback on style error or 8 s, layers installed from `style.load` so the fallback keeps them; verified on screen at 1280 and in the build |
| 2.1–2.7 ingestion | **done** | `pipeline/ingest/{lib,nwps,usgs_ogc,usace_cwms,refresh}.mjs`; 21 receipts from a live run, `pipeline/tests/test_ingest_contract.py` (10 tests, offline). 2.6's cadence is `.github/workflows/refresh.yml` — daily cron, fails by name on a source that refuses, then asserts its own run left every family inside 1 h via `refresh.mjs --check-stale` |
| 3 XGBoost | **done** — gated, measured on three windows, and in the app as a cross-check | § 4, FINDINGS § 9b |
| 4 HAND | **done** — unit settled by two independent checks (mm), per-reach stage, extent in the app at 90.5 KB gzipped, IoU 0.31 stated on the card | § 5, FINDINGS § 8 |

Decisions taken: OpenFreeMap (no key), HAND extent-overlay scope only, Brazos reservoirs only.
The map needed no rework — it was already MapLibre + OSM and renders — so Phase 1 shrank to the
basemap swap plus the fallback.

---

## 0. What is already true

Measured today, not remembered:

| ask | state | evidence |
|---|---|---|
| "remove authentication" | **nothing to remove in the repo; the wall was already gone** | `grep -rniE '(auth\|login\|password\|sso\|bearer)' app/src app/*.html sites/` returns zero auth code. The preview host `brazos-cast-h90iz6kcr-…vercel.app` answers **200** on `/`, `/app`, `/data/ensemble.json` and `/sw.js` with no cookie and no redirect to `vercel.com/sso-api`. It 302'd there when I checked it in the previous session, so the protection was a Vercel setting and it has been turned off. |
| "a real MapLibre/OSM map instead of a diagram" | **the map is real and already ships** | `maplibre-gl ^4.7.1` in [app/package.json](../app/package.json); `buildMap()` at [main.ts:1027](../app/src/main.ts#L1027) builds a MapLibre map over `tile.openstreetmap.org` raster tiles with `roads`, `island` and `route` layers. Screenshot of the public origin: OSM basemap, Richmond/Rosenberg street grid, Southwestern Freeway, MapLibre attribution, in a panel titled *Roads at this stage*. |
| "a full NWPS/USGS/USACE ingestion system" | **one third built, no USACE, no scheduler** | [fetch.mjs](../pipeline/fetch/fetch.mjs) caches NWPS stageflow + gauge metadata for the 7-gauge chain; [fetch_usgs_history.mjs](../pipeline/fetch/fetch_usgs_history.mjs) caches USGS daily/peak series; both write `data/raw/manifest.json`. Nothing reads USACE, nothing runs on a cadence, and USGS is on the **legacy** `waterservices` API, which USGS retires **Q1 2027**. |
| "an XGBoost baseline" | **already built, already beats its baselines, not shipped** | [forecast.py](../pipeline/models/forecast.py) trains `xgb.XGBRegressor` at +1/2/3/5/7 d against persistence and climatology, holdout 2016–17. From [model_forecast_benchmark.csv](../data/derived/model_forecast_benchmark.csv): **+1 d RMSE 1.159 ft vs persistence 1.494**, NSE 0.986. The LSTM is worse at every horizon ([lstm_compare.json](../data/derived/lstm_compare.json)). None of it reaches the app. |
| "a HAND raster pipeline" | **data present, one unresolved unit bug, not shipped** | 66 MB of NOAA HAND for HUC `12070104`, branch `3125000011`, in `data/raw/hand/`; [inundation.py](../pipeline/derive/inundation.py) produces bands. But its own docstring says **PROVISIONAL**: the REM raster reads as millimetres by the hydrotable's cell counts and as centimetres by physical plausibility, a 30× disagreement, and the output is labelled `provisional: true` and is not in the app payload. |

So the shape of the work is: **close the map's emptiness, finish the ingestion, ship the model
that already exists, and settle the HAND unit before building anything on top of it.**

---

## 1. Phase 0 — Access: make it a checked property, not a memory

The login wall is gone, but nothing in the repo would tell you if it came back. Deployment
Protection is per-project: a new preview deployment can be protected again even though this one
is public.

**0.1 · Confirm the project setting.** Vercel → Project → Settings → Deployment Protection →
Vercel Authentication. It needs to be **Disabled** (or "Only Production", which still leaves
previews open). This is a dashboard action on your account; the CLI is not installed here and I
have no token. *(2 minutes, yours.)*

**0.2 · `scripts/check-public-access.mjs`.** For the public alias and, when given one, a preview
host: assert `200` on `/`, `/app`, a `/data/*.json` and `/sw.js`; assert the body is the app's
title and not the SSO interstitial; convert a redirect to `vercel.com/sso-api` into a failure
that names Deployment Protection. Wire it into `scripts/check.sh` behind a flag like
`--browser`, because it needs the network.

**Done when** `scripts/check-public-access.mjs` exits 0 against both hosts, and exits 1 with a
readable message when pointed at a gated deployment (verified against a deliberately wrong
`?`-host, or against the old redirect captured as a fixture).

---

## 2. Phase 1 — The map: it exists; it reads as a diagram because it is nearly empty

At 8.5 ft, in the production screenshot: *0 of 1614 segments under water*, so every modelled road
is drawn as a 0.8–2.4 px dark-green line that sits under the OSM labels and is effectively
invisible; there is no river highlight, no gauge marker, no flood extent, and at low stage
nothing on the map is red. A street grid with no legible data layer does read as a diagram, even
though the basemap is a real OSM raster.

**1.1 · Restyle the road layer so it carries information at any stage.** Two-tone casing so
passable segments are visible on the raster basemap at z11–16; a `selected` highlight; and a
hover/click affordance that is discoverable without the hint text. The layer filters are already
in [main.ts:1064](../app/src/main.ts#L1064) — this is paint and order, not architecture.

**1.2 · Put the river and the gauge on the map.** The Brazos mainstem as a line from the
hydrography already in `data/raw/`, the Richmond gauge as a marker with its live stage in a
popup, and the upstream chain as small labelled points along the reach. This is what makes the
map *this* river rather than "a map".

**1.3 · Keyless vector basemap, with the raster kept as fallback.** `tile.openstreetmap.org` is
permitted for ordinary human-driven viewing but is best-effort with **no SLA**, and the policy
warns commercial and donation-seeking services that access can be withdrawn. The two keyless
options, both researched today:

- **OpenFreeMap** — public instance, no registration, no key, no request/view limits, commercial
  use explicitly allowed, as-is with no SLA, attribution required. Drop-in MapLibre style URL.
- **Self-hosted PMTiles** — no provider key; a single archive served by Range requests, R2
  recommended (no egress fee). A Texas extract's size is not published, so it has to be generated
  and measured. Vercel's byte-range behaviour was **not** verified, so this would mean a second
  host.

Recommendation: **OpenFreeMap now**, with the current OSM raster kept as the catch-path if the
style fails, and PMTiles recorded as the upgrade if traffic ever justifies it. Both are keyless,
so this decision does not block on you.

**1.4 · Stay on MapLibre v4 for this phase.** v6 is ESM-only and requires WebGL2; the v4 → v6
migration is ESM packaging and worker plumbing, which is a separate risk from "the map looks
empty". Revisit once Phase 1 lands.

**1.5 · Do not spend the text-mode budget.** The map stays a dynamic import, and
`scripts/check-text-mode.mjs` must still pass — its 200 KB gzipped floor is the guard that the
basemap style does not crawl back into the entry chunk.

**Done when** in a fresh browser profile with no key: the basemap paints, the river and gauge
marker are visible, roads are legible at 8.5 ft and at 50 ft, no console errors, `?text=1` still
loads no MapLibre, and the T8 perf spec still passes.

---

## 3. Phase 2 — Ingestion: NWPS + USGS + USACE, one command, with receipts

"Full" is defined here as: **every gauge and reservoir that can move the Richmond stage**, on a
documented cadence, with a receipt per source and a gate that fails when a source is stale or
returns nothing.

**2.1 · Move to `pipeline/ingest/`, one adapter per source.** Keep `fetch.mjs` as the NWPS
adapter's body rather than rewriting it.

| adapter | endpoint | auth | notes |
|---|---|---|---|
| `nwps.mjs` | `api.water.noaa.gov/nwps/v1/gauges/{lid}/stageflow`, `…/observed`, `…/forecast` | none | already implemented; add `/gauges?bbox=` to discover gauges instead of hard-coding LIDs |
| `usgs_ogc.mjs` | `api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items` | none (50 req/h per IP); optional `X-Api-Key` raises it to 1,000/h | parameter `00065` gage height, `00060` discharge; `USGS-08114000` id form; paginate via response links |
| `usace_cwms.mjs` | `cwms-data.usace.army.mil/cwms-data/timeseries`, `/projects` | none for low-risk public data | needs office/project parameters confirmed against the live Swagger before shipping |
| `mrms.mjs` *(optional)* | `s3://noaa-mrms-pds/` or the QPE ImageServer | none | 1 km QPE, 1/3/6/24/72 h windows; feeds Phase 3's features |

**2.2 · One receipt schema, written by every adapter.** `data/raw/_receipt.json`: `{source, url,
fetched_at, http_status, bytes, rows, sha256, status}`. A 200 with zero rows is a **failure**,
not a success — that is the failure mode that looks like a quiet river.

**2.3 · Retries and budget.** Exponential backoff on 429/5xx, honour `Retry-After`, a per-source
request budget derived from the documented limits (USGS unauthenticated is 50/hour — the 7-gauge
chain plus a daily series is close to that, which is the argument for the optional key), and no
parallel hammering of one host.

**2.4 · USACE scope, with the trap named.** Addicks and Barker are **San Jacinto** basin, not
Brazos — the app currently does not mention them and must not start. The Brazos reservoirs
(Whitney, Waco, Belton, Stillhouse Hollow, Granger, Georgetown, Somerville) are the ones that
move Richmond. Each project row must satisfy an explicit `basin == "Brazos"` assertion before it
can enter the payload; that assertion is the guard against a future contributor adding the
Houston dams because they are nearby.

**2.5 · `pipeline/ingest/refresh.mjs`** — one command, `--source=`, `--dry-run`, exits non-zero
on any source that failed, prints the receipt table.

**2.6 · Cadence.** The app already fetches live NWPS at runtime and already has a service-worker
fallback. Add a scheduled refresh (cron job or manual `refresh.mjs` before a deploy) that
regenerates the static snapshot, so a third-party outage degrades to "last known" rather than
"no answer". Runtime live fetch stays as the override.

**2.7 · `pipeline/tests/test_ingest_contract.py`** — receipts complete, row counts non-zero,
timestamps monotonic and inside the requested window, staleness thresholds, and the frozen
fixtures that let the suite run with the network off.

**Done when** one command repopulates all three sources from a cold cache; killing one source
fails the command and names it; the suite passes offline; and the app's `srcTag` line still shows
the same provenance sentence.

---

## 4. Phase 3 — XGBoost: it exists; make it honest, gated, and visible

> **DONE.** `pipeline/models/forecast.py` is now a stage in the golden regression and in
> `pipeline/tests/test_forecast_contract.py`; it scores three out-of-sample windows, reports
> exceedance at 20 / 33.4 / 45 / 50 ft and per event, and its numbers reach the app as the
> card *The model behind the range* (payload `model_crosscheck.json`). The measurement it found
> is in FINDINGS § 9b and it is not flattering: the model wins at +1…+3 d on every window and
> loses at +5/+7 d, and at 45–50 ft persistence is the better threshold classifier — on the
> holdout it misses all nine 50 ft exceedances. The app therefore says so, in the card and in
> the footer, rather than leading with the RMSE. 3.2's missing features were measured and left
> out (§ 9b explains why, including the MRMS/QPE blocker), so **3.1, 3.3 and 3.4 are complete
> and 3.2 is complete as a decision with the evidence recorded**.

**3.1 · Put it in the chain.** `pipeline/models/forecast.py` is not in `scripts/check.sh` and not
in the golden regression, so its published numbers can drift without a test noticing. Add it
(with a pinned seed and a pinned `xgboost` version) and assert the benchmark CSV reproduces
within tolerance.

**3.2 · Add the features that are missing, and only those.** Antecedent precipitation from MRMS/QPE
(Phase 2's `mrms.mjs`), upstream lags derived from `travel_time.json` rather than from lag
correlation, and cyclical seasonality. Strict rule: every feature must be available at issue
time; the chronological split stays.

**3.3 · Report the metrics that matter, per horizon and per event.** RMSE, MAE, NSE, KGE (already
computed), plus threshold exceedance at the stages the app actually uses — 20 / 33.4 / 45 / 50 ft
— as POD, FAR and CSI, broken out by event so Harvey cannot carry a pooled score.

**3.4 · Ship it as a cross-check, not as the answer.** Export a small `model_forecast.json` subset
into the app payload and show it beside the 50-member ensemble: *the model says 44.1 ft at +3 d,
the ensemble's spread is ±4.2*. Guard the payload size. The honest framing is that at +7 d the
model's RMSE is **6.06 ft** against an ensemble spread that is far wider, so presenting it as
"the forecast" would be a worse answer than the range the app already gives.

**Done when** the benchmark reproduces under `scripts/check.sh`, the exceedance table exists at
those four stages, and the app shows the model's number next to the ensemble's without changing
the answer sentence.

---

## 5. Phase 4 — HAND: settle the unit before building on it

**4.1 · Resolve the mm-vs-cm defect, and use the second extent to do it.** This is the highest-value
item in the phase and it is a measurement, not a build. `inundation.py` currently picks
centimetres because 383 km² at 45 ft is absurd, while millimetres fits the hydrotable's cell
counts. The repo already holds an independent observation — the **USFIMR 2016 extent**
(`data/raw/usfimr/`, used by `second_event_validation.py`) — so the unit can be chosen by asking
which reading reproduces the observed extent at the observed stage, rather than by plausibility.
Record the answer and the residuals in FINDINGS.

**4.2 · Only then, a fetcher.** `pipeline/ingest/hand.mjs` pulling the relevant HUC8 from the
**Texas 3 m Pin2Flood HAND** (CC BY 4.0, includes SRC tables) or NOAA-OWP's published FIM
products (national inputs are ~400 GB, national HAND ~1.7 TB, and the S3 bucket needs ESIP
credentials — so HUC8 selection, never a bulk pull). Record licence and receipt.

**4.3 · Per-reach stage instead of a uniform stage.** The current model applies one water surface
across the mainstem, which is HAND's stated assumption but ignores backwater. Use the synthetic
rating curve (discharge → stage per reach, reached from NWPS/USGS flow) and document the residual
limitation rather than hiding it.

**4.4 · Ship the extent as polygons, not per-frame rasters.** Export bands at the NWS categories
plus the current stage as vector polygons (PMTiles or GeoJSON, budget < 300 KB), and draw them
under the road layer in MapLibre. Keep the `provisional` label until 4.1 is settled and validated
— the app's whole voice is that it does not assert what it cannot defend.

**Done when** the unit is confirmed by two independent checks (hydrotable counts *and* USFIMR
overlap), the extent at Harvey's peak reaches a stated IoU against the 2016 observation, and the
overlay renders on the map inside the payload budget.

**Landed.** 4.1 `hand_unit_resolution.py`: both checks pick **millimetres** — the hydrotable's
per-reach cell counts at 1.0000 median ratio under mm against 0.05 under cm, and the 2016 water
edge at IoU 0.191 vs 0.093 at the observed stage (the best-fit stage is 5.9 ft from the gauge
under mm, 22.8 ft under cm). The product reads that artifact rather than a constant. 4.3 is not
a note but a change: stage is per reach, from the hydrotable's own SRC at the discharge the gauge
rating gives, which moves the corridor extent at 50 ft from 440 to 289 km² and the overlap from
0.19 to 0.31. 4.4 ships 95 polygons at 90.5 KB gzipped, drawn under the roads at the band at or
below the stage. Stated scores: **IoU 0.31 at the image's 49.40 ft (2.3× the radar's area) and
0.315 at Harvey's crest**, which is not like-for-like because the image precedes the crest by
three days; the card prints both rather than the flattering one. **4.2 landed, with its limit
stated where it can be read**: `pipeline/ingest/hand.mjs` fetches one HUC8 (the national inputs
are 400 GB and a bulk pull is what the selector exists to prevent), parses the package manifest
before any bytes move, refuses a package missing a layer the pipeline reads, compares the archive
against that manifest rather than trusting a hash alone, and records the licence and the sha256 in
`data/raw/_receipt.json`. The limit is packaging, not capability: NOAA's per-branch tree is behind
an ESIP-keyed bucket that answers 403 without credentials, so the keyless route is the Texas
Pin2Flood HUC8 archive — the same HAND family, **CC BY 4.0**, in a different layout. The fetcher
reproduces the product and the provenance; it does not byte-reproduce `data/raw/hand/12070104/`.
The remaining bias is HAND's connectivity assumption plus the radar's under-mapping under forest,
which one observation cannot separate.

---

## 6. Order, size, and what blocks what

| phase | size | blocks on | why this order |
|---|---|---|---|
| 0 · access check | 0.5 h | your dashboard confirmation | costs nothing, and the wall coming back is silent |
| 1 · map | ~1 day | nothing | the visible payoff, and it needs no key |
| 3 · XGBoost | ~0.5–1 day | nothing (MRMS features wait for 2) | almost all of it exists; shipping it is cheap |
| 2 · ingestion | ~1–2 days | USACE Swagger confirmation | feeds 3's features and 4's stage input |
| 4 · HAND | ~2–3 days | **4.1 before anything else** | building on an unresolved unit is building on sand |

---

## 7. What I need from you

Nothing here needs a paid key. The list is short and mostly decisions:

1. **Vercel Deployment Protection** — set it to Disabled (or Only Production) at the project level,
   so a future preview is not gated again. The current preview is already public.
2. **Basemap** — OpenFreeMap (no key, recommended) vs self-hosted PMTiles (no key, needs an R2/S3
   bucket) vs staying on OSM raster tiles.
3. **USGS API key** — *optional*. Free, raises 50 → 1,000 requests/hour. Only worth it if we poll
   more sites than the 7-gauge chain. No key needed for NWPS, USACE or MRMS.
4. **USACE scope** — Brazos reservoirs only (recommended), or also the San Jacinto dams as clearly
   labelled neighbours?
5. **HAND scope** — "flood extent on the map" (4.1 + 4.4, about a day) or the full per-reach
   pipeline (4.1 → 4.4, two to three days)?
6. **What you were looking at.** If the thing that read as a diagram was the **landing page's
   rail** (no map at all on `/`) or the **text-only view** (the map is deliberately absent), the
   fix is different from restyling `/app`'s map — say which and Phase 1 changes shape.

---

## 8. Risks worth naming now

- **OSM raster tiles have no SLA** and the policy warns donation-seeking and commercial services.
  Hence 1.3; the current usage is permitted but not guaranteed.
- **PMTiles on Vercel is unverified** for byte-range requests; plan on a second host if we take
  that route.
- **USGS provisional data are revised**, so a refreshed series can move a published number. The
  receipt hash is what makes that visible instead of silent.
- **HAND's uniform-stage assumption and levee handling** are real limitations, already labelled in
  the app; 4.3 narrows them, it does not remove them.
- **The +7 d model is not obviously better than "I don't know"** (RMSE 6.06 ft). Shipping it as a
  headline rather than as a cross-check would undercut the project's main claim.
