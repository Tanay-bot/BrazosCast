"""T1 — golden-artifact regression.

Every number in the README descends from these artifacts, and until now their
determinism was checked BY HAND (copy the artifacts, re-run, diff). This makes
that automatic: the whole chain is re-run in a throwaway copy of the repo and
every emitted artifact is compared to the committed one.

Measured before it was written: the chain reproduces all 11 artifacts IDENTICALLY,
so any difference is a real change in behaviour rather than noise. The only fields
excluded are timestamps. I1's second-event stage made it 12, and it reproduces too.

Cost is ~2 minutes, almost all of it harvey_validation.py (99 s), which is why this
is marked `slow` and excluded from the default run. `scripts/check.sh --all` runs it.
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys

import pytest

from conftest import ROOT

# Order matters and is not alphabetical: isolation ENRICHES road_thresholds in
# place, and road_thresholds regeneration would wipe those fields. Running them
# out of order produces different artifacts, which is itself worth pinning.
CHAIN = [
    "pipeline/derive/road_thresholds.py",
    "pipeline/derive/isolation.py",
    "pipeline/derive/routing.py",
    "pipeline/derive/gauge_redundancy.py",
    "pipeline/derive/harvey_validation.py",
    # Reads harvey_validation.json — the probit lift it applies out of sample — so it
    # must run AFTER it. Re-running it is also what proves a clone can re-derive the
    # second-event numbers from the committed Sentinel-1 extent.
    "pipeline/derive/second_event_validation.py",
    "pipeline/derive/ensemble.py",
    "pipeline/derive/backcast.py",
    "pipeline/derive/address_index.py",
    "pipeline/derive/gauge_history.py",
]

ARTIFACTS = [
    "road_thresholds.geojson", "road_thresholds.json", "road_thresholds.summary.json",
    "isolation.summary.json", "routing_graph.json", "routing.summary.json",
    "gauge_redundancy.json", "harvey_validation.json", "second_event_validation.json",
    "ensemble.json", "harvey_backcast.json", "address_index.json", "gauge_history.json",
]

VOLATILE = re.compile(r"(generated_at|generatedAt|fetchedAt|fetched_at|built_at|timestamp)", re.I)

IGNORE = shutil.ignore_patterns("node_modules", ".git", "dist", ".logs", ".freebuff",
                                "__pycache__", "*.pyc")


def diff_paths(a, b, path=""):
    """Every leaf that differs, named by its path in the document."""
    if type(a) is not type(b):
        return [(path or "<root>", f"type {type(a).__name__} -> {type(b).__name__}")]
    if isinstance(a, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append((f"{path}.{k}", "only in the re-run"))
            elif k not in b:
                out.append((f"{path}.{k}", "only in the committed artifact"))
            else:
                out += diff_paths(a[k], b[k], f"{path}.{k}")
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [(path, f"length {len(a)} -> {len(b)}")]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff_paths(x, y, f"{path}[{i}]")
        return out
    return [] if a == b else [(path, f"{a!r} -> {b!r}")]


@pytest.mark.slow
def test_the_chain_reproduces_the_committed_artifacts(tmp_path_factory):
    work = tmp_path_factory.mktemp("golden") / "repo"

    source = work.parent / "src"
    shutil.copytree(ROOT, source, ignore=IGNORE, symlinks=True)
    source.rename(work)

    failures = []
    for stage in CHAIN:
        proc = subprocess.run(
            [sys.executable, stage],
            cwd=work, capture_output=True, text=True, timeout=900,
        )
        if proc.returncode != 0:
            # Each script prints its own gate failure; surface the tail of it,
            # because "exit code 1" does not say which gate refused.
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
            failures.append(f"{stage} exited {proc.returncode}:\n    " + "\n    ".join(tail))

    assert not failures, "a stage failed in a clean copy of the repo:\n" + "\n".join(failures)

    drifted = []
    for name in ARTIFACTS:
        produced = work / "data" / "derived" / name
        committed = ROOT / "data" / "derived" / name
        assert produced.exists(), (
            f"{name} was NOT produced by the chain — a stage silently stopped writing it")
        try:
            a = json.loads(produced.read_text())
            b = json.loads(committed.read_text())
        except json.JSONDecodeError as exc:
            drifted.append(f"{name}: not valid JSON after the re-run ({exc})")
            continue

        d = [(p, w) for p, w in diff_paths(a, b) if not VOLATILE.search(p)]
        if d:
            shown = "\n      ".join(f"{p}: {w[:120]}" for p, w in d[:8])
            more = f"\n      ...and {len(d) - 8} more" if len(d) > 8 else ""
            drifted.append(f"{name} ({len(d)} differences)\n      {shown}{more}")

    assert not drifted, (
        "the chain no longer reproduces the shipped artifacts, so every number that "
        "descends from them is now unverified:\n\n    " + "\n\n    ".join(drifted))
