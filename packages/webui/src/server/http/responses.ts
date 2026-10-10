// HTTP response helpers for the loopback service: the plain-text rejection
// writer, the JSON success writer and the request-URL parser. Split from
// `service.ts` (plan section 7.1) with no behaviour change — the status codes,
// headers and bodies are the ones the service wrote before.

import type { ServerResponse } from "node:http";

export function rejectHttp(
  response: ServerResponse,
  status: number,
  reason: string,
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
  });
  response.end(reason);
}

export function respondJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.byteLength,
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

export function parseHttpUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }
}
