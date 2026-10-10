// Session import — read a transfer file and turn it back into a session.
//
// Responsibility (plan §7.2 `client/infrastructure/session-import.ts`; ticket
// #51): this is **browser file IO and HTTP upload**. It reads a picked file,
// rejects a format it cannot restore, and posts it; it decides nothing about the
// session's identity or where it belongs — the agent and workspace come from the
// caller's context. That business decision and the rail's import request live in
// `application/session-workflows.ts`, which receives this importer as an injected
// capability (type `WebuiSessionImporter`) from the composition root, so this
// adapter is never absorbed into a business workflow module.
//
// The counterpart of `GET /session-transfer`. That route writes a
// `mcode-webui-session-transfer@1` file; this posts one to
// `POST /session-import` and gets back the id of a session that holds the
// same history again.
//
// Two things this deliberately does not do:
//
//   - It does not read the file's `session.agentName` or `session.workspaceDir`.
//     The server ignores them too. A downloaded file is untrusted input: if
//     it could name the working directory, importing a file would aim a
//     session at an arbitrary directory on this machine. The agent and
//     workspace come from the context the user is importing into.
//
//   - It does not accept the older client-side export,
//     `mcode-webui-session@1`. That format carries the display layer only, so
//     replaying it would produce a session the user can read but the model
//     cannot -- worse than refusing, because it looks like it worked. It is
//     rejected here by name rather than as a generic parse failure, so the
//     user is told which file they picked and why it cannot come back.

import { WEBUI_SESSION_TRANSFER_FORMAT } from "../../shared/session-transfer-format.js";
import { readWebuiSessionTransferTarget } from "./session-transfer-target.js";

export interface WebuiSessionImportResult {
  readonly sessionId: string;
  readonly canonicalMessages: number;
  readonly displayMessages: number;
  readonly revision: string;
}

/** The client-side export format, which carries no canonical history. */
export const WEBUI_LEGACY_CLIENT_EXPORT_FORMAT = "mcode-webui-session@1";

/** Refused for a reason the user can act on, as opposed to a parse failure. */
export class WebuiSessionImportRefused extends Error {
  override readonly name = "WebuiSessionImportRefused";
  constructor(
    readonly reason: "not-a-transfer-file" | "legacy-client-export" | "not-json" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export interface WebuiSessionImportOptions {
  readonly agentName?: string;
  readonly workspaceDir?: string;
  readonly signal?: AbortSignal;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly origin?: string;
  readonly token?: string;
}

/**
 * Reject before uploading.
 *
 * A transfer file of a real session runs to tens of megabytes. Posting one
 * only to be told the format tag is wrong wastes the user's time and the
 * server's disk, so the tag is checked here where it costs a parse the
 * browser had to do anyway to read the file.
 */
export function assertWebuiTransferFile(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // Reached only after `JSON.parse` succeeded, so the bytes were JSON -- they
    // were just not a transfer file. Saying "not JSON" here would blame the
    // file for something it did not do.
    throw new WebuiSessionImportRefused("not-a-transfer-file", "所选文件不是会话导出文件。");
  }
  const format = (value as { readonly format?: unknown }).format;
  if (format === WEBUI_SESSION_TRANSFER_FORMAT) return;
  if (format === WEBUI_LEGACY_CLIENT_EXPORT_FORMAT) {
    throw new WebuiSessionImportRefused(
      "legacy-client-export",
      "这是旧版导出的会话文件，只包含显示记录、没有模型上下文，无法还原。请用服务端导出的 .transfer.json 文件。",
    );
  }
  throw new WebuiSessionImportRefused("not-a-transfer-file", "这不是会话导出文件。");
}

export async function importWebuiSessionFile(
  file: Blob,
  options: WebuiSessionImportOptions = {},
): Promise<WebuiSessionImportResult> {
  // Presence is checked, not truthiness: an injected empty token is a valid
  // dev target, and falling back to the global for it would silently ignore the
  // caller's origin.
  const target =
    options.origin !== undefined && options.token !== undefined
      ? { origin: options.origin, token: options.token }
      : readWebuiSessionTransferTarget();
  if (!target) {
    throw new WebuiSessionImportRefused("unreadable", "当前 WebUI 未连接运行时，无法导入。");
  }

  let text: string;
  try {
    text = await file.text();
  } catch (reason: unknown) {
    throw new WebuiSessionImportRefused(
      "unreadable",
      reason instanceof Error ? reason.message : String(reason),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebuiSessionImportRefused("not-json", "所选文件不是有效的 JSON。");
  }
  assertWebuiTransferFile(parsed);

  const query = new URLSearchParams({ token: target.token });
  // Identity comes from the caller's context, never from the payload.
  if (options.agentName) query.set("agentName", options.agentName);
  if (options.workspaceDir) query.set("workspaceDir", options.workspaceDir);

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${target.origin}/session-import?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const body = (await response.json().catch(() => ({}))) as Partial<WebuiSessionImportResult> & {
    readonly error?: string;
  };
  if (!response.ok) {
    throw new WebuiSessionImportRefused(
      response.status === 400 ? "not-a-transfer-file" : "unreadable",
      typeof body.error === "string" ? body.error : `导入失败（HTTP ${response.status}）`,
    );
  }
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    throw new WebuiSessionImportRefused("unreadable", "导入没有返回会话 ID。");
  }
  return {
    sessionId: body.sessionId,
    canonicalMessages: body.canonicalMessages ?? 0,
    displayMessages: body.displayMessages ?? 0,
    revision: body.revision ?? "",
  };
}
