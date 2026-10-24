"""The ingestion layer's contract, held without the network.

These are the claims that can be checked on a machine with no connection, and they are the
ones that would otherwise rot silently:

  * the sources are the ones the docs say, on the hosts that survive 2027;
  * the USACE allow-list is Brazos-only, and Addicks/Barker — the nearby dams a future
    contributor would add because they are 40 km away — are not in it;
  * a receipt that cannot say how many rows it holds is rejected;
  * `refresh.mjs` can plan every source without fetching anything, and refuses a source it
    does not know with a non-zero exit rather than a warning on stdout.

What is NOT covered here: that the live hosts still answer. That is `refresh.mjs` itself,
run by a human or a scheduled job; a test suite that depends on NOAA being up is a suite
that fails for reasons that have nothing to do with this repo.
"""
import json
import pathlib
import re
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
INGEST = ROOT / "pipeline" / "ingest"


def source(name: str) -> str:
    return (INGEST / name).read_text()


def test_the_legacy_usgs_api_is_not_used_by_the_ingest_layer():
    """USGS decommissions waterservices in Q1 2027; the ingest layer must be on the OGC API.

    The older `pipeline/fetch/fetch_usgs_history.mjs` still uses the legacy host and is a
    known, separate migration — this test is scoped to `pipeline/ingest/` on purpose, so it
    does not fail for a file this change did not touch.
    """
    for f in INGEST.glob("*.mjs"):
        # Comments may NAME the retired host — the adapter's docstring explains the migration —
        # so only executable text counts. A block comment is stripped; a `//` inside a URL is
        # not, because truncating at `//` would hide the host this test exists to find.
        code = re.sub(r"/\*.*?\*/", "", f.read_text(), flags=re.S)
        code = "\n".join(l for l in code.splitlines() if not l.strip().startswith("//"))
        assert "waterservices.usgs.gov" not in code, f"{f.name} still calls the retiring API"


def test_each_adapter_names_its_documented_host():
    assert "api.water.noaa.gov/nwps/v1" in source("nwps.mjs")
    assert "api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items" in source("usgs_ogc.mjs")
    assert "cwms-data.usace.army.mil/cwms-data" in source("usace_cwms.mjs")


def test_the_usgs_adapter_documents_the_rate_limit_that_sizes_its_plan():
    """The 14-request plan is only safe because the limit is 50/hour unauthenticated.

    If someone widens the chain, this sentence is what tells them to count again.
    """
    text = source("usgs_ogc.mjs")
    assert "50 requests/hour" in text
    assert "USGS_API_KEY" in text, "the optional key that raises the limit is not honoured"


def test_the_usace_allow_list_is_brazos_only():
    text = source("usace_cwms.mjs")
    ids = dict(re.findall(r'\{ cda: "(\w+)", name: "([^"]+)"', text))
    assert set(ids) == {"GGLT2", "GNGT2", "BLNT2", "STIT2", "WTYT2", "ACTT2", "SOMT2"}, ids
    # Addicks (ADDT2) and Barker (BKRT2) are San Jacinto basin. They are deliberately absent.
    for neighbour in ("ADDT2", "BKRT2"):
        assert neighbour not in text, f"{neighbour} is San Jacinto basin and must not be ingested as Brazos"
    assert 'basin: "Brazos"' in text, "every project record must carry its basin"


def test_a_receipt_without_a_row_count_is_refused():
    """The rule that makes an empty series a failure rather than a quiet success."""
    probe = """
      import { entry } from "./pipeline/ingest/lib.mjs";
      try { entry("x", { url: "u", rows: undefined }); console.log("accepted"); }
      catch { console.log("refused"); }
    """
    out = subprocess.run(["node", "--input-type=module", "-e", probe], cwd=ROOT,
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "refused", "an entry with no row count was accepted"


def test_refresh_plans_every_source_without_the_network():
    out = subprocess.run(["node", "pipeline/ingest/refresh.mjs", "--dry-run"],
                         cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    for name in ("nwps", "usgs_ogc", "usace"):
        assert f"== {name} (dry run)" in out.stdout, f"{name} is not in the default refresh"
    assert "would fetch https://api.water.noaa.gov/nwps/v1/gauges/RMOT2/stageflow" in out.stdout
    assert "would fetch" in out.stdout and "dry run: nothing fetched" in out.stdout
    assert "receipts" not in out.stdout, "a dry run wrote receipts"


def test_refresh_can_answer_how_old_the_snapshot_is_without_the_network():
    """The cadence's other half. A scheduled fetch is only useful if something notices it stopped.

    `--check-stale` reads the receipts and nothing else, so it is safe on a timer and safe in
    a test. The two assertions bracket the threshold rather than pinning a wall-clock time: any
    real receipt is older than zero hours and younger than a million.
    """
    if not (ROOT / "data" / "raw" / "_receipt.json").exists():
        pytest.skip("no receipts in this checkout, so there is no age to report")

    generous = subprocess.run(["node", "pipeline/ingest/refresh.mjs", "--check-stale=1000000"],
                              cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert generous.returncode == 0, generous.stderr
    assert "source families" in generous.stdout

    strict = subprocess.run(["node", "pipeline/ingest/refresh.mjs", "--check-stale=0"],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert strict.returncode == 1, "nothing can be zero hours old, so this must fail"
    assert "FAILED:" in strict.stderr and "refresh.mjs" in strict.stderr

    bad = subprocess.run(["node", "pipeline/ingest/refresh.mjs", "--check-stale=soon"],
                         cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert bad.returncode == 2, "a non-numeric threshold must be a usage error"


def test_the_cadence_is_a_committed_job_and_not_a_memory():
    """§ 2.6 asked for a schedule. A schedule that only exists in someone's notes is the
    failure mode this test is written against, so the workflow is asserted to exist, to run
    on a cron, and to finish by proving it fetched something."""
    path = ROOT / ".github" / "workflows" / "refresh.yml"
    assert path.exists(), "the scheduled refresh is gone: nothing runs the ingest on a cadence"
    text = path.read_text()
    assert "cron:" in text, "the workflow has no schedule, so it is a button rather than a cadence"
    assert "node pipeline/ingest/refresh.mjs" in text
    assert "--check-stale=1" in text, (
        "the job never asserts that its own run produced fresh receipts, so a run that fetched "
        "nothing would still pass")


def test_refresh_refuses_an_unknown_source():
    out = subprocess.run(["node", "pipeline/ingest/refresh.mjs", "--source=noaa_everything"],
                         cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert out.returncode == 2, "an unknown source must be a usage error, not a silent skip"


def test_a_written_receipt_describes_every_request():
    """If a receipt exists, it must be usable: a source without a url, a row count or a hash
    is not a record of anything. Skipped on a fresh clone, because receipts are fetched."""
    path = ROOT / "data" / "raw" / "_receipt.json"
    if not path.exists():
        return
    data = json.loads(path.read_text())
    assert data["sources"], "the receipt file exists but describes no sources"
    for name, r in data["sources"].items():
        for key in ("url", "status", "rows", "fetched_at", "bytes", "sha256"):
            assert key in r, f"{name} has no {key}"
        assert isinstance(r["rows"], int) and r["rows"] > 0, f"{name} records {r['rows']} rows"
        assert r["status"] == 200, f"{name} recorded a {r['status']}"
