/* Ask — the language model's half of the panel, and the guard on its other half.
 *
 * The split this module enforces is the point of the feature:
 *
 *   * the MODEL turns a question into a structured request (done by app/api/ask.ts), and it
 *     writes sentences AROUND a result object;
 *   * every NUMBER on screen comes from the result object, which this page computed with code
 *     that was already here — crossingHours, limitOf, robustness, the routing graph — never from
 *     the sentences.
 *
 * So the modules below are deliberately small and testable without a network: `resolveStreet`
 * matches a name against the app's own index (exact after normalisation, never a nearest guess),
 * `figuresFor` turns plain computed facts into the figure list the panel renders, and
 * `unsupportedNumbers` is the guard that withholds prose introducing a figure this page did not
 * compute. `postAsk` is the only part that talks to the endpoint, and it fails closed: no key,
 * no endpoint, an error or 8 seconds all become "unavailable", never a broken panel.
 */

export type AskIntent = "explain" | "compare" | "explore_stage" | "unsupported";

/** What the endpoint returns from step 1. Nothing in it is a number the app will show. */
export type AskRequest = {
  intent: AskIntent;
  streets: string[];
  stage_ft: number | null;
  mode: "live" | "replay" | null;
  clarify: string | null;
};

export type AskKind = "observed" | "forecast" | "modelled";

/** One rendered figure. `anchor` is the card on this page the number came from. */
export type AskFigure = {
  key: string;
  label: string;
  value: string;
  kind: AskKind;
  source: string;
  at: string;
  limitation: string;
  anchor: string;
};

export type AskAnswer = {
  street: { osmid: number; name: string; segments: number } | null;
  /** The stage the question named, when it named one; null means the question was about now. */
  hypotheticalFt: number | null;
  figures: AskFigure[];
  /** Every number the prose is allowed to contain: the ones printed in the figures. */
  numbers: number[];
  note: string;
};

/* ---------------------------------------------------------------- streets * */

/** Case, punctuation, whitespace and the handful of suffixes a resident may omit. This is
 *  normalisation, not guessing: "Jackson St." and "jackson street" are the same string here,
 *  and "Jaxon Street" is not. */
const SUFFIX: Record<string, string> = {
  street: "st", st: "st", road: "rd", rd: "rd", avenue: "ave", ave: "ave",
  drive: "dr", dr: "dr", lane: "ln", ln: "ln", boulevard: "blvd", blvd: "blvd",
  court: "ct", ct: "ct", place: "pl", pl: "pl", trail: "trl", trl: "trl",
  parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", loop: "loop",
  circle: "cir", cir: "cir", terrace: "ter", ter: "ter", way: "way", crossing: "xing",
};

export function normaliseStreet(name: string): string {
  const words = name.toLowerCase()
    .replace(/[.,'’#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    // A trailing directional ("Jackson Street North") is part of the name in this network,
    // so it is kept; only the street-type word is canonicalised.
    .map((w) => SUFFIX[w] ?? w);
  // "hwy 90a" and "highway 90a" both become "hwy 90a"; a leading "n"/"s" is a quadrant here
  // and is left alone because the index's names carry it.
  return words.join(" ");
}

/** One name in the app's own segment index, with every modelled segment it covers. */
export type StreetCandidate = { name: string; roads: number[] };

/** The one street a name resolves to, or null. Exact after normalisation: an unmatched name is
 *  refused by the caller rather than resolved to the nearest one, because a nearest guess about
 *  a street is a wrong answer about someone's house. */
export function resolveStreet(name: string, candidates: readonly StreetCandidate[]): StreetCandidate | null {
  const want = normaliseStreet(name);
  if (!want) return null;
  return candidates.find((c) => normaliseStreet(c.name) === want) ?? null;
}

/* ---------------------------------------------------------------- figures * */

/** The computed facts for one street. Every field is read off the app's existing kernels; this
 *  type exists so the figure list can be built (and tested) without a DOM or a browser. */
export type StreetFacts = {
  name: string;
  osmid: number;
  segments: number;
  /** Modelled flood stage for this segment, ft (HAND). */
  thresholdFt: number;
  /** The stage the page is showing, ft — the gauge's reading, or a value the slider was set to. */
  stageFt: number;
  /** True when the slider has been moved off the series' own last observation. */
  stageIsSlider: boolean;
  /** The last observed value in the series, ft — what the slider is compared with. */
  observedStageFt: number;
  mode: "live" | "replay";
  /** Hours until the threshold is crossed from the series' own reference, or null. */
  crossingHours: number | null;
  /** The stage the last dry way out is cut, ft (modelled), when it closes before the street. */
  isolationFt: number | null;
  /** The stage the last modelled route out is cut, ft, or null when none exists. */
  routeCutFt: number | null;
  /** Whether every measured perturbation keeps the qualitative answer. */
  survives: boolean;
  /** ISO timestamp of the observation the stage stands on. */
  observedAt: string;
  /** ISO timestamp of the end of the forecast, live only. */
  forecastTo: string | null;
  /** A stage the question hypothesised, ft — labelled as hypothetical wherever it appears. */
  hypotheticalFt: number | null;
  /** The corridor-wide measured lift and per-street sigma, for the limitation text. */
  liftFt: number;
  sigmaFt: number;
};

const when = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(t));
};

export function figuresFor(f: StreetFacts): AskAnswer {
  const figures: AskFigure[] = [];
  const replay = f.mode === "replay";
  const name = f.name;

  figures.push({
    key: "threshold",
    label: `${name} · modelled flood threshold`,
    value: `${f.thresholdFt.toFixed(1)} ft`,
    kind: "modelled",
    source: "NOAA-OWP HAND per-segment threshold",
    at: `segment ${f.osmid}` +
      (f.segments > 1 ? ` · 1 of ${f.segments} modelled segments with this name` : ""),
    limitation: `Scored against the observed 2017 extent these thresholds run about ` +
      `${Math.abs(f.liftFt).toFixed(0)} ft low with roughly ${f.sigmaFt.toFixed(0)} ft of ` +
      `spread, and the correction is deliberately not applied. A threshold is a model output, ` +
      `never an observation of water on the road.`,
    anchor: "#prov",
  });

  // The page's stage is the gauge's reading UNLESS the slider moved it, and a figure that called
  // a chosen scenario "observed" would be the exact confusion this panel is supposed to remove.
  figures.push(f.stageIsSlider
    ? {
      key: "stage",
      label: "River stage · scenario set on this page",
      value: `${f.stageFt.toFixed(2)} ft`,
      kind: "modelled",
      source: "the stage slider, compared with the river's own reading",
      at: "a stage you set, not the latest reading",
      limitation: `The slider on this page is set to ${f.stageFt.toFixed(2)} ft; the series' ` +
        `last observation is ${f.observedStageFt.toFixed(2)} ft. Everything below is computed ` +
        `against the stage you set, not against the observed river.`,
      anchor: "#stage",
    }
    : {
      key: "stage",
      label: replay ? "River stage · replayed 2017 record" : "River stage · observed",
      value: `${f.stageFt.toFixed(2)} ft`,
      kind: "observed",
      source: replay ? "USGS 08114000 · observed 2017 record" : "NOAA NWPS RMOT2 · official gauge",
      at: when(f.observedAt),
      limitation: replay
        ? "This is the 2017 record replayed, not the river today; the levels are observed, the " +
          "street result they are compared against is modelled."
        : "A gauge reading, not a road depth: the river can be below a street's threshold while " +
          "that street is impassable for other reasons.",
      anchor: "#stage",
    });

  figures.push({
    key: "crossing",
    label: replay ? `${name} · crossing in the replay` : `${name} · modelled crossing`,
    value: f.crossingHours === null
      ? "not reached inside this window"
      : `${Math.round(f.crossingHours)} h` + (replay ? " from replay start" : " from now"),
    kind: replay ? "modelled" : "forecast",
    source: replay
      ? "modelled threshold applied to the observed 2017 series"
      : "modelled threshold applied to the official NOAA forecast",
    at: replay ? "from the start of the record" : (f.forecastTo ? when(f.forecastTo) : "forecast window"),
    limitation: replay
      ? "The hours are measured from the start of the replay, not from now. Per-street timing " +
        "is not observed anywhere in this project."
      : "The forecast is NOAA's; the threshold is this project's model. Forecast uncertainty " +
        "here is taken from this project's benchmark as an assumption, not a calibration of NOAA.",
    anchor: "#answer",
  });

  if (f.isolationFt !== null) {
    figures.push({
      key: "wayout",
      label: `${name} · last dry way out`,
      value: `cut at ${f.isolationFt.toFixed(1)} ft`,
      kind: "modelled",
      source: "road-graph isolation sweep (pipeline/derive/isolation.py)",
      at: "stage on the Richmond gauge",
      limitation: "A modelled dry route exists in this network until that stage — not a " +
        "guarantee of a safe one, and a route outside the study area is not counted.",
      anchor: "#exits",
    });
  }

  if (f.routeCutFt !== null) {
    figures.push({
      key: "route",
      label: `${name} · last modelled route out`,
      value: `cut at ${f.routeCutFt.toFixed(1)} ft`,
      kind: "modelled",
      source: "road-graph routing (pipeline/derive/routing.py)",
      at: "stage on the Richmond gauge",
      limitation: "A routing result on the modelled corridor, not a report of a closed road.",
      anchor: "#exits",
    });
  }

  figures.push({
    key: "survives",
    label: `${name} · does the answer survive the measured error?`,
    value: f.survives ? "yes, the qualitative answer holds" : "no, a perturbation turns it over",
    kind: "modelled",
    source: "threshold ±1σ, corridor lift, forecast RMSE envelope",
    at: "same series, same rule",
    limitation: "The forecast error curve is this project's benchmark applied to the official " +
      "forecast as an assumption; no calibration of NOAA's uncertainty exists in this project.",
    anchor: "#robCard",
  });

  if (f.hypotheticalFt !== null) {
    const wet = f.hypotheticalFt >= f.thresholdFt;
    figures.push({
      key: "hypothetical",
      label: `${name} · at ${f.hypotheticalFt.toFixed(1)} ft (hypothetical)`,
      value: wet ? "modelled threshold crossed" : "below the modelled threshold",
      kind: "modelled",
      source: "same threshold, a stage you named",
      at: "hypothetical stage, not a forecast",
      limitation: "A hypothetical stage: the river has not been forecast to reach it here. The " +
        "comparison is a model output, not an observation.",
      anchor: "#stage",
    });
  }

  // Everything the prose may say: the numbers printed above, and nothing else. Built from the
  // rendered strings on purpose, so a sentence can only reuse what the reader can see.
  const numbers = [...new Set(figures.flatMap((g) => numbersIn(
    `${g.label} ${g.value} ${g.at} ${g.limitation} ${g.source}`)))].sort((a, b) => a - b);

  return {
    street: { osmid: f.osmid, name: f.name, segments: f.segments },
    hypotheticalFt: f.hypotheticalFt,
    figures,
    numbers,
    note: replay
      ? "Replay mode: levels are observed, street results are modelled, and hours are from the start of the record."
      : "Live mode: the stage is observed, the forecast is NOAA's, and street results are modelled.",
  };
}

/* ---------------------------------------------------------------- numbers * */

/** Numeric tokens, with thousands separators left in the string rather than invented: "1,614"
 *  reads as 1 and 614 here, which is why the prose guard is a whitelist and not a parser. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** Prose numbers that the result object does not hold. Rounded restatements of an allowed
 *  figure are allowed (`145` beside 144.7); anything else is a new number. */
export function unsupportedNumbers(prose: string, allowed: readonly number[]): number[] {
  const ok = (n: number) => allowed.some((a) =>
    Math.abs(a - n) <= 0.51 || Math.abs(a - n) <= Math.abs(a) * 0.006);
  return numbersIn(prose).filter((n) => !ok(n));
}

/* ---------------------------------------------------------------- the call * */

export type AskFailure = "unavailable" | "rate" | "timeout" | "bad-response";

export type AskResult =
  | { ok: true; request: AskRequest }
  | { ok: true; prose: string }
  | { ok: false; reason: AskFailure };

/** A few questions per minute, enforced on the client as well as the endpoint: the endpoint's
 *  limit protects the key, this one protects the reader from a retry loop of their own. */
export function rateLimiter(max = 4, windowMs = 60_000, clock: () => number = Date.now) {
  let hits: number[] = [];
  return {
    take(): boolean {
      const now = clock();
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
    get used(): number { return hits.length; },
  };
}

/** POST to the endpoint with an 8 s ceiling. Every failure mode collapses to a reason the panel
 *  can say out loud; nothing here throws into the page. */
export async function postAsk(action: "parse" | "narrate",
  payload: Record<string, unknown>, timeoutMs = 8_000): Promise<AskResult> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const r = await fetch("./api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: ctl.signal,
    });
    if (r.status === 429) return { ok: false, reason: "rate" };
    if (!r.ok) return { ok: false, reason: "unavailable" };
    const j = await r.json() as { ok?: boolean; request?: AskRequest; prose?: string };
    if (!j || j.ok !== true) return { ok: false, reason: "unavailable" };
    if (action === "parse") {
      return j.request && typeof j.request.intent === "string"
        ? { ok: true, request: j.request }
        : { ok: false, reason: "bad-response" };
    }
    return typeof j.prose === "string" && j.prose.trim()
      ? { ok: true, prose: j.prose.trim() }
      : { ok: false, reason: "bad-response" };
  } catch {
    // A non-JSON body (a static host answering 200 text/html for a missing function) throws in
    // .json(), which lands here: it must read as unavailable, never as an answer.
    return { ok: false, reason: timedOut ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
