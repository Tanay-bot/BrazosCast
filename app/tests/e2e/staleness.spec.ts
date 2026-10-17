import { expect, test } from "@playwright/test";
import { booted, stubGauge, text } from "./helpers";

/**
 * The four regimes a stale gauge can be in, and the sentence each one produces.
 *
 * `gauge_redundancy.json` derives the boundaries from measurement — persistence beats the
 * upstream transfer below 18 h, the transfer is used as an ANCHORED change up to 30 h, and
 * unanchored beyond — and the app implements that rule in the browser. Nothing checked it
 * until here, and the failure mode is the one this project fears most: a number presented
 * as a measurement when it is an estimate.
 *
 * The upstream stubs are FLAT series, which makes the arithmetic checkable without
 * re-implementing it: with the same upstream stage at both the lag and the lag-plus-gap,
 * the transfer's CHANGE is identically zero, so an anchored estimate must come out exactly
 * equal to the last observation.
 */

const ADDR = "?addr=1600+Jackson+Street";
const upstream = (value: number) => ({ value, historyHours: 96 });

test("under 18 h the last observation is used, and the badge stays off", async ({ page }) => {
  await stubGauge(page, { value: 29.4, lastObsHoursAgo: 6 }, {
    HPDT2: upstream(34.16), BAWT2: upstream(98.19),
  });
  await booted(page, ADDR);

  await expect(page.locator("#stageVal")).toHaveText("29.40");
  // The badge is driven by the `estimated` flag, not by the wording: persistence is a
  // measurement, so it must not be labelled as an estimate.
  await expect(page.locator("#estPill")).toBeHidden();
  const sub = await text(page, "sub");
  expect(sub).toContain("RMOT2 has not reported for 6 h — showing its last observation");
  expect(sub).not.toContain("ESTIMATED");
  expect(await text(page, "srcTag")).toMatch(/^NOAA NWPS RMOT2/);
});

test("past 18 h the estimate is anchored, and the badge says so", async ({ page }) => {
  await stubGauge(page, { value: 29.4, lastObsHoursAgo: 24 }, {
    HPDT2: upstream(34.16), BAWT2: upstream(98.19),
  });
  await booted(page, ADDR);

  await expect(page.locator("#estPill")).toBeVisible();
  const sub = await text(page, "sub");
  expect(sub).toContain("ESTIMATED from Hempstead and San Felipe");
  expect(sub).toContain("anchored on the last observation");
  // The band is quoted from the artifact rather than implied.
  expect(sub).toContain("measured band of -1.56 to +1.01 ft");
  expect(await text(page, "srcTag")).toMatch(/^ESTIMATED · NWPS Hempstead \/ San Felipe → RMOT2 \(stale 24 h\)$/);
  // Flat upstream, so the anchored change is zero and the answer must be the last reading.
  await expect(page.locator("#stageVal")).toHaveText("29.40");
});

test("past 18 h with no upstream gauge the app shows the last observation and says why", async ({ page }) => {
  await stubGauge(page, { value: 29.4, lastObsHoursAgo: 24 }, { HPDT2: "fail", BAWT2: "fail" });
  await booted(page, ADDR);

  await expect(page.locator("#stageVal")).toHaveText("29.40");
  await expect(page.locator("#estPill")).toBeHidden();
  const sub = await text(page, "sub");
  expect(sub).toContain("no upstream gauge could supply the lagged value it needs");
  expect(sub).toContain("showing the last observation");
});

test("past 30 h the estimate is unanchored, and equals the measured transfer", async ({ page, request }) => {
  // The expectation comes from the artifact the app reads, not from a second
  // implementation of the transfer in this file: the two upstream stages are set exactly
  // ON knots of the published curve, so each one maps to its paired value with no
  // interpolation involved.
  const red = await (await request.get("/data/gauge_redundancy.json")).json();
  const HPDT2_KNOT = 6, BAWT2_KNOT = 2;
  const hempstead = red.transfer.HPDT2;
  const sanFelipe = red.transfer.BAWT2;
  const expected = (hempstead.r_ft[HPDT2_KNOT] + sanFelipe.r_ft[BAWT2_KNOT]) / 2;

  await stubGauge(page, { value: 29.4, lastObsHoursAgo: 40 }, {
    HPDT2: upstream(hempstead.u_ft[HPDT2_KNOT]),
    BAWT2: upstream(sanFelipe.u_ft[BAWT2_KNOT]),
  });
  await booted(page, ADDR);

  await expect(page.locator("#estPill")).toBeVisible();
  const sub = await text(page, "sub");
  expect(sub).toContain("upstream stage shifted by the derived lag");
  expect(sub).not.toContain("anchored on the last observation");
  // Not clamped: both upstream stages are inside the fitted range, so the quoted band
  // does describe the estimate.
  expect(sub).not.toContain("clamped");
  await expect(page.locator("#stageVal")).toHaveText(expected.toFixed(2));
  // 28.16 ft is action stage: the estimate moved the category, which is the whole point.
  await expect(page.locator("#catVal")).toHaveText("Action stage");
});
