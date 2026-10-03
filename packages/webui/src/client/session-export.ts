// Session export — serialize one session and its full history to a JSON file.
//
// The roadmap lists "会话导入/导出" as unmet with no entry point at all. The
// export half needs no new server operation: the transport already exposes
// `loadMessages`, and the message page is cursor-paginated, so the whole history
// is reachable by walking `nextCursor`. Everything that touches the DOM is
// isolated at the bottom of the file; the shape helpers above it are pure so
// they can be tested without a browser.
//
// The import half is a different story and is deliberately not here: see
// `WebuiCreateSessionRequest` in the server port — it accepts only a name, an
// optional workspace directory, and the team-mode flag. There is no way to
// seed a session with a replayed history, so an import would have to be a
// runtime change rather than a WebUI change.

import type {
  WebuiClientMessage,
  WebuiClientMessageLoader,
  WebuiClientMessagePage,
  WebuiClientSession,
} from "./contracts.js";

/** Bumped when the exported shape changes incompatibly. */
export const WEBUI_SESSION_EXPORT_FORMAT = "mcode-webui-session@1";

/**
 * Ceiling on the pages walked while collecting a history. The cursor walk is
 * defensive because a transport bug that returns a non-advancing cursor would
 * otherwise loop forever in a user-triggered download.
 */
export const WEBUI_SESSION_EXPORT_MAX_PAGES = 200;

export interface WebuiSessionExport {
  readonly format: typeof WEBUI_SESSION_EXPORT_FORMAT;
  readonly exportedAt: string;
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
    readonly agentName: string;
    readonly workspaceDir?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
  };
  readonly messageCount: number;
  readonly messages: readonly WebuiClientMessage[];
}

/**
 * Walk the message cursor until the transport says there is nothing more.
 *
 * Two orderings are in play and conflating them scrambles the transcript. The
 * cursor walk moves backwards in time — the first call has no cursor and
 * returns the newest page, and each call that passes the previous page's
 * `nextCursor` reaches older messages. Within a single page the messages
 * already run oldest-to-newest, the order the transcript renders. So the page
 * *list* is reversed and each page is left alone; reversing the flattened
 * array instead yields `m1, m3, m2, m5, m4` for a five-message history.
 *
 * Stops on any of: `hasMore === false`, a missing `nextCursor`, a cursor that
 * repeats (no forward progress), or the page ceiling.
 */
export async function collectWebuiSessionMessages(
  load: WebuiClientMessageLoader,
  sessionId: string,
  maxPages: number = WEBUI_SESSION_EXPORT_MAX_PAGES,
): Promise<readonly WebuiClientMessage[]> {
  const pages: WebuiClientMessage[][] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result: WebuiClientMessagePage = await load(cursor ? { id: sessionId, before: cursor } : { id: sessionId });
    pages.push([...(result.messages ?? [])]);
    if (result.hasMore === false) break;
    const next = result.nextCursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return pages.reverse().flat();
}

/** Assemble the export payload. `exportedAt` is injected so the shape is testable. */
export function buildWebuiSessionExport(
  session: WebuiClientSession,
  messages: readonly WebuiClientMessage[],
  exportedAt: string,
): WebuiSessionExport {
  return {
    format: WEBUI_SESSION_EXPORT_FORMAT,
    exportedAt,
    session: {
      sessionId: session.sessionId,
      title: session.title?.trim() || session.agentName || session.sessionId,
      agentName: session.agentName,
      ...(session.workspaceDir ? { workspaceDir: session.workspaceDir } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messageCount: messages.length,
    messages,
  };
}

/**
 * A filesystem-safe download name.
 *
 * Folds path separators and the Windows-reserved set into underscores, and
 * turns control characters into spaces. A literal space is left alone: it is
 * legal in a filename, and a CJK title containing one stays readable. Only
 * runs of whitespace are collapsed. Trailing dots and spaces are stripped
 * because Windows drops them silently, which would make the saved name
 * differ from the name that was shown.
 */
export function webuiSessionExportFileName(session: WebuiClientSession, exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/gu, "").replace(/\..+$/u, "");
  const raw = session.title?.trim() || session.agentName || session.sessionId;
  const safe = raw
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/[\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 60);
  // A title made entirely of reserved characters reduces to a row of
  // underscores: legal, but a file the user cannot identify. Same rule as
  // `webuiSessionTransferFileName`, so the two exports never disagree.
  return `${/[\p{L}\p{N}]/u.test(safe) ? safe : session.sessionId}-${stamp}.json`;
}

/** Pretty-printed JSON with a trailing newline, so the file is diff-friendly. */
export function webuiSessionExportToJson(payload: WebuiSessionExport): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Trigger a browser download. Split out from the logic above so the payload
 * helpers stay testable; returns false when there is no DOM to drive.
 */
export function downloadWebuiSessionExport(payload: WebuiSessionExport, exportedAt: string): boolean {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return false;
  const blob = new Blob([webuiSessionExportToJson(payload)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = webuiSessionExportFileName(
    {
      sessionId: payload.session.sessionId,
      agentName: payload.session.agentName,
      title: payload.session.title,
      createdAt: payload.session.createdAt,
      updatedAt: payload.session.updatedAt,
      ...(payload.session.workspaceDir ? { workspaceDir: payload.session.workspaceDir } : {}),
    },
    exportedAt,
  );
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
