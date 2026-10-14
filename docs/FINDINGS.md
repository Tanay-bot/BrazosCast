# BrazosCast — pipeline findings (v0)

Measured results from the first real data runs. Everything here is reproducible from the scripts
named; nothing is asserted from memory. Environment: `~/miniforge3/envs/brazoscast` (Python 3.12,
GDAL 3.13.3, rasterio 1.5.2).

---

## 1. Travel-time matrix — the novel artifact

**No published table says how long a Brazos crest takes to reach Richmond.** Derived two ways:
daily cross-correlation over 1990–2026 (`pipeline/analyze/travel_time.py`) and sub-daily
event-peak matching over 24 major events (`pipeline/analyze/travel_time_subdaily.py`).

### Sub-daily median lead time to Richmond (hours)

| Gauge | Name | Median | IQR (p25–p75) | n |
|---|---|---|---|---|
| **HPDT2** | **Hempstead** (key upstream) | **48.1 h** | 33.0–54.9 | 20 |
| BAWT2 | San Felipe (nearest upstream) | 30.8 h | 20.2–56.8 | 17 |
| BBZT2 | Bryan | 75.5 h | 69.1–100.8 | 20 |
| HIBT2 | Highbank | 101.5 h | 85.0–134.8 | 17 |
| WBAT2 | Waco (far upstream) | 119.0 h | 113.2–144.1 | 19 |

(An earlier pass analysed only 16 events after the USGS API rate-limited four of them;
the legacy-endpoint fallback recovered them, and these are the figures the app ships.
Note Hempstead moved 38.8 → **48.1 h** with the fuller sample — a reminder that the tail of
this distribution is thin.)

**This is the demo sentence.** *A crest at Hempstead reaches Richmond in roughly a day and a half.*
The pitch's "you have 31 hours" is now a derived distribution, not an illustration.

### Daily cross-correlation lags (days, upstream leads Richmond)

Waco 4 · Highbank 3 · Bryan 2 · Hempstead 1 · San Felipe 1, all with r ≥ 0.79.

### ⚠️ The plan's hypothesis is wrong (and this is a *finding*, not a bug)

The brief predicted travel times **shorten** at high discharge. The data says the opposite:
splitting by Richmond discharge tercile, lags **grow** at high flow — Waco 4→5 d, Highbank 3→4 d,
Bryan 2→3 d, Hempstead 1→1 d.

Most likely mechanism (a hypothesis, to state as one): upstream gauges are flashy — they spike on
local rainfall within hours — while Richmond's crest is delayed by flood-pool routing and the 12
upstream reservoir releases. The *measured effect* is real regardless: **the biggest floods buy the
most lead time**, which is good for the product but means fixed-lag features are wrong. The feature
matrix must be conditioned on discharge regime (exactly the design the brief called for, for the
opposite stated reason). This is the strongest answer to the competition's "technical difficulty"
question — proposed a mechanism, measured it, reported it was backwards.

### Caveats to keep honest

- Daily lags are integer days; only the sub-daily run gives hours.
- All 24 candidate events are now cached (n = 17–20 per gauge after gap-filling).
- San Felipe (BAWT2) has only **35%** daily stage coverage — its lags are the least reliable.
- The IQR is wide (Hempstead 33–55 h): these are order-of-magnitude lead times, not precise ones.
- Multi-crest events (e.g. 2015-06, 2016-06) produce ambiguous peak matches; the median is robust
  to them but individual rows are not.

---

## 2. HAND inundation is precomputed for Richmond — a big risk reduction

The spec assumed we would run `fimserve` to generate HAND rasters (and feared GDAL fighting us for a
day). **The outputs already exist in the public bucket**, verified via `aws s3 ls --no-sign-request`:

```
s3://ciroh-owp-hand-fim/                 # also hand_fim_4_5_2_11 / _4_8_7_2 / _4_9_9_0
  hand_fim_4_9_9_0/12070104/             # HUC8 containing Richmond — PRESENT
    hydrotable.csv (77 MB) / .parquet (2 MB)   # discharge -> stage -> inundation lookup
    osm_roads_subset.gpkg + osm_roads_fimpact.csv   # road flood-impact, already computed
    LeveeProtectedAreas_subset.gpkg, nld_subset_levees.gpkg  # the levee caveat, built in
    nwm_catchments_proj_subset.gpkg, nwm_subset_streams*.gpkg
    usgs_elev_table.csv, usgs_subset_gages.gpkg
    branches/<feature_id>/                 # the actual HAND rasters
```

So the inundation rung is **download + join**, not model-building. Plan adjustment: pull the specific
Richmond branches + hydrotable instead of running `fimserve` end-to-end. The levee layers make the
"this parcel is behind a levee; HAND is unreliable here" caveat nearly free — pull
`LeveeProtectedAreas_subset.gpkg`.

NWM kerchunk refs confirmed at `s3://noaa-nodd-kerchunk-pds/nwm/` (`short_range/`, `medium_range_mem1/`, …);
retrospective at `s3://noaa-nwm-retro-v2.0-pds/`.

---

## 3. The new USGS API now expects an API key

`api.waterdata.usgs.gov` returns **`429 OVER_RATE_LIMIT`** after a burst of anonymous calls, with the
message: *"Make sure you provided your API key from https://api.waterdata.usgs.gov/signup/"*.

- The legacy `waterservices.usgs.gov` endpoint still works (301 → follows) and has a separate budget.
- The sub-daily script now falls back to legacy automatically for uncached windows.
- **Action:** sign up for a free key and set `USGS_API_KEY` before heavy pulls. Note this in the
  writeup — noticing a rate-limit/key change is exactly the maturity signal the brief wants.

---

## 4. The premise, measured

From the cached OpenFEMA v3 snapshot (7,389 Fort Bend claims) via `pipeline/analyze/nfip_xzone.py`:

- **66.2%** of claims rated in an **X zone** (outside the mapped 100-yr floodplain); **67.3%** of
  building dollars.
- **Harvey (Aug–Sep 2017): 73.8%** of claims were X-zone.

The county's floodplain map did not warn the majority of residents who actually flooded.

---

## 5. Street-level thresholds (`pipeline/derive/road_thresholds.py`)

NOAA-OWP already publishes, per OSM road segment, the HAND height at which it floods
(`osm_roads_fimpact.csv`, 8,841 rows). We use `threshold_hand_ft` directly as the Richmond
gauge stage for segments on the **mainstem levelpath** (`branch == 3125000011`, the same
levelpath as RMOT2). Segments with `branch == 0` sit on tributaries and are marked
`mainstem=false` — their threshold is relative to their own drainage, not the Brazos.

**Result:** 1,614 mainstem segments in the Richmond/Rosenberg corridor.
Thresholds: min 11.7 ft, p25 30.7 ft, median **33.4 ft**, p75 43.2 ft, max 81.9 ft.
1.5% flood at action stage (20 ft) and 76.5% at minor flood (45 ft). 27 segments sit inside a
levee-protected area (flagged `levee: true`). Output: `data/derived/road_thresholds.geojson`.

**Two caught errors — both worth stating in the writeup.**

1. *Discharge through the wrong rating curve.* Mapping `threshold_discharge_cfs` via the Richmond
   rating implied **38% of streets flood at action stage** — implausible. The file spans 442 NWM
   reaches; a tributary's discharge is not comparable to the mainstem's. Rejected.
2. *Per-catchment rows poisoning the minimum.* A road has one row per catchment it crosses, and
   those rows reference **different reaches**. Simonton Road's rows ran 2.6 → 51.9 ft: the low values
   were referenced to a small tributary ("2.6 ft above that creek"), not the Brazos. Taking the
   minimum over all rows set the whole segment to 2.6 ft, and the app then claimed **863 of 2,474
   segments were underwater at a 9.2 ft stage**. Fix: keep only mainstem-levelpath rows *before*
   aggregating. The minimum threshold is now 11.7 ft, so nothing floods at 9.2 ft.

**Open QC item:** validate thresholds against the USGS Harvey observed-inundation layer before
shipping. 76.5% of mainstem segments flooding at the 45 ft minor stage is high and unverified.

## 6. Inundation bands — PROVISIONAL (`pipeline/derive/inundation.py`)

Inundation = cells where HAND < stage. Getting there surfaced an unresolved unit question:

- the hydrotable `stage` column is unambiguously **metres** (0.3048 m = 1 ft steps);
- the `rem_zeroed_masked_*.tif` raster is int16, values 0–32766. Read as **millimetres** it
  reproduces the hydrotable's cell counts (~10.07M vs 9.9M at a 12 m stage) but implies
  **383 km² flooded at 45 ft inside the Richmond window (65% of the domain)** — absurd;
- read as **centimetres** it gives **13.5 km² at 45 ft** — plausible for the Brazos floodplain —
  but does not reproduce the cell counts.

We ship the centimetre reading because it is the physically credible one, and label every
output `provisional: true`. **This must be confirmed against NOAA-OWP docs before the extents
are presented as authoritative.** Stage→area: 40 ft 13.16 km², 45 ft 13.51 km², 48 ft 13.70 km²,
50 ft 13.84 km². The area barely grows with stage, i.e. nearly all low-HAND cells are already
wet by 40 ft — another reason to distrust the scale until confirmed.

## 7. Forecast benchmark (`pipeline/models/forecast.py`, `lstm.py`)

Holdout **2016–2017** (contains the 2016 flood and Harvey); trained ≤ 2015. RMSE in feet.

| horizon | model | RMSE | MAE | NSE | KGE |
|---|---|---|---|---|---|
| +1 d | XGBoost | 1.159 | 0.552 | 0.986 | 0.960 |
| +1 d | persistence | 1.494 | 0.752 | 0.977 | **0.983** |
| +2 d | XGBoost | **2.163** | 1.088 | **0.950** | 0.920 |
| +2 d | persistence | 2.687 | 1.390 | 0.923 | **0.955** |
| +3 d | XGBoost | **3.568** | 1.986 | **0.861** | 0.871 |
| +3 d | persistence | 3.672 | 1.948 | 0.853 | **0.922** |
| +7 d | XGBoost | **6.057** | 3.823 | **0.571** | **0.781** |
| +7 d | persistence | 6.905 | 3.891 | 0.442 | 0.732 |

- **XGBoost beats persistence on RMSE and NSE at every horizon**, decisively at +1–2 d and +7 d;
  persistence still wins KGE/MAE at +3–5 d. Reported honestly rather than spun.
- **Top features at +2 d are `BAWT2_s0` (San Felipe, 0.465) and `HPDT2_s0` (Hempstead, 0.452)** —
  the two nearest upstream gauges. The model independently rediscovered the travel-time structure.
  That is the best single demo visual in the project.

### LSTM vs XGBoost (`pipeline/models/lstm.py`)

The first LSTM, regressing the absolute stage, was clearly underfit (RMSE 3.88 ft at +1 d — worse
than doing nothing). Reformulating it to predict the **change from the last observed stage** — which
makes persistence the trivial solution — fixed it (3.88 → **1.80** ft at +1 d). Final holdout:

| horizon | LSTM RMSE | LSTM NSE | persistence RMSE | XGBoost RMSE | winner |
|---|---|---|---|---|---|
| +1 d | 1.798 | 0.968 | 1.972 | **1.159** | XGBoost |
| +2 d | 3.360 | 0.889 | 3.589 | **2.163** | XGBoost |
| +3 d | 4.629 | 0.789 | 4.900 | **3.568** | XGBoost |
| +5 d | 6.319 | 0.605 | 6.869 | **5.365** | XGBoost |
| +7 d | 7.578 | 0.431 | 8.301 | **6.057** | XGBoost |

**The LSTM beats persistence at every horizon and loses to XGBoost at every horizon.** Per the
brief's own instruction, we ship the GBM and report the loss rather than quietly swapping models.
The likely reason is data volume (~9k daily samples, one gauge): gradient boosting exploits the
hand-built lags directly, and there is not enough series for the LSTM's sequence advantage to
appear. A 26-year hourly NWM-forced corpus would be the fair retry.

**Not done:** the NWS-official and NWM-retrospective head-to-head. Archived AHPS forecasts are not
published openly, and the NWM retrospective needs the kerchunk/Zarr route. Tracked as the one
remaining benchmark task rather than claimed.
