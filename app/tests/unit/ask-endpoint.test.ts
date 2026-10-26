import { afterEach, describe, expect, test, vi } from "vitest";
import handler from "../../api/ask";

/* The endpoint, driven without a network.
 *
 * Three things here are worth a test rather than a code read: that the key is read server-side
 * and its absence fails CLOSED (503, not a crash and not a proxied call), that the model's
 * output is re-validated before it reaches the page, and that a hostile origin or a runaway
 * client is refused before any request is spent. The alias below is the only "key" that exists
 * in this file, and it is never sent anywhere: fetch is stubbed in every test.
 */

type Out = { status: number; body: unknown; headers: Record<string, string> };

function res(): { res: Record<string, unknown>; out: Out } {
  const out: Out = { status: 0, body: null, headers: {} };
  const r = {
    status(code: number) { out.status = code; return r; },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; },
    json(b: unknown) { out.body = b; },
    end() { /* unused: json is always the writer here */ },
  };
  return { res: r, out };
}

let ip = 0;
function req(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const ipv4 = `10.0.0.${++ip}`;
  return {
    method,
    headers: { host: "brazoscast.example", "x-forwarded-for": ipv4, "content-type": "application/json", ...headers },
    body,
  };
}

/** A Gemini-shaped reply whose single candidate holds `text`. */
function gemini(text: string): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  delete process.env.GEMINI_API_KEY;
});

describe("Ask endpoint — fails closed", () => {
  test("no key is a 503 and makes no upstream call at all", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { res: r, out } = res();
    await handler(req({ action: "parse", question: "Jackson Street?" }) as never, r as never);
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ ok: false, error: "unavailable" });
    expect(spy).not.toHaveBeenCalled();
    expect(out.headers["cache-control"]).toBe("no-store");
  });

  test("a foreign Origin is refused before the key is touched", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { res: r, out } = res();
    await handler(req({ action: "parse", question: "x" },
      { origin: "https://evil.example" }) as never, r as never);
    expect(out.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  test("GET is not an Ask request", async () => {
    const { res: r, out } = res();
    await handler(req(null, {}, "GET") as never, r as never);
    expect(out.status).toBe(405);
  });

  test("a runaway client is stopped at the window, not at the model", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const spy = vi.fn(async () => gemini('{"intent":"unsupported","streets":[],"clarify":null}'));
    vi.stubGlobal("fetch", spy);
    const fixed = { host: "brazoscast.example", "x-forwarded-for": "192.0.2.77" };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { res: r, out } = res();
      await handler(req({ action: "parse", question: "anything" }, fixed) as never, r as never);
      codes.push(out.status);
    }
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
    expect(spy).toHaveBeenCalledTimes(6);
  });
});

describe("Ask endpoint — the model's output is re-validated", () => {
  test("a structured request is cleaned before it is returned", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => gemini(JSON.stringify({
      intent: "explain",
      // Four names and a stage no river in this corridor has: the endpoint keeps three and
      // refuses the stage rather than passing a hallucinated level to the page.
      streets: ["Jackson Street", "Skinner Lane", "Chew Road", "Nowhere Road"],
      stage_ft: 400,
      mode: "replay",
      clarify: "  why?  ",
    }))));
    const { res: r, out } = res();
    await handler(req({ action: "parse", question: "which streets flood?" }) as never, r as never);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      request: {
        intent: "explain",
        streets: ["Jackson Street", "Skinner Lane", "Chew Road"],
        stage_ft: null,
        mode: "replay",
        clarify: "why?",
      },
    });
  });

  test("an unrecognised intent becomes unsupported, never a guess", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => gemini('{"intent":"do_something_else","streets":[]}')));
    const { res: r, out } = res();
    await handler(req({ action: "parse", question: "hello" }) as never, r as never);
    expect(out.body).toMatchObject({ ok: true, request: { intent: "unsupported", stage_ft: null } });
  });

  test("prose for the panel comes back trimmed and fenced-free", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => gemini("```\nWater is modelled to reach the street.\n```")));
    const { res: r, out } = res();
    await handler(req({
      action: "narrate", mode: "live",
      street: { name: "Jackson Street", osmid: 1, segments: 2 },
      figures: [{ label: "x", value: "1 ft", kind: "modelled", source: "s", at: "a", limitation: "l" }],
    }) as never, r as never);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, prose: "Water is modelled to reach the street." });
  });

  test("the narration request carries figures and segment ids — never an address", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return gemini("Two sentences.");
    }));
    const { res: r } = res();
    await handler(req({
      action: "narrate", mode: "live",
      street: { name: "Jackson Street", osmid: 4242, segments: 3 },
      figures: [{ label: "l", value: "1 ft", kind: "modelled", source: "s", at: "a", limitation: "b" }],
    }) as never, r as never);
    expect(sent).toContain("4242");
    expect(sent).not.toMatch(/\d{3,5}\s+Jackson/i);
  });

  test("an upstream 5xx twice is unavailable, and a rejected key is not retried", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const busy = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", busy);
    const a = res();
    await handler(req({ action: "parse", question: "x" }) as never, a.res as never);
    expect(a.out.status).toBe(503);
    expect(busy).toHaveBeenCalledTimes(2);   // one retry, then the panel's sentence

    const denied = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", denied);
    const b = res();
    await handler(req({ action: "parse", question: "x" }) as never, b.res as never);
    expect(b.out.status).toBe(503);
    expect(denied).toHaveBeenCalledTimes(1); // a bad key cannot succeed on a second try
  });
});
