import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction } from "../../scripts/lib/release-metadata.mjs";
import { packageExportEntries } from "../../scripts/lib/package-exports.mjs";

const serverPort = Number(process.env.WEBUI_SERVER_PORT ?? 8787);
const webuiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webuiRoot, "..", "..");
const clientRoot = path.join(webuiRoot, "src", "client");
const stylesheetPath = path.resolve(repoRoot, "dist-webui", "client", "styles.css");

// Workspace packages publish `exports` pointing at `dist/`, which a source
// checkout never builds. The esbuild build and the Vitest config both map
// specifiers back to `src/` through `package-exports.mjs`; the dev server
// needs the same mapping or bare imports like `@mavis/shared/daily-signin`
// fail to resolve against the missing `dist/`.
const { packageRoots } = readExtraction(repoRoot);
const workspaceAlias = packageExportEntries(repoRoot, packageRoots).map(
  ({ specifier, file }) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement: path.join(repoRoot, file),
  }),
);

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function assetContentTypeFor(relative: string): string | undefined {
  const dot = relative.lastIndexOf(".");
  if (dot < 0) return undefined;
  return ASSET_CONTENT_TYPES[relative.slice(dot).toLowerCase()];
}

function webuiRuntimePlugin() {
  return {
    name: "webui-runtime-config-and-assets",
    transformIndexHtml(html: string) {
      return {
        html,
        tags: [
          {
            tag: "script",
            children:
              "window.__WEBUI_CONFIG__={websocketUrl:`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,token:''};",
            injectTo: "head-prepend",
          },
        ],
      };
    },
    configureServer(server: {
      middlewares: { use: (handler: (...args: never[]) => void) => void };
    }) {
      server.middlewares.use(async (request, response, next) => {
        const [pathname, query = ""] = request.url?.split("?", 2) ?? [""];

        // Requests carrying a query (`?import` and friends) belong to Vite's
        // transform pipeline: a JSON asset imported from the module graph is
        // requested as `...json?import` and must come back as a JavaScript
        // module with a proper MIME type. Serving the raw bytes here instead
        // ships no Content-Type at all, the browser's strict module MIME
        // check fails the import, and the whole dev page fails to mount —
        // the dev-mode symptom behind roadmap item B-2 (slash palette "does
        // not open in dev").
        if (query) {
          next();
          return;
        }
        if (pathname === "/styles.css") {
          try {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/css; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(await readFile(stylesheetPath));
          } catch {
            next();
          }
          return;
        }
        const prefix = pathname.startsWith("/assets/")
          ? "/assets/"
          : pathname.startsWith("/fonts/")
            ? "/fonts/"
            : undefined;
        if (!prefix) {
          next();
          return;
        }
        const relative = pathname.slice(prefix.length);
        if (!relative || relative.includes("\\") || relative.split("/").includes("..")) {
          next();
          return;
        }
        try {
          const sourceRoot =
            prefix === "/fonts/"
              ? path.join(clientRoot, "assets", "fonts", "katex")
              : path.join(clientRoot, "assets");
          const file = await readFile(path.join(sourceRoot, relative));
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          // The middleware answers ahead of Vite's static handler, so the
          // Content-Type Vite would have set has to be set here too; without
          // it fonts and JSON arrive as `application/octet-stream`-ish
          // unknown types and some consumers reject them.
          response.setHeader(
            "Content-Type",
            assetContentTypeFor(relative) ?? "application/octet-stream",
          );
          response.end(file);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  root: "src/client",
  resolve: {
    alias: workspaceAlias,
  },
  esbuild: {
    jsx: "automatic",
  },
  plugins: [webuiRuntimePlugin()],
  server: {
    port: Number(process.env.WEBUI_VITE_PORT ?? 5173),
    proxy: {
      "/ws": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
      // The session transfer routes are plain HTTP, and the dev client is same
      // origin with Vite -- `__WEBUI_CONFIG__.websocketUrl` points back at
      // `location.host`, so an unproxied POST here would land on Vite and 404
      // instead of reaching the server. Production serves the client from the
      // same listener and needs no proxy.
      //
      // Regex keys, not paths: a non-`^` key is a `startsWith` prefix match, and
      // the client module `src/client/session-import.ts` is served at exactly
      // `/session-import.ts`. A `/session-import` key swallowed it, Vite answered
      // that module request with a bare 404, `main.tsx` never evaluated and the
      // shell rendered blank with no console error. The trailing group keeps the
      // query string in the match, because the route URL carries one.
      "^/session-transfer(\\?|$)": {
        target: `http://127.0.0.1:${serverPort}`,
      },
      "^/session-import(\\?|$)": {
        target: `http://127.0.0.1:${serverPort}`,
      },
    },
  },
});
