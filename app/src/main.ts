import "./tokens.css";
import "./style.css";
/* MapLibre is the heaviest thing the app ships (~232 KB gzipped of the 839 KB bundle)
 * and the `?text=1` route exists precisely so a phone on a bad connection does not
 * download it. It is therefore imported inside buildMap() — a static import here
 * would put it in the entry chunk for every visitor and make the text-only route a
 * lie. This type import is erased at build time and pulls nothing in. */
import type maplibregl from "maplibre-gl";

/* The kernels the pipeline implements a second time, in Python. They live in modules of their
 * own because "the two agree" is a claim about duplicated code and has to be checkable without
 * a browser: each module's verification grid is recomputed row by row in
 * app/tests/unit/grid-parity.test.ts, which pipeline/tests/test_grid_parity.py runs from the
 * project's one check command. main.ts reads state and draws; it does not own the arithmetic. */
import { firstForecastIndex, mulberry32, rmseFt, runEnsemble } from "./lib/ensemble";
import type { EnsembleOut, EnsembleSpec } from "./lib/ensemble";
import { flagCounts, streetLeadHours, tierOnsets } from "./lib/backcast";
import { applyTransfer, applyTransferClamped } from "./lib/transfer";
import type { Transfer } from "./lib/transfer";
import { crossCheck, valueAt } from "./lib/crosscheck";
import type { CrossVerdict, UpstreamReading } from "./lib/crosscheck";
import { cutOffAt, hospitalCutAt } from "./lib/responders";
import type { CutRow } from "./lib/responders";
import { MAX_USER_HOURS, applyUserForecast, parseForecast } from "./lib/userforecast";
import { robustness } from "./lib/robustness";
import type { RobustOut } from "./lib/robustness";
import { islandForSegment } from "./lib/islands";
import type { IslandSpec, IslandView } from "./lib/islands";
import { messagesFor } from "./lib/notify";
import type { Lang, TemplateSet } from "./lib/notify";
import type { Pt } from "./lib/series";
import { bandFor } from "./lib/flood";
import { readJsonProgress } from "./lib/stream";

/* ------------------------------------------------------------------ *
 * BrazosCast — address-first flood lead time for the lower Brazos.
 * Live stage/forecast: NOAA NWPS RMOT2. Street thresholds: OWP HAND.
 * Crest lead times: derived in-repo from historical gauge peaks.
 * ------------------------------------------------------------------ */

const TH = { action: 20, minor: 45, moderate: 48, major: 50 };
const GAUGE = { lid: "RMOT2", usgs: "08114000", lat: 29.582222, lon: -95.7575 };
const TZ = "America/Chicago";
const DATA = "./data/";
const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? "";

type ChainRow = { name: string; median_h: number; p25_h: number; p75_h: number; n: number };
type Road = {
  properties: {
    osmid: number; highway: string; name: string | null;
    flood_stage_ft: number; mainstem: boolean; levee: boolean;
    confidence: string; crossing: boolean;
    isolation_ft: number | null; isolation_gap_ft: number | null; isolation_status: string;
  };
  geometry: { type: "LineString" | "MultiLineString"; coordinates: number[][] | number[][][] };
};

/* A real destination on the modelled road network (pipeline/derive/routing.py). */
type Facility = { id: string; kind: string; name: string | null; lon: number; lat: number; snap_m: number; node: number };
type RoutingGraph = {
  coord_decimals: number; max_snap_m: number;
  nodes: number[]; edges: number[]; edge_seg: number[];
  segments: { osmid: number; ft: number; hw: string }[];
  facilities: Facility[];
  /* Where the road extract was clipped. `nodes` are the graph nodes within `band_m` of that
   * box, i.e. where a road leaves the study area — the difference between an island bounded
   * by water and one bounded by the edge of the model (F4). */
  clip?: { bbox: number[]; band_m: number; nodes: number[] };
  node_cut_ft: (number | null)[];
  node_cut_medical_ft: (number | null)[];
  segment_route_cut_ft: (number | null)[];
  segment_route_cut_medical_ft: (number | null)[];
};
/* One destination as seen from the selected street at the current stage. */
type RouteOut = { f: Facility; ok: boolean; meters: number; wet: number; deepestFt: number | null; path: number[]; edges: number[] };

/* The modelled flood extent (pipeline/derive/inundation.py, NEXT-PLAN § 5.4). Only the
 * metadata is typed here — the polygons go straight to MapLibre — because the metadata is
 * what the card is allowed to say. Every number below is measured by that script: the
 * bands it cut, the area it mapped, and the one radar image it was scored against. */
type FloodMeta = {
  bands_ft: number[];
  band_areas_km2: Record<string, number>;
  unit: string;
  provisional: boolean;
  validation: {
    observed_stage_ft: number; observed_km2: number; modelled_km2_at_that_stage: number;
    area_ratio: number; iou_at_that_stage: number; recall: number; precision: number;
    harvey_peak_ft: number; iou_at_harvey_peak: number;
  };
};

/* Gauge-failure redundancy (pipeline/derive/gauge_redundancy.py): what to report when
 * RMOT2 stops reporting. The regime boundaries and the band are MEASURED there, not
 * chosen here — the app only applies them. */
type Redundancy = {
  transfer: Record<string, Transfer>;
  validation: { regimes: { persistence_until_h: number; anchor_until_h: number; shift_beyond_h: number } };
  uncertainty: { band_ft: number[] };
};

/* Scoring of these thresholds against the observed 2017 Harvey extent
 * (pipeline/derive/harvey_validation.py). The app asserts a flood stage per street, so
 * the measurement of how wrong that number is has to be shown next to it: the
 * thresholds over-predict, and the correction they imply is stated rather than applied
 * because it is fitted to a single event. */
type Validation = {
  peak: { stage_ft: number };
  confusion_matrix: { accuracy: number; false_positive_rate: number; recall: number;
    prevalence_observed: number; prevalence_modelled: number; n: number };
  diagnosis: { auc_discrimination: number; offset_vs_observed_peak_ft: number;
    threshold_error_model: { lift_ft: number; per_street_sigma_ft: number } };
  observation: { extent_area_km2: number; hwm: { n: number } };
};

/* The Harvey backcast (pipeline/derive/backcast.py). Replay mode only, and it is the one
 * place the app's lead time can be COUNTED instead of asserted: the tier onsets and the
 * crest are observed, and the browser recomputes all of them rather than trusting the
 * artifact. What is NOT observed is per-street timing — the only street-level observation
 * in this repo is one event-maximum extent — so the block says which half is which. */
type Cm = { accuracy: number; false_positive_rate: number; recall: number };
type BackcastTier = {
  tier: string; stage_ft: number; onset_h: number | null; onset_at: string | null;
  hours_before_crest: number | null; hours_above: number; peak_above_ft: number;
};
type Backcast = {
  answer: string;
  event: { label: string;
    crest: { stage_ft: number; at: string; hours_from_start: number; note: string };
    window: { from: string; to: string; hours: number; n_points: number } };
  tiers: BackcastTier[];
  street_lead_time: { segments: number; segments_reaching_threshold: number;
    p10_h: number; median_h: number; p90_h: number; min_h: number; max_h: number; note: string;
    /* Per segment, indexed by position in road_thresholds.geojson — what I3 reads for the
     * selected street, and what the app's own recomputation is checked against. */
    per_segment_h?: (number | null)[] };
  correction_tradeoff: {
    lift_ft: number;
    flags_at_crest: { stage_ft: number; shipped: number; corrected: number; of: number };
    streets_reaching_threshold_shipped: number;
    streets_silent_in_window_after_correction: number;
    hours_of_warning_given_up: { p10: number; median: number; p90: number; n: number };
    adjudication_at_the_peak: { shipped: Cm; variants: Record<string, Cm> } | null;
    reading: string };
  verification_grid: {
    flag_counts: { stage_ft: number; shipped: number; corrected: number }[];
    tier_onsets_h: Record<string, number | null>;
    /* I3 — the per-segment rows the browser re-derives for the selected street. */
    segment_lead_h?: Record<string, number | null> };
};

/* The quiet-river record (pipeline/derive/gauge_history.py): the Richmond gauge's annual stage
 * peaks, which is what turns "stays dry" into "the gauge would need 33.4 ft; it last reached
 * that in 2024". Annual maxima only — the artifact's own limits say so, and the app repeats it
 * rather than implying a continuous record. */
type GaugeHistory = {
  site: string; lid: string; unit: string; n_peaks: number; from: string; to: string;
  highest: { at: string; ft: number };
  peaks: { at: string; ft: number }[];
  source: string;
};

/* The XGBoost baseline's measured skill (pipeline/models/forecast.py, exported by
 * pipeline/export/app_data.py). Fields are POSITIONAL arrays, so the shape is named here
 * rather than guessed: benchmark is [window, horizon, xgb_rmse, persist_rmse, xgb_kge,
 * persist_kge]; exceedance is [window, horizon, stage_ft, model, hits, misses, false_alarms,
 * pod, far, csi]; event rows are [horizon, rmse, persist_rmse, peak_pred_ft, peak_err_ft,
 * csi@each stage]. A rate is null when its denominator is empty — never 0, because
 * "nothing exceeded this stage" and "no false alarms" are different statements. */
type ModelCross = {
  source: string; question: string;
  model: { name: string; version: string; seed: number; train_end: string;
    n_features: number; train_rows: number };
  stages: [number, string][];
  windows: { id: string; from: string; to: string; role: string }[];
  fields: Record<string, string>;
  benchmark: [string, number, number, number, number | null, number | null][];
  comparison: { summary: string; per_horizon: string;
    loses: [string, number, number][]; note: string };
  exceedance: [string, number, number, string, number, number, number,
    number | null, number | null, number | null][];
  events: { label: string; from: string; to: string; peak_ft: number; peak_at: string;
    days: number;
    rows: [number, number, number, number, number, (number | null)[]][] }[];
  limits: string[];
};

/* Offline address index, built by pipeline/derive/address_index.py.
 * A house number resolves to the app's own segment POSITION, so no geocoder and
 * no API key is involved. `keys` maps a canonical street name to the app streets
 * it names; `ranges` is [streetIdx, lo, hi, segmentIdx]. */
type AddressIndex = {
  streets: { n: string; s: number[] }[];
  keys: Record<string, number[]>;
  ranges: [number, number, number, number][];
  max_distance_m: number;
};

const state: {
  roads: Road[]; address: AddressIndex | null;
  chain: (ChainRow & { lid: string })[]; series: Pt[]; current: number;
  mode: "live" | "replay"; selected: Road | null; selIdx: number; source: string;
  graph: RoutingGraph | null; routes: RouteOut[]; routeSel: RouteOut | null;
  redundancy: Redundancy | null; estimated: boolean; staleHours: number; estimateNote: string;
  validation: Validation | null;
  ensembleSpec: EnsembleSpec | null; ensemble: EnsembleOut | null; ensKey: string;
  modelCross: ModelCross | null;
  backcast: Backcast | null; bcKey: string;
  island: IslandView | null;
  household: HouseholdRow[];
  /* F7 — the compiled alert templates and the reader's language. The templates travel in
   * the payload rather than in this file: what is tested is what is shown. */
  notifications: TemplateSet | null; lang: Lang;
  /* The quiet-river record, and the three post-submission kernels' outputs. Each is cached
   * against a key that names what it depends on (see the `*Key` fields), because render() runs
   * on every stage change and none of these depends on the stage except the cut set. */
  history: GaugeHistory | null;
  cross: CrossVerdict | null; crossKey: string;
  cut: CutRow[]; cutKey: string;
  rob: RobustOut | null; robKey: string;
  /* I4 — the series with a pasted forecast in place of the gauge's, and the gauge's own series
   * kept so `Clear` restores exactly what it replaced. Never persisted: no storage, no URL. */
  baseSeries: Pt[] | null; userForecast: { points: number; note: string } | null;
} = { roads: [], address: null, chain: [], series: [], current: 0, mode: "live", selIdx: -1, selected: null,
  source: "", graph: null, routes: [], routeSel: null,
  redundancy: null, estimated: false, staleHours: 0, estimateNote: "", validation: null,
  ensembleSpec: null, ensemble: null, ensKey: "", backcast: null, bcKey: "", island: null,
  modelCross: null,
  household: [], notifications: null, lang: "en",
  history: null, cross: null, crossKey: "", cut: [], cutKey: "", rob: null, robKey: "",
  baseSeries: null, userForecast: null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function category(s: number) {
  if (s >= TH.major) return { n: "Major flooding", v: "var(--major)" };
  if (s >= TH.moderate) return { n: "Moderate flooding", v: "var(--moderate)" };
  if (s >= TH.minor) return { n: "Minor flooding", v: "var(--minor)" };
  if (s >= TH.action) return { n: "Action stage", v: "var(--action)" };
  return { n: "No flooding", v: "var(--dry)" };
}

const fmtTime = (t: number, opts: Intl.DateTimeFormatOptions = {}) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).format(new Date(t));

function centroid(r: Road): [number, number] {
  const flat: number[][] = r.geometry.type === "LineString"
    ? (r.geometry.coordinates as number[][])
    : (r.geometry.coordinates as number[][][]).flat();
  const n = flat.length || 1;
  const s = flat.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
  return [s[0] / n, s[1] / n];
}

/* ---------------- the offline copy ---------------- *
 * The first visit is the one the service worker cannot cover on its own: the page fetches
 * its payload before the worker controls it, so none of those responses pass through the
 * cache. Leaving that to the second visit would mean the storm has to arrive after a page
 * load it politely waited through — so the app hands over what this load has already paid
 * for, in two forms:
 *
 *   a URL,  which the worker copies out of the browser's own HTTP cache. `only-if-cached`
 *           means no request leaves the device at all; a file the browser will not serve
 *           from cache is skipped and picked up by the ordinary paths on the next visit.
 *   a body, for the responses the HTTP cache cannot help with. The live gauge is 468 KB,
 *           carries no validator, and answers a conditional request with the whole thing
 *           again — so for that one, the bytes already in hand are the only cheap copy.
 *
 * Fire and forget: nothing on screen waits for the cache. */
type OfflineEntry = { url: string; body?: string; type?: string };

const offlinePosted = new Set<string>();

/** Everything this page has already downloaded from this origin.
 *
 *  Read from the resource timeline rather than maintained as a list, because a list of
 *  filenames cannot name the map's chunks (content-hashed, and emitted by the bundler) and
 *  a list that silently stops matching is the failure this project keeps finding. An asset
 *  the app starts using is in here the moment it is used. Cross-origin entries — the fonts,
 *  the map tiles, the gauge — are skipped by the worker; the gauge is handed over as a body
 *  instead, because it cannot be re-read cheaply. */
function loadedHere(): OfflineEntry[] {
  return performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => u.startsWith(`${location.origin}/`))
    .map((u) => ({ url: u }));
}

function keepOfflineCopy(entries: OfflineEntry[]) {
  if (!("serviceWorker" in navigator)) return;
  // A reading is re-fetched whenever the mode changes; posting 468 KB again each time
  // would be a cost with no reader, since the worker keeps what it already has.
  const fresh = entries.filter((e) => !offlinePosted.has(e.url));
  if (!fresh.length) return;
  for (const e of fresh) offlinePosted.add(e.url);
  // `ready` resolves once the worker is active, which on the first visit is a moment after
  // the page that registered it — the same page, because the worker claims it on activate.
  void navigator.serviceWorker.ready
    .then((reg) => {
      (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: "offline-copy", entries: fresh });
    })
    .catch(() => { /* no worker: the app answers the ordinary way, as it did before F6 */ });
}

/* ---------------- data ---------------- */
async function loadStatic() {
  const [gj, chain, gph, red, val, ens, bc, addr, notify, hist, mc] = await Promise.all([
    fetch(DATA + "road_thresholds.geojson").then((r) => r.json()),
    fetch(DATA + "travel_time_subdaily.json").then((r) => r.json()),
    fetch(DATA + "routing_graph.json").then((r) => r.json()),
    fetch(DATA + "gauge_redundancy.json").then((r) => r.json()),
    fetch(DATA + "harvey_validation.json").then((r) => r.json()),
    fetch(DATA + "ensemble.json").then((r) => r.json()),
    fetch(DATA + "harvey_backcast.json").then((r) => r.json()),
    fetch(DATA + "address_index.json").then((r) => r.json()),
    fetch(DATA + "notifications.json").then((r) => r.json()),
    fetch(DATA + "gauge_history.json").then((r) => r.json()),
    fetch(DATA + "model_crosscheck.json").then((r) => r.json()),
  ]);
  // After the fetches above and not before: the hand-over copies what the browser's HTTP
  // cache already has, so the payload has to have been requested first.
  keepOfflineCopy(loadedHere());
  state.roads = gj.features as Road[];
  state.address = addr as AddressIndex;
  buildRoadIndex();
  state.graph = gph as RoutingGraph;
  state.redundancy = red as Redundancy;
  state.validation = val as Validation;
  state.ensembleSpec = ens as EnsembleSpec;
  state.backcast = bc as Backcast;
  state.notifications = notify as TemplateSet;
  state.history = hist as GaugeHistory;
  state.modelCross = mc as ModelCross;
  buildRouting();
  state.chain = Object.entries(chain.gauges as Record<string, ChainRow>)
    .map(([lid, g]) => ({ lid, ...g }))
    .sort((a, b) => a.median_h - b.median_h);
}

async function fetchLive() {
  const url = `https://api.water.noaa.gov/nwps/v1/gauges/${GAUGE.lid}/stageflow`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NWPS ${r.status}`);
  // Read as text rather than .json() so the same bytes can be handed to the cache: this
  // response has no validator, so a second fetch is the full 468 KB, not a 304.
  const raw = await r.text();
  const j = JSON.parse(raw);
  keepOfflineCopy([{ url, body: raw, type: "application/json" }]);
  const pts: Pt[] = [];
  for (const p of j.observed?.data ?? []) pts.push({ t: Date.parse(p.validTime), v: p.primary, kind: "obs" });
  for (const p of j.forecast?.data ?? []) pts.push({ t: Date.parse(p.validTime), v: p.primary, kind: "fc" });
  pts.sort((a, b) => a.t - b.t);
  state.series = pts;
  const obs = pts.filter((p) => p.kind === "obs");
  state.current = obs.length ? obs[obs.length - 1].v : 0;
  const obsEnd = obs.length ? obs[obs.length - 1].t : pts[pts.length - 1].t;
  const fcEnd = pts[pts.length - 1].t;
  state.source = `NOAA NWPS ${GAUGE.lid} · observed to ${fmtTime(obsEnd, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` +
    ` · forecast to ${fmtTime(fcEnd, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;

  // --- gauge-failure path ------------------------------------------------
  state.estimated = false;
  state.staleHours = 0;
  state.estimateNote = "";
  const gapH = (Date.now() - obsEnd) / 3_600_000;
  const red = state.redundancy;
  if (red && gapH > 2) {
    state.staleHours = gapH;
    if (gapH <= red.validation.regimes.persistence_until_h) {
      // Measured: at this staleness the last reading beats the transfer, so the
      // honest answer is the last reading with its age attached.
      state.estimateNote =
        `RMOT2 has not reported for ${gapH.toFixed(0)} h — showing its last observation. ` +
        `Upstream estimation only becomes the better estimate past ` +
        `${red.validation.regimes.persistence_until_h} h of staleness.`;
    } else {
      const est = await estimateFromUpstream(gapH, state.current);
      if (est) {
        state.current = est.stage;
        state.estimated = true;
        const [lo, hi] = red.uncertainty.band_ft;
        const clampNote = est.clamped.length
          ? ` ${est.clamped.join(" and ")} ${est.clamped.length > 1 ? "are" : "is"} below the ` +
            `range the transfer was fitted on, so the estimate is clamped to the fitted floor ` +
            `and the band quoted above does not describe it — treat it as a floor, not a value.`
          : "";
        state.estimateNote =
          `RMOT2 has not reported for ${gapH.toFixed(0)} h. This stage is ESTIMATED from ` +
          `${est.names.join(" and ")} — ${est.anchor ? "anchored on the last observation" : "upstream stage shifted by the derived lag"} — ` +
          `with a measured band of ${lo} to +${hi} ft. Treat it as approximate.${clampNote}`;
        state.source = `ESTIMATED · NWPS ${est.names.join(" / ")} → RMOT2 (stale ${gapH.toFixed(0)} h)`;
      } else {
        state.estimateNote =
          `RMOT2 has not reported for ${gapH.toFixed(0)} h and no upstream gauge could supply ` +
          `the lagged value it needs — showing the last observation.`;
      }
    }
  }
}

async function loadReplay() {
  const j = await fetch(DATA + "replay-harvey.json").then((r) => r.json());
  // Replay is the app's own fallback when the gauge cannot be read, which is exactly the
  // moment the connection is likely to be the thing that is missing. Cache it too.
  keepOfflineCopy([{ url: DATA + "replay-harvey.json" }]);
  state.series = j.points.map((p: { t: string; v: number }) => ({ t: Date.parse(p.t), v: p.v, kind: "obs" as const }));
  const peak = j.points.reduce((a: { v: number }, b: { v: number }) => (b.v > a.v ? b : a), j.points[0]);
  state.current = peak.v;
  state.source = `Replay · ${j.event} · USGS ${j.site} observed`;
}

/* ---------------- gauge-failure redundancy ---------------- */
/* UPGRADE-PLAN.md step 5 asked for the upstream gauges to stand in when RMOT2 goes
 * stale. gauge_redundancy.py measured what that is actually worth, and the answer
 * corrected the plan: below the derived crossover the LAST RICHMOND OBSERVATION is
 * closer to the truth than any upstream transfer, so persistence is used there and
 * the transfer only beyond it. The boundaries and the band come from the artifact. */

async function fetchUpstream(lid: string): Promise<{ t: number; v: number }[]> {
  const r = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow`);
  if (!r.ok) throw new Error(`NWPS ${lid} ${r.status}`);
  const j = await r.json();
  return ((j.observed?.data ?? []) as { validTime: string; primary: number }[])
    .map((p) => ({ t: Date.parse(p.validTime), v: p.primary }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

/** Estimate the current Richmond stage from the upstream gauges. Returns null when
 *  no gauge can supply the lagged value the transfer needs — in which case the app
 *  falls back to the last observation and says so, rather than inventing a number. */
async function estimateFromUpstream(gapH: number, lastObs: number) {
  const red = state.redundancy;
  if (!red) return null;
  const anchor = gapH <= red.validation.regimes.anchor_until_h;
  const now = Date.now();
  const parts: number[] = [];
  const names: string[] = [];
  const clamped: string[] = [];
  for (const [lid, t] of Object.entries(red.transfer)) {
    let s: { t: number; v: number }[];
    try { s = await fetchUpstream(lid); } catch { continue; }
    const tol = 3 * 3_600_000;
    const vNow = valueAt(s, now - t.lag_h_used * 3_600_000, tol);
    if (vNow === null) continue;
    const g = applyTransferClamped(t, vNow);
    if (anchor) {
      // the plan's method used as a CHANGE, anchored on what was really measured
      const vThen = valueAt(s, now - (t.lag_h_used + gapH) * 3_600_000, tol);
      if (vThen === null) continue;
      parts.push(lastObs + (g.v - applyTransfer(t, vThen)));
    } else {
      parts.push(g.v);
    }
    names.push(t.name);
    if (g.clamped) clamped.push(t.name);
  }
  if (!parts.length) return null;
  return { stage: parts.reduce((a, b) => a + b, 0) / parts.length, names, anchor, clamped };
}

/* ---------------- I2: two gauges, one answer ----------------
 * The kernel is ./lib/crosscheck.ts (the pipeline's own transfer, with the band it measured on
 * held-out events). What belongs here is the network and the moment: fetch what the upstream
 * gauges are reporting, compare at the lag each transfer was fitted at, and say so when they
 * disagree — the one place the app can notice that the reading it is keyed to is wrong. */
async function runCrossCheck() {
  const red = state.redundancy;
  if (!red || state.mode !== "live") {
    state.cross = null;
    state.crossKey = "";
    renderCrossCheck();
    return;
  }
  const gauges: UpstreamReading[] = [];
  await Promise.all(Object.entries(red.transfer).map(async ([lid, t]) => {
    try { gauges.push({ lid, transfer: t, series: await fetchUpstream(lid) }); }
    catch { /* a gauge that will not answer is reported as missing, never as agreement */ }
  }));
  const band = red.uncertainty.band_ft;
  state.cross = crossCheck(state.current, gauges, Date.now(), [band[0], band[1]]);
  state.crossKey = `live|${Math.round(state.current)}`;
  renderCrossCheck();
}

function renderCrossCheck() {
  const c = state.cross;
  $("xcCard").hidden = state.mode !== "live";
  if (state.mode !== "live") { $("xcBody").innerHTML = ""; return; }
  if (!c) {
    $("xcNote").textContent = "reading the upstream gauges…";
    $("xcBody").innerHTML = "";
    return;
  }
  const rows = c.rows.map((r) => {
    const div = `${r.divergenceFt >= 0 ? "+" : ""}${r.divergenceFt.toFixed(2)} ft`;
    // A clamped upstream value is outside the range the transfer was fitted on, so its
    // "divergence" is the gap between a floor value and the river — reported as such rather
    // than as a gauge disagreeing with the reading.
    return `<div class="xc-row${r.clamped || r.agrees ? "" : " bad"}">` +
      `<b>${r.name}</b><span>${r.upstreamFt!.toFixed(2)} ft at −${r.lagH} h → ` +
      `${r.estimateFt.toFixed(2)} ft here</span>` +
      `<span class="st ${r.clamped ? "warn" : r.agrees ? "ok" : "bad"}">` +
      `${r.clamped ? "out of range" : div}</span></div>`;
  }).join("");
  $("xcBody").innerHTML = rows || `<p class="muted">No upstream gauge is reporting.</p>`;
  $("xcNote").textContent = c.rows.length
    ? `${c.rows.length} upstream gauge${c.rows.length > 1 ? "s" : ""} · live reading ` +
      `${state.current.toFixed(2)} ft · ${c.inRange} inside the fitted range` +
      (c.missing.length ? ` · ${c.missing.join(", ")} silent` : "")
    : "no upstream reading";
  $("xcVerdict").textContent = c.note;
}

/* ---------------- I7: the model, held to its own record ----------------
 * The ensemble block above perturbs forecast points by an error curve, and that curve is
 * THIS model's measured RMSE (ensemble.py reads the benchmark). So the model is load-bearing
 * for a number the app already shows, and the honest thing is to put its record next to it —
 * including the part of the record that argues against using it. What the card cannot show is
 * a live model forecast: the model needs the daily stage of all seven gauges, which the
 * browser does not fetch, so it shows MEASURED SKILL and says so instead of implying a
 * prediction. Every sentence below is computed from the artifact, and the losses are read
 * from it rather than written here — a summary of a benchmark that can drop its own
 * counter-evidence is not a summary. */
const WIN_LABEL: Record<string, string> = {
  train_2013_15: "in sample", holdout_2016_17: "2016-17",
  later_2018_21: "2018-21", recent_2022_26: "2022-26",
};

function renderModelCross() {
  const mc = state.modelCross;
  const box = $("mdCard");
  if (!mc) { box.hidden = true; return; }
  box.hidden = false;

  const out = mc.windows.filter((w) => w.id !== "train_2013_15");
  const horizons = [...new Set(mc.benchmark.map((r) => r[1]))].sort((a, b) => a - b);
  const cell = (w: string, h: number) =>
    mc.benchmark.find((r) => r[0] === w && r[1] === h);

  // RMSE in feet, model / persistence. A row is flagged when the model is no better than
  // assuming today's stage, which is the finding the pipeline reports and the reason this
  // card exists at all.
  const rows = horizons.map((h) => {
    const cells = out.map((w) => {
      const r = cell(w.id, h);
      if (!r) return `<td class="na">—</td>`;
      const worse = r[2] >= r[3];
      return `<td${worse ? ' class="bad"' : ""}>${r[2].toFixed(2)}` +
        `<i>/${r[3].toFixed(2)}</i>${worse ? '<span class="flag">no better</span>' : ""}</td>`;
    }).join("");
    return `<tr><th scope="row">+${h} d</th>${cells}</tr>`;
  }).join("");
  $("mdTable").innerHTML =
    `<table><caption>${mc.question}</caption><thead><tr><th scope="col">days ahead</th>` +
    out.map((w) => `<th scope="col">${WIN_LABEL[w.id] ?? w.id}</th>`).join("") +
    `</tr></thead><tbody>${rows}</tbody></table>`;

  const train = cell("train_2013_15", 1);
  const ho = cell("holdout_2016_17", 3);
  $("mdHead").textContent = `Each cell is the model's RMSE in feet against persistence, on ` +
    `windows it was not fitted on — the published holdout (2016-17, which contains the 2016 ` +
    `flood and Harvey) and two later ones. In sample at +1 d it scores ` +
    `${train ? train[2].toFixed(2) : "?"} ft against ${train ? train[3].toFixed(2) : "?"} ft, ` +
    `which is memorising 2013-15 rather than forecasting; the holdout at +3 d is ` +
    `${ho ? ho[2].toFixed(2) : "?"} ft against persistence's ${ho ? ho[3].toFixed(2) : "?"}.`;

  // The note is the artifact's own sentence about its losses, lower-cased for a mid-sentence
  // joining there and capitalised here — it is one string in one place, not two copies that
  // could disagree.
  const note = mc.comparison.note
    ? mc.comparison.note.charAt(0).toUpperCase() + mc.comparison.note.slice(1)
    : "";
  $("mdSum").textContent = `Across every out-of-sample window and horizon: ` +
    `${mc.comparison.summary}. ${note ? note + "." : ""}`;

  // The events where the model is WORSE at the shortest lead time. Inside a flood the
  // upstream gauges are exactly what the model has, so this is where it should do best —
  // saying when it does not is the whole difference between a cross-check and a headline.
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  const when = (iso: string) => {
    const [y, m] = iso.split("-");
    return `${MONTH[Number(m) - 1]} ${y}`;
  };
  const losing = mc.events.filter((e) => e.rows.length && e.rows[0][1] > e.rows[0][2]);
  $("mdLoss").textContent = losing.length
    ? `Inside ${losing.map((e) => `the ${when(e.peak_at)} flood (peak ${e.peak_ft} ft, the model ` +
        `${e.rows[0][1].toFixed(1)} ft off against persistence's ${e.rows[0][2].toFixed(1)} at ` +
        `+1 d)`).join("; ")} the model is the worse of the two at the shortest lead time — ` +
      `which is the event where it matters most. On the other ` +
      `${mc.events.length - losing.length} floods in the record it wins.`
    : `On every one of the ${mc.events.length} floods found in the record the model beats ` +
      `persistence at +1 day.`;

  // Exceedance at the four stages the answer speaks in, in the most recent window at +3 d.
  // Counts travel with the rate, and an empty denominator is stated as such.
  const win = "recent_2022_26";
  const ex = (st: number, model: string) =>
    mc.exceedance.find((r) => r[0] === win && r[1] === 3 && r[2] === st && r[3] === model);
  $("mdStages").textContent = `At 3 days out on ${WIN_LABEL[win]}, scored against the stages ` +
    `this app answers in: ` + mc.stages.map(([st, label]) => {
      const r = ex(st, "xgboost");
      if (!r || r[9] === null) {
        return `${st} ft ${label} — no day reached it, so there is no rate to report`;
      }
      const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
      return `${st} ft ${label} CSI ${r[9].toFixed(2)} (${n(r[4], "hit", "hits")}, ` +
        `${n(r[5], "missed", "missed")}, ${n(r[6], "false alarm", "false alarms")})`;
    }).join("; ") + ".";

  const knots = state.ensembleSpec?.parameters.forecast_rmse_knots_ft;
  $("mdHint").textContent = `The uncertainty block above uses this model's error curve to ` +
    `grow its forecast spread` +
    (knots && knots.length
      ? ` (${knots.map(([d, v]: [number, number]) => `+${d} d ${v.toFixed(1)} ft`).join(", ")})`
      : "") +
    `, so a model that is no better than persistence past 3 days is exactly why that block ` +
    `reports a range instead of the model's own number.`;
}

/* ---------------- lead time ---------------- */
function crossingHours(threshold: number): number | null {
  const now = state.series.length ? state.series[state.series.length - 1].t : Date.now();
  const ref = state.mode === "live" ? Date.now() : (state.series[0]?.t ?? now);
  for (const p of state.series) {
    if (p.v >= threshold) return Math.max(0, (p.t - ref) / 3_600_000);
  }
  return null;
}

/* ---------------- what the river would have to do (F1's second half) ----------------
 * On the day the river is at 9 ft the app's answer is "your street stays dry", which is true
 * and useless. The honest version is arithmetic on a record the repo already had: the stage it
 * would take, and when that last happened. The record is annual peaks, so "last reached" means
 * the last year whose peak was at or above the stage — exact for the question asked, and the
 * artifact says so in its own limits rather than leaving the app to imply a daily series. */

function lastReached(threshold: number): { at: string; ft: number } | null {
  const h = state.history;
  if (!h) return null;
  let best: { at: string; ft: number } | null = null;
  for (const p of h.peaks) if (p.ft >= threshold && (!best || p.at > best.at)) best = p;
  return best;
}

/** The sentence for a street the forecast never reaches. `leads` is the isolation case: the
 *  number that matters to a household is the one that cuts them off, not the one that floods
 *  the road, and the two are different stages for 230 segments. */
function quietLine(at: number, leads: boolean): string {
  const h = state.history;
  const need = leads
    ? `It would take ${at.toFixed(1)} ft at the gauge to cut your last dry way out.`
    : `This street floods at ${at.toFixed(1)} ft.`;
  if (!h) return `${need} The gauge's peak record did not load, so how often it has been that high is not shown.`;
  const hit = lastReached(at);
  const hi = `${h.highest.ft.toFixed(1)} ft in ${h.highest.at.slice(0, 4)}`;
  if (!hit) {
    return `${need} The gauge has not reached that in the whole record (${h.from.slice(0, 4)}–` +
      `${h.to.slice(0, 4)}, ${h.n_peaks} annual peaks, highest ${hi}).`;
  }
  const age = new Date().getUTCFullYear() - Number(hit.at.slice(0, 4));
  return `${need} It last reached that in ${hit.at.slice(0, 4)} (${hit.ft.toFixed(1)} ft, ` +
    `${age} year${age === 1 ? "" : "s"} ago); the record's highest is ${hi}. ` +
    `Annual peaks only, at ${h.lid}.`;
}
/* ---------------- uncertainty ensemble ---------------- */
/* The algorithm is ./lib/ensemble.ts, where the pipeline's verification grid can be recomputed
 * against it. What is decided HERE is what belongs to the app rather than to the arithmetic: the
 * instant the reported hours are measured from, and where the observation stops and the
 * forecast begins. */
function seriesRef(): number {
  return state.mode === "replay" ? (state.series[0]?.t ?? Date.now()) : Date.now();
}

function seriesWindow(): Pt[] {
  if (state.mode === "replay") return state.series;
  const now = Date.now();
  const from = now - 36 * 3_600_000;
  return state.series.filter((p) => p.t >= from);
}

/* ---------------- selection ---------------- */
/* Index-based, because the routing graph addresses road segments by their position
 * in road_thresholds.geojson, and that index is what ties a click to a route. */

/* Distances are measured to the segment GEOMETRY, not to its centroid.
 * The centroid rule was measurably wrong, and the measurement is what changed it:
 * of 899 county address ranges attached to a segment within 50 m, only 79.6%
 * named the same street a map click returned, and EVERY disagreement sat at
 * sub-metre to ~26 m snap distance — the address was essentially ON the street
 * the click got wrong. The cause is that a long segment's centroid can sit far
 * from a point that lies on the segment itself, so a click 0.5 m from Pultar
 * Road returned Rocky Falls Road, and 0.2 m from North 2nd Street returned
 * South 2nd Street. Vertices are flattened once so a click is a linear scan. */
/** Every segment's flood stage, in segment order: the population flagCounts() scans (see the
 *  Harvey backcast section). Built once with the other per-segment arrays, not per render. */
let roadThresholds: number[] = [];

let roadVertStart = new Int32Array(1);
let roadX = new Float64Array(0);
let roadY = new Float64Array(0);

function buildRoadIndex() {
  roadThresholds = state.roads.map((r) => r.properties.flood_stage_ft);
  const counts: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of state.roads) {
    const flat: number[][] = r.geometry.type === "LineString"
      ? (r.geometry.coordinates as number[][])
      : (r.geometry.coordinates as number[][][]).flat();
    counts.push(flat.length);
    for (const c of flat) { xs.push(c[0]); ys.push(c[1]); }
  }
  roadVertStart = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) roadVertStart[i + 1] = roadVertStart[i] + counts[i];
  roadX = Float64Array.from(xs);
  roadY = Float64Array.from(ys);
}

function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

function nearestRoadIndex(lon: number, lat: number): number {
  // Longitude degrees are shorter than latitude degrees at this latitude; scale
  // them so the comparison is not biased along the axis the corridor runs down.
  const k = Math.cos((lat * Math.PI) / 180);
  const px = lon * k;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < state.roads.length; i++) {
    const s = roadVertStart[i], e = roadVertStart[i + 1];
    let minD = Infinity;
    for (let j = s; j + 1 < e; j++) {
      const d = segDistSq(px, lat, roadX[j] * k, roadY[j], roadX[j + 1] * k, roadY[j + 1]);
      if (d < minD) minD = d;
    }
    // A single-vertex segment has no edge to measure against.
    if (minD === Infinity && e > s) minD = (roadX[s] * k - px) ** 2 + (roadY[s] - lat) ** 2;
    if (minD < bestD) { bestD = minD; best = i; }
  }
  return best;
}

/* ---------------- address resolution ----------------
 * Tiered, and every tier that cannot answer says why instead of guessing:
 *   1. house number + street  -> the exact segment (via the offline index)
 *   2. street name alone      -> the segment that floods first, disclosed
 *   3. typo (edit distance 2) -> a suggestion, and the address that works
 *   4. Mapbox, only if a token is configured (last resort, demoted)
 *   5. click the map
 * A street the app does not model is REFUSED. It is not snapped to the nearest
 * modelled street, because that answers a different household's question.
 */

/* Must match TOKEN_MAP in pipeline/derive/address_index.py, because the index's
 * keys were produced by that side. */
const STREET_TOKENS: Record<string, string> = {
  RD: "ROAD", ST: "STREET", AVE: "AVENUE", AV: "AVENUE", DR: "DRIVE",
  BLVD: "BOULEVARD", LN: "LANE", HWY: "HIGHWAY", PKWY: "PARKWAY", CT: "COURT",
  CIR: "CIRCLE", PL: "PLACE", TRL: "TRAIL", TER: "TERRACE", FWY: "FREEWAY",
  EXPY: "EXPRESSWAY", N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST",
  NE: "NORTHEAST", NW: "NORTHWEST", SE: "SOUTHEAST", SW: "SOUTHWEST",
  RM: "RANCH ROAD", RR: "RANCH ROAD", FM: "FARM TO MARKET", IH: "INTERSTATE",
  SH: "STATE HIGHWAY", US: "US",
};

function canonicalStreet(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((t) => STREET_TOKENS[t] ?? t)
    .join(" ");
}

function parseAddress(text: string): { num: number | null; key: string } {
  let s = text.trim();
  // A city/state/ZIP tail is not part of the street name. Everything after the
  // first comma is dropped, which covers what people actually paste.
  s = s.replace(/\s*,?\s*\b(TX|TEXAS)\b.*$/i, " ");
  s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, " ");
  const head = s.split(",")[0];
  const m = head.match(/^\s*(\d+)\s+(.*)$/);
  if (m) return { num: Number(m[1]), key: canonicalStreet(m[2]) };
  return { num: null, key: canonicalStreet(head) };
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/* A concrete address on a street, so a refusal can offer something that works
 * rather than only naming a street. */
function sampleAddress(si: number): string | null {
  const idx = state.address;
  if (!idx) return null;
  const e = idx.ranges.find((r) => r[0] === si);
  if (!e) return null;
  return `${e[1]} ${idx.streets[si].n}`;
}

function streetSpans(si: number): string {
  const idx = state.address;
  if (!idx) return "";
  const e = idx.ranges.filter((r) => r[0] === si);
  if (!e.length) return "";
  const lo = Math.min(...e.map((x) => x[1]));
  const hi = Math.max(...e.map((x) => x[2]));
  return `${lo.toLocaleString()}-${hi.toLocaleString()}`;
}

/* The threshold a segment would need to start warning, i.e. how early it goes. */
function thresholdOf(i: number): number {
  return state.roads[i]?.properties.flood_stage_ft ?? Infinity;
}

function say(msg: string) { $("askHint").textContent = msg; }

/* A failed lookup must not leave the PREVIOUS street's answer on screen: the
 * card would show one household's flood result while the hint says no street was
 * found, which is the kind of mixed message this app exists to avoid. */
function clearSelection() {
  state.selected = null;
  state.selIdx = -1;
  state.routes = [];
  state.routeSel = null;
  render();
}

/* ---------------- shareable state ----------------
 * An answer nobody can forward stops at one screen. The address, the stage and the
 * mode all live in the URL, so a link restores exactly the view it was copied from —
 * including in Harvey replay, which is the one mode that shows a flood.
 *
 * Unknown parameters are preserved rather than rewritten away, so a parameter this
 * version does not know about still round-trips (the planned ?text=1 keeps working
 * once it exists) instead of being silently stripped by a link.
 *
 * The URL is kept current with replaceState, never pushed. Pushing from render() —
 * which every state change goes through — would leave two identical history entries
 * per address change, so back would step to the same page. Deliberately no history:
 * the link is how an answer travels, not the back button.
 */
/* The incoming link, captured ONCE at boot. It cannot be re-read later: boot renders
 * before the URL has been applied, and that render would write the not-yet-restored
 * state back over the parameters it is about to consume — which silently deleted
 * ?addr and ?stage from every shared replay link until this was fixed. */
type UrlState = { addr: string | null; stage: number | null; mode: "live" | "replay" | null; text: boolean; lang: Lang };
let pendingUrl: UrlState | null = null;

/* `?text=1` — the low-bandwidth route. Read at boot before anything else, because the
 * whole point is not to fetch the map, and a decision made after the import has started
 * is not a decision. See applyTextMode(). */
const TEXT_PARAM = "text";
let textOnly = false;

/* The share confirmation is only true of the URL it was made for. The refusal path
 * prints that URL as the fallback, so leaving it up after the view moves would tell
 * the user to copy a link to the previous answer. Reset it whenever the URL changes. */
const SHARE_NOTE_AT_REST = "the address, stage and mode travel in the link";

/* What the link carries: the household, led by whichever row is on screen. Matching by
 * canonical street rather than by the typed text is what keeps a clicked road from being added
 * to the household a second time when it is already one of its addresses. */
function urlAddresses(): string[] {
  const selName = state.selected?.properties.name ?? "";
  const selKey = selName ? canonicalStreet(selName) : "";
  const rows = state.household;
  const lead = selKey
    ? rows.find((r) => r.si !== null && parseAddress(r.query).key === selKey)
    : undefined;
  const ordered = lead ? [lead, ...rows.filter((r) => r !== lead)] : rows;
  const out = ordered.map((r) => r.query);
  // Nothing in the household describes what is on screen — a road clicked on the map, or an
  // address whose street is not modelled — so the screen still leads rather than the link
  // opening on a different household member's street.
  return selName && !lead ? [selName, ...out] : out;
}

function stageRange(): { min: number; max: number } {
  const el = $("stage") as unknown as HTMLInputElement;
  return { min: Number(el.min || 5), max: Number(el.max || 56) };
}

function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  const { min, max } = stageRange();
  const raw = Number(p.get("stage"));
  const stage = p.get("stage") !== null && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, raw))
    : null;
  const mode = p.get("mode");
  return {
    addr: (p.get("addr") ?? "").trim() || null,
    stage,
    mode: mode === "replay" ? "replay" : mode === "live" ? "live" : null,
    text: p.get(TEXT_PARAM) === "1",
    // F7 — the alert language travels in the link, because a Spanish-speaking household
    // is the one most likely to send this answer to someone else.
    lang: p.get("lang") === "es" ? "es" : "en",
  };
}

/* The other view's link, built from the SAME parameters, so switching modes keeps the
 * street, the stage and the data mode. A plain link on purpose: it survives a refresh,
 * it can be middle-clicked, and it needs no handler to be correct. */
function viewHref(p: URLSearchParams, toText: boolean): string {
  const q = new URLSearchParams(p);
  if (toText) q.set(TEXT_PARAM, "1"); else q.delete(TEXT_PARAM);
  const qs = q.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}`;
}

/* What text mode removes is PIXELS, not information: the basemap and the canvas go, and
 * the numbers they drew stay as sentences. The flood count and the hydrograph summary
 * are rendered by render() in both modes — this only chooses which of them is visible. */
function applyTextMode() {
  document.body.classList.toggle("text-only", textOnly);
  const a = $("viewToggle") as unknown as HTMLAnchorElement;
  a.textContent = textOnly ? "Full view" : "Text-only";
  a.setAttribute("aria-label", textOnly
    ? "Switch to the full view, with the map and the chart"
    : "Switch to the text-only view: no map, no chart, far less to download");
}

function syncUrl() {
  // Until the incoming link has been applied, the app must not describe itself: it
  // does not yet hold the state the URL is asking for.
  if (pendingUrl) return;
  const p = new URLSearchParams(location.search);
  // The household first, led by the row that is on screen. The old rule — carry the typed text
  // only when it describes the street on screen — is now the LEAD rule: the row that matches the
  // screen goes first, the rest of the household follows, and nothing is dropped just because the
  // user clicked a different road. With no rows at all the street itself leads, so a link copied
  // after a map click still opens on the street the answer was about.
  const addrs = urlAddresses();
  if (addrs.length) p.set("addr", addrs.join("|")); else p.delete("addr");
  p.set("stage", state.current.toFixed(1));
  if (state.mode === "replay") p.set("mode", "replay"); else p.delete("mode");
  // The view travels with the link: a link to the light version must not arrive heavy.
  if (textOnly) p.set(TEXT_PARAM, "1"); else p.delete(TEXT_PARAM);
  if (state.lang === "es") p.set("lang", "es"); else p.delete("lang");
  ($("viewToggle") as unknown as HTMLAnchorElement).href = viewHref(p, !textOnly);
  const qs = p.toString();
  const before = location.href;
  history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  if (location.href !== before) $("shareNote").textContent = SHARE_NOTE_AT_REST;
}

async function applyUrl() {
  const u = pendingUrl;
  if (!u) return;
  // From here the URL is the app's to write.
  pendingUrl = null;
  if (u.mode === "replay" && state.mode !== "replay") await setMode("replay");
  else if (u.mode === "live" && state.mode !== "live") await setMode("live");
  if (u.stage !== null) {
    state.current = u.stage;
    render();
  }
  if (u.addr) {
    ($("addr") as HTMLInputElement).value = u.addr;
    // Through the household path even for one address: a link carrying three has to restore all
    // three, and one code path for both is one place for the ranking to be right.
    await checkAddresses(u.addr);
  }
  // Guarantees the URL is written once even when the link carried nothing to
  // restore, so the address bar always describes the view on screen.
  render();
}

/* One lookup, two callers. The household card (F3) has to resolve several addresses and rank
 * them, and the old shape of this function could only answer one: it wrote its answer straight
 * to the screen and mutated the selection. So the RULES moved into `locate()`, which is pure
 * and returns a result, and the screen-writing became `applyLocated()`. A second copy of the
 * tiers — house number, street alone, typo, refusal — is the failure this project keeps
 * finding, and it would have been a second copy of the refusal messages too. */
type Located =
  | { ok: true; si: number; note: string }
  /* `mapbox`: only a street the index has NEVER HEARD OF is worth sending to a geocoder. A
   * known street whose house number is outside the county's ranges is a different failure, and
   * answering it with a geocoder's nearest road would replace a correct refusal with a
   * confidently wrong street — which is the failure mode this whole tiering exists to avoid. */
  | { ok: false; why: string; suggest: boolean; clear: boolean; mapbox: boolean };

function located(query: string): Located {
  const idx = state.address;
  const { num, key } = parseAddress(query);
  if (!key) return { ok: false, why: "Type an address or a street name, or click a road on the map.", suggest: false, clear: false, mapbox: false };
  if (!idx) return { ok: false, why: "The address index did not load, so only road names work. Click the map.", suggest: false, clear: false, mapbox: false };

  let candidates = idx.keys[key];
  if (!candidates && num === null) {
    // A bare street name that missed exactly may still be one token off.
    const close = Object.keys(idx.keys).filter((k) => editDistance(k, key) <= 2);
    if (close.length) candidates = close.flatMap((k) => idx.keys[k]);
  }

  if (!candidates) {
    const close = Object.keys(idx.keys)
      .map((k) => ({ k, d: editDistance(k, key) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    if (close.length) {
      const opts = close.map((c) => {
        const si = idx.keys[c.k][0];
        const real = sampleAddress(si);
        return real ? `${idx.streets[si].n} (e.g. ${real})` : idx.streets[si].n;
      });
      return { ok: false, clear: true, suggest: true, mapbox: false,
        why: `No street “${key}” in the Richmond dataset. Did you mean: ${opts.join("; ")}?` };
    }
    return { ok: false, clear: true, suggest: false, mapbox: true,
      why: `No street “${key}” in the Richmond dataset — this app models the Brazos ` +
        `corridor, not every road in Fort Bend County. Try a street from the list, ` +
        `or click a road on the map.` };
  }

  const cand = idx.ranges.filter((r) => candidates!.includes(r[0]));
  if (!cand.length) {
    // The street is modelled but the county files no house numbers on it, so a
    // number cannot be placed. Answer with the segment that floods first rather
    // than inventing a location.
    const si = candidates[0];
    const segs = idx.streets[si].s;
    const best = segs.reduce((a, b) => (thresholdOf(b) < thresholdOf(a) ? b : a), segs[0]);
    return { ok: true, si: best,
      note: `${idx.streets[si].n} is modelled but has no county house numbers, so this ` +
        `is the segment that floods first. Click the map for a specific stretch.` };
  }

  if (num === null) {
    const segs = [...new Set(cand.map((c) => c[3]))];
    const best = segs.reduce((a, b) => (thresholdOf(b) < thresholdOf(a) ? b : a), segs[0]);
    const si = cand.find((c) => c[3] === best)![0];
    return { ok: true, si: best,
      note: `${idx.streets[si].n} has ${segs.length} modelled segments; showing the one ` +
        `that floods first. Add a house number for the segment nearest you.` };
  }

  const hits = cand.filter((c) => c[1] <= num && num <= c[2]);
  if (hits.length) {
    // Several ranges can contain the number when a street is split across
    // segments; the tightest one is the most specific statement about it.
    hits.sort((a, b) => (a[2] - a[1]) - (b[2] - b[1]) || a[3] - b[3]);
    const [si, lo, hi, seg] = hits[0];
    return { ok: true, si: seg,
      note: `Read as ${num} ${idx.streets[si].n} (county address range ${lo}-${hi}).` };
  }

  // The number is outside every range the county files for this street, which
  // usually means a typo or an address that does not exist. Name the real ones.
  const near = [...cand]
    .sort((a, b) => Math.min(Math.abs(num - a[1]), Math.abs(num - a[2])) -
      Math.min(Math.abs(num - b[1]), Math.abs(num - b[2])))
    .slice(0, 3);
  const si = near[0][0];
  const spans = streetSpans(si);
  const examples = near.map((e) => `${Math.min(e[1], e[2])}`).slice(0, 3);
  return { ok: false, clear: true, suggest: false, mapbox: false,
    why: `${num} ${idx.streets[si].n} is outside the county's addressed range ` +
      `(${spans}). Nearest listed: ${examples.join(", ")}. Check the number, or click the map.` };
}

/* ---------------- the household ---------------- */
/* F3. One address answers one household's question; home, school and a parent's house is how a
 * family actually plans, and they are not the same answer. The rows are the addresses the user
 * asked about, the card ranks them by when each one is reached, and the row on screen is the one
 * the answer above is about.
 *
 * `|` and `;` separate addresses, because a comma is part of the address people paste (the
 * "Richmond, TX" tail is stripped by parseAddress). Newlines work too, which is what a pasted
 * column of addresses arrives as. */
const HH_MAX = 6;

type HouseholdRow = { query: string; si: number | null; label: string; why: string };

function splitAddresses(text: string): string[] {
  const parts = text.split(/[|;\n]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = canonicalStreet(parseAddress(p).key) || p.toUpperCase();
    if (seen.has(key)) continue;      // the same address twice is one row, not two
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Resolve every address in the box, rank them, and make the first one that placed the answer. */
async function checkAddresses(text: string) {
  const queries = splitAddresses(text).slice(0, HH_MAX);
  if (!queries.length) {
    state.household = [];
    clearSelection();
    return say("Type an address or a street name, or click a road on the map.");
  }
  const rows: HouseholdRow[] = queries.map((q) => {
    const found = located(q);
    return found.ok
      ? { query: q, si: found.si, label: state.roads[found.si]?.properties.name ?? q, why: found.note }
      : { query: q, si: null, label: q, why: found.why };
  });
  state.household = rows;
  ($("addr") as HTMLInputElement).value = queries.join(" | ");

  const first = rows.find((r) => r.si !== null);
  if (first) {
    setSelected(first.si as number);
    const failed = rows.filter((r) => r.si === null).length;
    const extra = rows.length > 1
      ? ` ${rows.length} addresses ranked below, soonest first.` : "";
    const miss = failed ? ` ${failed} of ${rows.length} could not be placed.` : "";
    say(`${first.why}${extra}${miss}`);
  } else {
    // Nothing placed. The rows still carry their own reasons, and the first one is said aloud —
    // after Mapbox has had its one chance, and only for a street the index never heard of.
    const found = located(queries[0]);
    if (!found.ok && found.mapbox && MAPBOX_TOKEN) {
      // Mapbox is the last resort and needs a token; the offline index is the primary path
      // and works with no key and no network.
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(queries[0])}.json` +
        `?access_token=${MAPBOX_TOKEN}&proximity=${GAUGE.lon},${GAUGE.lat}&limit=1`;
      const j = await fetch(url).then((r) => r.json());
      const c = j.features?.[0]?.center;
      if (c) {
        const si = nearestRoadIndex(c[0], c[1]);
        rows[0] = { ...rows[0], si, label: state.roads[si]?.properties.name ?? queries[0] };
        setSelected(si);
        return;
      }
    }
    clearSelection();
    say(rows[0].why);
  }
}

/** The stage the answer is about, and which of the two thresholds it is: the earlier of the
 *  street's own flood stage and the stage at which its last dry way out is cut (isolation.py).
 *  One implementation, because the household card ranks rows by exactly the number the headline
 *  shows for the selected one — two copies of this rule would let a row and its own answer
 *  disagree. */
function limitOf(r: Road): { limit: number; cut: boolean } {
  const at = r.properties.flood_stage_ft;
  const iso = r.properties.isolation_ft;
  const cut = iso !== null && iso < at - 0.05;
  return { limit: cut ? (iso as number) : at, cut };
}

function setSelected(i: number) {
  state.selIdx = i;
  state.selected = state.roads[i];
  const [lon, lat] = centroid(state.roads[i]);
  map?.flyTo({ center: [lon, lat], zoom: 14, duration: 700 });
  render();
}

/* ---------------- map ---------------- */
let map: maplibregl.Map | null = null;

/* Fetched once and kept, rather than held only on the MapLibre source: the basemap fallback
 * replaces the whole style, which drops the source, and the extent has to be handed back to
 * the new style without a second 500 KB request. Null means "not loaded yet", which draws
 * nothing rather than guessing. */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the geometry is handed to
 * MapLibre unread, and maplibre's GeoJSON type does not describe the sibling `meta` member. */
let floodData: FloodData | null = null;
let floodMeta: FloodMeta | null = null;
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The extent as it ships: a FeatureCollection plus the metadata the card reads. The
 *  metadata is a sibling member rather than foreign members on the collection, which is
 *  what the pipeline writes and what the contract test asserts. */
type FloodData = GeoJSON.FeatureCollection & { meta: FloodMeta };

/* The extent's own meter, in the map's corner.
 *
 * The map route is the only part of the app that downloads something big enough to need
 * one: 450 KB of polygons, 90.5 KB over the wire. Saying so while it arrives is not
 * decoration — the layer appears under the roads, and without a mark the page looks like
 * it has finished when it has not. The figure is bytes RECEIVED, never a percentage: the
 * body is decoded before it reaches this function and `content-length` describes the
 * gzipped bytes, so a percentage would pass 100% halfway through (lib/stream.ts). */
function floodChip(state: "load" | "done" | "fail", text: string) {
  const chip = document.getElementById("floodChip");
  const label = document.getElementById("floodChipText");
  if (!chip || !label) return;
  chip.hidden = false;
  chip.classList.toggle("done", state === "done");
  chip.classList.toggle("fail", state === "fail");
  if (label.textContent !== text) label.textContent = text;
}

async function loadFlood() {
  floodChip("load", "loading extent");
  try {
    const res = await fetch(DATA + "flood_extent.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const f = await readJsonProgress<FloodData>(res, (p) => {
      // Rounded to the kilobyte, and only rewritten when the figure moves: a DOM write per
      // chunk would be thousands of writes for one line of text.
      if (p.bytes >= 1000) floodChip("load", `loading extent \u00b7 ${Math.round(p.bytes / 1000)} KB`);
    });
    if (!f?.meta) throw new Error("no meta");
    floodData = f;
    floodMeta = f.meta;
    if (map?.getSource("flood")) {
      (map.getSource("flood") as maplibregl.GeoJSONSource).setData(f);
    }
    syncMap();
    renderFloodNote();
    // The transfer size, not the decoded size: what the reader actually paid for. Some
    // servers send the body chunked with no content-length, so the resource timeline is
    // the second source — and if neither states a size, it is left out rather than guessed.
    const timed = performance.getEntriesByName(res.url, "resource").at(-1) as
      PerformanceResourceTiming | undefined;
    const wire = Number(res.headers.get("content-length")) || timed?.encodedBodySize || 0;
    // Named after the layer rather than left as a bare count: at a stage below flood stage
    // nothing is drawn, and "95 polygons" on its own would read as water that is not there.
    floodChip("done", `HAND extent \u00b7 ${f.features.length} polygons${wire ? ` \u00b7 ${Math.round(wire / 1000)} KB` : ""}`);
  } catch {
    // A missing extent must not take the map with it: the roads are the answer, the water
    // is context, and the chip says which one is missing.
    floodChip("fail", "extent unavailable");
  }
}

/** The filter that selects ONE band. `band === -1` matches nothing, which is what the
 * layers start on: a first frame that drew an arbitrary band would be water at a stage
 * nobody asked for. */
function bandFilter(band: number): maplibregl.FilterSpecification {
  return ["==", ["get", "stage_ft"], band] as unknown as maplibregl.FilterSpecification;
}

/* The basemap. OpenFreeMap serves a keyless vector style — no account, no card, no request
 * limit, commercial use allowed. OSM's own raster tiles are permitted for ordinary
 * human-driven viewing but are best-effort with no SLA, so they are kept as the FALLBACK
 * rather than the source: this page should not be waiting on a tile server with no promises
 * behind an answer about a river.
 *
 * The fallback is load-bearing, not decoration. A style URL is a third-party request, and if
 * it fails the road layer would sit on an empty canvas — which is exactly what a map with no
 * basemap looks like. */
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const BASEMAP_FALLBACK: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

async function buildMap() {
  // Lazy, and the guard is the feature: in text mode this function is never called, so
  // MapLibre and its stylesheet are never requested.
  if (textOnly) return;
  const [mod] = await Promise.all([
    import("maplibre-gl"),
    import("maplibre-gl/dist/maplibre-gl.css"),
  ]);
  // The only moment the map's own chunk and stylesheet are known to be loaded, and the only
  // place they can be discovered at all: their filenames are content hashes emitted by the
  // bundler, so neither a list here nor the worker could name them.
  keepOfflineCopy(loadedHere());
  const maplibregl = mod.default;
  if (textOnly) return;    // the toggle navigates, but a race must not build the map anyway

  /* The extent is fetched here, not in loadStatic: the text-only route never calls this
   * function, and that route's whole claim is that it downloads neither the map nor its
   * data. The fetch runs alongside the style request rather than before it. */
  void loadFlood();

  map = new maplibregl.Map({
    container: "map",
    style: BASEMAP_STYLE,
    /* Each style states its own attribution — the vector style names OpenFreeMap,
     * OpenMapTiles and OSM; the raster fallback names OSM. A custom attribution here would
     * print OSM twice on the vector path and lie about the fallback. */
    attributionControl: { compact: true },
    center: [GAUGE.lon, GAUGE.lat],
    zoom: 12,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  /* Layers are installed from `style.load` rather than `load`, because the raster fallback
   * below replaces the style after the map has already loaded — and `load` fires once.
   * Installing a second time is a no-op rather than a duplicate-source error. */
  const installLayers = () => {
    if (!map) return;
    if (map.getSource("roads")) { syncMap(); updateRouteLine(); return; }
    /* FIRST, so the water sits UNDER the roads: the roads are the answer and the extent is
     * the context. The bands are nested, so the filter names exactly one of them (the
     * nearest at or below the stage) and the source is uploaded once. */
    map!.addSource("flood", { type: "geojson", data: floodData ?? EMPTY_FC });
    map!.addLayer({
      id: "flood-extent", type: "fill", source: "flood", filter: bandFilter(-1),
      paint: { "fill-color": "#1a6d93", "fill-opacity": 0.26 },
    });
    map!.addLayer({
      id: "flood-edge", type: "line", source: "flood", filter: bandFilter(-1),
      paint: { "line-color": "#1a6d93", "line-width": 1, "line-opacity": 0.5 },
    });
    map.addSource("roads", { type: "geojson", data: "./data/road_thresholds.geojson" });
    map!.addLayer({
      id: "roads-pass", type: "line", source: "roads",
      filter: [">", ["get", "flood_stage_ft"], state.current],
      paint: { "line-color": "#2e7d5b", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 2.4], "line-opacity": 0.85 },
    });
    map!.addLayer({
      id: "roads-flood", type: "line", source: "roads",
      filter: ["<=", ["get", "flood_stage_ft"], state.current],
      paint: { "line-color": "#a01b2b", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.4, 16, 3.6] },
    });
    map!.addLayer({
      id: "roads-levee", type: "line", source: "roads",
      filter: ["==", ["get", "levee"], true],
      paint: { "line-color": "#6b4fa0", "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": 0.9 },
    });
    /* F4 — the island's boundary. Not the island itself: its extent is reported as a count,
     * because the layers below hold their data and a several-hundred-segment island would
     * have to re-upload its geometry on every slider step, which is what T8's budget exists
     * to prevent. What is drawn is the CUT — the flooded segments that lead off this island
     * — which is the smaller set and the one the question is about. */
    map!.addSource("island", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map!.addLayer({
      id: "island-edge", type: "line", source: "island",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#f0a12a", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2.6, 16, 5],
               "line-dasharray": [2.4, 1.4], "line-opacity": 0.95 },
    });
    map!.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map!.addLayer({
      id: "route-casing", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 },
    });
    map!.addLayer({
      id: "route-line", type: "line", source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#10261d", "line-width": 3 },
    });
    syncMap();
    updateRouteLine();   // a selection made before the style was ready still gets its line
  };

  /* One fallback, once. A style error and the timeout race each other; whichever arrives
   * first wins, and the other becomes a no-op. */
  let fellBack = false;
  let styleReady = false;
  const useFallback = (why: string) => {
    if (fellBack || styleReady) return;
    fellBack = true;
    console.warn(`basemap: ${why}; falling back to OSM raster tiles`);
    map!.setStyle(BASEMAP_FALLBACK);
  };
  const styleTimer = setTimeout(() => useFallback("the vector style did not load in 8 s"), 8000);
  map.on("style.load", () => {
    styleReady = true;
    clearTimeout(styleTimer);
    installLayers();
  });
  map.on("error", (e) => {
    // Style and glyph failures arrive here. A tile error AFTER the style is up is not a
    // reason to discard the basemap, so the guard is "the style never arrived".
    if (!styleReady) useFallback(e.error?.message ?? "the vector style failed to load");
  });
  map.on("click", (e) => {
    // Select the road segment the click landed on, by index, so the routing graph
    // can be indexed by the same position the pipeline used.
    setSelected(nearestRoadIndex(e.lngLat.lng, e.lngLat.lat));
  });
}

function syncMap() {
  if (!map || !map.getLayer("roads-flood")) return;
  map.setFilter("roads-flood", ["<=", ["get", "flood_stage_ft"], state.current]);
  map.setFilter("roads-pass", [">", ["get", "flood_stage_ft"], state.current]);
  syncFlood();
}

/** The band whose extent is drawn at this stage: the nearest at or BELOW it.
 *
 * Bands are cut at flood (45), moderate (48), major (50) and Harvey's peak, and they are
 * nested, so drawing the band below the stage under-states the water by at most one band's
 * worth of rise and never invents water the stage has not reached. Above the top band
 * (replay's crest is 55.01 ft, the top band 54.74) the top band stays drawn.
 */
function floodBand(stage: number): number | null {
  return bandFor(stage, floodMeta?.bands_ft ?? []);
}

function syncFlood() {
  if (!map || !map.getLayer("flood-extent")) return;
  const f = bandFilter(floodBand(state.current) ?? -1);
  map.setFilter("flood-extent", f);
  map.setFilter("flood-edge", f);
}

/** What the extent is, in the card under the map — including what it got wrong.
 *
 * The number this must not hide is the score: at the one stage anyone has observed, the
 * model maps more than twice the water the radar saw. A layer labelled "flood extent" with
 * no such sentence would be the app asserting something it cannot defend, which is the one
 * thing this project's voice is built not to do. */
function renderFloodNote() {
  const el = document.getElementById("floodNote");
  if (!el) return;
  const band = floodBand(state.current);
  const v = floodMeta?.validation;
  el.dataset.band = band === null ? "none" : String(band);
  if (!floodMeta || !v) { el.textContent = ""; return; }
  if (band === null) {
    el.textContent = `No extent is drawn below the flood stage (${TH.minor} ft): the water is ` +
      `in the channel, and the roads above already say what that means.`;
    return;
  }
  const km2 = floodMeta.band_areas_km2?.[String(band)];
  el.textContent =
    `HAND extent at ${band} ft: ${km2 ? `${km2} km²` : "—"}, an upper bound. ` +
    `Scored against the one 2016 radar image at ${v.observed_stage_ft.toFixed(1)} ft it maps ` +
    `${v.area_ratio.toFixed(1)}× the water it shows (IoU ${v.iou_at_that_stage.toFixed(2)}), ` +
    `and Harvey's crest scores ${v.iou_at_harvey_peak.toFixed(2)} against that same image.`;
}

/* ---------------- play the rise ---------------- *
 * The stage slider answers "what happens at this number". It cannot answer the question
 * the extent exists for, which is what the water DOES between numbers — so this walks the
 * stage from where it is to the top mapped band, and the bands, the flooded segments and
 * the routes recompute on the way. It is the same render() the slider drives; nothing here
 * computes a second truth.
 *
 * Held to ~20 fps on purpose. render() re-routes to every facility and re-partitions the
 * graph, which is what makes a stage change mean something and is far more than a frame's
 * worth of work: at 60 fps the animation would spend its budget on answers too fast to read.
 */
let riseRaf = 0;

function riseButton(): HTMLButtonElement | null {
  return document.getElementById("playRise") as HTMLButtonElement | null;
}

function stopRise() {
  if (riseRaf) cancelAnimationFrame(riseRaf);
  riseRaf = 0;
  const b = riseButton();
  if (!b) return;
  b.setAttribute("aria-pressed", "false");
  b.textContent = "Play the rise";
}

function playRise() {
  // A second press is the stop button. The control is a toggle, not a one-way trigger.
  if (riseRaf) { stopRise(); render(); return; }
  const bands = floodMeta?.bands_ft ?? [];
  const top = bands.length ? Math.max(...bands) : TH.major;
  const flood = Math.min(TH.minor, top);
  // At or above the top band there is nowhere to rise TO, so the pass starts at flood
  // stage — the first stage at which the extent draws anything at all.
  const from = state.current >= top - 0.005 ? flood : state.current;
  const to = top;
  if (!(to > from)) return;

  const b = riseButton();
  b?.setAttribute("aria-pressed", "true");
  if (b) b.textContent = "Stop";

  // The rise is information, not decoration, so reduced motion gets the destination rather
  // than nothing: one render at the top band.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    state.current = to; render(); stopRise(); return;
  }

  state.current = from;
  const ms = Math.min(4200, Math.max(1100, (to - from) * 380));
  const t0 = performance.now();
  let last = 0;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    // Smoothstep: ease out of the current stage and into the crest instead of starting and
    // stopping at full speed, which reads as a jump cut rather than a river.
    const e = k * k * (3 - 2 * k);
    state.current = from + (to - from) * e;
    if (now - last >= 45 || k === 1) { render(); last = now; }
    if (k < 1) {
      riseRaf = requestAnimationFrame(step);
    } else {
      riseRaf = 0;
      stopRise();
      render();
    }
  };
  riseRaf = requestAnimationFrame(step);
}

/** The three stages at which the app's own answer changes, drawn on the slider's track.
 *
 * Positions are computed from TH and the input's own min/max, so changing a threshold moves
 * its mark; a hard-coded percentage would be a second, silently ageing copy of the numbers.
 * The 9 px inset matches the thumb radius, without which every mark sits left of the stage
 * it names. */
function layoutTicks() {
  const box = document.getElementById("stageTicks");
  if (!box) return;
  const { min, max } = stageRange();
  const marks: [string, number][] = [
    ["action", TH.action], ["flood", TH.minor], ["moderate", TH.moderate], ["major", TH.major],
  ];
  box.replaceChildren(...marks.map(([name, ft]) => {
    const i = document.createElement("i");
    i.style.left = `${((ft - min) / (max - min)) * 100}%`;
    i.dataset.lab = String(ft);
    i.title = `${name} ${ft} ft`;
    return i;
  }));
}

/* ---------------- routing ---------------- *
 * The topology, the node coordinates and the per-segment cut stage all come from
 * pipeline/derive/routing.py, which built them with isolation.build() — the same
 * graph the isolation number is computed on. Nothing here re-derives the road
 * network, so the two panels cannot describe different roads.
 *
 * The routing rule is the one UPGRADE-PLAN.md step 4 asks for: a flooded edge is
 * WEIGHTED, not deleted. Cost = metres + PENALTY per flooded edge, so a route that
 * avoids water always beats one that crosses it, however long — but when every
 * route crosses water the search still returns the best one, and the answer is
 * "every way out crosses water, the shallowest crossing floods at X ft" rather
 * than nothing at all.
 */
const PENALTY = 1e6;

let nodeX = new Float64Array(0);
let nodeY = new Float64Array(0);
let adjStart = new Int32Array(1);
let adjTo = new Int32Array(0);
let adjEdge = new Int32Array(0);
let edgeA = new Int32Array(0);
let edgeB = new Int32Array(0);
let edgeFt = new Float64Array(0);
let edgeLenM = new Float64Array(0);
let maxIncidentFt = new Map<number, number>();
let segNodes: number[][] = [];
let facilityNodes: number[] = [];
/* The same graph, described for ./lib/islands.ts, which is a separate module because the
 * partition it computes is a claim about duplicated code and has to be checkable without a
 * browser: app/tests/unit/islands.test.ts recomputes the pipeline's whole ladder from it. */
let islandSpec: IslandSpec | null = null;

function haversineM(ax: number, ay: number, bx: number, by: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dp = (by - ay) * r, dl = (bx - ax) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(ay * r) * Math.cos(by * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Binary min-heap of (key, value) pairs. Lazy deletion: a stale entry is skipped
 *  by the caller comparing its key against the current best. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  lastKey = 0;
  get size() { return this.k.length; }
  push(key: number, val: number) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(p, i); i = p;
    }
  }
  pop(): number {
    const last = this.k.length - 1;
    const out = this.v[0];
    this.lastKey = this.k[0];
    this.k[0] = this.k[last]; this.v[0] = this.v[last];
    this.k.pop(); this.v.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < last && this.k[l] < this.k[m]) m = l;
      if (r < last && this.k[r] < this.k[m]) m = r;
      if (m === i) break;
      this.swap(m, i); i = m;
    }
    return out;
  }
  private swap(a: number, b: number) {
    const kk = this.k[a]; this.k[a] = this.k[b]; this.k[b] = kk;
    const vv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = vv;
  }
}

function buildRouting() {
  const g = state.graph!;
  const n = g.nodes.length / 2;
  const s = 10 ** g.coord_decimals;
  nodeX = new Float64Array(n); nodeY = new Float64Array(n);
  for (let i = 0; i < n; i++) { nodeX[i] = g.nodes[2 * i] / s; nodeY[i] = g.nodes[2 * i + 1] / s; }

  const E = g.edges.length / 3;
  edgeA = new Int32Array(E); edgeB = new Int32Array(E);
  edgeFt = new Float64Array(E); edgeLenM = new Float64Array(E);
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < E; e++) {
    const a = g.edges[3 * e], b = g.edges[3 * e + 1];
    edgeA[e] = a; edgeB[e] = b;
    edgeFt[e] = g.segments[g.edge_seg[e]].ft;
    edgeLenM[e] = haversineM(nodeX[a], nodeY[a], nodeX[b], nodeY[b]);
    deg[a]++; deg[b]++;
  }
  adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  adjTo = new Int32Array(2 * E); adjEdge = new Int32Array(2 * E);
  const cur = adjStart.slice(0, n);
  for (let e = 0; e < E; e++) {
    adjTo[cur[edgeA[e]]] = edgeB[e]; adjEdge[cur[edgeA[e]]++] = e;
    adjTo[cur[edgeB[e]]] = edgeA[e]; adjEdge[cur[edgeB[e]]++] = e;
  }

  segNodes = g.segments.map(() => []);
  for (let e = 0; e < E; e++) {
    const list = segNodes[g.edge_seg[e]];
    if (!list.includes(edgeA[e])) list.push(edgeA[e]);
    if (!list.includes(edgeB[e])) list.push(edgeB[e]);
  }
  facilityNodes = g.facilities.map((f) => f.node);
  maxIncidentFt = new Map();
  for (let e = 0; e < E; e++) {
    maxIncidentFt.set(edgeA[e], Math.max(maxIncidentFt.get(edgeA[e]) ?? 0, edgeFt[e]));
    maxIncidentFt.set(edgeB[e], Math.max(maxIncidentFt.get(edgeB[e]) ?? 0, edgeFt[e]));
  }
  islandSpec = {
    nodeCount: n, edgeA, edgeB, edgeFt, thresholds: roadThresholds, segNodes, facilityNodes,
    // Absent in a graph exported before F4: the island still computes, and simply cannot say
    // whether its edge is water or the study area's boundary. `?? []` rather than a throw,
    // because a stale payload must not take the answer down with it.
    clipNodes: g.clip?.nodes ?? [],
  };
  parityCheck();
}

/** Multi-source Dijkstra, cost = metres + PENALTY per edge already under water. */
function dijkstra(sources: number[], stage: number, origin?: Int32Array) {
  const n = nodeX.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevEdge = new Int32Array(n).fill(-1);
  const h = new Heap();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (dist[s] === 0) continue;
    dist[s] = 0;
    if (origin) origin[s] = i;
    h.push(0, s);
  }
  while (h.size) {
    const u = h.pop();
    const d = h.lastKey;
    if (d > dist[u]) continue;              // stale heap entry
    for (let p = adjStart[u]; p < adjStart[u + 1]; p++) {
      const e = adjEdge[p], v = adjTo[p];
      const nd = d + edgeLenM[e] + (edgeFt[e] <= stage ? PENALTY : 0);
      if (nd < dist[v]) {
        dist[v] = nd; prevEdge[v] = e;
        if (origin) origin[v] = origin[u];
        h.push(nd, v);
      }
    }
  }
  return { dist, prevEdge };
}

/** Widest path (max-min bottleneck) to a target set — the stage at which the best
 *  route is finally cut. This is what the pipeline exports as node_cut_ft;
 *  parityCheck() compares the two independent implementations.
 *
 *  Seeded FROM the target set, not from the query nodes: a query node initialised
 *  to Infinity would report an uncut route no matter what lies between it and the
 *  destination, which is exactly the wrong answer and is how the first version of
 *  this function failed parity with the pipeline. */
function widestTo(targets: Set<number>): Float64Array {
  const n = nodeX.length;
  const cap = new Float64Array(n).fill(-1);
  const h = new Heap();
  for (const t of targets) { cap[t] = Infinity; h.push(-Infinity, t); }
  while (h.size) {
    const u = h.pop();
    const c = -h.lastKey;
    if (c < cap[u]) continue;
    for (let p = adjStart[u]; p < adjStart[u + 1]; p++) {
      const e = adjEdge[p], v = adjTo[p];
      const nc = Math.min(c, edgeFt[e]);
      if (nc > cap[v]) { cap[v] = nc; h.push(-nc, v); }
    }
  }
  for (const t of targets) cap[t] = maxIncidentFt.get(t) ?? 0;
  return cap;
}

function pathOf(prevEdge: Int32Array, target: number) {
  const nodes: number[] = [target];
  const edges: number[] = [];
  let u = target, guard = 0;
  while (prevEdge[u] !== -1 && guard++ < 100000) {
    const e = prevEdge[u];
    edges.push(e);
    u = edgeA[e] === u ? edgeB[e] : edgeA[e];
    nodes.push(u);
  }
  return { nodes: nodes.reverse(), edges: edges.reverse() };
}

/** Everything the "Ways out" panel needs, for the current selection and stage. */
function computeRoutes(stage: number) {
  const g = state.graph!;
  const i = state.selIdx;
  state.routes = [];
  state.routeSel = null;
  if (!g || i < 0) return;

  const src = segNodes[i] ?? [];
  if (!src.length) return;
  const { dist, prevEdge } = dijkstra(src, stage);

  const seen = new Set<number>();
  const routes: RouteOut[] = [];
  for (const f of g.facilities) {
    const d = dist[f.node];
    if (!Number.isFinite(d) || seen.has(f.node)) continue;
    seen.add(f.node);
    const { nodes, edges } = pathOf(prevEdge, f.node);
    let wet = 0, deepest: number | null = null;
    for (const e of edges) {
      if (edgeFt[e] <= stage) { wet++; deepest = deepest === null ? edgeFt[e] : Math.min(deepest, edgeFt[e]); }
    }
    routes.push({ f, ok: wet === 0, meters: d - wet * PENALTY, wet, deepestFt: deepest, path: nodes, edges });
  }
  routes.sort((a, b) => a.meters + a.wet * PENALTY - (b.meters + b.wet * PENALTY));
  state.routes = routes;
  state.routeSel = routes[0] ?? null;
}

/** "Can help get in to me" — the same search run outward from the responders
 *  instead of inward from the street. The road graph is undirected, so the path is
 *  the same physical one as the forward route; the queries differ in framing, not
 *  in geometry, and this is the direction that answers whether an ambulance can
 *  reach you when you cannot drive out. */
function reverseBest(stage: number) {
  const g = state.graph!;
  const src = segNodes[state.selIdx] ?? [];
  if (!g || !src.length) return null;
  const origin = new Int32Array(nodeX.length).fill(-1);
  const { dist } = dijkstra(facilityNodes, stage, origin);
  let best: { f: Facility; meters: number; wet: number } | null = null;
  for (const u of src) {
    const d = dist[u];
    if (!Number.isFinite(d)) continue;
    const wet = Math.floor(d / PENALTY);
    if (!best || d < best.meters + best.wet * PENALTY) {
      const idx = origin[u];
      best = { f: g.facilities[idx] ?? g.facilities[0], meters: d - wet * PENALTY, wet };
    }
  }
  return best;
}

/** Cross-language gate. The pipeline computes the cut stage with a descending
 *  union-find pass; this recomputes it with a max-min Dijkstra from the same
 *  exported graph. If the two disagree, the graph the app routes on is not the
 *  graph the numbers were computed on and the panel would be quietly wrong. */
function parityCheck() {
  const g = state.graph!;
  const targets = new Set(facilityNodes);
  const idxs = g.segment_route_cut_ft
    .map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  const step = Math.max(1, Math.floor(idxs.length / 30));
  let checked = 0, bad = 0, worst = 0;
  for (let i = 0; i < idxs.length; i += step) {
    const seg = idxs[i];
    const nodes = segNodes[seg] ?? [];
    if (!nodes.length) continue;
    const cap = widestTo(targets);
    const mine = nodes.reduce((m, u) => Math.max(m, cap[u]), -1);
    const theirs = g.segment_route_cut_ft[seg]!;
    checked++;
    const diff = Math.abs(mine - theirs);
    if (diff > 0.15) bad++;
    worst = Math.max(worst, diff);
  }
  const msg = `[routing] parity vs pipeline: ${checked} segments, ${bad} mismatches, ` +
    `max |diff| ${worst.toFixed(3)} ft`;
  if (bad) console.error(msg); else console.info(msg);
}

/* ---------------- islands ---------------- *
 * F4, and the answer to a question the routing panel cannot ask: not "can I reach a
 * destination" but "which roads are still one connected place with mine". The partition is
 * computed in ./lib/islands.ts — the pipeline's own sweep, recomputed against its published
 * ladder in app/tests/unit/islands.test.ts — and what is decided HERE is only how to say it.
 *
 * The numbers are deliberately concrete rather than reassuring. Measured, the road extract is
 * already 116 separate networks at 0 ft and only 806 of 1,614 segments are on a fragment that
 * holds a responder, so a street with no hospital on its island has usually met the edge of the
 * study area rather than a wall of water — which is why `touchesClip` is said out loud instead
 * of being left out of the sentence. */
function islandSentence(v: IslandView, stage: number): string {
  const total = state.roads.length;
  if (v.island < 0) return "This segment is not on the modelled road graph, so it has no island.";
  // Three states, not two, and the third is why this is written out rather than templated: an
  // island with no drivable segment left cannot be described by its size. Measured, in replay at
  // 40 ft: a street whose own segment the local fire station sits on reported "0 of 1,614
  // segments … a fire or police station is on it", which is true of the graph (the station's node
  // is there) and false of the road (its doorstep is under water). So the empty island says what
  // it is, and the responder clause is dropped rather than asserted over it.
  const head = v.segments === 0
    ? (v.dry
        ? "every road connected to this street is under water"
        : `water is over this street at ${stage.toFixed(2)} ft, and every road connected to it is under water`)
    : v.dry
      ? `${v.segments} of the corridor's ${total} segments are still reachable from this street without crossing water`
      : `water is over this street at ${stage.toFixed(2)} ft, so nothing is drivable from it; the larger of the two islands its flooded segment joins holds ${v.segments} of the corridor's ${total} segments`;
  let out = `Your island: ${head}.`;
  if (v.segments > 0) {
    out += v.responder
      ? " A hospital, fire or police station is on it."
      : ` No modelled responder is on it${v.crossingSegs.length
          ? `, and every way off it crosses water: ${v.crossingSegs.length} flooded segments form its edge, the last of which closed at ${(v.lastCrossingFt as number).toFixed(1)} ft`
          : ""}.`;
  }
  if (v.touchesClip) {
    out += " It also reaches the edge of the study area, where a road continues outside what is modelled — so this island is what the extract covers, not a wall of water.";
  }
  return out;
}

/** One union-find pass over the 8,970 edges per stage step, so this is cheap enough to run
 *  inside the drag; measured against the budget it was added to, see T8. */
function computeIsland(stage: number) {
  const note = $("islandNote");
  if (!islandSpec || state.selIdx < 0) {
    state.island = null;
    note.hidden = true;
    note.textContent = "";
  } else {
    state.island = islandForSegment(islandSpec, stage, state.selIdx);
    note.hidden = false;
    note.textContent = islandSentence(state.island, stage);
  }
  updateIslandLine();
}

/** Draw the island's edge. The geometries are the road features already in memory, so this
 *  hands MapLibre references rather than rebuilt coordinates. */
function updateIslandLine() {
  if (!map || !map.getSource("island")) return;
  const v = state.island;
  const features = v
    ? v.crossingSegs.map((s) => ({ type: "Feature", properties: {},
        geometry: state.roads[s].geometry }))
    : [];
  (map.getSource("island") as maplibregl.GeoJSONSource)
    .setData({ type: "FeatureCollection", features } as never);
}

/** Draw the chosen route. The coordinates come from the exported graph nodes, so
 *  the line lies exactly on the graph the cut stage was computed from. */
function updateRouteLine() {
  if (!map || !map.getSource("route")) return;
  const r = state.routeSel;
  const features = r && r.path.length > 1
    ? [{ type: "Feature", properties: { wet: r.wet },
         geometry: { type: "LineString", coordinates: r.path.map((u) => [nodeX[u], nodeY[u]]) } }]
    : [];
  (map.getSource("route") as maplibregl.GeoJSONSource)
    .setData({ type: "FeatureCollection", features } as never);
}

/* ---------------- chart ---------------- */
function drawChart() {
  const cv = $("chart") as unknown as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 900;
  const h = 300;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const pts = seriesWindow();
  if (!pts.length) return;
  const css = getComputedStyle(document.documentElement);
  const c = (n: string, f: string) => css.getPropertyValue(n).trim() || f;

  const L = 46, R = 104, T = 14, B = 34;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vals = pts.map((p) => p.v).concat([state.selected?.properties.flood_stage_ft ?? TH.action]);
  const y0 = Math.max(0, Math.min(...vals) - 2), y1 = Math.max(...vals) + 2;
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const Y = (v: number) => T + ((y1 - v) / (y1 - y0 || 1)) * (h - T - B);

  g.font = "10.5px 'IBM Plex Mono', monospace";
  for (const [key, val, col] of [["major", TH.major, "--major"], ["moderate", TH.moderate, "--moderate"],
    ["minor", TH.minor, "--minor"], ["action", TH.action, "--action"]] as [string, number, string][]) {
    if (val < y0 || val > y1) continue;
    g.strokeStyle = c(col, "#999"); g.setLineDash([5, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, Y(val)); g.lineTo(w - R, Y(val)); g.stroke();
    g.setLineDash([]); g.fillStyle = c(col, "#999");
    g.fillText(`${key} ${val}`, w - R + 6, Y(val) + 3.5);
  }
  // user's street
  if (state.selected) {
    const at = state.selected.properties.flood_stage_ft;
    if (at >= y0 && at <= y1) {
      g.strokeStyle = c("--fg", "#000"); g.lineWidth = 2;
      g.beginPath(); g.moveTo(L, Y(at)); g.lineTo(w - R, Y(at)); g.stroke();
      g.fillStyle = c("--fg", "#000"); g.font = "600 10.5px 'IBM Plex Mono', monospace";
      g.fillText(`your street ${at}`, w - R + 6, Y(at) + 3.5);
    }
  }
  // axis
  g.fillStyle = c("--fg-faint", "#888"); g.font = "10.5px 'IBM Plex Mono', monospace";
  g.fillText(String(Math.round(y0)), 6, Y(y0));
  g.fillText(String(Math.round(y1)), 6, Y(y1));
  const midT = (t0 + t1) / 2;
  g.fillText(fmtTime(midT, { month: "short", day: "numeric" }), X(midT) - 20, h - 12);

  const draw = (sel: (p: Pt) => boolean, dash: number[], col: string, width: number) => {
    g.strokeStyle = col; g.lineWidth = width; g.setLineDash(dash);
    g.beginPath();
    let started = false;
    for (const p of pts) {
      if (!sel(p)) { started = false; continue; }
      const x = X(p.t), y = Y(p.v);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke(); g.setLineDash([]);
  };
  draw((p) => p.kind === "obs", [], c("--fg", "#000"), 2.4);
  draw((p) => p.kind === "fc", [7, 5], c("--water", "#1a6d93"), 2.4);

  // crossing marker
  if (state.selected) {
    const hrs = crossingHours(state.selected.properties.flood_stage_ft);
    if (hrs !== null) {
      const target = (state.mode === "replay" ? state.series[0].t : Date.now()) + hrs * 3_600_000;
      g.fillStyle = c("--major", "#8f1d2e");
      g.beginPath(); g.arc(X(target), Y(state.selected.properties.flood_stage_ft), 5.5, 0, 7); g.fill();
    }
  }
}

/* The canvas is this series drawn; this is the same series said. It is set in both
 * modes (in the full view it labels the curve), and in text mode it is the whole chart:
 * the window, the low, the crest with the time it happened, and where the gauge is now.
 * Nothing here is recomputed from a different source than drawChart() reads. */
function renderChartText() {
  const el = $("chartText");
  const pts = seriesWindow();
  if (!pts.length) { el.textContent = "No stage series is loaded."; return; }
  const lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
  const hi = pts.reduce((a, b) => (b.v > a.v ? b : a));
  const when = (t: number) => fmtTime(t, { month: "short", day: "numeric", hour: "numeric" });
  const kind = pts.some((p) => p.kind === "fc") ? "observed and forecast" : "observed";
  const parts = [
    `${pts.length} ${kind} points, ${when(pts[0].t)} to ${when(pts[pts.length - 1].t)}.`,
    `Lowest ${lo.v.toFixed(2)} ft, ${when(lo.t)}. Highest ${hi.v.toFixed(2)} ft, ${when(hi.t)}.`,
  ];
  const sel = state.selected;
  if (sel) {
    const at = sel.properties.flood_stage_ft;
    const hrs = crossingHours(at);
    parts.push(hrs === null
      ? `${sel.properties.name ?? "This segment"} is not reached by ${at.toFixed(1)} ft inside this window.`
      : `${sel.properties.name ?? "This segment"} is reached by ${at.toFixed(1)} ft ${Math.round(hrs)} h from here.`);
  }
  el.textContent = parts.join(" ");
  // The card header carries the one number worth having outside the paragraph.
  $("chartNote").textContent = `crest ${hi.v.toFixed(2)} ft · ${when(hi.t)}` +
    (state.userForecast ? ` · your forecast (${state.userForecast.points} points)` : "");
}

function renderEnsemble(sel: Road | null) {
  const box = $("ens");
  const e = state.ensemble, spec = state.ensembleSpec;
  if (!spec || !sel || !e) { box.hidden = true; return; }
  box.hidden = false;

  const point = crossingHours(sel.properties.flood_stage_ft);
  const span = Math.max(point ?? 0, e.p90_h ?? 0, 1);
  $("ensCount").textContent = `${e.crossing} of ${e.of}`;
  $("ensLab").textContent = e.crossing === 1 ? "run reaches this street" : "runs reach this street";
  $("ensRange").textContent = e.median_h === null
    ? "no run reaches it within the window"
    : `median ${Math.round(e.median_h)} h \u00b7 ${Math.round(e.p10_h as number)}\u2013` +
      `${Math.round(e.p90_h as number)} h`;
  $("ensNever").textContent = e.never_h
    ? `${e.never_h} of ${e.of} never reach it in the window`
    : "every run reaches it";

  // One square per run: filled if it crosses, empty if it does not. The count is the
  // headline, so it is shown rather than summarised.
  const grid = $("ensGrid");
  grid.innerHTML = "";
  for (let i = 0; i < e.of; i++) {
    const d = document.createElement("i");
    if (i < e.crossing) d.className = "on";
    grid.appendChild(d);
  }
  // Range bar: p10..p90 as a span, with the shipped point estimate marked for contrast.
  const lo = ((e.p10_h ?? 0) / span) * 100, hi = ((e.p90_h ?? 0) / span) * 100;
  ($("ensSpan") as HTMLElement).style.cssText =
    e.median_h === null ? "display:none" : `left:${lo}%;width:${Math.max(hi - lo, 0.5)}%`;
  ($("ensTick") as HTMLElement).style.cssText =
    e.median_h === null ? "display:none" : `left:${((e.median_h ?? 0) / span) * 100}%`;
  ($("ensPoint") as HTMLElement).style.cssText =
    point === null ? "display:none" : `left:${(point / span) * 100}%`;

  const p = spec.parameters;
  const shipped = sel.properties.flood_stage_ft;
  const corrected = shipped + p.lift_ft;
  // The headline and this block answer DIFFERENT questions on purpose, and at the
  // current stage they can read as opposites (the headline floors at 0 h while the
  // ensemble says most runs never arrive). Saying so is the whole point of the block.
  $("ensNote").textContent =
    `Scored against the observed 2017 flood extent, the corridor's thresholds run ` +
    `${p.lift_ft.toFixed(1)} ft low, and two streets with the same threshold still differ ` +
    `by about ${p.per_street_sigma_ft.toFixed(0)} ft (1 sd). So this street's stage is ` +
    `uncertain around ${corrected.toFixed(1)} ft, against the ${shipped.toFixed(1)} ft the ` +
    `headline uses: it floods LATER than the point estimate says` +
    (point === null ? ", which never reaches it at all." : `, ${Math.round(point)} h here.`) +
    ` ${state.mode === "replay"
      ? "The replay hydrograph is observed, so this spread is the threshold error alone."
      : `The forecast adds its own measured error (${p.forecast_rmse_knots_ft[0][1].toFixed(1)} ft at ` +
        `+1 day, ${p.forecast_rmse_beyond_measured_ft.toFixed(1)} ft at +7).`} ` +
    `The correction is measured from one event and is deliberately not applied to the ` +
    `headline; this block is not a probability of flooding.`;
}

/* ---------------- Harvey backcast ---------------- */
/* The rule itself is ./lib/backcast.ts, recomputed there rather than read off the artifact so
 * that the pipeline's 17-row grid can be checked against it. What belongs here is the
 * POPULATION the rule counts over — `roadThresholds`, derived with the other per-segment
 * arrays, i.e. every threshold in the road layer the app already fetched. */

/** Every number the backcast block shows, recomputed from the app's own replay series
 *  and road list and compared with the pipeline's grid. Returns the mismatches. */
function checkBackcastGrid(): { ok: boolean; rows: number; bad: string[] } {
  const bc = state.backcast;
  if (!bc || state.mode !== "replay" || !state.series.length) {
    return { ok: false, rows: 0, bad: ["no backcast loaded, or not in replay"] };
  }
  const bad: string[] = [];
  const onsets = tierOnsets(state.series, bc.tiers);
  bc.tiers.forEach((t, i) => {
    const want = bc.verification_grid.tier_onsets_h[`${t.tier}_${t.stage_ft}`] ?? null;
    if ((onsets[i] ?? null) !== want) bad.push(`onset ${t.tier}: ${onsets[i]} != ${want}`);
  });
  for (const g of bc.verification_grid.flag_counts) {
    const c = flagCounts(roadThresholds, g.stage_ft, bc.correction_tradeoff.lift_ft);
    if (c.shipped !== g.shipped || c.corrected !== g.corrected) {
      bad.push(`stage ${g.stage_ft}: ${c.shipped}/${c.corrected} != ${g.shipped}/${g.corrected}`);
    }
  }
  // I3 — the per-street half, recomputed for the rows the pipeline named. The selected
  // street's own row is added here rather than in render(), so the number on screen and the
  // number in the grid are the same computation.
  const segGrid = bc.verification_grid.segment_lead_h ?? {};
  if (state.selIdx >= 0) segGrid[String(state.selIdx)] = bc.street_lead_time.per_segment_h?.[state.selIdx] ?? null;
  for (const [k, want] of Object.entries(segGrid)) {
    const i = Number(k);
    const got = state.series.length ? streetLeadHours(state.series, roadThresholds[i]) : null;
    if (got !== want) bad.push(`segment ${i}: ${got} != ${want}`);
  }
  return { ok: bad.length === 0,
    rows: bc.tiers.length + bc.verification_grid.flag_counts.length + Object.keys(segGrid).length,
    bad };
}

function renderBackcast() {
  const box = $("bcCard");
  const bc = state.backcast;
  if (!bc || state.mode !== "replay") { box.hidden = true; state.bcKey = ""; return; }
  box.hidden = false;

  const crestH = bc.event.crest.hours_from_start || 1;
  const key = `${bc.event.window.n_points}|${crestH}`;
  if (key !== state.bcKey) {
    // Axis runs to the crest, not to the end of the record, because the lead time IS the
    // bar length. The window ends two hours after the crest, so nothing is hidden.
    $("bcTl").innerHTML = bc.tiers.map((t) => {
      const left = t.onset_h === null ? 100 : (t.onset_h / crestH) * 100;
      return `<div class="bc-row" style="--c:var(--${t.tier})">` +
        `<span class="bc-lab"><b>${t.tier}</b><i>${t.stage_ft} ft</i></span>` +
        `<span class="bc-track"><i class="bc-band" style="left:${left.toFixed(2)}%"></i>` +
        `<i class="bc-crest"></i></span>` +
        `<span class="bc-lead"><b>${t.hours_before_crest === null ? "\u2014" : Math.round(t.hours_before_crest)} h</b> before the crest</span></div>`;
    }).join("");

    const lt = bc.street_lead_time, tr = bc.correction_tradeoff;
    const admin = tr.adjudication_at_the_peak;
    $("bcSum").innerHTML =
      `Observed, on the record: the action stage was crossed <b>${Math.round(bc.tiers[0].hours_before_crest as number)} h</b> ` +
      `before the crest and the major stage ${Math.round(bc.tiers[3].hours_before_crest as number)} h before it. ` +
      `Across the corridor the median street's own threshold was crossed <b>${lt.median_h} h</b> before the crest ` +
      `(${lt.p10_h}\u2013${lt.p90_h} h), with ${lt.segments_reaching_threshold} of ${lt.segments} segments ` +
      `reaching theirs inside the window.`;
    $("bcCav").textContent =
      `Observed: when the gauge crossed each stage, and the crest. Modelled: which street floods when \u2014 the ` +
      `only street-level observation in this project is a single maximum extent, so no per-street timing here is ` +
      `validated. At the crest the shipped thresholds flag ${tr.flags_at_crest.shipped} of ${tr.flags_at_crest.of} ` +
      `segments. ` + (admin
        ? `Scored on that one instant, applying the measured ${tr.lift_ft.toFixed(1)} ft lift would take accuracy ` +
          `${admin.shipped.accuracy.toFixed(3)} \u2192 ${admin.variants.probit_lift.accuracy.toFixed(3)} and the ` +
          `false-positive rate ${admin.shipped.false_positive_rate.toFixed(3)} \u2192 ` +
          `${admin.variants.probit_lift.false_positive_rate.toFixed(3)} \u2014 but it would silence ` +
          `${tr.streets_silent_in_window_after_correction} of the ${tr.streets_reaching_threshold_shipped} ` +
          `streets the shipped rule warns in time, so it is deliberately not applied.`
        : `The measured correction is deliberately not applied.`);
    state.bcKey = key;
  }

  // I3 — the personal half of the historical claim: what THIS street's alert would have said.
  // The per-segment array is read by the same index the map and the answer use, and the local
  // recomputation is compared with it rather than trusted, so the two cannot drift.
  const sel = state.selected;
  if (!sel || state.selIdx < 0) {
    $("bcStreet").hidden = true;
  } else {
    $("bcStreet").hidden = false;
    const at = sel.properties.flood_stage_ft;
    const lead = state.series.length ? streetLeadHours(state.series, at) : null;
    const published = bc.street_lead_time.per_segment_h?.[state.selIdx] ?? null;
    const name = sel.properties.name ?? `segment ${sel.properties.osmid}`;
    const agree = lead === published ? ""
      : ` ⚠ This recomputation (${lead}) disagrees with the artifact (${published}) — treat the block above as the published figure.`;
    $("bcStreet").innerHTML = lead === null
      ? `<b>Your street (${name})</b> was never reached inside the 2017 window: it floods at ` +
        `${at.toFixed(1)} ft and the observed crest was ` +
        `${bc.event.crest.stage_ft.toFixed(2)} ft.` + agree
      : `<b>Your street (${name})</b>: the alert would have landed <b>${lead} h</b> before the ` +
        `observed crest — this street floods at ${at.toFixed(1)} ft and crossed it ` +
        `${Math.round(lead)} h ahead of the peak.${agree}`;
  }

  const c = flagCounts(roadThresholds, state.current, bc.correction_tradeoff.lift_ft);
  $("bcStage").innerHTML =
    `At <b>${state.current.toFixed(2)} ft</b> the app flags <b>${c.shipped}</b> of ${state.roads.length} segments` +
    (c.shipped === c.corrected ? " (identical with the correction)"
      : `; with the measured correction, <b>${c.corrected}</b>`) + ".";
  $("bcNote").textContent = `replay \u00b7 ${bc.event.window.n_points} hourly observations \u00b7 ` +
    `crest ${bc.event.crest.stage_ft.toFixed(2)} ft`;
}

/* ---------------- I5: who is cut off right now ----------------
 * The inverse of "ways out". The set that matters operationally is not the flooded streets: it
 * is the streets whose route to help is already cut while their own road is still DRY — no water
 * to see and no way out, and the gap between those two stages is how long it lasts. The rule is
 * ./lib/responders.ts; what is here is the population it reads (the road layer and the graph, in
 * one segment order) and the card. */
function updateCuts(stage: number) {
  const g = state.graph;
  const rows = g
    ? cutOffAt(stage, roadThresholds, g.segment_route_cut_ft, g.segment_route_cut_medical_ft,
      state.roads.map((r) => r.properties.name ?? `segment ${r.properties.osmid}`))
    : [];
  state.cut = rows;
  state.cutKey = `cut|${stage.toFixed(1)}`;

  const noHosp = rows.reduce((n, r) => n + (hospitalCutAt(r, stage) ? 1 : 0), 0);
  $("cutCard").hidden = !g;
  $("cutNote").textContent = `at ${stage.toFixed(2)} ft`;
  $("cutHead").textContent = rows.length
    ? `${rows.length} of ${state.roads.length} segments have a dry road and no modelled route to help`
    : `No segment has lost its route to help while its street is still dry at ${stage.toFixed(2)} ft`;
  const list = $("cutList");
  list.innerHTML = "";
  for (const r of rows.slice(0, 12)) {
    const li = document.createElement("li");
    li.className = "cut-row";
    const b = document.createElement("b");
    b.textContent = r.name;
    const m = document.createElement("span");
    m.className = "m";
    m.textContent = `route cut at ${r.cutFt.toFixed(1)} ft · street floods at ${r.floodFt.toFixed(1)} ft` +
      ` · ${r.marginFt.toFixed(1)} ft before the water` +
      (r.cutToHospitalFt === null ? " · no hospital route modelled at any stage"
        : hospitalCutAt(r, stage) ? ` · hospital route cut at ${r.cutToHospitalFt.toFixed(1)} ft` : "");
    li.append(b, m);
    list.appendChild(li);
  }
  if (rows.length > 12) {
    const li = document.createElement("li");
    li.className = "cut-row more";
    li.textContent = `…and ${rows.length - 12} more, worst first`;
    list.appendChild(li);
  }
  $("cutWorst").textContent = rows.length
    ? `Worst: ${rows[0].marginFt.toFixed(1)} ft between losing the way out and the street flooding. ` +
      `${noHosp} of them have no modelled hospital route at this stage either.`
    : "Drag the stage up to see the set grow; each segment's own cut is in routing_graph.json.";
}

/* ---------------- I6: does the answer survive the measured error? ----------------
 * The kernel is ./lib/robustness.ts, and it is driven by the artifact's own numbers: the
 * per-street sigma and the corridor lift from the 2017 extent, and the benchmark's forecast
 * RMSE at the horizon the answer lands on. Cached on the selection AND the series, because the
 * card must not cost the drag anything (T8 measures that budget). */
function updateRobustness(sel: Road | null) {
  const spec = state.ensembleSpec;
  const box = $("robCard");
  if (!spec || !sel || !state.series.length) {
    box.hidden = true;
    state.rob = null;
    return;
  }
  const p = spec.parameters;
  const key = `${state.selIdx}|${state.mode}|${state.series.length}|` +
    `${state.series[state.series.length - 1]?.t ?? 0}|${state.userForecast ? "user" : "gauge"}`;
  if (key !== state.robKey || !state.rob) {
    state.rob = robustness(state.series, seriesRef(), sel.properties.flood_stage_ft, {
      sigmaFt: p.per_street_sigma_ft,
      liftFt: p.lift_ft,
      rmseAtHours: (h) => rmseFt(h / 24, spec),
      forecastFrom: firstForecastIndex(state.series),
      horizonHours: 72,
    });
    state.robKey = key;
  }
  box.hidden = false;
  const r = state.rob;
  const fmt = (h: number | null) => (h === null ? "not reached" : `${h.toFixed(1)} h`);
  $("robHead").textContent = r.base === null
    ? "The point estimate is that water does NOT reach this street in the window. Do the measured errors change that?"
    : `The point estimate is ${r.base.toFixed(1)} h. Under the errors this project has measured:`;
  $("robBody").innerHTML =
    `<div class="rob-row rob-head"><span>perturbation</span><span>lead time</span>` +
    `<span>Δ</span><span>what changed</span></div>` +
    r.rows.map((row) => (row.skipped
      ? `<div class="rob-row skip"><b>${row.label}</b><span>—</span><span></span><i>${row.detail}</i></div>`
      : `<div class="rob-row${row.holds ? "" : " bad"}"><b>${row.label}</b>` +
        `<span>${fmt(row.hours)}</span>` +
        `<span>${row.delta === null ? "—" : `${row.delta > 0 ? "+" : ""}${row.delta.toFixed(1)} h`}</span>` +
        `<i>${row.detail}</i></div>`)).join("");
  $("robVerdict").textContent = r.survives
    ? `The qualitative answer holds under all ${r.appliedCount} perturbations: ` +
      (r.base === null ? "no perturbation reaches this street either."
        : "water still reaches this street inside the window, though the hours move.")
    : "⚠ The measured errors do not all preserve the answer — a row above turns 'reached' into " +
      "'not reached' or back. The point estimate alone does not say which.";
}

/* ---------------- I4: bring your own forecast ----------------
 * The rule the app runs is a comparison between a stage series and one number per street, so a
 * pasted series works. Only the FORECAST half is replaced — the observations are what happened —
 * and nothing is stored: the series lives in memory, never in the URL or on the device. */
function readUserForecast() {
  const ta = $("fcText") as unknown as HTMLTextAreaElement;
  const parsed = parseForecast(ta.value, Date.now());
  const applied = applyUserForecast(state.series, parsed.points);
  if (!applied) {
    $("fcNote").textContent = parsed.errors.length
      ? `Nothing applied: ${parsed.errors.length} line(s) could not be read ` +
        `(first: line ${parsed.errors[0].line} — ${parsed.errors[0].why}). ` +
        `Need at least 3 readable points after the last observation.`
      : `Nothing applied: need at least 3 readable points after the last observation.`;
    return;
  }
  state.baseSeries = state.series;
  state.series = applied.series;
  state.userForecast = { points: parsed.points.length, note: applied.note };
  state.robKey = "";
  state.ensKey = "";
  const dropped = parsed.errors.length
    ? ` ${parsed.errors.length} line(s) skipped (first: line ${parsed.errors[0].line}, ` +
      `${parsed.errors[0].why}).` : "";
  const far = parsed.tooFar ? ` ${parsed.tooFar} point(s) beyond ${MAX_USER_HOURS} h dropped.` : "";
  $("fcNote").textContent = `Using your forecast: ${applied.note}${dropped}${far} ` +
    `Nothing is stored — clearing restores the gauge's own series.`;
  render();
}

function clearUserForecast() {
  if (state.baseSeries) state.series = state.baseSeries;
  state.baseSeries = null;
  state.userForecast = null;
  state.robKey = "";
  state.ensKey = "";
  ($("fcText") as unknown as HTMLTextAreaElement).value = "";
  $("fcNote").textContent = "Not using a pasted forecast: the gauge's own series is shown.";
  render();
}

/* ---------------- F7: the alert ---------------- */
/* The text and the schedule are ./lib/notify.ts, filled from the templates compiled into
 * data/notifications.json. What belongs HERE is what only the page knows: which street,
 * which series, and which language. Nothing in the card is written by hand, so the
 * message on screen is the message pipeline/tests/test_notifications.py rendered.
 *
 * The send is simulated and the card says so. What is not simulated is the timing: the
 * quiet-hours hold, the drop-rather-than-send-late rule and the crossing are computed by
 * the same rules as the pipeline's run over the 2017 record. */
function fmtIn(ms: number, lang: Lang, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: TZ, ...opts })
    .format(new Date(ms));
}

function renderAlerts() {
  const box = $("alertCard");
  const nt = state.notifications;
  if (!nt) { box.hidden = true; return; }
  box.hidden = false;
  const lang = state.lang;
  const ui = nt.ui[lang];
  $("alTitle").textContent = ui.title;
  $("alNote").textContent = ui.note;
  $("alLead").textContent = ui.lead;
  $("alQuiet").textContent = ui.quiet;
  for (const [id, l] of [["langEn", "en"], ["langEs", "es"]] as const) {
    $(id).setAttribute("aria-pressed", lang === l ? "true" : "false");
    $(id).setAttribute("lang", l);
  }
  box.setAttribute("lang", lang);
  $("alLang").setAttribute("aria-label", ui.language);

  const list = $("alList");
  const none = $("alNone");
  list.innerHTML = "";
  const sel = state.selected;
  if (!sel) {
    none.hidden = false; none.textContent = ui.pick;
    return;
  }
  const at = sel.properties.flood_stage_ft;
  const crossH = crossingHours(at);
  if (crossH === null) {
    none.hidden = false; none.textContent = ui.none;
    return;
  }
  none.hidden = true;
  const ref = seriesRef();
  const crossAt = ref + crossH * 3_600_000;
  const rows = messagesFor(nt, lang, sel.properties.name ?? "", at,
    (ms) => valueAt(state.series, ms, 6 * 3_600_000),
    (s) => category(s).n, crossAt);

  const short = rows.length < nt.tiers.length;
  for (const r of rows) {
    const tier = nt.tiers.find((t) => t.id === r.tier)!;
    const past = r.at < ref;
    const li = document.createElement("li");
    li.className = "al-row" + (past ? " past" : "");
    const meta = document.createElement("div");
    meta.className = "al-meta";
    const b = document.createElement("b");
    b.textContent = tier.label[lang];
    const i = document.createElement("i");
    i.textContent = past
      ? ui.past
      :        `${fmtIn(r.at, lang, { weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit" })} · ${ui.river} ${r.values.river} ${ui.ft}` +
        (r.deferredFrom === null ? "" : ` · ${ui.held}`);
    meta.append(b, i);
    const p = document.createElement("p");
    p.className = "al-text";
    p.setAttribute("lang", lang);
    p.textContent = r.text;
    li.append(meta, p);
    list.appendChild(li);
  }
  if (short) {
    const li = document.createElement("li");
    li.className = "al-short";
    li.textContent = ui.short;
    list.appendChild(li);
  }
}

/* ---------------- the household card ---------------- */
/* F3, and the ordering is the feature: three addresses are three different answers, and the
 * useful thing about them together is WHICH ONE COMES FIRST. Rows are ranked by the same number
 * the headline shows for the selected street (`limitOf` — the earlier of the street's own
 * threshold and the stage its last dry way out is cut), so a row and the answer it links to can
 * never disagree about the same street.
 *
 * Rebuilt on every render rather than cached. It is at most six rows and three text nodes each,
 * and a cached ranking that went stale on a mode switch would be a wrong answer in the one place
 * the whole feature is a comparison — while `crossingHours` over a 241-point series, six times,
 * is not a cost the drag can notice (T8 measures it, and the budget test boots with a
 * household).
 */
function renderHousehold(stage: number) {
  const card = $("hhCard");
  const rows = state.household;
  if (rows.length < 2) {
    // One address is already the answer above; a card that repeats it verbatim is noise. The
    // list is cleared rather than left hidden, so a stale row can never be read off the DOM.
    card.hidden = true;
    $("hhList").innerHTML = "";
    return;
  }
  card.hidden = false;

  const ranked = rows.map((r) => {
    const road = r.si === null ? null : state.roads[r.si];
    const limit = road ? limitOf(road) : null;
    return { r, road, limit, hours: limit ? crossingHours(limit.limit) : null };
  }).sort((a, b) => {
    const ha = a.hours === null ? Infinity : a.hours;
    const hb = b.hours === null ? Infinity : b.hours;
    if (ha !== hb) return ha - hb;                       // soonest first, never-reached last
    const ta = a.limit ? a.limit.limit : Infinity;
    const tb = b.limit ? b.limit.limit : Infinity;
    if (ta !== tb) return ta - tb;                       // then by the stage each is waiting on
    return a.r.query.localeCompare(b.r.query);           // then stably, so the list cannot shuffle
  });

  const list = $("hhList");
  list.innerHTML = "";
  for (const row of ranked) {
    const li = document.createElement("li");
    li.className = "hh-row" + (row.r.si !== null && row.r.si === state.selIdx ? " you" : "");

    const name = document.createElement("b");
    // The address as the user wrote it, as TEXT: it is their input, and the one string on this
    // card that did not come out of an artifact.
    name.textContent = row.r.query;
    const hours = document.createElement("div");
    hours.className = "t";
    hours.textContent = row.hours === null ? "\u2014" : `${Math.round(row.hours)} h`;
    const what = document.createElement("div");
    what.className = "m";

    if (!row.road) {
      li.classList.add("miss");
      what.textContent = row.r.why;
    } else {
      const at = row.road.properties.flood_stage_ft;
      what.textContent = row.hours === null
        ? `${row.r.label} \u00b7 not reached inside this window (floods at ${at.toFixed(1)} ft)`
        : `${row.r.label} \u00b7 ` + (row.limit?.cut
            ? `last dry way out cut at ${row.limit.limit.toFixed(1)} ft; the street floods at ${at.toFixed(1)} ft`
            : `water reaches it at ${at.toFixed(1)} ft`);
      if (row.r.si !== null) {
        // Clickable, because the answer above is about ONE of them and choosing which is how a
        // household uses this. Keyboard-reachable for the same reason every other control is.
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.setAttribute("aria-label", `Show the answer for ${row.r.query}`);
        const si = row.r.si as number;
        const pick = () => {
          if (si !== state.selIdx) setSelected(si);
          say(`Showing ${row.r.query}.`);
        };
        li.addEventListener("click", pick);
        li.addEventListener("keydown", (e) => {
          if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") pick();
        });
      }
    }
    li.append(name, hours, what);
    list.appendChild(li);
  }

  const failed = rows.filter((r) => r.si === null).length;
  $("hhNote").textContent = `${rows.length} addresses \u00b7 soonest first` +
    (failed ? ` \u00b7 ${failed} could not be placed` : "") + ` \u00b7 at ${stage.toFixed(2)} ft`;
}

/* ---------------- render ---------------- */
function render() {
  const stage = state.current;
  const cat = category(stage);
  const ans = document.getElementById("answer")!;
  ans.style.setProperty("--sev", cat.v);

  $("stageVal").textContent = stage.toFixed(2);
  $("catVal").textContent = cat.n;
  $("sevPill").textContent = cat.n;
  $("srcTag").textContent = state.source;
  // The mark beside that sentence, from the same flags the sentence is built from: waiting,
  // estimated, replay, or live. Derived here rather than set at each fetch site, because
  // there are four paths into this function and only one of them is allowed to be wrong.
  $("srcTag").dataset.state = !state.series.length ? "wait"
    : state.estimated ? "stale"
    : state.mode === "replay" ? "replay" : "live";
  // The badge is the only thing standing between a user and acting on an estimate
  // as if it were a measurement, so it is driven by the flag, not by the wording.
  ($("estPill") as HTMLElement).style.display = state.estimated ? "" : "none";
  $("stage").setAttribute("value", String(stage));
  ($("stage") as HTMLInputElement).value = String(stage);
  $("stageHint").textContent =
    `official NWS categories: action ${TH.action} · flood ${TH.minor} · moderate ${TH.moderate} · major ${TH.major}`;

  const sel = state.selected;
  $("addrOut").textContent = sel ? (sel.properties.name ?? `segment ${sel.properties.osmid}`) : "no street selected";
  const vEl = $("verdict"), sEl = $("sub"), hEl = $("hours"), hlEl = $("hoursLab");

  if (!sel) {
    vEl.innerHTML = "Enter an address to see your lead time";
    sEl.textContent = "The river is a number. Your street is the answer.";
    hEl.textContent = "—"; hlEl.textContent = "hours of lead time";
  } else {
    const at = sel.properties.flood_stage_ft;
    // The isolation stage is the actionable number, and it is never later than
    // the street's own threshold: it is the point at which the last dry route
    // out is cut. Details in pipeline/derive/isolation.py.
    const iso = sel.properties.isolation_ft;
    const lost = sel.properties.isolation_status === "no_dry_refuge";
    const { limit, cut: leads } = limitOf(sel);
    const hrsLimit = crossingHours(limit);

    if (stage >= at) {
      vEl.innerHTML = "Water is <em>on your street now</em>";
      sEl.textContent = `This segment's low point is ${at.toFixed(1)} ft on the Richmond gauge; the gauge is at ${stage.toFixed(2)} ft. Do not drive out.`;
      hEl.textContent = "0"; hlEl.textContent = "hours of lead time";
    } else if (leads && stage >= limit) {
      vEl.innerHTML = "You have <em>no dry route out</em>";
      sEl.textContent = `Every dry way off ${sel.properties.name ?? "this segment"} was cut at ${(iso as number).toFixed(1)} ft on the Richmond gauge — ${(at - (iso as number)).toFixed(1)} ft before the street itself goes under at ${at.toFixed(1)} ft. The gauge is at ${stage.toFixed(2)} ft.`;
      hEl.textContent = "0"; hlEl.textContent = "hours of lead time";
    } else if (hrsLimit === null) {
      vEl.innerHTML = leads
        ? `Your <em>last way out</em> stays open in this forecast`
        : `Your street stays <em>dry</em> in this forecast`;
      // "Stays dry" is true and useless on its own. F1's second half: what would have to
      // happen, and when it last did — computed from the cached peak record, so it costs no
      // request and works during the outage that motivates the product.
      sEl.textContent = leads
        ? `You keep a dry route out until ${limit.toFixed(1)} ft; the street floods at ${at.toFixed(1)} ft. The forecast does not reach either, and the gauge is at ${stage.toFixed(2)} ft. ` + quietLine(limit, true)
        : `The forecast does not reach it, and the gauge is at ${stage.toFixed(2)} ft. ` + quietLine(at, false);
      hEl.textContent = "—"; hlEl.textContent = "no crossing forecast";
    } else {
      const when = fmtTime((state.mode === "replay" ? state.series[0].t : Date.now()) + hrsLimit * 3_600_000,
        { weekday: "long", hour: "numeric", minute: "2-digit" });
      vEl.innerHTML = leads
        ? `You lose your last way out <em>${when}</em>`
        : `Water reaches this street <em>${when}</em>`;
      sEl.textContent = leads
        ? `Every dry route off ${sel.properties.name ?? "this segment"} is cut at ${limit.toFixed(1)} ft on the Richmond gauge — ${(at - limit).toFixed(1)} ft before the street itself floods at ${at.toFixed(1)} ft. The river is at ${stage.toFixed(2)} ft.`
        : `${sel.properties.name ?? "This segment"} floods at ${at.toFixed(1)} ft on the Richmond gauge; the river is at ${stage.toFixed(2)} ft.`;
      hEl.textContent = Math.round(hrsLimit).toString();
      hlEl.textContent = leads ? "until you are cut off" : "hours of lead time";
    }
    // Every street number in this panel inherits the threshold's measured bias, so it is
    // disclosed on the answer itself rather than only in the provenance line.
    if (state.validation) {
      // The probit fit, because that is the model the ensemble below propagates — one
      // number for the same quantity everywhere in this panel.
      const d = state.validation.diagnosis.threshold_error_model.lift_ft;
      sEl.textContent += ` ⚠ Scored against the observed 2017 flood extent these thresholds over-predict and run about ${Math.abs(d).toFixed(0)} ft low — water reaches this street later than the number above says. Not corrected: one event only.`;
    }
    if (lost) sEl.textContent += " ⚠ No modelled dry ground is reachable from this road's part of the network at any stage — treat the route out as unreliable.";
    if (sel.properties.levee) sEl.textContent += " ⚠ This segment is inside a levee-protected area — HAND does not model levees, so treat this threshold as unreliable.";
    else if (sel.properties.confidence === "low") sEl.textContent += " ⚠ Low confidence: this segment is below action stage, or sits at a river crossing where the bare-earth elevation model reads the ground under the bridge rather than the deck. Treat this threshold as unreliable.";
  }

  if (state.estimateNote) sEl.textContent += ` ⚠ ${state.estimateNote}`;

  // --- uncertainty ensemble ---------------------------------------------------
  // Depends only on the selection, the mode and the series — never on the slider — so
  // it is cached and the drag stays as cheap as it was before this block existed.
  const selKey = `${state.selIdx}|${state.mode}|${state.series.length}` +
    `|${state.series[0]?.t ?? 0}|${state.series[state.series.length - 1]?.t ?? 0}`;
  if (state.ensembleSpec && sel && (selKey !== state.ensKey || !state.ensemble)) {
    state.ensemble = runEnsemble(sel.properties.flood_stage_ft, state.ensembleSpec,
      state.series, seriesRef(), firstForecastIndex(state.series));
    state.ensKey = selKey;
  }
  renderEnsemble(sel);
  renderBackcast();
  renderAlerts();
  renderHousehold(stage);
  updateRobustness(sel);
  updateCuts(stage);
  renderCrossCheck();
  renderModelCross();

  const lowConf = state.roads.filter((r) => r.properties.confidence === "low").length;
  const trapped = state.roads.filter((r) => r.properties.isolation_gap_ft !== null
    && r.properties.isolation_gap_ft > 0.05).length;
  const v = state.validation;
  const valNote = v
    ? `<s>|</s><span>validated vs 2017 observed extent: marks ` +
      `${(v.confusion_matrix.prevalence_modelled * 100).toFixed(0)}% of the corridor flooded ` +
      `where ${(v.confusion_matrix.prevalence_observed * 100).toFixed(0)}% was, so the ` +
      `thresholds run ${Math.abs(v.diagnosis.threshold_error_model.lift_ft).toFixed(0)} ft low ` +
      `(n=${v.confusion_matrix.n}, ${v.observation.hwm.n} high-water marks)</span>`
    : "";
  $("prov").innerHTML =
    `<span>USGS ${GAUGE.usgs} / NWS ${GAUGE.lid} · Brazos River at Richmond</span><s>|</s>` +
    `<span>observed ${stage.toFixed(2)} ft</span><s>|</s>` +
    `<span>${state.mode === "live" ? "official NWS forecast" : "historical replay"}</span>` +
    `<s>|</s><span>thresholds: modelled (OWP HAND) \u00b7 ${lowConf} of ${state.roads.length} low confidence</span>` +
    valNote +
    `<s>|</s><span>${trapped} cut off before their street floods</span>`;

  // chain
  const list = $("chainList");
  list.innerHTML = "";
  const userHours = sel ? crossingHours(sel.properties.flood_stage_ft) : null;
  for (const c of state.chain) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${c.name}</b><div class="t">${c.median_h.toFixed(0)} h</div>` +
      `<div class="m">${c.lid} · IQR ${c.p25_h.toFixed(0)}–${c.p75_h.toFixed(0)} h · n=${c.n}</div>`;
    list.appendChild(li);
  }
  const youLi = document.createElement("li");
  youLi.className = "you";
  youLi.innerHTML = `<b>Your street</b><div class="t">${userHours === null ? "—" : `${Math.round(userHours)} h`}</div>` +
    `<div class="m">${sel ? (sel.properties.name ?? "selected segment") : "not selected"}</div>`;
  list.appendChild(youLi);
  $("chainNote").textContent = "derived from historical crest travel times (daily + sub-daily)";

  // ways out — routing to real destinations on the modelled network, at this stage
  computeRoutes(stage);
  const ex = $("exits");
  if (!sel || !state.graph) {
    ex.innerHTML = `<p class="muted">Enter an address, or click a road on the map.</p>`;
  } else {
    const parts: string[] = [];
    if (!state.routes.length) {
      parts.push(`<p class="muted">No modelled route from this segment to a hospital, fire or
        police station at any stage. This part of the road network is a fragment that the
        bounding-box extract does not connect — a limit of the study area, not a real barrier.</p>`);
    } else {
      parts.push(state.routes.slice(0, 5).map((r) => {
        const km = (r.meters / 1000).toFixed(1);
        const meta = r.ok
          ? `${km} km · dry route`
          : `${km} km · crosses water on ${r.wet} segment${r.wet > 1 ? "s" : ""}; ` +
            `deepest floods at ${r.deepestFt!.toFixed(1)} ft`;
        const far = r.f.snap_m > 60 ? ` · route ends ${Math.round(r.f.snap_m)} m from the station` : "";
        return `<div class="exit"><div style="flex:1;min-width:0">` +
          `<b>${r.f.name ?? r.f.kind}</b><span>${meta}${far}</span></div>` +
          `<span class="st ${r.ok ? "ok" : "bad"}">${r.ok ? "open" : "water"}</span></div>`;
      }).join(""));
    }
    const cut = state.graph.segment_route_cut_ft[state.selIdx];
    const medCut = state.graph.segment_route_cut_medical_ft[state.selIdx];
    const rev = reverseBest(stage);
    const cutTxt = cut === null || cut === undefined
      ? "No route off this segment exists at any river stage."
      : `Your last route out is cut at ${cut.toFixed(1)} ft.`;
    const revTxt = rev
      ? `${rev.f.name ?? rev.f.kind} can reach this segment${rev.wet ? ` — but only by crossing ${rev.wet} flooded segment${rev.wet > 1 ? "s" : ""}` : " on a dry route"}`
      : "No responder has a modelled route to this segment";
    // Reaching a fire station is not the same as reaching a hospital: for someone
    // who cannot be treated in place, the hospital route is the one that matters.
    let medTxt = "";
    if (medCut === null || medCut === undefined) {
      // Only worth saying if some responder *can* get here, or it repeats the line above.
      if (cut !== null && cut !== undefined) medTxt = " No hospital has a modelled route here at any stage.";
    } else if (cut === null || cut === undefined || medCut < cut - 0.05) {
      medTxt = ` A hospital route is cut at ${medCut.toFixed(1)} ft.`;
    }
    parts.push(`<p class="hint" style="margin-top:10px">Responder access: ${revTxt}. ${cutTxt}${medTxt}` +
      ` Routes are on the modelled corridor only; a responder outside it is not counted.</p>`);
    ex.innerHTML = parts.join("");
  }
  $("exitNote").textContent = `at ${stage.toFixed(2)} ft`;
  computeIsland(stage);
  updateRouteLine();

  // map — the count is rendered in BOTH modes: it is a sentence, not a pixel, and it is
  // most of what the map says. Only syncMap() (which no-ops without a map) is skipped.
  syncMap();
  const flooded = state.roads.filter((r) => stage >= r.properties.flood_stage_ft).length;
  $("mapNote").textContent = `${flooded} of ${state.roads.length} segments under water`;
  renderFloodNote();

  renderChartText();
  if (!textOnly) drawChart();

  // Every state change lands here, so the URL and the screen cannot disagree.
  syncUrl();
}

/* ---------------- wiring ---------------- */
/* The datalist offers REAL addresses the index can resolve, not bare street
 * names: the previous list invited input that could never match, because a
 * street name with a house number was matched as a substring of a road name. */
function samples() {
  const dl = $("samples") as unknown as HTMLDataListElement;
  const idx = state.address;
  const seen = new Set<number>();
  const options: string[] = [];
  if (idx) {
    for (const [si, lo] of idx.ranges.map((r) => [r[0], r[1]] as const)) {
      if (seen.has(si)) continue;
      seen.add(si);
      options.push(`${lo} ${idx.streets[si].n}, Richmond, TX`);
    }
  }
  // Streets with no county house numbers still work by name alone.
  const named = new Set<number>();
  for (const r of state.roads) {
    const n = r.properties.name;
    if (!n) continue;
    const si = idx?.streets.findIndex((s) => s.n === n) ?? -1;
    if (si >= 0 && named.has(si)) continue;
    if (si >= 0) named.add(si);
    options.push(n);
  }
  options.slice(0, 80).forEach((v) => {
    const o = document.createElement("option"); o.value = v; dl.appendChild(o);
  });
}

function wire() {
  // Through checkAddresses, not a single-address resolver: the box accepts `|`-separated
  // addresses and the household card is the point of that. One address behaves as it always did.
  const go = () => { void checkAddresses(($("addr") as HTMLInputElement).value); };
  $("go").addEventListener("click", go);
  $("addr").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go();
  });
  ($("stage") as unknown as HTMLInputElement).addEventListener("input", (e) => {
    // A hand on the slider outranks an animation: the animation stops where the hand is.
    stopRise();
    state.current = Number((e.target as HTMLInputElement).value);
    render();
  });
  $("playRise").addEventListener("click", playRise);
  $("mLive").addEventListener("click", () => setMode("live"));
  $("mReplay").addEventListener("click", () => setMode("replay"));
  // F7 — the alert language. A view choice, like text mode: it is in the link, so the
  // answer can be sent to someone in the language they read.
  $("langEn").addEventListener("click", () => setAlertLang("en"));
  $("langEs").addEventListener("click", () => setAlertLang("es"));
  $("share").addEventListener("click", () => { void shareLink(); });
  // I4 — a pasted forecast. Both controls are local: the series never leaves the page.
  $("fcUse").addEventListener("click", readUserForecast);
  $("fcClear").addEventListener("click", clearUserForecast);
}

function setAlertLang(lang: Lang) {
  if (state.lang === lang) return;
  state.lang = lang;
  render();
  syncUrl();
}

function setModeButtons() {
  $("mLive").setAttribute("aria-pressed", state.mode === "live" ? "true" : "false");
  $("mReplay").setAttribute("aria-pressed", state.mode === "replay" ? "true" : "false");
}

/* What the link claims, taken from what is on screen rather than restated here — a
 * second copy of the verdict would be a second thing to drift. */
function shareSummary(): string {
  const street = state.selected?.properties.name ?? "no street selected";
  const verdict = $("verdict").textContent?.trim() ?? "";
  return `${street} — ${verdict} · BrazosCast, ${state.current.toFixed(1)} ft on the Richmond gauge`;
}

async function shareLink() {
  syncUrl();
  const url = location.href;
  const note = $("shareNote");

  if (navigator.share) {
    try {
      await navigator.share({ title: "BrazosCast", text: shareSummary(), url });
      note.textContent = "Shared.";
      return;
    } catch (e) {
      // A cancelled share is not a failure and must not fall through to copying.
      if ((e as DOMException)?.name === "AbortError") return;
    }
  }

  try {
    await navigator.clipboard.writeText(`${shareSummary()}\n${url}`);
    note.textContent = "Link copied — it restores this street, stage and mode.";
  } catch {
    // The clipboard API needs a secure context and can be refused outright, so the
    // link is shown instead of a button that appears to work and does nothing.
    note.textContent = `Copy this link: ${url}`;
  }
}

async function setMode(mode: "live" | "replay") {
  // The stage is about to be replaced by the other event's, so a pass in flight is now
  // rising through a river that is no longer on screen.
  stopRise();
  state.mode = mode;
  setModeButtons();
  // A pasted forecast is a statement about the series this mode loaded, so it does not
  // survive a mode switch: the observations in the new mode are a different event.
  state.baseSeries = null;
  state.userForecast = null;
  ($("fcNote") as HTMLElement).textContent = "";
  state.cross = null;
  state.robKey = "";
  state.ensKey = "";
  try {
    if (mode === "live") {
      await fetchLive();
    } else {
      await loadReplay();
    }
  } catch (e) {
    $("askHint").textContent = `Could not load ${mode} data: ${e}`;
  }
  render();
  if (mode === "live") void runCrossCheck();
  else { state.cross = null; renderCrossCheck(); }
}

/* ---------------- offline ---------------- *
 * The storm case: the connection is the first thing to go, and the page has to keep
 * answering. app/public/sw.js caches the shell and whatever else the app has already
 * asked for; these two functions only decide whether it is registered and say out loud
 * when the browser has no network.
 */
function registerOffline() {
  // Production only, and the guard is the feature: a dev server serves modules unhashed,
  // so a service worker would hand back the previous version of a module from a URL that
  // still looks current — the one bug that is worse than being offline.
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  // Nothing can be installed with no connection, and a registration left half-installed
  // is worse than none: the next online visit registers cleanly instead.
  if (!navigator.onLine) return;
  // Relative on purpose. base is "./", so this app may be deployed under a subpath, and
  // an absolute "/sw.js" would land outside it.
  void navigator.serviceWorker.register("./sw.js").catch(() => {
    /* A registration that fails must not touch the answer on screen. */
  });
}

/* navigator.onLine is the browser's own signal rather than a probe: it says the machine
 * believes it has no network, which is the storm case and is deliberately not a claim
 * that the server is reachable. The tag names what it actually tests. */
function wireOfflineTag() {
  const el = $("offlineTag");
  const sync = () => { el.hidden = navigator.onLine; };
  addEventListener("online", sync);
  addEventListener("offline", sync);
  sync();
}

async function boot() {
  // The URL is read FIRST, because it decides whether the map is built at all. The old
  // order (build the map, then read the URL) would begin downloading MapLibre before it
  // could know a text-only visitor had asked not to have it.
  pendingUrl = readUrl();
  textOnly = pendingUrl.text;
  state.lang = pendingUrl.lang;
  applyTextMode();
  // Before the first await, so the state of the connection is on screen from the first
  // paint — including in text mode, which is the route most likely to be used on one.
  wireOfflineTag();
  // Not awaited: the map is a download, and the answer must not wait behind it. A failure
  // here is a blank base map offline, never a broken answer, so it must not escape as an
  // unhandled rejection either.
  if (!textOnly) void buildMap().catch(() => {});
  await loadStatic();
  samples();
  wire();
  layoutTicks();
  // The URL decides the mode BEFORE anything is fetched, so a replay link does not
  // make a live request only to throw it away — and on a flaky connection it does not
  // wait for a live gauge before showing 2017.
  if (pendingUrl.mode === "replay") {
    await loadReplay();
    state.mode = "replay";
  } else {
    try { await fetchLive(); } catch { await loadReplay(); state.mode = "replay"; }
  }
  setModeButtons();
  render();
  await applyUrl();
  // I2 — after the first paint, never in front of it: the upstream gauges are two more
  // requests, and the answer the page already has must not wait for a cross-check of it.
  if (state.mode === "live") void runCrossCheck();
  // The net, once everything boot needs has loaded and the timeline can be read in one go.
  keepOfflineCopy(loadedHere());
  // Dev-only inspection hook: the routing panel is verified against the pipeline
  // in a real browser, and screenshots are not always available. Stripped from
  // production builds by the DEV guard.
  if (import.meta.env.DEV) {
    (window as unknown as { brazoscast: unknown }).brazoscast =
      { map, state, widestTo, dijkstra, facilityNodes, applyTransfer, estimateFromUpstream,
        fetchLive, runEnsemble, mulberry32, rmseFt, checkBackcastGrid, tierOnsets, flagCounts,
        checkAddresses, located, urlAddresses, parseAddress, canonicalStreet, editDistance,
        nearestRoadIndex, buildRoadIndex,
        islandForSegment, islandSpec, computeIsland,
        readUrl, syncUrl, applyUrl, shareLink, shareSummary,
        runCrossCheck, crossCheck, cutOffAt, hospitalCutAt, robustness,
        parseForecast, applyUserForecast, streetLeadHours, lastReached, quietLine,
        render, updateCuts, updateRobustness, renderCrossCheck, drawChart };
  }
}

/* The rail is withdrawn whatever happens: a failed boot must not leave the page claiming to
 * be working on something it has given up on. */
void boot().finally(() => {
  document.body.dataset.boot = "done";
  // Removed rather than hidden after the fade — a fixed bar at zero opacity still paints.
  setTimeout(() => document.getElementById("bootRail")?.remove(), 400);
});

// Called, not awaited, and outside boot(): the offline copy is a background capability,
// and nothing the user is looking at waits for it.
registerOffline();
