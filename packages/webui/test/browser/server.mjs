import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installFixtureTransport } from "./fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../dist-webui/client");
const port = 4179;
const serverId = process.env.WEBUI_BROWSER_SERVER_ID ?? randomUUID();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", serverId }));
    return;
  }
  // Chunks live under `assets/` once the client bundle is split (the
  // transcript's Mermaid library and the composer's slash palette are both
  // dynamic imports). The real service already resolves that prefix
  // (`packages/webui/src/server/http/client-assets.ts`); the test server
  // has to as well, or every lazily loaded chunk 404s in the browser suite.
  const isAsset = pathname.startsWith("/assets/");
  // The document routes this client serves. `/miniapp` is ADR 0020's standalone
  // presentation: the real service maps it to the same bundle
  // (`packages/webui/src/server/http/router.ts`), so the harness has to as well or
  // the popup in the browser suite 404s.
  const isDocument =
    pathname === "/" || pathname === "/index.html" || pathname === "/archon" || pathname === "/miniapp";
  const name = isDocument ? "index.html" : path.basename(pathname);
  if (!isAsset && !["index.html", "client.js", "styles.css"].includes(name)) {
    response.writeHead(404).end("not found");
    return;
  }
  try {
    let body = await readFile(path.join(root, isAsset ? `.${pathname}` : name));
    if (name === "index.html") {
      const html = body.toString().replace(
        "</head>",
        `<script>window.__WEBUI_TEST_SERVER_ID__=${JSON.stringify(serverId)};window.__WEBUI_CONFIG__={websocketUrl:"ws://127.0.0.1:${port}",token:"synthetic-token"};(${installFixtureTransport.toString()})();for(const setup of window.__WEBUI_FIXTURE_SETUP__??[])setup();</script></head>`,
      );
      body = Buffer.from(html);
    }
    const contentType = name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404).end("built WebUI artifact not found; run pnpm build:webui first");
  }
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
