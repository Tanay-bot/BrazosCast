/**
 * Read a JSON response while counting the bytes that have arrived.
 *
 * The flood extent is the one request the map route makes that a user waits on and can
 * see the size of: 450 KB raw, 90.5 KB gzipped, and on a phone it takes a visible
 * moment. `Response.json()` resolves exactly once, at the end, so a loader driven by it
 * could only ever say "working" — this hands the caller the running byte count instead.
 *
 * The count is DECODED bytes; `content-length` describes the encoded body, so the two
 * are not comparable and this deliberately does not compute a percentage from them.
 * A caller can show "62 KB" honestly; "62% of 90 KB" would be a lie on a gzipped
 * response, which is the normal case.
 *
 * Pure and browser-free (Node 18+ has both `Response` and streams), so the chunked path
 * is tested without a page.
 */

export type Progress = {
  /** Bytes of body decoded so far. */
  bytes: number;
  /** The encoded body's length in bytes, when the server states one. */
  total: number | null;
};

export async function readJsonProgress<T>(
  res: Response,
  onProgress?: (p: Progress) => void,
): Promise<T> {
  const stated = Number(res.headers.get("content-length"));
  const total = Number.isFinite(stated) && stated > 0 ? stated : null;

  // A body-less or already-consumed response has nothing to stream. Parse it the ordinary
  // way rather than throwing: the caller's job is the data, the meter is a courtesy.
  if (!res.body) {
    const data = (await res.json()) as T;
    onProgress?.({ bytes: 0, total });
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const tick = () => onProgress?.({ bytes, total });

  tick();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // `value` is undefined only on a done frame, which the branch above took.
    bytes += value?.byteLength ?? 0;
    text += decoder.decode(value, { stream: true });
    tick();
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}
