// Static client asset serving for the loopback service: resolve the requested
// `index.html` / `client.js` / `styles.css` / `assets/*` / `fonts/*` name under
// the client directory, inject the runtime config into `index.html`, and write
// the bytes. Split from `service.ts` with no behaviour change.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

import {
  hostnameFromHostHeader,
  portFromHostHeader,
} from "../access-policy.js";
import { credentialCookie } from "../credentials.js";
import { rejectHttp } from "./responses.js";

export interface WebuiClientAssetContext {
  readonly clientDir: string | undefined;
  readonly host: string;
  readonly tcpPort: number;
  readonly token: string;
  readonly dataDir: string | undefined;
  /**
   * The `Host` header the page was requested with. The browser connects
   * back over the address it reached the page on, so a wildcard bind hands
   * the page the address the person used rather than `0.0.0.0`.
   */
  readonly requestHost?: string;
}

export async function serveClientAsset(
  response: ServerResponse,
  url: URL,
  name: string,
  context: WebuiClientAssetContext,
): Promise<void> {
  try {
    const clientDir = findClientDirectory(context.clientDir);
    const fileName = resolveClientAsset(clientDir, url.pathname, name);
    if (!fileName) {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    let body = await readFile(fileName);
    if (name === "index.html") {
      const config = JSON.stringify({
        websocketUrl: websocketUrl(context),
        token: context.token,
        dataDir: context.dataDir,
      }).replace(/</gu, "\\u003c");
      body = Buffer.from(body.toString("utf8").replace(
        "</head>",
        `<script>window.__WEBUI_CONFIG__=${config};</script></head>`,
      ));
    }
    response.writeHead(200, {
      "Content-Type": contentType(fileName),
      "Cache-Control": "no-store",
      // The page's own relative requests carry the credential in this
      // cookie: a browser that opened the page with the token in the query
      // asks for ./client.js without it, and on a non-loopback interface
      // that request would otherwise be refused.
      ...(name === "index.html" && context.token ? { "Set-Cookie": credentialCookie(context.token) } : {}),
    });
    response.end(body);
  } catch {
    rejectHttp(response, 404, "Not Found");
  }
}

/**
 * The WebSocket endpoint the page connects back to.
 *
 * The address in the `Host` header wins over the bound address: a service
 * bound to `0.0.0.0` has no address of its own, and a browser that reached
 * the page at `192.168.1.20:2233` has to reach the socket at the same one.
 */
export function websocketUrl(context: WebuiClientAssetContext): string {
  const requestHost = context.requestHost;
  const hostname = requestHost ? hostnameFromHostHeader(requestHost) : "";
  if (!hostname) return `ws://${context.host}:${context.tcpPort}`;
  const port = (requestHost ? portFromHostHeader(requestHost) : undefined) ?? context.tcpPort;
  const literal = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `ws://${literal}:${port}`;
}

export function contentType(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".woff")) return "font/woff";
  if (name.endsWith(".ttf")) return "font/ttf";
  return name.endsWith(".css")
    ? "text/css; charset=utf-8"
    : name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
}

export function resolveClientAsset(
  clientDir: string,
  pathname: string,
  fallbackName: string,
): string | undefined {
  if (fallbackName === "index.html" || fallbackName === "client.js" || fallbackName === "styles.css")
    return path.join(clientDir, fallbackName);
  const prefix = pathname.startsWith("/assets/")
    ? "/assets/"
    : pathname.startsWith("/fonts/")
      ? "/fonts/"
      : undefined;
  if (!prefix) return undefined;
  const relativeName = pathname.slice(prefix.length);
  if (!relativeName || relativeName.includes("\\") || relativeName.split("/").includes(".."))
    return undefined;
  const candidate = path.resolve(clientDir, prefix.slice(1), relativeName);
  const root = path.resolve(clientDir) + path.sep;
  return candidate.startsWith(root) ? candidate : undefined;
}

export function findClientDirectory(override: string | undefined): string {
  // Caller-supplied override wins so tests pin the served directory and the
  // dev preview launcher can point at the built artifacts; if it does not
  // exist we fall back to the discovery below rather than 404 the page.
  if (override && existsSync(override)) return override;
  // The two candidate depths are unchanged from `service.ts`: this module sits
  // one directory deeper (`server/http/`), so each path reaches one level
  // further up to resolve to the same absolute directory as before.
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client"),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../dist-webui/client",
    ),
  ];
  // The built server uses the first path; source tests and development use the second.
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}
