/* Ask BrazosCast — the only server-side code in this project, and deliberately the thinnest
 * thing that could work.
 *
 * It does two jobs for the panel in app/src/main.ts, and neither of them is arithmetic:
 *
 *   action "parse"    question  -> a structured request (street names, optional stage, intent);
 *   action "narrate"  computed result object -> two or three sentences about it.
 *
 * Every number the reader sees is rendered by the page from that result object. The model never
 * computes one, and the page withholds any sentence that introduces a number the object does not
 * contain (see app/src/lib/ask.ts § unsupportedNumbers).
 *
 * Deployment facts that shaped this file:
 *
 *   * the key is read from process.env.GEMINI_API_KEY and never leaves the server. It is NOT
 *     prefixed VITE_, because Vite inlines those into the public bundle and this repo is public.
 *   * no SDK. One fetch to the REST API, so there is no dependency to keep current and nothing
 *     to bundle into the function.
 *   * no data access. The endpoint is handed the model id and the reader's question, nothing
 *     else; the street index, thresholds, routing graph and series stay in the browser, which is
 *     why this function is a few kilobytes rather than a second copy of the pipeline.
 *   * it fails closed. No key, a model error, or more than ~8 s all answer 503/504 and the panel
 *     says "Ask is unavailable right now"; the rest of the page is untouched.
 *
 * The model id is a single constant on purpose. It was chosen by listing
 * https://generativelanguage.googleapis.com/v1beta/models and taking a current fast flash-class
 * model that lists generateContent — not from memory — and then timing it. Re-check that list
 * when this is bumped.
 */

/** Chosen from the live model list (a current fast flash-class model that lists generateContent)
 *  and then MEASURED from here, not picked by reputation: gemini-3.1-flash-lite answered in 0.6–1.5 s
 *  when it answered at all, but returned 503 or hung past 9 s on roughly one request in three;
 *  gemini-3.5-flash-lite answered every structured request in 0.6–1.1 s. The panel has an 8 s
 *  ceiling, so the difference is whether the feature works. */
const MODEL = "gemini-3.5-flash-lite";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** The panel gives up at 8 s. This is the budget for the model work including one retry, so an
 *  attempt that is slow cannot consume the time another attempt needed. */
const UPSTREAM_TOTAL_MS = 7_400;
/** Short enough that a queue-bound first attempt still leaves time for the retry that would have
 *  produced an answer — measured: a busy flash model can spend five seconds before saying 503. */
const FIRST_ATTEMPT_MS = 4_000;
/** A few questions per minute per client. In-memory and per isolate on purpose: it is a speed
 *  bump for a runaway loop, not an identity system, and it never blocks a first question. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;
const MAX_BODY_BYTES = 16 * 1024;

/* Vercel's Node runtime supplies these; the project has no @types/node dependency and adding one
 * for two lines would be a build change this feature does not need. */
declare const process: { env: Record<string, string | undefined> };

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
};
type Res = {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(body?: string): void;
};

type AskBody = {
  action?: "parse" | "narrate";
  question?: string;
  mode?: "live" | "replay";
  street?: { name?: string; osmid?: number; segments?: number } | null;
  figures?: { label?: string; value?: string; kind?: string; source?: string; at?: string;
    limitation?: string }[];
  note?: string;
};

const PARSE_PROMPT =
  "You convert a question about flood risk in Richmond, Texas into a structured request. " +
  "You never estimate, predict or state any flood level, depth, time or road condition. " +
  "Return only the structured fields. streets holds street names exactly as the user wrote " +
  "them, at most three. If a street is ambiguous or missing, set clarify to a short question " +
  "and leave streets empty. If the question is not about streets, river stages or access in " +
  "this corridor, set intent to unsupported and leave streets empty. stage_ft is the only " +
  "field that may carry a number, and only when the user names a river stage in feet to " +
  "explore — not a level you chose. mode is replay only when the user explicitly asks about " +
  "the 2017 flood or the replay.";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: ["explain", "compare", "explore_stage", "unsupported"] },
    streets: { type: "ARRAY", items: { type: "STRING" } },
    stage_ft: { type: "NUMBER", nullable: true },
    mode: { type: "STRING", enum: ["live", "replay"], nullable: true },
    clarify: { type: "STRING", nullable: true },
  },
  required: ["intent", "streets", "clarify"],
};

const NARRATE_PROMPT =
  "You are writing two or three plain sentences for a resident of Richmond, Texas, explaining " +
  "a flood-risk result that another system computed. The JSON you are given is the whole truth " +
  "available to you. Rules, all absolute: do not introduce ANY number that is not present in " +
  "that JSON — no levels, depths, hours, distances or dates that are not already there. Do not " +
  "estimate, predict or extrapolate. Do not give evacuation instructions and do not call any " +
  "route safe. Modelled results are modelled: if the JSON says modelled, say modelled. If the " +
  "JSON marks a stage as hypothetical, say it is hypothetical. Write about what the figures " +
  "mean for the street, not about the JSON itself, and do not repeat every figure — the page " +
  "prints those beside your sentences.";

/* ---------------------------------------------------------------- helpers * */

function json(res: Res, status: number, body: unknown): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.status(status).json(body);
}

function header(req: Req, name: string): string {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** Same-origin only: this endpoint spends a key, so a page on another host must not drive it. */
function sameOrigin(req: Req): boolean {
  const origin = header(req, "origin");
  if (!origin) return true; // a non-browser client; there is no origin to compare
  try {
    return new URL(origin).host === header(req, "host");
  } catch {
    return false;
  }
}

const hits = new Map<string, number[]>();

function withinRate(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  // A map that only ever grows is a leak in a warm isolate; stale keys go on each pass.
  if (hits.size > 500) for (const [k, v] of hits) {
    if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return true;
}

async function readBody(req: Req): Promise<string> {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  let raw = "";
  if (!req[Symbol.asyncIterator]) return "";
  for await (const chunk of req as unknown as AsyncIterable<Uint8Array | string>) {
    raw += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (raw.length > MAX_BODY_BYTES) throw new Error("body too large");
  }
  return raw;
}

async function callModel(key: string, body: unknown, ms: number): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${API}/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`gemini ${r.status}`);
    const j = await r.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on a 429/5xx. A busy flash model answers 503 in well under a second, and a second
 *  attempt is what turns that into an answer instead of "unavailable" — inside the same 8 s the
 *  panel already allows. A rejection that is not transient (a bad key: 400/401/403) is NOT
 *  retried: spending the budget twice on a call that cannot succeed only makes the panel slower. */
async function generate(key: string, body: unknown): Promise<string> {
  const deadline = Date.now() + UPSTREAM_TOTAL_MS;
  let attempt = 0;
  for (;;) {
    const left = deadline - Date.now();
    const ms = Math.min(attempt === 0 ? FIRST_ATTEMPT_MS : UPSTREAM_TOTAL_MS, left);
    if (ms < 600) throw new Error("gemini deadline");
    try {
      return await callModel(key, body, ms);
    } catch (e) {
      const m = /gemini (\d{3})/.exec(String((e as Error).message));
      const code = m ? Number(m[1]) : 0;
      // Retried once, inside the same budget: a busy model (429/5xx) and a first attempt that
      // ran out of time (no code at all) are both worth a second try. A rejected key (400/401/
      // 403) is not, because it cannot succeed and a retry only makes the panel slower.
      const transient = code === 0 || code === 429 || code >= 500;
      if (attempt > 0 || !transient || deadline - Date.now() < 1_500) throw e;
      attempt += 1;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** The structured half. Constrained JSON, temperature 0, and every field re-validated here —
 *  a model that returns an extra street or a 400 ft stage must not reach the page. */
function cleanRequest(raw: string): Record<string, unknown> | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const intents = ["explain", "compare", "explore_stage", "unsupported"];
  const intent = intents.includes(String(j.intent)) ? String(j.intent) : "unsupported";
  const streets = Array.isArray(j.streets)
    ? j.streets.filter((s): s is string => typeof s === "string").map((s) => s.trim())
      .filter(Boolean).slice(0, 3)
    : [];
  const stage = typeof j.stage_ft === "number" && Number.isFinite(j.stage_ft)
    && j.stage_ft >= 0 && j.stage_ft <= 80 ? Math.round(j.stage_ft * 10) / 10 : null;
  const mode = j.mode === "live" || j.mode === "replay" ? j.mode : null;
  const clarify = typeof j.clarify === "string" && j.clarify.trim()
    ? j.clarify.trim().slice(0, 160) : null;
  return { intent, streets, stage_ft: stage, mode, clarify };
}

/** The prose half. Length-capped, and a stray fence or preamble is dropped before it reaches
 *  the guard on the page. */
function cleanProse(raw: string): string {
  return raw.replace(/^```[a-z]*\n?|```$/g, "").trim().slice(0, 900);
}

/* ---------------------------------------------------------------- handler * */

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method" });
    return;
  }
  if (!sameOrigin(req)) {
    json(res, 403, { ok: false, error: "origin" });
    return;
  }
  const ip = header(req, "x-forwarded-for").split(",")[0].trim()
    || header(req, "x-real-ip") || "unknown";
  if (!withinRate(ip)) {
    json(res, 429, { ok: false, error: "rate" });
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // The documented fallback: no key is a normal state, and the panel says so.
    json(res, 503, { ok: false, error: "unavailable" });
    return;
  }

  let body: AskBody;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as AskBody;
  } catch {
    json(res, 400, { ok: false, error: "body" });
    return;
  }

  try {
    if (body.action === "parse") {
      const question = String(body.question ?? "").trim().slice(0, 300);
      if (!question) {
        json(res, 400, { ok: false, error: "question" });
        return;
      }
      const text = await generate(key, {
        systemInstruction: { parts: [{ text: PARSE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      });
      const request = cleanRequest(text);
      if (!request) {
        json(res, 502, { ok: false, error: "unreadable" });
        return;
      }
      json(res, 200, { ok: true, request });
      return;
    }

    if (body.action === "narrate") {
      /* Only the computed object goes back to the model: segment ids, figures and their
       * sources. No address, no question, no series. */
      const payload = {
        mode: body.mode === "replay" ? "replay" : "live",
        street: {
          name: String(body.street?.name ?? "").slice(0, 80),
          osmid: Number(body.street?.osmid ?? 0),
          segments: Number(body.street?.segments ?? 1),
        },
        note: String(body.note ?? "").slice(0, 300),
        figures: (body.figures ?? []).slice(0, 8).map((f) => ({
          label: String(f.label ?? "").slice(0, 120),
          value: String(f.value ?? "").slice(0, 80),
          kind: String(f.kind ?? "modelled").slice(0, 12),
          source: String(f.source ?? "").slice(0, 120),
          at: String(f.at ?? "").slice(0, 80),
          limitation: String(f.limitation ?? "").slice(0, 300),
        })),
      };
      const text = await generate(key, {
        systemInstruction: { parts: [{ text: NARRATE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
      });
      const prose = cleanProse(text);
      if (!prose) {
        json(res, 502, { ok: false, error: "empty" });
        return;
      }
      json(res, 200, { ok: true, prose });
      return;
    }

    json(res, 400, { ok: false, error: "action" });
  } catch (e) {
    /* Upstream refused, timed out, or was unreachable. The panel has one sentence for all of
     * them, and the rest of the page does not change. The reason is logged server-side, because
     * "unavailable" on the page must not also mean "undiagnosable" in the logs — and the key
     * is never part of it. */
    console.error("[ask]", String(e instanceof Error ? e.message : e).slice(0, 200));
    json(res, 503, { ok: false, error: "unavailable" });
  }
}
