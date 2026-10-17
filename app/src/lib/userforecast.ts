/* I4 — bring your own forecast.
 *
 * The obvious question about any product that reads a forecast is "why should I trust yours
 * instead of the NWS's?". The honest answer is that you do not have to: the app's rule is a
 * comparison between the stage series and one number per street, so any series works. This module
 * is the parser for that series and the splice that puts it in place of the forecast half.
 *
 * Two things it deliberately does NOT do. It does not touch the observed half — the replay
 * hydrograph or the gauge's own readings are observations, and letting a pasted series overwrite
 * them would make the lead time a statement about the paste rather than about the river. And it
 * does not guess: a line it cannot read is reported with its line number and the count of skipped
 * lines is shown, because a silently dropped point would move a crossing time and nothing on
 * screen would say so.
 *
 * Nothing here is stored: the series lives in memory for the session and never enters the URL or
 * the page's own storage, which the state contract (pipeline/tests/test_app_state_contract.py)
 * requires of the address and this feature inherits.
 */
import type { Pt } from "./series";

export type ParsedForecast = {
  points: Pt[];
  /** Lines that could not be read, by 1-based line number, with the text that failed. */
  errors: { line: number; text: string; why: string }[];
  /** Points dropped for being outside the accepted horizon. */
  tooFar: number;
  /** Duplicate timestamps collapsed, last value winning. */
  duplicates: number;
};

export const MAX_USER_HOURS = 240;
export const MIN_USER_POINTS = 3;

/** A number and nothing else: "34.2", "+36", "-0.5". Anything with a stray character in it is
 *  a line this parser should refuse rather than salvage, because a salvaged number moves a
 *  crossing time and nothing on screen would say so. */
const num = (s: string) => (/^[-+]?\d*\.?\d+$/.test(s) ? Number(s) : null);

/** `2026-10-18T06:00, 34.2` · `+36, 34.2` · `36, 34.2` · `36 34.2` — one point per line.
 *  A time is either an ISO instant or hours from `now`; a bare number is hours, because that is
 *  what a model's own output looks like and nobody typing twelve points wants to write 2017. */
export function parseForecast(text: string, now: number,
  maxHours = MAX_USER_HOURS): ParsedForecast {
  const points: Pt[] = [];
  const errors: ParsedForecast["errors"] = [];
  let tooFar = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    // One time and one stage, separated by a comma, a tab, a semicolon or spaces. Two tokens
    // and only two: a third would be a line this parser is guessing about.
    const parts = line.split(/\s*[,;\t]\s*|\s+/).filter(Boolean);
    if (parts.length !== 2) {
      errors.push({ line: idx + 1, text: line,
        why: parts.length < 2 ? "expected a time and a stage" : "more than two values" });
      return;
    }
    const [tRaw, vRaw] = parts;
    const v = num(vRaw);
    if (v === null) {
      errors.push({ line: idx + 1, text: line, why: `"${vRaw}" is not a stage` });
      return;
    }
    let t: number;
    // A time with no zone is read as UTC rather than as the viewer's local time, because the
    // same pasted forecast has to mean the same instant in Richmond and in the browser of
    // whoever the link was sent to. The help text says so; "+6" sidesteps it entirely.
    const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(tRaw) && !/(Z|[+-]\d{2}:?\d{2})$/.test(tRaw);
    const iso = Date.parse(naive ? `${tRaw.replace(" ", "T")}Z` : tRaw);
    if (Number.isFinite(iso) && /\d{4}-\d{2}-\d{2}/.test(tRaw)) {
      t = iso;
    } else {
      const hours = num(tRaw);
      if (hours === null) {
        errors.push({ line: idx + 1, text: line, why: `"${tRaw}" is not a time or an hour offset` });
        return;
      }
      t = now + hours * 3_600_000;
    }
    if (t < now - 3_600_000) {
      errors.push({ line: idx + 1, text: line, why: "that time has already passed" });
      return;
    }
    if ((t - now) / 3_600_000 > maxHours) { tooFar++; return; }
    points.push({ t, v, kind: "fc" });
  });

  points.sort((a, b) => a.t - b.t);
  let duplicates = 0;
  const dedup: Pt[] = [];
  for (const p of points) {
    const last = dedup[dedup.length - 1];
    if (last && last.t === p.t) { dedup[dedup.length - 1] = p; duplicates++; continue; }
    dedup.push(p);
  }
  return { points: dedup, errors, tooFar, duplicates };
}

export type AppliedForecast = {
  /** The series the app should use: observations, then the pasted points. */
  series: Pt[];
  /** How many pasted points replaced the forecast, and what the replaced run claimed. */
  replaced: number;
  replacedPeakFt: number | null;
  note: string;
};

/** Replace the forecast half with the pasted points, keeping every observation. Null when the
 *  paste cannot stand in for a forecast (too few points, or a series with nothing observed). */
export function applyUserForecast(series: readonly Pt[], user: readonly Pt[],
  minPoints = MIN_USER_POINTS): AppliedForecast | null {
  if (user.length < minPoints) return null;
  const observed = series.filter((p) => p.kind === "obs");
  if (!observed.length) return null;
  const forecast = series.filter((p) => p.kind === "fc");
  // Only forecast points that come after the last observation are replaced; an observation
  // cannot be overwritten by a paste, and a pasted point before the last reading is not a
  // forecast at all.
  const lastObs = observed[observed.length - 1].t;
  const replacedRun = forecast.filter((p) => p.t > lastObs);
  const adopted = user.filter((p) => p.t > lastObs);
  if (adopted.length < minPoints) return null;
  const merged = [...observed, ...adopted];
  return {
    series: merged,
    replaced: replacedRun.length,
    replacedPeakFt: replacedRun.length
      ? Math.round(Math.max(...replacedRun.map((p) => p.v)) * 100) / 100 : null,
    note: replacedRun.length
      ? `${adopted.length} pasted points replaced ${replacedRun.length} forecast points ` +
        `(which peaked at ${Math.round(Math.max(...replacedRun.map((p) => p.v)) * 100) / 100} ft).`
      : `${adopted.length} pasted points added; this series had no forecast to replace.`,
  };
}
