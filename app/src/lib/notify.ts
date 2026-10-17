/* F7 — the alert text, filled in the browser.
 *
 * The strings are NOT written here. They are compiled at build time by
 * pipeline/derive/notifications.py from pipeline/notify/templates.json and shipped inside
 * data/notifications.json, so the text a phone would show is the text a test rendered.
 * This module fills the same placeholders the pipeline fills, and
 * pipeline/tests/test_notifications.py requires the two renderers to agree character for
 * character on the artifact's verification streets — including the time format and the
 * quiet-hours hold. A Spanish alert whose numbers drifted from the English one is the
 * failure this arrangement exists to make untestable.
 *
 * It knows nothing about the page: no DOM, no fetch, no state. That is what lets
 * app/tests/unit/notifications.test.ts run it under Node against the shipped artifact.
 */

export type Lang = "en" | "es";

export type TemplateSet = {
  tiers: { id: string; hours_before: number; label: Record<Lang, string>;
    purpose: Record<Lang, string> }[];
  templates: Record<Lang, Record<string, string>>;
  placeholders: string[];
  fallback_street: Record<Lang, string>;
  category_es: Record<string, string>;
  ui: Record<Lang, Record<string, string>>;
  policy: {
    quiet_hours: { from_local_hour: number; to_local_hour: number; exempt: string[] };
    max_chars: number;
  };
};

/** The values a template takes. `category` is the ENGLISH category name in both
 *  languages, because that is the unit the pipeline and the app both compute; `fill()`
 *  translates it, exactly as the Python renderer does. */
export type AlertValues = {
  street: string; stage: string; river: string; category: string;
  hours: string; when: string;
};

const MONTH = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
};

const TZ = "America/Chicago";

/** Local calendar parts, read through Intl so the browser's own tz database decides. */
function localParts(ms: number): { day: string; month: number; hour: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return { day: p.day, month: Number(p.month), hour: Number(p.hour) };
}

/** The crossing time, in the message's language.
 *
 *  Twelve-hour in both languages with a short month name and no digits in it, so the
 *  English and Spanish messages carry the same numerals — the digit-parity gate compares
 *  what a person reads. The Spanish am/pm is unpunctuated because a trailing period
 *  collided with the sentence period ("2 p.m.."). */
export function formatWhen(ms: number, lang: Lang): string {
  const { day, month, hour } = localParts(ms);
  const h12 = hour % 12 || 12;
  const ampm = lang === "es" ? (hour < 12 ? "am" : "pm") : (hour < 12 ? "AM" : "PM");
  return lang === "es"
    ? `${day} ${MONTH.es[month - 1]}, ${h12} ${ampm}`
    : `${MONTH.en[month - 1]} ${day}, ${h12} ${ampm}`;
}

/** Fill one template. Throws on a placeholder mismatch rather than rendering `{stage}`
 *  into a message that tells someone to leave. */
export function fill(tpl: string, lang: Lang, ts: TemplateSet, values: AlertValues): string {
  const want = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const have = Object.keys(values).sort();
  if (want.length && want.join(",") !== have.join(",")) {
    throw new Error(`${lang} template wants ${want.join(",")} but got ${have.join(",")}`);
  }
  const v: Record<string, string> = { ...values };
  if (lang === "es") {
    const es = ts.category_es[values.category];
    if (!es) throw new Error(`no Spanish category for ${values.category}`);
    v.category = es;
  }
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => v[k]);
}

/** The local hour at an instant, in the policy's timezone. */
export function localHour(ms: number): number {
  return localParts(ms).hour;
}

/** When a tier's message actually goes out, and whether quiet hours moved it.
 *
 *  Policy: 22:00–07:00 local holds the first two tiers to 07:00; the 6-hour alert is
 *  exempt. A held message that would land after the street floods is dropped, not sent
 *  late — `null` means it is not sent at all. Mirrors `next_local_seven` and the loop in
 *  pipeline/derive/notifications.py. */
export function scheduleSend(
  crossAt: number, hoursBefore: number, tier: string, ts: TemplateSet,
): { at: number; deferredFrom: number | null } | null {
  const q = ts.policy.quiet_hours;
  let at = crossAt - hoursBefore * 3_600_000;
  if (q.exempt.includes(tier)) return { at, deferredFrom: null };
  const h = localHour(at);
  if (!(h >= q.from_local_hour || h < q.to_local_hour)) return { at, deferredFrom: null };
  // The next 07:00 local. Walking an hour at a time avoids doing timezone arithmetic by
  // hand and is exact here: DST never changes the hour at which 07:00 is 07:00.
  const deferredFrom = at;
  let held = at;
  for (let i = 0; i < 24 && localHour(held) !== q.to_local_hour; i++) held += 3_600_000;
  if (localHour(held) !== q.to_local_hour || held >= crossAt) return null;
  at = held;
  return { at, deferredFrom };
}

/** The three messages for one street, in one language, at one crossing. */
export type Filled = { tier: string; hoursBefore: number; at: number; deferredFrom: number | null;
  text: string; values: AlertValues };

export function messagesFor(
  ts: TemplateSet, lang: Lang, street: string, threshold: number,
  riverAt: (ms: number) => number | null, categoryOf: (stage: number) => string,
  crossAt: number,
): Filled[] {
  const out: Filled[] = [];
  for (const t of ts.tiers) {
    const sched = scheduleSend(crossAt, t.hours_before, t.id, ts);
    if (!sched) continue;
    const river = riverAt(sched.at);
    if (river === null) continue;
    const values: AlertValues = {
      street: street || ts.fallback_street[lang],
      stage: threshold.toFixed(1),
      river: river.toFixed(1),
      category: categoryOf(river),
      hours: String(t.hours_before),
      when: formatWhen(crossAt, lang),
    };
    out.push({
      tier: t.id, hoursBefore: t.hours_before, at: sched.at,
      deferredFrom: sched.deferredFrom,
      text: fill(ts.templates[lang][t.id], lang, ts, values), values,
    });
  }
  return out;
}

/** The digits in a string, as a multiset key. The parity gate's unit: two messages about
 *  the same street at the same hour must carry the same numbers, whatever the language. */
export function digitKey(text: string): string {
  return (text.match(/\d/g) ?? []).sort().join("");
}
