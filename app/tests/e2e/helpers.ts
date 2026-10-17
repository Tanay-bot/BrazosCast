import { expect, type Page } from "@playwright/test";

/**
 * The gauge surfaces the app talks to, and a stub for each.
 *
 * Every test in this suite drives the app through the SAME three fetch surfaces it has in
 * production — the live gauge, the upstream gauges, and the static payload — and only the
 * first two are faked. The payload is served from the real build, so an assertion can never
 * pass against data the pipeline did not produce.
 */

export const NWPS = "**/nwps/v1/gauges/**";

/** The lid the app reads the Richmond stage from. */
export const RMOT2 = "RMOT2";
/** The two upstream gauges `gauge_redundancy.json` transfers from. */
export const UPSTREAM = ["HPDT2", "BAWT2"];

export type Stageflow = {
  /** The stage the last observation sits at — what the app takes as "now". */
  value: number;
  /** Optional hump in the observed record, so the chart has a shape to draw. */
  peak?: number;
  /** How long ago the last observation was taken. This IS the staleness the app sees. */
  lastObsHoursAgo?: number;
  historyHours?: number;
  forecastTo?: number;
  forecastHours?: number;
};

const HOUR = 3_600_000;

/**
 * A stageflow body in the shape the app parses (`observed.data[].validTime/primary`,
 * `forecast.data[].…`).
 *
 * Timestamps are built relative to `Date.now()`, which is what makes the staleness
 * regimes testable: the app decides between persistence and an upstream estimate from the
 * age of the last observation, so how old that observation is IS the test input. Freezing
 * the clock would add a moving part without changing which branch is taken.
 */
export function stageflow(opts: Stageflow): string {
  const {
    value, peak, lastObsHoursAgo = 0.25, historyHours = 48,
    forecastTo = value, forecastHours = 48,
  } = opts;
  const lastObs = Date.now() - lastObsHoursAgo * HOUR;
  const observed = [];
  for (let h = historyHours; h >= 0; h--) {
    const t = lastObs - h * HOUR;
    // A hump whose top is at the middle of the record, so "lowest" and "highest" in the
    // chart summary are two different numbers rather than a flat line's single one.
    const v = peak === undefined ? value
      : value + (peak - value) * Math.sin((Math.PI * (historyHours - h)) / historyHours);
    observed.push({ validTime: new Date(t).toISOString(), primary: Math.round(v * 100) / 100 });
  }
  const forecast = [];
  for (let h = 1; h <= forecastHours; h++) {
    forecast.push({
      validTime: new Date(lastObs + h * HOUR).toISOString(),
      primary: Math.round(forecastTo * 100) / 100,
    });
  }
  return JSON.stringify({ observed: { data: observed }, forecast: { data: forecast } });
}

/** Serve the Richmond gauge, and optionally the upstream ones. */
export async function stubGauge(
  page: Page,
  richmond: Stageflow | "fail",
  upstream: Record<string, Stageflow | "fail"> = {},
): Promise<void> {
  await page.route(NWPS, async (route) => {
    const lid = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const body = lid === RMOT2 ? richmond : upstream[lid];
    if (body === undefined || body === "fail") {
      // A gauge that cannot be read: the app must degrade, not invent a reading.
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: stageflow(body) });
  });
}

/** Boot the APP and wait until it has a source line rather than "connecting…".
 *
 *  The app lives at `/app` now; `/` is the landing page. Callers may still pass `?a=1` or
 *  `/?a=1` — the second is the shape every link in the wild has, and the landing redirects it,
 *  so normalising here keeps each test about the app rather than about that redirect (which
 *  has its own test in landing.spec.ts). */
export async function booted(page: Page, query = ""): Promise<void> {
  const q = query.replace(/^\/\?/, "?");
  const url = q === "" ? "/app" : q.startsWith("?") ? `/app${q}` : q;
  await page.goto(url);
  await expect(page.locator("#srcTag")).not.toHaveText(/connecting/i);
}

export const text = (page: Page, id: string) =>
  page.locator(`#${id}`).innerText().then((s) => s.replace(/\s+/g, " ").trim());
