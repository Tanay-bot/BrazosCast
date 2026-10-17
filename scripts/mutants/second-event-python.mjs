#!/usr/bin/env node
/* Mutation test for pipeline/tests/test_second_event.py: break the second-event validation in
 * five ways, one at a time, and require the NAMED test to fail — a mutation that fails some
 * other test means the check caught it for the wrong reason.
 *
 * Two files are touched and both are restored byte-identical (verified, not assumed). The
 * artifact counts because the script WRITES it as a side effect: a mutant that leaves a
 * mutated data/derived/second_event_validation.json behind would quietly change every number
 * the README and FINDINGS quote, which is the failure this whole harness exists to prevent.
 *
 * Each `from` string is either an input that decides a published number (the image instant,
 * the stage, the lift, the population an AUC is computed over) or an input that decides what
 * the headline MEANS (whether a refutation has to be shown dry). Between them they cover the
 * four claims the file makes: the observation is the one it says it is, it is scored at the
 * right instant, the correction under test is Harvey's, and the refutation count is not the
 * modelled-wet count under another name.
 *
 * Run through `scripts/check-mutants.sh`, which resolves the interpreter the same way
 * scripts/check.sh does. */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PY = process.env.BRAZOSCAST_PYTHON
  ?? `${process.env.HOME}/miniforge3/envs/brazoscast/bin/python`;
const SRC = `${ROOT}/pipeline/derive/second_event_validation.py`;
const ART = `${ROOT}/data/derived/second_event_validation.json`;
const FILES = { src: SRC, art: ART };
const original = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]));
const TESTS = "pipeline/tests/test_second_event.py";

const M = (name, test, from, to) => ({ name, test, from, to });

const mutations = [
  // The image instant is what makes this a stage-specific observation; a validator that reads
  // the date but substitutes its own time is scoring the thresholds against a different water.
  M("acquisition time invented, not read from the layer",
    "test_the_stage_is_recomputed_from_the_image_time_and_the_cached_gauge",
    `    day = pd.Timestamp(row["Flood_Date"]).date()\n    return pd.Timestamp(f"{day}T{row['Start_Time']}", tz="UTC")`,
    `    day = pd.Timestamp(row["Flood_Date"]).date()\n    return pd.Timestamp(f"{day}T12:00:00", tz="UTC")`),

  // The defect the receipt documented and the artifact was built to remove: the stage taken
  // from the acquisition DAY (a range, and a mean of 50.87 ft here) rather than the instant.
  M("stage from the day mean, not the image instant",
    "test_the_stage_is_recomputed_from_the_image_time_and_the_cached_gauge",
    `    nearest = s.index[np.argmin(np.abs(s.index - when))]\n    stage = float(s.loc[nearest])`,
    `    _d = s[(s.index >= when.normalize()) & (s.index < when.normalize() + pd.Timedelta("1D"))]\n    nearest = _d.index[np.argmin(np.abs(_d.index - when))]\n    stage = float(_d.mean())`),

  // The correction restated instead of read: this is the one field whose restatement would let
  // the two artifacts drift while both stayed self-consistent, turning the out-of-sample claim
  // into a test of some other lift.
  M("the tested lift hardcoded instead of read from Harvey's artifact",
    "test_the_correction_tested_is_the_correction_harvey_measured",
    `        "lift_ft": hv["estimators_of_the_same_lift"]["probit_mle_ft"],`,
    `        "lift_ft": 22.30,`),

  // The confound the second version of this file fixed: an AUC is a property of a population,
  // so reporting the corridor's AUC as Harvey's-set AUC makes a cross-population comparison
  // look like a like-for-like one. The count stays right; only the number is wrong.
  M("Harvey-set AUC computed over the corridor",
    "test_the_ranking_comparison_uses_matched_populations",
    `    a6_hvset = auc(-thresh[in_harvey_set], obs_wet[in_harvey_set])`,
    `    a6_hvset = auc(-thresh[in_box], obs_wet[in_box])`),

  // And the headline's definition: a refutation is a modelled-wet segment the image shows DRY.
  // Drop the "dry" and the count becomes the modelled-wet total, which is the number a
  // HIGH-stage extent could have produced — i.e. the finding would say nothing.
  M("refutation no longer requires the image to show dry",
    "test_the_refutations_are_quantified_and_survive_the_under_mapping_objection",
    `    refuted = in_box & ~obs_wet & model_wet`,
    `    refuted = in_box & model_wet`),
];

let bad = 0;
for (const m of mutations) {
  if (!original.src.includes(m.from)) {
    console.log(`  ?? ${m.name}: the code to mutate is gone — update this script`);
    bad++;
    continue;
  }
  writeFileSync(SRC, original.src.replace(m.from, m.to));
  // The tests assert against the ARTIFACT, so the mutant has to be run through the derivation
  // first — otherwise the committed (unmutated) artifact is what the tests read and every
  // mutant looks harmless. A derivation that refuses (its own gates) writes nothing, which is
  // reported rather than counted as caught: that would be a different check doing the work.
  let derived = 0;
  try {
    execFileSync(PY, ["pipeline/derive/second_event_validation.py"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    derived = e.status ?? 1;
  }
  let out = "", code = 0;
  try {
    out = execFileSync(PY, ["-m", "pytest", TESTS, "-q"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  writeFileSync(SRC, original.src);
  writeFileSync(ART, original.art);
  const failed = /(test_\w+)\s+_____/.exec(out)?.[1] ?? /FAILED [^\s]*::(test_\w+)/.exec(out)?.[1];
  const ok = code !== 0 && failed === m.test;
  const note = derived !== 0 ? ` derivation exited ${derived}` : "";
  console.log(`  ${ok ? "ok  " : "MISS"} ${m.name.padEnd(46)} exit=${code} failed=${failed ?? "-"}${note}`);
  if (!ok) {
    bad++;
    console.log(out.split("\n").filter((l) => /^E /.test(l)).slice(0, 2).map((l) => `        ${l}`).join("\n"));
  }
}

let restored = 0;
for (const [k, p] of Object.entries(FILES)) if (readFileSync(p, "utf8") === original[k]) restored++;
console.log(bad === 0 && restored === 2
  ? `\nAll ${mutations.length} mutations were caught, and both files are byte-identical.`
  : `\n${bad} of ${mutations.length} mutations were NOT caught (${restored}/2 files restored).`);
process.exit(bad === 0 && restored === 2 ? 0 : 1);
