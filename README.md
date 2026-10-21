# BrazosCast

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/lockup-dark.svg">
  <img src="app/public/brand/lockup.svg" width="300" alt="BrazosCast — flood lead time for the lower Brazos">
</picture>

The lockup is the product in one drawing: a staff gauge with waterline ticks, the rising
hydrograph, and the red dot where the curve crosses a threshold. `app/public/brand/` holds both
themes plus the square mark the pages use (`mark.svg`, and `mark-mono.svg` in the app's footer).

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
- [x] Inundation extent — **the raster's unit is measured, not assumed**: millimetres, confirmed by the hydrotable's per-reach cell counts *and* the 2016 Sentinel-1 water edge; per-reach stage from each reach's own rating curve; shipped as 95 polygons (90.5 KB gzipped) under the road layer, scored at IoU 0.31 against that one observation and labelled an upper bound because of it (FINDINGS § 8)
- [x] Model benchmark — XGBoost > LSTM > persistence on the 2016–17 holdout; **and the horizon limit**, measured on two later windows: it beats persistence at +1…+3 d and does not at +5/+7 d, and at 45–50 ft persistence is the better threshold classifier. Shipped as a cross-check, never as the forecast → [FINDINGS § 9b](docs/FINDINGS.md)
- [x] **Isolation stage** — when the last dry way out is cut: 230 segments are trapped before their own street floods
- [x] **Routing stage** — Dijkstra on that same graph to real OSM destinations: 609 segments lose their route to a responder before their own street floods
- [x] **Gauge-failure redundancy** — if RMOT2 stops reporting, the stage is estimated from upstream gauges, with the trigger set by measurement (18 h, not the planned 2 h)
- [x] **Validated against observed Harvey flooding** — the thresholds over-predict, and by how much is now measured: **+22.3 ft** (best-cut) / **+23.7 ft** (probit), a constant
- [x] **A second observed flood, at a lower stage** — the 2016 Sentinel-1 water edge, which refutes instead of agreeing: **1,241 segments** the shipped rule submerges at 49.40 ft are shown dry, and Harvey's lift fails out of sample (**AUC 0.566 vs 0.809**; implied lift **−2.05 ft** against +23.72)
- [x] **Uncertainty ensemble** — lead time as a distribution, not a point: *"24 of 50 runs reach this street"*, from the measured per-street error
- [x] **Harvey backcast** — the lead time the app would actually have given in 2017, counted from the observed record: the action stage 109 h before the crest, the median street 96 h, and what applying the correction would cost
- [x] **The alert, in English and Spanish** — three tiers counted back from **your street's** own crossing (T−72 h / T−24 h / T−6 h), compiled at build time, filled by two independent implementations the tests require to carry the same digits, and simulated over the 2017 record: **4,407 messages** to **1,469 streets**, none duplicated, none arriving after the water, longest 279 characters
- [x] **Offline address index** — a typed house number resolves to the right street segment with no geocoder and no API key, from county address ranges: 819 ranges across 96 of the 154 modelled street names, and **96.8%** of them name the same segment a map click returns
- [x] **Two front doors, one dataset** — `/` is a landing page that answers the river's halves of the question in one screen: the live stage, a staff gauge you can drag to see what the river's own peak record says about any stage, and a box that resolves a street onto the same scale. `/app` is the map, unchanged; every link already sent still opens the answer it was about, because `/` redirects its legacy query to the app. Both documents render from the same payload — the gauge record and the street thresholds — and the build ships their chunks separately, so the storm page never downloads the homepage. Held by `app/tests/e2e/landing.spec.ts`, which asserts among other things that the scale is actually DRAWN (the ticks shipped collapsed to zero width once)
- [x] **Test suite** — **136 pipeline tests**, **120 kernel tests** (`app/tests/unit`, vitest) and **52 browser tests** (`scripts/check.sh`), including a golden-artifact regression that re-runs the whole pipeline and diffs every artifact, a payload-contract test, source-integrity checks, raw-input-policy checks (which raw inputs are committed, and why — the rule that caught the 2017 interval record being excluded from the repo it is the source of), doc-drift checks against the README, **cross-language grid parity** — the ensemble's 16 rows and the backcast's 17, plus the transfer's knots, recomputed through the app's own TypeScript and required to match the pipeline exactly — **invariants over generated inputs** (reachability, the isolation bound, the forecast-error curve, three orders of magnitude more inputs than the shipped corridor), a state-contract suite holding the app to "the address is never stored on the device, the URL is replaced and not pushed, and a parameter this version does not know survives a link", and a Playwright suite that boots the built app with a stubbed gauge and reloads it with the origin genuinely taken away
- [x] **Shareable state** — the street, the stage and the mode travel in the URL, so a copied link restores that answer on a fresh load in a browser that has never seen the app; parameters this version does not know are carried through rather than stripped
- [x] **`?text=1` low-bandwidth route** — no map, no chart, no MapLibre, no webfonts: measured from the build by `scripts/check-text-mode.mjs` (gzip -9 of exactly what ships), **321.0 KB against 637.8 KB** for the full route — **316.8 KB saved, 49.7%**, with the 84.6 KB of webfonts and the map tiles requested by neither. The 450 KB flood extent is charged to the full route only, because text mode never asks for it and the browser suite asserts that; the app's entry chunk is **30.6 KB gzipped** for every visitor, and the landing is a separate document with a chunk of its own
- [x] **Offline cache** — a service worker keeps what the page has already been asked for, so a reload with no connection still answers. **One visit is enough**: measured on a fresh origin, a first load leaves the 14-file payload (~2.1 MB, including the 450 KB flood extent the map route fetches) and the current gauge reading cached, and a reload with every connection refused restored the same answer from the cache. The eager set is the shell only, because precaching 2 MiB would hand back what `?text=1` saved
- [x] **What the river would have to do** — on a dry day the answer is not "stays dry" but *"this street floods at 33.4 ft; the gauge last reached that in 2025 (34.76 ft)"*, from the USGS annual peak record (`pipeline/derive/gauge_history.py`, 111 annual peaks back to 1884, highest 61.20 ft in 1913)
- [x] **Two gauges, one answer (I2)** — the upstream gauges transferred down the reach at the lag each was fitted at, compared with the live reading against the measured band, and honest when the river is too low for the transfer to mean anything
- [x] **Does the answer survive (I6)** — the lead time re-run with the per-street threshold error, the corridor lift and the benchmark's forecast RMSE applied: *"the qualitative answer holds under all 4 perturbations"* or a named row that flips it
- [x] **Dry road, no way out (I5)** — the inverse view: segments whose route to help is already cut while their own street is still dry (294 at 30 ft, 116 at 45 ft, 12 at 55 ft — the set is a lens on two curves, not a growing list), worst first
- [x] **Per-street 2017 backcast (I3)** — the alert the selected street itself would have got in 2017, recomputed in the browser and checked against the pipeline's 1,614-entry per-segment array
- [x] **Bring your own forecast (I4)** — paste a series and the app's own rule runs over it, with the observations kept and every unreadable line reported by number; nothing pasted is stored or put in the URL
- [x] Static app: address → street threshold → hours of lead time (live + Harvey replay)
- [ ] Forecast vs archived NWS / NWM retrospective *(deliberately cut — archived AHPS is not openly published)*

## Layout

```
docs/       plan, verified data-source ledger
pipeline/   fetch + analysis + (later) models, geo, road graph
data/raw/   cached source snapshots + manifest.json
data/derived/
app/        frontend (static, deployable): index.html = landing, app.html = the map
app/src/    landing.ts/landing.css and main.ts/style.css, over one tokens.css
app/public/ payload the browser fetches, and the brand marks
```

## Run the app

```bash
cd app && npm install && node node_modules/esbuild/install.js
npm run dev        # http://localhost:5173 — the landing; the app is /app
npm run build      # static bundle in app/dist (index.html + app.html)
```

Two documents ship: `/` (the landing, `index.html`) and `/app` (the map, `app.html`). The dev
server, `vite preview` and the deployed host all rewrite `/app` to that document, so no address
in the browser is a file name. Both documents render from `app/public/data/`.

The app fetches the live NOAA NWPS gauge directly from the browser (CORS is open) and reads the
per-street thresholds from `app/public/data/`. The landing reads the same live gauge, the USGS
peak record in `gauge_history.json` and the street minimums in `street_thresholds.json` — and
then hands the typed address to `/app` rather than answering the household's question twice.

**Typing an address needs no key and no network.** House numbers resolve from an offline index
built out of Fort Bend County's own road centerlines, which carry address ranges per segment —
`4710 Jackson Street` lands on the Jackson Street segment whose range brackets 4710. There is no
geocoder in the request path: the Census geocoder sends no CORS header (so a browser cannot call
it) and returns zero matches for this corridor, and Mapbox needs a token. Set `VITE_MAPBOX_TOKEN`
only if you want Mapbox as a last-resort fallback; you can also click a road on the map.

A street the app does not model is **refused rather than snapped to the nearest modelled street**,
because that would answer a different household's question. Every refusal says which streets are
close, and a typo is offered the real address that works.

## Deploy

The app is a static bundle; any host that serves `app/dist` works. `app/vercel.json` carries the
three response headers the app depends on — `sw.js` uncached, or a browser can be pinned to an old
service worker; `/data/*` revalidated, or a stale thresholds file answers about a river the app no
longer models; hashed `/assets/*` immutable — and exactly **one rewrite**, `/app -> app.html`,
rather than an SPA catch-all: a missing payload is a 404 rather than an HTML page a JSON parse
would choke on. `scripts/check-vercel-config.mjs` reads the config, applies the rules the way a
request would, and fails if a shipped file gets the wrong header — or if a document names a
payload the bundle does not ship. The payload list is read out of the two documents' sources, not
typed into the check: a typed count is how a check ends up guarding the wrong thing.

**Vercel, from a Git import.** Import the repo and set **Root Directory to `app`**; the Vite preset
fills in `npm run build` and `dist`. No environment variable is needed, and the build fetches no
data: the payload in `app/public/data/` is committed.

**Vercel, from the CLI.** `scripts/deploy-vercel.sh` rebuilds, copies the header config into the
bundle, uploads `app/dist`, then curls the new origin for those headers, the content types and the
404 case — it fails rather than print a URL it could not verify. It reads `VERCEL_TOKEN`, or
`.vercel-token` (gitignored), or an existing `npx vercel login`.

## Refresh the data

```bash
node pipeline/fetch/fetch.mjs                          # NWPS chain, NWS, OpenFEMA
node pipeline/fetch/fetch_usgs_history.mjs 1985        # long gauge record
node pipeline/fetch/fetch_facilities.mjs               # OSM hospitals / fire / police (routing destinations)
node pipeline/fetch/fetch_harvey_inundation.mjs        # USGS observed Harvey extent (validation layer)
node pipeline/fetch/fetch_usfimr_2016.mjs              # Sentinel-1 water edge, 2016 flood (second observation)
node pipeline/fetch/fetch_fbcad_roads.mjs              # county road centerlines WITH address ranges
<env>/bin/python pipeline/analyze/travel_time.py       # crest lags (daily)
<env>/bin/python pipeline/analyze/travel_time_subdaily.py 24
<env>/bin/python pipeline/derive/gauge_rating.py        # gauge stage/discharge rating (standalone)
<env>/bin/python pipeline/derive/road_thresholds.py    # per-street thresholds
<env>/bin/python pipeline/derive/isolation.py          # isolation stage (rewrites road_thresholds.* in place)
<env>/bin/python pipeline/derive/routing.py            # ways out: routes to real destinations
<env>/bin/python pipeline/derive/gauge_redundancy.py   # gauge-failure estimate (measures its own error)
<env>/bin/python pipeline/derive/threshold_correction.py  # tests every fix route; applies none
<env>/bin/python pipeline/derive/harvey_validation.py   # scores the thresholds against observed Harvey extent
<env>/bin/python pipeline/derive/second_event_validation.py  # ...and against the 2016 radar water edge (OUT OF SAMPLE)
<env>/bin/python pipeline/derive/ensemble.py           # lead-time distribution + app verification grid
<env>/bin/python pipeline/derive/backcast.py           # 2017 backcast: the lead time the app would have given
<env>/bin/python pipeline/derive/address_index.py       # offline address index (needs road_thresholds + the FBCAD fetch)
<env>/bin/python pipeline/derive/hand_unit_resolution.py  # settles the HAND raster's unit (hydrotable + USFIMR)
<env>/bin/python pipeline/derive/inundation.py         # flood-extent bands -> app payload (needs the first)
<env>/bin/python pipeline/models/forecast.py           # XGBoost benchmark
<env>/bin/python pipeline/export/app_data.py           # publish into the app
```

Writes `data/raw/` and `data/raw/manifest.json` (per-source status, counts, per-gauge datums).

## Run the checks

```bash
scripts/check.sh            # tests + tsc + build + payload sync      (~15 s)
scripts/check.sh --browser  # also the Playwright suite               (~60 s)
scripts/check.sh --all      # also the golden pipeline regression     (~3 min)

scripts/check-mutants.sh    # do the checks still catch what they claim to? (minutes, not seconds)
```

The last one is not a gate and is not part of `check.sh`: it compiles a deliberate defect into the
real code, one at a time, and requires the test or stage that *owns* that defect to fail — then
proves every file it touched is byte-identical again. Run it when a check changes, or when you want
the mutation claims below to stop being assertions. Its six sets are listed with the suite that owns
each one.

**Not everything the checks read is in the repo**, and the exceptions are deliberate —
`docs/DATA-SOURCES.md` § "Raw inputs — what is tracked, and why" is the whole inventory and the
measurements behind it. A fresh clone runs neither suite unattended: the fast path needs the USGS
caches (`node pipeline/fetch/fetch_usgs_history.mjs 1985`) and `app/node_modules`, and `--all`
additionally needs the 66 MB HAND archive, which has no fetcher at all — it is a manual download
into `data/raw/hand/`. With those in place both pass, which is how the criterion was checked.

The test suite needs one dependency the pipeline does not, and the browser suite needs two more:

```bash
<env>/bin/pip install pytest
cd app && npm i -D @playwright/test && npx playwright install chromium
```

`--all` is the golden regression: it copies the repo to a temporary directory, re-runs the
chain in order (`road_thresholds → isolation → routing → gauge_redundancy → harvey_validation
→ ensemble → backcast → address_index`), and fails if any artifact differs from the committed
one. The chain is deterministic — measured, all 12 artifacts reproduce identically — so a diff
means behaviour changed, not that a run wobbled. It costs about two minutes, almost all of it
Harvey validation, which is why it is opt-in.

The other suites are fast and check the parts that drift silently: the **payload contract**
(every field the app reads still exists, and every exported file is actually fetched), **source
integrity** (the cached raw inputs against their own receipts), and **doc drift** (every figure
in the README against the artifact it came from). A deliberate-mutation check confirmed each
one fails when it should — including one case where the drift test was too weak and had to be
fixed rather than the data.

One step is neither: **`scripts/check-text-mode.mjs`** runs after the build and reads `app/dist`,
because the `?text=1` route is a claim about bytes and only the build knows the bytes. It asserts
that MapLibre is a separate chunk and is not statically imported by the entry, that its CSS is not
in the entry stylesheet, that the font guard survives minification, and that the gzipped saving
clears a 200 KB floor. It prints the current figures on every run.

**`scripts/check-offline.mjs`** is the other one, and it *runs* `app/dist/sw.js` rather than
reading it — a service worker has no behaviour except in how it answers requests, so it is loaded
in Node inside a fake world: a `fetch` backed by the real `dist/` tree, a Cache API shim, and a
switch for the network. It then drives install, a first-visit warm-up, a navigation, the data
path, the gauge, a deploy and a cache purge, and asserts what the docs promise: the eager set is
the shell (no payload file and no third-party host is fetched at install), a reload with the
network off returns the cached shell and the cached data, a cache miss still fails, the live
gauge is never taken from the cache while the network is there, and a half-finished deploy is not
swapped in. Thirteen mutations of the worker — including re-fetching during the warm-up and
dropping the prune — each fail the check that owns them, with every file restored byte-identical.

The **state contract** suite is the one that reads the app rather than the artifacts: it pins the
three properties shareable state depends on — nothing stored on the device, `replaceState` and
never `pushState`, and a query re-seeded from `location.search` so a parameter this version does
not know (the planned `?text=1`) survives a link instead of being stripped by it. It asserts
against the mechanisms rather than the behaviour, which is the right split now that there is a
browser runner: the browser proves the round-trip it happens to take, and this proves the
properties that must hold on every path. Five mutations (a `localStorage` read, a `pushState`, a
from-scratch query, a removed note reset, a removed refusal fallback) each fail the specific test
that owns them.

### The kernel suite

`app/tests/unit/` (vitest, `cd app && npm test`) runs the algorithms the pipeline implements a
**second** time, in TypeScript, against the artifacts the app is served. It exists because of what
"the two implementations agree" rested on: a DEV-only browser hook, invisible to any CI — and for
the backcast, a check function (`checkBackcastGrid`) that nothing ever called. A duplicated
algorithm that nothing checks is two algorithms.

- **`islands.test.ts`** (22 tests) recomputes the island sweep — the whole nine-rung ladder, row by
  row, from the graph the app is served (`public/data/`, which the build copies to `dist/`) — against
  the rows `routing.py` published. It also holds the three things the ladder cannot see: the rung with
  no water on it reproduces the **806** the routing stage's cut field published (the coupling that
  makes this a second implementation rather than a parallel universe); the boundary of a street's
  island is re-derived by flooding rather than by union-find, so "a way off the island" — a wet
  segment that moves you between two islands, not one you can drive around — is checked against a
  different algorithm; and the rule that decides which island a cut road feature belongs to is held on
  a **synthetic graph built to separate it from its rivals**, because the shipped data cannot (see
  below).
- **`grid-parity.test.ts`** (41 tests) recomputes the ensemble's **16 rows** and the backcast's
  **17** — crossing counts, all three quantiles and `never_h` included — and requires each to
  equal the pipeline's row exactly, then holds the transfer's knots, its clamp outside the fitted
  range, and the bracket between knots against the artifact's own numbers. Exactness is the right
  assertion rather than a tolerance: both sides round identically on purpose (draws to 6 dp,
  crossing hours to 3 dp, thresholds to 4 dp, quantiles to 2 dp) so that libm and V8 differing in
the last ulp cannot move a draw across a hydrograph point. The file also pins the two things the
  rows **cannot** witness: that the app counts the same 1,614-segment population the pipeline
  counted, and the crossing rule's boundary — `v >= tau` with tau at 4 dp, so a threshold 1e-6 ft
  above an observed stage still crosses in every member.
- **`pipeline/tests/test_grid_parity.py`** is what makes that part of the project's one check
  command, and holds the identities a TypeScript test cannot: that the series the app replays is
  the series `ensemble.py` computed its grid on (241 hourly points, compared point by point), and
  that the app's population of road thresholds is the pipeline's, segment for segment. A grid
  checked against the wrong hydrograph agrees perfectly.

**Every claim below of the form "a deliberate defect fails the check that owns it" is reproducible**:
`scripts/check-mutants.sh` compiles each one into the real code and requires the named test or stage
to fail, then proves every touched file is byte-identical again. It is opt-in and slow by
construction, so it is not part of `check.sh`. Fifty-two mutants in eight sets are wired into it: the
island layer (8 — five in the app's kernel, two in the pipeline's own gates, one on the synthetic
fixture), the app's household and island specs (3), the second-event validation (5 — the image
instant, the stage, the lift under test, the population an AUC is computed over, and the definition
of a refutation), the shipped worker (13), the offline source contract (15), and the alert (8 — a
digit drifting in the Spanish template, a dropped placeholder, a Spanish category left in English,
the stage ladder, the 12-hour clock, the quiet-hours hold, and the browser and pipeline renderers
broken one at a time, because the parity claim is about two implementations). The kernel-grid,
chart, share,
state-contract and text-mode mutant sets are still hand-verified; porting them in is the same
mechanical job, and until then the ledger in [docs/ACTION-PLAN.md](docs/ACTION-PLAN.md) records where
each was checked.

**Mutation-checked nine for nine**: an off-by-one crossing count, the crossing boundary moved, tier
onsets measured from the wrong instant, the flag rule made exclusive, the transfer off by one
index, a bottleneck stamped above the true cut, the BFS passability rule made inclusive, the
error curve's first segment flattened, and the held floor dropped below its last knot — each fails
the check that owns it. Two of those were **not** caught on the first run and the causes were
fixed rather than accepted: the rows have no draw landing exactly on a hydrograph point, so the
boundary convention is invisible to grid parity (now asserted directly), and continuous stage
draws can never tie with a threshold, so the passability rule `t > stage` versus `t >= stage` was
unobservable until the generated stages were put on the same 0.1 ft grid as the thresholds.

**The island layer, mutation-checked eight for eight**: the passability rule made inclusive in both
implementations, the boundary definition loosened so water you can drive around is counted as an exit,
the attribution replaced by "the first island in the list" — in the ladder's counts and in the
per-street view — straddling segments counted in both islands instead of one, and the pipeline's own
cut-field cross-check disabled. Two of those were **not caught by any gate over the artifact**
and the cause is a finding rather than a test bug: the tie-break chain that picks between the two
islands a cut road feature straddles is never *decided* by the shipped data — replacing it with "the
lowest island id" leaves every published number byte-identical — so no check reading the ladder can
tell the rule from its rivals, and neither can the reversal gate, because the Python side sorts. The
rule is therefore held where it can be observed: a synthetic two-island graph on each side, in which
the larger side is the **higher** id, so both naive rules put the road on the wrong side and the
test that owns the attribution fails while every artifact gate stays green ([FINDINGS](docs/FINDINGS.md) §14).

### The browser suite

`app/tests/e2e/` (Playwright, `scripts/check.sh --browser`) runs the **built** app in Chromium —
not the dev server, because the worker only registers in a build and the shipped document is not
the source one. Thirty-eight tests in two projects:

```bash
cd app && npx playwright test                      # both projects
cd app && npx playwright test --project=offline    # just the outage
```

- **`app`** (`serviceWorkers: block`) stubs the gauge over the network and holds the claims that
  were driven by hand until now: a live boot that says where it read to, a replay link that never
  asks the live gauge anything, a gauge that cannot be read, the four staleness regimes with the
  badge each one should show, an address resolving to a street and a route out, a street the
  county does not model being refused, the 0-of-50 ensemble, and — new — that the graph the app
  routes on is the graph the pipeline's numbers were computed on, read from the parity line the
  app already prints once per boot and nothing had ever asserted.
- **`perf.spec.ts`** (T8) is the budget the two published render numbers never had, and the one
  claim timing cannot check. The budget is 24 slider steps, live and in replay, at a median under
  40 ms — the 6.2 ms §12 claims, reproduced at 6.0–6.4 ms when the spec runs alone and 9.3–13.3 ms
  behind the rest of `--all`, which is where the ceiling comes from; the numbers are printed on
  every run, with layout and without. The second test counts instead of timing, because one ensemble run costs a fraction of
  a millisecond: it wraps `Math.log` — called by `gauss()` and nothing else in the app — and drives
  the drag on the **text route**, where MapLibre's own `Math.log` calls cannot muddy a count that
  is otherwise exact. 24 steps: **0** draws. The controls are what make that mean something — boot
  computes one run at 2,450 draws, a mode switch forces 2,500, and removing the cache guard turns
  the drag into 58,800 and fails, while the timing test passes with the same mutant.
- **`household.spec.ts`** (five tests) is F3 through the interface a user has: three addresses in
the box in an order that is *not* the answer's order, so a card that echoed the input would fail;
the ranking checked as an order over the numbers the card itself shows; the never-reached address
ranked last rather than first; clicking a row moving the answer without moving the ranking; an
address the index cannot place keeping its row and its reason; and the whole household surviving a
link opened in a fresh context.
- **`island.spec.ts`** (five tests) is F4 where a browser is the only witness: the number on the
panel is the number for the stage being shown, it only ever **shrinks** as the river rises (compared
against itself one stage earlier, never against a constant that could drift from the pipeline), the
emptied island says it is under water instead of quoting a size, and an island bounded by the
extract says so rather than looking like a coastline.
- **`chart.spec.ts`** (four tests) reads the **canvas**, which was the last claim this README kept
  as a human judgement. It records the 2D context's own calls, so the assertion is on the geometry
  the app asked for, not on a screenshot: the observed line's low and its crest, the flat forecast,
  the dashed half beginning exactly one hour of x after the record ends, the crossing marker on
  your street's line at the hour the sentence states, and — with the river 49 ft below a street that
  floods at 60.6 ft — that line still drawn, with the gap on screen equal to the gap in feet. Every
  value is read **back off the canvas** through a scale recovered from the app's own category grid
  (20/45/48/50, exact whole feet, each labelled where it lands), so nothing in the file re-runs the
  app's formulas; and no label is drawn on top of the curve, which is the legibility half. Seven
  mutations of the chart's own code, `drawChart` and the sentence beside it, each fail the test that
  owns them: the axis dropping your street's threshold, the forecast drawn solid, a label moved into
  the plot area, a label detached from the line it names, the observed record not drawn, the marker
  nudged 20 px, and the sentence reporting the high as the low.
- **`offline`** is about the worker, and it takes the **origin away for real**. Three things it
deliberately does not do, each learned by measuring:
  - **not `context.setOffline(true)`** — that stops the page, not the worker. The worker keeps its
    own connection, so an "offline" reload was still refreshing from a live origin and a missing
    file came back with a status instead of a network error. The app is served through
    `tests/e2e/origin-gate.mjs`, which stops answering by destroying the socket when the spec says
    so: for page and worker alike, the origin is gone.
  - **not a stubbed gauge** — Playwright cannot route a request made *inside* a worker, so once a
    page is controlled the real NWPS response arrives. The reading is therefore put into the cache
    by the spec (the state a storm leaves: the last reading kept, the gauge unreachable) and
    asserted there; the app's own hand-over of it is asserted in `check-offline.mjs`, where the
    worker is executed directly and the message can be inspected.
  - **not the live gauge host** — it is unresolvable for that project (`--host-resolver-rules`),
    for page and worker both, because nothing at runtime can make it dead for the worker.

The last human checks moved here in **`share.spec.ts`** (six tests): a copied link opened in a
fresh browser context restores the street, the stage and the mode; two different addresses produce
two different links, each restoring its own; a refused clipboard prints the link rather than
showing a button that appears to work; a cancelled share neither reports success nor silently
copies; the share sheet is handed the answer and not only the link; and the light view survives in
both directions, with `text=1` in the page's own URL — because that URL, not the toggle's href, is
what the copy path takes. Three of those four share paths were mutation-checked (remove the
refusal fallback, drop the `AbortError` guard, drop the answer from the share payload — each fails
the test that owns it); the fourth, dropping `text=1` from `syncUrl`, changes nothing observable,
because the flag already arrives in `location.search` — a redundant line, not a gap in the test.

**Still eyes-only, after `chart.spec.ts`:** whether the picture *reads*. What it draws, where, at
what scale, and that its numbers are the same flood the sentence describes are now checked (its
bytes and its text alternative were already: `check-text-mode.mjs`, and the offline spec reloads
`?text=1` with the origin gone). Whether a reader finds the low and the crest without being told,
whether the dashed half is distinguishable at this stroke width and colour, whether the tick labels
are worth printing at all — that is taste, and no assertion here pretends to it.

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

## Which side of the cut — islands

A route answers *"can I reach the hospital"*. The other question a household asks is **"how much
of the corridor is still one place with me?"** — and it has a different shape, because it is about
the whole network rather than one destination. `pipeline/derive/routing.py` sweeps the same graph
at nine stages, keeping only the edges whose threshold is above the stage, and the pieces that come
out are islands: the roads still reachable from a street **without crossing water**.

**The measurement came first, and it changed the feature.** Before any flooding at all the extract
is already **116 separate networks**, and only **806 of 1,614** segments sit on one that holds a
responder — because the road layer is a bounding-box clip, and a road that leaves the box and comes
back is two roads to this model. Raising the stage splits what is left: **6,552 pieces at 45 ft**,
the largest island down from **2,148** nodes at low water to **698**. So an island here is *roads
reachable without crossing water*, never *ground walled in*, and the app says which it is. Each rung
also counts the islands that reach the study area's own boundary — **19** at low water, **163** at
55 ft — where a road continues outside what is modelled, and a street on one of those is told so
rather than being shown a coastline that is really the edge of the extract.

On screen the panel reports the island the selected street is on, and the map draws its
**boundary**: the flooded segments that lead off it, in amber. The extent is a sentence and the cut
is the picture, deliberately — the layers beneath hold their data, and a several-hundred-segment
island would have to re-upload its geometry on every slider step, which is what the render budget
exists to prevent. Method and the whole ladder: [docs/FINDINGS.md](docs/FINDINGS.md) §14.

## One household, several addresses

Home, school, a parent's house: three addresses, three different answers — and the useful thing
about them together is **which comes first**. So the app takes up to six, separated by `|`, and
renders them as one card ranked by when each one is reached, using the same rule the headline uses
(the earlier of the street's own threshold and the stage its last dry way out is cut) so that a row
and the answer it links to cannot disagree about the same street.

The two orders are kept apart on purpose: the **ranking** is by urgency, and the **answer above**
follows the order the addresses were given in, because that is the user's own choice. The row on
screen is marked, clicking another row moves the answer to it, and every row carries its own
reason when it could not be placed — an address the app cannot find keeps its place in the list
rather than disappearing from it. The whole list travels in the link (`addr=a|b|c`, the row on
screen first), so a plan for three places can be sent to the people it is about.

## The same answer on a bad connection

An address-first tool is used from a phone, often in weather, often somewhere the signal is thin.
`?text=1` renders the answer as text only: no base map, no raster tiles, no canvas chart, no
web fonts. It is the same pipeline output — the same verdict, the same lead time, the same ways
out — with the pixels removed and the sentences kept.

Measured from the build by `scripts/check-text-mode.mjs` — `gzip -9` of exactly the files that
ship, so the number is reproducible by anyone rather than remembered from one browser session:

| | gzipped, same origin |
|---|---|
| entry (the HTML's JS + CSS) | 22.7 KB |
| the 9 data files the app fetches | 276.7 KB |
| **`?text=1`** | **299.4 KB** |
| **full view** | **525.7 KB** (+226.3 KB of MapLibre) |

**226.3 KB saved, 43.1%**, and the 84.6 KB of web fonts and the base-map tiles are not requested by
the text-only route at all — it preconnects to neither font host. The biggest single item is
MapLibre: 227,010 bytes of JS and CSS that every visitor used to download before the first number
appeared, now a separate chunk fetched only when the map is built. The map's own information stays
— *1,187 of 1,614 segments under water* is a line of text, and the hydrograph is summarised from
the same series the canvas draws. (This table was a browser-measured byte count until F4 enriched
the road layer with its isolation fields, which nearly doubled the largest payload file; nothing
was checking the prose, so it had silently aged by ~500 KB. The build check is now the number.)

The route is entered by a link, not a mode switch: `?text=1` travels with the address, the stage
and the data mode, so a light link stays light, and the header's **Full view** / **Text-only**
toggle carries those parameters across in both directions.

## When the connection goes

The hours this app exists for are the hours the signal is most likely to fail. A service worker
(`app/public/sw.js`) keeps a copy of whatever the page has already been asked for, so a reload
with no connection still answers.

**One visit is enough.** Measured on a fresh origin in a real browser: a first load leaves the
9-file payload *and* the current gauge reading in the cache, and a reload with the server
refusing every connection restored the same answer it gave online — *Major flooding* / *Water is
on your street now* / *0 hours of lead time* / *1,337 of 1,614 segments under water*, with the
same street and stage still in the URL. Which bytes came from where is visible, not asserted:
the shell answered with `x-brazoscast-cache: hit` (11,586 B), `ensemble.json` and the 1 MB road
layer with `swr`, and a URL the cache does not hold still failed outright — the control that says
there was no network behind any of it. `?text=1` was reloaded the same way: the full answer, no
map built, no canvas, nothing rasterised.

**The eager set is the shell, and only the shell.** `?text=1` exists for phones where 85 KB of
fonts decided whether there was an answer at all, so precaching the 1.6 MB payload at install
would hand that back with the other hand. Everything else is cached the first time the app asks
for it, at no extra cost, because the app asks for all of it on every boot. What a service worker
cannot cover on its own is the *first* visit — the page fetches its payload before the worker
controls it — so the app reports what it has already loaded (read from the resource timeline, so
it includes the map's content-hashed chunks that no list in the source can name) and the worker
asks for each of those again, which the browser answers out of what it holds. The live gauge is
handed over as the bytes in hand instead, and that path is not a shortcut: its response is **468
KB with no validator**, so a conditional request gets the whole thing again, more than the entire
text-only route saves.

**That hand-over used to be `only-if-cached`, and it copied nothing at all.** It reads like the
cheapest possible step — a cache mode that cannot reach the network — and it cannot be satisfied
by any response these hosts serve: `Cache-Control: no-cache` requires a revalidation, which that
mode forbids, so every copy rejected. Measured in a browser, the payload was reaching the cache by
the ordinary path (the page's own fetches, once the worker controls it) while the map's chunks,
fetched *before* that, were not cached at all — so a first visit followed by an outage rendered
the answer with no map. Two checks had blessed it: the Node harness modelled `only-if-cached` as a
plain cache lookup, and it was only the browser suite that could show the difference.

Four things are deliberately *not* cached, each for a reason that is written where the decision
is: base-map tiles (unbounded in number, opaque, and the OpenStreetMap tile service is not for
offline collection), the webfonts (they are what `?text=1` refuses to download), the previous
build's chunks (pruned when the shell is updated), and a shell that is not complete — a new build
is swapped in only once every file it names is in the cache, because a cached shell naming a
missing chunk renders a blank page, which is worse than not being offline-capable at all.

Cached responses are stored with their encoding headers stripped: a body read in a worker is
already decoded, so keeping the host's `content-encoding` would announce a gzip that is no longer
there and the browser would refuse to parse the page it had just served. The header shows
**offline** when the browser reports no connection — the browser's own signal rather than a probe,
so it claims what it can actually know. In the test above the machine still had internet and the
tag correctly stayed hidden while every byte came from the cache.

To take it back:
`navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))`, then
delete the caches and reload.

## Carrying the answer out

A lead time trapped in one tab does not reach the neighbour who needs it. The street, the
gauge stage and the mode are all in the URL (`?addr=`, `?stage=`, `?mode=replay`), so
**Copy link to this answer** hands over the exact view rather than the front page. Unknown
parameters are preserved, so `?text=1` (planned) survives a link today instead of being
stripped by it. The app writes the URL with `replaceState`, never pushes it: a link is how
the answer travels, the back button is not.

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

### The second extent, and the one thing it can do that Harvey's could not

That last limit — *an event maximum cannot refute a low threshold* — was the reason Step 3 closed
every correction route. It now has an answer, and the answer is that the correction still does not
ship, for a different and much larger reason.

There is a second, independent observation of this reach: the **USFIMR** water edge from a
**Sentinel-1** HV image taken **2016-05-30 00:26 UTC**, partway up the rising limb of the June 2016
flood, cached by `pipeline/fetch/fetch_usfimr_2016.mjs` and scored in
`pipeline/derive/second_event_validation.py`. It is not a second maximum. At the image instant the
Richmond gauge read **49.40 ft** — 5.75 ft below the Harvey peak and, more to the point, **5.75 ft
above nothing**: what it fixes is the stage the water was *photographed* at, from the layer's own
acquisition time and the cached gauge series, cross-checked by running the layer's own
`Q_at_Image` (80,600 cfs) through the rating Step 3 fixed to within 1.2 ft.

That property is what a maximum lacks. At 49.40 ft the model puts **1,312** segments under water; the
image shows **1,241 of them dry**. A segment shown dry at a known stage had not flooded yet, so its
true threshold is *above* that stage — the shipped threshold below it is **refuted**, and this is the
first observation in the repo with anything to say about the below-action segments at all (of the 22,
the image shows 21 dry). Harvey's extent could not have produced a single one of those 1,241: a
segment wet at 55.1 ft is equally consistent with flooding at 17 ft and at 55.1 ft, which is exactly
why every one of its below-action segments was wet.

The image is a radar water edge, so the objection writes itself: it could simply be
**under-mapping** water. The artifact answers with the number rather than an assurance — erasing
every refutation would need the image to have missed **17×** more water than it contains. That is a
large factor, and it is not a proof.

**And then the Harvey-fitted lift fails out of sample.** Applied unchanged — +23.72 ft — to this
second event: it repairs **1,190 of the 1,241** refutations, accuracy 0.230 → 0.926, false-positive
rate 0.805 → 0.033. That looks decisive until the recall column: **0.055**, against 0.973 today. It
buys its accuracy by calling water dry. The reason is visible in the one number a constant offset
cannot move — the **AUC of 0.566** at this stage against **0.809** at Harvey's peak, and 0.566 is on
Harvey's own 1,187-segment evaluated set, not this event's wider corridor, so the two are
like-for-like. A constant lift is rank-preserving: no shift of the thresholds could have changed
that number. **Discrimination, not calibration, is what fails at the lower stage** — so the event
implies a lift of **−2.05 ft** on its own, against Harvey's +23.72 ft, and the two events do not
agree on a single constant.

**What this changes, and what it does not.** It does not change what ships: no correction is still
applied, and the most important reason is no longer "there is only one event" — it is that the
second event says the first event's constant is not the fix. It also does not vindicate the shipped
thresholds; a radar edge at one instant bounds thresholds from below and nothing else. What it does
is move the diagnosis one level: the defect is in the *ordering* the thresholds impose, not in their
level, and a single offset cannot repair an ordering no matter how well it fits one flood. Full
method, the stage sensitivities (day mean, and the layer's own Q) and limits in
[docs/FINDINGS.md](docs/FINDINGS.md) §15.

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
differing in the last ulp must not be able to change a reported count. The ensemble itself does not
move the drag: it is cached on the selection and never recomputed while the stage changes — and
"never recomputed" is counted rather than timed, 24 steps produce **0** of the draws a single
ensemble run needs 2,450 of while a forced mode switch produces 2,500.

**The render cost, re-measured after the bet cards (I2–I6) landed, by A/B against the previous
commit rather than against a memory of a number.** `git worktree add … HEAD`, the same spec on the
same machine, back to back: **8.8 → 11.1 ms** median in live mode and **11.2 → 13.9 ms** in replay,
maxima 11.5 → 13.6 and 13.6 → 22.0. Both are inside the budget the suite asserts (40 ms, ~3× the
worst observation), and both are under a 60 Hz frame — but the *published* 6.2 ms figure was measured
on an idle machine, and this machine now reproduces **8.8 ms on unchanged code**, so the honest
number is the delta (**+2.3 ms**) and not the absolute one. What the +2.3 ms buys is ~20 more DOM rows
per step across the four new cards; the kernels themselves are cheap (the whole cut-set join over
1,614 segments measures 0.3 ms). Method: [docs/FINDINGS.md](docs/FINDINGS.md) §12 and §17.

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

## The alert you would get

Every number above is something you have to be looking at to receive. `pipeline/derive/notifications.py`
turns the answer into what would actually be **sent**, in English and Spanish, and the send is
simulated — there is no carrier, no opt-in and no phone number in this repository. What is real is the
text and the schedule, because those are what can be checked here.

**The tiers are a countdown from your street, and that was a measurement rather than a choice.** The
plan said to hang the alerts on the official categories. The 2017 record says what that would do: the
flood stages arrived at hours 158, 165 and 169 — **7 and 4 hours apart**, three texts in one night — and
none of them would have said anything about *your* street, because your street floods at its own
number. So the three tiers are **T−72 h, T−24 h and T−6 h before that street's own modelled crossing**,
and the official category still appears inside each message as context:

> *BrazosCast 3 days out: the Brazos at Richmond is at 10.6 ft, No flooding. Jackson Street is modelled
> to go under at 40.6 ft — about 72 h from now, Aug 28, 1 AM. Plan a dry route and move what you can.
> This is a model, not an order.*

> *BrazosCast 6 h out: water is expected on Jackson Street at 40.6 ft by Aug 28, 1 AM, about 6 h. The
> river is at 35.2 ft, Action stage. Leave now if you can, by a route you know is dry. 12 inches of
> moving water carries most cars away.*

**The Spanish message is the feature, so the numbers have to survive it.** The templates are compiled
once at build time (`pipeline/notify/templates.json`) and filled by two independent implementations —
the pipeline in Python and the browser in `app/src/lib/notify.ts` — and the tests require the digit
**multisets** to match, not merely the sentences. That is why the crossing time is 12-hour in both
languages: a 24-hour Spanish clock would be better Spanish and would put *different numerals* in the
two messages. The card's own chrome is translated from the same artifact, with a test that no Spanish
string is still the English one.

**Run over 2017, the policy sent for real.** All **1,614** streets went through it and **1,469** cross
their own threshold inside the window — the same population the backcast above reports, by the same
rule. That is **4,407 messages**, three per street: none duplicated, none arriving after the water,
longest 279 characters. Quiet hours (22:00–07:00 local) held **225** sends per held tier to 07:00 and
never the 6-hour one; the longest hold is 9 h and the shortest held tier is 24 h out, so a held
message always still precedes the water.

The card is on screen for whichever street is selected, in either language, and the language travels
in the link (`?lang=es`) so a Spanish-speaking household can pass the answer on.

**Mutation-checked eight for eight**: a digit drifted in the Spanish template, a placeholder dropped,
a Spanish category left in English, the stage ladder moved, the 12-hour clock lost, the quiet-hours
hold removed, and each renderer broken on its own — every one fails the named test that owns it, and
all three files are restored byte-identical. Method and limits:
[docs/FINDINGS.md](docs/FINDINGS.md) §16.

## What the river would have to do

On most days the honest answer to "when does water reach my street" is "it does not", which is true
and useless. The app now finishes the sentence with the record: *this street floods at 33.4 ft; the
gauge last reached that in 2025 (34.76 ft, 1 year ago); the record's highest is 61.20 ft in 1913.
Annual peaks only, at RMOT2.* The record is the cached USGS annual peak series for `08114000` — 111
peaks from 1884 to 2025, filtered to the gage-height parameter (the same USGS file also carries
discharge peaks, in different units, and mixing them would still look like a plausible series) — and
`pipeline/derive/gauge_history.py` refuses to write it unless it is chronological, in feet, long enough
for "never in the record" to mean something, and agrees with the 2017 peak the rest of the repo
publishes. "Last reached" is exact for the question asked: a year's peak bounds every reading in it,
so the last year whose peak passed a stage is the last year that stage was reached. 6 KB, no request
at runtime, and it works during the outage that motivates the product.

## Two gauges, one answer

The app is keyed to one gauge, and until now a second one was only used when the first went quiet. Run
the same transfer whenever the upstream gauges are reporting — at the lag each was fitted at, compared
against the **band measured on held-out events** (−1.56 to +1.01 ft) — and the page gains the one
number that can notice the reading everything else depends on is wrong.

**Measuring it in the browser is what changed the design.** On a quiet river (8.60 ft) both gauges are
below the range the transfer was fitted on — it was fitted on flood events — so both return *clamped
floor* values 2.57 and 1.99 ft above the live reading. Read literally, that is two gauges disagreeing
with the instrument, forever, on the day the page is most likely to be visited. A check that cannot be
made is not a failure: clamped rows are labelled **out of range**, the verdict says the transfer is not
defined at this stage, and only a gauge *inside* the fitted range can raise a disagreement.
`pipeline/tests/test_bets.py` holds the shipped band and knots to exactly that.

## Does the answer survive?

Every published number descends from two estimated quantities: a street's flood stage (measured to run
~22 ft low, with ~11 ft of per-street spread) and the forecast (RMSE measured at several horizons). The
headline quotes a point lead time and says nothing about either. This card re-runs the app's own rule
under each measured error — threshold ±1σ, the corridor lift applied, the forecast ±1σ at the horizon
the answer actually lands on, and the answer quoted only 72 h out — and reports whether the
**qualitative** claim survives. On the quiet-river example above: *"the point estimate is that water
does NOT reach this street in the window… the qualitative answer holds under all 4 perturbations"*, with
the two forecast rows marked skipped and saying why (*already 'not reached'*). Where a perturbation
flips the answer the row is marked, because "31 h" becoming "22 h" does not change a decision while
"31 h" becoming "never in the window" does.

## Dry road, no way out

Every other panel answers for the street in front of you. This one answers the inverse question, which
is the operationally interesting one: **whose route to help is already cut while their own road is still
dry** — no water to see and no way out. It reads the same graph the ways-out panel does, in the same
segment order, and excludes (rather than reports) the streets the extract cannot route a responder to at
any stage.

The set is **not monotone in stage**, and that is a property of the question rather than a bug: a
segment is in it when its route is cut *and* its street is still dry, so the count is the gap between
two curves. Measured at the shipped thresholds: **6** segments at 20 ft, **5** at 25, **294** at 30
(the median street floods at 33.4 ft, so most routes are cut before most streets are wet), **23** at 34,
**116** at 45, **12** at 55 — with the worst trapped window 16.3 ft and, at 30 ft, **142** of the 294
having no modelled hospital route at that stage either. Rows are worst first and the ranking does not
move as the stage does.

## Your own forecast

The obvious question about a product that reads a forecast is *"why should I trust yours instead of the
NWS's?"*, and the honest answer is that you do not have to: the rule is a comparison between a stage
series and one number per street, so any series works. Paste one point per line — `+6, 34.2`, or
`2026-10-18T06:00 41.5` (UTC unless you write an offset) — and the app's own rule runs over it, with the
observed record kept and only the forecast half replaced. Every line it cannot read is reported **by
number and reason**, never skipped silently, because a dropped point moves a crossing time and nothing on
screen would say so. Nothing pasted is stored, put in the URL, or counted in any published figure, and
clear restores the gauge's own series.

## Known defect in the street thresholds

The thresholds treat the HAND height above the nearest drainage as the Richmond gauge stage. That
leaves a systematic error — the HAND reference changes bed elevation along the corridor, and the
residual along-river slope is `−0.92 ft/mile (r = −0.64)`.

Concretely: **13 classified highway segments (11 unique ways — US Highway 90A, East US Highway 90A
and West Grand Parkway South) still sit below action stage** in `road_thresholds.summary.json`. Every affected segment is flagged
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
