import "./style.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/* ------------------------------------------------------------------ *
 * BrazosCast — address-first flood lead time for the lower Brazos.
 * Live stage/forecast: NOAA NWPS RMOT2. Street thresholds: OWP HAND.
 * Crest lead times: derived in-repo from historical gauge peaks.
 * ------------------------------------------------------------------ */

const TH = { action: 20, minor: 45, moderate: 48, major: 50 };
const GAUGE = { lid: "RMOT2", usgs: "08114000", lat: 29.582222, lon: -95.7575, zeroDatumFt: 26.73 };
const TZ = "America/Chicago";
const DATA = "./data/";
const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? "";

type Pt = { t: number; v: number; kind: "obs" | "fc" };
type ChainRow = { name: string; median_h: number; p25_h: number; p75_h: number; n: number };
type Road = {
  properties: {
    osmid: number; highway: string; name: string | null;
    flood_stage_ft: number; mainstem: boolean; levee: boolean;
  };
  geometry: { type: "LineString" | "MultiLineString"; coordinates: number[][] | number[][][] };
};

const state: {
  roads: Road[]; chain: (ChainRow & { lid: string })[]; series: Pt[]; current: number;
  mode: "live" | "replay"; selected: Road | null; source: string;
} = { roads: [], chain: [], series: [], current: 0, mode: "live", selected: null, source: "" };

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
  const [gj, chain] = await Promise.all([
    fetch(DATA + "road_thresholds.geojson").then((r) => r.json()),
    fetch(DATA + "travel_time_subdaily.json").then((r) => r.json()),
  ]);
  state.roads = gj.features as Road[];
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
}

async function loadReplay() {
  const j = await fetch(DATA + "replay-harvey.json").then((r) => r.json());
  state.series = j.points.map((p: { t: string; v: number }) => ({ t: Date.parse(p.t), v: p.v, kind: "obs" as const }));
  const peak = j.points.reduce((a: { v: number }, b: { v: number }) => (b.v > a.v ? b : a), j.points[0]);
  state.current = peak.v;
  state.source = `Replay · ${j.event} · USGS ${j.site} observed`;
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

function seriesWindow(): Pt[] {
  if (state.mode === "replay") return state.series;
  const now = Date.now();
  const from = now - 36 * 3_600_000;
  return state.series.filter((p) => p.t >= from);
}

/* ---------------- selection ---------------- */
function nearestRoad(lon: number, lat: number): { road: Road; dist: number } {
  let best: { road: Road; dist: number } | null = null;
  for (const r of state.roads) {
    const c = centroid(r);
    const d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2;
    if (!best || d < best.dist) best = { road: r, dist: d };
  }
  return best!;
}

async function selectByRoadName(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return;
  const hit = state.roads.find((r) => (r.properties.name ?? "").toLowerCase().includes(q));
  if (hit) return setSelected(hit);
  // last resort: Mapbox geocode (needs a token)
  if (MAPBOX_TOKEN) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${MAPBOX_TOKEN}&proximity=${GAUGE.lon},${GAUGE.lat}&limit=1`;
    const j = await fetch(url).then((r) => r.json());
    const c = j.features?.[0]?.center;
    if (c) return setSelected(nearestRoad(c[0], c[1]).road);
  }
  $("askHint").textContent = `No road matching “${query}” in the Richmond dataset. Try a road name, or click the map.`;
}

function setSelected(road: Road) {
  state.selected = road;
  const [lon, lat] = centroid(road);
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
    syncMap();
  });
  map.on("click", (e) => {
    const f = map!.queryRenderedFeatures(e.point, { layers: ["roads-flood", "roads-pass"] })[0];
    if (f) {
      setSelected({
        properties: f.properties as unknown as Road["properties"],
        geometry: f.geometry as unknown as Road["geometry"],
      });
    }
  });
}

function syncMap() {
  if (!map || !map.getLayer("roads-flood")) return;
  map.setFilter("roads-flood", ["<=", ["get", "flood_stage_ft"], state.current]);
  map.setFilter("roads-pass", [">", ["get", "flood_stage_ft"], state.current]);
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
    if (stage >= at) {
      vEl.innerHTML = "Water is <em>on your street now</em>";
      sEl.textContent = `This segment's low point is ${at.toFixed(1)} ft on the Richmond gauge; the gauge is at ${stage.toFixed(2)} ft. Do not drive out.`;
      hEl.textContent = "0"; hlEl.textContent = "hours of lead time";
    } else {
      const hrs = crossingHours(at);
      if (hrs === null) {
        vEl.innerHTML = `Your street stays <em>dry</em> in this forecast`;
        sEl.textContent = `This segment floods at ${at.toFixed(1)} ft and the forecast does not reach it. The gauge is at ${stage.toFixed(2)} ft.`;
        hEl.textContent = "—"; hlEl.textContent = "no crossing forecast";
      } else {
        const when = fmtTime((state.mode === "replay" ? state.series[0].t : Date.now()) + hrs * 3_600_000,
          { weekday: "long", hour: "numeric", minute: "2-digit" });
        vEl.innerHTML = `Water reaches this street <em>${when}</em>`;
        sEl.textContent = `${sel.properties.name ?? "This segment"} floods at ${at.toFixed(1)} ft on the Richmond gauge; the river is at ${stage.toFixed(2)} ft.`;
        hEl.textContent = Math.round(hrs).toString(); hlEl.textContent = "hours of lead time";
      }
    }
    if (sel.properties.levee) sEl.textContent += " ⚠ This segment is inside a levee-protected area — HAND does not model levees, so treat this threshold as unreliable.";
  }

  $("prov").innerHTML =
    `<span>USGS ${GAUGE.usgs} / NWS ${GAUGE.lid} · Brazos River at Richmond</span><s>|</s>` +
    `<span>observed ${stage.toFixed(2)} ft</span><s>|</s>` +
    `<span>${state.mode === "live" ? "official NWS forecast" : "historical replay"}</span>` +
    `<s>|</s><span>thresholds: modelled (OWP HAND)</span>`;

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

  // nearby streets
  const ex = $("exits");
  if (!sel) {
    ex.innerHTML = `<p class="muted">Enter an address, or click a road on the map.</p>`;
  } else {
    const c = centroid(sel);
    const near = state.roads
      .filter((r) => r.properties.osmid !== sel.properties.osmid)
      .map((r) => ({ r, d: (centroid(r)[0] - c[0]) ** 2 + (centroid(r)[1] - c[1]) ** 2 }))
      .sort((a, b) => a.d - b.d).slice(0, 6);
    ex.innerHTML = near.map(({ r }) => {
      const at = r.properties.flood_stage_ft, bad = stage >= at;
      return `<div class="exit"><div style="flex:1;min-width:0"><b>${r.properties.name ?? "unnamed segment"}</b>` +
        `<span>floods at ${at.toFixed(1)} ft${r.properties.levee ? " · levee-protected" : ""}</span></div>` +
        `<span class="st ${bad ? "bad" : "ok"}">${bad ? "under" : "passable"}</span></div>`;
    }).join("");
  }
  $("exitNote").textContent = `at ${stage.toFixed(2)} ft`;

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
}

boot();
