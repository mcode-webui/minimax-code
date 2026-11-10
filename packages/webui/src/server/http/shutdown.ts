// The shutdown route: the page's own request to stop the local server.
//
// The service owns the HTTP listener but not the process: the host that
// assembled it does. This route is therefore a *request*, not an action. It
// answers, and then asks the host to stop. A host that has no such answer --
// the service embedded in the desktop app, whose process is not the server's
// to end -- refuses the route instead of pretending.
//
// The credential is required even where the loopback interface would not
// normally ask for one. This route ends the process, and "any local process
// can stop the server" is not a privilege the ordinary routes hand out.

import type { IncomingMessage, ServerResponse } from "node:http";

import { credentialPresented, type WebuiCredential } from "../credentials.js";
import { rejectHttp } from "./responses.js";

export interface WebuiShutdownRouteOptions {
  readonly credential: WebuiCredential;
  /** Full access is the explicit "no credential" mode; it applies here too. */
  readonly fullAccess: boolean;
  /**
   * The host's answer to "stop now".
   *
   * Absent when the host has none, and the route then says it has none rather
   * than stopping something the host did not offer to stop.
   */
  readonly requestShutdown?: () => void;
}

export function handleWebuiShutdown(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: WebuiShutdownRouteOptions,
): void {
  if (!options.requestShutdown) {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  if (
    !options.fullAccess &&
    !credentialPresented(
      options.credential,
      url.searchParams.get("token"),
      request.headers.cookie,
    )
  ) {
    rejectHttp(response, 401, "Unauthorized");
    return;
  }
  // The answer goes out before the host stops: a request refused by a closed
  // listener looks like a crash to the page that asked.
  response.end(JSON.stringify({ ok: true, closing: true }), () => {
    setTimeout(() => options.requestShutdown?.(), 100);
  });
}
