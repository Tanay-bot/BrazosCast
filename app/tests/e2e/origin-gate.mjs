/* The origin gate — test-only infrastructure for the outage spec.
 *
 * `context.setOffline(true)` is not an outage. It stops the PAGE, but the worker keeps its
 * own network: measured, the worker's inner fetches still left the machine, which means an
 * "offline" reload was quietly refreshing from a live origin and a missing file came back
 * with a status instead of a network error. A test that passes that way proves nothing about
 * the cache, and the whole point of F6 is the reload when the origin is GONE.
 *
 * So the app is served through this: a pass-through that forwards every request to the real
 * preview server, and — on command — stops answering at all by destroying the socket. A
 * destroyed socket is what a client sees when the server is unreachable, which is the storm
 * being tested; a 503 would be an origin that answered, and the worker treats those two
 * differently on purpose.
 *
 *   GET /__gate          → the current state
 *   GET /__gate?down=1   → stop answering (every later request, from the page or the worker)
 *   GET /__gate?up=1     → resume
 *
 * The worker's other origin (the live gauge) is removed at launch instead, with
 * `--host-resolver-rules` in playwright.config.ts, because DNS is not something a test can
 * flip at runtime and it has to be dead for page and worker alike.
 */
import http from "node:http";

const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.GATE_UPSTREAM_PORT ?? 4187) };
const PORT = Number(process.env.GATE_PORT ?? 4199);

let down = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${UPSTREAM.host}:${UPSTREAM.port}`);
  if (url.pathname === "/__gate") {
    if (url.searchParams.has("down")) down = true;
    if (url.searchParams.has("up")) down = false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ down }));
    return;
  }
  if (down) {
    /* Not a response: no response. The socket goes away, so the client sees EXACTLY what an
     * unreachable server looks like — a failed fetch, not a bad status. */
    req.socket.destroy();
    return;
  }
  const headers = { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
  const up = http.request({ ...UPSTREAM, path: req.url, method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  up.on("error", () => req.socket.destroy());
  req.pipe(up);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`origin gate on ${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}`);
});
