# BrazosCast

> **BrazosCast tells a Fort Bend household when floodwater reaches *their street* and which of their
> ways out will still be open — not whether the river is high.**

An address-first flood **lead-time** engine for the lower Brazos River at Richmond, Texas.
2026 Congressional App Challenge, TX-22.

## Status

- [x] Data dependencies verified live and cached (`data/raw/`)
- [x] Verified ledger of every source + corrections → [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)
- [x] Build plan and analysis → [docs/PLAN.md](docs/PLAN.md)
- [x] Travel-time matrix (crest lag, flow-dependent) — Hempstead→Richmond ≈ 39 h
- [x] Street-level thresholds — 1,614 mainstem segments, median 33.4 ft
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

## Attribution

Libraries and datasets are documented with licenses in the submission and in each pipeline step.
AI tools are disclosed fully per the 2026 CAC rulebook.
