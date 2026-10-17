#!/usr/bin/env node
/* Mutation test for the alert (F7): break the templates, the schedule and the two renderers in
 * eight ways, one at a time, and require the NAMED test to fail — a mutation that trips some
 * other test means the check caught it for the wrong reason, which is not the same as the check
 * being sound.
 *
 * Five files are touched and all five are restored byte-identical (verified, not assumed):
 *
 *   pipeline/notify/templates.json        the text
 *   pipeline/derive/notifications.py      the pipeline's renderer, policy and time format
 *   app/src/lib/notify.ts                 the browser's renderer and schedule
 *
 * The Python half runs against the module the tests import, so the two renderers can be broken
 * independently — which is the point: "the Spanish message carries the same numbers" is a claim
 * about two implementations, and it is only checked if breaking either one fails.
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
const FILES = {
  templates: `${ROOT}/pipeline/notify/templates.json`,
  derive: `${ROOT}/pipeline/derive/notifications.py`,
  lib: `${ROOT}/app/src/lib/notify.ts`,
};
const original = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]));

const M = (name, file, runner, test, from, to) => ({ name, file, runner, test, from, to });

const mutations = [
  // ---- the text ------------------------------------------------------------------------
  // A digit that drifts in the translation. This is the failure the whole feature is built
  // around, and the test that owns it is the parity one.
  M("a year drifts in the Spanish tier name", "templates", "pytest",
    "test_english_and_spanish_carry_the_same_digits",
    `"BrazosCast 24 h antes: se prevé que {street} se inunde`,
    `"BrazosCast 48 h antes: se prevé que {street} se inunde`),
  M("the Spanish template drops a placeholder", "templates", "pytest",
    "test_every_template_takes_exactly_the_declared_placeholders",
    `para {when}, unas {hours} h. El río está en {river} pies`,
    `para {when}, unas {hours} h. El río está en pies`),
  // The category the app computes is English in both languages; a Spanish message that leaks
  // the English word is no longer the string the pipeline rendered.
  M("a Spanish category is left in English", "templates", "pytest",
    "test_the_verification_messages_are_their_templates_filled",
    `"Minor flooding": "inundación menor",`, `"Minor flooding": "Minor flooding",`),
  // ---- the pipeline's renderer and policy -----------------------------------------------
  M("the stage ladder in the renderer drifts", "derive", "pytest",
    "test_the_category_stages_are_the_apps",
    `TH = {"action": 20, "minor": 45, "moderate": 48, "major": 50}`,
    `TH = {"action": 25, "minor": 45, "moderate": 48, "major": 50}`),
  // Owned by the extremes test: the verification rows carry their `when` as a pre-rendered
  // value, so the only Python test that exercises the formatter itself is the one that calls it.
  M("the time format loses its 12-hour rule", "derive", "pytest",
    "test_extremes_still_render_with_equal_digits",
    `    hour = local.hour % 12 or 12`, `    hour = local.hour`),
  // ---- the browser's renderer and schedule ----------------------------------------------
  M("quiet hours stop holding anything", "lib", "vitest",
    "every send time and hold matches",
    `  if (!(h >= q.from_local_hour || h < q.to_local_hour)) return { at, deferredFrom: null };`,
    `  return { at, deferredFrom: null };`),
  M("the browser fills English into the Spanish message", "lib", "vitest",
    "every verification message is reproduced character for character",
    `    v.category = es;`, `    v.category = values.category;`),
  M("an unnamed street falls back in English only", "lib", "vitest",
    "an unnamed segment falls back to the language's own phrase",
    `      street: street || ts.fallback_street[lang],`,
    `      street: street || ts.fallback_street.en,`),
];

const run = (mutation) => {
  const [cmd, args] = mutation.runner === "pytest"
    ? [PY, ["-m", "pytest", "pipeline/tests/test_notifications.py", "-q"]]
    : [`${ROOT}/app/node_modules/.bin/vitest`,
      ["run", "tests/unit/notifications.test.ts", "--reporter=verbose"]];
  return execFileSync(cmd, args, {
    cwd: mutation.runner === "pytest" ? ROOT : `${ROOT}/app`,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
};

let bad = 0;
for (const m of mutations) {
  const path = FILES[m.file];
  if (!original[m.file].includes(m.from)) {
    console.log(`  ?? ${m.name}: the code to mutate is gone — update this script`);
    bad++;
    continue;
  }
  writeFileSync(path, original[m.file].replace(m.from, m.to));
  let out = "", code = 0;
  try {
    out = run(m);
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  writeFileSync(path, original[m.file]);
  // pytest prints the failing test as a banner; vitest prints `× suite > test name`.
  const named = out.includes(m.test);
  const ok = code !== 0 && named;
  console.log(`  ${ok ? "ok  " : "MISS"} ${m.name.padEnd(42)} exit=${code} ` +
    `failed=${named ? m.test : "something else"}`);
  if (!ok) {
    bad++;
    console.log(out.split("\n").filter((l) => /^(E |FAILED|×)/.test(l))
      .slice(0, 2).map((l) => `        ${l}`).join("\n"));
  }
}

let restored = 0;
for (const [k, p] of Object.entries(FILES)) if (readFileSync(p, "utf8") === original[k]) restored++;
console.log(bad === 0 && restored === 3
  ? `\nAll ${mutations.length} mutations were caught by the test that owns them, and all three ` +
    `files are byte-identical.`
  : `\n${bad} of ${mutations.length} mutations were NOT caught (${restored}/3 files restored).`);
process.exit(bad === 0 && restored === 3 ? 0 : 1);
