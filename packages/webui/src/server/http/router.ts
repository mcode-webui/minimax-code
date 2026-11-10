// HTTP router for the loopback service: dispatch one admitted request to the
// session-transfer, workspace-file or static client-asset route. Split from
// `service.ts` with no behaviour change — the admission order, route order,
// status codes and bodies are the ones the service wrote before.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  credentialPresented,
  type WebuiCredential,
} from "../credentials.js";
import {
  admitHttpRequest,
  credentialRequired,
  hostnameFromHostHeader,
} from "../access-policy.js";
import { rejectHttp, parseHttpUrl } from "./responses.js";
import { serveClientAsset } from "./client-assets.js";
import { serveBrowserExtensionPackage } from "./browser-extension.js";
import { handleSessionTransfer, handleSessionImport } from "./session-transfer.js";
import { handleWebuiShutdown } from "./shutdown.js";
import { serveWorkspaceFile } from "./workspace-file.js";
import type { WebuiHarnessPort } from "../../runtime/port.js";
import type { WebuiBrowserExtensionPackage } from "../browser-bridge/extension-package.js";

export interface WebuiHttpRouterContext {
  readonly host: string;
  /** The TCP port the kernel allocated, once `start()` has resolved. */
  readonly boundTcpPort: () => number | undefined;
  /** The configured TCP port, used as the client-asset fallback before bind. */
  readonly configuredTcpPort: number;
  readonly credential: WebuiCredential;
  readonly dev: boolean;
  readonly fullAccess?: boolean;
  readonly clientDir: string | undefined;
  /**
   * The extension package this host offers for download.
   *
   * Absent when this host carries no extension: the route then says so
   * rather than serving an empty package.
   */
  readonly browserExtensionPackage?: WebuiBrowserExtensionPackage;
  readonly port: WebuiHarnessPort;
  /**
   * The host's answer to a request to stop the server.
   *
   * The service owns its listener, not the process: the host that assembled
   * it does. Absent when the host has no such answer -- the service embedded
   * in an application that outlives it -- and the shutdown route then refuses
   * rather than stopping something nobody offered to stop.
   */
  readonly requestShutdown?: () => void;
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
  // Development mode drops the credential for the loopback interface only.
  // A request that arrived on another interface has to present it unless full
  // access was explicitly selected: the service reads files and runs a terminal, and a wider bind
  // publishes both (ADR 0031). The credential arrives in the query or in
  // the cookie the page response set.
  const requestHostname = hostnameFromHostHeader(request.headers.host ?? "");
  if (
    credentialRequired(requestHostname, context.dev, context.fullAccess) &&
    !credentialPresented(
      context.credential,
      url?.searchParams.get("token"),
      request.headers.cookie,
    )
  ) {
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
  // The page's own request to stop the server. It sits after the loopback,
  // origin and credential checks so it inherits them, and it asks the credential
  // again: stopping the process is not a privilege the ordinary routes hand
  // out on loopback.
  if (request.method === "POST" && url.pathname === "/webui-shutdown") {
    handleWebuiShutdown(request, response, url, {
      credential: context.credential,
      fullAccess: context.fullAccess === true,
      ...(context.requestShutdown
        ? { requestShutdown: context.requestShutdown }
        : {}),
    });
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
  // The extension package is a download the person takes away: the browser
  // cannot install an extension for them, so the host hands them the build
  // this host speaks to. It answers HEAD as well as GET, for the same reason
  // the workspace-file route does, and it sits after the loopback, origin and
  // credential checks so it inherits them.
  if (url.pathname === "/browser-extension") {
    await serveBrowserExtensionPackage(
      request,
      response,
      context.browserExtensionPackage,
    );
    return;
  }
  if (request.method !== "GET") {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  const name =
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/archon" ||
    // A standalone Mini App is an ordinary client document; ADR 0020 gives it a
    // route of its own (`/miniapp?plugin=&session=`) and the shell decides what
    // it renders. Mapping it here is what makes the deep link a page rather than
    // a 404.
    url.pathname === "/miniapp"
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
    token: context.fullAccess ? "" : context.credential.token,
    dataDir: context.port.version().dataDir,
    // The address the person reached the page on, not the bound address: a
    // wildcard bind has no address of its own to hand the browser.
    requestHost: request.headers.host,
  });
}
