import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  digitKey, fill, formatWhen, messagesFor, scheduleSend, type TemplateSet,
} from "../../src/lib/notify";

/**
 * F7 — the alert, rendered in the browser exactly as the pipeline rendered it.
 *
 * The templates are compiled at build time (pipeline/derive/notifications.py) and the app
 * fills them at run time, so the strings exist in two implementations. This file holds the
 * TypeScript half to the Python half character for character: same template, same values,
 * same text — and for the Spanish one, the same digits as the English. A translation that
 * drifted one number would be invisible on screen and is the reason this test exists.
 *
 * The expectations are the pipeline's own rows inside the artifact the app is served
 * (app/public/data/notifications.json), not a fixture written here.
 */

const ts = JSON.parse(
  readFileSync(new URL("../../public/data/notifications.json", import.meta.url), "utf8"),
) as unknown as TemplateSet & {
  verification: {
    street: string; threshold_ft: number; crossing_at: string;
    sends: {
      tier: string; send_at: string; deferred_from: string | null; river_ft: number;
      category: string; hours_to_crossing: number;
      values: Record<"en" | "es", {
        street: string; stage: string; river: string; category: string;
        hours: string; when: string }>;
      en: string; es: string;
    }[];
  }[];
};

/** The app's category names, from app/src/main.ts's TH — which
 *  pipeline/tests/test_notifications.py checks against the pipeline's own copy. */
function categoryOf(stage: number): string {
  if (stage >= 50) return "Major flooding";
  if (stage >= 48) return "Moderate flooding";
  if (stage >= 45) return "Minor flooding";
  if (stage >= 20) return "Action stage";
  return "No flooding";
}

const rows = ts.verification.flatMap((v) =>
  v.sends.map((s) => ({ street: v.street, threshold: v.threshold_ft,
    crossing: Date.parse(v.crossing_at), ...s })));

describe("the template is filled identically on both sides", () => {
  test("every verification message is reproduced character for character", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const lang of ["en", "es"] as const) {
        expect(fill(ts.templates[lang][r.tier], lang, ts, r.values[lang])).toBe(r[lang]);
      }
    }
  });

  test("the crossing time is formatted identically to the pipeline's", () => {
    for (const r of rows) {
      for (const lang of ["en", "es"] as const) {
        expect(formatWhen(r.crossing, lang)).toBe(r.values[lang].when);
      }
    }
  });

  test("the Spanish message carries the English message's digits", () => {
    for (const r of rows) {
      expect(digitKey(r.es)).toBe(digitKey(r.en));
    }
  });

  test("every message fits two SMS segments", () => {
    for (const r of rows) {
      expect(r.en.length).toBeLessThanOrEqual(ts.policy.max_chars);
      expect(r.es.length).toBeLessThanOrEqual(ts.policy.max_chars);
    }
  });

  test("the Spanish message says pies, not ft", () => {
    for (const r of rows) expect(r.es).toContain("pies");
  });
});

describe("the quiet-hours schedule is the pipeline's", () => {
  test("every send time and hold matches", () => {
    for (const r of rows) {
      const got = scheduleSend(r.crossing, r.hours_to_crossing, r.tier, ts);
      expect(got).not.toBeNull();
      expect(got!.at).toBe(Date.parse(r.send_at));
      expect(got!.deferredFrom === null ? null : got!.deferredFrom)
        .toBe(r.deferred_from === null ? null : Date.parse(r.deferred_from));
    }
  });

  test("the six-hour tier is never held", () => {
    for (const r of rows) {
      if (r.tier === "now") expect(r.deferred_from).toBeNull();
    }
  });

  test("a held message goes out at 07:00 local, and still before the water", () => {
    for (const r of rows) {
      if (r.deferred_from === null) continue;
      // 07:00 America/Chicago is 12:00 or 13:00 UTC.
      expect(["12:00:00", "13:00:00"]).toContain(new Date(Date.parse(r.send_at))
        .toISOString().slice(11, 19));
      expect(Date.parse(r.send_at)).toBeLessThan(r.crossing);
    }
    // The three verification streets happen to cross in the afternoon, so the hold is
    // exercised here instead of hoped for: a 03:00 local crossing puts both held tiers
    // inside quiet hours.
    const cross = Date.UTC(2017, 7, 27, 8, 0);      // 03:00 CDT
    const early = scheduleSend(cross, 72, "early", ts)!;
    expect(early.deferredFrom).not.toBeNull();
    expect(early.at).toBeGreaterThan(early.deferredFrom!);
    expect(early.at).toBeLessThan(cross);
    expect(new Date(early.at).toISOString().slice(11, 19)).toBe("12:00:00");
    const now = scheduleSend(cross, 6, "now", ts)!;
    expect(now.deferredFrom).toBeNull();
  });

  test("a hold that would land after the water is a drop, not a late text", () => {
    // Unreachable from the shipped 72/24/6 ladder (the longest hold is 9 h and the
    // shortest held tier is 24 h out), so it is exercised with a one-hour window. The
    // branch exists because the alternative on a future ladder is a text after the flood.
    const cross = Date.UTC(2017, 7, 27, 8, 0);      // 03:00 CDT
    expect(scheduleSend(cross, 1, "soon", ts)).toBeNull();
  });
});

describe("the card's three messages", () => {
  test("messagesFor reproduces the pipeline's sends, in order", () => {
    for (const v of ts.verification) {
      const river = new Map<number, number>();
      for (const s of v.sends) river.set(Date.parse(s.send_at), s.river_ft);
      const out = messagesFor(
        ts, "en", v.street, v.threshold_ft,
        (ms) => river.get(ms) ?? null, categoryOf, Date.parse(v.crossing_at),
      );
      expect(out.map((m) => m.tier)).toEqual(v.sends.map((s) => s.tier));
      expect(out.map((m) => m.text)).toEqual(v.sends.map((s) => s.en));
      // And the same three, in Spanish.
      const es = messagesFor(
        ts, "es", v.street, v.threshold_ft,
        (ms) => river.get(ms) ?? null, categoryOf, Date.parse(v.crossing_at),
      );
      expect(es.map((m) => m.text)).toEqual(v.sends.map((s) => s.es));
    }
  });

  test("an unnamed segment falls back to the language's own phrase", () => {
    const cross = Date.parse(ts.verification[0].crossing_at);
    const at = cross - 6 * 3_600_000;
    const riverAt = () => 40;
    const en = messagesFor(ts, "en", "", 45, riverAt, categoryOf, cross);
    const es = messagesFor(ts, "es", "", 45, riverAt, categoryOf, cross);
    expect(en.some((m) => m.text.includes("your street"))).toBe(true);
    expect(es.some((m) => m.text.includes("su calle"))).toBe(true);
    // The fallback is still an alert about a named place in time.
    expect(en[en.length - 1].at).toBeLessThanOrEqual(at);
  });
});

describe("the fill refuses to ship a broken message", () => {
  test("a missing placeholder is an error, not a literal {stage}", () => {
    const bad = { ...rows[0].values.en } as Record<string, string>;
    delete bad.stage;
    expect(() => fill(ts.templates.en.early, "en", ts,
      bad as unknown as typeof rows[0]["values"]["en"])).toThrow();
  });

  test("an unknown category is an error, not the English word in Spanish", () => {
    const v = { ...rows[0].values.es, category: "Catastrophic flooding" };
    expect(() => fill(ts.templates.es.early, "es", ts, v)).toThrow(/Spanish category/);
  });
});
