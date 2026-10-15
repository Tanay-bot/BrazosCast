import "./style.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

type Pt = { t: number; v: number; kind: "obs" | "fc" };
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
  node_cut_ft: (number | null)[];
  node_cut_medical_ft: (number | null)[];
  segment_route_cut_ft: (number | null)[];
  segment_route_cut_medical_ft: (number | null)[];
};
/* One destination as seen from the selected street at the current stage. */
type RouteOut = { f: Facility; ok: boolean; meters: number; wet: number; deepestFt: number | null; path: number[]; edges: number[] };

/* Gauge-failure redundancy (pipeline/derive/gauge_redundancy.py): what to report when
 * RMOT2 stops reporting. The regime boundaries and the band are MEASURED there, not
 * chosen here — the app only applies them. */
type Transfer = { name: string; usgs: string; lag_h: number; lag_h_used: number; u_ft: number[]; r_ft: number[] };
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

/* The uncertainty the point estimate hides (pipeline/derive/ensemble.py).
 * Parameters AND the algorithm come from the pipeline, and the app must reproduce the
 * pipeline's verification grid — the same cross-language check the crest transfer and
 * the Dijkstra already get. Nothing here is invented in the browser. */
type EnsembleOut = {
  members: number; crossing: number; of: number;
  median_h: number | null; p10_h: number | null; p90_h: number | null; never_h: number;
};
type EnsembleSpec = {
  parameters: {
    members: number; seed: number; lift_ft: number; per_street_sigma_ft: number;
    forecast_rmse_knots_ft: [number, number][]; forecast_rmse_beyond_measured_ft: number;
  };
  verification_grid: ({ threshold_ft: number; forecast_from: number | null; mode: string }
    & EnsembleOut)[];
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
    p10_h: number; median_h: number; p90_h: number; min_h: number; max_h: number; note: string };
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
    tier_onsets_h: Record<string, number | null> };
};

const state: {
  roads: Road[]; chain: (ChainRow & { lid: string })[]; series: Pt[]; current: number;
  mode: "live" | "replay"; selected: Road | null; selIdx: number; source: string;
  graph: RoutingGraph | null; routes: RouteOut[]; routeSel: RouteOut | null;
  redundancy: Redundancy | null; estimated: boolean; staleHours: number; estimateNote: string;
  validation: Validation | null;
  ensembleSpec: EnsembleSpec | null; ensemble: EnsembleOut | null; ensKey: string;
  backcast: Backcast | null; bcKey: string;
} = { roads: [], chain: [], series: [], current: 0, mode: "live", selected: null, selIdx: -1,
  source: "", graph: null, routes: [], routeSel: null,
  redundancy: null, estimated: false, staleHours: 0, estimateNote: "", validation: null,
  ensembleSpec: null, ensemble: null, ensKey: "", backcast: null, bcKey: "" };

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

/* ---------------- data ---------------- */
async function loadStatic() {
  const [gj, chain, gph, red, val, ens, bc] = await Promise.all([
    fetch(DATA + "road_thresholds.geojson").then((r) => r.json()),
    fetch(DATA + "travel_time_subdaily.json").then((r) => r.json()),
    fetch(DATA + "routing_graph.json").then((r) => r.json()),
    fetch(DATA + "gauge_redundancy.json").then((r) => r.json()),
    fetch(DATA + "harvey_validation.json").then((r) => r.json()),
    fetch(DATA + "ensemble.json").then((r) => r.json()),
    fetch(DATA + "harvey_backcast.json").then((r) => r.json()),
  ]);
  state.roads = gj.features as Road[];
  state.graph = gph as RoutingGraph;
  state.redundancy = red as Redundancy;
  state.validation = val as Validation;
  state.ensembleSpec = ens as EnsembleSpec;
  state.backcast = bc as Backcast;
  buildRouting();
  state.chain = Object.entries(chain.gauges as Record<string, ChainRow>)
    .map(([lid, g]) => ({ lid, ...g }))
    .sort((a, b) => a.median_h - b.median_h);
}

async function fetchLive() {
  const r = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${GAUGE.lid}/stageflow`);
  if (!r.ok) throw new Error(`NWPS ${r.status}`);
  const j = await r.json();
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

/** The same clamped piecewise-linear interpolation the pipeline validated, with the
 *  clamp reported: the transfer is fitted on FLOOD events, so an upstream stage below
 *  the fitted range yields the floor value, and the uncertainty band measured over the
 *  fitted range does not describe that case. Quoting the band anyway would be a lie. */
function applyTransferClamped(t: Transfer, x: number): { v: number; clamped: boolean } {
  const u = t.u_ft, r = t.r_ft;
  if (x <= u[0]) return { v: r[0], clamped: true };
  if (x >= u[u.length - 1]) return { v: r[r.length - 1], clamped: true };
  for (let i = 1; i < u.length; i++) {
    if (x <= u[i]) {
      const f = (x - u[i - 1]) / (u[i] - u[i - 1] || 1);
      return { v: r[i - 1] + f * (r[i] - r[i - 1]), clamped: false };
    }
  }
  return { v: r[r.length - 1], clamped: true };
}

function applyTransfer(t: Transfer, x: number): number {
  return applyTransferClamped(t, x).v;
}

async function fetchUpstream(lid: string): Promise<{ t: number; v: number }[]> {
  const r = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow`);
  if (!r.ok) throw new Error(`NWPS ${lid} ${r.status}`);
  const j = await r.json();
  return ((j.observed?.data ?? []) as { validTime: string; primary: number }[])
    .map((p) => ({ t: Date.parse(p.validTime), v: p.primary }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

function valueAt(series: { t: number; v: number }[], targetMs: number, tolMs: number): number | null {
  let best = Infinity, out: number | null = null;
  for (const p of series) {
    const d = Math.abs(p.t - targetMs);
    if (d < best) { best = d; out = p.v; }
  }
  return best <= tolMs ? out : null;
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

/* ---------------- lead time ---------------- */
function crossingHours(threshold: number): number | null {
  const now = state.series.length ? state.series[state.series.length - 1].t : Date.now();
  const ref = state.mode === "live" ? Date.now() : (state.series[0]?.t ?? now);
  for (const p of state.series) {
    if (p.v >= threshold) return Math.max(0, (p.t - ref) / 3_600_000);
  }
  return null;
}

/* ---------------- uncertainty ensemble ---------------- */
/* A line-by-line mirror of pipeline/derive/ensemble.py. The PRNG is mulberry32 in both
 * languages (Math.imul is the low 32 bits of the product, which is why the Python side
 * masks), and the drawn values are rounded to 6 dp so that libm and V8 differing in the
 * last ulp cannot move a draw across a hydrograph point and change the reported count. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = (t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0 ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return Math.round(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 1e6) / 1e6;
}

/* Measured forecast RMSE (ft) at a given horizon in days: linear between the knots the
 * benchmark produced, zero at zero, and held at the longest measured horizon beyond it. */
function rmseFt(days: number, spec: EnsembleSpec): number {
  const k = spec.parameters.forecast_rmse_knots_ft;
  if (days <= 0) return 0;
  if (days >= k[k.length - 1][0]) return spec.parameters.forecast_rmse_beyond_measured_ft;
  if (days < k[0][0]) return (k[0][1] * days) / k[0][0];
  for (let i = 0; i + 1 < k.length; i++) {
    const [d0, v0] = k[i], [d1, v1] = k[i + 1];
    if (days >= d0 && days <= d1) return v0 + ((v1 - v0) * (days - d0)) / (d1 - d0);
  }
  return spec.parameters.forecast_rmse_beyond_measured_ft;
}

function runEnsemble(threshold: number, spec: EnsembleSpec): EnsembleOut {
  const { members, seed, lift_ft, per_street_sigma_ft } = spec.parameters;
  const series = state.series;
  const ref = state.mode === "replay" ? (series[0]?.t ?? Date.now()) : Date.now();
  const fcFrom = series.findIndex((p) => p.kind === "fc");
  const rng = mulberry32(seed);
  const hours: number[] = [];
  for (let m = 0; m < members; m++) {
    const tau = Math.round((threshold + lift_ft + per_street_sigma_ft * gauss(rng)) * 1e4) / 1e4;
    // Forecast error is a random walk whose cumulative sd at each horizon equals the
    // measured RMSE there, so it grows the way the benchmark says it does. Observed
    // points are never perturbed — in replay that leaves only the threshold term.
    let z = 0, prevVar = 0, hit: number | null = null;
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      let v = p.v;
      if (fcFrom >= 0 && i >= fcFrom) {
        const var_ = rmseFt((p.t - ref) / 86_400_000, spec) ** 2;
        z += Math.sqrt(Math.max(0, var_ - prevVar)) * gauss(rng);
        prevVar = var_;
        v = v + z;
      }
      if (v >= tau) { hit = Math.round(Math.max(0, (p.t - ref) / 3_600_000) * 1e3) / 1e3; break; }
    }
    if (hit !== null) hours.push(hit);
  }
  hours.sort((a, b) => a - b);
  const q = (p: number) => {
    if (!hours.length) return null;
    const idx = (hours.length - 1) * (p / 100);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const val = hours[lo] + (hours[hi] - hours[lo]) * (idx - lo);
    return Math.round(val * 100) / 100;
  };
  return { members, crossing: hours.length, of: members,
    median_h: q(50), p10_h: q(10), p90_h: q(90), never_h: members - hours.length };
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
function nearestRoadIndex(lon: number, lat: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < state.roads.length; i++) {
    const c = centroid(state.roads[i]);
    const d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

async function selectByRoadName(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return;
  const hit = state.roads.findIndex((r) => (r.properties.name ?? "").toLowerCase().includes(q));
  if (hit >= 0) return setSelected(hit);
  // last resort: Mapbox geocode (needs a token)
  if (MAPBOX_TOKEN) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${MAPBOX_TOKEN}&proximity=${GAUGE.lon},${GAUGE.lat}&limit=1`;
    const j = await fetch(url).then((r) => r.json());
    const c = j.features?.[0]?.center;
    if (c) return setSelected(nearestRoadIndex(c[0], c[1]));
  }
  $("askHint").textContent = `No road matching “${query}” in the Richmond dataset. Try a road name, or click the map.`;
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

function buildMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
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
    },
    center: [GAUGE.lon, GAUGE.lat],
    zoom: 12,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    map!.addSource("roads", { type: "geojson", data: "./data/road_thresholds.geojson" });
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
/* The rule, recomputed here rather than read from the artifact, so the timeline is
 * derived in the browser and then checked against the pipeline — the same
 * cross-language check the ensemble, the transfer function and the Dijkstra get.
 * A tier onset is the first hourly point at or above the tier stage; a flag count is
 * the number of segments whose threshold is at or below the stage. */
function tierOnsets(series: Pt[], tiers: { stage_ft: number }[]): (number | null)[] {
  const ref = series[0]?.t ?? 0;
  return tiers.map((t) => {
    for (const p of series) {
      if (p.v >= t.stage_ft) return Math.round(((p.t - ref) / 3_600_000) * 10) / 10;
    }
    return null;
  });
}

function flagCounts(stage: number, lift: number): { shipped: number; corrected: number } {
  let shipped = 0, corrected = 0;
  for (const r of state.roads) {
    const at = r.properties.flood_stage_ft;
    if (at <= stage) shipped++;
    if (at + lift <= stage) corrected++;
  }
  return { shipped, corrected };
}

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
    const c = flagCounts(g.stage_ft, bc.correction_tradeoff.lift_ft);
    if (c.shipped !== g.shipped || c.corrected !== g.corrected) {
      bad.push(`stage ${g.stage_ft}: ${c.shipped}/${c.corrected} != ${g.shipped}/${g.corrected}`);
    }
  }
  return { ok: bad.length === 0, rows: bc.tiers.length + bc.verification_grid.flag_counts.length, bad };
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

  const c = flagCounts(state.current, bc.correction_tradeoff.lift_ft);
  $("bcStage").innerHTML =
    `At <b>${state.current.toFixed(2)} ft</b> the app flags <b>${c.shipped}</b> of ${state.roads.length} segments` +
    (c.shipped === c.corrected ? " (identical with the correction)"
      : `; with the measured correction, <b>${c.corrected}</b>`) + ".";
  $("bcNote").textContent = `replay \u00b7 ${bc.event.window.n_points} hourly observations \u00b7 ` +
    `crest ${bc.event.crest.stage_ft.toFixed(2)} ft`;
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
    const leads = iso !== null && iso < at - 0.05;
    const limit = leads ? (iso as number) : at;
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
      sEl.textContent = leads
        ? `You keep a dry route out until ${limit.toFixed(1)} ft; the street floods at ${at.toFixed(1)} ft. The forecast does not reach either, and the gauge is at ${stage.toFixed(2)} ft.`
        : `This segment floods at ${at.toFixed(1)} ft and the forecast does not reach it. The gauge is at ${stage.toFixed(2)} ft.`;
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
    state.ensemble = runEnsemble(sel.properties.flood_stage_ft, state.ensembleSpec);
    state.ensKey = selKey;
  }
  renderEnsemble(sel);
  renderBackcast();

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
  updateRouteLine();

  // map
  syncMap();
  const flooded = state.roads.filter((r) => stage >= r.properties.flood_stage_ft).length;
  $("mapNote").textContent = `${flooded} of ${state.roads.length} segments under water`;

  drawChart();
}

/* ---------------- wiring ---------------- */
function samples() {
  const seen = new Map<string, [number, number]>();
  for (const r of state.roads) {
    const n = r.properties.name;
    if (n && !seen.has(n)) seen.set(n, centroid(r));
  }
  const dl = $("samples") as unknown as HTMLDataListElement;
  [...seen.keys()].slice(0, 60).forEach((n) => {
    const o = document.createElement("option"); o.value = n; dl.appendChild(o);
  });
}

function wire() {
  $("go").addEventListener("click", () => selectByRoadName(($("addr") as HTMLInputElement).value));
  $("addr").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") selectByRoadName(($("addr") as HTMLInputElement).value);
  });
  ($("stage") as unknown as HTMLInputElement).addEventListener("input", (e) => {
    state.current = Number((e.target as HTMLInputElement).value);
    render();
  });
  $("mLive").addEventListener("click", () => setMode("live"));
  $("mReplay").addEventListener("click", () => setMode("replay"));
}

async function setMode(mode: "live" | "replay") {
  state.mode = mode;
  $("mLive").setAttribute("aria-pressed", mode === "live" ? "true" : "false");
  $("mReplay").setAttribute("aria-pressed", mode === "replay" ? "true" : "false");
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
}

async function boot() {
  buildMap();
  await loadStatic();
  samples();
  wire();
  try { await fetchLive(); } catch { await loadReplay(); state.mode = "replay"; }
  render();
  // Dev-only inspection hook: the routing panel is verified against the pipeline
  // in a real browser, and screenshots are not always available. Stripped from
  // production builds by the DEV guard.
  if (import.meta.env.DEV) {
    (window as unknown as { brazoscast: unknown }).brazoscast =
      { map, state, widestTo, dijkstra, facilityNodes, applyTransfer, estimateFromUpstream,
        fetchLive, runEnsemble, mulberry32, rmseFt, checkBackcastGrid, tierOnsets, flagCounts };
  }
}

boot();
