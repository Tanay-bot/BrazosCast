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
- [x] **Isolation stage** — when the last dry way out is cut: 230 segments are trapped before their own street floods
- [x] **Routing stage** — Dijkstra on that same graph to real OSM destinations: 609 segments lose their route to a responder before their own street floods
- [x] **Gauge-failure redundancy** — if RMOT2 stops reporting, the stage is estimated from upstream gauges, with the trigger set by measurement (18 h, not the planned 2 h)
- [x] **Validated against observed Harvey flooding** — the thresholds over-predict, and by how much is now measured: **+22.3 ft** (best-cut) / **+23.7 ft** (probit), a constant
- [x] **Uncertainty ensemble** — lead time as a distribution, not a point: *"24 of 50 runs reach this street"*, from the measured per-street error
- [x] **Harvey backcast** — the lead time the app would actually have given in 2017, counted from the observed record: the action stage 109 h before the crest, the median street 96 h, and what applying the correction would cost
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
node pipeline/fetch/fetch_facilities.mjs               # OSM hospitals / fire / police (routing destinations)
node pipeline/fetch/fetch_harvey_inundation.mjs        # USGS observed Harvey extent (validation layer)
<env>/bin/python pipeline/analyze/travel_time.py       # crest lags (daily)
<env>/bin/python pipeline/analyze/travel_time_subdaily.py 24
<env>/bin/python pipeline/derive/gauge_rating.py        # gauge stage/discharge rating (standalone)
<env>/bin/python pipeline/derive/road_thresholds.py    # per-street thresholds
<env>/bin/python pipeline/derive/isolation.py          # isolation stage (rewrites road_thresholds.* in place)
<env>/bin/python pipeline/derive/routing.py            # ways out: routes to real destinations
<env>/bin/python pipeline/derive/gauge_redundancy.py   # gauge-failure estimate (measures its own error)
<env>/bin/python pipeline/derive/threshold_correction.py  # tests every fix route; applies none
<env>/bin/python pipeline/derive/harvey_validation.py   # scores the thresholds against observed Harvey extent
<env>/bin/python pipeline/derive/ensemble.py           # lead-time distribution + app verification grid
<env>/bin/python pipeline/derive/backcast.py           # 2017 backcast: the lead time the app would have given
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

## If the gauge goes down

`RMOT2` is a single point of failure for a river warning, so the upstream gauges are wired in as a
redundancy path (`pipeline/derive/gauge_redundancy.py`): Richmond stage is estimated from Hempstead
or San Felipe shifted by the derived crest lag. Two things make it trustworthy rather than clever —
it is **measured against the alternative you already have**, the last Richmond reading, and the
result corrected the plan: below ~18 h of staleness the last reading is closer to the truth, so the
app says so instead of estimating, and only **beyond 30 h** does the upstream estimate take over
(2.52 ft against persistence's 5.35 ft at 48 h).

When it does estimate, the app marks it — a striped `estimated` badge, a source line reading
`ESTIMATED · NWPS Hempstead → RMOT2`, and the measured band (−1.56/+1.01 ft, out-of-sample coverage
**44%**, reported as 44% rather than as a nominal 50%). The transfer is fitted on flood events, so at
low water it clamps to the fitted floor — and the app says that plainly rather than quoting a band
that does not describe it.

## The question the app answers

Not *"when does my street flood?"* but **"when do I lose my last way out?"** — a different number,
and never later than the first. `pipeline/derive/isolation.py` computes it per segment: **230 of
1,614** segments in the corridor are cut off *before* their own street goes under, most sharply
**US Highway 90A — street 34.8 ft, every dry route out gone at 18.1 ft, a 16.7 ft gap.** On a rising
river that gap is most of a day of warning the threshold alone does not give you.

Method, and the honest limits, are in [docs/FINDINGS.md](docs/FINDINGS.md) §6: a road graph with a
node at every vertex, refuge defined as ground the modelled water does not reach at the 50 ft major
stage, and isolation as the widest-path bottleneck to it. The numbers move when the threshold
defect below is fixed; the structure is what this stage contributes.

## Ways out — routes to real destinations

Enter an address and the app no longer lists the six nearest streets. It routes on the
actual road graph to **real places** — hospitals, fire stations and police stations pulled
from OpenStreetMap — and reports what that route costs you at the current stage: a dry
route with its length, or "crosses water on 3 segments, deepest floods at 24.1 ft".

Flooded segments are **weighted, not deleted** (`pipeline/derive/routing.py`), so when
every way out is wet the app still answers instead of going blank. And it answers the
question that matters when you cannot drive yourself: **can help get in to me** — which
station, on how much dry road, and until what stage.

At the shipped thresholds, **806 of 1,614** segments have a modelled route to a responder
at some stage and only **197** to a hospital; **609 lose that route before their own street
floods.** FM 762 is the sharpest: the street floods at 37.1 ft but the last route out is cut
at **20.8 ft**. Facilities more than 400 m from the modelled network are rejected rather
than connected, so a route is never invented along roads outside the study area, and the
808 segments in fragments the clipped extract does not connect are told so in plain words
instead of being silently blank.

The app's Dijkstra is a second implementation of the pipeline's cut stage, in another
language, and it is checked against it in the browser — **0 mismatches over 31 sampled
segments**. Method and limits: [docs/FINDINGS.md](docs/FINDINGS.md) §7.

## Validated against the flood that actually happened

Every number above this point is internally consistent. Until now none of it had been checked
against water that arrived. It now has been, with the one independent observation of the 2017
event that exists for this reach: the USGS flood-inundation extent for the upper Brazos
(doi:[10.5066/F7VH5N3N](https://doi.org/10.5066/F7VH5N3N), SIR 2018-5070), cached to
`data/raw/harvey/` and scored in `pipeline/derive/harvey_validation.py`.

**Method.** A segment is predicted flooded at the Harvey peak if `flood_stage_ft <= 55.15 ft`,
and observed flooded if its geometry intersects the mapped extent. The evaluated set is the
**1,187 segments inside the mapped area boundary** — outside it the release supplies no
observation, so scoring those would manufacture both kinds of error.

| | observed flooded | observed dry | total |
|---|---|---|---|
| **model says flooded** | 414 | **686** | 1,100 |
| **model says dry** | **0** | 87 | 87 |
| total | 414 | 773 | 1,187 |

**accuracy 0.422 · false-positive rate 0.887 · recall 1.000 · precision 0.376**

The model marked **92.7%** of the evaluated corridor flooded; **34.9%** was. And the errors run in
one direction only: **not one segment was observed flooded that the model called dry.** The
defect is a refusal to say "dry", never a false all-clear — which for a life-safety product is the
right way for it to be wrong, and is worth stating precisely rather than as reassurance.

The threshold is not noise. Feeding it in as a ranking score gives an **AUC of 0.809**: HAND does
tell ground that flooded from ground that did not (observed-wet segments median 30.6 ft, observed-dry
37.6 ft). What is wrong is the absolute mapping from HAND to Richmond gauge stage. So the diagnosis
splits cleanly — **discrimination works, calibration does not** — and the two need different fixes.

**The magnitude.** The stage that best reproduces the observed extent is **32.85 ft, not the observed
peak of 55.15 ft: a lift of +22.3 ft.** Applied, accuracy goes 0.422 → 0.769 and the false-positive
rate 0.887 → 0.230 — and the probit lift scores 0.760 / 0.153 on the same 1,187 outcomes. Both are
**in-sample** (fitted and tested on one event), so they bound what the correction would do; the
spatial holdout above is the weaker, out-of-sample test. The trade is visible in one number: the
corrected rule would call **167 segments dry that flooded**, against zero misses today. In plain terms, **every street in this product floods about 22 ft later than its
threshold claims** — the median corridor segment, reported as flooding at 33.4 ft, in fact floods
near 55.7 ft, which is the Harvey peak itself. The worst flood on record inundating a third of the
corridor's roads is a coherent picture; the shipped thresholds are not.

**Two estimators of that one number, and they agree.** The stage that best reproduces the extent
(above, by counting misclassifications) gives **+22.3 ft**; a probit fit of the same 1,187 binary
outcomes gives **+23.7 ft** and, crucially, the per-street spread as well. They differ by 1.4 ft
because they optimise different things, and both are in `harvey_validation.json` under
`estimators_of_the_same_lift`. **The app quotes the probit fit**, because it is the fit that also
yields the spread the ensemble propagates — one number for the same quantity everywhere on screen.

**It is a constant, not a drift.** Fitting the correction on one half of the corridor and testing it
on the other — the only out-of-sample test a single event allows:

| correction fitted | test accuracy | false-positive rate | recall |
|---|---|---|---|
| none | 0.440 / 0.387 | 0.993 / 0.746 | 1.000 / 1.000 |
| **constant offset** | **0.709 / 0.844** | 0.229 / 0.069 | 0.629 / 0.444 |
| offset + along-river slope | 0.622 / 0.831 | 0.018 / 0.006 | 0.158 / 0.083 |

(upstream→downstream / downstream→upstream). The constant transfers; the linear form does not, and
its recall collapses. That independently confirms what `threshold_correction.py` concluded about the
flat-pool route: **under normal flow the physical correction is a constant offset** — not the
`−0.92 ft/mile` trend the shipped summary names as the operative error.

**Two routes that were written off predicted this number.** R2 recovered a datum gap of **+24.7 ft**
between the gauge reach's `dem_adj_elevation` and the gauge's own zero datum, and closed it as
irreconcilable. R1's median lift over all segments is **+25.1 ft**, and it was set aside because
nothing could say whether the magnitude was right. The observation says the magnitude is **+22.3 ft**:
both land **within 3 ft**, from entirely different inputs. The datum gap was not an unresolvable
nuisance — it was the signal. That also settles R1's open question, in the negative: for the three
named highways R1's conversion lands **8–9 ft short** of what the observation requires, which is
independently why it redistributes the below-action set rather than lifting it.

**What Harvey actually reached**, for the highways this README already flags:

| highway | segments | lowest threshold | observed flooded | model says |
|---|---|---|---|---|
| US Highway 90A | 56 | 17.0 ft | **13 (23%)** | 100% |
| East US Highway 90A | 71 | 16.5 ft | **33 (46%)** | 100% |
| West Grand Parkway South | 26 | 15.6 ft | **11 (42%)** | 100% |
| State Highway 6 South | 35 | 29.3 ft | **29 (83%)** | 100% |

**No correction is applied, and that is deliberate — now for a priced reason.** One event, one
extent: the observation bounds the correction, but a constant fitted to a single flood with no
second flood to test it on is a new unvalidated number in place of an old one — the same principle
that closed the five routes in `threshold_correction.py`. What the backcast below adds is the other
side of the ledger: applying it would silence **969 of the 1,469** streets the shipped rule warns in
time, and delay the rest by a median of 71 h. Both costs are now measured rather than argued.

**What the test cannot say.** The extent is a water surface interpolated between **44 surveyed
high-water marks** and clipped to the mapped boundary — a survey-anchored estimate, not satellite
water edges, and one maximum extent rather than a time series. So it bounds the threshold error; it
does not prove a given parcel was wet. Because it is a single instant, **it cannot validate a low
threshold**: a segment observed wet at the record peak is equally consistent with flooding at 17 ft
and at 55 ft. It can only refute thresholds it found dry. That is why the 20 segments below action
stage — 17 of which Harvey did reach — are reported and explicitly **not** treated as vindicated.
Adjudicating those needs a series of extents at successive stages, which this release does not have.
Roads are lines, so any part of a segment inside the extent counts as flooded; the crest travels
during the event, so no single gauge reading is simultaneous with every location; and an extent that
under-represents the flood would inflate false positives — though most of them sit close to the
separating threshold (median 36.4 ft) rather than far below it. Full limits in
[docs/FINDINGS.md](docs/FINDINGS.md) §11.

## The uncertainty the point estimate hides

"Water reaches this street at 31 hours" is one run of one model. The same evidence that measured the
22 ft bias also measures how far apart two streets with the *same* threshold can be, and that second
number is the larger one: **σ = 11.4 ft (1 sd)**, from the probit fit in `harvey_validation.py`. So
`pipeline/derive/ensemble.py` asks the question 50 times, drawing each street's true flood stage from
the measured distribution and the forecast's own measured error (RMSE by horizon from the benchmark:
1.2 ft at +1 day, 6.1 ft at +7), and the app answers with a distribution:

> **Uncertainty · with the measured threshold error applied**
> **24 of 50** runs reach this street — median **163 h** (148–194 h); 26 never reach it in the window.
> The point estimate for the same street is **140 h**.

On the Harvey replay, a 30 ft street goes from a certainty (50/50) to 27/50; a 50 ft street goes to
**0 of 50** — the model's "169 h" is not a number anyone should act on. Every ensemble answer is
reported *beside* the shipped point estimate, never in place of it, and the block says in the panel
why the two differ — at the peak stage they can read as opposites, and pretending otherwise would be
the dishonest option.

The algorithm is **implemented twice, in Python and in TypeScript, and the app reproduces the
pipeline's 16-row verification grid exactly** (counts and all three quantiles, including the rows
that exercise the forecast-error path). Same drawn-value rounding on both sides, because libm and V8
differing in the last ulp must not be able to change a reported count. The drag cost is unchanged —
median **6.2 ms** per render over 24 slider steps, because the ensemble is cached on the selection
and never recomputed while the stage changes.

**What it is not:** a probability of flooding, or a confidence interval on a measured quantity. σ is
unexplained variance from a single event, so it absorbs real per-reach differences (culverts, levees,
the HAND reference error) and everything the model cannot see. In replay the hydrograph is observed,
so its spread is the threshold error alone and understates what a live forecast carries.

## What it would have sent — the 2017 backcast

Everything above is a forecast scored against a single observed instant. The app's headline is a
**lead time**, and none of it had produced one for the flood that actually happened.
`pipeline/derive/backcast.py` does, by running the app's own rule backwards over the observed gauge
record — 241 hourly points, 2017-08-22 to 09-01, the same series replay mode loads:

| tier | crossed | before the crest |
|---|---|---|
| action 20 ft | Aug 27 09:00 | **109 h** |
| minor 45 ft | Aug 28 14:00 | 80 h |
| moderate 48 ft | Aug 28 21:00 | 73 h |
| major 50 ft | Aug 29 01:00 | 69 h |

Across the corridor, the app's own alert for a street landed **96 h before the crest** at the median
(69–102 h), with **1,469 of 1,614** segments reaching their threshold inside the window. Four days of
warning is the claim, and this is the one event where it can be **counted** instead of asserted.

**What separates the observed from the modelled is stated, not blurred.** The onset hours and the
crest are observed. *Which street floods when* is not: the only street-level observation in this
project is one event-maximum extent, and a single instant cannot say when water arrived anywhere. The
artifact records that in its schema, the app says it in the panel, and the window ends two hours after
the crest, so the recession is **not reported at all** rather than extrapolated.

The flag counts are the threshold defect above expressing itself over time: at the action stage the
shipped rule flags 22 segments and the corrected rule **none**; at the crest, 1,469 against 500. So
the correction is not a free improvement — it would silence **969 of the 1,469** streets the shipped
rule warns in time and delay the rest by a median of **71 h**, buying accuracy 0.422 → 0.760 and a
false-positive rate 0.887 → 0.153 at the cost of those 167 flooded-but-called-dry segments. It stays
unapplied, and now both sides of that decision are numbers.

The timeline is drawn from arithmetic the **browser** performs — onsets recomputed from its own replay
series, counts from its own road list — and then checked against the pipeline's grid of 13 stages plus
4 tier onsets: **all 17 rows match**. The stage slider answers a different, consistent question on the
same block: *at 51.00 ft the app flags 1,355 of 1,614 segments; with the measured correction, 79*.
Method and limits: [docs/FINDINGS.md](docs/FINDINGS.md) §13.

## Known defect in the street thresholds

The thresholds treat the HAND height above the nearest drainage as the Richmond gauge stage. That
leaves a systematic error — the HAND reference changes bed elevation along the corridor, and the
residual along-river slope is `−0.92 ft/mile (r = −0.64)`.

Concretely: **13 classified highway segments (11 unique ways — US 90A, Grand Parkway, State Highway 6)
still sit below action stage** in `road_thresholds.summary.json`. Every affected segment is flagged
`confidence: "low"` and the app says so on screen rather than asserting a threshold it cannot defend.
128 segments are flagged in total (below action, unrepaired river crossings, or levee-protected).

**Five fix routes were built and tested, and all five are closed by a measurement**
([threshold_correction.py](pipeline/derive/threshold_correction.py)) — so the thresholds ship
unchanged and the defect stays declared rather than being papered over. The closest to working is
per-reach conversion through the gauge rating: it moves US 90A 16.5 → 30.5 ft and State Highway 6
14.2 → 27.5, but it does not *lift* segments so much as redistribute the below-action set (17 lifted,
17 new, net 18), and its hybrid is non-monotone. What the investigation did produce is a validated,
datum-free bed profile (`bed_profile.json`, r = 0.986 against the gauge bed elevations) and a real bug
fix: the rating itself erred **16.6 ft at the Harvey peak** and now errors 0.00 ft there.

An earlier attempt to convert the source's inundation discharge through the gauge's own measured
rating was built and **rejected on measurement** — the source discharges lie mostly above the gauge's
observed record, and the column is not a single-reach discharge (225 sub-reaches span three orders of
magnitude at one stage). The evidence is recorded under `known_defect` in the summary. Closing the
defect needs new data: a HAND re-run from the DEM, or per-reach channel bed elevations.

Gates at the end of `pipeline/derive/road_thresholds.py` fail the run if any segment below action
stage or any unrepaired crossing is not flagged, and if the reported defect set stops matching the
data.

**The magnitude is no longer unknown: see [Validated against the flood that actually happened](#validated-against-the-flood-that-actually-happened)
above — the thresholds run about 22 ft low, uniformly.**

## Attribution

Libraries and datasets are documented with licenses in the submission and in each pipeline step.
AI tools are disclosed fully per the 2026 CAC rulebook.
