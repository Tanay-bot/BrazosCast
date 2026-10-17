"""T6 — the product's promises, as properties over generated inputs.

Every gate in this pipeline runs on ONE dataset: the shipped corridor. That is the right
population to publish a number about and the wrong one to prove a monotonicity on, because a
promise asserted on one input is a coincidence with a sample size of one. Each test below names a
promise in the product's own words, generates inputs with a seeded numpy generator (so a failure
is reproducible), and holds the promise for all of them. Each one also prints how many draws it
made and asserts a floor on that number, because "property-tested" without a count is a claim
about nothing — and a test that quietly stopped generating inputs would otherwise pass.

The algorithms are the pipeline's own, imported rather than re-implemented (see conftest), which
is the point: this is where the gates that live INSIDE `ensemble.py`, `isolation.py` and
`backcast.py` — gates that only run when somebody runs the script — become gates that run on
demand. Where a promise has no function to call, the test says so instead of restating the rule.

  * "as the river rises you never GAIN a way out" — `isolation.widest_path`, the union-find pass
    every segment's isolation reading comes from, against `isolation.bfs_reachable`, a
    deliberately different algorithm.
  * "your last way out is cut at or before your own street floods" — the shipped invariant of
    `isolation_ft` against `flood_stage_ft`.
  * "forecast error grows with the horizon" — `ensemble.rmse_ft` through its measured knots.
  * "a higher threshold never crosses more often" — `ensemble.ensemble`, member by member.
  * "the published grids never invert" — the two verification grids the app is asked to
    reproduce, checked against each other rather than against a second implementation of them.

Deliberately cheap: ~1,500 draws in about two seconds, so this runs in the default check and not
behind `--all`.
"""
import json

import numpy as np
import pytest

from conftest import DERIVED, PUBLIC

import ensemble as E
import isolation as ISO

SEED = 20261016


def random_network(rng, nodes=60, edges=110, refuges=3):
    """A road network: random edges, each carrying a flood threshold, and refuge nodes.

    Thresholds are drawn on a 0.1 ft grid so ties are COMMON — the widest-path pass joins
    components in descending threshold order, and an implementation that stamps a node on the
    wrong edge of a tie would still need every other value to be right to pass.
    """
    pairs = []
    for _ in range(edges):
        u, v = (int(rng.integers(0, nodes)), int(rng.integers(0, nodes)))
        if u != v:
            pairs.append((u, v, float(np.round(rng.uniform(5.0, 55.0), 1))))
    seeds = {int(i) for i in rng.choice(nodes, size=refuges, replace=False)}
    return nodes, pairs, seeds


def test_a_rising_gauge_never_opens_a_way_out():
    """The promise the isolation stage is built on, over generated graphs and stages.

    Three things are asserted, and the third is the interesting one:

    1. a refuge node is the destination and is never stamped as isolated;
    2. a node can reach refuge at some stage IFF its component holds a refuge — so the one-pass
       union-find and the connected-component pass agree about the static graph;
    3. at any stage, "reachable" means exactly `access[i] is not None and stage < access[i]`.

    (3) is an equivalence between two independent algorithms — the descending union-find pass and
    a BFS over the passable edges — and it is what makes the drawn value mean what the artifact
    says it means. Monotonicity then follows, and is asserted directly as well.
    """
    rng = np.random.default_rng(SEED)
    draws = 0
    checked = 0
    for _ in range(40):
        n, edges, seeds = random_network(rng)
        access = ISO.widest_path(n, edges, seeds)
        comp = ISO.components_of(n, edges)
        seeded = {comp[s] for s in seeds}

        assert all(access[s] is None for s in seeds), "a refuge node was stamped as isolated"
        for i in range(n):
            if i in seeds:
                continue
            if comp[i] in seeded:
                assert access[i] is not None, (
                    f"node {i} is in a component holding a refuge but has no way out at any "
                    "stage")
            else:
                assert access[i] is None, (
                    f"node {i} has no refuge in its component but was given a way out "
                    f"at {access[i]} ft")
            checked += 1

        # Stages on the SAME 0.1 ft grid as the thresholds, so ties are common. They have to be:
        # the boundary convention (`t > stage` — an edge is passable strictly below its threshold)
        # is invisible to continuous draws, where a stage lands exactly on a threshold with
        # probability zero. A mutation of `>` to `>=` in the BFS pass goes unnoticed until the
        # stages can tie, which is what this line is for.
        stages = sorted(float(np.round(s, 1)) for s in rng.uniform(0.0, 60.0, 25))
        counts = []
        for stage in stages:
            seen = ISO.bfs_reachable(n, edges, seeds, stage)
            counts.append(int(sum(seen)))
            for i in range(n):
                if i in seeds:
                    continue
                expected = access[i] is not None and stage < access[i]
                assert bool(seen[i]) == expected, (
                    f"at {stage:.1f} ft node {i} is {'reachable' if seen[i] else 'cut off'} "
                    f"while the widest-path pass says {access[i]}")
                draws += 1
        # The same fact said as the promise: as the river rises, the set of ways out shrinks.
        assert counts == sorted(counts, reverse=True), (
            f"raising the stage ADDED a way out: reachable counts {counts} at {stages}")

    assert checked >= 500 and draws >= 20_000, f"only {checked} nodes, {draws} stage reads"
    print(f"  {checked} generated nodes, {draws} (node, stage) reachability reads")


def test_the_last_way_out_is_never_cut_after_the_street_floods():
    """The shipped invariant, on the population the numbers are published about.

    `isolation_ft` is the stage at which the last dry route off a segment is cut, and the
    pipeline takes the minimum of it and the segment's own threshold — because once your street
    is under water you cannot leave either. A gap that came out negative would mean a road
    reported as reachable after the water is over it.
    """
    doc = json.loads((PUBLIC / "road_thresholds.geojson").read_text())
    feats = doc["features"]
    assert len(feats) == 1614, f"the road layer has {len(feats)} features"

    defined = 0
    trapped = 0
    for f in feats:
        p = f["properties"]
        at, iso, gap = p["flood_stage_ft"], p.get("isolation_ft"), p.get("isolation_gap_ft")
        assert (iso is None) == (p["isolation_status"] == "no_dry_refuge"), (
            f"osmid {p['osmid']}: isolation_ft {iso} and status {p['isolation_status']!r} "
            "disagree about whether a refuge exists")
        if iso is None:
            assert gap is None, f"osmid {p['osmid']}: a gap for a segment with no way out"
            continue
        assert iso <= at + 1e-9, (
            f"osmid {p['osmid']}: the last way out is cut at {iso} ft but the street floods "
            f"at {at} ft — the app would report a dry route over water")
        assert abs(gap - (at - iso)) <= 1e-6, (
            f"osmid {p['osmid']}: gap {gap} is not flood_stage_ft - isolation_ft ({at - iso})")
        defined += 1
        trapped += 1 if gap > 0.05 else 0

    assert defined > 0 and trapped > 0, "no segment has both an isolation stage and a gap"
    print(f"  {defined} segments with a defined way out, {trapped} trapped before they flood")


def test_forecast_error_never_falls_with_the_horizon():
    """A random walk whose cumulative sd is the measured RMSE can only be built if that curve
    rises. The knots are measurements; between them the curve is an interpolation, and beyond
    the last one it is held — all of which have to be non-decreasing for the walk to mean
    anything. It also has to pass through the measurements it claims to interpolate.

    Asserting the second of those found something, and it is pinned below rather than smoothed
    over: the held value is the last knot ROUNDED to three decimal places (`FORECAST_FLOOR_FT`
    is 6.057 against a knot of 6.057354), so the curve misses its own final knot by 0.00035 ft
    and has a downward step of exactly that size at 7 days. Measured, not assumed. It is not
    corrected here because the floor feeds every draw past the seventh day and therefore every
    count in the verification grid — a change that would regenerate the artifact, and the app's
    copy of it, for a discrepancy three orders of magnitude below the ±11 ft spread the ensemble
    propagates. What this test does instead is hold the seam to 1e-3 ft so it cannot grow.
    """
    last_d, last_v = E.RMSE_KNOTS[-1]

    # Non-decreasing at 1,201 horizons from 0 to 12 days, the last knot included.
    grid = np.linspace(0.0, 12.0, 1201)
    values = [E.rmse_ft(float(d)) for d in grid]
    assert values == sorted(values), (
        "the forecast error curve falls as the horizon grows: "
        f"{[(float(d), v) for d, v in zip(grid, values) if v < max(values[:values.index(v) + 1])][:3]}")
    assert values[0] == 0.0, "the error at zero days is not zero"
    assert E.rmse_ft(0.5) <= E.rmse_ft(1.0), "the first segment of the curve is not monotone"

    # Every knot but the last is hit exactly.
    for d, v in E.RMSE_KNOTS[:-1]:
        assert abs(E.rmse_ft(float(d)) - v) < 1e-9, f"the curve misses its own knot at {d} d"

    # The last knot's seam: the limit from the left against the value AT the knot.
    seam = E.rmse_ft(float(last_d) - 1e-9) - E.rmse_ft(float(last_d))
    assert 0 < seam < 1e-3, f"the step at the last knot is {seam:.6f} ft, not the ~3e-4 documented"
    assert E.rmse_ft(float(last_d)) == E.FORECAST_FLOOR_FT, (
        "the value at the last knot is no longer the held floor")
    assert abs(last_v - E.FORECAST_FLOOR_FT) < 1e-3, "the held value is not the last knot"
    assert E.rmse_ft(last_d + 30) == E.FORECAST_FLOOR_FT, "the curve is not held past its range"

    # "Error grows with the horizon" is stricter than "error never falls": a FLAT segment is
    # non-decreasing too, and a flat first day would mean a six-hour-ahead forecast carrying no
    # error at all. So every interval between the measured knots must RISE, and past the last knot
    # the curve must be held exactly flat — which is what the artifact says it does. (A mutation
    # that froze the first day passed the non-decreasing assertion above; this is the assertion
    # that noticed, which is why it is here.)
    knots = [0.0] + [float(d) for d, _ in E.RMSE_KNOTS]
    for a, b in zip(knots, knots[1:]):
        quarter, middle = a + (b - a) / 4, (a + b) / 2
        assert E.rmse_ft(middle) > E.rmse_ft(quarter) > E.rmse_ft(a), (
            f"the forecast error does not rise across {a}-{b} days")
    assert E.rmse_ft(float(last_d) + 1) == E.rmse_ft(float(last_d) + 5) == E.FORECAST_FLOOR_FT, (
        "the error beyond the measured range is not held flat")

    rng = np.random.default_rng(SEED + 1)
    days = np.sort(rng.uniform(0.0, 12.0, 300))
    assert [E.rmse_ft(float(d)) for d in days] == sorted(E.rmse_ft(float(d)) for d in days)
    print(f"  {len(grid)} horizons + 300 random ones, {len(E.RMSE_KNOTS)} knots, seam {seam:.2e} ft")


def test_a_higher_threshold_never_crosses_more_often(derived_json):
    """The promise the ensemble is quoted for, on the half of the grid where it is a promise.

    With the series wholly observed there is no forecast perturbation, so member m draws the SAME
    threshold error in both runs and raising the threshold raises that member's tau — crossing
    counts can only fall. Monotone by construction, which is exactly why the pipeline's own gate
    asserts this for the `observed_only` rows of the grid and not for the forecast rows.

    Measured here on 300 generated hydrographs at the shipped error model: **0 inversions**
    observed-only, **2 of 300** with a forecast boundary in place. The forecast path is not
    monotone because its members are not the same 50 scenarios: a member consumes RNG draws until
    it crosses, so the stream position after member m depends on where member m crossed, and only
    6 of 50 members get the same threshold draw at two different thresholds (measured). So the
    app's block is a per-street uncertainty budget, not a shared scenario set, and a higher street
    threshold can rarely be reported as reached by more runs. That is recorded rather than
    asserted — the accurate claim is the one below — and nothing in the README or FINDINGS says
    the runs are shared (checked). What would break the assertion below is the threshold term
    being applied before rounding, after the walk, or with the sign flipped: all of which still
    produce plausible-looking counts.
    """
    params = derived_json("ensemble.json")["parameters"]
    lift, sigma, members, seed = (params["lift_ft"], params["per_street_sigma_ft"],
                                  params["members"], params["seed"])
    rng = np.random.default_rng(SEED + 2)
    HOUR = 3_600_000
    draws = 0
    for _trial in range(300):
        # A 48-hour hydrograph with a real rise and fall, so thresholds land on both sides.
        hours = np.arange(48)
        base = 8.0 + 28.0 * np.exp(-((hours - 30) ** 2) / 200.0)
        series = [[int(h * HOUR), round(float(v), 2)]
                  for h, v in zip(hours, base + rng.normal(0, 0.4, hours.size))]
        lo, hi = sorted(float(x) for x in rng.uniform(8.0, 42.0, 2))
        a = E.ensemble(lo, series, 0, None, lift, sigma, members, seed)
        b = E.ensemble(hi, series, 0, None, lift, sigma, members, seed)
        assert a["crossing"] >= b["crossing"], (
            f"{lo:.2f} ft crosses {a['crossing']} times and {hi:.2f} ft crosses "
            f"{b['crossing']} — a higher threshold crossed more often")
        for e in (a, b):
            assert e["never_h"] == e["of"] - e["crossing"], "never_h and crossing disagree"
            assert 0 <= e["crossing"] <= e["of"]
            if e["crossing"]:
                assert e["p10_h"] <= e["median_h"] <= e["p90_h"], (
                    f"quantiles out of order: {e['p10_h']} {e['median_h']} {e['p90_h']}")
            else:
                assert e["median_h"] is None and e["p10_h"] is None
        # Determinism: the same threshold on the same series is the same 50 runs, so a count on
        # screen is a measurement rather than a sample.
        assert E.ensemble(lo, series, 0, None, lift, sigma, members, seed) == a
        draws += 2

    # The crossing boundary, with the error model switched off so tau IS the threshold: at an
    # observed stage every member crosses, and above every observed stage none does. The boundary
    # sits at the 4 dp the threshold term is rounded to ("v >= tau" against round(threshold, 4)),
    # so a threshold 1e-6 ft ABOVE the wettest hour still rounds back onto it and crosses in all
    # 50 members — a property of the deliberate rounding, pinned here because it is the kind of
    # thing that reads as a bug the first time it is met.
    flat = [[int(h * HOUR), 12.0 + (h % 3) * 0.5] for h in range(24)]
    lowest, highest = 12.0, 13.0
    assert min(v for _, v in flat) == lowest and max(v for _, v in flat) == highest
    assert E.ensemble(lowest, flat, 0, None, 0.0, 0.0, members, seed)["crossing"] == members, (
        "a threshold at the lowest observed stage did not cross in every member")
    assert E.ensemble(highest, flat, 0, None, 0.0, 0.0, members, seed)["crossing"] == members
    assert E.ensemble(highest + 1e-6, flat, 0, None, 0.0, 0.0, members, seed)["crossing"] == members
    assert E.ensemble(highest + 0.01, flat, 0, None, 0.0, 0.0, members, seed)["crossing"] == 0, (
        "a threshold above every observed stage still crossed")

    assert draws >= 500, f"only {draws} ensemble runs"
    print(f"  {draws} observed-only ensemble runs over generated hydrographs, + the boundary")


def test_the_published_grids_never_invert(derived_json):
    """The two verification grids the app must reproduce, held to their own promises.

    No generated input here, and that is the honest position rather than a shortcut: the flag
    rule is one comparison on a threshold array, so a generated-input version of it in Python
    would be a test of numpy's `<`. What this checks instead is the published grid — the rows a
    reader and the browser both rely on — for the orderings the artifacts assert in prose.
    """
    ens = derived_json("ensemble.json")["verification_grid"]
    assert len(ens) == 16, f"the ensemble grid has {len(ens)} rows"
    by_mode = {}
    for row in ens:
        by_mode.setdefault(row["mode"], []).append(row)
    for mode, rows in by_mode.items():
        by_threshold = sorted(rows, key=lambda r: r["threshold_ft"])
        crossings = [r["crossing"] for r in by_threshold]
        assert crossings == sorted(crossings, reverse=True), (
            f"the {mode} rows cross more often as the threshold rises: "
            f"{[(r['threshold_ft'], r['crossing']) for r in by_threshold]}")
        assert any(0 < c < rows[0]["of"] for c in crossings), (
            f"no {mode} row is uncertain, so the grid carries no spread")

    bc = derived_json("harvey_backcast.json")
    grid = bc["verification_grid"]["flag_counts"]
    stages = [r["stage_ft"] for r in grid]
    shipped = [r["shipped"] for r in grid]
    corrected = [r["corrected"] for r in grid]
    assert stages == sorted(stages), "the flag grid's stages are not ascending"
    assert shipped == sorted(shipped), "a higher stage flagged fewer segments"
    assert corrected == sorted(corrected), "the corrected rule is not monotone in stage"
    assert all(c <= s for c, s in zip(corrected, shipped)), (
        "the measured correction flagged MORE segments than the shipped rule — raising a "
        "threshold cannot warn more people, and this is the trade-off the backcast measures")

    onsets = bc["verification_grid"]["tier_onsets_h"]
    crest_h = bc["event"]["crest"]["hours_from_start"]
    window_h = bc["event"]["window"]["hours"]
    tiers = [round(float(k.rsplit("_", 1)[1]), 1) for k in onsets]
    ordered = [onsets[k] for k in sorted(onsets, key=lambda k: float(k.rsplit("_", 1)[1]))]
    assert ordered == sorted(ordered), "a higher tier was crossed earlier than a lower one"
    assert all(0 <= o <= crest_h for o in ordered), (
        f"a tier onset lies outside the event (crest {crest_h} h, window {window_h} h)")
    assert tiers == sorted(tiers)
    print(f"  {len(ens)} ensemble rows, {len(grid)} flag rows, {len(onsets)} tier onsets")
