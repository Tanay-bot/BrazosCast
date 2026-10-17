"""Shared fixtures and helpers for the BrazosCast pipeline tests.

The tests assert against the COMMITTED artifacts, because those are what the app
and the docs are built from. Every one of them names the artifact and the field
it read, so a failure says which number moved rather than that something broke.
"""
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DERIVED = ROOT / "data" / "derived"
RAW = ROOT / "data" / "raw"
PUBLIC = ROOT / "app" / "public" / "data"
TESTS = ROOT / "pipeline" / "tests"

# The derive scripts are importable so a test can reuse their own canonicaliser
# rather than restating it: a test that re-implements the logic tests itself.
for _p in (ROOT, TESTS, ROOT / "pipeline" / "derive", ROOT / "pipeline" / "export",
           ROOT / "pipeline" / "analyze"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def read_json(base: pathlib.Path, name: str):
    path = base / name
    assert path.exists(), f"missing artifact {path}"
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:  # a truncated artifact is a real failure
        raise AssertionError(f"{path} is not valid JSON: {exc}") from exc


def get(obj, dotted: str):
    """Walk a dotted path, allowing integer indices into lists.

    Raises AssertionError naming the exact step that failed, because "KeyError:
    'false_positive_rate'" on a 15 KB artifact is not a useful failure message.
    """
    cur = obj
    walked = []
    for part in dotted.split("."):
        if isinstance(cur, list):
            idx = int(part)
            assert 0 <= idx < len(cur), (
                f"{'.'.join(walked) or '<root>'} has {len(cur)} entries, index {idx} requested")
            cur = cur[idx]
        elif isinstance(cur, dict):
            assert part in cur, (
                f"{'.'.join(walked) or '<root>'} has no key {part!r}; keys present: "
                f"{sorted(cur)[:12]}")
            cur = cur[part]
        else:
            raise AssertionError(
                f"cannot descend into {type(cur).__name__} at {part!r} of {dotted!r}")
        walked.append(part)
    return cur


@pytest.fixture(scope="session")
def root() -> pathlib.Path:
    return ROOT


@pytest.fixture(scope="session")
def derived_json():
    return lambda name: read_json(DERIVED, name)


@pytest.fixture(scope="session")
def public_json():
    return lambda name: read_json(PUBLIC, name)


@pytest.fixture(scope="session")
def raw_json():
    return lambda name: read_json(RAW, name)
