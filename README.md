# BrazosCast

> **BrazosCast tells a Fort Bend household when floodwater reaches *their street* and which of their
> ways out will still be open — not whether the river is high.**

An address-first flood **lead-time** engine for the lower Brazos River at Richmond, Texas.
2026 Congressional App Challenge, TX-22.

## Status

- [x] Data dependencies verified live and cached (`data/raw/`)
- [x] Verified ledger of every source + corrections → [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)
- [x] Build plan and analysis → [docs/PLAN.md](docs/PLAN.md)
- [x] Upgrade & fix plan, with measurements → [docs/UPGRADE-PLAN.md](docs/UPGRADE-PLAN.md)
- [x] Travel-time matrix (crest lag, flow-dependent) — Hempstead→Richmond ≈ 39 h
- [x] Street-level thresholds — 1,614 mainstem segments, median 33.4 ft — **known defect, below**
- [x] Inundation bands — **provisional** (HAND raster scale unresolved)
- [x] Model benchmark — XGBoost > LSTM > persistence on the 2016–17 holdout
- [x] Static app: address → street threshold → hours of lead time (live + Harvey replay)
- [ ] Forecast vs archived NWS / NWM retrospective

## Layout

```
docs/       plan, verified data-source ledger
pipeline/   fetch + analysis + (later) models, geo, road graph
data/raw/   cached source snapshots + manifest.json
data/derived/
app/        frontend (static, deployable)
```

## Run the app

```bash
cd app && npm install && node node_modules/esbuild/install.js
npm run dev        # http://localhost:5173
npm run build      # static bundle in app/dist
```

The app fetches the live NOAA NWPS gauge directly from the browser (CORS is open) and reads the
per-street thresholds from `app/public/data/`. Set `VITE_MAPBOX_TOKEN` for address geocoding;
without it, enter a road name or click the map.

## Refresh the data

```bash
node pipeline/fetch/fetch.mjs                          # NWPS chain, NWS, OpenFEMA
node pipeline/fetch/fetch_usgs_history.mjs 1985        # long gauge record
<env>/bin/python pipeline/analyze/travel_time.py       # crest lags (daily)
<env>/bin/python pipeline/analyze/travel_time_subdaily.py 24
<env>/bin/python pipeline/derive/road_thresholds.py    # per-street thresholds
<env>/bin/python pipeline/derive/inundation.py         # provisional extents
<env>/bin/python pipeline/models/forecast.py           # XGBoost benchmark
<env>/bin/python pipeline/export/app_data.py           # publish into the app
```

Writes `data/raw/` and `data/raw/manifest.json` (per-source status, counts, per-gauge datums).

## The premise, measured

Of **7,389** Fort Bend NFIP claims, **66.2%** were rated in an **X zone** — outside the mapped
100-year floodplain — accounting for **67.3%** of building dollars paid. During **Harvey, 73.8%**
of claims were X-zone. The county's floodplain map did not warn the majority of residents who
actually flooded. Reproduce: `python3 pipeline/analyze/nfip_xzone.py`.

## Known defect in the street thresholds

The thresholds treat the HAND height above the nearest drainage as the Richmond gauge stage. That
leaves a systematic error — the HAND reference changes bed elevation along the corridor, and the
residual along-river slope is `−0.92 ft/mile (r = −0.64)`.

Concretely: **11 classified highway segments (US 90A and the Grand Parkway) still sit below action
stage** in `road_thresholds.summary.json`. Every affected segment is flagged `confidence: "low"` and
the app says so on screen rather than asserting a threshold it cannot defend. 128 segments are
flagged in total (below action, unrepaired river crossings, or levee-protected).

An earlier attempt to convert the source's inundation discharge through the gauge's own measured
rating was built and **rejected on measurement** — the source discharges lie mostly above the gauge's
observed record, and the column is not a single-reach discharge (225 sub-reaches span three orders of
magnitude at one stage). The evidence is recorded under `known_defect` in the summary. Closing the
defect needs new data: a HAND re-run from the DEM, or per-reach channel bed elevations.

Gates at the end of `pipeline/derive/road_thresholds.py` fail the run if any segment below action
stage or any unrepaired crossing is not flagged, and if the reported defect set stops matching the
data.

## Attribution

Libraries and datasets are documented with licenses in the submission and in each pipeline step.
AI tools are disclosed fully per the 2026 CAC rulebook.
