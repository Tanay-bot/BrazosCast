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
1.4% flood at action stage (20 ft) and 76.3% at minor flood (45 ft). 27 segments sit inside a
levee-protected area (`levee: true`). 104 segments cross a stream (`crossing: true`); 19 of those
were repaired from non-crossing neighbours. 128 segments carry `confidence: "low"`.
Output: `data/derived/road_thresholds.geojson`.

**Three caught errors — all worth stating in the writeup.**

1. *Discharge through the wrong rating curve.* Mapping `threshold_discharge_cfs` via the Richmond
   rating implied **38% of streets flood at action stage** — implausible. The file spans 442 NWM
   reaches; a tributary's discharge is not comparable to the mainstem's. Rejected. Re-confirmed with
   the gauge's own rating (9,690 paired daily observations, `gauge_rating.py`): it yields a **57.3 ft
   median threshold**, with **860 of 1,614** segments needing a discharge beyond anything the gauge
   has measured. The column is also not a single-reach discharge at all: the mainstem levelpath's
   hydrotable carries 225 sub-reaches whose discharges at one stage span **3,229–232,824 cms**. The
   route is unusable *as a direct conversion*, and now measurably so — but it is usable **per reach**,
   which is a different test entirely (see *The five routes*, below).
2. *Per-catchment rows poisoning the minimum.* A road has one row per catchment it crosses, and
   those rows reference **different reaches**. Simonton Road's rows ran 2.6 → 51.9 ft: the low values
   were referenced to a small tributary ("2.6 ft above that creek"), not the Brazos. Taking the
   minimum over all rows set the whole segment to 2.6 ft, and the app then claimed **863 of 2,474
   segments were underwater at a 9.2 ft stage**. Fix: keep only mainstem-levelpath rows *before*
   aggregating. The minimum threshold is now 11.7 ft, so nothing floods at 9.2 ft.
3. *Bare-earth elevation at river crossings — and the limit of the fix.* OWP HAND comes from a
   bare-earth DEM, so the ground *under* a bridge reads as channel bed and a crossing segment gets an
   artificially low threshold. The OSM extract carries **no `bridge` or `layer` column**, so crossings
   are found geometrically instead (within 15 m of an NWM stream line) and repaired from non-crossing
   neighbours within 300 m. Low thresholds are genuinely concentrated at crossings: **33.3% of
   sub-25-ft segments sit within 15 m of a stream line against 6.4% of all segments**, a 5.2×
   enrichment. The repair fixes **State Highway 6 (14.2 → 30.2 ft)** but cannot fix US 90A or the Grand
   Parkway, whose 16–19 ft values run the length of the corridor rather than concentrating at a
   crossing. Those segments are now flagged rather than silently shipped.

**Open defect — declared, not hidden, and its magnitude is now measured (§11).** Treating
`threshold_hand_ft` as the Richmond gauge stage leaves a residual systematic error: the HAND reference
changes bed elevation along the corridor, and regressing the thresholds on distance from the gauge
gives **−0.92 ft/mile, r = −0.64**. Thirteen classified highway segments (**11 unique ways** — US 90A,
Grand Parkway, State Highway 6) still sit below action stage in `road_thresholds.summary.json` under
`known_defect`, every one flagged `confidence: "low"`.

Against the observed Harvey extent the error is **+22.3 ft, uniform** — not the along-river trend this
paragraph describes, which a spatial holdout shows does not generalise where a constant does (§11).
The `confidence: "low"` flags are on the right segments for the right reason; what changes is that the
correction's size is known rather than assumed.**Open QC item — NOW CLOSED (§11).** Validate thresholds against the USGS Harvey observed-inundation
layer before shipping: 76.3% of mainstem segments flooding at the 45 ft minor stage was high and
unverified. It is verified now, and it is too high — the observed extent puts the model's prevalence
at 92.7% against an actual 34.9%, with a measured false-positive rate of 0.887 and the required
correction at **+22.3 ft**.

### A real bug found here: the gauge rating was wrong at the top of the record

While testing the conversion the rating itself was measured, and it failed at the one point that
matters most. At the largest event on record — **2017-08-31, Hurricane Harvey: 55.01 ft at
120,000 cfs** — the plain power law predicted **39.3 ft** (15.7 ft low) and the standard shifted
power law predicted **71.6 ft** (16.6 ft high), while fitting the low-flow bulk to 0.34 ft.

Two closed forms erring in *opposite* directions is the diagnostic: the observed curve **flattens**
at high stage (102,000 cfs gives 54.65 ft, not 64), and no three-parameter power form bends that way.
This is not scatter — the top of the record is clean and monotone (53.26 ft at 95,000 cfs, 54.65 at
102,000, 55.01 at 120,000).

`gauge_rating.py` now uses a **monotone PCHIP** curve through the median stage of 40 log-spaced flow
bins, with the record peak appended as an exact knot, and a local power-law tail above the record.
Measured before → after:

| metric | power law | shifted power law | **PCHIP** |
|---|---|---|---|
| median abs error | 0.87 ft | 0.34 ft | **0.28 ft** |
| stage > 35 ft | — | 2.73 ft | **1.12 ft** |
| stage > 45 ft | — | ~5–9 ft | **1.14 ft** |
| max abs error | — | 16.57 ft | **4.01 ft** |
| error at the observed peak | 15.7 ft | −16.57 ft | **0.00 ft** |

Gated at run time: the rating must be non-decreasing in flow, strictly increasing across its 40
knots, monotone in its extrapolation tail, and within 1.5 ft above 35 ft.

### The five routes to closing the defect, each closed by a measurement

`pipeline/derive/threshold_correction.py` builds and tests every route to a physically-correct
conversion. **All five are closed, and no correction is applied** — a correction that cannot be
validated would be worse than a declared defect. Each closure is recomputed at run time into
`threshold_correction.json`, so a route cannot be re-proposed without confronting its measurement.

| route | verdict | the measurement that closes it |
|---|---|---|
| **R1** discharge through each reach's own rating | works, cannot ship | it is not a lift — in-record **645 up, 117 down** — so it *redistributes* the below-action set: **17 of 18 lifted, 17 new, net 18**; the hybrid is non-monotone (637 segments invert) because 1,014 of 1,776 segments need discharge beyond the record |
| **R2** per-reach bed elevations, absolute | unresolvable datum — **but the number was right (§11)** | `usgs_elev_table.csv` **does** hold `dem_adj_elevation`, for its 15 gauge crosswalk rows (**9 distinct reaches**); they form a clean monotone profile, but at the gauge itself that elevation (51.4 ft) and the gauge's own zero datum (26.73 ft) differ by **+24.7 ft**, which would put the median corridor road above any flood on record. Observed flooding independently requires **+22.3 ft**, **within 2.4 ft** of that gap — so taking it literally was closer to the truth than discarding it was |
| **R3** the flat-pool correction the review asked for | premise corrected | applying `HAND + [bed(x) − bed(gauge)]` **adds** slope rather than removing it — the bed drops 0.53 ft/mile downstream, the same sign as the observed −0.92 ft/mile threshold trend |
| **R4** re-reference HAND to the Brazos | reference not identifiable | the mechanism is real (every sub-20-ft segment sits 2,000+ m from the Brazos but 8–200 m from a tributary), but NWM flowlines over-correct the median by **+26.6 ft**; and of 145 sampled segments only 59 have *any* drainage cell within 2.5 km of the real HAND raster, **none** of them off-branch |
| **R5** validate against observed flooding | **no longer closed — superseded by §11** | as a *claim-point* route it is still closed: the 7,389 OpenFEMA NFIP claims (**3,928 Harvey**, 6,662 with depth) are privacy-coarsened to 0.1° — **6 distinct latitudes × 8 longitudes**, ~11 km per cell. But the same section listed observed inundation **as polygons** as the way to reopen it, and that is now fetched and scored: §11 measures the error at **+22.3 ft**, a constant |

**Shipped instead: the validated bed profile.** Integrating NWM reach slope × length downstream gives a
datum-free relative channel-bed profile that reproduces the six gauge bed elevations in
`usgs_elev_table.csv` at **r = 0.986** (offset spread −0.44 to +11.35 m — the size of the unresolvable
datum gap), with an implied slope of 0.53 ft/mile. No DEM is needed and only differences are
meaningful. This is what a future DEM-based re-run has to agree with.

**Honest limits of this stage.** The refuges and thresholds it reasons about are the *uncorrected*
ones — now measured at **+22.3 ft low, uniformly** (§11) — so its absolute numbers move when the
primitive is fixed; the structure is what it contributes.
R1's analysis runs on the pre-export fimpact table (1,776 ways, 819 classified, 18 below action); the
shipped artifacts carry 1,614 segments (13 rows / 11 ways below action), so those counts are not the
same population and are labelled as such. And when this section was written nothing here had been
adjudicated against observed inundation. **It now has been (§11), and the result is narrower and more
useful than "unproven": the thresholds are not noise (AUC 0.809), their error is a uniform
**+22.3 ft** rather than the along-river trend this section describes, and two of the five routes
closed above turn out to have landed within 3 ft of that number.** What remains unproven is whether
the correction generalises — one event, one extent, so it is measured but not applied.

## 6. Isolation stage — "when can I no longer leave?" (`pipeline/derive/isolation.py`)

The question above is "when does my street flood?". The question that actually kills people is
**"when do I lose my last way out?"** — a different number, and never later than the first. This
stage adds `isolation_ft`, `isolation_gap_ft` and `isolation_status` to every segment.

At the shipped thresholds: **230 of 1,614 segments are cut off before their own street floods**
(median gap 2.8 ft, max 19.6 ft). **883 have no modelled dry refuge at all**
(`isolation_status = "no_dry_refuge"`). Largest gaps — you are trapped eleven to seventeen feet
before your own street goes under: US Highway 90A (street 34.8 ft, cut off **18.1 ft**, gap 16.7),
FM 762 (16.3), West Grand Parkway South (15.9), Ellis Creek Boulevard (15.5), Gateway Boulevard
(13.5), Macek Road (13.5), Crabb River Road (11.7), Jackson Street (9.7), Fort Street (8.3),
Houston Street (7.4).

**Method.** A graph with a node at every vertex, edges carrying their segment's threshold. A refuge
is a node incident to a segment surviving the 50 ft major stage. Isolation is the widest-path
bottleneck to that set, computed in **one descending union-find pass** rather than one per stage,
then cross-checked by an independent BFS at every sampled stage. A segment's isolation is the
**max** over its vertices — "do I still have a way out?" is an existence question, so the last exit
to go is the one that matters — capped by the segment's own threshold, because once your street is
under water you cannot leave either.

**The topology was the entire story.** An earlier prototype built one edge per segment, endpoints
only. That graph collapses **8,987 vertices to 1,866** and fragments the corridor into **286
components (largest 183 nodes)** instead of **116 (largest 2,148)**. Under-connection removes paths,
so it reports isolation early. Running this implementation on the prototype's own graph reproduces
its published **152** trapped segments exactly; correcting the topology raises that to **230** and
drops the no-refuge count from 1,052 to 883. The max-vs-min aggregation choice makes **no
difference** on this data (230 either way), so the number rests on the topology alone.

*Two things we checked and did not need.* `unary_union` inserts **zero** new vertices across these
1,614 segments — the extract is already fully noded and 2,037 vertices are exact shared junctions,
so no geometric noding was required, only using all vertices. And 196 features are multipart with
parts that do not touch, so edges are built per part; chaining across parts would invent links
between fragments that do not touch.

**Caveats, and they matter.** Reachability is a road-network property, not a safety guarantee: a
refuge node is ground the modelled water does not reach at 50 ft — not a shelter, and not validated
against where people actually went. Absolute stages inherit the `−0.92 ft/mile` error above, so they
move when that primitive is fixed. The corridor is a **bounding-box clip**, so roads are cut at its
edge and escape to high ground *outside* the study area is not counted as an exit: treating the box
edge as an exit instead moves no-refuge 883 → 674 and trapped 230 → 408. Finally the refuge bar is a
choice, not a measurement — at 45 ft, 863 segments would have no refuge; at 55 ft, 910.

## 7. Routing — ways out to real destinations (`pipeline/derive/routing.py`)

§6 answers *"when do I lose my last way out?"* against any dry ground. That is the right
survival question but not an actionable one: it does not say **where** to go, and it does
not answer the question a household actually asks in an emergency — *can an ambulance
reach me?* This stage puts real destinations on **the same graph** §6 was computed on.

**The graph is imported, not rebuilt.** `routing.py` calls `isolation.build()` and asserts
its node/edge counts match `isolation.summary.json` — 8,987 nodes, 8,970 edges. If the two
builders ever drift, the run fails, because the routes the app draws must lie on the
network the isolation number describes.

**Destinations.** 59 hospitals, fire stations and police stations inside the corridor box
were fetched from OpenStreetMap (`pipeline/fetch/fetch_facilities.mjs`, cached to
`data/raw/osm_facilities.json`; Overpass answers only *light* node-only queries for this
box — adding `way` to the same query returns a 502/504 gateway timeout on the main instance
and every mirror tried, which is recorded in the script). A facility is accepted only when a graph node is within **400 m**
of it: **9 accepted, 50 rejected.** The rejections are the substance of the check — the
road extract is a bounding-box clip, so a Sugar Land hospital snapped to the corridor edge
would advertise a route along roads that were never modelled. The furthest accepted station
is 370 m from the network, the nearest rejection is 561 m, and the app states the snap
distance on screen.

**Method.** Edge cost is `metres + 1e6` when the segment is under water at the current
stage. A flooded edge is therefore *weighted, not deleted*: a dry route always beats a wet
one of any length, and when every route is wet the search still answers — "crosses water on
3 segments, deepest floods at 24.1 ft" — instead of returning nothing. The cut stage is the
widest-path (max-min) bottleneck to the facility set, the same one-pass descending
union-find §6 uses, seeded with the 9 facility nodes.

**Results at the shipped thresholds.**

| | segments |
|---|---|
| a modelled route to a responder at some stage | **806** of 1,614 |
| a modelled route to a **hospital** at some stage | **197** of 1,614 |
| lose that route **before their own street floods** | **609** |
| no route to a responder at any stage | 808 |

Median cut stage 30.0 ft (p25 29.4, p75 40.3). Largest gaps — help stops reaching you well
before the water does: **FM 762** (street 37.1 ft, cut **20.8**, gap 16.3), Town Center Blvd
(54.5 → 40.3), B F Terry Blvd (54.5 → 40.3), Macek Rd (34.3 → 20.8), Crabb River Rd
(32.5 → 20.8).

The 808 segments with no route at any stage sit in road-network **fragments the clipped
extract does not connect** — the same 116-component structure §6 documents. That is a limit
of the study area, not a real barrier, and the app says so verbatim rather than reporting
it as an emergency.

**Reverse routing.** "Can help get in" is the same field read outward from the responders:
a multi-source search seeded from all facility nodes. Because the road graph is
*undirected*, the physical path is identical to the forward route — the queries differ in
framing, not in geometry — and that symmetry is stated in the module and the summary rather
than dressed up as an asymmetry the data does not have. What the reverse direction adds is
concrete: it is the question that matters when you cannot drive out yourself, it names the
station, and it runs in one pass instead of one per destination.

**Two bugs this stage caught, and they are the argument for the gates.** First, the
aggregation inherited `widest_path`'s seed convention (`None` = "you are the destination"),
so a street that *touches a station* read as having **no route at all** — the exact opposite
of the truth. A facility node now carries its own road's threshold. Second, the app's
independent max-min Dijkstra came back infinite on every segment in the first browser run,
because it seeded the *query* node with Infinity instead of the *target set*: a query node
initialised that way reports an uncut route no matter what lies between it and the
destination. Both were caught by checks, not by reading.

**Verified.** 8 pipeline gates pass — graph identity with §6, snap bounds asserted in both
directions, BFS vs the bottleneck at 16 stages on all 8,987 nodes, the hospital set (a
subset) can never be cut before the responder superset, non-vacuity at 5 ft, and payload
array alignment. The artifact is byte-identical on re-run. And the app's own Dijkstra — a
second, independent implementation in another language — was checked **in a real browser**
against the pipeline's union-find bottleneck: **31 segments, 0 mismatches, max |diff|
0.000 ft.**

**Caveats.** A route is a corridor road-network path, not a driving instruction and not a
safety guarantee: the clip means a route cannot leave the study area, thresholds inherit the
`−0.92 ft/mile` HAND-as-stage error so cut stages move when that primitive is fixed, and OSM
facility positions are volunteer-mapped points rather than a dispatch feed — a station may be
closed or relocated.

## 8. Inundation bands — PROVISIONAL (`pipeline/derive/inundation.py`)

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

## 9. Forecast benchmark (`pipeline/models/forecast.py`, `lstm.py`)

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

## 10. Gauge-failure redundancy — and a trigger the data contradicts (`pipeline/derive/gauge_redundancy.py`)

What does the product report if RMOT2 goes down? Step 5 of the upgrade plan asked for the upstream
gauges to stand in, triggered at 2 hours of staleness. That method is built here and then measured,
and the measurement corrects the trigger.

**Method.** Richmond(t) ≈ T(upstream(t − lag)), where `lag` is the medians in §1 (Hempstead 48 h,
San Felipe 31 h) and T is a monotone piecewise-linear transfer fitted as the median Richmond stage
of 12 quantile bins of upstream stage. Piecewise-linear rather than the PCHIP used in
`gauge_rating.py`, deliberately: the identical interpolation is re-implemented in the browser, and
linear interpolation through bin medians is trivially reproducible in both languages — which is now
an asserted property, not a hope (see §7).

**The measurement, 5-fold leave-events-out over 20 flood events, 4,133 paired hours.** Three
estimators — the last observation you already have (persistence), the plan's upstream shift, and an
anchored variant that applies the transfer as a *change* from the last real reading:

| staleness | persistence | upstream shift | anchored |
|---|---|---|---|
| 2 h | **0.22 ft** | 2.52 ft | 0.22 ft |
| 6 h | **0.66** | 2.52 | 0.66 |
| 12 h | **1.32** | 2.52 | 1.28 |
| 18 h | 1.99 | 2.52 | **1.86** |
| 24 h | 2.66 | 2.52 | **2.37** |
| 30 h | 3.33 | 2.52 | **2.80** |
| 48 h | 5.35 | **2.52** | 3.63 |
| 72 h | 7.88 | **2.52** | 3.94 |

The upstream transfer errs a **constant** ~2.5 ft — it does not degrade with staleness, which is
exactly what makes it useful, but it also means that below about a day it is *worse* than the
reading already on the screen. **So the plan's 2 h trigger is wrong, and the regimes are derived
from the errors instead of chosen:** under 18 h the last observation (with its age attached),
18–30 h the anchored estimate, beyond 30 h the upstream estimate. At the crossover the anchored
variant wins, and it loses again by 72 h because its own anchor is then two days stale.

**The band is measured, not assumed.** The quoted uncertainty is the training-fold error IQR,
−1.56 / +1.01 ft, and its **out-of-sample coverage is 44%** against a nominal 50%. The honest
reading is that it is a 44% band, slightly under-covering because the error distribution drifts
between events; the run fails outright if coverage leaves 30–70%, so the band cannot quietly become
decoration. It is also **asymmetric and biased low**, i.e. the transfer slightly overestimates.

**A prerequisite with teeth.** T is fitted on USGS gage height and applied to NWPS values, and
`docs/DATA-SOURCES.md` documents a live "San Felipe trap" where one gauge appears in two vertical
datums. The module therefore re-checks NWPS against USGS on the cached upstream series **every
run**: they agree within **0.24 ft** over 29 overlapping days on both gauges (mean −0.008 and
−0.042 ft). A silent offset here would have become a wrong flood stage, so this is a gate, not a
footnote. It needs `nwps/{HPDT2,BAWT2}_stageflow.json`, now cached by `pipeline/fetch/fetch.mjs`.

**A defect the browser test found.** The transfer is fitted on flood events; at the time of writing
the river is at 9 ft, below the entire fitted range, so the estimate **clamps to the fitted floor**
(11.17 ft here) while the app was still quoting the flood-range band. That is a lie by omission —
the band does not describe a clamped value — so the app now names the clamped gauge and says the
number is a floor, not a value.

**In the app:** the `estimated` badge (striped, distinct from the severity pill), the band, a source
line reading `ESTIMATED · NWPS Hempstead → RMOT2 (stale 41 h)`, and an explicit note when the last
observation is the better answer explaining *why* the app is not estimating yet.

**Verified.** Gates pass: datum agreement, enough paired hours, monotone transfer, ordered derived
regimes, the shipped estimator beats persistence where it is used, band coverage measured in range,
and the largest lag + gap (120 h) fits inside the 719 h live observed window. The app's transfer
matches the pipeline's exactly on a 13-point grid for both gauges. All four staleness regimes were
driven **in a real browser** by shifting the clock: fresh, 11 h (last observation, no badge), 25 h
(anchored, both gauges, clamp disclosed) and 41 h (upstream shift, 11.17 ft, badge, clamp disclosed).

**Caveats.** The transfer describes 20 Brazos flood events, not the river in general; it is an
estimate of a stage, not a forecast; upstream gauges can fail independently of RMOT2, in which case
there is no estimate rather than a worse one; and a datum change at any of the three gauges
invalidates it silently — which is why the datum gate runs every build.

## 11. Harvey validation — the thresholds, adjudicated against observed flooding

*(§11 closes with the fitted error model `(L, sigma)`; §12 propagates it into the product.)*

Every number in §1–§10 is internally consistent. None had been checked against water that arrived.
Section 5 listed this as an **open QC item** ("validate thresholds against the USGS Harvey
observed-inundation layer before shipping") and section 5's R5 closed the observation route because
the only in-repo observation, 3,928 Harvey NFIP claims, is privacy-coarsened to 0.1° — six distinct
latitudes across the county. This stage reopens it with polygon data.

**Source.** USGS data release [doi:10.5066/F7VH5N3N](https://doi.org/10.5066/F7VH5N3N), the Brazos
the River item of *Characterization of peak streamflows and flood inundation … Hurricane Harvey*
(SIR 2018-5070). `pipeline/fetch/fetch_harvey_inundation.mjs` caches the 2 MB upper-reach package
to `data/raw/harvey/` with content assertions (zip magic and byte count, plus a string the payload
must contain), because ScienceBase answers errors with an HTML 200. The 377 MB depth raster is
deliberately not fetched: polygon intersection needs no raster.

**Three layers, all EPSG:6579:** the mapped inundation extent (`brazos_upper_final`, one polygon,
576 km² as shipped and **not OGC-valid** — repaired per-part with `buffer(0)` rather than dropped),
the mapped area boundary (948 km²), and 44 surveyed high-water marks with NAVD88 water-surface
elevations, 35 of them on the Brazos main stem. The release readme states the extent is *"derived
from the water-surface elevation surveyed at high-water marks"*, interpolated with ESRI Topo to
Raster. **It is a survey-anchored estimate, not a satellite water edge, and one maximum extent
rather than a time series.** Everything below is bounded by that.

**Method.** Predicted flooded at the Harvey peak if `flood_stage_ft <= 55.15 ft` (the observed RMOT2
maximum, from the same cached USGS series the app's replay uses); observed flooded if the segment
geometry intersects the extent. The evaluated set is the **1,187 of 1,614 segments whose centroid
lies inside the mapped boundary** — the release supplies no observation outside it, so scoring those
segments would manufacture both error types.

| | observed flooded | observed dry | total |
|---|---|---|---|
| model flooded | 414 | **686** | 1,100 |
| model dry | **0** | 87 | 87 |

accuracy **0.422** · false-positive rate **0.887** · recall **1.000** · precision **0.376**. Modelled
prevalence 92.7%, observed 34.9%. Restricting by *any part* of a segment inside the boundary instead
of the centroid moves this to 0.417 accuracy, and scoring the whole corridor without the boundary
restriction gives 0.417 — the headline is not an artifact of where the boundary was drawn.

**The errors run one way only.** Zero false negatives: no segment was observed flooded that the model
called dry. The defect is an inability to say "dry", never a false all-clear.

**Discrimination works; calibration does not.** As a ranking score the threshold gives **AUC 0.809**
(observed-wet median 30.6 ft against observed-dry 37.6 ft). The HAND height genuinely separates
ground that flooded from ground that did not. What fails is the mapping from HAND to gauge stage.

**The magnitude, and its functional form.** The stage best reproducing the extent is **32.85 ft
against an observed peak of 55.15 ft — a lift of +22.3 ft** (accuracy 0.422 → 0.769, FPR 0.887 →
0.230). Fitting on one half of the corridor and testing on the other:

| fitted correction | test accuracy | FPR | recall |
|---|---|---|---|
| none | 0.440 / 0.387 | 0.993 / 0.746 | 1.000 / 1.000 |
| constant offset | **0.709 / 0.844** | 0.229 / 0.069 | 0.629 / 0.444 |
| offset + along-river slope | 0.622 / 0.831 | 0.018 / 0.006 | 0.158 / 0.083 |

(upstream→downstream / downstream→upstream.) **The constant transfers; the linear form does not,
and its recall collapses** — it is a bad model that happens to score well only by predicting almost
nothing wet. This independently confirms R3's corrected premise in `threshold_correction.py`
("under normal flow the physical correction is a constant offset") and contradicts the shipped
summary's account of the error as the −0.92 ft/mile trend. The trend is real in the thresholds
(**−0.826 ft/mile, r = −0.503** recomputed on the evaluated set) but it is not the shape of the
error.

**Two closed routes predicted this.** R2 recovered a **+24.7 ft** constant between the gauge reach's
`dem_adj_elevation` (51.4 ft) and the gauge's own zero datum (26.73 ft), and closed as
irreconcilable. R1's median lift over all segments is **+25.1 ft**, set aside because nothing could
say whether the magnitude was right. The extent says **+22.3 ft**: **Δ +2.41** and **Δ +2.78** from
entirely different inputs. The datum gap was the signal, not a nuisance. This also settles R1's open
question in the negative — for State Highway 6, the Grand Parkway and US 90A its conversion lands
**8.3–9.0 ft short** of what the observation requires, which is why it redistributes the below-action
set instead of lifting it.

**What Harvey reached, on the roads §5 already flagged:** US Highway 90A 13/56 (23%), East US Highway
90A 33/71 (46%), West Grand Parkway South 11/26 (42%), State Highway 6 South 29/35 (83%) — against a
model that calls all four 100% flooded.

**A blind spot that is stated rather than exploited.** 20 segments sit below the 20 ft action stage,
and Harvey reached 17 of them (85%). That looks like vindication of §5's most criticised number and
it is **not**: a segment observed wet at the record peak is equally consistent with flooding at 17 ft
and at 55 ft. A point-in-time extent carries no information about a low threshold — it can only
*refute* thresholds it found dry. Adjudicating those 20 needs a series of extents at successive
stages, which this release does not provide.

**What applying it would score, since that had never been measured.** The decision not to apply the
correction was argued from principle — one event, no second flood to test on — and the *price* of that
decision was never priced. So the same test the shipped thresholds had just failed is run on the
corrected rule, `flooded iff (threshold + lift) <= peak`, on the same 1,187 outcomes:

| rule | accuracy | false-positive rate | recall | precision |
|---|---|---|---|---|
| shipped | 0.422 | 0.887 | **1.000** | 0.376 |
| corrected, best-cut lift (+22.30 ft) | **0.769** | 0.230 | 0.768 | 0.641 |
| corrected, probit lift (+23.72 ft) | 0.760 | **0.153** | 0.597 | 0.677 |

This is **in-sample** — fitted and tested on the same 1,187 outcomes — so it is an upper bound on
what the correction would do, and the out-of-sample spatial holdout above (0.709 / 0.844) is the
weaker, honest test. The trade is visible in one column: the correction buys the ability to say
*DRY* at the price of **167 segments that flooded and would now be called dry**, against zero misses
for the shipped rule. For a life-safety product that is not obviously a good trade, and one event
cannot say which is right. It is recorded in `correction_would_score`.

**No correction is applied**, on the same principle that closed all five routes: a constant fitted to
one event, with no second event to test it on, would be a new unvalidated number replacing an old
one. `threshold_correction.py` now cross-checks `harvey_validation.json` at run time, so the two
artifacts cannot drift into different stories about the same thresholds, and its `to_reopen` item
"observed inundation extent for Harvey as polygons" is marked satisfied. Gates now require the
corrected rule to actually improve accuracy and the false-positive rate on the fitting event (or the
lift would not be the lift), to never recall more than a rule that floods everything, and its
implied cutoff to stay within 3 ft of the independently fitted best-cut stage.

**Verified.** All gates pass: the release's extent is asserted to be OGC-invalid as shipped (so the
repair path cannot silently become dead code), the evaluated set is non-trivial, no segment outside
the mapped boundary intersects the extent, the confusion cells sum, the FPR is a proportion, and the
AUC is asserted above chance — because if the threshold ever stopped discriminating the observed
extent, that would mean *the comparison* had broken, not the model. The artifact is byte-identical on
re-run. `threshold_correction.py`'s closures are numerically unchanged by the cross-check.

### The error model — a bias *and* a spread, and only the first is a correction

The best-cut search gives one number, the constant the corridor is off by. That number is precise and
it is not the uncertainty a household faces. So the same 1,187 observed outcomes are refitted as a
probit, modelling the true flood stage of segment *i* as `tau_i = T_i + L + eps_i` with
`eps ~ N(0, sigma)`, and `P(wet_i) = Phi((S - L - T_i)/sigma)` — identified from the cross-section
even though each segment contributes a single binary observation:

| quantity | value | 90% CI (bootstrap over segments, seeded) |
|---|---|---|
| lift `L` (the bias) | **+23.72 ft** | +22.90 .. +24.60 |
| **per-street spread `sigma`** | **+11.36 ft** | +10.03 .. +12.73 |

The two estimates of the lift agree to **1.4 ft** (best-cut +22.30, probit +23.72); they optimise
different objectives, so exact agreement would be a coincidence, and both are recorded in
`estimators_of_the_same_lift` so neither can be quoted as *the* number without the other.

`sigma` is the larger and more consequential quantity, and it is **not** a bias — no offset corrects
it. It says two streets the model assigns the same threshold can be 11 ft apart, which is why the
corrected model is still only ~76% accurate. It is also a **limit**: it is unexplained variance from
ONE event, so it absorbs genuine per-reach differences (culverts, levees, the HAND reference error),
any error in the extent itself, and everything this model cannot see. A gate requires it stay above
1 ft, because a collapsing sigma would contradict the measured per-segment error rate.

**Limits.** One event, one extent: this measures agreement with the best available reconstruction of
Harvey and cannot be repeated on another flood from data in this repo. The extent is interpolated
from 44 high-water marks and clipped to a boundary that the readme says was lined up with the extent
itself, so it may under-represent the flood — which would *inflate* false positives; most of them sit
near the separating threshold (median 36.4 ft, p10 30.3 ft) rather than far below it. It is the event
maximum against the gauge maximum, so the downstream crest travel time of §1 is not resolved. Roads
are lines, so any part of a segment inside the extent counts as flooded — which matches what a
threshold means (a low point submerging) but not a road that is mostly dry. And absolute stages still
inherit the very defect this test measures; that is the point, not an escape from it.

## 12. Uncertainty ensemble — lead time as a distribution (`pipeline/derive/ensemble.py`)

§11 ended with two fitted numbers, and they play different roles. The lift (+23.72 ft) is a **bias**
one corrects. The per-street spread (**sigma = 11.36 ft, 1 sd**) is **not** — no offset removes it,
and it is why the corrected model is still only ~76% accurate. Two streets the model puts at the same
stage can be eleven feet apart. That is the uncertainty a household actually faces, and a point
estimate cannot express it, so this stage asks the question 50 times.

**Method.** Per member: draw the street's true stage as `threshold + L + sigma*N(0,1)`; perturb the
forecast points by a random walk whose cumulative sd at each horizon equals the *measured* RMSE there
(1.16 ft at +1 d, 2.16 at +2, 3.57 at +3, 5.37 at +5, 6.06 at +7, from the benchmark in §9), leaving
observed points untouched; then take the first crossing. Report the count that cross, the quantiles
over those that do, and the number that never arrive.

| street threshold | point estimate | ensemble | spread source |
|---|---|---|---|
| 20 ft | 129 h | 42/50 cross, median 152 h [140–173] | threshold only (replay) |
| 30 ft | 138 h | **27/50**, median 162 h [147–216] | threshold only (replay) |
| 45 ft | 158 h | **4/50**, median 186 h | threshold only (replay) |
| 50 ft | 169 h | **0/50** | threshold only (replay) |

On the replay hydrograph the spread is **entirely** threshold-driven, because the series is observed
rather than forecast: 27/50 cross at a 30 ft threshold, against 50/50 with the lift and sigma both
zeroed. That is the whole finding in one comparison — the same evidence that says the thresholds are
low also says we cannot be certain a given street floods at all.

**The algorithm is implemented twice, and the app reproduces the pipeline exactly.** This is the same
check the crest transfer and the Dijkstra already get, and it is the reason the ensemble is auditable
rather than asserted: `app/src/main.ts` mirrors `ensemble.py` line for line, both use mulberry32
(`Math.imul` is the low 32 bits of the product, which is why the Python side masks) with Box-Muller,
and drawn values are rounded to 6 dp on both sides so that libm and V8 differing in the last ulp
cannot move a draw across a hydrograph point and change a reported count. The pipeline emits a
**16-row verification grid** — 8 thresholds x {observed-only, a slice treated as forecast} — and the
app matches **every row on the crossing count and all three quantiles**, including the rows that
exercise the forecast-error path. Note the quantile convention had to match too: numpy's default
`linear` interpolation is `(n-1)*p/100`, which the TypeScript side reimplements rather than
approximating.

**Gates:** the forecast-error curve passes through its measured knots and is asserted monotone in
horizon; the PRNG is asserted reproducible; a higher threshold must never cross more often (the
ensemble is asserted not inverted); a crossing count cannot exceed the member count; quantiles must be
ordered; and the grid must contain at least one uncertain row, so a silently-degenerate ensemble
fails the run. The bootstrap that produced `sigma` is **seeded**, and the artifact is byte-identical
on re-run including it.

**In the app** the block sits under the point estimate, headed *"Uncertainty · with the measured
threshold error applied"*, and says in the panel why the two disagree — at the peak stage the headline
floors at 0 h while the ensemble says most runs never arrive, and the block reconciles them by naming
the shipped threshold, the corrected one, and the fact that the correction is measured from one event
and deliberately not applied. The block is reported **beside** the point estimate, never in place of
it. The ensemble does not move the drag — it is cached on the selection and never recomputed while the
stage moves — and that is counted rather than timed (24 steps produce 0 of the draws a run needs).
The published render figure was **6.2 ms** median over 24 slider steps, max 13 ms, measured on an idle
machine; for the re-measurement after the bet cards landed, see §17.

**Limits.** This is not a probability of flooding and not a confidence interval on a measured
quantity: `sigma` is unexplained variance from a single event. The forecast-error curve is measured
on this gauge's *daily* record and is applied here to an *hourly* hydrograph; beyond the +7 d knot it
is held flat rather than extrapolated, which is conservative. Replay carries no forecast uncertainty
because its hydrograph is observed, so that spread understates what a live forecast would carry. And
the ensemble inherits §11's dependence on one event: it distributes the error that was measured, it
does not make that error smaller.

## 13. Harvey backcast — the lead time, counted (`pipeline/derive/backcast.py`)

§12 answers with a distribution, but every number in this project is still a forecast of a flood that
has not happened yet, scored against a single observed instant. The app's headline is a **lead time**
— *"water reaches your street in 96 hours"* — and no artifact had produced one for the flood that
actually occurred. This stage runs the app's own rule backwards over the observed record: an hourly
mean resample of USGS `08114000`, 2017-08-22 00:00 to 09-01 00:00, 241 points — the same series the
app's replay mode loads, so the backcast is computed on the app's own data rather than a second
resample of the same file.

**What is observed and what is not — this is the whole design.** The record yields two things that are
pure observation: when the gauge crossed each NWS category, and the crest. It yields **no per-street
timing at all**, because the only street-level observation in the project is one event-maximum extent
(§11) and a single instant cannot say when water arrived anywhere. So the artifact reports onsets and
lead times that are observed, and marks the street-level onset that precedes them as the model — in
its schema (`validated_per_street: false`), in the app panel, and in its own limits. The replay window
also ends **two hours after the crest**, so the recession is not observed at all: the artifact says
when tiers were *crossed* and never claims when they *cleared*.

| tier | onset | before the crest | hours above |
|---|---|---|---|
| action 20 ft | Aug 27 09:00 | **109 h** | 112 |
| minor 45 ft | Aug 28 14:00 | 80 h | 83 |
| moderate 48 ft | Aug 28 21:00 | 73 h | 76 |
| major 50 ft | Aug 29 01:00 | 69 h | 72 |

Across the corridor, the app's own alert for each segment — the first observed hour at or above its
shipped threshold — landed **96 h before the crest** at the median (69 h at p10, 102 h at p90),
with **1,469 of 1,614** segments reaching their threshold inside the window. Four days of warning is
the product's claim, and Harvey is the one event where it can be counted instead of asserted.

**The flag counts are §11's defect expressed over time, and the trade has a price on both sides.**

| stage | segments flagged, shipped | with the measured correction |
|---|---|---|
| 20 ft (action) | 22 | **0** |
| 45 ft (minor) | 1,232 | 32 |
| 50 ft (major) | 1,337 | 59 |
| 55.13 ft (crest) | 1,469 | 500 |

Applying the lift is not a free improvement: it would **silence 969 of the 1,469 streets** the shipped
rule warns in time at all within the window, and delay the rest by a **median of 71 h** (p90 88 h).
What it buys back is measured on the peak in §11 — accuracy 0.422 → 0.760, false-positive rate 0.887 →
0.153, against **167 genuinely flooded segments that would be reclassified dry**. So the standing
decision not to apply the correction now has a measured cost on each side rather than an argument on
one. Note the two populations are not the same and are not added together: the 969 is over all 1,614
corridor segments, the 167 over the 1,187 inside the mapped boundary.

**Implemented twice, like the ensemble.** `app/src/main.ts` recomputes the tier onsets from its own
replay series and the flag counts from its own road list, then checks both against the grid the
pipeline emits — **13 stages x {shipped, corrected} plus 4 tier onsets, all 17 rows matched**. That is
the same cross-language check the ensemble, the crest transfer and the Dijkstra get, and it is why the
timeline is drawn from arithmetic the browser performs rather than from numbers it was handed.

**Gates.** The series must be hourly; the hourly crest must agree with the published 15-minute peak
(55.15 ft) to within 0.05 ft, so two artifacts cannot quietly disagree about one flood; the crest must
fall in the second half of the window, so a truncated record cannot pass as the build-up; every tier
must be crossed, in stage order, inside the window, with hours above it; flag counts must be monotone
in stage and the corrected count never above the shipped one; the curve must actually rise; the
lead-time quantiles must be ordered and non-negative; correcting a threshold must never alert
*earlier*; and the correction must silence **some but not all** warned streets — a trade-off that is
not being measured fails the run.

**In the app** the block appears in replay mode as *"What BrazosCast would have sent"*, one bar per
category drawn from its onset **to the crest**, so the bar length is literally the lead time, with the
lead time labelled. The stage slider then answers a different and consistent question — *at 51.00 ft
the app flags 1,355 of 1,614 segments; with the measured correction, 79* — which is why the block
reacts to the slider without pretending the slider is a clock. Its render cost is small and was
measured after the change: the timeline DOM is built once and cached, the per-render work is one pass
over the 1,614 segments, and 24 slider steps cost a median **4 ms**, max **6.4 ms** — inside the range
the ensemble block was recorded at (§12).

**Limits.** No per-street timing here is validated, and the lead time is measured to the **gauge**
crest: the crest travels downstream during the event (§1), so a street below Richmond crests later
than the gauge it is keyed to. The recession is outside the window. The flag counts inherit the
threshold defect this stage measures rather than fixes, and the corrected counts apply a constant
fitted to one event — which is exactly why they are reported and not shipped. One event: this backcast
cannot be repeated on another flood from data in this repo.

---

## 14. Islands — which side of the cut (`pipeline/derive/routing.py`, `app/src/lib/islands.ts`)

Routing answers "can I reach a named destination". This asks the graph a different question, and it is the one a household actually asks in the first hour: **"which roads can
I still move between at all?"** At a given stage, the edges whose segment threshold is still above
that stage partition the network by union-find over the dry edges; the piece your street lands in is
the ground still drivable from it without crossing water, and the wet segments on that piece's border
are the ways off it. The border is drawn on the map, because the cut is the smaller set and the one
the question is about.

**Two readings of one implementation, so the rule cannot be right in one place and wrong in the
other.** `app/src/lib/islands.ts` computes the partition once (`sweep`) and reports two views from it:
the pipeline's own row shape (`ladderRow`), recomputed row by row in `app/tests/unit/islands.test.ts`
against `routing.summary.json` — 22 tests — and the single island a household is asking about
(`islandForSegment`). The stage comparison is `ft > stage`, the same one the map filter and
`isolation.widest_path` use.

**What the measurement forced, and it is not a flood result at all.** At 0 ft — no flooding anywhere
in the model — the extract is **already 116 separate networks**, and only **806 of 1,614** segments
sit on a fragment that contains a modelled responder. That is the bounding-box clip, not water. So
this is **reachability, never enclosure**, `islands_touching_the_clip` exists so the app can say when
an island ends at the edge of the study area instead of at a river, and a street marked "no modeled
route to a responder" is not a street that is trapped.

| stage | components | largest island (nodes) | largest island (segments) | dry segments | dry with a responder | islands at the clip | segments on >1 island |
|---|---|---|---|---|---|---|---|
| 0 ft | 116 | 2,148 | 337 | 1,614 | 806 | 19 | 3 |
| 5 ft | 116 | 2,148 | 337 | 1,614 | 806 | 19 | 3 |
| 12 ft | 128 | 2,148 | 337 | 1,612 | 806 | 19 | 3 |
| 20 ft | 212 | 2,083 | 326 | 1,592 | 795 | 19 | 3 |
| 30 ft | 1,860 | 1,836 | 301 | 1,349 | 391 | 78 | 4 |
| 40 ft | 5,673 | 1,470 | 251 | 480 | 276 | 139 | 1 |
| 45 ft | 6,552 | 698 | 107 | 382 | 128 | 155 | 1 |
| 50 ft | 7,310 | 596 | 97 | 277 | 118 | 163 | 1 |
| 55 ft | 7,978 | 338 | 44 | 146 | 65 | 163 | 1 |

The numbers above 30 ft move fast — 1,860 networks at 30 ft becomes 7,978 at 55 — which is the
corridor coming apart into single streets as the low crossings go under.

**The straddling rule.** **286 of the 1,205 distinct ways** in the road layer carry more than one
segment (one carries seven), and the clip cuts features into further pieces, so a single segment's
nodes can land on two islands. Counting it twice would inflate the reachable ground; dropping it
would understate it. So `reach` counts **touching** (published as a column above), `segs` attributes a
straddling segment to **one** island by a stated rule (most nodes, then lowest island id), and
`segments_touching_more_than_one_island` publishes the size of the over-count — 3 at low stage, 1 at
high. A segment cannot silently move between islands, because the number that would move is on screen.

**The refuge bar is a choice and is labelled as one.** "Dry ground at 50 ft" is a hand-set bar, not a
measurement, so the artifact carries its sensitivity: with the bar at 35/40/45/50/55 ft, **393 / 705 /
863 / 883 / 910** segments have no dry refuge reachable at all. The app says *refuge*, never *shelter*.

**Limits.** Reachability on a clipped extract, not enclosure by water; routes are network paths, not
driving instructions and not a safety guarantee; the thresholds the cut stages inherit the
HAND-as-stage error measured in §11 (−0.92 ft/mile), so the stages move when that primitive is fixed;
and the destinations are volunteer-mapped OSM points, not a dispatch feed.

## 15. A second observed flood — refutations from below, and a constant that does not transfer (`pipeline/derive/second_event_validation.py`)

§11 ends with the one thing the project could not answer: the thresholds are wrong by **+22.3 ft**
(best-cut) / **+23.72 ft** (probit), both fitted to a single event, and `UPGRADE-PLAN.md` calls a
second observed extent the highest-value outstanding item. This is that extent — and it does not
confirm the correction; it **replaces** what the defect is.

**Choosing the event was measurement, not preference.** The 2015 and 2016 floods were ranked off the
cached Richmond record first (54.74 and 50.01 ft against Harvey's 55.19), then the USFIMR catalogue
was searched for a machine-readable product over this reach. It holds exactly one: **2016-05-30**, a
Sentinel-1 HV water edge at 10 m, **214.9 km²** mapped, three days *before* that event crested. Two
properties make it worth more than a second maximum:

* **its stage is pinned, not assumed.** The layer's own attributes carry the acquisition time
  (00:26:20 UTC), and the validation reads the cached USGS 08114000 instantaneous series at that
  instant: **49.40 ft**, with 15.7 ft of clearance below Harvey's peak. The cross-check is independent
  of the gauge reading: the layer's own `Q_at_Image` (**80,600 cfs**) run through the rating curve
  Step 3 fixed lands at **48.19 ft**, within **1.21 ft**.
* **being lower, it can refute.** At 49.40 ft a segment the image shows **dry** has a true threshold
  above 49.40; that is a bound from below, which a maximum extent can never supply. **1,241**
  segments are shown dry that the shipped rule submerges at that stage, out of 1,614 evaluated.

**What it found.** Harvey's lift applied out of sample repairs **1,190** of those 1,241 refutations,
at a recall of **0.055** against the shipped rule's **0.973** — i.e. it buys silence. The within-event
**AUC collapses from 0.809 (Harvey's maximum extent) to 0.566** on Harvey's own 1,187-segment
population. A constant offset is rank-preserving, so that is the decisive number: **no shift of any
size can fix an ordering.** The event's own best cut is degenerate (at 4 ft: recall 0.0), its
balanced-accuracy optimum implies a lift of **−2.05 ft**, and the under-mapping sensitivity says the
refutations would need the radar to have missed water by a factor of **17×** to be explained away.

**So the defect is reclassified, not fixed.** It is not only a level error (that is what §11 measured)
but an **ordering** error at a lower stage, and the correction stays unapplied for a stronger reason
than "one event only". The README's 22 ft figure still stands, labelled as the single-event
measurement it always was, and the app's disclosure is unchanged.

**Limits.** One instant on a rising limb — not a series, so a segment shown wet says nothing about
where between 0 and 49.40 ft it flooded; a radar water edge with vegetation, smooth-water and
wind-roughening failure modes, ground-proofed from secondary sources rather than surveyed; the
polygon bounds the **water**, not the scene, so every "dry" reading rests on the scene having covered
that ground (the conservative near-water variant is reported beside the corridor-wide one); one gauge
on a reach whose crest travels; and the thresholds under test still inherit the §11 defect this
section measures and does not fix.

**In the pipeline and the docs.** `pipeline/fetch/fetch_usfimr_2016.mjs` caches the layer with a
receipt (zip magic, shapefile members, the catalogued mapped area as a gate);
`pipeline/derive/second_event_validation.py` writes `data/derived/second_event_validation.json` and
gates on the area, the join, the refutation count, the implied lift and the under-mapping factor;
`pipeline/tests/test_second_event.py` holds the contract. The app shows none of it directly — it is
evidence about the thresholds, and the README quotes it.

## 16. The alert — three tiers, two languages, and a schedule that can be checked (`pipeline/derive/notifications.py`)

Everything above is something *read*. This is the part that is supposed to **reach** someone: the
message. The send is simulated — no carrier, no opt-in, no phone number in this repository — because
what a repository can verify is the text and the timing, and those are what go wrong in a way nobody
notices until the night it matters.

**The ladder was chosen against the obvious design, by measurement.** The plan said to tie the alerts
to the official categories in `TH = {action: 20, minor: 45, moderate: 48, major: 50}`. The 2017 record
says what that would do: the three flood categories arrived at hours 158, 165 and 169 — **7 and 4
hours apart**, i.e. three texts in one night — and none of them would say anything about the reader's
own street, because the reader's street floods at its own number. So the tiers are a countdown from
**that street's own modelled crossing**: T−72 h ("3 days out"), T−24 h ("1 day out"), T−6 h ("6 hours
out"). The official category still appears inside every message as context at the hour it is sent,
which is what "ties to the tiers in TH" is worth once it is measured.

**What the simulation did.** Over the same replayed hydrograph the backcast uses, all **1,614**
modelled streets went through the policy and **1,469** of them cross their own threshold inside the
window — the same population, by the same rule, that §13 reports. They produce **4,407 messages**,
three each: none duplicated (keyed on segment *position*; keying on osmid produced 1,086 phantom
duplicates on the first run, because one way can contribute several segments), none arriving after
the water it is about, longest rendered message **279 characters** — two SMS segments, in Spanish as
well as English.

**Quiet hours, and an arithmetic that makes one rule unreachable.** 22:00–07:00 local holds the first
two tiers to 07:00 and never the 6-hour one; **225** sends per held tier were moved. The rule for a
hold that would land *after* the crossing is to drop the message rather than send it late — and at
these offsets it is unreachable, which is a property rather than luck: the longest hold (22:00 →
07:00) is **9 h** and the shortest held tier is **24 h** out, so a held message always still precedes
the water. It is kept as a guard, counted separately (`held_past_crossing`, 0).

**The translation is the feature, so the numbers have to survive it.** A Spanish message that says 48
where the English says 45 is worse than no message, and nothing on screen would look wrong. The
templates are compiled once at build time (`pipeline/notify/templates.json`) and filled by **two**
implementations — the pipeline in Python, the browser in `app/src/lib/notify.ts` — and the tests
require the digit **multisets** to match, not merely the sentences. That is why the crossing time is
12-hour in both languages (`Aug 26, 2 PM` / `26 ago, 2 pm`): a 24-hour Spanish time would be better
Spanish and would put *different numerals* in the two messages, so the parity gate would be comparing
two clocks instead of two translations. The card's own chrome (title, note, quiet-hours line) is
translated from the same artifact, with a test that no Spanish UI string is still the English one — a
half-translated surface is the failure mode that makes bilingual UI worse than monolingual.

**What is observed and what is not.** The hydrograph is observed, so every send time is hindsight: the
schedule is what the policy *would have* done. In live mode the same rule reads the NWPS forecast,
whose error is measured in §11 and is not re-scored here. The street crossing itself is the model's,
and §15 shows its ordering is weak at a lower stage (AUC 0.566), which the alert inherits — which is
why the message says *modelled* and not *will flood*. The alert also uses the street's **threshold**,
not the earlier stage at which its last dry route is cut (§6); for a street whose way out closes
first, the actionable number is the isolation one, and that is on screen rather than in the message.

**In the pipeline and the app.** `pipeline/notify/templates.json` (the text, both languages),
`pipeline/derive/notifications.py` (the policy, the simulation, the artifact),
`data/derived/notifications.json` (shipped unchanged), `app/src/lib/notify.ts` (filling and schedule,
no DOM), the card in `app/src/main.ts` and `app/index.html`, and tests on both sides:
`pipeline/tests/test_notifications.py` (18), `app/tests/unit/notifications.test.ts` (13) and
`app/tests/e2e/alert.spec.ts` (3), plus eight mutants of the templates and both renderers in
`scripts/mutants/notifications.mjs` — each fails the named test that owns it.

## 17. The bets — I2–I6, and the two defects measuring them found

`docs/ACTION-PLAN.md` §4 listed five post-submission bets and the quiet-river half of F1. All six are
built: each is a kernel in `app/src/lib/` (so it is testable without a browser), a card, and tests on
both sides — `app/tests/unit/bets.test.ts` (23) drives the kernels, `pipeline/tests/test_bets.py` (8)
holds the artifacts they read.

**What each one is, in one line.** *What the river would have to do* (F1's other half): the stage a
street needs and the last year the gauge reached it, from the USGS annual peak record
(`pipeline/derive/gauge_history.py`, 111 peaks 1884–2025, highest 61.20 ft in 1913) — annual maxima, so
"last reached" is exact for the question asked, and filtered to the gage-height parameter because the
same file carries discharge peaks in different units. *Two gauges, one answer* (I2): the upstream
transfer run whenever the gauges are reporting, against the band measured on held-out events. *Does the
answer survive* (I6): the lead time re-run under the per-street sigma, the corridor lift, the forecast
RMSE at the horizon the answer lands on, and a 72 h horizon. *Dry road, no way out* (I5): the inverse
set — route to help already cut, own street still dry. *Per-street backcast* (I3): the selected street's
own 2017 lead time, recomputed in the browser against the pipeline's 1,614-entry array. *Your own
forecast* (I4): any pasted series run through the app's own rule, observations kept.

### The first defect: one segment in 1,614, and it was a rounding tie

I3 publishes `street_lead_time.per_segment_h` — the per-street half of the backcast — and the browser
recomputes the selected street's own lead time and compares. The full-corridor comparison caught a
disagreement at **one segment of 1,614** (index 962, threshold 52.3 ft: 49 h against 48). The cause was
not the rule. The app is served the replay hydrograph rounded to 2 dp
(`pipeline/export/app_data.py`), and the artifact was being computed on unrounded values, so an hour
reading 52.298 ft crossed a 52.3 ft threshold in the browser and 52.298 < 52.3 did not in the pipeline.
The fix was to compute the artifact on the series the app actually receives — and doing that exposed the
second half of the bug: **numpy's `round` is not Python's `round` at a tie.** `55.135` became `55.14`
under `np.round` and `55.13` in the payload, which moved the crest by one hour,which moved *every* lead time at once (the rounding then showed up as a different single row). Both numbers were
self-consistent; only one could be shown. The artifact now rounds with the same call the payload does,
the corridor comparison is **0 mismatches over all 1,614 segments**, and the artifact's crest, the
payload's peak and `harvey_validation.json`'s observed peak all read 55.13–55.19 ft on the same flood.

### The second defect: a false alarm that only a browser could show

I2's first version reported *disagreement* whenever a divergence fell outside the band. Measured live at
8.60 ft: Hempstead 9.56 ft → an estimate of 11.17 ft, San Felipe 93.13 ft → 10.59 ft, divergences +2.57
and +1.99 ft — **both flagged, permanently, on a quiet river.** The transfer is fitted on flood events,
so at a low stage every knot clamps to a floor value; the "estimates" were the ends of the fitted curve,
not predictions of the river. Two changes: a clamped row can never count as agreement *or* as
disagreement (it is labelled *out of range*), and the verdict only counts gauges inside the fitted range.
A check that cannot be made is not a failure — and putting a permanent ⚠ beside the one number the page
is about would be worse than not checking at all.

### The inverse set is a lens, not a list

I5's membership rule is an inequality with two sides — route cut *and* street still dry — so the count is
the gap between two curves and is **not monotone in stage**. Measured on the shipped thresholds:
**6** segments at 20 ft, **5** at 25, **294** at 30, **23** at 34, **10** at 40, **116** at 45, **52** at
50, **12** at 55. The peak at 30 ft is where most routes are already cut (the median street floods at
33.4 ft) and most streets are not yet wet; by 35 ft the flood curve has overtaken it. The worst trapped
window is 16.3 ft, and at 30 ft **142** of the 294 have no modelled hospital route at that stage either.
A card that assumed monotonicity would have looked fine and described the wrong population.

### What the four cards cost the drag

Measured **by A/B against the previous commit** — `git worktree add /tmp/bc-base HEAD`, the same
`perf.spec.ts`, the same machine, back to back — rather than against a remembered number:

| | before (HEAD) | after |
|---|---|---|
| live, median over 24 steps | **8.8 ms** (max 11.5) | **11.1 ms** (max 13.6) |
| replay, median | **11.2–11.6 ms** (max 13.6) | **13.9 ms** (max 22.0) |

The published figure is 6.2 ms and this machine no longer reproduces it on *unchanged* code (8.8 ms), so
the meaningful number is the delta: **+2.3 ms live, +2.5 ms replay**, from ~20 more DOM rows per step.
The kernels are not the cost: the cut-set join over 1,614 segments measures **0.3 ms**, and an
optimisation that cached its sorted index across stages was written, measured, and **reverted** — it
bought nothing and would have left two implementations of the membership rule (the app's filter and the
kernel's), which is the failure mode this repo keeps finding. The suite's budget stays at 40 ms, which
is ~3× the worst observation and ~2× the new median.

**Limits.** I4's series is the user's own and is not validated by anything here — it moves the lead
time, not the confidence. I5's set is modelled on the study-area extract, so a street the extract cannot
route a responder to is excluded rather than reported; a real dispatch feed would change that set. I2
cannot check the reading when the river is below the transfer's fitted range, which on the day this was
written it was. I6 perturbs with measured errors but does not combine them: the rows are one-at-a-time,
so a threshold error *and* a forecast error at once is not among them. The quiet-river answer inherits
the 22 ft threshold bias like every other stage number in the product — it is the *stage* that is
biased, also in the direction of saying a street is reached later than it is.
