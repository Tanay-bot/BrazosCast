import { expect, test, type Page } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * T8 — the performance budget, and the claim a stopwatch cannot check.
 *
 * The published numbers, from `docs/FINDINGS.md` §12/§13 and quoted in the README: a stage drag
 * costs **6.2 ms median over 24 slider steps** (max 13 ms), and the 2017 backcast block added to
 * the same drag costs **4 ms median** (max 6.4 ms). Both were measured by hand and written into
 * the docs; nothing could fail if they stopped being true. The first test holds the drag to a
 * budget in both modes — replay is where the backcast timeline is on screen, so §13 is inside
 * the second measurement rather than separate from it.
 *
 * The second published claim is not a number at all — *"the ensemble is cached on the
 * selection and never recomputed while the stage changes"* — and it is the harder one to
 * test, because one ensemble run is 50 members over a ~100-point series, i.e. a small
 * fraction of a millisecond. A recompute hidden inside a 6 ms render is invisible to a
 * stopwatch, so **timing can never catch its removal**; the second test counts the work
 * instead of timing it. That is the whole reason this file has two tests rather than one.
 *
 * Both run against the BUILT app, in the `app` project of `playwright.config.ts` (service
 * worker blocked, gauge stubbed over the network), because the cost of a dev server's module
 * graph is not the cost of the shipped one. The suite reads nothing but the DOM, the network
 * and — in the counting test — `Math.log`, which is not the app's API but the app's own
 * arithmetic. See the probe's comment for why that is the honest instrument here.
 */

const STEPS = 24;

/**
 * The view both drags are timed on, and F3/F4 are why it is not one address.
 *
 * A budget is only worth what it covers: the household card (F3) renders a row per address and the
 * island line (F4) runs a union-find over the graph on every stage step, so a drag timed on a
 * single address would measure a page that no longer exists. Two addresses put both of them inside
 * every sample, and the island line is the expensive half by construction — 8,970 edges per step —
 * which is exactly what this budget is here to hold.
 */
const HOUSEHOLD = "/?addr=1600+Jackson+Street%7C2500+Holmes+Road&stage=50";

/**
 * The median ceiling for one slider step, in ms, in the shipped build.
 *
 * Set from measurement, not taste. The published figure is 6.2 ms, and this machine reproduces
 * it: the same code measures a median of 6.0–6.4 ms with the spec alone on an idle machine and
 * 9.3–13.3 ms when it runs inside `scripts/check.sh --all`, behind the pipeline regression and
 * the build. Machine load moves it by 2x, so a ceiling near the published figure would fail on a
 * busy run and mean nothing. 40 ms is ~3x the worst observation and ~6x the claim, which is what
 * this budget is for: a per-step cost that grows with the payload, not a machine-speed
 * comparison.
 * It is not decorative — the mutant that renders ten times per input event measures 59 ms
 * median and fails here (see docs/ACTION-PLAN.md, T8). Below that the printed numbers are the
 * signal, so drift is visible in the log long before it fails.
 */
const MEDIAN_BUDGET_MS = 40;

type Step = {
  /** The `input` handler's own work: the number the published claim is about. */
  js: number;
  /** The same step including style and layout, which is what the user waits for. */
  frame: number;
};

/**
 * Drive the stage slider the way a drag does — set the value, fire the event the app listens
 * for, time what happens — over 24 values spanning the slider's whole range.
 *
 * Not a synthesised mouse drag: that adds browser work (hit-testing, pointer events) to every
 * sample, and what is being asserted is the app's render cost, not the browser's. `frame`
 * forces style and layout so the number is a frame rather than only the JS inside the handler,
 * since a render that got cheap by deferring layout would otherwise look like a win.
 */
async function drag(page: Page, steps = STEPS): Promise<Step[]> {
  return page.evaluate((n) => {
    const el = document.querySelector("#stage") as HTMLInputElement;
    const min = Number(el.min), max = Number(el.max);
    const out: { js: number; frame: number }[] = [];
    for (let i = 0; i < n; i++) {
      el.value = String(min + ((max - min) * i) / (n - 1));
      const t0 = performance.now();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      const t1 = performance.now();
      void document.body.offsetHeight; // force style + layout inside the sample
      out.push({ js: t1 - t0, frame: performance.now() - t0 });
    }
    return out;
  }, steps);
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function stats(xs: number[]) {
  const s = sorted(xs);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const mid = (s.length - 1) / 2;
  return {
    median: s.length % 2 === 1 ? s[mid] : (s[mid - 0.5] + s[mid + 0.5]) / 2,
    p90: at(0.9),
    max: s[s.length - 1],
  };
}

const fmt = (n: number) => n.toFixed(1);

/** Every number this file asserts is also printed, so a budget that is being met with less
 *  and less room says so before it fails. */
function report(scope: string, xs: number[]): void {
  const js = stats(xs.map((s) => s.js));
  const frame = stats(xs.map((s) => s.frame));
  console.log(
    `[perf] ${scope}: ${STEPS} steps — render median ${fmt(js.median)} ms, p90 ${fmt(js.p90)}, ` +
    `max ${fmt(js.max)}; with layout median ${fmt(frame.median)}, p90 ${fmt(frame.p90)}, ` +
    `max ${fmt(frame.max)}`,
  );
}

test("the stage drag stays inside the published render budget", async ({ page }) => {
  test.slow(); // a cold browser on a loaded machine is not a regression
  await stubGauge(page, { value: 30, lastObsHoursAgo: 0.25 });
  await booted(page, HOUSEHOLD);
  // Non-vacuous: the ensemble block, the household card and the island line are the state-holding
  // parts of the render and each exists only with a street selected, so a drag timed on an empty
  // page would measure nothing. All three are asserted present rather than assumed.
  await expect(page.locator("#ens")).toBeVisible();
  await expect(page.locator("#hhCard")).toBeVisible();
  await expect(page.locator("#islandNote")).toBeVisible();
  const atFifty = await text(page, "mapNote");

  await drag(page, 3); // discarded: the first steps pay for lazy map work that a drag pays once
  const live = await drag(page);
  report("live", live);

  // The drag did real work, so the budget is being met by work rather than by a no-op: at 5 ft
  // and at 56 ft the same 1,614 segments cannot read alike, and the stage really moved.
  expect(await text(page, "stageVal")).toBe("56.00");
  expect(await text(page, "mapNote")).not.toBe(atFifty);

  // Replay is the heavier render — the backcast timeline is on screen too (§13's claim).
  await page.locator("#mReplay").click();
  await expect(page.locator("#bcCard")).toBeVisible();
  await drag(page, 3);
  const replay = await drag(page);
  report("replay (with the backcast block)", replay);

  expect(stats(live.map((s) => s.js)).median).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  expect(stats(replay.map((s) => s.js)).median).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
});

/* ---------------------------------------------------------------- *
 * The probe: `Math.log`, wrapped before the app's own code runs.
 *
 * What is being counted is `gauss()` — the only caller of `Math.log` anywhere in the app
 * (`rmseFt` interpolates, `crossingHours` scans, `flagCounts` and the routing distance take a
 * square root or a cosine; none of them log) — and `gauss()` is called only from
 * `runEnsemble`. A recompute therefore cannot be silent: one run draws a value per member for
 * the threshold and one per member per forecast point, i.e. thousands of calls, against a drag
 * that must make none.
 *
 * This is instrumentation the app does not ship and does not know about, which is the point:
 * `T7`'s suite runs against the built app on purpose, where no `window.brazoscast` hook
 * exists, and shipping a counter in the production bundle for the benefit of a test would be
 * a worse trade than counting the arithmetic the app already does.
 *
 * The subject is the **text-only route**, and that choice is load-bearing. In the full app
 * MapLibre calls `Math.log` itself: measured, a 24-step drag in replay mode produced 368 draws
 * with the cache doing its job, ~15 per step of map work, which is noise next to a replay-mode
 * run's 50 draws and would force a bound loose enough to be a weak test. With no map (and no
 * MapLibre module loaded at all) the count is exact instead of statistical, so the assertion
 * can be the strong one: **zero**. The ensemble is the same code either way — it does not know
 * whether a map exists — so nothing about the claim depends on the route.
 *
 * A probe that stops working is the failure mode to worry about, so the test calibrates it in
 * the same run and in both directions: it requires the boot's own run to register thousands of
 * draws, requires the drag to register none, and then forces a recompute on purpose and
 * requires the thousands to come back. A dead probe fails the first and last of those; a
 * per-step recompute fails the middle one.
 * ---------------------------------------------------------------- */
const PROBE = "__brazosGaussDraws";

/** Install the counter before any page script runs. */
async function probe(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const w = window as unknown as Record<string, number>;
    w[key] = 0;
    const log = Math.log;
    Math.log = (x: number) => { w[key]++; return log(x); };
  }, PROBE);
}

const draws = (page: Page): Promise<number> =>
  page.evaluate((key: string) => (window as unknown as Record<string, number>)[key], PROBE);

const reset = (page: Page) =>
  page.evaluate((key: string) => { (window as unknown as Record<string, number>)[key] = 0; }, PROBE);

/** One live run of the ensemble draws a value per member for the threshold and one per member
 *  per forecast point — thousands. A floor, not an equality, because the exact number of
 *  members and forecast points is the payload's business, not this test's. */
const ONE_RUN_FLOOR = 500;

test("the drag does not recompute the ensemble", async ({ page }) => {
  test.slow();
  await probe(page);
  await stubGauge(page, { value: 30, lastObsHoursAgo: 0.25 });
  // Text-only, so the only `Math.log` in the page is the ensemble's own (see the probe above).
  await booted(page, `?text=1&addr=1600+Jackson+Street%7C2500+Holmes+Road&stage=30`);
  await expect(page.locator("#ens")).toBeVisible();
  await expect(page.locator("#hhCard")).toBeVisible();

  // Calibration 1: boot computed the ensemble at least once, and the probe saw it. This is
  // also what one run costs, which is what makes the zero below meaningful.
  const bootedDraws = await draws(page);
  console.log(`[perf] boot = ${bootedDraws} draws (one live run is thousands)`);
  expect(bootedDraws).toBeGreaterThanOrEqual(ONE_RUN_FLOOR);

  // The claim: 24 slider steps across the whole range, with the ensemble block, the answer panel
  // and the 1,614-segment counts all rendering — and not one draw. Fresh numbers on the panel
  // each step, so the drag was real work and not 24 steps against a frozen page.
  const atThirty = await text(page, "mapNote");
  await reset(page);
  await drag(page);
  const duringDrag = await draws(page);
  console.log(`[perf] ${STEPS} slider steps = ${duringDrag} draws (a recompute per step would be 24 runs)`);
  expect(await text(page, "mapNote")).not.toBe(atThirty);
  expect(duringDrag).toBe(0);

  // Calibration 2, and the other half of the claim: the cache is not a one-shot. A mode switch
  // changes the cache key, so it MUST recompute — which is what proves the zero above is the
  // cache holding rather than a probe that can no longer see anything. Switching to replay and
  // back recomputes twice, on two different series.
  await reset(page);
  await page.locator("#mReplay").click();
  await expect(page.locator("#bcCard")).toBeVisible();
  await page.locator("#mLive").click();
  // The handler is async — it awaits the gauge before rendering — so the count is only final
  // once the replay-only block is gone. Reading it at the click would race the fetch and
  // report the replay run alone, which is exactly how this assertion failed the first time.
  await expect(page.locator("#bcCard")).toBeHidden();
  const afterSwitch = await draws(page);
  console.log(`[perf] mode switch back and forth = ${afterSwitch} draws`);
  expect(afterSwitch).toBeGreaterThanOrEqual(ONE_RUN_FLOOR);
});
