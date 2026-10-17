/* BrazosCast — the deployed entrypoint.
 *
 * The app is a prebuilt static bundle (app/dist): HTML, the content-hashed entry chunk,
 * the map chunk, the service worker, and the 11-file data payload the page fetches. There
 * is no server-side rendering and no runtime data fetch of our own — the browser reads the
 * live NOAA gauge directly (CORS is open on that endpoint) and every other number is
 * precomputed into the payload.
 *
 * So this Worker has exactly one job: hand the request to the assets binding, and add the
 * headers the app depends on and a static host does not necessarily provide:
 *
 *   * `sw.js` must never be cached by the CDN, or a browser can be pinned to an old service
 *     worker and never see a new build — the one failure a service worker makes hard to
 *     escape without the user clearing site data.
 *   * the payload (`/data/*.json`, `.geojson`) is revalidated rather than cached hard, because
 *     a stale thresholds file would answer about a river the app no longer models.
 *   * the HTML is revalidated for the same reason: it names the hashed chunks.
 *
 * The index is served for an unknown path (single-page app), and the service worker's own
 * scope is the origin root, which is why `?text=1` and the share links are ordinary URLs.
 */

const NO_STORE = "no-cache, must-revalidate";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const res = await env.ASSETS.fetch(request);

    // A 404 from the assets binding on a navigation is the SPA case: serve the shell so a
    // shared link that carries a query the app understands is not answered with a 404 page.
    if (res.status === 404 && request.mode === "navigate") {
      return withHeaders(await env.ASSETS.fetch(new URL("/index.html", url)), url, true);
    }
    return withHeaders(res, url, res.status === 200);
  },
};

function withHeaders(res, url, ok) {
  if (!ok) return res;
  const headers = new Headers(res.headers);
  const path = url.pathname;
  if (path.endsWith("/sw.js") || path.endsWith("index.html") || path === "/" || path.endsWith("/")) {
    headers.set("cache-control", NO_STORE);
  } else if (/\/data\/[^/]+\.(json|geojson)$/.test(path)) {
    // The payload is copied into the service worker's cache on first use, so the CDN copy is
    // only a first-visit concern — and a first visit must not get yesterday's thresholds.
    headers.set("cache-control", NO_STORE);
  } else if (/\/assets\/.+-[A-Za-z0-9_]{8}\.(js|css)$/.test(path)) {
    // Content-hashed, so it can never disagree with the HTML that names it.
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  headers.set("x-brazoscast", "static");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
