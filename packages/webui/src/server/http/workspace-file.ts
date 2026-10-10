// Workspace file route for the loopback service: serve one workspace file as a
// byte-range-capable HTTP resource. Split from `service.ts` (plan section 7.1)
// with no behaviour change — the path containment check, the range parsing and
// the status codes, headers and bodies are the ones the service wrote before.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { rejectHttp } from "./responses.js";

/**
 * Serve one workspace file as a byte-range-capable HTTP resource.
 *
 * Media preview and HTML preview both need a URL the browser streams rather
 * than a base64 payload inside a JSON reply: `<video>` and `<audio>` cannot
 * scrub a progress bar without `Range`, and inlining a large file inflates
 * every response that merely mentions it.
 *
 * Dispatch happens after the loopback, origin and credential checks, so this
 * inherits them instead of re-implementing them: a workspace file is served to
 * whoever holds the per-start token and to nobody else.
 */
export async function serveWorkspaceFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    rejectHttp(response, 405, "Method Not Allowed");
    return;
  }
  const dir = url.searchParams.get("dir");
  const relative = url.searchParams.get("path");
  if (!dir || !relative) {
    rejectHttp(response, 400, "Missing dir or path");
    return;
  }
  const root = path.resolve(dir);
  const target = path.resolve(root, relative);
  // `path.resolve` has already collapsed every `..`, so what is left to
  // reject is the cases that survive it: an absolute `path`, or a sibling
  // that merely shares a prefix (`/repo-evil` against root `/repo`).
  if (target !== root && !target.startsWith(root + path.sep)) {
    rejectHttp(response, 403, "Forbidden Path");
    return;
  }
  let stats;
  try {
    stats = await stat(target);
  } catch {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  if (!stats.isFile()) {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  const total = stats.size;
  const range = parseByteRange(request.headers.range, total);
  if (range === "invalid") {
    response.writeHead(416, { "Content-Range": `bytes */${total}` });
    response.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const headers: Record<string, string> = {
    "Content-Type": workspaceContentType(target),
    "Content-Length": String(end - start + 1),
    // A partial body is only correct for the bytes it was cut from, so a
    // later edit must not let a cached range be replayed against.
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    // Without allow-same-origin the document runs in an opaque origin, so
    // script inside a previewed artifact cannot read the page that framed
    // it — including `window.__WEBUI_CONFIG__.token`, which would hand it
    // the whole WebUI session.
    "Content-Security-Policy": workspaceContentType(target).startsWith("text/html")
      ? "sandbox allow-scripts"
      : "sandbox",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  // A zero-byte file has no last byte, so `end` above is -1 and there is no
  // legal `end` to hand a read stream: `createReadStream` rejects it with
  // ERR_OUT_OF_RANGE, which rejects this promise and — since the caller only
  // `void`s the dispatch — surfaces as an unhandled rejection and takes the
  // process down. The `Content-Length: 0` already sent above is the whole
  // body, so just end the response.
  if (total === 0) {
    response.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(target, { start, end });
    stream.on("error", () => {
      response.destroy();
      resolve();
    });
    stream.on("close", resolve);
    stream.pipe(response);
  });
}

const WORKSPACE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".csv": "text/csv; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function workspaceContentType(name: string): string {
  return WORKSPACE_MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function parseByteRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return undefined;
  // No byte of a zero-length representation can be selected, so any range
  // against one is unsatisfiable. Handled here rather than in the two
  // branches below because the suffix branch would otherwise answer with
  // `{start: 0, end: -1}` — a range whose header cannot even be spelled.
  if (size === 0) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    // Suffix form `bytes=-500`: the final N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return "invalid";
  if (start >= size) return "invalid";
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}
