import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths keep the build deployable at a subpath (Cloudflare Pages, GitHub Pages).
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
  },
  server: { port: 5173 },
});
