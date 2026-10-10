// HTTP router for the loopback service: dispatch one admitted request to the
// session-transfer, workspace-file or static client-asset route. Split from
// `service.ts` (plan section 7.1) with no behaviour change — the admission
// order, route order, status codes and bodies are the ones the service wrote
// before.

import type { IncomingMessage, ServerResponse } from "node:http";

import { credentialMatches, type WebuiCredential } from "../credentials.js";
import { admitHttpRequest } from "../access-policy.js";
import { rejectHttp, parseHttpUrl } from "./responses.js";
import { serveClientAsset } from "./client-assets.js";
import { handleSessionTransfer, handleSessionImport } from "./session-transfer.js";
import { serveWorkspaceFile } from "./workspace-file.js";
import type { WebuiHarnessPort } from "../../runtime/port.js";

export interface WebuiHttpRouterContext {
  readonly host: string;
  /** The TCP port the kernel allocated, once `start()` has resolved. */
  readonly boundTcpPort: () => number | undefined;
  /** The configured TCP port, used as the client-asset fallback before bind. */
  readonly configuredTcpPort: number;
  readonly credential: WebuiCredential;
  readonly dev: boolean;
  readonly clientDir: string | undefined;
  readonly port: WebuiHarnessPort;
}

export async function serveHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: WebuiHttpRouterContext,
): Promise<void> {
  if (
    !admitHttpRequest(request, response, {
      host: context.host,
      tcpPort: context.boundTcpPort,
      credential: context.credential,
      dev: context.dev,
    })
  ) {
    return;
  }
  const url = parseHttpUrl(request.url);
  const presented = url?.searchParams.get("token");
  if (!context.dev && !credentialMatches(context.credential, presented)) {
    rejectHttp(response, 401, "Unauthorized");
    return;
  }
  if (!url) {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  if (request.method === "GET" && url.pathname === "/session-transfer") {
    await handleSessionTransfer(url, response, context.port);
    return;
  }
  if (request.method === "POST" && url.pathname === "/session-import") {
    await handleSessionImport(request, url, response, context.port);
    return;
  }
  // Ahead of the GET-only gate below because this route also answers HEAD:
  // `serveWorkspaceFile` reports the byte range and content length with no
  // body. It sits after the loopback, origin and credential checks, so it
  // inherits them rather than re-implementing them.
  if (url.pathname === "/workspace-file") {
    await serveWorkspaceFile(request, response, url);
    return;
  }
  if (request.method !== "GET") {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  const name =
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/archon"
      ? "index.html"
      : url.pathname === "/client.js"
        ? "client.js"
        : url.pathname === "/styles.css"
        ? "styles.css"
        : url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")
          ? url.pathname.slice(1)
        : undefined;
  if (!name) {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  await serveClientAsset(response, url, name, {
    clientDir: context.clientDir,
    host: context.host,
    tcpPort: context.boundTcpPort() ?? context.configuredTcpPort,
    token: context.credential.token,
    dataDir: context.port.version().dataDir,
  });
}
