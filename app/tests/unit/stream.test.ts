import { describe, expect, it } from "vitest";
import { readJsonProgress } from "../../src/lib/stream";

/**
 * The reader the flood layer's meter is driven by.
 *
 * The properties that matter are not "it parses JSON" — `Response.json()` does that — but
 * that it reports bytes AS THEY ARRIVE, that it does not corrupt a multi-byte character
 * split across chunks (a decoder per chunk would), and that it does not pretend the
 * decoded count is a fraction of an encoded `content-length`.
 */

/** A body delivered in the given chunks, so the chunk boundaries are the test input. */
function chunked(parts: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

describe("readJsonProgress", () => {
  it("counts bytes as the body arrives, not only at the end", async () => {
    const body = JSON.stringify({ type: "FeatureCollection", features: new Array(80).fill(0) });
    const encoder = new TextEncoder();
    const raw = encoder.encode(body);
    // Three chunks: the byte count must climb, and the last count is the whole body.
    const parts = [raw.slice(0, 100), raw.slice(100, 400), raw.slice(400)];

    const seen: number[] = [];
    const data = await readJsonProgress<{ features: unknown[] }>(
      chunked(parts),
      (p) => seen.push(p.bytes),
    );

    expect(data.features).toHaveLength(80);
    expect(seen.length).toBeGreaterThanOrEqual(parts.length);
    expect(seen[0]).toBe(0);
    // Monotonic, and ending at exactly the body's length.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(raw.byteLength);
  });

  it("does not corrupt a character split across two chunks", async () => {
    // "×" is two bytes in UTF-8. Split between them: a per-chunk decoder would emit U+FFFD.
    const encoder = new TextEncoder();
    const raw = encoder.encode(JSON.stringify({ label: "2.3× over-draw" }));
    const cut = raw.indexOf(0xc3) + 1;
    expect(cut).toBeGreaterThan(0);

    const data = await readJsonProgress<{ label: string }>(
      chunked([raw.slice(0, cut), raw.slice(cut)]),
    );
    expect(data.label).toBe("2.3× over-draw");
  });

  it("reports content-length as the encoded total, never as a percentage base", async () => {
    // The header describes the encoded body; the count is decoded bytes. On a gzipped
    // response the count passes it, which is why the UI shows KB and not a percentage.
    const encoder = new TextEncoder();
    const raw = encoder.encode(JSON.stringify({ note: "×".repeat(10) }));
    const seen: { bytes: number; total: number | null }[] = [];

    await readJsonProgress(
      chunked([raw], { "content-length": "24" }),
      (p) => seen.push(p),
    );

    expect(seen.at(-1)).toEqual({ bytes: raw.byteLength, total: 24 });
    expect(raw.byteLength).toBeGreaterThan(24);
  });

  it("reports no total when the server states none", async () => {
    const seen: (number | null)[] = [];
    await readJsonProgress(
      chunked([new TextEncoder().encode('{"a":1}')]),
      (p) => seen.push(p.total),
    );
    expect(seen.every((t) => t === null)).toBe(true);
  });

  it("still parses a response whose body is already gone", async () => {
    // Not a real fetch, but the fallback branch has to return the data rather than
    // throw: a consumed or absent body must not break the map.
    const fake = { body: null, headers: new Headers(), json: async () => ({ ok: true }) } as unknown as Response;
    const seen: number[] = [];
    await expect(readJsonProgress(fake, (p) => seen.push(p.bytes))).resolves.toEqual({ ok: true });
    expect(seen).toEqual([0]);
  });
});
