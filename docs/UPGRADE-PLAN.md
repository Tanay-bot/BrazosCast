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

1. **The discharge does not lie in the rating's support.** A plain power-law
   rating (`R² = 0.908`) is badly biased across the flood range: it predicts
   **39.3 ft where the record shows 55.0 ft** at the largest observed flow — a
   **15.7 ft** error at the one event that matters most.
2. **A rating that fits gives an impossible answer.** A shifted power-law rating
   (the standard hydrologic form) fits the whole record to **0.34 ft** median
   error — and then yields a **78.5 ft median threshold**, with **860 of 1,614**
   segments needing a discharge beyond anything the gauge has measured. It
   asserts that the median corridor road floods at a level larger than any on
   record. That is extrapolation dressed as measurement.
3. **The column is not a gauge discharge at all.** The mainstem levelpath's
   hydrotable carries **225 sub-reaches** whose discharges at a single stage span
   **3,229 to 232,824 cms**. It is not comparable across reaches, which is the
   same reason the earlier rating-curve attempt failed.

Route rejected, and the evidence is recorded in
`road_thresholds.summary.json` under `known_defect` so it cannot be re-proposed
without confronting the measurement. `pipeline/derive/gauge_rating.py` is kept as
a working, independently useful artifact (it converts any future flow to gauge
stage), not as part of the threshold chain.

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
Only Step 3 can, and Step 3 needs data.

Residual error, unchanged and now documented: the HAND reference changes bed
elevation along the corridor, so `−0.92 ft/mile, r = −0.64` remains. Closing it
needs **new data, not new code**: a HAND re-run from the DEM (not in this repo),
or per-reach channel bed elevations (`usgs_elev_table.csv` has 15 rows, one per
gauge).

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

### Step 2 — Isolation stage: *when can I no longer leave?*

The upgrades document's Tier 1, and the one change that alters what the product
*is*. Ship `isolation_ft` per segment: the stage at which a node loses its last
route to safety. Always ≤ the flood stage.

- Rebuild topology properly — split segments at every shared vertex, or node the
  network with `osmnx` and join thresholds by `osmid` — before publishing any
  number. The prototype's endpoint snapping misses T-intersections and
  over-reports isolation.
- Union-find sweep across stage; refuge = any node touching an edge that survives
  major stage.
- Gates: isolation ≤ flood stage for every segment; monotone across stage.

**Acceptance:** the count of segments cut off before their own street floods, on
corrected topology, with the gates passing and the app's verdict line leading
with the isolation number.

### Step 3 — Close the threshold defect (needs new data)

Acquire what Step 1 could not produce: per-reach channel bed elevations (to turn
local HAND depth into gauge stage), or a DEM to re-run HAND. Then re-derive and
re-check the gates. **This is the only step that can remove the 11 classified
highways from `known_defect`.**

### Step 4 — Routing and reverse routing

Replace the six-nearest-by-centroid list in `app/src/main.ts` with Dijkstra on the
proper graph. Weight flooded edges at 1e6 instead of deleting them, so a fully-cut
network returns "every route out crosses water, the shallowest is X" rather than
nothing. Route to real OSM destinations (hospital, fire_station). Add reverse
routing: can an ambulance reach *you*.

### Step 5 — Gauge-failure redundancy

When RMOT2 is stale > 2 h, estimate Richmond stage from upstream HPDT2/BAWT2
shifted by the derived median lag, labelled as estimated, widened to the measured
IQR. The travel-time table becomes an operational redundancy path.

### Step 6 — Harvey validation (needs new data)

USGS observed inundation for Aug–Sep 2017 intersected with the road graph. This
adjudicates whether the corrected thresholds are actually better, and converts the
weakest claim into the most rigorous one.

**Acceptance:** confusion matrix in `README.md`, including a measured
false-positive rate.

### Step 7 — Uncertainty, demo, human layer

Bootstrapped ensemble ("37 of 50 runs reach your street"), the Harvey backcast
alert timeline, islands by connected component, three-tier notifications,
household card, low-bandwidth `?text=1`, PWA offline cache, multilingual
build-time templates.

### Cut

- NWS/NWM forecast head-to-head — archived AHPS is not openly published and the
  existing benchmark is already honest.
- Anything widening scope past flooding.

---

## Part C — Sequence

| order | work | status |
|---|---|---|
| 1 | threshold gates, crossing repair, confidence | **done** |
| 2 | isolation stage, true topology | next |
| 3 | close the threshold defect (new data) | needs data |
| 4 | routing + reverse routing | — |
| 5 | gauge redundancy | — |
| 6 | Harvey validation | needs data |
| 7 | demo + human layer | — |

Steps 1–2 are correctness and must land before any number goes to a judge. Steps
4–5 are what distinguish this from a dashboard. Step 6 is what proves 1–3 were
right.
