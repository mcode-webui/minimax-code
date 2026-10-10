// Session transfer routes for the loopback service: export one session as a
// file and recreate a session from a transfer file. Split from `service.ts`
// (plan section 7.1) with no behaviour change — the network-facing half (body
// and query reading, status codes, headers and bodies) is the one the service
// wrote before; the import workflow itself lives in the runtime's
// `session-transfer` module, which owns it.

import type { IncomingMessage, ServerResponse } from "node:http";

import { rejectHttp, respondJson } from "./responses.js";
import {
  webuiSessionTransferFileName,
  importWebuiSessionTransfer,
  WEBUI_DEFAULT_IMPORT_AGENT,
} from "../../runtime/session-transfer.js";
import type { WebuiHarnessPort } from "../../runtime/port.js";
import type { WebuiSessionInfo } from "../../shared/contracts/session.js";

/**
 * The import body is a whole session and real ones run to tens of megabytes,
 * so the cap has to clear the largest export the export route can produce
 * while still refusing a body that is not a session file.
 */
const WEBUI_MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/**
 * `maxBytes` is a parameter rather than a constant so the cap can be tested
 * without allocating a quarter of a gigabyte in a unit test.
 */
export function readRequestBody(
  request: IncomingMessage,
  maxBytes: number = WEBUI_MAX_IMPORT_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * Serve a session as a file that `/session-import` can read back.
 *
 * An HTTP route rather than a WebSocket operation because the file is
 * unbounded: one real session on this machine serialises to 50 MB, and the
 * envelope carries a `payload_too_large` code. Producing the body here also
 * keeps it out of the browser's heap, which is the other half of why the
 * client-side export cannot be reused for this.
 *
 * The payload comes from the runtime rather than from here. An earlier
 * version read `messages.jsonl` off disk and walked `getMessages` for the
 * display side, which needed no port change -- and silently lost the
 * canonical receipts on roughly 1% of rows, because `getMessages` returns a
 * view prepared for rendering, not the stored record.
 */
export async function handleSessionTransfer(
  url: URL,
  response: ServerResponse,
  port: WebuiHarnessPort,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    rejectHttp(response, 400, "Bad Request");
    return;
  }
  // `getSession` rejects for an unknown id rather than returning an empty
  // result, so both the rejection and an empty `session` mean "no such
  // session". Letting the rejection reach the outer catch answered 500 for a
  // request that was simply asking about something that is not there.
  let session: WebuiSessionInfo;
  try {
    const found = await port.getSession({ id: sessionId });
    if (!found.session) {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    session = found.session;
  } catch {
    rejectHttp(response, 404, "Not Found");
    return;
  }
  try {
    const file = await port.exportSessionTransfer({ id: sessionId });
    const body = Buffer.from(`${JSON.stringify(file)}\n`, "utf8");
    const exportedAt = file.exportedAt || new Date().toISOString();
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.byteLength,
      "Content-Disposition":
        `attachment; filename*=UTF-8''${encodeURIComponent(webuiSessionTransferFileName(sessionId, session, exportedAt))}`,
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    rejectHttp(response, 500, "Internal Server Error");
  }
}

/**
 * Recreate a session from a transfer file.
 *
 * The route keeps the network-facing half -- reading the body and the query
 * string -- and delegates the workflow (create, import, title, rollback) to
 * the runtime's `session-transfer` module, which owns it (plan section 7.1).
 * The outcome maps back onto the same status codes and bodies this handler
 * served before the move.
 */
export async function handleSessionImport(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  port: WebuiHarnessPort,
): Promise<void> {
  let file: unknown;
  try {
    const raw = await readRequestBody(request);
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
    // Accept either the bare transfer file or `{ file: <transfer file> }`,
    // so the client does not have to know which one this route prefers.
    file = (parsed as { readonly file?: unknown } | undefined)?.file ?? parsed;
  } catch {
    rejectHttp(response, 400, "Bad Request");
    return;
  }

  const agentName = url.searchParams.get("agentName")?.trim() || WEBUI_DEFAULT_IMPORT_AGENT;
  const workspaceDir = url.searchParams.get("workspaceDir")?.trim() || undefined;

  const outcome = await importWebuiSessionTransfer(port, {
    file,
    agentName,
    workspaceDir,
  });
  if (outcome.kind === "imported") {
    respondJson(response, 200, { ...outcome.body });
    return;
  }
  if (outcome.kind === "create-failed") {
    rejectHttp(response, 500, "Internal Server Error");
    return;
  }
  const foreign = outcome.kind === "not-transfer-file";
  respondJson(response, foreign ? 400 : 422, {
    error: foreign ? "Not a session transfer file" : "Session import failed",
  });
}
