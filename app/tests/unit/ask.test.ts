import { describe, expect, test } from "vitest";
import {
  figuresFor, normaliseStreet, numbersIn, postAsk, rateLimiter, resolveStreet,
  unsupportedNumbers,
} from "../../src/lib/ask";
import type { StreetCandidate, StreetFacts } from "../../src/lib/ask";

/* The Ask panel's kernel, held to the two claims it makes.
 *
 * The first is resolution: a street name either names a street in this model or it does not.
 * There is no nearest-neighbour step to test because there is none in the code — "Jaxon Street"
 * must fail the way "Nowhere Street" does, since a resolved-to-the-closest answer would be a
 * confident statement about someone else's address.
 *
 * The second is the number guard: the model writes prose around a computed object, and any
 * figure the object does not hold has to be caught BEFORE it is shown. That is the one claim in
 * the whole feature that a language model can violate on a good day, so it is the one with the
 * most tests.
 */

const candidates: StreetCandidate[] = [
  { name: "Jackson Street", roads: [3, 4, 5] },
  { name: "Skinner Lane", roads: [0, 1] },
  { name: "Chew Road", roads: [7] },
];

describe("Ask — a street name resolves exactly, or not at all", () => {
  test("case, punctuation and the street-type suffix are normalisation, not guessing", () => {
    expect(normaliseStreet("Jackson St.")).toBe(normaliseStreet("jackson street"));
    expect(normaliseStreet("  CHEW   RD ")).toBe("chew rd");
    for (const name of ["Jackson Street", "jackson st", "JACKSON ST.", "Jackson  Street"]) {
      expect(resolveStreet(name, candidates)?.name, name).toBe("Jackson Street");
    }
  });

  test("a street the model does not have is refused, not resolved to the nearest one", () => {
    // One letter away from a street it DOES have, which is exactly the case a fuzzy matcher
    // would answer confidently and wrongly.
    expect(resolveStreet("Jaxon Street", candidates)).toBe(null);
    expect(resolveStreet("Nowhere Street", candidates)).toBe(null);
    expect(resolveStreet("", candidates)).toBe(null);
  });

  test("the resolved street carries every modelled segment the name covers", () => {
    expect(resolveStreet("Jackson Street", candidates)?.roads).toEqual([3, 4, 5]);
  });
});

const base: StreetFacts = {
  name: "Jackson Street", osmid: 1234, segments: 12,
  thresholdFt: 36.1, stageFt: 30, stageIsSlider: false, observedStageFt: 30, mode: "live",
  crossingHours: 145.2, isolationFt: 34.2, routeCutFt: 33.9, survives: false,
  observedAt: "2026-10-18T06:00:00Z", forecastTo: "2026-10-23T06:00:00Z",
  hypotheticalFt: null, liftFt: 23.72, sigmaFt: 11.36,
};

describe("Ask — every figure comes from the computed facts, with its source", () => {
  test("the live answer carries the threshold, the observed stage and the crossing", () => {
    const a = figuresFor(base);
    const byKey = Object.fromEntries(a.figures.map((f) => [f.key, f]));
    expect(byKey.threshold.value).toBe("36.1 ft");
    expect(byKey.threshold.kind).toBe("modelled");
    expect(byKey.stage.value).toBe("30.00 ft");
    expect(byKey.stage.kind).toBe("observed");
    expect(byKey.crossing.value).toBe("145 h from now");
    expect(byKey.crossing.kind).toBe("forecast");
    // The assumption about NOAA's error is stated on the figure, not only in the docs.
    expect(byKey.crossing.limitation).toContain("assumption");
    expect(byKey.survives.value).toContain("no");
    for (const f of a.figures) {
      expect(f.source, f.key).not.toBe("");
      expect(f.limitation, f.key).not.toBe("");
      expect(f.anchor, f.key).toMatch(/^#/);
    }
  });

  test("replay says observed levels, modelled street results, and hours from the record's start", () => {
    const a = figuresFor({ ...base, mode: "replay", forecastTo: null });
    const byKey = Object.fromEntries(a.figures.map((f) => [f.key, f]));
    expect(byKey.stage.kind).toBe("observed");
    expect(byKey.stage.source).toContain("USGS");
    expect(byKey.crossing.value).toBe("145 h from replay start");
    expect(byKey.crossing.kind).toBe("modelled");
    expect(a.note).toMatch(/Replay mode/);
  });

  test("a named stage is labelled hypothetical everywhere it appears", () => {
    const a = figuresFor({ ...base, hypotheticalFt: 42 });
    const hyp = a.figures.find((f) => f.key === "hypothetical")!;
    expect(hyp.label).toContain("hypothetical");
    expect(hyp.value).toBe("modelled threshold crossed");
    expect(hyp.kind).toBe("modelled");
    expect(hyp.limitation).toContain("hypothetical");
    // ...and below the threshold it is the other answer, not a missing one.
    const dry = figuresFor({ ...base, hypotheticalFt: 20 });
    expect(dry.figures.find((f) => f.key === "hypothetical")!.value)
      .toBe("below the modelled threshold");
  });

  test("a stage moved by the slider is a scenario, never called observed", () => {
    const a = figuresFor({ ...base, stageFt: 42, stageIsSlider: true, observedStageFt: 8.6 });
    const stage = a.figures.find((f) => f.key === "stage")!;
    expect(stage.label).toContain("scenario");
    expect(stage.kind).toBe("modelled");
    expect(stage.limitation).toContain("8.60 ft");
    expect(a.numbers).toContain(8.6);
  });

  test("a street with no way-out cut reports none, rather than a zero", () => {
    const a = figuresFor({ ...base, isolationFt: null, routeCutFt: null });
    expect(a.figures.some((f) => f.key === "wayout")).toBe(false);
    expect(a.figures.some((f) => f.key === "route")).toBe(false);
    expect(a.figures.some((f) => f.key === "crossing")).toBe(true);
  });
});

describe("Ask — the prose may only reuse the numbers on screen", () => {
  const a = figuresFor(base);

  test("the allowed numbers are exactly the ones printed in the figures", () => {
    const printed = new Set(a.figures.flatMap((f) => numbersIn(`${f.label} ${f.value}`)));
    for (const n of printed) expect(a.numbers, String(n)).toContain(n);
  });

  test("prose that restates a figure is accepted, including rounded", () => {
    expect(unsupportedNumbers("Water is modelled to reach Jackson Street in about 145 h.", a.numbers))
      .toEqual([]);
    expect(unsupportedNumbers("The threshold is 36 ft on the Richmond gauge.", a.numbers)).toEqual([]);
  });

  test("a number the page did not compute is caught", () => {
    // The failure mode this exists for: a plausible-looking lead time nobody computed.
    expect(unsupportedNumbers("Water reaches it in roughly 31 hours.", a.numbers)).toEqual([31]);
    expect(unsupportedNumbers("At 47.5 ft the road is under water.", a.numbers)).toEqual([47.5]);
    // A single digit is a deliberately weak case: dates in the object's own timestamps make
    // 1–9 hard to police without a parser, so the guard is a floor and not a proof. The
    // authoritative output is the figure list, which the model never writes.
    expect(unsupportedNumbers("It is 31 h away, not 9 h.", a.numbers)).toContain(31);
    // "1,614" is read as two tokens by design: the guard is a whitelist, not a parser.
    expect(numbersIn("1,614 segments")).toEqual([1, 614]);
  });
});

describe("Ask — the panel fails closed", () => {
  test("the client limiter allows a few questions a minute and then stops", () => {
    let now = 1_000_000;
    const lim = rateLimiter(4, 60_000, () => now);
    for (let i = 0; i < 4; i++) expect(lim.take(), String(i)).toBe(true);
    expect(lim.take()).toBe(false);
    now += 60_001;
    expect(lim.take()).toBe(true);
  });

  test("an endpoint that answers with HTML reads as unavailable, never as an answer", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<!doctype html>", {
      status: 200, headers: { "content-type": "text/html" },
    })) as typeof fetch;
    try {
      const r = await postAsk("parse", { question: "When is Jackson Street cut off?" });
      expect(r).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a 503 is unavailable and a 429 is the rate limit, said differently", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
      expect(await postAsk("narrate", {})).toEqual({ ok: false, reason: "unavailable" });
      globalThis.fetch = (async () => new Response("{}", { status: 429 })) as typeof fetch;
      expect(await postAsk("narrate", {})).toEqual({ ok: false, reason: "rate" });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a request that never answers becomes a timeout at the 8 second ceiling", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_ok, fail) => {
      init.signal?.addEventListener("abort", () => fail(new Error("aborted")));
    })) as unknown as typeof fetch;
    try {
      const r = await postAsk("parse", { question: "anything" }, 20);
      expect(r).toEqual({ ok: false, reason: "timeout" });
    } finally {
      globalThis.fetch = real;
    }
  });
});
