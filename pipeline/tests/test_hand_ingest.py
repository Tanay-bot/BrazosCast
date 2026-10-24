"""NEXT-PLAN § 5.2 — the HUC8 archive fetcher, held to its own claims.

`pipeline/ingest/hand.mjs` exists because the HAND archive was the one input a clone could
not fetch for itself, and an input that arrives by hand arrives without a receipt, without a
licence check and without anything that would notice a truncated 1.7 GB file. So the claims
worth testing are exactly the ones that make a download a fact:

  * the manifest is parsed and its row count and byte total are checked against each other;
  * the package is declared BEFORE the archive moves, and a package missing a layer the
    pipeline reads is refused;
  * the archive on disk is compared with the manifest, not merely hashed — a truncation and a
    changed package both fail with a name;
  * the receipt records the licence, the hash, the size and the row count;
  * a dry run and a manifest-only read write nothing at all.

The end-to-end case runs the REAL command against a fixture archive served over loopback, so
the CLI path — HEAD, streaming download, sha256, `unzip -l` verification, extraction, receipt
— is exercised without pulling 1.7 GB from TACC. What it cannot prove is that the live host
still serves the archive: that is `--manifest`, which is run by a human or the scheduled job.
"""
import contextlib
import hashlib
import http.server
import functools
import json
import pathlib
import subprocess
import threading
import zipfile

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = ROOT / "pipeline" / "ingest" / "hand.mjs"
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "pin2flood_12070104_prod.txt"

# The layers the Python stages actually read, one from each family. A package without them
# cannot feed road_thresholds/inundation, so downloading it would be 1.7 GB of nothing.
LAYERS = [
    "12070104/rem_zeroed_masked_healed.tif",
    "12070104/hydroTable.csv",
    "12070104/gw_catchments_reaches_filtered_addedAttributes_crosswalked.gpkg",
    "12070104/demDerived_reaches_split_filtered_addedAttributes_crosswalked.gpkg",
]


def node(*args, **kw):
    return subprocess.run(["node", str(CLI), *args], cwd=ROOT, capture_output=True,
                          text=True, timeout=kw.pop("timeout", 120), **kw)


def manifest_text(entries, archive="12070104.zip"):
    """A `unzip -l`-shaped listing, which is what both the host and `unzip` speak."""
    rows = "\n".join(
        f" {size:9d}  01-22-2023 09:27   {name} : (output) fixture" for name, size in entries)
    total = sum(size for _, size in entries)
    return (f"Archive:  {archive}\n"
            "  Length      Date    Time    Name\n"
            "---------  ---------- -----   ----\n"
            f"{rows}\n"
            "---------                     -------\n"
            f" {total:9d}                     {len(entries)} files\n")


def make_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in entries:
            zf.writestr(name, f"fixture for {name}\n" * 20)
    with zipfile.ZipFile(path) as zf:
        return [(i.filename, i.file_size) for i in zf.infolist()]


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: A003 - the base class's name
        pass


@contextlib.contextmanager
def serve(root):
    handler = functools.partial(_Quiet, directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def archive_tree(tmp_path, *, declared=None):
    """A served `prod/` directory holding a real zip and a manifest that describes it."""
    root = tmp_path / "served" / "prod"
    root.mkdir(parents=True)
    entries = make_zip(root / "12070104.zip", LAYERS)
    (root / "12070104.txt").write_text(manifest_text(declared or entries))
    return tmp_path / "served", entries


# ---- the manifest ------------------------------------------------------------------

def test_the_committed_manifest_beside_the_live_archive_parses():
    """The real 1.9 KB manifest for HUC 12070104, captured from TACC.

    Committed as a fixture because the parse is the thing that can rot: the host's listing
    format changing would otherwise be discovered by a human wondering why a 1.7 GB download
    "verified" against nothing.
    """
    probe = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {parseManifest, missingLayers} from './pipeline/ingest/hand.mjs';"
         "import {readFileSync} from 'node:fs';"
         f"const m = parseManifest(readFileSync({json.dumps(str(FIXTURE))}, 'utf8'));"
         "console.log(JSON.stringify({count: m.count, bytes: m.totalBytes,"
         " names: m.files.map(f => f.name), missing: missingLayers(m.files)}));"],
        cwd=ROOT, capture_output=True, text=True, timeout=60)

    assert probe.returncode == 0, probe.stderr
    got = json.loads(probe.stdout)
    assert got["count"] == 8
    assert got["bytes"] == 2_081_129_448
    assert got["missing"] == [], "the real package no longer carries a layer the pipeline reads"
    assert any(n.endswith("rem_zeroed_masked_healed.tif") for n in got["names"])
    assert any(n.endswith("hydroTable.csv") for n in got["names"])


def test_a_manifest_that_disagrees_with_itself_is_refused():
    """A row count or byte total that does not match the rows is a format change.

    Both failures are silent by nature — the file is still a plausible listing — so the parser
    is the only place that can catch them. Verified by asking the real parser, not by reading
    the regex.
    """
    text = FIXTURE.read_text()
    wrong_count = text.replace("8 files", "9 files")
    wrong_total = text.replace("2081129448", "2081129449")
    probe = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {parseManifest} from './pipeline/ingest/hand.mjs';"
         "for (const [label, text] of [['count', process.env.A], ['total', process.env.B]]) {"
         "  try { parseManifest(text); console.log(label + ':accepted'); }"
         "  catch (e) { console.log(label + ':refused'); } }"],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
        env={"A": wrong_count, "B": wrong_total, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    assert probe.returncode == 0, probe.stderr
    assert "count:refused" in probe.stdout
    assert "total:refused" in probe.stdout


# ---- the command, without the network ------------------------------------------------

def test_a_dry_run_prints_the_urls_and_writes_nothing():
    receipt = ROOT / "data" / "raw" / "_receipt.json"
    before = receipt.stat().st_mtime_ns
    done = node("--huc8=12070104", "--dry-run")
    assert done.returncode == 0, done.stderr
    assert "pin2flood/texas/prod/12070104.zip" in done.stdout
    assert "nothing fetched" in done.stdout
    assert receipt.stat().st_mtime_ns == before, "a dry run wrote the tracked receipt"


@pytest.mark.parametrize("args, expected", [
    (["--huc8=1207"], 2),
    (["--huc8=1207010a"], 2),
    ([], 2),
    (["--huc8=12070104", "--variant=lite"], 2),
    (["--huc8=12070104", "--nonsense"], 2),
])
def test_bad_arguments_exit_2_and_never_touch_the_network(args, expected):
    done = node(*args)
    assert done.returncode == expected, done.stdout + done.stderr
    assert "usage:" in done.stderr


# ---- the command, against a fixture archive -----------------------------------------

def test_the_whole_path_downloads_verifies_extracts_and_writes_a_receipt(tmp_path):
    served, entries = archive_tree(tmp_path)
    tracked = ROOT / "data" / "raw" / "_receipt.json"
    before = tracked.read_bytes()
    receipt = tmp_path / "receipt.json"
    out = tmp_path / "out"

    with serve(served) as base:
        done = node("--huc8=12070104", f"--base={base}", f"--out={out}",
                    f"--receipt={receipt}", "--no-merge", "--extract")

    assert done.returncode == 0, done.stdout + done.stderr
    assert "verified 4 files" in done.stdout

    record = json.loads(receipt.read_text())["archives"]["12070104/prod"]
    zipped = (served / "prod" / "12070104.zip").read_bytes()
    assert record["licence"] == "CC BY 4.0"
    assert "Pin2Flood" in record["attribution"] and "TACC" in record["attribution"]
    assert record["rows"] == len(entries) == 4
    assert record["bytes"] == len(zipped)
    assert record["sha256"] == hashlib.sha256(zipped).hexdigest()
    assert record["http_status"] == 200
    assert [f["name"] for f in record["files"]] == [name for name, _ in entries]
    assert record["url"].endswith("/prod/12070104.zip")

    for name in LAYERS:
        assert (out / "12070104" / name).exists(), f"{name} was not extracted"
    assert tracked.read_bytes() == before, "--no-merge still wrote the tracked receipt"


def test_an_archive_that_does_not_match_its_manifest_is_refused(tmp_path):
    """The mutation a real truncation would produce, at the file level.

    The zip is intact and the manifest is self-consistent; they simply disagree about one
    file's size. A hash alone would not catch this (the bytes are what was sent), so this is
    the assertion that the manifest comparison is doing the work.
    """
    entries = [(LAYERS[0], 999_999)] + [(n, s) for n, s in make_zip(
        tmp_path / "probe.zip", LAYERS) if n != LAYERS[0]]
    root = tmp_path / "served" / "prod"
    root.mkdir(parents=True)
    (root / "12070104.zip").write_bytes((tmp_path / "probe.zip").read_bytes())
    (root / "12070104.txt").write_text(manifest_text(entries))

    with serve(tmp_path / "served") as base:
        done = node("--huc8=12070104", f"--base={base}", f"--out={tmp_path / 'out'}",
                    f"--receipt={tmp_path / 'r.json'}", "--no-merge")

    assert done.returncode == 1, done.stdout
    assert "does not match its manifest" in done.stderr
    assert not (tmp_path / "r.json").exists(), "a failed verification still wrote a receipt"


def test_a_package_missing_a_layer_is_refused_before_the_download(tmp_path):
    """1.7 GB is not moved to discover that the hydrotable is absent."""
    root = tmp_path / "served" / "prod"
    root.mkdir(parents=True)
    entries = make_zip(root / "12070104.zip", LAYERS[:1])
    (root / "12070104.txt").write_text(manifest_text(entries))

    with serve(tmp_path / "served") as base:
        done = node("--huc8=12070104", f"--base={base}", f"--out={tmp_path / 'out'}",
                    f"--receipt={tmp_path / 'r.json'}", "--no-merge")

    assert done.returncode == 1, done.stdout
    assert "missing the hydrotable" in done.stderr
    assert not (tmp_path / "out" / "12070104.zip").exists(), "the archive moved anyway"


def test_an_oversized_archive_needs_an_explicit_yes(tmp_path):
    """The ceiling is what stops a `--variant=full` typo from pulling 9 GB."""
    served, _ = archive_tree(tmp_path)

    with serve(served) as base:
        done = node("--huc8=12070104", f"--base={base}", f"--out={tmp_path / 'out'}",
                    f"--receipt={tmp_path / 'r.json'}", "--no-merge", "--max-bytes=100")

    assert done.returncode == 1, done.stdout
    assert "above the" in done.stderr and "--yes" in done.stderr
