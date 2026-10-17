import { defineConfig } from "vitest/config";

/**
 * BrazosCast — the kernel half of the suite (T3).
 *
 * Two runners, two subjects. Playwright (`playwright.config.ts`) owns `tests/e2e` and drives the
 * BUILT app, because boot order, the service worker and the cost of a drag exist only in a
 * browser. This one owns `tests/unit` and runs the pure kernels over the shipped artifacts, which
 * is where an algorithm implemented twice — once here, once in `pipeline/derive/*.py` — can be
 * checked exactly, row by row, instead of sampled at runtime by a dev hook.
 *
 * `include` is explicit rather than left to vitest's default glob, because that glob also matches
 * the Playwright specs (`tests/e2e/*.spec.ts`); running those without a browser fails in a way
 * that looks like a broken assertion rather than a wrong file.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
