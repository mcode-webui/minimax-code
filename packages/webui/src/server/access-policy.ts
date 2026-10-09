// Admission policy for the loopback service: which host, URL host, origin and
// credential the HTTP and WebSocket surfaces accept. Split from `service.ts`
// (plan section 7.1) with no behaviour change — every decision, rejection
// status and response/socket byte is the one the service wrote before.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { credentialMatches, type WebuiCredential } from "./credentials.js";
import { rejectHttp } from "./http/responses.js";

export interface WebuiAdmissionContext {
  readonly host: string;
  /** The TCP port the service bound, once `start()` has resolved. */
  readonly tcpPort: () => number | undefined;
  readonly credential: WebuiCredential;
  readonly dev: boolean;
}

/**
 * Loopback host and origin admission for one HTTP request. Rejects in place
 * and returns `false` when the request is refused; returns `true` when the
 * caller may route it. The credential check stays with the router because it
 * needs the parsed request URL.
 */
export function admitHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: WebuiAdmissionContext,
): boolean {
  const requestHost = (request.headers.host ?? "").toLowerCase();
  const requestOrigin = (request.headers.origin ?? "").toLowerCase();
  if (!requestHost || !isLoopbackHost(requestHost.split(":")[0] ?? "")) {
    rejectHttp(response, 403, "Forbidden Host");
    return false;
  }
  if (
    requestOrigin &&
    !isAllowedOrigin(requestOrigin, context.host, context.tcpPort())
  ) {
    rejectHttp(response, 403, "Forbidden Origin");
    return false;
  }
  return true;
}

/**
 * Loopback host, URL host, origin and credential admission for one WebSocket
 * upgrade. Rejects on the socket and returns `false` when refused.
 */
export function admitWebSocketUpgrade(
  request: IncomingMessage,
  url: URL,
  socket: Duplex,
  context: WebuiAdmissionContext,
): boolean {
  const urlHost = url.hostname.toLowerCase();
  const requestHost = (request.headers.host ?? "").toLowerCase();
  const requestOrigin = (request.headers.origin ?? "").toLowerCase();
  if (!requestHost || !isLoopbackHost(requestHost.split(":")[0] ?? "")) {
    rejectUpgrade(socket, 403, "Forbidden Host");
    return false;
  }
  if (urlHost !== "127.0.0.1" && urlHost !== "localhost") {
    rejectUpgrade(socket, 403, "Forbidden Host");
    return false;
  }
  if (
    requestOrigin &&
    !isAllowedOrigin(requestOrigin, context.host, context.tcpPort())
  ) {
    rejectUpgrade(socket, 403, "Forbidden Origin");
    return false;
  }
  const presented = url.searchParams.get("token");
  if (!context.dev && !credentialMatches(context.credential, presented)) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return false;
  }
  return true;
}

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const reasonLine = reason.replace(/[\r\n]/gu, " ");
  socket.write(`HTTP/1.1 ${status} ${reasonLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function parseWebSocketUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    const base = "ws://127.0.0.1";
    return new URL(rawUrl, base);
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

export function isLoopbackBindAddress(host: string): boolean {
  // The service binds loopback only. `0.0.0.0` and any LAN address are
  // rejected before the HTTP server is constructed so the misconfiguration
  // surfaces at boot, not at the first upgrade.
  if (isLoopbackHost(host)) return true;
  // IPv6 zone IDs (`fe80::1%lo0`, `::1%1`) are loopback-shaped for the
  // purpose of the bind; strip the zone before re-checking.
  const stripped = host.split("%")[0] ?? host;
  return isLoopbackHost(stripped);
}

export function isAllowedOrigin(origin: string, host: string, port?: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (port === undefined) return true;
  const portNumber = parsed.port
    ? Number(parsed.port)
    : defaultPortForProtocol(protocol);
  return portNumber === port && parsed.hostname === host;
}

function defaultPortForProtocol(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}
