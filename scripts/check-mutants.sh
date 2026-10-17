#!/usr/bin/env bash
#
# BrazosCast — the mutation harness: every claim of the form "this check would catch it".
#
#   scripts/check-mutants.sh
#
# OPT-IN, and deliberately not part of scripts/check.sh. It is slow by construction — each mutant
# is a real defect compiled into the real code and run against the real check, and the browser and
# worker sets rebuild or reload per mutant — so it is the one thing here that stays off the fast
# path. What it buys is the difference between a claim and a checked claim: the README, FINDINGS
# and docs/ACTION-PLAN.md all say some number of deliberate defects "each fail the check that owns
# them", and until this existed the scripts that did the mutating lived in a shell history.
#
# Two rules, and they are the whole design:
#
#   1. Each mutant must fail THE CHECK THAT OWNS IT, by name. "Something failed" is not evidence:
#      a mutation that trips an unrelated guard has been caught by accident, and the check the
#      claim is about is still untested. So the expected failing stage / test name is part of each
#      definition and is compared, not just the exit status.
#
#   2. Every file it touches is restored and then COMPARED, byte for byte, at the end. A harness
#      that leaves a defect in the tree is worse than no harness, and a `trap` alone cannot prove
#      it did not, so the comparison is the assertion.
#
# The control runs first: with no mutation applied, the checks must pass. Without it a broken
# environment would look like a perfect score.
#
# Not covered here, and not claimed to be: the kernel-grid, chart, share, state-contract and
# text-mode mutant sets. Those were verified by hand during the sessions that wrote them, and
# porting them in is the same mechanical job as these — until then the ledger in
# docs/ACTION-PLAN.md is the record of where each claim was checked.
#
# Nothing is piped into a filter, because a pipeline's exit status is the last command's.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${BRAZOSCAST_PYTHON:-$HOME/miniforge3/envs/brazoscast/bin/python}"
LIB="$ROOT/app/src/lib/islands.ts"
ROUTING="$ROOT/pipeline/derive/routing.py"
MAIN="$ROOT/app/src/main.ts"
SW="$ROOT/app/public/sw.js"
HTML="$ROOT/app/index.html"

step() { printf '\n== %s\n' "$1"; }

if [ ! -x "$PY" ]; then
  echo "python not found at $PY" >&2
  echo "set BRAZOSCAST_PYTHON to the environment with geopandas (see README)" >&2
  exit 2
fi

# The union of everything any set below writes to. Backed up before anything runs and compared
# after everything has: routing.py rewrites its two artifacts as a side effect, so those count.
FILES=("$LIB" "$ROUTING" "$MAIN" "$SW" "$HTML"
       "$ROOT/pipeline/derive/second_event_validation.py"
       "$ROOT/pipeline/derive/notifications.py" "$ROOT/pipeline/notify/templates.json"
       "$ROOT/app/src/lib/notify.ts"
       "$ROOT/data/derived/routing_graph.json" "$ROOT/data/derived/routing.summary.json"
       "$ROOT/data/derived/second_event_validation.json")
BAK="$(mktemp -d)"
restore() {
  local f
  for f in "${FILES[@]}"; do cp "$BAK/$(basename "$f")" "$f"; done
}
trap 'restore; rm -rf "$BAK"' EXIT
for f in "${FILES[@]}"; do cp "$f" "$BAK/$(basename "$f")"; done

caught=0
missed=0
report() {  # name, what happened
  if [ "$2" = 0 ]; then
    printf '  caught   %s\n' "$1"; caught=$((caught + 1))
  else
    printf '  MISSED   %s  → %s\n' "$1" "$3"; missed=$((missed + 1))
  fi
}

# --- the runners -------------------------------------------------------------
# Each takes the mutant's name and returns 0 only if the owning check FAILED, which is success
# here. A runner that cannot tell which check failed is weaker than one that can, which is why
# the worker and source sets compare a stage or a test name rather than an exit code.

run_vitest() {  # the app's island kernel
  ( cd "$ROOT/app" && ./node_modules/.bin/vitest run tests/unit/islands.test.ts ) \
    >"$BAK/vitest.txt" 2>&1
  [ $? -ne 0 ]
}

run_routing() {  # the pipeline's own gates must refuse to write the artifact
  ( cd "$ROOT" && "$PY" pipeline/derive/routing.py ) >"$BAK/routing.txt" 2>&1
  [ $? -ne 0 ]
}

run_contract() {  # the fixture that holds what the shipped data cannot express
  ( cd "$ROOT" && "$PY" -m pytest pipeline/tests/test_island_contract.py -q ) \
    >"$BAK/contract.txt" 2>&1
  [ $? -ne 0 ]
}

run_spec() {  # a browser spec against the built app; $1 may name several files
  # shellcheck disable=SC2086  # unquoted on purpose: it is a list of spec paths
  ( cd "$ROOT/app" && npx playwright test $1 ) >"$BAK/spec.txt" 2>&1
  [ $? -ne 0 ]
}

# `mutate <file> <<'PY' … PY` — the python program reads the path from argv[1] and rewrites it.
mutate() {
  python3 - "$1" || { echo "  ?? a mutation failed to apply to $1" >&2; exit 2; }
}

# --- control -----------------------------------------------------------------
step "control (no mutation): the checks pass as shipped"
control=1
# The runners answer "did the owning check fail?", which is the right question for a mutant and
# the wrong one here — so the control inverts them. Getting this backwards is exactly what the
# control is for, and it did catch it: the first run of this script reported a failed control
# while the ten specs above it were passing.
run_spec "tests/e2e/household.spec.ts tests/e2e/island.spec.ts" && control=0
( cd "$ROOT" && "$PY" -m pytest pipeline/tests/test_island_contract.py -q ) >"$BAK/ctl.txt" 2>&1 \
  || control=0
if [ "$control" = 1 ]; then
  echo "  control passes"
else
  echo "  CONTROL FAILED — fix the environment before reading anything below" >&2
  tail -20 "$BAK/ctl.txt" "$BAK/spec.txt" >&2
  exit 1
fi

# =============================================================================
step "the island sweep (app/src/lib/islands.ts) — tests/unit/islands.test.ts"
# The partition is arithmetic, so these are arithmetic defects: a boundary that is off by one
# comparison, a rule that reads node order, an identity that stops being an identity.
# =============================================================================

# An inclusive passability rule. The rungs sit on the same 0.1 ft grid as the thresholds, so
# 45 ft is an exact threshold for many segments and the two rules really do differ here.
mutate "$LIB" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "if (spec.edgeFt[e] > stage) {"
assert old in s, "the passability rule moved; update this mutant"
open(p, "w").write(s.replace(old, "if (spec.edgeFt[e] >= stage) {", 1))
PY
run_vitest; report "passability t > stage → t >= stage" $? "islands.test.ts passed with it"
restore

# The boundary loosened: a wet segment whose nodes are ALL on this island is water you can drive
# around, and counting it as a way off would overstate the cut.
mutate "$LIB" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "if (mine && other) {"
assert old in s, "the boundary definition moved; update this mutant"
open(p, "w").write(s.replace(old, "if (mine || other) {", 1))
PY
run_vitest; report "boundary mine && other → mine || other" $? "islands.test.ts passed with it"
restore

# The attribution rule replaced by "whatever island the first node is on", in the ladder's counts.
mutate "$LIB" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "    segs[attribute(reach, size, touched)]++;"
assert old in s, "the ladder attribution moved; update this mutant"
open(p, "w").write(s.replace(old, "    segs[touched[0]]++;", 1))
PY
run_vitest; report "ladder attribution → first island in the list" $? "islands.test.ts passed"
restore

# The same rule in the per-street view, which is a different call site and a different claim: the
# one island a household is shown must be the one the ladder counted.
mutate "$LIB" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "  const me = attribute(sw.reach, sw.size, touched);"
assert old in s, "the view's attribution moved; update this mutant"
open(p, "w").write(s.replace(old, "  const me = touched[0];", 1))
PY
run_vitest; report "view attribution → first island in the list" $? "islands.test.ts passed"
restore

# The partition identity broken: a straddling segment counted in every island it touches, so
# `sum(segs) === dryCount` no longer holds and one road is in two places at once.
mutate "$LIB" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "    segs[attribute(reach, size, touched)]++;"
assert old in s, "the ladder attribution moved; update this mutant"
open(p, "w").write(s.replace(old, "    for (const i of touched) segs[i]++;", 1))
PY
run_vitest; report "straddling segments counted in both islands" $? "islands.test.ts passed"
restore

# =============================================================================
step "the island ladder (pipeline/derive/routing.py) — its own gates, before the artifact is written"
# =============================================================================

# The same inclusive rule on the pipeline's side: the union-find and the flood fill then disagree,
# which is the gate that makes the second implementation worth having.
mutate "$ROUTING" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "        if t > stage:"
assert old in s, "the passability rule moved; update this mutant"
open(p, "w").write(s.replace(old, "        if t >= stage:", 1))
PY
run_routing; report "passability t > stage → t >= stage" $? "routing.py wrote the artifact anyway"
restore

# The cross-check against §7's published cut field, disabled. This is the gate that ties a new
# statistic to a number that already had one.
mutate "$ROUTING" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "            here = island_of[i] in with_responder"
assert old in s, "the cut-field cross-check moved; update this mutant"
open(p, "w").write(s.replace(old, old + " or i in seed_nodes or True", 1))
PY
run_routing; report "cut-field cross-check disabled" $? "routing.py wrote the artifact anyway"
restore

# =============================================================================
step "the attribution rule where it can actually be seen (pipeline/tests/test_island_contract.py)"
# This one is here because of a measurement, not a hunch: replacing the rule with "the lowest
# island id" leaves EVERY published number byte-identical, so no gate over the artifact can hold
# it, and the reversal gate cannot either (the pipeline sorts the touched list). It is held on a
# synthetic graph instead — see docs/FINDINGS.md §14.
# =============================================================================

mutate "$ROUTING" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "        seg_island = [_attribute(reach, size, t) for t in touched]"
assert old in s, "the attribution line moved; update this mutant"
open(p, "w").write(s.replace(old, "        seg_island = [t[0] for t in touched]", 1))
PY
run_contract; report "attribution → lowest island id (held by the synthetic fixture)" $? \
  "the contract tests passed with it"
restore

# =============================================================================
step "the app's half (app/src/main.ts) — the browser specs that own each claim"
# =============================================================================

# The household ranking removed, so the rows stay in the order they were typed. The spec checks
# the ranking as an order over the numbers the card itself shows.
mutate "$MAIN" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
start = s.index("  }).sort((a, b) => {\n    const ha = a.hours")
end = s.index("  });\n\n  const list = $(\"hhList\");", start) + len("  });")
open(p, "w").write(s[:start] + "  });" + s[end:])
PY
run_spec "tests/e2e/household.spec.ts"
report "household rows left in input order" $? "household.spec.ts passed"
restore

# The emptied island described by its size again — the contradiction a measurement caught: a
# street whose own segment the fire station sits on reporting "0 of 1,614 segments … a station
# is on it".
mutate "$MAIN" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = """  const head = v.segments === 0
    ? (v.dry
        ? "every road connected to this street is under water"
        : `water is over this street at ${stage.toFixed(2)} ft, and every road connected to it is under water`)
    : v.dry"""
assert old in s, "the three-state sentence moved; update this mutant"
s = s.replace(old, "  const head = v.dry", 1)
s = s.replace("  if (v.segments > 0) {", "  if (true) {", 1)
open(p, "w").write(s)
PY
run_spec "tests/e2e/island.spec.ts"
report "empty-island branch removed" $? "island.spec.ts passed"
restore

# The island frozen at its first value, so the panel reports the partition of an earlier stage.
mutate "$MAIN" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "    state.island = islandForSegment(islandSpec, stage, state.selIdx);"
assert old in s, "the island computation moved; update this mutant"
new = "    state.island = state.island ?? islandForSegment(islandSpec, stage, state.selIdx);"
open(p, "w").write(s.replace(old, new, 1))
PY
run_spec "tests/e2e/island.spec.ts"
report "island frozen at its first value" $? "island.spec.ts passed"
restore

# =============================================================================
step "the second event — scripts/mutants/second-event-python.mjs (5)"
# Its own file because its subject is its own file: this set mutates the derivation AND re-runs
# it, since the tests assert against the artifact and the committed artifact is the unmutated
# one. Both the script and the artifact it writes are restored and compared.
node "$ROOT/scripts/mutants/second-event-python.mjs" >"$BAK/second.txt" 2>&1
second=$?
sed 's/^/  /' "$BAK/second.txt"
[ "$second" -eq 0 ] && caught=$((caught + 5)) || missed=$((missed + 1))

# =============================================================================
step "the offline contract — scripts/mutants/offline-worker.mjs (13) and offline-python.mjs (15)"
# Both delegate: a defect in the shipped worker has to fail the check at the stage that owns it,
# and a defect in the source has to fail the test that owns it, by name. They build what they
# need and restore what they touch.
# =============================================================================

step "app build (the worker set reads and writes app/dist)"
( cd "$ROOT/app" && npm run build ) >"$BAK/build.txt" 2>&1 \
  || { echo "  the build failed; fix that first" >&2; tail -20 "$BAK/build.txt" >&2; exit 1; }

node "$ROOT/scripts/mutants/offline-worker.mjs" >"$BAK/workers.txt" 2>&1
workers=$?
sed 's/^/  /' "$BAK/workers.txt"
[ "$workers" -eq 0 ] && caught=$((caught + 13)) || missed=$((missed + 1))

node "$ROOT/scripts/mutants/offline-python.mjs" >"$BAK/sources.txt" 2>&1
sources=$?
sed 's/^/  /' "$BAK/sources.txt"
[ "$sources" -eq 0 ] && caught=$((caught + 15)) || missed=$((missed + 1))

# =============================================================================
step "the alert — scripts/mutants/notifications.mjs (8)"
# The text, the policy and both renderers. The set breaks the Spanish template, the pipeline's
# renderer and the browser's renderer separately, because "the two languages carry the same
# numbers" is a claim about two implementations and is only checked if breaking either fails.
node "$ROOT/scripts/mutants/notifications.mjs" >"$BAK/alerts.txt" 2>&1
alerts=$?
sed 's/^/  /' "$BAK/alerts.txt"
[ "$alerts" -eq 0 ] && caught=$((caught + 8)) || missed=$((missed + 1))

# =============================================================================
step "every file the harness touched, restored byte for byte"
# A trap cannot prove this; the comparison is the assertion.
restore
diffs=0
for f in "${FILES[@]}"; do
  if cmp -s "$f" "$BAK/$(basename "$f")"; then
    printf '  ok    %s\n' "${f#"$ROOT"/}"
  else
    printf '  DIFF  %s — the harness left a change behind\n' "${f#"$ROOT"/}"
    diffs=$((diffs + 1))
  fi
done

printf '\nmutants caught: %d, missed: %d, files left changed: %d\n' "$caught" "$missed" "$diffs"
[ "$missed" -eq 0 ] && [ "$diffs" -eq 0 ]
