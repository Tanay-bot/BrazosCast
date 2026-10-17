"""T3 — cross-language grid parity, the half that needs Python.

The ensemble, the backcast rule and the crest transfer are each implemented TWICE: once in
`pipeline/derive/*.py`, which writes the artifacts, and once in `app/src/lib/*.ts`, which runs in
the browser. The pipeline emits a verification grid for each of them, precisely so the second
implementation can be checked instead of trusted — and until now the only thing that read those
grids was a DEV-only browser hook, which no CI can see. The recomputation itself is
`app/tests/unit/grid-parity.test.ts`, because the second implementation is TypeScript; this file
drives it and holds the two identities that a TypeScript test cannot.

The split is deliberate. Rebuilding the replay series in TypeScript would mean porting a pandas
resample; recomputing numpy's percentile in Python would restate the algorithm the TS side already
implements. So each side checks the part it can be authoritative about:

  * here — that the series the app replays IS the series the pipeline's grid was computed on, and
    that the app's population of road thresholds is the pipeline's, segment for segment. Neither
    was compared anywhere before, and both would make a perfect-looking parity check vacuous.
  * there — that every row of both grids comes out of the app's kernels exactly.

A grid checked against the wrong hydrograph agrees perfectly, which is why the identities come
first.
"""
import datetime as dt
import json
import pathlib
import re
import shutil
import subprocess

import pytest

from conftest import DERIVED, PUBLIC, ROOT, read_json

APP = ROOT / "app"
SEGMENTS = 1614


def test_the_app_replays_the_series_the_grid_was_computed_on():
    """ensemble.py rebuilds the Harvey series from the USGS interval cache; the app fetches
    `replay-harvey.json`. Two ways to build one series, and nothing compared them."""
    import ensemble  # pipeline/derive, on sys.path via conftest

    pipeline = ensemble.replay_series()
    shipped = read_json(PUBLIC, "replay-harvey.json")["points"]

    assert len(pipeline) == len(shipped) == 241, (
        f"the pipeline builds {len(pipeline)} hourly points and the app is served "
        f"{len(shipped)}")
    mismatched = [
        (t, v, p["t"], p["v"]) for (t, v), p in zip(pipeline, shipped)
        if int(dt.datetime.fromisoformat(p["t"]).timestamp() * 1000) != t
        or round(float(p["v"]), 2) != round(v, 2)
    ]
    assert not mismatched, (
        f"{len(mismatched)} of {len(shipped)} replay points differ from the series the "
        f"ensemble grid was computed on (first: pipeline {mismatched[0][:2]}, app "
        f"{mismatched[0][2:]}) — the grid would then be checked against another hydrograph")


def test_the_population_the_backcast_counts_is_the_one_the_app_counts():
    """backcast.py counts thresholds from the geojson; the app counts the properties of the
    geojson it fetches. The sidecar road_thresholds.json carries the same numbers under a
    different key (`at`), and that is the key the docs quote."""
    derived = json.loads((DERIVED / "road_thresholds.geojson").read_text())
    served = json.loads((PUBLIC / "road_thresholds.geojson").read_text())
    sidecar = read_json(DERIVED, "road_thresholds.json")

    app_thresholds = [f["properties"]["flood_stage_ft"] for f in served["features"]]
    assert app_thresholds == [f["properties"]["flood_stage_ft"] for f in derived["features"]], (
        "the app is served a road layer the pipeline did not derive")
    assert app_thresholds == [r["at"] for r in sidecar], (
        "road_thresholds.geojson and road_thresholds.json disagree on the thresholds — the "
        "app counts the first and every published figure comes from the second")
    assert len(app_thresholds) == SEGMENTS, (
        f"the app counts {len(app_thresholds)} thresholds, the grids are computed on {SEGMENTS}")
    backcast = read_json(DERIVED, "harvey_backcast.json")
    assert backcast["street_lead_time"]["segments"] == SEGMENTS, (
        "harvey_backcast.json counts a different number of segments than the road layer holds")


def _vitest_command():
    """The local binary first, so the check does not depend on `npx` resolving anything."""
    local = APP / "node_modules" / ".bin" / "vitest"
    if local.exists():
        return [str(local), "run"]
    if shutil.which("npx"):
        return ["npx", "vitest", "run"]
    return None


def test_the_typescript_kernels_reproduce_every_grid_row():
    """Drive `vitest run`: 16 ensemble rows, 17 backcast rows, the transfer's knots.

    Run from app/ because the kernels live there and the test resolves the artifacts the app is
    actually served. Exit status is the assertion; the output is only used to prove the runner
    ran something, since a runner that collects nothing also exits 0.
    """
    cmd = _vitest_command()
    if cmd is None:
        pytest.skip("vitest is not installed — run `cd app && npm install`")

    proc = subprocess.run(cmd, cwd=APP, capture_output=True, text=True)
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, (
        "the app's kernels no longer reproduce the pipeline's verification grids:\n"
        + "\n".join(output.splitlines()[-40:]))
    match = re.search(r"Tests\s+(\d+) passed", output)
    assert match, (
        "vitest exited 0 without reporting any passing tests, so the grids were not actually "
        "recomputed:\n" + "\n".join(output.splitlines()[-20:]))
    # 16 ensemble rows + 13 flag-count rows + 4 tier onsets + the grid/population guards.
    assert int(match.group(1)) >= 33, (
        f"only {match.group(1)} assertions ran; the grid is 16 + 17 rows, so a run this small "
        "means the grid was not recomputed")
