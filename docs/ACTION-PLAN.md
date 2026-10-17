# BrazosCast — actionable work plan

> Every item below is sized, ordered, and has a **done-when** that a command can check.
> Nothing here is an aspiration; each one names a file it creates or changes.

**Baseline this doc was written against:** `main` @ `cee1afb`, clean tree, 84 tracked files.
Pipeline env: `/Users/tanay/miniforge3/envs/brazoscast/bin/python` (3.12.15, geopandas 1.2.0,
rasterio, numpy, networkx, shapely — **pytest absent**). Node v24.18.0 / npm 11.16.0.
App builds with `vite` target `es2020`.

---

## 0. Ground rules

1. ~~**Nothing in this project is verified by a test suite, because there is no test suite.**~~
   **Resolved** — `pytest.ini`, `pipeline/tests/conftest.py` and 34 tests now exist, run by
   `scripts/check.sh`. The finding it records is kept because it is why section 2 exists.
   Confirmed: no `pytest.ini`, `pyproject.toml`, `setup.cfg`, `conftest.py`, no
   `vitest.config.*`, no test files anywhere; `app/package.json` devDeps are only
   `typescript` and `vite`. Every check today is an inline `assert` gate printed to stdout
   inside a `pipeline/derive/*.py` script, or a human driving the browser.
2. **A script that prints "OK" is not a test.** The gates in `road_thresholds.py`,
   `ensemble.py`, `backcast.py` and `harvey_validation.py` are good and must be kept —
   but they only run when someone runs the script, and they only check the shipped data.
   Section 2 turns them into a suite that runs on demand and in CI.
3. **Never weaken a gate to make a change land.** If an item below requires changing an
   assertion, the item must say so and justify it on measurement.
4. **Definition of done for every item:** the named file exists, its command exits 0, and
   the stated `done when` output was observed — not inferred.

---

## 1. Fix real defects (do these first)

### D1 · The address box cannot resolve a real address — ✅ **DONE**

**Shipped.** `pipeline/fetch/fetch_fbcad_roads.mjs` caches county road centerlines with TIGER
address ranges; `pipeline/derive/address_index.py` maps those ranges onto **same-named** app
segments and emits a 34 KB static index; `selectByRoadName` is replaced by a tiered `resolveAddress`.
Verified in the browser with **no Mapbox token present**: six real addresses resolve to the correct
street and segment (`1600 Jackson Street` → segment 1473, 40.6 ft), a street the app does not model
is refused, a typo is offered the real address that works, and a number outside the county's range is
told the nearest listed numbers.

**Three corrections the measurements forced, each of which changed the design:**
1. **The mapping must be by street NAME, not nearest-neighbour.** A proximity snap sent real
   Thompson Ferry Road addresses to *Oilfield Road* and *Lake Olympia Parkway* — different streets.
2. **The snap radius is a quality gate, and 2 km was far too generous.** Agreement with a map click
   falls off monotonically with snap distance (79.7% at 0-10 m, 45.7% at 100-400 m, 16.6% at
   1-2 km), so the radius was cut to **50 m**: a county road in a different city that shares a name
   is a different road. Coverage fell from 1,012 to 819 ranges and quality rose accordingly.
3. **`nearestRoadIndex` compared CENTROIDS, which is wrong** — a long segment's centroid can sit far
   from a point lying on the segment. It now measures distance to the geometry (vertices flattened
   once at load). Measured effect on the acceptance criterion: agreement went from **62.0% to 96.8%**
   of the 899 attached ranges naming the same segment a map click returns. The residual 29 are a
   dense street grid (Avenue D vs West Street, Preston Street vs North 2nd Street) where centrelines
   differ by metres and the ambiguity is real.

**Effort S. Highest user-visible impact.**

`selectByRoadName` in [app/src/main.ts](app/src/main.ts#L420) does a substring match on
road *names* only, and falls back to Mapbox **only if `VITE_MAPBOX_TOKEN` is set** —
which it is not by default. The input's own placeholder invites
`4710 Thompson Ferry Rd, Richmond, TX`, a string that can never match a bare road name.
So the app's headline interaction fails for the exact input it suggests.

The documented fallback is worse than useless — measured, not assumed:

| probe | result |
|---|---|
| Census Geocoder CORS preflight, 2 origins | **no `Access-Control-Allow-Origin` at all** |
| Census `Public_AR_Current` / `ACS2026` / `Census2020` / `LUCA` — Richmond TX addresses | **0 matches, all four benchmarks** |
| same endpoints — Washington DC / Austin / Houston addresses | matched |
| Overpass (node count, trivial query) | `502 ... request queue is full`; kumi mirror 500 |
| FBCAD open data hub | **HTTP 200** |

`docs/PLAN.md` §5 recommends the Census Geocoder as the zero-key default. **That
recommendation is now measured-wrong** and the plan should be corrected (§2 of D1 below).

**Do**
1. Add a build-time offline index: `pipeline/derive/address_index.py` →
   `data/derived/address_index.json` + `app/public/data/address_index.json`.
   Source it from Fort Bend County's own parcel/address data (FBCAD hub answers 200), **not**
   Nominatim/Census. If the hub exposes no address-point layer, fall back to counting
   `addr:housenumber` nodes from OSM as a one-time offline fetch, and say so in the ledger.
2. Match order in `selectByRoadName`: **normalized address → house number + street name →
   street name → fuzzy (edit distance ≤ 2) → map click**. Keep the Mapbox path but demote it
   behind a visible "use Mapbox (needs token)" toggle.
3. Correct `docs/PLAN.md` §5 with the CORS and coverage measurement, and record both in
   `docs/DATA-SOURCES.md`.
4. Replace the placeholder with a string the app can actually resolve, or keep it and make
   it resolve.

**Done when** pasting each of 5 real Richmond addresses returns the same street a map click
returns, with `VITE_MAPBOX_TOKEN` unset, and a 6th nonexistent address fails with a message
that suggests a nearby real one.

**Caveat to keep in the write-up:** the Census coverage result is scoped to the queries I
ran and cannot separate "no coverage" from "that house number is not in the source file".
The CORS result is unambiguous on its own.

---

### D2 · You cannot send anyone their result
**Effort S.** — ✅ **DONE** (with **F2**)

No `URLSearchParams`, no `location.search`, no `history.pushState`, no `navigator.share`,
no `navigator.clipboard` — none exist in the app. The answer is rendered and then trapped
in the tab. Lead time is only useful if it can be *carried* — to a neighbour, a parent, a
group chat.

**Do**
1. Encode state in the URL: `?addr=`, `?stage=`, `?mode=live|replay`, `?text=1`.
2. Read it on boot in `boot()` before the first `render()`.
3. "Copy link" button in the answer card, using `navigator.share` where available.

**Done when** an address→URL→fresh-load cycle restores the same street, stage and mode, and
two different addresses produce two different URLs.

**Shipped, and verified that way in a browser.** Shifted earlier than the plan assumed: the URL
is read **before the first fetch**, so a replay link does not make a live gauge request only to
throw it away. Two things the plan did not anticipate, both found by testing rather than reading:

- **`render()` ran before the URL was applied**, and render writes the URL — so boot described
the default view over the parameters it was about to consume and *every shared replay link
arrived stripped*. Fixed by capturing the incoming parameters once at boot and suppressing URL
writes until they are applied. A link that silently loses its own state is worse than no link:
it looks like it worked.
- **The typed text and the clicked road disagreed.** Preferring the address box would make a
link copied after a map click restore the *previous* street while the page showed the new one.
The typed text is now carried only when it resolves to the street actually on screen — otherwise
the selection wins, which is what the user is looking at.

`?text=1` was briefly *encoded for but not implemented*: unknown parameters are preserved, so the
flag round-tripped before the mode existed. It is now implemented — see **F5**. "Copy link" uses
`navigator.share` where it exists and falls back to the clipboard, with a third path that prints
the link when the clipboard is refused rather than a button that appears to work.

**All three exit paths are now driven in a browser** (`app/tests/e2e/share.spec.ts`), because they
are claims about a browser and not about this code: a fresh context (not a reload — a reload keeps
the module's state, so "the link restored it" would be unfalsifiable) opens the copied URL and must
show the same street, stage and mode; the clipboard is read back, so a refusal is asserted rather
than assumed; a cancelled share must leave no trace at all, including on the clipboard; and the
light view must share a light link. Three of the four share mutations fail the test that owns them
(no refusal fallback, no `AbortError` guard, the answer dropped from the share payload). The fourth
— removing `p.set(TEXT_PARAM, "1")` from `syncUrl` — fails nothing, and that is a finding rather
than a gap: the flag already arrives in `location.search`, which is where `syncUrl`'s parameters
come from, so the line is defensive. The source test in `test_text_mode.py` still pins it.

---

### D3 · The declared threshold defect (13 highway segments below action stage) — ✅ **CLOSED, NEITHER WAY** (I1 did it)
**Effort M. Do not attempt to "fix" it — close the data gap.**

Verified directly against `data/derived/road_thresholds.json` (threshold field is `at`,
confidence field is `conf`):

| filter | count |
|---|---|
| all segments below action (`at` < 20) | 22 — primary 13, tertiary 5, secondary 4 |
| classified below action (primary/secondary/motorway/trunk) | 17 segments, 14 unique ids |
| **primary below action** | **13 segments / 11 unique ways** |

All 13 carry `conf: "low"` and the app says so on screen rather than asserting a threshold
it cannot defend. The 11 unique ways are `US Highway 90A`, `East US Highway 90A`, and
`West Grand Parkway South` — osmid `20898558` alone accounts for 3 of the 13 segments, which
is why the segment count and the way count differ. Five correction routes were built and all
five are closed by measurement.

The measured magnitude is **+22.30 ft (best-cut) / +23.72 ft (probit MLE)**, a *constant*
bias, and the per-street spread is **σ = 11.36 ft** — which cannot be corrected by an offset.

> **First real catch for T2, found while writing this doc:** README §"Known defect" names the
affected ways as "US 90A, Grand Parkway, **State Highway 6**". State Highway 6 is *not* below
action stage — its minimum threshold is 29.3 ft (`harvey_validation.json` → `named_offenders`
→ `State Highway 6 South`), and it is named there for over-prediction, not under-prediction.
The README's counts (13 / 11) are correct; the way list is not. Fix the README as part of D3.

**Do** — in priority order:
1. **Get a second observed extent** (see I1). `docs/UPGRADE-PLAN.md` calls this the
   highest-value outstanding item in the plan. Nothing else closes D3.
2. Only then, re-run `harvey_validation.py` with two events and fit the correction
   out-of-sample instead of in-sample.

**Done when** either (a) the correction is validated on a second event and applied, with the
README's 22 ft figure updated to the two-event number; or (b) the second event confirms the
constant and the defect is formally declared permanent pending a HAND re-run.

**✅ Closed by I1, and by neither branch.** The second extent exists and the correction was scored
out-of-sample on it — branch (a) and (b) both assumed the constant would survive, and it does not:
at 49.40 ft on the rising limb of the 2016 flood the image shows **1,241** segments dry that the
shipped thresholds submerge, Harvey's **+23.72 ft** lift repairs **1,190** of them but at a recall
of **0.055** (shipped: 0.973), and the within-event **AUC falls 0.809 → 0.566** on Harvey's own
1,187-segment set. A constant offset is rank-preserving, so this is a statement no shift can
answer: **the defect is in the ordering, not only in the level.** The correction stays unapplied —
now because the second event says it is the wrong *kind* of fix, not merely because there was only
one event. What a clone can check: `pipeline/derive/second_event_validation.py`,
`pipeline/tests/test_second_event.py`, FINDINGS §15. The 22 ft figure itself is unchanged and still
in the README, labelled as measured on Harvey alone.

---

### D4 · Repository hygiene decisions that are currently half-made
**Effort S. One decision, not code.** — ✅ **DONE** (option **(a), extended**)

`data/raw/harvey/Brazos_upper.zip` (2.0 MB) and two ~460 KB NWPS `_stageflow.json` files are
tracked, while `.gitignore` excludes `data/raw/hand/` and `data/raw/usgs/` under
"large raw inputs (re-fetchable)". `data/raw/nwps/*.json` is tracked, so the policy is
already inconsistent.

**Do:** pick one and make `.gitignore` say it:
- **(a) keep them** — a clone reproduces the validation layer; add `data/raw/nwps/` to the
  comment so the exception is deliberate, or
- **(b) drop them** — ignore `data/raw/harvey/`, keep `_receipt.json` tracked.

**Done when** the ignore rules and the tracked set agree, and `git status` is clean either way.

**Shipped as (a), because the reason for (a) turned out to be a rule and not two exceptions.**
Committing the Harvey zip keeps "a clone reproduces the validation layer" true; the same argument,
applied to every input instead of to the two named here, is what the section now states:

> A raw input is **committed** when it is small **and** one of: a receipt or manifest of what was
> fetched; a stable historical record a published number descends from; or a snapshot of a live
> product the artifacts were derived from — re-fetching a live product returns *different* data,
> so the artifacts would stop being derivable from the cache. It is **ignored** when it is bulk and
> one committed command re-creates it.

So every rule now carries the size and the command that re-creates what it ignores, and the two
exceptions that survive a wholesale exclusion are marked. Tracked: **13.7 MB across 20 files** —
the two files I1 added are `data/raw/usfimr/`'s. Ignored: **162 MB**, each with its recreate
command. The full inventory, with sizes, is [DATA-SOURCES.md](./DATA-SOURCES.md) § "Raw inputs —
what is tracked, and why".

**Two inputs were in the wrong class, and the rule is what found them** — neither was on this
item's list of two files:

1. **`data/raw/usgs/iv/08114000_20170822.json` (493 KB) was ignored, and it is the wrong file to
   ignore.** It is the 2017 interval record — the only input to `backcast.py`, `ensemble.py` and
   `harvey_validation.py` and the source of the series the app replays — and it sat inside a tree
   excluded wholesale by `data/raw/usgs/`. A clone could not re-derive the backcast or the
   ensemble, and `test_source_integrity.py`, which asserts the record is present *precisely because
   the backcast has no other source*, could not pass either. The rule was also wrong about its own
   claim: `iv/` is written by `pipeline/analyze/travel_time_subdaily.py`, not by
   `pipeline/fetch/` — and `hand/` has no fetcher at all, so "re-fetchable via pipeline/fetch" was
   untrue of both trees it named.
2. **`data/raw/fbcad_roads.json` (2.8 MB) was neither tracked nor ignored.** The FBCAD centre lines
   are the *sole* input to `address_index.py`, whose output ships inside the app, so this file is
   the provenance of the address box — and it showed up as `??` on every `git status`, which is how
   a load-bearing input stays undecided. It is now declared committed.

Resolution required a negation rule (`data/raw/usgs/iv/*.json` excluded, that one file re-included),
and a negation is fragile in exactly one way: git cannot re-include a file whose parent directory
is excluded, so broadening the rule above it back to the directory form silently re-ignores the
record. That is the original defect, one keystroke away — so it is gated rather than trusted.

**Done-when evidence:** `pipeline/tests/test_raw_input_policy.py` (4 tests, `scripts/check.sh`)
holds the exceptions un-ignored, the bulk caches excluded, a *neighbour* of the exception still
excluded (the leak a widened negation causes), every rule carrying a reason that names a size or a
recreate command, and the `.gitignore` → `DATA-SOURCES.md` pointer resolving. **Eight mutations
test it** — the original defect (directory form instead of the file glob), the negation deleted, the
negation widened to the whole `iv/` tree, the reason block deleted, a new rule added with no reason,
an exclusion's size and command stripped, `hand/` un-ignored, and the policy heading renamed — and
each fails the test that owns it, with the control still passing and every file restored
byte-identical. The measurements: `git check-ignore -q` now says *not ignored* for exactly the two
exceptions and *ignored* for the three bulk trees, and `git ls-files --others --exclude-standard --
data/raw` lists exactly those two — **plus I1's `usfimr/` pair**, which needs no rule because it
sits outside every excluded tree; that makes four, and DATA-SOURCES.md § "Raw inputs" is the record.

**Also found while measuring:** the rule `data/raw/*.tmp` guarded a pattern **nothing in the repo
writes** — the only occurrence of `.tmp` anywhere is that line itself — so it was dropped rather
than left looking like it protected something. And "`git status` is clean" cannot be observed while
this whole plan is uncommitted; what *can* be observed, and is, is that no path under `data/raw/`
is left in the ambiguous untracked-and-unignored state without being declared committed.

**Cost, stated, and then measured rather than stated.** The claim "a clone must fetch X" is
falsifiable, so the clone content was materialised (the files `git ls-files` and
`git ls-files --others --exclude-standard` name) and the suites run against it. It corrected the
guess twice: the golden regression needs the **USGS daily series as well as** `hand/` (its second
failure is `gauge_redundancy.py` dying as `KeyError: ['HPDT2']`, which names neither the missing
file nor the fetch command), and after this item's fix only **one** of the five source-integrity
tests still needs a bootstrap, because three of them read files that were just committed. Verified:
with the USGS caches and `app/node_modules` the fast suite is **65 passed**, and with the HAND
archive added the golden regression passes.

**Re-measured for I1, which added a committed raw input and a test that reads an ignored one.** The
clone is now 136 files / 19 MB and the bootstrap is **two** commands, one download and one install:
alone, the golden regression fails three stages and the fast suite three tests; with the daily/peak
caches and `app/node_modules`, one fast test is left; with the event caches
(`travel_time_subdaily.py`) as well, **82 passed, 2 skipped**; with the HAND archive, the golden
regression reproduces all 12 artifacts. The full table is in DATA-SOURCES.md § "Raw inputs". 162 MB
is not going into git to make a test feel self-contained.

---

### D5 · Raw-source integrity is asserted nowhere
**Effort S.** — ✅ **DONE** (by **T5**, as this item directed)

`data/raw/harvey/_receipt.json` and `data/raw/usgs/_summary.json` exist, but nothing checks
them. A silent re-fetch can change a published number and no gate notices.

**Do** → covered by T5 below; listed here because it is a correctness defect, not just a test.

**Shipped** as `pipeline/tests/test_source_integrity.py`, which holds the Harvey receipt's per-file
byte counts, the manifest's claim and gauge counts, every USGS site's summary against the length of
its cached series, and — added while doing D4 — the FBCAD cache's own counts and the presence of the
2017 interval record.

**The interaction with D4 is the thing worth recording here, and it is why D4 was not cosmetic.**
Before it, three of these five tests read files `.gitignore` excluded (the USGS summary and series,
the FBCAD cache, the 2017 interval record), so the suite that exists to make the raw layer
verifiable could not run on a clone at all — while silently passing on every machine that happened
to have the caches. After it, the FBCAD cache and the interval record are committed and only the
bulk USGS series is a bootstrap step, failing with a missing-artifact message that names the file.
A gate that only works on the author's machine is not a gate.

---

## 2. Test infrastructure — the missing verification layer

### Setup (do once)

```bash
# Python
/Users/tanay/miniforge3/envs/brazoscast/bin/pip install pytest
# JS
cd app && npm i -D vitest @vitest/coverage-v8
# browser e2e (T7 only, when you get there)
npm i -D @playwright/test && npx playwright install chromium
```

Add to `app/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`.
Create `app/vitest.config.ts` mirroring `vite.config.ts`'s `base: "./"`.
Create `pipeline/tests/` and a root `conftest.py` that inserts the repo root on `sys.path`.

### T1 · Golden-artifact regression — `pipeline/tests/test_golden.py` · **S** — ✅ **DONE**
**Shipped**, and the hand-verification is now automated. It copies the repo to a temporary
directory, re-runs the chain in order, and diffs all **12** artifacts (timestamps excluded) —
I1 added `second_event_validation.json` to the chain and it reproduces too.
Measured first: the chain reproduces every artifact **identically**, so a diff means behaviour
changed rather than that a run wobbled. ~3 min, dominated by `harvey_validation.py` (99 s),
so it is marked `slow` and run by `scripts/check.sh --all`. **Not covered:** the two network
fetches and the `analyze/` stages, which read the live USGS API; they are outside the chain.

Determinism is currently verified by hand (`cp` artifacts → re-run → compare). Automate it:
run all derives, compare to the committed `data/derived/*.json` while ignoring
`generated_at`-style timestamps, and require byte-equality elsewhere. This is the safety net
for every number in the README.
**Done when** `pytest pipeline/tests/test_golden.py` passes, and deleting one artifact makes
it fail.

### T2 · Doc/artifact drift — `pipeline/tests/test_doc_drift.py` · **S** — ✅ **DONE**
**Shipped.** Two things the plan did not anticipate. One: the test originally searched the README
and FINDINGS **concatenated**, so a number could drift out of the README while the other document
still mentioned it — a deliberate-mutation check caught that the test was too weak, and it now
asserts per document. Two: comparing formatted strings is brittle in a way that hides real drift
(the README writes "+22.3" and the artifact holds 22.30, which must agree; the README writing
"+22.3" against 22.34 must not), so numeric claims are extracted from the prose and compared
within the precision the prose states. Both fixes were verified by breaking the README on purpose
and watching the right assertions fail.

The SH 6 case landed already fixed, so the regression asserts it stays fixed.
A ~40-assertion checker was written ad hoc this session and thrown away. Make it permanent.
Every one of these was verified against the artifact while writing this plan, so each is a
real assertion with a real source:

| figure | value | artifact |
|---|---|---|
| segments | 1,614 | `road_thresholds.json` / `.summary.json` |
| median threshold | 33.4 ft | `road_thresholds.json` (`at`) |
| low-confidence | 128 | `.summary.json` (`low_confidence_segments`) |
| primary below action | 13 segments / 11 ways | `.summary.json` (`known_defect`) |
| required lift | +22.30 / +23.72 ft | `harvey_validation.json` (`estimators_of_the_same_lift`) |
| per-street σ | 11.36 ft | `harvey_validation.json`, `ensemble.json` |
| segments cut off before their street floods | 609 | `routing.summary.json` |
| trapped before flood | 230 | `isolation.summary.json` |
| flags at crest, shipped | 1,469 of 1,614 | `harvey_backcast.json` (`correction_tradeoff`) |
| median street lead time | 96 h | `harvey_backcast.json` |
| action-stage onset | 109 h before crest | `harvey_backcast.json` |

The project's stated fear is docs and artifacts telling different stories; this is the guard,
and **it already has a known failing case** — README names State Highway 6 among the
below-action ways (see D3). Land the test with that assertion and let it fail, then fix the
README.
**Done when** intentionally editing one number in the README fails the test, and the SH 6
assertion passes.

### T3 · Cross-language grid parity — `app/src/lib/*.ts` + `pipeline/tests/test_grid_parity.py` · **M** — ✅ **DONE**

**Shipped.** Four kernels moved into importable modules — `app/src/lib/ensemble.ts`
(`runEnsemble`, `rmseFt`, `mulberry32`, `gauss`, `firstForecastIndex`), `backcast.ts`
(`tierOnsets`, `flagCounts`), `transfer.ts` (`applyTransfer`, `applyTransferClamped`) and
`series.ts` (the `Pt` type they share) — with the state they used to read passed in as arguments,
which is what makes the pipeline's grid reproducible outside a running page. `main.ts` keeps what
belongs to the app: the instant hours are measured from (`seriesRef()`), the observed/forecast
boundary, and the population the backcast counts over (`roadThresholds`, derived once with the
other per-segment arrays instead of rebuilt per render).

`app/tests/unit/grid-parity.test.ts` (**41 tests**, `cd app && npm test`, vitest now a devDep with
`vitest.config.ts` whose `include` is explicit because the default glob also matches the Playwright
specs) recomputes the ensemble's **16 rows** and the backcast's **17** — counts, all three
quantiles, `never_h` — and requires each to equal the pipeline's row **exactly**, plus the
transfer's knots, its clamp and the bracket between knots. `pipeline/tests/test_grid_parity.py`
drives it from the pipeline suite and holds the two identities a TypeScript test cannot: the
replay series the app is served is the series `ensemble.py` computed its grid on (241 points
compared one by one), and the app's 1,614 thresholds are the pipeline's own (`road_thresholds.json`
`at` == the geojson's `flood_stage_ft`, which nothing had compared either).

**Three things the plan did not anticipate.**

1. **`checkBackcastGrid()` was never called.** It exists, it recomputes all 17 backcast rows, and
   it was reachable only as a property on the DEV-only inspection hook — nothing invoked it, so the
   "cross-check the browser must reproduce" was a function nobody ran. Found while looking for the
   hook the plan blames. The grid now has a real owner; the function stays for the dev hook.
2. **`dijkstra` was not extracted**, deliberately. The routing parity the plan wanted visible is
   already asserted for the app's *own* run: `parityCheck()` logs one line per boot, and
   `boot.spec.ts` now reads it (28th browser test). Extracting the max-min search would mean
   rewriting 200 lines of indexed typed arrays bound to `main.ts`'s load path to gain a check that
   exists — no coverage, real risk. The kernels that were extracted are the ones with grids.
3. **Two mutations were invisible on the first pass, and the causes were fixed rather than
   accepted.** The shipped rows contain no draw that lands exactly on a hydrograph point, so
   `v >= tau` versus `v > tau` is invisible to grid parity — now asserted directly, with tau's 4 dp
   rounding (a threshold 1e-6 ft *above* an observed stage still crosses in every member). And
   continuous stage draws can never tie with a threshold, so `t > stage` versus `t >= stage` in the
   BFS pass was unobservable until the generated stages were put on the same 0.1 ft grid as the
   thresholds.

**Done-when evidence:** nine mutations, each failing the check that owns it — an off-by-one
crossing count, the crossing boundary moved, tier onsets measured from the wrong instant, the flag
rule made exclusive, the transfer interpolation off by one index, a bottleneck stamped above the
cut, the BFS passability rule made inclusive, the forecast-error curve's first segment flattened,
and the held floor dropped below its last knot. Every mutated file restored byte-identical
(`cmp`). The harness itself checks its baselines first, because a silent build failure reads as a
caught mutant — the trap recorded under T7.

**Not done:** the half of the app's TypeScript that has no grid (`nearestRoadIndex`, the address
parser, `editDistance`) is exercised only through the browser suite.

### T4 · Payload contract — `pipeline/tests/test_payload_contract.py` · **S** — ✅ **DONE**
**Shipped, and it found three real defects on first run:**
1. `address_index.json` declared `max_distance_m` in the app's TypeScript type and the artifact
   never carried it — a field the app's own contract promised and nothing provided. Added.
2. **`road_thresholds.json` (287 KB) and `stage_area_curve.json` were exported to the browser and
   fetched by nothing.** Dead payload on every page load, directly against the low-bandwidth goal.
   Removed from the export list.
3. `app_data.py` only ever ADDED files, so a retired artifact stayed in the shipped bundle forever.
   It now prunes anything outside the current payload — which is how those 287 KB kept being
   deployed after they stopped being read.

`scripts/check.sh` also diffs `app/dist/data` against `app/public/data`, because a stale build
serves artifacts from a previous pipeline run and every fast test would still pass.
`app_data.py` hard-fails only when `isolation_ft` is missing. Assert every field the app
reads exists with a sane range, per artifact: `road_thresholds.geojson` properties
(`threshold_ft`, `confidence`, `isolation_ft`, `isolation_status`, `osmid`),
`ensemble.json`, `harvey_validation.json`, `harvey_backcast.json`, `routing_graph.json`.
The app silently degrades when a field disappears; this makes it loud.
**Done when** removing one field from each artifact fails with a message naming the artifact,
the field and the segment.

### T5 · Source integrity — `pipeline/tests/test_source_integrity.py` · **S** — ✅ **DONE**
**Shipped.** Checks the Harvey receipt's per-file byte counts against disk, the manifest's claim and
gauge counts against the cached rows, every USGS site's summary against the length of its cached
stage/flow/peak series, the FBCAD cache's own counts, and that the cached 2017 interval record the
backcast replays is still present. Deliberately not strengthened into a checksum test where no
checksum exists — a hash invented here would be this script vouching for itself.

Adding it caught two of my own wrong assumptions rather than data problems, which is the useful
outcome: the OpenFEMA cache stores `{metadata, NfipClaims}` and the USGS files `{site, peaks}` /
`{site, stage_daily, flow_daily}`, so the first version measured `len(dict)` = 2.
Verify `data/raw/harvey/_receipt.json`, `data/raw/manifest.json` and `data/raw/usgs/_summary.json`
against the files they describe (size + checksum where present).
**Done when** truncating one cached file fails the test.

### T6 · Invariants over random inputs — `pipeline/tests/test_invariants.py` · **M** — ✅ **DONE**

**Shipped** as five property tests in `pipeline/tests/test_invariants.py`, run by
`scripts/check.sh` (fast, **1.7 s**), and it prints what it drew: **2,280 generated nodes and
57,000 (node, stage) reachability reads**, 600 ensemble runs over generated hydrographs, 1,501
horizons, and the shipped road layer. The kernels are the pipeline's own, imported rather than
re-implemented.

| promise | generated inputs | assertion |
|---|---|---|
| a rising gauge never **opens** a way out | 40 random networks, 1,000 random stages | `widest_path` and `bfs_reachable` answer the same question, exactly: reachable ⟺ stamped above the stage. Plus: a refuge node is never stamped; a node is stamped iff its component holds a refuge; the reachable count never grows with stage |
| your last way out is cut at or before your street floods | and that a stamped value is a real bottleneck | `isolation_ft <= flood_stage_ft` and `gap == flood_stage_ft - isolation_ft` over all 1,614 segments, `isolation_ft is None` iff `status == no_dry_refuge` |
| forecast error **grows** with the horizon | 1,201 horizons + 300 random | non-decreasing; rises *inside* every knot interval (flat is not growth); held exactly flat past the last knot; every knot hit |
| a higher threshold never crosses more often | 300 generated hydrographs | `crossing(lo) >= crossing(hi)` on the observed path, quantile ordering, `never_h == of - crossing`, determinism, and the crossing boundary with the error model off |
| the published grids never invert | the shipped grids | ensemble rows non-increasing in threshold with spread present; flag rows monotone in stage and `corrected <= shipped`; tier onsets ordered and inside the event |

**Two findings, both from the assertion rather than from reading.**

1. **The forecast-error curve misses its own last knot by 0.00035 ft**, because the held value is
   the knot *rounded to 3 dp* (`FORECAST_FLOOR_FT = 6.057` against a knot of 6.057354). So there is
   a downward step of exactly that size at 7 days — three orders of magnitude below the ±11 ft
   spread it feeds, and not corrected here because the floor enters every draw past day 7 and
   therefore every count in the verification grid. It is now pinned to 1e-3 ft so it cannot grow
   unnoticed, and the pipeline's own gate only ever asserted the *first* knot.
2. **A higher threshold can, rarely, cross more often on the forecast path** — measured 2 in 300
   generated pairs, against 0 in 300 on the observed path. It is not a rounding bug: the members
   are not the same 50 scenarios at two thresholds, because a member consumes PRNG draws until it
   crosses, so the stream position after member *m* depends on where member *m* crossed (only 6 of
   50 members share a threshold draw at two thresholds). That is why `ensemble.py`'s own gate
   covers the `observed_only` rows and not the forecast rows — and why the assertion here is the
   observed-path one. It is recorded in `docs/FINDINGS.md`, whose sentence "a higher threshold must
   never cross more often" read as a property of the ensemble when it is the gate's scope that is
   true. The app's block is a per-street uncertainty budget, not a shared scenario set.

**Also asserted, and not from the plan:** the threshold term is rounded to 4 dp before the
comparison, so a threshold 1e-6 ft above an observed stage still crosses in every member. Pinned,
because it reads as a bug the first time it is met.

**Done-when evidence:** two injected inversions (a bottleneck stamped above the true cut; the BFS
passability rule made inclusive) each fail the test that owns them, alongside the non-decreasing
and grid-ordering mutants above — nine for nine in the T3/T6 harness. **Not covered:** no
generated *road geometry* is fed through `isolation.build` (the graph kernels are tested directly),
and the flag-count rule is tested on the shipped grid rather than over generated thresholds — the
rule is one comparison, so a Python property test of it would be testing numpy.

### T7 · Browser e2e with a mocked gauge — `app/tests/e2e/` · **M** — ✅ **DONE**
**Shipped** as 28 Playwright tests in two projects (`scripts/check.sh --browser`, `--all`), run
against the BUILT app: `app` (worker blocked, gauge stubbed over the network) and `offline` (the
worker is the subject). The suite has since grown past the T7 sketch: `perf.spec.ts` (T8),
`share.spec.ts` — six tests that take D2's link round-trip, its two copy paths and the text toggle
out of the README's hand-checked list — and `chart.spec.ts`, four tests that take the canvas: the
observed line's low and crest, the dashed forecast half on the same time axis, the crossing marker
on your street's line at the hour the sentence states, and your street's line still drawn when the
river is 49 ft below it, with the gap on screen equal to the gap in feet. Every value is read back
off the canvas through a scale recovered from the app's own category grid, so no assertion restates
the app's arithmetic; seven mutations of the chart's own code — `drawChart` and the sentence beside
it: axis without your street's threshold, forecast solid, a label over the curve, a label detached
from its line, the record undrawn, the marker moved, the sentence's high and low swapped — each fail
the test that owns them. (One attempt at "the record is undrawn" was rejected by `tsc` rather than
by the test, which is why the mutation that ships in the record is the type-safe one; the check that
would have reported it as caught now refuses to report a suite that never ran.) What is left as a human
judgement is narrower than "is it legible": it is taste, not placement. Coverage as specified — live boot, replay boot, gauge outage, all four
staleness regimes with the badge each one should show, 0-of-50 ensemble, address→route — plus a
refusal case and the F6 outage set. The address case was never D1-blocked in the end: F1 shipped
an offline index, so a typed house number resolves with no token.

**Three things only the browser could show, each now written into the spec and the harness:**

1. **The Cache API keys on `Vary`.** The preview server sends `Vary: Origin`; the install stored
the shell's files from a request with no `Origin` and the document's `crossorigin` module and
stylesheet requests carry one, so every replay was a false miss and, with the origin gone, the
asset failed outright. Reads now pass `ignoreVary`. No in-process shim can produce this.
2. **`context.setOffline(true)` is not an outage.** It stops the page, not the worker: the worker
kept its own connection, so an "offline" reload was still refreshing from a live origin and a
missing file answered with a *status* rather than a network error — a passing test that meant
something else. The offline project runs against `tests/e2e/origin-gate.mjs`, which stops
answering by destroying the socket; the gauge host is made unresolvable at the DNS layer
(`--host-resolver-rules`), because nothing at runtime can make it dead for the worker.
3. **Playwright does not route the worker's inner requests,** so a stub on `page.route` is
bypassed the moment the page is controlled and the real 468 KB NWPS response arrives. That is why
the reading in the offline spec is put into the cache by the test, and why the app's own hand-over
of it is asserted in `check-offline.mjs` instead — where the message can be inspected directly.

### T8 · Performance budget — `app/tests/e2e/perf.spec.ts` · **S** — ✅ **DONE**
The docs claim **6.2 ms median over 24 slider steps** (idle machine; the same code measures **8.8 ms** on
a busy one, and the bet cards add **+2.3 ms live / +2.5 ms replay** by A/B — `FINDINGS` §17) and that the ensemble "is not
recomputed while the stage moves". Both are now asserted, in the `app` project so they run
against the BUILT bundle with the gauge stubbed.

**The budget.** 24 slider steps in live mode and again in replay (where the backcast block is
on screen too), each step timed twice: the `input` handler's own work, which is what the
published figure means, and the same step with style and layout forced, which is what the user
waits for. Measured here: **6.0–6.4 ms median** when the spec runs alone — the published 6.2 ms,
reproduced — against a **40 ms** ceiling set from the load, not from taste: the same test inside
`--all`, behind the pipeline regression and the build, measures **9.3–13.3 ms**, so a ceiling
near the published figure would fail on a busy run and mean nothing. At ~3x the worst observed
it still catches what it is for — per-step cost that grows with the payload (an extra pass over
the 1,614 segments, a timeline rebuilt per frame) rather than a slower machine; the mutant that
renders ten times per event measures **59 ms** and fails. Every number is printed on each run, so
drift is visible long before it fails.

**The claim a stopwatch cannot reach, and the measurement that proves it.** "Never recomputed"
is invisible to timing. Removing the cache guard and re-running showed it directly: **24 extra
ensemble runs per drag moved the median from 6.0 to 6.6 ms** in one run and 6.1 to 6.3 in
another — inside the run-to-run spread, and under any ceiling loose enough to survive a loaded
machine (one run is a fraction of a millisecond: those two mutants bound it at 0.2–0.6 ms against
a 6 ms render). No useful budget on a shared machine can see it, so the test counts the
work instead of timing it.

The instrument is the app's own arithmetic: `gauss()` is the only caller of `Math.log` in the
app (`rmseFt` interpolates, `crossingHours` scans, `flagCounts` compares, the routing distance
takes a square root and a cosine), and `gauss()` is called only from `runEnsemble`. The subject
is the **text-only route**, which is a load-bearing choice rather than a convenience: with
MapLibre on the page its own `Math.log` calls are visible — measured, 368 draws across a 24-step
replay drag, ~15 per step, which next to a 50-draw replay run is noise that would force a loose
bound. With no map loaded the count is exact, so the assertion is the strong one:

- boot, live, one street selected: **2,450 draws** (the run the answer is built from);
- 24 slider steps across the whole slider range: **0 draws**, with the map note moving between
the ends so the drag is real work and not 24 steps against a frozen page;
- a forced mode switch, which must recompute: **2,500 draws**.

The third of those is the control, and it is why the second means something: a probe that had
stopped counting would fail it, and a per-step recompute fails the middle one — with the guard
removed it reports **58,800 draws**, 24 runs, and the timing test passes beside it.

No hook was added to the app and no counter shipped in the bundle. `T7`'s suite runs against the
built app precisely because production has no `window.brazoscast`, and shipping instrumentation
for a test would be a worse trade than counting the arithmetic the app already does. Files were
restored byte-identical after the mutations.

### T9 · A single entry point — `make check` or `scripts/check.sh` · **S** — ✅ **DONE**
**Shipped** as `scripts/check.sh` (`--browser` for the Playwright suite, `--all` for that plus the
golden regression). Nothing is piped into a filter, so no status is masked, and a deliberate README
break was confirmed to exit 1, name the failing step, and stop before the build rather than running
on. The browser suite is opt-in because it costs ~45 s and needs the browsers installed, but
`--all` includes it: a check somebody has to remember to run is a check that stops running.
One command that runs: pipeline tests → `tsc --noEmit` → `vite build` → the text-only byte budget
→ the offline worker harness in Node → (optionally) the Playwright suite. Preserve exit status (`set -o pipefail`); do not pipe it into `tail`.
**Done when** a deliberate break anywhere makes the single command exit non-zero.

---

## 3. Features that serve the app and the vision

Ordered by value per hour. F1 and F2 are the two that a judge will actually touch.

### F1 · Offline address index · **M** *(this is D1's implementation)* — ✅ **DONE** *(both halves)*
Key-free, CORS-free, network-free — and it works during the outage that motivates the product.
Shipped as `data/derived/address_index.json` (34 KB, 819 ranges on 96 of 154 streets) via
`pipeline/derive/address_index.py`. **Not done:** 58 streets have no county house numbers at all,
so those answer by street name only.

**The "what would have to happen" half is DONE** — `pipeline/derive/gauge_history.py` emits the USGS
annual peak record for `08114000` (111 peaks, 1884–2025, highest 61.20 ft in 1913) and the app answers
*"this street floods at 33.4 ft; the gauge last reached that in 2025 (34.76 ft); the record's highest is
61.20 ft in 1913"*. Annual maxima, so "last reached" is exact for the question asked; gage-height
parameter only, because the same USGS file carries discharge peaks in other units. Gates: chronological,
feet, ≥50 peaks, and the 2017 peak must agree with `harvey_validation.json`'s published peak.
Also add: **what would have to happen** — when the river is quiet, replace "stays dry" with
*"the gauge would need 33.4 ft; it last reached that in 2017"*, computed from the cached
`data/raw/usgs/08114000_peaks.json`. Honest, and cheap.

### F2 · Shareable state · **S** *(this is D2)* — ✅ **DONE**
URL encoding + copy link + `navigator.share`.

### F3 · Household card — multiple addresses at once · **M** — ✅ **DONE**
Home, school, a parent's house: the same answer three times, which is how families actually
plan. Renders as one card with N rows, sorted by soonest onset. Reuses
`nearestRoadIndex()` and the existing selection/render path.
**Done when** three addresses produce three rows and the earliest onset is first.

### F4 · Islands by connected component · **M** — ✅ **DONE**
`routing.py` already builds the graph; components are the cheap next layer and answer
*"which side of the cut am I on?"* — a different and more actionable question than
"my street is wet". Extend `data/derived/routing.summary.json`; render as a boundary on the
map. This is the last item `UPGRADE-PLAN.md` lists as outstanding under Step 7 besides the
human layer.

### F5 · `?text=1` low-bandwidth mode · **S** — ✅ **DONE**
Strips the map, the canvas chart and MapLibre (the heaviest dependency) and renders semantic
HTML only. Depends on F2 for the URL param.
**Done when** it loads and answers with the map canvas absent, and the measured transfer size
drops materially against the default route.

**Shipped, measured in a fresh browser profile on the built app: 1,604,003 → 1,196,686 bytes
(−25.4%) as served by a host that leaves JSON alone, and 697,454 → 292,295 (−58.1%) when JSON is
compressed the way Cloudflare Pages compresses it.** What actually goes:

| dropped | bytes | how it was measured |
|---|---|---|
| MapLibre JS + CSS | 227,604 | browser `transferSize`, same-origin |
| the 4 base-map tiles of the initial view | 95,085 | refetching the exact URLs the map requested |
| the webfonts (5 woff2 + their CSS) | 84,628 | `curl`; they were loaded by BOTH routes until the inline guard |

Three things the plan did not anticipate, all found by measuring rather than reasoning:

- **The decision has to be made before the import, not after it.** `boot()` used to build the
  map and *then* read the URL, so a text-only visitor's MapLibre download had already begun.
  The flag is now read first, and MapLibre is a dynamic `import()` inside `buildMap()`, which is
  the only way the library can leave the entry chunk at all. Side effect worth having: the entry
  chunk fell from 839 KB (232 KB gzipped) to 38.6 KB (15.0 KB gzipped) for **every** visitor
  (re-measured on the current tree: **39.6 KB / 15.4 KB gzipped** — the 38.6 is the figure from
  that session, and the offline registration F6 later added to the same file is what moved it;
  `scripts/check-text-mode.mjs` prints the live number on every run, so neither figure can drift
  silently),
  with the map arriving after the answer instead of in front of it.
- **The webfonts were the third-largest item and nobody had asked about them.** They are attached
  from an inline guard in `<head>` because that is the only point that runs before the browser
  would request them; inside the module the check is always too late. Measured: as a static
  `<link>`, text mode downloaded all five woff2 files.
- **The map's information had to survive the map.** "1,187 of 1,614 segments under water" is a
  sentence, so text mode keeps it; the canvas chart is replaced by a summary computed from the
  same `seriesWindow()` the canvas draws, so the two cannot disagree about the same flood.

**Verified** by `scripts/check-text-mode.mjs` (build-level: MapLibre is a separate chunk, is not
statically imported by the entry, its CSS is not in the entry stylesheet, the font guard
survives minification, and the gzipped saving clears a 200 KB floor) and
`pipeline/tests/test_text_mode.py` (source-level: eight absences). Six source mutations and two
build mutations each fail the check that owns them — including one that renamed the static
import binding, which is why the source test matches any static form rather than a name.

### F6 · PWA offline cache · **S** — ✅ **DONE**

The scenario is a storm that takes out the connection — the app should still answer. Shipped as
`app/public/sw.js` (15.9 KB source, 5.6 KB gzipped) plus registration and an offline tag in
`app/src/main.ts` / `app/index.html`.

**Done when, measured in a real browser on a fresh origin:** a first load leaves the 8-file
payload *and* the current gauge reading cached; killing the server (stricter than DevTools
offline: every connection refused rather than intercepted) and reloading restored the same answer
it gave online — *Major flooding* / *Water is on your street now* / *0 hours of lead time* /
*1,337 of 1,614 segments under water* — with the shell answering `x-brazoscast-cache: hit`
(11,586 B), `ensemble.json` and the 1 MB road layer `swr`, and an uncached URL still failing.
Reloaded again for `?text=1`: the full answer, no map, no canvas, no raster tiles.

**Four things the plan did not anticipate.** Each was found by measuring or by a check that
refused to pass, and the first one changes the design.

1. **"Precaching `app/public/data/*`" was the wrong instruction** — it is the F5 budget spent.
   The payload is 1.6 MB and `?text=1` exists for phones where 85 KB of fonts decided whether
there was an answer. The eager set is the **shell only**; everything else is cached the first time
the app asks for it, which costs a visitor nothing because the app asks for all eight files on
every boot. `scripts/check-offline.mjs` asserts this on the requests the worker actually made:
three, all same-origin, none a payload file, none a font, none a tile.
2. **A service worker does not cover the first visit, and the first visit is the one that
   matters.** The page fetches its payload before the worker controls it, so a first-visit-then-outage
   reload had an empty payload and rendered no answer at all — measured, in the partition whose
   worker predated the warm-up. The app now reports what it already loaded — read from the resource
   timeline, which is also the only way to name the map's content-hashed chunks — and the worker
   asks for each of those again, which the browser answers out of what it holds. The gauge body is
   handed over as bytes instead, because a re-fetch is not a cheap alternative for it: that response
   is **468 KB with no validator**, so a conditional request returns all of it again — more than the
   entire text-only route saves.

   **The first version of this used `only-if-cached`, and it copied nothing.** It reads like the
   cheapest possible step and is the opposite: that mode can only be satisfied by a response the
   browser can produce without the network, and `Cache-Control: no-cache` — what the preview server
   and every static host send for HTML and JSON — requires a revalidation, which the mode forbids.
   So every copy rejected. The payload still appeared in the cache, which is why it went unnoticed:
   it was arriving by the ordinary path (the page's own fetches, once the worker controls it), and
   only the map's chunks, fetched *before* that, were missing — the first visit then an outage
   rendered the answer with no map. Two checks had blessed it, and neither could have caught it:
   `check-offline.mjs` modelled `only-if-cached` as a plain cache lookup (now modelled faithfully),
   and the browser test of the day used `context.setOffline(true)`, which left the worker its own
   connection. The browser suite's offline spec is what refused to pass.
3. **The shell swap has to be all-or-nothing, and the HTML stored last.** A shell naming a chunk
   the cache does not hold renders nothing offline. There is direct evidence that this is not
   hypothetical: a partition left through the pre-fix worker served a cached shell whose asset was
   gone and produced `Failed to load module script: ... MIME type of "text/html"` — the SPA
   fallback answering a missing chunk with the page. `fetchInto` now reports success and the swap
   is skipped unless every file the new shell names is in.
4. **A decoded body must not keep the host's `content-encoding`.** A body read in a worker is
   decoded while its headers can still say gzip; storing that pair is a cached page the browser
   refuses to parse. Every cache write goes through `plain()`/`shellResponse()`, and a mutation
   that removes the strip fails the check.

Deliberately **not** cached, each with the reason next to the decision: base-map tiles (unbounded
in number, opaque, and the OpenStreetMap tile service is not for offline collection), the webfonts
(what `?text=1` refuses to download), the previous build's chunks (pruned on shell update), and any
cross-origin host other than the gauge.

**Verified three-sided, and every half mutation-tested.** `scripts/check-offline.mjs` *runs*
`dist/sw.js` in Node inside a fake world — a `fetch` over the real `dist/` tree, a Cache API shim,
and a network switch — through install, warm-up, navigation, the data path, the gauge, a deploy
and a cache purge; `pipeline/tests/test_offline.py` holds the eleven source-level contracts
(production-only registration, a relative worker path, a non-blocking registration, no payload in
the eager set, encoding stripped at every `cache.put`, gauge network-first, data cache-first, tiles
and fonts untouched, the hand-over fed by the resource timeline); and the browser suite reloads
the built app with the origin taken away. Mutations re-run against the parts this session changed:
**5 of 6** worker mutations fail the check that owns them (only-if-cached again, no already-cached
guard, cross-origin warming, no handed-over body, no prune) — the sixth, removing the map's own
hand-over, is now a *redundant* line rather than a behaviour, because the boot-end hand-over
reports the same chunk a moment later; and **8 of 8** mutations of the worker and the app fail the
source test that owns them. Every file was restored byte-identical.

**Re-run later, from `scripts/check-mutants.sh`, and the claim above was no longer reproducible** —
which is exactly why the harness is committed rather than remembered. Both scripts had been written
against an earlier `sw.js` and `main.ts`, so **nine** of their definitions were mutating text that no
longer existed (reported loudly as `??`, never counted as a pass), one expected a test that had since
been renamed, and the source-level script had never actually run to completion: it referenced a `bad`
counter it never declared, so it died on its first stale anchor. Re-anchored against the current
worker and app, all **28** offline mutations are caught (13 worker, 15 source).

**One of the misses was a real gap in the harness, not a stale anchor, and it is fixed.**
`scripts/check-offline.mjs` modelled "the browser's HTTP cache holds this URL" as a hit *whatever the
request asked for*, so a warm-up that forces revalidation-and-download was indistinguishable from one
that copies — the warm stage counted cache reads it could not actually audit. The model now honours
the request's cache mode (`reload` bypasses the entry; `no-cache` may reuse it only when it does not
have to be revalidated first, which is the same distinction the `only-if-cached` branch has always
made), and the mutation that defeated it — replacing the warm-up's plain `fetch(url.href)` with
`cache: "no-cache"` — is now caught. `check-offline.mjs` still passes on the shipped worker.

**Not covered, and stated as such.** The gauge's *hand-over* is asserted in the Node harness, not
in a browser: Playwright cannot route a request the worker makes, so a stubbed gauge is bypassed
once the page is controlled, and a suite that needed the live API to prove an offline behaviour
would be no proof at all. The offline spec therefore puts the reading into the cache itself (the
state a storm leaves) and asserts what the app does with it. `navigator.onLine` is the browser's
belief rather than a probe, which is why the tag says *offline* rather than *unreachable* — and
with the origin gated down and the browser believing it is connected, the tag correctly stays
hidden. If the browser refuses to install a worker at all — insecure context, or a policy that
blocks it — nothing here runs and the app behaves exactly as it did before F6.

### F7 · Three-tier notifications + multilingual templates (EN/ES) · **M** — ✅ **DONE**

Build-time templates, simulated send. Fort Bend County is roughly a third Hispanic; an alert only in
English is a partial alert.

**Delivered as a countdown from the reader's own street, not from the river's category — and that
change is a measurement, not a preference.** The item proposed tying the three tiers to
`TH = { action: 20, minor: 45, moderate: 48, major: 50 }`. The 2017 record says what that produces:
the official flood stages arrived at hours 158, 165 and 169 — **7 h and 4 h apart**, i.e. three texts
in one night — and none of them would say when *the reader's* street floods, which is the only thing
this app is for. So the tiers are **T−72 h, T−24 h, T−6 h before that street's own modelled crossing**
("3 days out" / "1 day out" / "6 hours out"), and the official category still appears inside every
message as context at the hour it is sent.

**What shipped:**

* `pipeline/notify/templates.json` — the text once, in both languages, with the placeholder set, the
  tier ladder, the Spanish category names and the card's own chrome (title, note, quiet-hours line).
  Nothing is written at runtime: what a test renders is what a phone would show.
* `pipeline/derive/notifications.py` — the policy and the simulation. Over the same replayed
  hydrograph the backcast uses, **1,469 of 1,614** streets cross their own threshold inside the
  window (the backcast's own population, by the same rule) and produce **4,407 messages**: three
  each, none duplicated, none arriving after the water, longest **279 characters** — two SMS
  segments. Keying the de-duplication on segment **position** matters: keying on osmid produced
  1,086 phantom duplicates on the first run, because one way can contribute several segments.
* **Quiet hours**, 22:00–07:00 local: **225** sends per held tier were moved to 07:00, and the 6-hour
  alert is never held. The drop-rather-than-send-late rule is kept as a guard and counted separately
  (`held_past_crossing` = 0) — at these offsets it is unreachable, because the longest hold is 9 h
  and the shortest held tier is 24 h out.
* `app/src/lib/notify.ts` + the card in the app — the browser fills the **same** templates with its
  own numbers, so the Spanish and English messages are produced by two independent implementations.
  The parity test compares **digit multisets**, not sentences; the crossing time is 12-hour in both
  languages for exactly that reason (a 24-hour Spanish clock is better Spanish and different
  numerals). The card renders whichever street is selected, and the language travels in the link
  (`?lang=es`).
* **Tests both sides:** `pipeline/tests/test_notifications.py` (18 — templates and their source, parity from both
  the artifact and the renderers, quiet hours, the population identity against
  `harvey_backcast.json`, the SMS budget, the export),
  `app/tests/unit/notifications.test.ts` (13 — the same strings character for character, the schedule
  and the hold), `app/tests/e2e/alert.spec.ts` (3 — the card, the toggle surviving a reload, and the
  text-only route).

**and eight mutants, each caught by the test that owns it** (`scripts/mutants/notifications.mjs`: a
digit drifted in the Spanish template, a dropped placeholder, a Spanish category left in English,
the stage ladder moved, the 12-hour clock lost, the quiet-hours hold removed, and each renderer
broken on its own).

**What a clone can check:** the artifact (`data/derived/notifications.json`), its two test files, the
mutation set, and FINDINGS §16. **What is not claimed:** there is no carrier and no phone number — the send is simulated,
and the part that can be verified here is the text and the schedule. The schedule itself is hindsight
over an observed hydrograph; in live mode the same rule reads the NWPS forecast, whose error is
already measured.

---

## 4. Innovative bets

### I1 · A second observed extent — **the single highest-value item in this plan** · **L** — ✅ **DONE**
`docs/UPGRADE-PLAN.md` says it plainly: the correction "stays unapplied until a second event
can test it, which makes a second observed extent the highest-value outstanding item".
Candidates: the 2016 flood, or a second Harvey product (different agency/processing). The
existing layer is `data/raw/harvey/` fetched by
[pipeline/fetch/fetch_harvey_inundation.mjs](pipeline/fetch/fetch_harvey_inundation.mjs).
**Done when** the validation has two independent events and the +22 ft figure is either
confirmed out-of-sample or replaced.

**Delivered: the 2016 flood, as a Sentinel-1 water edge — and it replaced the figure rather than
confirming it.** The 2015 and 2016 events were ranked off the cached Richmond record first (54.74
and 50.01 ft against Harvey's 55.19), then the USFIMR catalogue was searched for a machine-readable
product covering this reach; it holds exactly one, dated **2016-05-30**, three days *before* that
event crested. Two properties make it worth more than a second maximum:

* **its stage is pinned, not assumed** — the layer's own attributes carry the acquisition time
  (00:26:20 UTC) and the validation reads the cached gauge at that instant: **49.40 ft**, 15.7 ft
  below Harvey's peak, cross-checked by running the layer's own `Q_at_Image` (80,600 cfs) through
  the rating Step 3 fixed, which lands within 1.2 ft; and
* **being lower, it refutes** — 1,241 segments the shipped rule submerges at that stage are shown
  dry, which is what a maximum extent cannot say about any threshold (FINDINGS §15).

What it found: the correction does **not** transfer out of sample (implied lift **−2.05 ft** against
Harvey's +23.72), and the reason is structural — **AUC 0.566 here against 0.809 at Harvey's peak**,
on the same 1,187-segment population, and no constant offset can move a ranking. So the defect is
reclassified from a level error to an **ordering** error. No correction is applied; the disclosure
in the app is unchanged, and the README's 22 ft figure still stands as the single-event measurement
it always was.
**Cost:** the corpus it needs is one fetch and one derivation (4.7 MB, committed); the answer
arrived without a DEM re-run.

### I2 · Second-gauge live cross-validation · **M** — ✅ **DONE** *(and it corrected itself by measurement)*
`gauge_redundancy.py` already estimates stage from upstream gauges if RMOT2 stops. Run the
opposite direction too: when *two* gauges are reporting, show both and flag disagreement.
It converts the redundancy work from a contingency into a live confidence signal.
**Done when** the app displays both estimates and the divergence when they differ.
**Shipped** as `app/src/lib/crosscheck.ts` + the *Two gauges, one answer* card. The disagreement is
judged against the band `gauge_redundancy.py` measured on held-out events (−1.56 to +1.01 ft). **The
first version was wrong and the browser said so:** at 8.60 ft both gauges sit below the range the
transfer was fitted on, so both clamp to a floor and both read ~2 ft above the live stage — a permanent
false alarm on a quiet river. A clamped row is now labelled *out of range* and can raise neither
agreement nor disagreement; only gauges inside the fitted range count. [FINDINGS](FINDINGS.md) §17.

### I3 · Per-street backcast · **M** — ✅ **DONE** *(and it found a rounding tie)*
The 2017 backcast currently reports the corridor and the median street. Per-street backcast
answers *"what would my own alert have said in 2017?"* — the one flourish that makes the
historical claim personal. `backcast.py` already computes 1,469 of 1,614 segments reaching
threshold inside the window; surface those per segment.
**Shipped** as `street_lead_time.per_segment_h` (1,614 entries, positional), a named segment row in the
browser's verification grid, and the selected street's own line in the backcast card. **It found a real
defect:** the artifact was computed on unrounded values while the app is served 2 dp, so segment 962
crossed a 52.3 ft threshold in one and not the other; fixing it exposed `np.round` vs `round` at a tie
(55.135 → 55.14 against 55.13), which moved the crest and therefore every lead time. Now computed on the
series the app receives, with **0 mismatches across all 1,614 segments**. [FINDINGS](FINDINGS.md) §17.

### I4 · Bring-your-own-forecast · **M** — ✅ **DONE**
Accept a pasted/uploaded forecast series and run the app's own rule over it. Makes the engine
provably model-agnostic and answers the obvious judge question — *"why should I trust your
forecast instead of NWS?"* with *"you do not have to; here is yours."
**Shipped** as `app/src/lib/userforecast.ts` + a `<details>` on the chart card. Observations are kept and
only the forecast half is replaced; every unreadable line is reported by number and reason rather than
dropped, because a dropped point moves a crossing time silently. Nothing pasted is stored, put in the
URL, or counted in any published number.

### I5 · Responder view · **M** — ✅ **DONE**
The inverse question: *given a stage, which segments are cut off* — sorted by
"trapped before their own street floods". That set is already computed (230 segments in
`isolation.summary.json`) and is the operationally interesting one.
**Shipped** as `app/src/lib/responders.ts` + the *Dry road, no way out* card, on the stricter rule (route
to help cut **and** own street still dry), worst first. **The set is not monotone in stage** — 6 segments
at 20 ft, 5 at 25, **294 at 30**, 23 at 34, 116 at 45, 12 at 55 — because it is the gap between two
curves, and a card that assumed monotonicity would have described the wrong population. [FINDINGS](FINDINGS.md) §17.

### I6 · Robustness / uncertainty dashboard · **M** — ✅ **DONE**
One view showing how each published number behaves under perturbation: does the 309 h
lead-time claim survive ±1 σ on the thresholds, the gauge error, and the forecast horizon?
This is the honest counterpart to I1 when a second event is unavailable.
**Shipped** as `app/src/lib/robustness.ts` + the *Does the answer survive?* card: threshold ±1σ, the
corridor lift, forecast ±1σ at the horizon the answer lands on (skipped, with the reason, when there is
no forecast or when the answer is already "not reached"), and a 72 h horizon. It reports whether the
**qualitative** claim survives, because 31 h → 22 h does not change a decision and 31 h → "never in the
window" does. The four cards cost **+2.3 ms** per drag step, measured by A/B against the previous commit
(`git worktree`), not against a remembered number; an optimisation that cached the cut index was
measured and reverted. [FINDINGS](FINDINGS.md) §17.

### I7 · Second model head-to-head · **L, and cut-able**
`UPGRADE-PLAN.md` already cuts the NWS/NWM retrospective because archived AHPS is not openly
published and the existing benchmark is honest. **Recommend leaving it cut.** Listed only so
the decision is recorded as a decision.

---

## 5. Sequence

| # | item | effort | depends on | why here |
|---|---|---|---|---|
| 1 | **D1** + **F1** address resolution ✅ | M | — | the headline interaction is currently broken |
| 2 | **T1**, **T2**, **T4**, **T5**, **T9** ✅ | S | pytest install | cheap, and they protect every published number |
| 3 | **D2** + **F2** shareable state ✅ | S | — | turns a screencast into something a judge can hold |
| 4 | **T3** ✅, **T6** ✅ | M | kernel extraction | makes "implemented twice" a checked claim |
| 5 | **D4** ✅, **D5** ✅ hygiene + integrity | S | — | small, unblocks nothing but cleans the record — and the rule it forced found two inputs the item itself had not named |
| 6 | **F3** household card, **F4** islands | M | D1 | the human layer the vision is actually about |
| 7 | **F5** `?text=1` ✅, **F6** PWA ✅ | S | F2 | offline and bandwidth-poor demos |
| 8 | **T7** ✅, **T8** ✅ | M | F1, Playwright | repeatable browser + perf verification — 28 tests in two projects (boot/staleness/answer, the links, the canvas, the outage, the router's own parity line), and the render budget with a draw-count probe for the ensemble cache |
| 9 | **I1** second observed extent ✅ | L | — | the only path that closes D3 — and it did, by refuting the correction (AUC 0.566 vs 0.809, implied lift −2.05 ft) instead of confirming it |
| 10 | **F7** i18n + notifications | M | D3 | ✅ **done** — three tiers counted from the street's own crossing, EN/ES from build-time templates, parity-gated by digit multiset |
| 11 | **I2**, **I3**, **I4**, **I5**, **I6** + F1's second half ✅ | M each | — | all six delivered — and measuring them found two defects (a 2-dp rounding tie at one segment in 1,614; a permanent false alarm in the cross-check on a quiet river) plus a set that is not monotone in stage. [FINDINGS](FINDINGS.md) §17 |
| — | **I7** second model head-to-head | L | — | **deliberately cut** — recorded so the decision is a decision, not an omission |

**If you only do three things:** D1+F1 (the address box works), T1+T2 (the numbers stay
true), I1 (the threshold defect gets a second event). Those three are the difference between
a demo and a measurement.

---

## 6. What this plan does *not* fix

- **The 22 ft threshold bias stays in the product.** I1 landed and did not remove it: the second
  event says the *fix* for it is wrong, not that the bias is absent. It is disclosed, not fixed,
  and that disclosure is a feature.
- **The HAND inundation bands stay provisional** — the raster scale is unresolved.
- **No source can confirm the address dataset** until D1's step 1 actually inspects the FBCAD
  hub's layer list. Reachable at 200 ≠ has an address-point layer.
- **Overpass is currently saturated** (`502`, queue full) and the kumi mirror returned 500.
  Any plan that depends on a live Overpass call at runtime is unsound; fetch offline, cache,
  and commit — which is what the rest of this plan already assumes.
