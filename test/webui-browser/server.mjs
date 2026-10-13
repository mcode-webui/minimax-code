import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installFixtureTransport } from "./fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist-webui/client");
const port = 4179;
const serverId = process.env.WEBUI_BROWSER_SERVER_ID ?? randomUUID();

/** The entry files the built client references by name. */
const ROOT_ASSETS = ["index.html", "client.js", "styles.css"];

/**
 * Resolve a request path to a file under the built client directory, or
 * `undefined` when it falls outside the served set.
 *
 * The set mirrors the loopback service's static resolver (`resolveClientAsset`
 * in `packages/webui/src/server/http/client-assets.ts`): the three entry names
 * plus the `assets/` prefix. That prefix is where the client build emits its
 * lazily loaded chunks — the transcript pulls the diagram library in through
 * a dynamic `import()`, and `scripts/build-webui.mjs` keeps it out of
 * `client.js` as an `assets/` chunk — so the fixture must serve what the real
 * service serves or the diagram tests would 404 on the chunk.
 */
function resolveServedFile(pathname) {
  const name = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  if (ROOT_ASSETS.includes(name)) return path.join(root, name);
  if (!name.startsWith("assets/")) return undefined;
  const relative = name.slice("assets/".length);
  if (!relative || relative.includes("\\") || relative.split("/").includes("..")) return undefined;
  const candidate = path.resolve(root, "assets", relative);
  return candidate.startsWith(path.resolve(root) + path.sep) ? candidate : undefined;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", serverId }));
    return;
  }
  const file = resolveServedFile(pathname);
  if (!file) {
    response.writeHead(404).end("not found");
    return;
  }
  try {
    let body = await readFile(file);
    if (path.basename(file) === "index.html") {
      const html = body.toString().replace(
        "</head>",
        `<script>window.__WEBUI_TEST_SERVER_ID__=${JSON.stringify(serverId)};window.__WEBUI_CONFIG__={websocketUrl:"ws://fixture.invalid",token:"synthetic-token"};(${installFixtureTransport.toString()})();for(const setup of window.__WEBUI_FIXTURE_SETUP__??[])setup();</script></head>`,
      );
      body = Buffer.from(html);
    }
    const contentType = file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end("built WebUI artifact not found; run pnpm build:webui first");
  }
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
