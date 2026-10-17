import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * `/app` is the app's published address: a one-line rewrite in production (app/vercel.json).
 * The dev server and `vite preview` have to answer the same URL, or the browser suite would be
 * testing a document path that never ships — and `base: "./"` means the page must be served
 * WITHOUT a trailing slash, because relative asset URLs resolve against `/` there.
 */
function appRoute(): Plugin {
  const rewrite = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/app" || url.pathname === "/app/") {
      req.url = `/app.html${url.search}`;
    }
    next();
  };
  return {
    name: "brazoscast-app-route",
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  // Relative paths keep the build deployable at a subpath (Cloudflare Pages, GitHub Pages).
  base: "./",
  plugins: [appRoute()],
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
    // Two documents: the landing at `/` and the app at `/app`. Two entries also keep the
    // landing's chunk out of the app's, so the storm page never pays for the homepage.
    rollupOptions: { input: { landing: "index.html", app: "app.html" } },
  },
  server: { port: 5173 },
});
