import { expect, test } from "@playwright/test";
import { booted, stubGauge } from "./helpers";

/**
 * The states a user meets while the app is thinking, and the one thing it can show that a
 * slider cannot: the water rising.
 *
 * Three of these are about honesty rather than decoration. The rail has to exist BEFORE the
 * module runs (that is the whole point of a loading indicator) and be gone once the answer is
 * on screen, because a bar that keeps sweeping after the page has finished is a lie. The
 * header mark has to follow the same flags the sentence does. The extent chip must say bytes
 * received and never a percentage — the body reaches this code decoded and gzipped, so any
 * fraction of `content-length` would pass 100% halfway through (src/lib/stream.ts).
 *
 * The rise is the one animation here that carries information, so it is tested for what it
 * changes: the stage, the band under the roads, and the button's own state — plus the
 * reduced-motion path, which must reach the same answer in one frame.
 */

test.use({ reducedMotion: "no-preference" });

const GAUGE = { value: 29.4, peak: 31.2, forecastTo: 30.1 };

test("the rail is drawn before the module runs, and withdrawn when the answer is", async ({ page }) => {
  await stubGauge(page, GAUGE);
  // One payload file is held so the boot state is observable rather than a race.
  await page.route("**/data/road_thresholds.geojson", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  await page.goto("/app");

  // In the HTML, not created by the module: it must be visible on the first frame.
  await expect(page.locator("#bootRail")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-boot", "loading");
  // And the header says the same thing in words, with a spinner rather than a dot.
  await expect(page.locator("#srcTag")).toHaveAttribute("data-state", "wait");
  await expect(page.locator("#srcTag")).toContainText("connecting");

  // ...then both are gone, and the rail is removed rather than left at full width.
  await expect(page.locator("body")).toHaveAttribute("data-boot", "done", { timeout: 15_000 });
  await expect(page.locator("#bootRail")).toHaveCount(0);
  await expect(page.locator("#srcTag")).toHaveAttribute("data-state", "live");
});

test("the header mark follows the reading", async ({ page }) => {
  await stubGauge(page, GAUGE);
  await booted(page);
  await expect(page.locator("#srcTag")).toHaveAttribute("data-state", "live");

  // Replay is not live: a hollow mark, so a 2017 crest is never mistaken for this minute.
  await booted(page, "?mode=replay");
  await expect(page.locator("#srcTag")).toHaveAttribute("data-state", "replay");

  // An unreadable gauge falls back to replay, and the mark says so too.
  await stubGauge(page, "fail");
  await booted(page);
  await expect(page.locator("#srcTag")).toHaveAttribute("data-state", "replay");
});

test("the extent's meter says what is arriving, then what it cost", async ({ page }) => {
  await stubGauge(page, GAUGE);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/data/flood_extent.json", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/app?stage=50");
  const chip = page.locator("#floodChip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/loading extent/);
  await expect(chip.locator(".spin")).toBeVisible();

  release();
  await expect(chip).toContainText(/95 polygons/, { timeout: 15_000 });
  await expect(chip).toHaveClass(/done/);
  await expect(chip.locator(".spin")).toBeHidden();
  // The extent draws, so the meter was reporting a real request rather than a placeholder.
  await expect(page.locator("#floodNote")).toHaveAttribute("data-band", "50");

  // Never a percentage: decoded bytes against an encoded length would pass 100%.
  expect(await chip.innerText()).not.toContain("%");
});

test("the rise walks the stage up through every band and stops at the top", async ({ page }) => {
  await stubGauge(page, GAUGE);
  await booted(page, "?stage=30");
  const btn = page.locator("#playRise");
  const note = page.locator("#floodNote");
  // The bands come from the extent's metadata, so the pass can only reach the top band once
  // that has arrived. Waiting for the meter's own done state is what makes that a fact
  // rather than a hope.
  await expect(page.locator("#floodChip")).toHaveClass(/done/, { timeout: 15_000 });

  // Below flood stage nothing is drawn, which is where the pass has to start from.
  await expect(note).toHaveAttribute("data-band", "none");
  // The bands are cut at 45 / 48 / 50 / 54.74 and the pass takes a few seconds, so the
  // sequence is recorded IN THE PAGE rather than polled: a polling assertion samples from
  // outside and can step over a band it was meant to see, which is a false failure about
  // the test rather than a true one about the app. Every boundary is required, in order —
  // a missing band means the filter is not re-applied with the stage, which is the bug this
  // catches.
  const seen = await page.evaluate(async () => {
    const note = document.getElementById("floodNote")!;
    // Seeded with where the pass starts, because the observer also records a write of the
    // same value and an empty array would then begin with the starting band twice over.
    const seq: string[] = [note.dataset.band ?? ""];
    const obs = new MutationObserver(() => {
      const b = note.dataset.band ?? "";
      if (seq[seq.length - 1] !== b) seq.push(b);
    });
    obs.observe(note, { attributes: true, attributeFilter: ["data-band"] });
    document.getElementById("playRise")!.click();
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (document.getElementById("playRise")!.getAttribute("aria-pressed") === "false") {
          clearInterval(iv);
          resolve();
        }
      }, 50);
    });
    obs.disconnect();
    return seq;
  });
  expect(seen).toEqual(["none", "45", "48", "50", "54.74"]);

  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(btn).toHaveText("Play the rise");
  await expect(page.locator("#stageVal")).toHaveText("54.74");
});

test("a second press stops it where it is, and the slider outranks it", async ({ page }) => {
  await stubGauge(page, GAUGE);
  await booted(page, "?stage=30");
  const btn = page.locator("#playRise");
  const stage = page.locator("#stageVal");

  // The button is a toggle while a pass is running, and that is the state the test drives.
  await btn.click();
  await expect(btn).toHaveText("Stop");
  await page.waitForTimeout(600);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  const stopped = await stage.innerText();
  // Stopped means stopped: the number must not keep climbing after the press.
  await page.waitForTimeout(500);
  await expect(stage).toHaveText(stopped);
  expect(Number(stopped)).toBeLessThan(54.74);
  expect(Number(stopped)).toBeGreaterThan(30);

  // A hand on the slider stops a pass in flight rather than fighting it.
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await page.locator("#stage").fill("41.5");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(stage).toHaveText("41.50");
});

test("the scale marks the stages the answer changes at", async ({ page }) => {
  await stubGauge(page, GAUGE);
  await booted(page);

  const ticks = page.locator("#stageTicks i");
  await expect(ticks).toHaveCount(4);
  // Positioned from TH and the input's own range, so these are the numbers the app colours
  // by rather than a second copy of them.
  await expect(ticks.nth(3)).toHaveAttribute("data-lab", "50");
  await expect(ticks.nth(3)).toHaveAttribute("title", /major 50 ft/);
  const left = await ticks.nth(3).evaluate((el) => (el as HTMLElement).style.left);
  // 50 ft on a 5–56 ft track.
  expect(parseFloat(left)).toBeCloseTo(((50 - 5) / (56 - 5)) * 100, 1);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the rise is a jump to the top band, not an animation", async ({ page }) => {
    await stubGauge(page, GAUGE);
    await booted(page, "?stage=30");
    await expect(page.locator("#floodChip")).toHaveClass(/done/, { timeout: 15_000 });
    await page.locator("#playRise").click();

    // No waiting: the same destination, reached in one render, and the control is already
    // back to its resting state because there was nothing to stop.
    await expect(page.locator("#stageVal")).toHaveText("54.74");
    await expect(page.locator("#floodNote")).toHaveAttribute("data-band", "54.74");
    await expect(page.locator("#playRise")).toHaveAttribute("aria-pressed", "false");
  });
});
