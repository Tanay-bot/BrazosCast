#!/usr/bin/env bash
#
# BrazosCast — every check, one command.
#
#   scripts/check.sh            fast: the tests that do not re-run the pipeline (~15 s, of
#                               which ~5 s is pytest and the kernel suite it drives)
#   scripts/check.sh --browser  also the Playwright suite (~60 s: it builds the app again
#                               and starts two servers — the app, and the origin gate the
#                               outage spec takes the app's origin away with)
#   scripts/check.sh --all      also the golden regression, which re-runs the whole chain in
#                               a throwaway copy (~2 min, mostly Harvey validation), and the
#                               browser suite — measured end to end at ~3 min
#
# The golden regression reads raw inputs that are NOT in the repo, by decision and not by
# accident: docs/DATA-SOURCES.md § "Raw inputs — what is tracked, and why". A bare clone can
# run everything except that one step until the manual HAND archive is in data/raw/hand/.
#

# NOT here: the mutation harness (scripts/check-mutants.sh), which re-runs each check with a
# deliberate defect compiled into the real code. It is the slowest thing in the repo by
# construction and it is not a gate — it is the evidence behind every "this would catch it"
# claim in the README. Run it when a check changes, not on every edit.
#
# Nothing here is piped into a filter, because a pipeline's exit status is the last
# command's and `... | tail` would report success for a failing test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${BRAZOSCAST_PYTHON:-$HOME/miniforge3/envs/brazoscast/bin/python}"

ALL=0
BROWSER=0
case "${1:-}" in
  "")        ;;
  --browser) BROWSER=1 ;;
  --all)     ALL=1; BROWSER=1 ;;
  *)         echo "usage: scripts/check.sh [--browser|--all]" >&2; exit 2 ;;
esac

step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

if [ ! -x "$PY" ]; then
  echo "python not found at $PY" >&2
  echo "set BRAZOSCAST_PYTHON to the environment with geopandas (see README)" >&2
  exit 2
fi

# The pipeline tests also DRIVE the app's kernel suite: pipeline/tests/test_grid_parity.py runs
# `vitest run` over app/src/lib and fails on any pipeline grid row the TypeScript cannot reproduce
# (and on a run that collects nothing, since a runner with no tests also exits 0). So the cross-
# language claim is covered by the fast path, not by a step someone has to remember.
step "pipeline tests ($("$PY" -m pytest --version 2>/dev/null || echo 'pytest missing'))"
if [ "$ALL" = 1 ]; then
  "$PY" -m pytest pipeline/tests || fail "pipeline tests (including the slow golden regression)"
else
  "$PY" -m pytest pipeline/tests -m "not slow" || fail "pipeline tests"
  echo "   (skipped the slow golden regression — run scripts/check.sh --all)"
fi

step "TypeScript types"
( cd "$ROOT/app" && npx tsc --noEmit ) || fail "tsc --noEmit"

step "app build"
( cd "$ROOT/app" && npm run build ) || fail "vite build"

# After the build, because this reads app/dist: it is the only check that sees what is
# actually shipped, and the text-only route is a claim about the shipped bytes.
step "text-only route (?text=1) budget"
node "$ROOT/scripts/check-text-mode.mjs" || fail "text-only budget (MapLibre split / fonts guarded)"

# Also after the build, and for the same reason: this runs the SHIPPED app/dist/sw.js in
# a fake world with the network switched off, because a service worker's behaviour is not
# in its text. It holds the line F5 drew — the eager set is the shell, not the 1.6 MB payload.
step "offline service worker"
node "$ROOT/scripts/check-offline.mjs" || fail "offline contract (shell-only install, SWR, gauge fallback, deploy)"

# The browser half, and the only check that can be the browser half: a real navigation, a real
# Cache Storage, a real service worker in the middle. Opt-in because it costs ~45 s and needs
# the Playwright browsers installed — but a check only a human remembers to run is a check that
# stops running, so `--all` includes it. It serves the app through tests/e2e/origin-gate.mjs,
# which can take the ORIGIN away rather than just the page's network: `setOffline(true)` leaves
# the worker its own connection, and an outage the worker can still reach proves nothing.
if [ "$BROWSER" = 1 ]; then
  step "browser suite (Playwright: mocked gauge, then a real outage)"
  ( cd "$ROOT/app" && npx playwright test ) || fail "browser suite (if Playwright is missing its browsers: cd app && npx playwright install chromium)"
else
  echo "   (browser suite skipped — run scripts/check.sh --browser, or --all)"
fi

step "shipped payload is current"
# The build copies app/public/data into dist; if the two disagree the deployed
# bundle is serving artifacts from a previous run of the pipeline.
for f in "$ROOT"/app/public/data/*; do
  n="$(basename "$f")"
  d="$ROOT/app/dist/data/$n"
  [ -f "$d" ] || fail "app/dist/data/$n is missing — rebuild, or re-run the export"
  cmp -s "$f" "$d" || fail "app/dist/data/$n differs from app/public/data/$n"
done
echo "   app/dist/data matches app/public/data"

printf '\nAll checks passed.\n'
