// Round-trip session transfer: the export half of a format that `import` can
// read back.
//
// The client-side `session-export.ts` cannot be used for this. It walks
// `getMessages`, which serves the display projection, and that projection is
// not a superset of the model-facing history:
//
//   - canonical history keeps `toolResult` as its own message. The display
//     projection has no such role at all; it folds the result into the
//     assistant row's `toolCalls[].toolCallResultData` (rendered, ~7x smaller
//     than the raw content).
//   - display-only fields (`rawJson`, `usage`, `actions`, `queryKey`) exist
//     solely because rows are written from the runtime event stream, not
//     derived from the JSONL. Nothing rebuilds them from canonical history.
//
// So a file that must survive a round trip carries both layers, and the
// reader in `import` is responsible for putting each one back where it came
// from. Anything that stores only one of them is lossy in a way the importer
// cannot repair.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
// Port types, not the client's: the server must not reach into client/ for
// shapes, and `getMessages` is declared in terms of these anyway.
import type { WebuiMessage, WebuiSessionInfo } from "./port.js";

export const WEBUI_SESSION_TRANSFER_FORMAT = "mcode-webui-session-transfer@1" as const;

/** One line of `messages.jsonl`, kept verbatim. */
export interface CanonicalEnvelope {
  readonly message_id: string;
  readonly turn_id: string;
  readonly message: unknown;
}

export interface WebuiSessionTransfer {
  readonly format: typeof WEBUI_SESSION_TRANSFER_FORMAT;
  readonly exportedAt: string;
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  };
  /** The model-facing history, in file order. Empty when the session has none. */
  readonly canonical: {
    readonly envelopes: readonly CanonicalEnvelope[];
    readonly activeGeneration?: number;
    readonly activeRevision?: string;
  };
  /** The display projection, oldest first. */
  readonly display: {
    readonly messages: readonly WebuiMessage[];
  };
}

/**
 * Assemble the payload.
 *
 * `sessionId` is passed separately rather than read off `session`: every field
 * on `WebuiSessionInfo` is optional, and the caller already knows the id it
 * asked for. Trusting the port's echo instead would let a session that came
 * back without an id produce a file the importer cannot file.
 */
export function buildSessionTransfer(input: {
  readonly sessionId: string;
  readonly session: WebuiSessionInfo;
  readonly envelopes: readonly CanonicalEnvelope[];
  readonly messages: readonly WebuiMessage[];
  readonly exportedAt: string;
  readonly activeGeneration?: number;
  readonly activeRevision?: string;
}): WebuiSessionTransfer {
  const { session } = input;
  return {
    format: WEBUI_SESSION_TRANSFER_FORMAT,
    exportedAt: input.exportedAt,
    session: {
      sessionId: input.sessionId,
      title: session.title?.trim() || session.agentName || input.sessionId,
      ...(session.agentName ? { agentName: session.agentName } : {}),
      ...(session.workspaceDir ? { workspaceDir: session.workspaceDir } : {}),
      ...(typeof session.createdAt === "number" ? { createdAt: session.createdAt } : {}),
      ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
    },
    canonical: {
      // Copied rather than aliased. The payload is serialised straight after
      // it is built, but holding the caller's array would let anything that
      // touches the payload mutate the reader's data mid-export.
      envelopes: [...input.envelopes],
      ...(typeof input.activeGeneration === "number" ? { activeGeneration: input.activeGeneration } : {}),
      ...(input.activeRevision ? { activeRevision: input.activeRevision } : {}),
    },
    display: { messages: [...input.messages] },
  };
}

/**
 * The directory name a session's history lives under, as the runtime writes
 * it: `<time>-session_<base64(sessionId)>`. The base64 is a pure encoding of
 * the id, so the name can be derived rather than looked up in the database.
 */
export function sessionHistoryDirSuffix(sessionId: string): string {
  return `session_${Buffer.from(sessionId, "utf8").toString("base64").replace(/=+$/u, "")}`;
}

/**
 * Find a session's history directory under `<dataDir>/v2/sessions`.
 *
 * The date segments in the path are assigned when the session is created and
 * are not derivable from the id, so this scans. It prunes to depth 4 and only
 * compares directory names, which keeps a scan of a few thousand sessions in
 * the low tens of milliseconds -- acceptable for a user-initiated download and
 * not worth a new port operation just to avoid it.
 */
export async function locateSessionHistoryDir(
  dataDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const root = join(dataDir, "v2", "sessions");
  const suffix = sessionHistoryDirSuffix(sessionId);
  const stack: { readonly dir: string; readonly depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name.endsWith(suffix)) return child;
      if (depth < 4) stack.push({ dir: child, depth: depth + 1 });
    }
  }
  return undefined;
}

/**
 * Read `messages.jsonl`. Malformed lines are dropped rather than failing the
 * whole export: a truncated tail from a crash should not cost the user the
 * rest of a session, and the importer re-validates everything it is given.
 */
export async function readCanonicalEnvelopes(
  historyDir: string,
): Promise<readonly CanonicalEnvelope[]> {
  let raw: string;
  try {
    raw = await readFile(join(historyDir, "messages.jsonl"), "utf8");
  } catch {
    return [];
  }
  const envelopes: CanonicalEnvelope[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CanonicalEnvelope>;
      if (typeof parsed?.message_id === "string" && typeof parsed?.turn_id === "string") {
        envelopes.push({
          message_id: parsed.message_id,
          turn_id: parsed.turn_id,
          message: parsed.message,
        });
      }
    } catch {
      // Skipped on purpose; see the doc comment.
    }
  }
  return envelopes;
}

/** The generation and revision the active file was published under, if any. */
export async function readHistoryCatalog(
  historyDir: string,
): Promise<{ readonly activeGeneration?: number; readonly activeRevision?: string }> {
  try {
    const parsed = JSON.parse(
      await readFile(join(historyDir, "history-catalog.json"), "utf8"),
    ) as { activeGeneration?: unknown; activeRevision?: unknown };
    return {
      ...(typeof parsed.activeGeneration === "number" ? { activeGeneration: parsed.activeGeneration } : {}),
      ...(typeof parsed.activeRevision === "string" ? { activeRevision: parsed.activeRevision } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * A filesystem-safe name, matching `webuiSessionExportFileName` so the two
 * exports do not disagree about what a session's file is called.
 *
 * A title made entirely of reserved characters reduces to a row of
 * underscores, which is a legal but useless filename, so a name with no
 * alphanumeric content falls back to the session id.
 */
export function webuiSessionTransferFileName(
  sessionId: string,
  session: Pick<WebuiSessionInfo, "title" | "agentName">,
  exportedAt: string,
): string {
  const stamp = exportedAt.replace(/[-:]/gu, "").replace(/\..+$/u, "");
  const raw = session.title?.trim() || session.agentName || sessionId;
  const safe = raw
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, 120);
  return `${/[\p{L}\p{N}]/u.test(safe) ? safe : sessionId}-${stamp}.transfer.json`;
}

/**
 * Walk `getMessages` to the end of the session, oldest first.
 *
 * The cursor moves backwards in time while each page already runs
 * oldest-to-newest, so the page list is reversed and the pages themselves are
 * left alone -- reversing the flattened array instead yields `m1, m3, m2`.
 *
 * The same three guards the client-side walk uses: a misbehaving transport
 * that repeats a cursor would otherwise loop forever inside a request handler.
 */
export async function collectSessionDisplayMessages(
  load: (request: { readonly id: string; readonly before?: string }) => Promise<{
    readonly messages?: readonly WebuiMessage[];
    readonly nextCursor?: string;
    readonly hasMore?: boolean;
  }>,
  sessionId: string,
  maxPages = 200,
): Promise<readonly WebuiMessage[]> {
  const pages: WebuiMessage[][] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await load(cursor ? { id: sessionId, before: cursor } : { id: sessionId });
    pages.push([...(result.messages ?? [])]);
    if (result.hasMore === false) break;
    const next = result.nextCursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return pages.reverse().flat();
}
