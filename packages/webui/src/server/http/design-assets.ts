import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebuiHarnessPort } from "../../runtime/port.js";
import { parseByteRange } from "./workspace-file.js";
import { rejectHttp, respondJson } from "./responses.js";
import { readRequestBody } from "./session-transfer.js";
import { DESIGN_MAX_HTTP_ACTION_BYTES, DESIGN_MAX_KEEPALIVE_BYTES } from "../../shared/design-input.js";
import { applyDesignActionOperation } from "../operation/design.js";

/** Large media retains the same validation and runtime authority as the wire action. */
export async function applyDesignMediaAction(request: IncomingMessage, response: ServerResponse, port: WebuiHarnessPort): Promise<void> {
  if (request.method !== "POST") { respondJson(response, 405, { code: "invalid_request", message: "Method Not Allowed" }); return; }
  if (Number(request.headers["content-length"] ?? 0) > DESIGN_MAX_HTTP_ACTION_BYTES) { response.setHeader("Connection", "close"); respondJson(response, 413, { code: "payload_too_large", message: "Design media action exceeds the 96 MiB JSON limit" }); request.resume(); return; }
  try {
    const bytes = await readRequestBody(request, DESIGN_MAX_HTTP_ACTION_BYTES, { keepConnectionOnLimit: true });
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { respondJson(response, 400, { code: "invalid_body", message: "Design action body must be JSON" }); return; }
    const validated = applyDesignActionOperation.validate(value);
    if (!validated.ok) { respondJson(response, 400, { code: validated.code, message: validated.message }); return; }
    if (!["upload", "publish", "set_media_poster", "save_draft_edits"].includes(validated.body.action.type)) { respondJson(response, 400, { code: "invalid_body", message: "Only media uploads and compact close-page drafts use the Design media endpoint" }); return; }
    if (validated.body.action.type === "save_draft_edits" && bytes.byteLength > DESIGN_MAX_KEEPALIVE_BYTES) { respondJson(response, 413, { code: "payload_too_large", message: "Design close-page draft exceeds the 64 KiB JSON limit" }); return; }
    const result = await port.applyDesignAction(validated.body);
    respondJson(response, 200, { ...result });
  } catch (error) {
    const failure = error as { readonly code?: unknown; readonly message?: unknown };
    const code = typeof failure?.code === "string" ? failure.code : "harness_error";
    const message = typeof failure?.message === "string" ? failure.message : String(error);
    if (code === "payload_too_large") response.setHeader("Connection", "close");
    respondJson(response, code === "payload_too_large" ? 413 : code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : code === "INVALID_ARGUMENTS" || code === "MEDIA_MISSING" ? 400 : 500, { code, message });
  }
}

/** Authenticated native Design bytes; paths and file IO remain runtime-owned. */
export async function serveDesignAsset(request: IncomingMessage, response: ServerResponse, url: URL, port: WebuiHarnessPort): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") { rejectHttp(response, 405, "Method Not Allowed"); return; }
  const match = /^\/design-assets\/(assets|uploads)\/([A-Za-z0-9][\w.-]*)$/.exec(url.pathname);
  if (!match) { rejectHttp(response, 400, "Invalid Design asset"); return; }
  const asset = await port.readDesignAsset({ kind: match[1] as "assets" | "uploads", name: match[2] });
  if (!asset) { rejectHttp(response, 404, "Not Found"); return; }
  const total = asset.bytes.byteLength;
  const range = parseByteRange(request.headers.range, total);
  if (range === "invalid") { response.writeHead(416, { "Content-Range": `bytes */${total}` }); response.end(); return; }
  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  const download = url.searchParams.get("download");
  response.writeHead(range ? 206 : 200, { "Content-Type": asset.mimeType, "Content-Length": Math.max(0, end - start + 1), "Cache-Control": "no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}), ...(download ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.replace(/[\r\n]/g, ""))}` } : {}) });
  response.end(request.method === "HEAD" ? undefined : asset.bytes.subarray(start, end + 1));
}
