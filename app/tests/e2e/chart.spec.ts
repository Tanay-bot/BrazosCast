import { expect, test, type Page } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * The canvas, and whether the picture says what the sentence beside it says.
 *
 * This is the README's last hand-checked item — "whether the chart the canvas draws
 * communicates its low and high ... whether the picture is legible is not a test". The sentence
 * is covered already (boot.spec and the offline spec read #chartText); the DRAWING was not,
 * because a canvas has no DOM to assert on.
 *
 * So the canvas is read the way a browser draws it: the 2D context's own calls are recorded and
 * the assertions are on the geometry they produce. A screenshot diff could only say the picture
 * CHANGED; the claim here is that it is drawn in the right PLACE, and the place is the argument
 * to moveTo/lineTo/fillText/arc.
 *
 * Two consequences worth stating, because they are what makes this a test of the chart rather
 * than a test of a copy of the chart:
 *
 *   every VALUE comes from a PIXEL. The scale is recovered from the app's own category grid —
 *      `TH` is 20/45/48/50, exact integers, each drawn as a horizontal line and labelled where it
 *      lands — so the map between a canvas y and feet of river stage is built out of what the app
 *      drew, and the same map then has to place the curve, the forecast and the street's line. No
 *      stage in this file is recomputed from the app's formulas.
 *   every EXPECTATION comes from the PAYLOAD. The stub defines the series, so its low, its crest
 *      and its forecast are known exactly, and the recorded pixels have to agree with them — and
 *      with the sentence and the card header, which are the two places a reader gets the numbers
 *      when the canvas is not there at all (?text=1).
 */

/* ------------------------------------------------------------------ reading the canvas */

type Pt = { x: number; y: number };
type Stroke = { kind: "stroke"; pts: Pt[]; dash: number[]; width: number };
type Label = { kind: "text"; text: string; x: number; y: number };
type Dot = { kind: "dot"; x: number; y: number; r: number };
type Mark = Stroke | Label | Dot;
type Frame = { w: number; h: number; marks: Mark[] };

/**
 * Record what the chart's 2D context is told to draw, in CSS pixels.
 *
 * Only the canvas whose id is `chart` is recorded: MapLibre puts canvases of its own on the page
 * (WebGL, so they never reach this prototype, but the filter keeps that a property of the test
 * rather than of the library's implementation). Coordinates are put through the context's own
 * transform on the way in, so a device pixel ratio this test did not choose cannot move a point.
 */
async function recordChart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const frames: unknown[] = [];
    (window as unknown as { __chartFrames: unknown[] }).__chartFrames = frames;
    let frame: { w: number; h: number; marks: unknown[] } | null = null;
    let path: Pt[] = [];
    let arc: { x: number; y: number; r: number } | null = null;
    let tf = [1, 0, 0, 1, 0, 0];
    const ours = (c: HTMLCanvasElement) => c instanceof HTMLCanvasElement && c.id === "chart";
    const at = (x: number, y: number) => ({
      x: tf[0] * x + tf[2] * y + tf[4], y: tf[1] * x + tf[3] * y + tf[5],
    });

    const wrap = (name: keyof CanvasRenderingContext2D,
      after: (ctx: CanvasRenderingContext2D, args: number[]) => void) => {
      const orig = proto[name] as unknown as (...a: number[]) => void;
      proto[name] = function (this: CanvasRenderingContext2D, ...args: number[]) {
        orig.apply(this, args);
        if (ours(this.canvas)) after(this, args);
      } as never;
    };

    // drawChart() clears first, so a clearRect is where a frame begins and the only place the
    // plot's own size is stated.
    wrap("clearRect", (_ctx, a) => {
      frame = { w: a[2], h: a[3], marks: [] };
      frames.push(frame);
      path = []; arc = null;
    });
    wrap("setTransform", (_ctx, a) => { tf = [a[0], a[1], a[2], a[3], a[4], a[5]]; });
    wrap("beginPath", () => { path = []; arc = null; });
    wrap("moveTo", (_ctx, a) => path.push(at(a[0], a[1])));
    wrap("lineTo", (_ctx, a) => path.push(at(a[0], a[1])));
    wrap("arc", (_ctx, a) => { arc = { x: a[0], y: a[1], r: a[2] }; });
    wrap("stroke", (ctx) => {
      if (!frame) return;
      frame.marks.push({ kind: "stroke", pts: path.slice(),
        dash: [...ctx.getLineDash()], width: ctx.lineWidth });
      path = [];
    });
    wrap("fill", (ctx) => {
      if (frame && arc) frame.marks.push({ kind: "dot", ...at(arc.x, arc.y), r: arc.r });
      path = []; arc = null;
    });
    wrap("fillText", (_ctx, a) => {
      if (frame) frame.marks.push({ kind: "text", text: String(a[0]), ...at(a[1], a[2]) });
    });
  });
}

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __chartFrames: Frame[] }).__chartFrames);

/**
 * The frame the app drew after the address resolved.
 *
 * The frame that carries a street line is preferred over simply the last one, because a mutant
 * that stops drawing that line should fail `your street's line is not drawn` in the test that
 * owns it rather than fail here as "the chart was never drawn".
 */
async function drawn(page: Page, street: string | RegExp): Promise<Frame> {
  await expect(page.locator("#addrOut")).toHaveText(street);
  for (let i = 0; i < 40; i++) {
    const all = await frames(page);
    const withStreet = all.filter((f) => f.marks.some(
      (m) => m.kind === "text" && /^your street /.test(m.text)));
    if (withStreet.length) return withStreet[withStreet.length - 1];
    if (i === 39 && all.length) return all[all.length - 1];
    await page.waitForTimeout(50);
  }
  throw new Error("the chart was never drawn");
}

const strokes = (f: Frame) => f.marks.filter((m): m is Stroke => m.kind === "stroke");
const labels = (f: Frame) => f.marks.filter((m): m is Label => m.kind === "text");
const dots = (f: Frame) => f.marks.filter((m): m is Dot => m.kind === "dot");

/**
 * The four kinds of line the frame contains, told apart by how drawChart() strokes them:
 * the series is more than two points and split by dash (observed solid, forecast dashed), while
 * the category grid and your street's threshold are two-point horizontals — dashed and solid
 * respectively.
 */
function read(f: Frame) {
  const s = strokes(f);
  return {
    observed: s.filter((x) => x.dash.length === 0 && x.pts.length > 2),
    forecast: s.filter((x) => x.dash.length > 0 && x.pts.length > 2),
    grid: s.filter((x) => x.dash.length > 0 && x.pts.length === 2),
    street: s.filter((x) => x.dash.length === 0 && x.pts.length === 2),
    labels: labels(f),
    dots: dots(f),
  };
}

const GRID_LABEL = /^(major|moderate|minor|action) (\d+(?:\.\d+)?)$/;
const AXIS_LABEL = /^(\d+)$/;

/** The left-edge stage ticks. They are ROUNDED to whole feet, which is why they are only a
 *  fallback: the map they define carries up to half a foot. */
function axisTicks(f: Frame) {
  return labels(f).filter((l) => l.x < 12 && AXIS_LABEL.test(l.text))
    .map((l) => ({ v: Number(l.text), y: l.y }))
    .sort((a, b) => a.v - b.v);
}

/**
 * The category grid, as anchors for the canvas→stage map.
 *
 * The pairing is the assertion: `drawChart` labels each reference line at `Y(value) + 3.5` and
 * draws it at `Y(value)`, so a label whose own height carries no line is a grid whose numbers do
 * not describe its lines — which is exactly the kind of thing a reader would not notice.
 */
function gridAnchors(f: Frame) {
  const out: { v: number; y: number }[] = [];
  for (const l of labels(f)) {
    const m = GRID_LABEL.exec(l.text);
    if (!m) continue;
    const on = read(f).grid.find((s) => Math.abs(s.pts[0].y - s.pts[1].y) < 0.01 &&
      Math.abs(s.pts[0].y - (l.y - 3.5)) < 1);
    expect(on, `the “${l.text}” line is labelled but no line was drawn at that height`).toBeTruthy();
    out.push({ v: Number(m[2]), y: on!.pts[0].y });
  }
  return out.sort((p, q) => p.v - q.v);
}

const between = (a: { v: number; y: number }, b: { v: number; y: number }) =>
  (y: number) => a.v + ((y - a.y) * (b.v - a.v)) / (b.y - a.y);

/**
 * Feet of river stage for a canvas y.
 *
 * Prefers the category grid, which is stated in exact whole feet, so the map is exact and the
 * tolerance can be a twentieth of a foot. Falls back to the two axis ticks, which are rounded to
 * whole feet, and says so — with that map a value is only good to about a foot.
 */
function stageMap(f: Frame): { stage: (y: number) => number; exact: boolean } {
  const grid = gridAnchors(f);
  if (grid.length >= 2) {
    return { stage: between(grid[0], grid[grid.length - 1]), exact: true };
  }
  const ticks = axisTicks(f);
  expect(ticks.length, "the chart drew neither two category lines nor two axis labels, so no " +
    "value can be read off it at all").toBeGreaterThanOrEqual(2);
  return { stage: between(ticks[0], ticks[ticks.length - 1]), exact: false };
}

/** Assert a drawn value equals a stage in feet, failing with the number that was drawn. */
function close(actual: number, expected: number, tol: number, what: string) {
  expect(Math.abs(actual - expected),
    `${what}: the canvas says ${actual.toFixed(3)} ft, expected ${expected} ft (±${tol})`)
    .toBeLessThanOrEqual(tol);
}

/* ------------------------------------------------------------------ the two rivers */

/** A river that crested 24 h ago and is forecast well above the street in the window. */
const HUMP = { value: 30, peak: 34, forecastTo: 46, historyHours: 48, forecastHours: 48 };
/** The same shape at a fifth the height, against a street that floods at 60.6 ft. */
const QUIET = { value: 11, peak: 11.5, forecastTo: 11, historyHours: 48, forecastHours: 48 };

const JACKSON = "1600 Jackson Street";
/** From the app's own address index: a street whose threshold is high enough that a quiet
 *  river has to be drawn as a small line near the bottom of a chart that still reaches it. */
const KIBLER = "10118 Kibler Road, Richmond, TX";

async function live(page: Page, addr: string, gauge: typeof HUMP): Promise<void> {
  await recordChart(page);
  await stubGauge(page, gauge);
  await booted(page, `?addr=${encodeURIComponent(addr)}`);
}

/* ------------------------------------------------------------------ the tests */

test("the canvas draws the same low and high the sentence states", async ({ page }) => {
  await live(page, JACKSON, HUMP);
  const f = await drawn(page, "Jackson Street");
  const { stage, exact } = stageMap(f);
  const tol = exact ? 0.05 : 1;
  const { observed, forecast, street } = read(f);

  expect(observed, "the observed record is not one solid line").toHaveLength(1);
  expect(forecast, "the forecast is not one dashed line").toHaveLength(1);
  expect(street, "your street's threshold is not drawn").toHaveLength(1);

  // The series the stub sent, read back off the canvas through the chart's own scale.
  const obs = observed[0].pts.map((p) => stage(p.y));
  const fc = forecast[0].pts.map((p) => stage(p.y));
  expect(observed[0].pts.length, "the observed window is no longer 36 hourly points")
    .toBe(36);
  expect(forecast[0].pts.length, "the forecast line is no longer every hour the gauge sent")
    .toBe(48);
  close(Math.min(...obs), HUMP.value, tol, "the lowest point of the observed line");
  close(Math.max(...obs), HUMP.peak!, tol, "the crest of the observed line");
  close(Math.min(...fc), HUMP.forecastTo, tol, "the flat forecast's low end");
  close(Math.max(...fc), HUMP.forecastTo, tol, "the flat forecast's high end");

  // The two places the numbers appear when the canvas does not: the sentence under it and the
  // card header above it. Both must state the same flood the picture draws.
  const sentence = await text(page, "chartText");
  const low = Number(/Lowest ([\d.]+) ft/.exec(sentence)?.[1]);
  const high = Number(/Highest ([\d.]+) ft/.exec(sentence)?.[1]);
  close(Math.min(...obs), low, 0.05, "the sentence's lowest against the drawn curve");
  close(Math.max(...fc), high, 0.05, "the sentence's highest against the drawn curve");
  expect(await text(page, "chartNote"),
    "the card header states a crest the curve does not reach")
    .toMatch(new RegExp(`^crest ${high.toFixed(2)} ft · `));

  // Nothing is drawn on top of the curve: every label anchors outside the plotted series.
  // This is the legibility half — a summary printed over the line it summarises is not one.
  const pts = [...observed[0].pts, ...forecast[0].pts];
  const box = {
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
  };
  for (const l of labels(f)) {
    const over = l.x > box.x0 + 2 && l.x < box.x1 - 2 && l.y > box.y0 + 2 && l.y < box.y1 - 2;
    expect(over, `the label “${l.text}” is drawn on top of the curve, at ${l.x},${l.y}`)
      .toBe(false);
  }
});

test("the forecast half is dashed and continues the observed half's own time axis", async ({ page }) => {
  await live(page, JACKSON, HUMP);
  const f = await drawn(page, "Jackson Street");
  const { observed, forecast } = read(f);
  expect(observed).toHaveLength(1);
  expect(forecast).toHaveLength(1);

  expect(observed[0].dash, "the observed record is drawn dashed").toHaveLength(0);
  expect(forecast[0].dash.length, "the forecast is drawn solid, so the two halves of the " +
    "series cannot be told apart").toBeGreaterThan(0);
  expect(forecast[0].width, "the forecast is drawn as a lesser line than the record")
    .toBe(observed[0].width);

  const lastObs = observed[0].pts[observed[0].pts.length - 1];
  const firstFc = forecast[0].pts[0];
  expect(firstFc.x, "the forecast is not drawn to the right of the record").toBeGreaterThan(lastObs.x);

  // One axis for both halves. The record is hourly and spans 35 h, so an hour is that many
  // pixels; the gauge's last observation is 0.25 h old and its first forecast point is 1 h
  // after it, so the dashed line must begin exactly one hour of x further right.
  const perHour = (lastObs.x - observed[0].pts[0].x) / 35;
  close((firstFc.x - lastObs.x) / perHour, 1, 0.2,
    "the hours between the end of the record and the start of the forecast");
});

test("the crossing marker sits on your street's line, at the hour the sentence names", async ({ page }) => {
  await live(page, JACKSON, HUMP);
  const f = await drawn(page, "Jackson Street");
  const { observed, forecast, street, dots: marker } = read(f);
  expect(street, "your street's threshold is not drawn").toHaveLength(1);
  expect(marker, "the forecast takes the river over this street and no crossing was marked")
    .toHaveLength(1);

  // The marker is the intersection the app is claiming: the street's own height, at the first
  // forecast point that reaches it. Both are read off the drawing, not restated from the code.
  expect(Math.abs(marker[0].y - street[0].pts[0].y),
    "the marker is not on your street's line").toBeLessThanOrEqual(0.01);
  expect(Math.abs(marker[0].x - forecast[0].pts[0].x),
    "the marker is not at the first forecast point that reaches your street")
    .toBeLessThanOrEqual(0.01);

  const sentence = await text(page, "chartText");
  const hrs = Number(/is reached by [\d.]+ ft (\d+) h from here/.exec(sentence)?.[1]);
  expect(hrs, `the sentence does not state an hour: ${sentence}`).toBeGreaterThan(0);
  const lastObs = observed[0].pts[observed[0].pts.length - 1];
  const perHour = (lastObs.x - observed[0].pts[0].x) / 35;
  close((marker[0].x - lastObs.x) / perHour, hrs, 0.6,
    "the hour the marker is drawn at against the hour the sentence states");
});

test("a quiet river still draws your street's line, at the distance the sentence states", async ({ page }) => {
  await live(page, KIBLER, QUIET);
  const f = await drawn(page, "Kibler Road");
  const { stage, exact } = stageMap(f);
  const tol = exact ? 0.05 : 1;
  const { observed, forecast, street, dots: marker } = read(f);

  const sentence = await text(page, "chartText");
  const at = Number(/is not reached by ([\d.]+) ft inside this window/.exec(sentence)?.[1]);
  expect(at, `the sentence does not say the street is unreachable: ${sentence}`).toBeGreaterThan(0);

  expect(street, "the river is 49 ft below this street and its line is not on the chart at all")
    .toHaveLength(1);
  const named = labels(f).find((l) => /^your street /.test(l.text));
  expect(named, "your street's line is drawn unlabelled, so it is a mystery line").toBeTruthy();
  close(Number(/your street ([\d.]+)/.exec(named!.text)![1]), at, 0.05,
    "the number on your street's line against the number in the sentence");
  close(stage(street[0].pts[0].y), at, tol, "the height of your street's line");

  // The whole point of the picture at a low stage: the gap between the river and the street is
  // drawn to the same scale as the river's own variation, so it can be seen and not just read.
  const drawnHigh = Math.max(...observed[0].pts.map((p) => stage(p.y)),
    ...forecast[0].pts.map((p) => stage(p.y)));
  const highest = Number(/Highest ([\d.]+) ft/.exec(sentence)?.[1]);
  close(drawnHigh, highest, tol, "the top of the drawn curve");
  close(stage(street[0].pts[0].y) - drawnHigh, at - highest, 2 * tol,
    "the gap drawn between the river and your street against the gap in feet");

  // The axis was stretched to include a street the river is nowhere near. Without that the one
  // line that carries the answer falls off the top of the chart.
  expect(Math.max(...axisTicks(f).map((t) => t.v)),
    "the axis stops below your street's threshold, so the line that matters is off the chart")
    .toBeGreaterThanOrEqual(at - 1);
  expect(marker, "a crossing was marked for a street this window never reaches").toHaveLength(0);
});
