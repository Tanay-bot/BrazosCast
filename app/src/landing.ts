/* The landing page — the river read for one household.
 *
 * Three jobs, in the order the page asks them: put the live stage on the gauge, let the reader
 * drag that gauge to see what the river's own record says about a stage, and resolve a street
 * onto the same scale. Nothing here decides a lead time; that is the app's job at /app, and the
 * probe hands off rather than reimplementing it.
 *
 * The numbers on this page are the artifacts' numbers: the peak record comes from
 * gauge_history.json and the street thresholds from street_thresholds.json, both exported by
 * pipeline/export/app_data.py. No statistic is typed into this file.
 */
import "./tokens.css";
import "./landing.css";

const GAUGE = "https://api.water.noaa.gov/nwps/v1/gauges/RMOT2/stageflow";
const HISTORY = "./data/gauge_history.json";
const STREETS = "./data/street_thresholds.json";
/* The size of the threshold bias, read from the artifact the app discloses it from. It was
 * typed into the prose as "24 ft" before, which is the drift this project keeps catching: the
 * number is a pipeline result, not a fact about the river. */
const VALIDATION = "./data/harvey_validation.json";
const ACTION_FT = 20;
const FLOOD_FT = 45;
const DOMAIN = { min: 0, max: 66 };

type History = {
  peaks: { at: string; ft: number }[];
  from: string;
  to: string;
  n_peaks: number;
  highest: { ft: number; at: string };
};
type StreetEntry = { name: string; min_ft: number; segments: number };
type StreetIndex = { by_key: Record<string, StreetEntry>; source?: string; note?: string };
/* Only the one field the sentence needs. The app reads the same path (main.ts). */
type Validation = { diagnosis: { threshold_error_model: { lift_ft: number } } };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number) => v.toFixed(2);
const clock = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })
    .format(new Date(iso));

/* ------------------------------------------------------------------ the rail --- */

/** The official stages on this gauge, in feet — the only numbers the scale labels. */
const STAGES: [number, string][] = [[20, "20"], [45, "45"], [48, "48"], [50, "50"], [61.2, "61.2"]];

/** The scale: every five feet, with the official stages labelled where they fall.
 *
 *  A labelled stage REPLACES the five-foot tick under it rather than sitting on top of one:
 *  two rules at the same height read as a heavier tick, not as two facts. 48 and 61.2 are not
 *  multiples of five, so they are the only ones added. */
const TICKS: { ft: number; label?: string }[] = (() => {
  const labelled = new Map(STAGES);
  const out: { ft: number; label?: string }[] = [];
  for (let ft = 0; ft <= 65; ft += 5) out.push({ ft, label: labelled.get(ft) });
  for (const [ft, label] of STAGES) if (!out.some((t) => t.ft === ft)) out.push({ ft, label });
  return out.sort((a, b) => a.ft - b.ft);
})();

/* A FRACTION, not a percentage: the CSS is `calc(var(--p) * 100%)`, and a percentage
 * multiplied by a percentage is invalid — which collapsed every tick onto the top of the
 * track. Found by looking at the rendered page. */
const pct = (ft: number) =>
  String(Math.max(0, Math.min(1, (ft - DOMAIN.min) / (DOMAIN.max - DOMAIN.min))));

type Rail = {
  setStage: (ft: number, opts?: { silent?: boolean }) => void;
  setStreet: (s: StreetEntry | null) => void;
  stage: () => number;
};

/* The band's labels are dropped when they would touch, heaviest first: the action stage, flood
 * stage and the record are the three the prose names, 48 and 50 are the detail. Visibility and
 * not display, so measuring cannot change the width it just measured. */
const LABEL_RANK = new Map([["20", 0], ["45", 1], ["61.2", 2], ["48", 3], ["50", 4]]);

function fitBandLabels(track: HTMLElement): void {
  /* Zero width means the band is not on screen (desktop hides it outright). Measuring then
   * would collapse every label onto 0 and hide them all; the resize below fits it when the
   * band is given a width. */
  if (!track.offsetWidth) return;
  const rows: HTMLElement[][] = [[], []];
  for (const el of track.querySelectorAll<HTMLElement>(".h-tick")) {
    rows[Number(el.style.getPropertyValue("--row")) || 0].push(el);
  }
  for (const row of rows) {
    const items = row.map((el) => {
      const span = el.querySelector("span") as HTMLElement;
      span.style.visibility = "";
      return { span, centre: el.offsetLeft, half: span.offsetWidth / 2 };
    });
    items.sort((a, b) => (LABEL_RANK.get(a.span.textContent ?? "") ?? 9) -
      (LABEL_RANK.get(b.span.textContent ?? "") ?? 9));
    const kept: { l: number; r: number }[] = [];
    for (const it of items) {
      const l = it.centre - it.half, r = it.centre + it.half;
      if (kept.some((k) => l < k.r + 5 && r > k.l - 5)) { it.span.style.visibility = "hidden"; continue; }
      kept.push({ l, r });
    }
  }
}

function buildRail(onChange: (ft: number) => void): Rail {
  const track = $<HTMLDivElement>("railTrack");
  const ticks = $<HTMLDivElement>("railTicks");
  const needle = $<HTMLDivElement>("railNeedle");
  const you = $<HTMLDivElement>("railYou");
  const youLab = $<HTMLSpanElement>("railYouLab");
  const now = $<HTMLSpanElement>("railNow");
  const band = $<HTMLDivElement>("railH");

  ticks.replaceChildren();
  band.replaceChildren();
  TICKS.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = `tick${t.label ? " major" : ""}`;
    el.style.setProperty("--p", String(t.ft / DOMAIN.max));
    el.style.setProperty("--i", String(i));
    el.innerHTML = `<i class="rule"></i>${t.label ? `<span>${t.label}</span>` : ""}`;
    ticks.appendChild(el);
  });

  const hTrack = document.createElement("div");
  hTrack.className = "h-track";
  band.appendChild(hTrack);
  /* Two label rows, alternating. 45, 48 and 50 are three feet apart: on a phone the band is
   * ~350 px wide, so they land ~16 px apart and one row renders them as "45 4850". The
   * alternation is the fix, and it lives here rather than in a media query because the
   * collision depends on the width the band actually got. Three feet is not always two rows
   * either, so the fit is measured below rather than assumed. */
  TICKS.filter((x) => x.label).forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "h-tick major";
    el.style.setProperty("--p", String(t.ft / DOMAIN.max));
    el.style.setProperty("--row", String(i % 2));
    el.innerHTML = `<span>${t.label}</span>`;
    hTrack.appendChild(el);
  });
  fitBandLabels(hTrack);
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => fitBandLabels(hTrack)).observe(hTrack);
  }
  /* Inside the track, not beside it: the needle has to be as tall as the band it marks. */
  const hNeedle = document.createElement("div");
  hNeedle.className = "h-needle";
  hTrack.appendChild(hNeedle);
  const hYou = document.createElement("div");
  hYou.className = "h-you";
  hYou.hidden = true;
  hTrack.appendChild(hYou);

  let stage = 8.5;

  const paint = () => {
    const p = pct(stage);
    needle.style.setProperty("--p", p);
    needle.hidden = false;
    hNeedle.style.setProperty("--p", p);
    track.setAttribute("aria-valuenow", stage.toFixed(1));
    track.setAttribute("aria-valuetext", `${stage.toFixed(1)} feet`);
    now.textContent = `${fmt(stage)} ft`;
  };

  const setStage = (ft: number, opts: { silent?: boolean } = {}) => {
    stage = Math.round(Math.max(DOMAIN.min, Math.min(DOMAIN.max, ft)) * 10) / 10;
    paint();
    if (!opts.silent) onChange(stage);
  };

  const fromPointer = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    const frac = 1 - (e.clientY - r.top) / r.height;
    setStage(DOMAIN.min + frac * (DOMAIN.max - DOMAIN.min));
  };

  track.addEventListener("pointerdown", (e) => {
    track.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  track.addEventListener("pointermove", (e) => {
    if (track.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  track.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 5 : 0.5;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { setStage(stage + step); e.preventDefault(); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { setStage(stage - step); e.preventDefault(); }
    if (e.key === "PageUp") { setStage(stage + 5); e.preventDefault(); }
    if (e.key === "PageDown") { setStage(stage - 5); e.preventDefault(); }
    if (e.key === "Home") { setStage(DOMAIN.min); e.preventDefault(); }
    if (e.key === "End") { setStage(DOMAIN.max); e.preventDefault(); }
  });

  return {
    setStage,
    stage: () => stage,
    setStreet: (s) => {
      you.hidden = !s;
      hYou.hidden = !s;
      if (!s) return;
      you.style.setProperty("--p", pct(s.min_ft));
      youLab.textContent = fmt(s.min_ft);
      hYou.style.setProperty("--p", pct(s.min_ft));
    },
  };
}

/* ------------------------------------------------------------------- the page --- */

function peaksAtOrAbove(history: History | null, ft: number): number {
  if (!history) return 0;
  return history.peaks.filter((p) => p.ft >= ft).length;
}

/* Short on purpose: this sits in a 104 px column, and a paragraph there is not a caption.
 * It answers the one question a dragged gauge raises — has the river actually been here —
 * so the count is stated against the record and not against the live reading. */
function caption(history: History | null, ft: number, street: StreetEntry | null): string {
  if (!history) return "Peak record unavailable.";
  const since = history.from.slice(0, 4);
  const of = `of ${history.n_peaks} annual peaks since ${since}`;
  if (street) {
    const at = peaksAtOrAbove(history, street.min_ft);
    return `${street.name} floods at ${fmt(street.min_ft)} ft · reached in ${at} ${of}.`;
  }
  const n = peaksAtOrAbove(history, ft);
  if (n === 0) return `Never reached since ${since} · record ${fmt(history.highest.ft)} ft.`;
  const last = history.peaks.filter((p) => p.ft >= ft).at(-1);
  return `Reached in ${n} ${of} · last ${last ? last.at.slice(0, 4) : "—"}.`;
}

function heroSentence(live: { stage: number; at: string; peak: number | null } | null): string {
  if (!live) {
    return `<span class="fail">The gauge could not be read just now.</span> The scale still shows what each stage means.`;
  }
  const observed = `Observed ${clock(live.at)}.`;
  const gap = ACTION_FT - live.stage;
  if (live.stage >= FLOOD_FT) return `${observed} That is <b>at or above flood stage</b> (45 ft).`;
  if (live.stage >= ACTION_FT) return `${observed} <b>Above action stage</b> (20 ft); flood stage is 45 ft.`;
  const forecastReaches = live.peak !== null && live.peak >= ACTION_FT;
  return `${observed} That is <b>${gap.toFixed(1)} ft below action stage</b> — ${forecastReaches
    ? "the forecast reaches it."
    : "the forecast does not reach it."}`;
}

/* ------------------------------------------------------------------ resolution --- */

const SUFFIX: Record<string, string> = {
  LN: "LANE", RD: "ROAD", ST: "STREET", DR: "DRIVE", AVE: "AVENUE", BLVD: "BOULEVARD",
  HWY: "HIGHWAY", PKWY: "PARKWAY", CT: "COURT", PL: "PLACE", TRL: "TRAIL", CIR: "CIRCLE",
  TER: "TERRACE", LOOP: "LOOP", WAY: "WAY", EXPY: "EXPRESSWAY", FWY: "FREEWAY",
};

function keyOf(text: string): string {
  return text.toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
}

/** Candidate lookup keys, because the index carries both the county's short and long forms. */
function keysFor(street: string): string[] {
  const base = keyOf(street);
  const out = [base];
  const parts = base.split(" ");
  const last = parts[parts.length - 1];
  if (SUFFIX[last]) out.push([...parts.slice(0, -1), SUFFIX[last]].join(" "));
  for (const [short, long] of Object.entries(SUFFIX)) {
    if (last === long) out.push([...parts.slice(0, -1), short].join(" "));
  }
  return [...new Set(out)];
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

type Resolved = { entry: StreetEntry; typed: string } | { miss: string };

function resolve(index: StreetIndex, query: string): Resolved {
  const raw = query.trim();
  if (!raw) return { miss: "Type a street name or an address." };
  // A house number narrows the app's answer; here it is stripped so the street still resolves.
  const street = raw.replace(/^\d+[A-Za-z]?\s+/, "");
  for (const key of keysFor(street)) {
    const hit = index.by_key[key];
    if (hit) return { entry: hit, typed: raw };
  }
  const target = keyOf(street);
  const near = Object.keys(index.by_key)
    .map((k) => ({ k, d: editDistance(target, k) }))
    .filter((x) => x.d <= 2 || x.k.includes(target) || target.includes(x.k))
    .sort((a, b) => a.d - b.d)[0];
  return {
    miss: near
      ? `No modelled street called “${street.trim()}”. Did you mean ${index.by_key[near.k].name}?`
      : `“${street.trim()}” is not one of the modelled streets. Try a street name from the map.`,
  };
}

/* --------------------------------------------------------------------- boot --- */

async function readGauge() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(GAUGE, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`gauge ${res.status}`);
    const j = (await res.json()) as {
      observed?: { data?: { validTime: string; primary: number }[] };
      forecast?: { data?: { validTime: string; primary: number }[] };
    };
    const obs = j.observed?.data ?? [];
    const last = obs[obs.length - 1];
    if (!last || !Number.isFinite(Number(last.primary))) throw new Error("no reading");
    const fc = j.forecast?.data ?? [];
    const peak = fc.reduce((m, p) => Math.max(m, Number(p.primary) || -Infinity), -Infinity);
    return { stage: Number(last.primary), at: last.validTime, peak: Number.isFinite(peak) ? peak : null };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function boot() {
  document.documentElement.classList.add("js");

  let history: History | null = null;
  let live: { stage: number; at: string; peak: number | null } | null = null;
  let street: StreetEntry | null = null;
  let index: StreetIndex | null = null;

  const cap = $<HTMLParagraphElement>("railCap");
  const probeNote = $<HTMLParagraphElement>("probeNote");
  const probeLink = $<HTMLParagraphElement>("probeLink");
  const probeHref = $<HTMLAnchorElement>("probeHref");

  const rail = buildRail((ft) => { cap.textContent = caption(history, ft, street); });
  /* The rail is above the fold, so it is never observed — but its ticks still carry the
   * `html.js` entry animation, whose "done" state is the `.in` class on an ancestor. Without
   * this the whole scale stays at scaleX(0): a gauge with no ticks, which is what the page
   * shipped until someone looked at it. */
  document.querySelector(".rail")?.classList.add("in");

  const paintHero = () => {
    $("stageNow").textContent = live ? fmt(live.stage) : "—";
    $("heroSub").innerHTML = heroSentence(live);
  };
  paintHero();

  /* Registered BEFORE the first await. The form has an `action` so it works with no script at
   * all, which means a submit that lands while the gauge is still in flight would navigate to
   * the app and skip this page's own answer — a race a visitor on a slow connection can
   * actually hit, and the browser suite hit it on its first run. */
  $<HTMLFormElement>("probe").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = $<HTMLInputElement>("addr").value.trim();
    if (!raw) {
      probeNote.className = "probe-note bad";
      probeNote.textContent = "Type a street name or an address.";
      return;
    }
    if (!index) index = await readJson<StreetIndex>(STREETS);
    if (!index) {
      probeNote.className = "probe-note bad";
      probeNote.textContent = "The street list could not be loaded. The map still works.";
      return;
    }
    const found = resolve(index, raw);
    if ("miss" in found) {
      probeNote.className = "probe-note bad";
      probeNote.textContent = found.miss;
      probeLink.hidden = true;
      rail.setStreet(null);
      return;
    }
    street = found.entry;
    rail.setStreet(street);
    // The dot lands on the street's FIRST segment to flood, which is what the app shows for a
    // bare street name; a house number is resolved to the nearest segment by the app itself.
    const house = /^\d/.test(raw);
    probeNote.className = "probe-note ok";
    probeNote.textContent = house
      ? `${street.name} floods at ${fmt(street.min_ft)} ft on its earliest segment. The full answer picks the segment nearest the number you gave.`
      : `${street.name} floods at ${fmt(street.min_ft)} ft. That is where the red dot sits.`;
    probeHref.href = `./app?addr=${encodeURIComponent(raw)}`;
    probeLink.hidden = false;
    cap.textContent = caption(history, rail.stage(), street);
  });

  const [h, l, v] = await Promise.allSettled([
    readJson<History>(HISTORY), readGauge(), readJson<Validation>(VALIDATION),
  ]);
  history = h.status === "fulfilled" ? h.value : null;
  live = l.status === "fulfilled" ? l.value : null;
  // The clause still reads if the artifact is missing; it just does not put a number on it.
  const lift = v.status === "fulfilled" ? v.value?.diagnosis?.threshold_error_model?.lift_ft : null;
  if (typeof lift === "number" && Number.isFinite(lift)) {
    $("biasFt").textContent = ` by about ${Math.abs(lift).toFixed(0)} ft`;
  }
  paintHero();
  /* No reading, no needle: a mark at 8.5 ft would be this page inventing an observation.
   * The scale and its ticks still stand, which is the whole point of the gauge. */
  if (live) {
    rail.setStage(live.stage, { silent: true });
    document.querySelector(".rail")?.classList.add("rail-ready");
  }
  if (street) rail.setStreet(street);
  cap.textContent = caption(history, rail.stage(), street);

  // Reveals: opt-in from here, so a failed script leaves the page readable (see landing.css).
  const sections = [...document.querySelectorAll<HTMLElement>(".meaning,.case,.limits")];
  sections.forEach((s) => s.classList.add("reveal"));
  document.querySelectorAll<HTMLElement>(".hero .eyebrow,.hero .thesis,.hero .hero-sub,.hero .probe")
    .forEach((el, i) => { el.classList.add("reveal"); el.style.setProperty("--d", String(i)); });

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -12% 0px" });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
  } else {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
  }
}

void boot();
