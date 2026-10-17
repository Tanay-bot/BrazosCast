"""D4 — the raw-input policy, held to itself.

`.gitignore` decides whether anyone who clones the repo can check the shipped
numbers, and until now it decided that by accident. Two inputs were in the wrong
class, and both were found by reading each rule against what actually reads the
file:

  * `data/raw/usgs/iv/08114000_20170822.json` — the 2017 interval record, the only
    input to `backcast.py`, `ensemble.py` and `harvey_validation.py` and the series
    the app replays — sat inside a tree excluded wholesale. A clone could not
    re-derive any of those, and `test_source_integrity.py` could not pass.
  * `data/raw/fbcad_roads.json` — the FBCAD centerlines the shipped address index
    is built from — was neither tracked nor ignored, so it showed up as `??` on
    every `git status` and stayed undecided.

The first now survives on a NEGATION rule inside a directory that is otherwise
ignored, which is fragile in a specific way: broadening the rule above it back to
the directory form (`data/raw/usgs/`) re-ignores it silently, because git cannot
re-include a file whose parent directory is excluded. That is exactly how it went
undeclared the first time, so it is asserted here rather than trusted.

`git check-ignore` is used instead of reading the rules directly because it applies
git's own matcher: ordering, `**`, and negation are all things a re-implementation
would get subtly wrong in the direction of passing.
"""
import shutil
import subprocess

import pytest

from conftest import ROOT

GITIGNORE = ROOT / ".gitignore"
POLICY_DOC = "docs/DATA-SOURCES.md"
BEGIN = "# ---- raw inputs"
END = "# ---- end raw inputs"

# Raw inputs a shipped artifact descends from. Both sit inside a tree that is
# excluded wholesale; both survive on a negation rule.
COMMITTED_EXCEPTIONS = [
    "data/raw/usgs/iv/08114000_20170822.json",  # the 2017 backcast's hydrograph
    "data/raw/fbcad_roads.json",                # the address index's only input
]

# One path per ignored tree — plus a NEIGHBOUR of the exception above it, which is
# the leak a mis-scoped negation would produce: `data/raw/usgs/iv/` must still be
# excluded for every other event while that one file is not.
STILL_EXCLUDED = [
    "data/raw/hand/12070104/hydrotable.parquet",
    "data/raw/usgs/08114000_daily.json",
    "data/raw/usgs/iv/08096500_20170822.json",
]


def _git(*args):
    if shutil.which("git") is None or subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--git-dir"],
            capture_output=True).returncode != 0:
        pytest.skip("not a git checkout, so .gitignore means nothing here")
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def _is_ignored(path: str) -> bool:
    """git's own answer. 0 = ignored, 1 = not ignored, anything else is a failure."""
    proc = _git("check-ignore", "-q", path)
    assert proc.returncode in (0, 1), (
        f"git check-ignore failed on {path} (exit {proc.returncode}):\n{proc.stderr}")
    return proc.returncode == 0


def test_the_inputs_a_shipped_artifact_descends_from_are_committed():
    """A clone that cannot read these cannot check what the repo publishes."""
    for path in COMMITTED_EXCEPTIONS:
        assert not _is_ignored(path), (
            f"{path} is ignored, but a shipped artifact descends from it. It lives "
            f"inside a tree excluded wholesale, so it stays committed only through "
            f"the negation rule — check that the rules ABOVE it are still the "
            f"file-glob forms and not the directory ones. Policy: {POLICY_DOC} "
            f"§ \"Raw inputs\".")


def test_the_bulk_caches_stay_out_of_the_repo():
    """162 MB of re-creatable caches, and the exception must not leak wider."""
    for path in STILL_EXCLUDED:
        assert _is_ignored(path), (
            f"{path} is NOT ignored. The policy commits 9.2 MB and excludes the bulk "
            f"caches; this path is one of them, so either a rule was narrowed or the "
            f"negation for the 2017 interval record now covers its neighbours too. "
            f"Policy: {POLICY_DOC} § \"Raw inputs\".")


# A reason has to be more than a separator: a bare `#` is layout, not a decision.
_MIN_REASON = 20
# What makes an exclusion defensible: how big it is, or what re-creates it.
_SIZES = ("MB", "KB")
_REMAKE = "re-creat"


def _raw_input_rules():
    """Return (line number, rule, comment block above it) for the raw section."""
    lines = GITIGNORE.read_text().splitlines()
    assert any(l.startswith(BEGIN) for l in lines), (
        f"{GITIGNORE.name} has no {BEGIN!r} marker; the raw-inputs section is what "
        "carries the reasons and the recreate commands, and it cannot be found")
    assert any(l.startswith(END) for l in lines), (
        f"{GITIGNORE.name} has no {END!r} marker")
    start = next(i for i, l in enumerate(lines) if l.startswith(BEGIN))
    stop = next(i for i, l in enumerate(lines) if l.startswith(END))
    assert start < stop, f"the {BEGIN!r} marker comes after {END!r}"

    rules, block = [], []
    for n, line in enumerate(lines[start + 1:stop], start=start + 2):
        stripped = line.strip()
        if not stripped:
            block = []  # a blank line ends a comment block
        elif stripped.startswith("#"):
            block.append(stripped)
        else:
            rules.append((n, stripped, list(block)))
            block = []
    assert rules, "the raw-inputs section contains no rules at all"
    return rules


def test_every_raw_input_rule_states_why_it_is_ignored():
    """The section is the record; an unexplained rule is the half-made decision.

    A structural invariant, not a semantic one: it cannot tell a true reason from a
    plausible one, it can only insist that one is written down, that it says how
    big the thing is or what re-creates it, and that it sits with the rule it
    belongs to rather than in a paragraph somewhere above.
    """
    unexplained, unsized = [], []
    for n, rule, block in _raw_input_rules():
        text = " ".join(block)
        if len(text) <= _MIN_REASON:
            unexplained.append((n, rule))
        # An exclusion has to justify itself; a negation (`!`) is an inclusion,
        # so it needs a reason but no size or recreate command.
        elif not rule.startswith("!") and not (
                any(s in text for s in _SIZES) or _REMAKE in text):
            unsized.append((n, rule))

    assert not unexplained, (
        "these rules sit in the raw-inputs section with no comment above them, so "
        "nothing says why the path is excluded or what re-creates it:\n"
        + "\n".join(f"  .gitignore:{n}: {r}" for n, r in unexplained)
        + f"\nEvery rule needs a reason (see {POLICY_DOC} § \"Raw inputs\").")
    assert not unsized, (
        "these exclusions do not say how big the excluded tree is or what "
        "re-creates it, which is the whole argument for leaving it out of the "
        "repo:\n" + "\n".join(f"  .gitignore:{n}: {r}" for n, r in unsized)
        + "\nState the size (MB/KB) or the command that re-creates it.")


def test_the_policy_pointer_in_gitignore_resolves_to_a_real_heading():
    """The section points at the doc; a renamed heading would rot the pointer."""
    text = GITIGNORE.read_text()
    assert POLICY_DOC in text, (
        f"the raw-inputs section no longer points at {POLICY_DOC}, so a reader has "
        "no rationale to follow and no way to see what a fresh clone can run")
    tail = text[text.index(POLICY_DOC):]
    quote = tail.index('"')
    title = tail[quote + 1:tail.index('"', quote + 1)]

    doc = (ROOT / POLICY_DOC).read_text()
    assert f"## {title}" in doc, (
        f"{GITIGNORE.name} points at {POLICY_DOC} § \"{title}\" and that heading "
        f"does not exist — the policy was renamed or moved without the pointer")
