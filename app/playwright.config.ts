import { defineConfig, devices } from "@playwright/test";

/**
 * BrazosCast — the browser half of the test suite (T7).
 *
 * Everything `scripts/check.sh` could check until now came from reading source, executing
 * modules in Node, or diffing artifacts. Five claims live only in a browser: that the app
 * BOOTS under a gauge it can and cannot read, that the staleness regimes reach the screen
 * as the right sentence next to the right badge, that an address resolves to a route, that
 * a reload with the network off still answers — and what a drag COSTS, which no reading or
 * in-process execution can measure (tests/e2e/perf.spec.ts). Those were driven by hand; here
 * they are one command.
 *
 * The suite runs against the BUILT app on purpose. A dev server is not what ships: the
 * service worker does not register there, the module graph is not the shipped one, and the
 * minified HTML is a different document. That means no `window.brazoscast` dev hook, so
 * every assertion below reads the DOM a user would see.
 *
 * Two projects, because the service worker has to be off for one and on for the other:
 *
 *   app      — `serviceWorkers: "block"`. These tests intercept the gauge over the network,
 *              and a worker between the page and the route would serve its own cache first,
 *              making the stub intermittently irrelevant. Blocking it also proves the app
 *              boots with no worker at all.
 *   offline  — `serviceWorkers: "allow"`, because that spec is ABOUT the worker. It talks to
 *              the ORIGIN GATE instead of the preview server directly (see
 *              tests/e2e/origin-gate.mjs), because an outage has to be real: `setOffline`
 *              stops the page but not the worker's own fetches, so an "offline" reload would
 *              still be refreshing from a live origin. The live gauge's host is made
 *              unresolvable for this project, since its stubbing cannot be done from here
 *              either — Playwright does not route the worker's inner requests.
 */
const PORT = 4187;
const BASE = `http://127.0.0.1:${PORT}`;
/** The origin gate: the same app, behind a switch that can take the origin away. */
const GATE_PORT = 4199;
const GATE = `http://127.0.0.1:${GATE_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // One server, and the offline spec wants a cache store of its own; parallel workers would
  // share both and make failures depend on ordering.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { baseURL: BASE, trace: "retain-on-failure" },
  webServer: [
    {
      // Build first, so this can never pass or fail against a stale `dist/`: a browser suite
      // that tests the previous build is the trap this project has already been bitten by
      // (see the payload-sync step in scripts/check.sh).
      command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
      url: BASE,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `node tests/e2e/origin-gate.mjs`,
      url: `${GATE}/__gate`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "app",
      testIgnore: /offline\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
    },
    {
      name: "offline",
      testMatch: /offline\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: GATE,
        serviceWorkers: "allow",
        // The live gauge is removed at the DNS layer: it has to be unreachable for the
        // worker as well as the page, and nothing in Playwright can do that at runtime.
        launchOptions: {
          args: ["--host-resolver-rules=MAP api.water.noaa.gov ~NOTFOUND"],
        },
      },
    },
  ],
});
