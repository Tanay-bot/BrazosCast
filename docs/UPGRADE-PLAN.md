# BrazosCast — upgrade & fix integration plan

Written 2026-10-14 against `baba9c0`, integrating `brazoscast-review.md` and
`brazoscast-upgrades.md`. Read alongside [PLAN.md](./PLAN.md) (the original build
plan) and [FINDINGS.md](./FINDINGS.md).

Every claim below was checked against the artifacts in this repo before being
planned, and where a document was wrong the correction is stated. Numbers are
reproducible with the script named.

---

## Part A — What I verified, and what the documents got wrong

### A1. The severity finding is correct. Reproduced exactly.

The derivation treated `threshold_hand_ft` as the Richmond gauge stage directly.
The output says (**pre-fix baseline** — this is the state the review saw, reproduced
from the original derivation; the shipped figures after Step 1 are in A6):

| gauge stage | segments under | share |
|---|---|---|
| 9.2 ft | 0 / 1614 | 0.0% |
| 20.0 ft (action) | 25 / 1614 | 1.5% |
| 33.4 ft | 811 / 1614 | 50.2% |
| 45.0 ft (flood) | 1234 / 1614 | 76.5% |
| 50.0 ft | 1338 / 1614 | 82.9% |
| 55.1 ft (Harvey peak) | 1472 / 1614 | 91.2% |

The three lowest named roads were `State Highway 6 South 14.2 ft`,
`West Grand Parkway South 15.2 ft`, `East US Highway 90A 16.5 ft` — the three
major Brazos crossings. The regression the review quotes reproduces too:
`slope = -0.918 ft/mile, r = -0.636`. The diagnosis of *severity* stands.

### A2. The review's proposed mechanism and its fix do not hold up.

- **The tags do not exist.** `osm_roads_subset.gpkg` columns are exactly
  `['osmid','highway','name','huc8','catchment_id','osmid_catchid','geometry']`.
  No `bridge`, no `layer`. The proposed fix has nothing to read.
- **The fallback fix is inert.** "Exclude segments whose geometry intersects the
  NWM mainstem line": **0 of the 20 offending segments intersect the mainstem
  stream line even at a 60 m buffer.** It would move nothing.
- **The "per-catchment poisoning" story does not describe these rows.** For
  SH 6 the source's three rows are `4.33 m` (mainstem), `0.40 m` and `9.34 m`
  (both `branch == 0`). The `0.40 m` "poison" is already discarded by the
  existing mainstem filter. The kept `14.21 ft` comes from the **mainstem row
  itself**, so the bug is not the aggregation picking a bad row.

### A3. But the pattern the review was reaching for is real.

| | segments | % within 15 m of a stream line |
|---|---|---|
| all segments | 1,514 | 6.4% |
| segments under 25 ft | 100 | **33.3%** |

A 5.2× enrichment: low thresholds **do** cluster at river crossings. The instinct
was right even though the evidence and the fix were not.

### A4. The declared datum conversion was dead code. Now removed.

`GAUGE_ZERO_DATUM_FT = 26.73` was set, published in the summary, and never used.
The same constant sat unused in `app/src/main.ts`. Both are now deleted rather
than left as a conversion that was declared and skipped.

### A5. The fix the review ranked #2 does **not** work at this site. Measured.

The review ranked "convert HAND to a gauge-equivalent stage properly (half a
day)" as fix #2, and its reasoning was that a per-reach conversion "kills the
-0.92 ft/mile artifact". The bundle does contain paired daily stage (00065) and
discharge (00060) for the Richmond gauge — 9,690 paired observations. So the
route was built and tested. **It is unusable, on three measured grounds:**

1. **The rating was itself defective at the top of the record — and that was a
   real bug, now fixed.** Two closed forms were fitted and both failed on the same
   point, the largest event on record (2017-08-31, Hurricane Harvey: 55.01 ft at
   120,000 cfs). A plain power law predicts **39.3 ft** there (15.7 ft low); the
   standard shifted power law predicts **71.6 ft** (16.6 ft high) while fitting
   the low-flow bulk to 0.34 ft. The errors point in opposite directions because
   the observed rating *flattens* at high stage — 102,000 cfs gives 54.65 ft, not
   64 — and no three-parameter power form bends that way. `gauge_rating.py` now
   uses a monotone PCHIP curve through the median stage of 40 log-spaced flow
   bins, with the record peak as an exact knot: median 0.28 ft, above 35 ft 1.12
   ft, max 4.0 ft, error at the peak 0.00 ft (was 16.6).
2. **The threshold discharges still do not lie in the rating's support.**
   **860 of 1,614** segments need a discharge beyond anything the gauge has
   measured, so converting the column directly yields a **57.3 ft median
   threshold**. It asserts that the median corridor road needs a flood larger
   than any on record. That is extrapolation dressed as measurement.
3. **The column is not a gauge discharge at all.** The mainstem levelpath's
   hydrotable carries **225 sub-reaches** whose discharges at a single stage span
   **3,229 to 232,824 cms**. It is not comparable across reaches, which is the
   same reason the earlier rating-curve attempt failed.

Route rejected *as a direct conversion*, and the evidence is recorded in
`road_thresholds.summary.json` under `known_defect` so it cannot be re-proposed
without confronting the measurement. The rejection is about the conversion route,
not about the rating: the rating was fixed in the process, and route R1 in
`threshold_correction.py` uses it to convert **per reach**, which is the version
that is worth testing against real inundation.

### A6. What is actually shipped, and the defect that remains.

Shipped: HAND-as-stage, plus the review's fix #1 in its only implementable form —
geometric crossing detection (no tags exist) with repair from non-crossing
neighbours within 300 m — plus a `confidence` flag.

- 104 crossing segments; **19 repaired**. The repair **fixes State Highway 6
  (14.2 → 30.2 ft)**, the most visible absurdity in the product.
- It does **not** fix US 90A or the Grand Parkway: their 16–19 ft values run the
  length of the corridor, not just at a crossing, so they are not a bridge
  artifact.
- 128 segments are flagged `confidence: "low"`; the 11 classified highway
  segments still below action stage are listed in the summary's `known_defect`.

**But the headline distribution barely moved**, and saying otherwise would be
false. Same table as A1, after Step 1:

| gauge stage | pre-fix | shipped | share | change |
|---|---|---|---|---|
| 9.2 ft | 0 | 0 | 0.0% | — |
| 20.0 ft (action) | 25 | **22** | 1.4% | −3 |
| 33.4 ft | 811 | **802** | 49.7% | −9 |
| 45.0 ft (flood) | 1234 | **1231** | 76.3% | −3 |
| 50.0 ft | 1338 | **1337** | 82.8% | −1 |
| 55.1 ft (Harvey peak) | 1472 | **1468** | 91.0% | −4 |

The review's core complaint — *half the corridor's streets flood eleven feet
below official minor-flood stage* — **still stands at 49.7%.** Step 1 removed one
visible absurdity (SH 6) and made the rest honest; it did not fix the primitive.
Only Step 3 can.

> **Step 6 update.** "Still stands" now has a size. Against the observed Harvey
extent the thresholds over-predict by **+22.3 ft, uniformly** (§ Step 6): streets
that this table says flood at 33 ft flood near 55 ft. The complaint was right,
the population it describes is larger than the 49.7% figure suggests, and the error
is a constant rather than the along-river trend the blocks below describe.

Residual error, unchanged and now documented: the HAND reference changes bed
elevation along the corridor, so `−0.92 ft/mile, r = −0.64` remains. Closing it
needs **new data, not new code**: a HAND re-run from the DEM (not in this repo),
or per-reach channel bed elevations in the gauge's own vertical datum.
(`usgs_elev_table.csv` does hold `dem_adj_elevation` — **15 rows covering 9
distinct gauge reaches**, one row per crosswalk source rather than one per gauge —
but those elevations and the gauge's zero datum differ by +24.7 ft at the gauge
itself, so they cannot be used as-is. Step 3 below tests that and the four other
routes.)

So the review's "30 minutes" for fix #1 and "half a day" for fix #2 are both
wrong: #1 is partial and #2 is not available. The plan below is reordered
accordingly.

### A7. Smaller corrections.

- "No test directory, no assertions" — correct. Six audits now run at the end of
  the derive step and a broken artifact fails the build.
- The review's literal gate ("no primary highway floods below action stage")
  **cannot pass on this data**. It is not faked: the failing set is reported and
  quantified, and the gates assert the *reporting* is complete and consistent.
- The upgrades document's isolation prototype is honest that it under-connects
  the graph at segment endpoints. That flaw must be fixed before its numbers are
  published — it over-reports isolation.
- The cut list is accepted: drop the NWS/NWM head-to-head.

---

## Part B — The plan

### Step 1 — Threshold primitive: gates, crossing repair, declared confidence. **DONE**

`pipeline/derive/road_thresholds.py` now detects crossings geometrically, repairs
them from neighbours, flags confidence, records the rejected conversion routes
with their measurements, and runs six gates. State Highway 6 is fixed; the
remaining defect is declared rather than hidden.

**Verified:** gates pass; `tsc --noEmit` clean; `vite build` exit 0.

### Step 2 — Isolation stage: *when can I no longer leave?* **DONE**

`pipeline/derive/isolation.py` ships `isolation_ft`, `isolation_gap_ft` and
`isolation_status` per segment, and the app's verdict line now leads with the
isolation number ("You lose your last way out Saturday 8:00 PM · 121 hours until
you are cut off").

**Results, at the thresholds from Step 1:**

- **230 of 1,614 segments are cut off before their own street floods** (median
gap 2.8 ft, max 19.6 ft). US Highway 90A: street 34.8 ft, cut off 18.1 ft.
- **883 have no modelled dry refuge at any stage** — shipped as an explicit
`isolation_status = "no_dry_refuge"` rather than a silent null, because it is the
most severe answer this stage can give, not missing data.

**What the topology fix was actually worth.** The upgrades document's prototype
used one edge per segment, endpoints only. That collapses 8,987 vertices to 1,866
and fragments the corridor into 286 components (largest 183) instead of 116
(largest 2,148). **Running this implementation on the prototype's own graph
reproduces its published 152 exactly**; the corrected topology raises it to 230
and drops the no-refuge count from 1,052 to 883. The max-vs-min aggregation choice
makes no difference (230 either way), so the whole difference is topology — which
is precisely the flaw the prototype's author flagged as a caveat and could not fix.

**Two things checked rather than assumed.** `unary_union` inserts zero new
vertices — the extract is already fully noded (2,037 exact shared junctions), so no
geometric noding was needed and none was written. And 196 features are multipart
with parts that do not touch, so edges are built per part; chaining across parts
would have invented links. The first draft did exactly that and the gate caught it.

**Gates:** isolation ≤ the segment's own flood stage for every segment; the
union-find bottleneck cross-checked against an independent BFS at 20 sampled
stages (boundaries included) on all 8,987 nodes; the topology fix asserted to
improve on endpoint-only connectivity; and `isolation_status` asserted consistent
with every value. The export step refuses to run if the field is missing, so
forgetting to re-run this stage fails loudly instead of shipping a half-empty
payload.

**Known limits (in the summary):** the refuge bar is a choice, not a measurement
(45 ft → 863 no-refuge, 55 ft → 910); the bounding-box clip means escape outside
the study area is not counted (treating the box edge as an exit would give 674
no-refuge and 408 trapped); and absolute stages inherit the Step 3 defect.

### Step 3 — Close the threshold defect. **DONE — closed by measurement, not by a correction.**

Five routes to a physically-correct conversion were built and tested
(`pipeline/derive/threshold_correction.py`). Every one is closed by a number that
is recomputed at run time, and **no correction is applied** — the thresholds ship
unchanged, because a correction that cannot be validated would be worse than a
declared defect. What the step produced instead:

* each closure recorded with its measurement in
  `data/derived/threshold_correction.json`, so no route can be re-proposed
  without confronting the number that killed it;
* the one asset from the investigation that **does** validate: a datum-free
  relative channel-bed profile recovered by integrating NWM reach slopes and
  checked against the six gauge bed elevations in `usgs_elev_table.csv` at
  **r = 0.986** (`data/derived/bed_profile.json`);
* a real bug fixed in `gauge_rating.py` — a **16.6 ft** error at the Harvey peak;
* R1, the closest route to reopening, fully implemented and anchored: at the
  gauge's own sub-reach it returns HAND within 2.6 ft, and it moves US 90A
  16.5 → 30.5 ft, State Highway 6 14.2 → 27.5 and Grand Parkway 15.2 → 28.8.

R1 still cannot ship, and the reason is measured rather than assumed: it is not a
lift (in-record it moves 645 segments up and 117 down), so it **redistributes** the
below-action set — 17 of the 18 classified highways are lifted and 17 different
ones are pushed below action (net 18) — and the hybrid (convert in range, keep
HAND otherwise) is non-monotone, with 637 segments reporting a *later* flood
stage than higher ground nearby.

**Conclusion: this is a data problem, not a code problem, and the route most
likely to work is already written.** Reopening needs one of: a DEM to re-run HAND
against the correct drainage, per-reach bed elevations in the gauge's own
vertical datum, or USGS/NOAA Harvey inundation **polygons**. The OpenFEMA claim
points cannot substitute — they are privacy-coarsened to 0.1°, ~11 km per cell,
so 7,387 claims collapse onto six latitudes.

> **Step 6 update: the third of those was obtained, and it reframes this section.**
The observed extent puts the required correction at **+22.3 ft, a constant** —
within 2.4 ft of R2's discarded datum gap (+24.7 ft) and 2.8 ft of R1's median
lift (+25.1 ft). So R2's "irreconcilable" constant was pointing at the right
number and R1's magnitude is **8–9 ft short** of what the observation needs. The
data problem still needs the DEM or the bed elevations to make the correction
*shippable*, but its size is no longer a mystery.

> **I1 update: a SECOND observation was obtained, and it argues the other way.**
The same third route, a second time: a Sentinel-1 water edge for the 2016 flood at
49.40 ft (`second_event_validation.py`). At that lower stage the shipped thresholds
put **1,312** segments under water and the image shows **1,241 of them dry** —
evidence a maximum extent structurally cannot produce. Harvey's +23.72 ft lift repairs
1,190 of those, but at a recall of **0.055**, and the within-event **AUC falls from
0.809 to 0.566** on Harvey's own 1,187-segment set. A constant offset is
rank-preserving, so no shift could have moved that number: **the defect is in the
ordering the thresholds impose, not only in their level**, and the 2016 event implies
a lift of **−2.05 ft** on its own. Step 3's five closed routes stay closed, and the
route this section recommends is now **weaker**, not stronger — the DEM/bed-elevation
route survives this finding, the offset route does not.

### Step 4 — Routing and reverse routing. **DONE**

`pipeline/derive/routing.py` builds the stage; the app runs the search.

**The graph is shared, not rebuilt.** The routing stage imports `isolation.build()` and
asserts its node and edge counts equal `isolation.summary.json`, so the routes the app
draws lie on the same **8,987-node / 8,970-edge** network the isolation number was
computed on. If either builder drifts, the run fails instead of quietly describing a
different road network in each panel.

**Destinations are real, and only on the network.** 59 hospitals, fire stations and
police stations inside the corridor box were fetched from OpenStreetMap
(`pipeline/fetch/fetch_facilities.mjs`, cached). A facility is accepted only if a graph
node is within 400 m of it — **9 accepted, 50 rejected**. The rejections are the point:
the road extract is a bounding-box clip, so a Sugar Land hospital snapped to the
corridor edge would advertise a route along roads that were never modelled. The nearest
route ends 370 m from the furthest accepted station, and the app says so on screen.

**Flooded edges are weighted, not deleted** (1e6 per flooded segment), so a dry route
always beats a wet one of any length, and when every route is wet the search still
answers — "crosses water on 3 segments, deepest floods at 24.1 ft" — instead of
returning nothing.

**Results at the shipped thresholds:**

- **806 of 1,614** segments have a modelled route to a responder at some stage; **197**
  to a hospital, which is the number that decides whether an ambulance can get in.
- **609 lose that route before their own street floods** — help stops reaching them
  earlier than the flood reaches them. Largest gaps: FM 762 (street 37.1 ft, cut
  **20.8**), Town Center Blvd (54.5 → 40.3), Macek Rd (34.3 → 20.8), Crabb River Rd
  (32.5 → 20.8). Median cut stage 30.0 ft.

The 808 segments with no route to a responder **at any stage** are in road-network
fragments the clipped extract does not connect — a limit of the study area, and the app
says exactly that rather than reporting it as a real barrier.

**Reverse routing is the same field, read outward from the responders.** The multi-source
search from all facility nodes answers "who can reach me"; because the road graph is
undirected the physical path is the same one the forward search finds, and that symmetry
is stated in the summary and the module rather than dressed up as an asymmetry the data
does not have.

**Verified:** the pipeline's 8 gates pass (graph identity, snap bounds both ways,
independence of BFS vs the bottleneck at 16 stages, a hospital subset can never be cut
before the responder superset, non-vacuity at 5 ft, payload array alignment); the artifact
is byte-identical on re-run; `tsc --noEmit` and `vite build` are clean; and the app's
owndependent max-min Dijkstra was checked **in the browser** against the pipeline's
union-find bottleneck — **31 segments, 0 mismatches, max |diff| 0.000 ft**.

### Step 5 — Gauge-failure redundancy. **DONE — and the trigger was wrong.**

The plan said: estimate Richmond stage from HPDT2/BAWT2 shifted by the derived
median lag whenever RMOT2 is stale by more than 2 hours, label it estimated, widen
to the measured IQR. `pipeline/derive/gauge_redundancy.py` builds exactly that and
then **measures** it, 5-fold leave-events-out over 20 flood events, against the
estimator that actually competes with it — the last Richmond observation you
already have:

| staleness | persistence | upstream shift | anchored |
|---|---|---|---|
| 2 h | **0.22 ft** | 2.52 ft | 0.22 ft |
| 12 h | **1.32** | 2.52 | 1.28 |
| 18 h | 1.99 | 2.52 | **1.86** |
| 24 h | 2.66 | 2.52 | **2.37** |
| 30 h | 3.33 | 2.52 | **2.80** |
| 48 h | 5.35 | **2.52** | 3.63 |
| 72 h | 7.88 | **2.52** | 3.94 |

**The 2 h trigger is wrong, and the table says why.** The upstream transfer errs a
constant ~2.5 ft — it does not degrade with staleness, which is precisely its
value — so below about a day it is *worse* than the reading already on screen. The
regimes are therefore derived from the errors rather than chosen:

- **under 18 h** → the last observation, with its age attached
- **18–30 h** → the anchored estimate (last observation + the transfer's change)
- **beyond 30 h** → the upstream estimate, with the measured band

The band is the training-fold error IQR, −1.56 / +1.01 ft, and its **coverage is
measured out-of-sample at 44%** against a nominal 50% — reported rather than
assumed, and gated: a band that does not cover about what it claims fails the run.

**A prerequisite that is a gate, not a footnote.** The transfer is fitted on USGS
gage height and applied to NWPS values in production, and docs/DATA-SOURCES.md
documents a live "San Felipe trap" where the same gauge appears in two vertical
datums. So the module re-checks NWPS against USGS on the cached upstream series
every run: they agree within **0.24 ft** over 29 overlapping days on both gauges.
A silent offset here would have become a wrong flood stage.

**In the app:** a stale gauge shows an `estimated` badge and the band, the source
line reads `ESTIMATED · NWPS Hempstead → RMOT2`, and when the upstream stage falls
below the range the transfer was fitted on (it is fitted on flood events, so this
is the normal condition in a quiet river) the estimate says it is **clamped to the
fitted floor and that the band does not describe it** — a floor, not a value.

**Verified:** gates pass (datum agreement, derived regimes ordered, beats
persistence where shipped, band coverage measured, and the largest lag + gap fits
inside the 719 h live observed window); the app's piecewise-linear transfer matches
the pipeline's on a 13-point grid for both gauges exactly; and all four staleness
regimes were driven in a real browser by shifting the clock — fresh, 11 h (last
observation), 25 h (anchored), 41 h (upstream, clamped and disclosed).

### Step 6 — Harvey validation. **DONE — and it settles Step 3's open question.**

The plan said this "needs new data". It did, and the data was found and fetched: the USGS
flood-inundation extent for the upper Brazos from Hurricane Harvey (doi:10.5066/F7VH5N3N,
SIR 2018-5070), cached by the new `pipeline/fetch/fetch_harvey_inundation.mjs` and scored in
`pipeline/derive/harvey_validation.py`. It replaced the observation route R5 had closed on
privacy-coarsened claim points.

**Acceptance met:** confusion matrix in `README.md`, with a measured false-positive rate.

At the observed peak (55.15 ft), on the 1,187 segments inside the mapped boundary:

| | observed flooded | observed dry | total |
|---|---|---|---|
| model flooded | 414 | **686** | 1,100 |
| model dry | **0** | 87 | 87 |

accuracy 0.422 · **false-positive rate 0.887** · recall 1.000 · precision 0.376, against a modelled
prevalence of 92.7% and an observed 34.9%.

**Four things this settles, none of which were knowable from the repo before.**

1. **The error is calibration, not discrimination.** AUC 0.809 — the HAND threshold does rank ground
   that flooded above ground that did not. Only the absolute mapping to gauge stage is wrong.
2. **The magnitude is +22.3 ft, and it is a constant.** Fitting on one half of the corridor and
   testing on the other: constant offset 0.709/0.844 test accuracy, offset + along-river slope
   0.622/0.831 (with recall collapsing to 0.16/0.08), uncorrected 0.440/0.387. This **confirms R3's
   corrected premise** — the physical correction is a constant offset — over the −0.92 ft/mile trend
   the shipped summary names as the error.
3. **R2's discarded datum gap was the signal.** R2 recovered a +24.7 ft constant and closed it as an
   irreconcilable vertical-reference problem; R1's median lift is +25.1 ft. The observation says
   +22.3 ft — **within 3 ft of both**, from unrelated inputs. The route written off as unresolvable
   was pointing at the right number.
4. **R1 is not enough.** Its conversion lands **8.3–9.0 ft short** of what the observation requires
   on the three named highways, independently explaining why it redistributes the below-action set
   rather than lifting it. `to_reopen`'s "observed inundation extent" item is marked satisfied by a
   run-time cross-check in `threshold_correction.py`.

**Still not applied, and on purpose.** One event, one extent, and a constant fitted to a single
flood with no second flood to test it on is a new unvalidated number in place of an old one — the
same rule that closed all five routes in Step 3. What changed is that the defect is now *measured*
(22.3 ± a few ft, uniform) rather than *declared* (−0.92 ft/mile, unexplained).

**One thing the test cannot do, stated rather than exploited.** A single-instant extent cannot
validate a low threshold — a segment wet at the record peak is equally consistent with flooding at
17 ft and at 55 ft — so the 20 below-action segments (17 of which Harvey reached) are reported and
explicitly **not** treated as vindicated. That needs a series of extents at successive stages.

> **I1 supplied one such extent, and it answers this paragraph — in the negative.**
`pipeline/fetch/fetch_usfimr_2016.mjs` fetches a Sentinel-1 water edge for the 2016 flood from
USFIMR, and `pipeline/derive/second_event_validation.py` scores the same thresholds against it at
**49.40 ft**, on the rising limb, five days before that event crested. Because it is *below* the
stages the thresholds claim to flood at, it refutes rather than merely agrees: **1,241** segments
the shipped rule puts under water at that stage are shown dry (including **21 of the 22**
below-action segments — the first evidence in the repo that speaks to any of them at all). Harvey's
**+23.72 ft** lift repairs 1,190 of those, and Step 6's own framing says that reads as decisive
until the recall column does: **0.055**, against 0.973 shipped. The within-event **AUC is 0.566**
here against **0.809** at Harvey's peak, measured on Harvey's own 1,187-segment set, so the two are
like-for-like — and an AUC is a ranking, which no constant offset can change. So the second event
refutes the correction rather than confirming it: the events disagree on the constant (+23.72 vs
**−2.05 ft** implied), and the failure is in the *ordering*, which is why the fix is a DEM or a
re-run of HAND and not a lift. The radar edge can be wrong about 4.5% water coverage, so the
artifact carries the sensitivity: erasing every refutation would need the image to have missed
**17×** more water than it contains.

The observation is a water surface interpolated between 44 surveyed high-water marks, not satellite
water edges, and one maximum extent rather than a time series. Limits in FINDINGS §11; the second
observation's own limits — one instant, a radar edge, a bounding box for scene coverage — in
FINDINGS §15.

### Step 7 — Uncertainty, demo, human layer. **DONE — all eight items, plus the five ACTION-PLAN bets.**

The step lists eight things. The uncertainty ensemble and the Harvey backcast are done;
the rest are not, and are listed at the end of this section as outstanding.

**The uncertainty ensemble is done, and it is the item that consumes Step 6 rather
than sitting beside it.** "31 hours" is one run of one model; the same evidence that
measured the +22 ft bias also measures how far apart two streets with the *same*
threshold can be — and that number is much larger:

| quantity | value | estimator |
|---|---|---|
| corridor-wide lift (bias) | **+22.30 ft** | best-cut search (maximises correct classifications) |
| corridor-wide lift (bias) | **+23.72 ft** | probit MLE, 90% CI +22.9..+24.6 |
| **per-street spread** | **σ = 11.36 ft (1 sd)** | probit MLE, 90% CI 10.0..12.7 |

The first is a bias, which one corrects. The second is *not* a bias and cannot be
corrected by an offset: it says two streets the model puts at the same stage can be
11 ft apart. That is the honest uncertainty a household faces, so
`pipeline/derive/ensemble.py` draws each street's true stage from the measured
distribution, adds the forecast's own measured error, and the app answers with a
**distribution**:

| street threshold | point estimate | ensemble |
|---|---|---|
| 30 ft | 138 h (certain) | **27 of 50** cross, median 162 h [147–216] |
| 45 ft | 158 h | **4 of 50** cross |
| 50 ft | 169 h | **0 of 50** cross |

**Verified:** the algorithm is implemented twice — Python and TypeScript — and the
app reproduces the pipeline's **16-row verification grid exactly**, counts and all
three quantiles, including the rows that exercise the forecast-error path (mulberry32
+ Box-Muller with drawn values rounded identically on both sides, so an ulp difference
between libm and V8 cannot change a reported count). Gates assert the forecast-error
curve passes through its measured knots and is monotone, that a higher threshold never
crosses more often, and that the grid is not uniformly certain. Render latency is
unchanged by the ensemble at **6.2 ms median over 24 slider steps** (idle machine) because it is cached on
the selection, never recomputed while the stage moves. (Both halves are asserted now, in a
browser: the budget in `app/tests/e2e/perf.spec.ts`, and the cache by counting the draws a run
requires — 24 steps produce none, a forced mode switch produces 2,500.)

**The Harvey backcast alert timeline is also done, and it is the item that makes the
lead-time claim checkable rather than plausible.** Every number in this repo was a
forecast scored against one observed instant; none had produced a lead time for the
flood that happened. `pipeline/derive/backcast.py` runs the app's own rule backwards
over the observed 2017 gauge record (241 hourly points, Aug 22 – Sep 1):

| tier | onset | before the crest |
|---|---|---|
| action 20 ft | Aug 27 09:00 | **109 h** |
| minor 45 ft | Aug 28 14:00 | 80 h |
| moderate 48 ft | Aug 28 21:00 | 73 h |
| major 50 ft | Aug 29 01:00 | 69 h |

The median street's own alert landed **96 h before the crest** (69–102 h), with 1,469
of 1,614 segments reaching their threshold inside the window. **What is observed and
what is not is stated rather than blurred:** the onsets and the crest are observed; the
per-street onset that precedes them is the model, because the only street-level
observation in the project is one event-maximum extent. The window ends two hours after
the crest, so the recession is not reported at all.

**It also priced the decision this plan has been carrying since Step 3.** Applying the
measured correction would silence **969 of the 1,469** streets the shipped rule warns in
time and delay the rest by a median of **71 h**; what it buys is measured on the peak —
accuracy 0.422 → 0.760 and the false-positive rate 0.887 → 0.153, at 167 genuinely
flooded segments reclassified dry. `harvey_validation.py` now records that in-sample
score (`correction_would_score`), so "not applied" rests on a number on each side
instead of an argument on one.

**Verified:** the app recomputes the tier onsets from its own replay series and the flag
counts from its own road list and matches the pipeline's **13-stage + 4-onset grid on all
17 rows**; gates require the hourly crest to agree with the published 15-minute peak, the
crest to fall in the build-up half of the window, flag counts to be monotone in stage and
never higher under the correction, quantiles ordered, correcting a threshold never to
alert *earlier*, and the correction to silence some but not all warned streets — a
trade-off that is not being measured fails the run.

**The three-tier alert in English and Spanish is done, and the tier list was chosen against the
plan's own suggestion by measurement.** `pipeline/notify/templates.json` holds the text once, in
both languages, and `pipeline/derive/notifications.py` compiles it, applies the policy and runs it
over the replayed 2017 record: **1,469 of 1,614** streets cross their own threshold inside the
window (the backcast's own population, by the same rule) for **4,407 messages** — three each, none
duplicated, none after the water, longest 279 characters. The tiers are a countdown from **that
street's own crossing** at T−72 h / T−24 h / T−6 h, not from the river's category: the official
flood stages (45, 48, 50 ft) arrived 7 h and 4 h apart in 2017, so a stage-anchored ladder is three
texts in one night and none of them about the reader's street. The category still rides inside each
message as context. Quiet hours 22:00–07:00 hold the first two tiers to 07:00 (225 sends moved per
held tier) and never the 6-hour one — and because the longest hold is 9 h against a 24 h tier, a
held message always still precedes the water; the drop-rather-than-send-late rule is a counted
guard (`held_past_crossing` = 0), not a thing that happens. The browser fills the same templates
(`app/src/lib/notify.ts`) and the tests require the digit multisets to match, which is why the
crossing time is 12-hour in both languages. Details and limits: FINDINGS §16. The islands, the
household card, `?text=1` and the PWA cache are done and are recorded in the README's checklist.

**The five post-submission bets in `ACTION-PLAN.md` §4 are done too** — the live two-gauge
cross-check, the per-street backcast, bring-your-own-forecast, the inverse (dry road, no way out) view
and the robustness card — along with F1's other half, the "what the river would have to do" answer from
the USGS annual peak record (`pipeline/derive/gauge_history.py`). Measuring them found two defects and
one false assumption, all three now fixed and written up in [FINDINGS](FINDINGS.md) §17: a 2 dp rounding
tie that made one segment of 1,614 disagree between the pipeline and the browser (and, underneath it,
`np.round` vs `round` at 55.135 moving the crest by an hour), a cross-check that flagged both gauges on
a quiet river because the transfer is fitted on flood events, and an inverse set that is not monotone in
stage because it is the gap between two curves.

### Cut

- NWS/NWM forecast head-to-head — archived AHPS is not openly published and the
  existing benchmark is already honest.
- Anything widening scope past flooding.

---

## Part C — Sequence

| order | work | status |
|---|---|---|
| 1 | threshold gates, crossing repair, confidence | **done** |
| 2 | isolation stage, true topology | **done** |
| 3 | five correction routes tested; all closed by measurement | **done** |
| 4 | routing + reverse routing | **done** |
| 5 | gauge redundancy (trigger corrected by measurement) | **done** |
| 6 | Harvey validation (observed extent; error measured at +22.3 ft, a constant) | **done** |
| 7 | uncertainty ensemble (lead time as a distribution) | **done** |
| 7 | Harvey backcast alert timeline | **done** |
| 7 | islands by connected component, household card, `?text=1`, PWA | **done** |
| I1 | second observed extent (2016 Sentinel-1 water edge; the +22 ft constant does NOT transfer) | **done** |
| 7 | notifications (three tiers, EN/ES build-time templates) | **done** |

Steps 1–2 are correctness and must land before any number goes to a judge. Steps
4–5 are what distinguish this from a dashboard. Step 6 is what proves 1–3 were
right — and what it proved is more specific than expected: the thresholds are not
noise and their error is not the shape the summary described, but a **uniform
~22 ft offset** that already existed in the repo as a datum gap nobody could
justify. The correction itself stays unapplied, and the second event that was going to
test it has now run: a Sentinel-1 water edge for the 2016 flood puts the same
thresholds at an AUC of **0.566** against Harvey's 0.809 on the same 1,187 segments,
so the offset is **not** the fix — the defect is in the ordering, not the level (Step 3,
I1 update). What remains outstanding is the DEM / bed-elevation route, which this
finding argues *for*.
