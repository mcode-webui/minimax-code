// The session transfer format tag, shared by both sides of the HTTP boundary.
//
// The file is written by `SessionTransferApplication` in
// `@mavis/local-runtime-v2` and read back by `session-import.ts` in the
// client. Those two live in different packages and the client must not import
// the runtime, so the tag is declared here and both sides are pinned to it by
// a test that compares this constant against the runtime's own.
//
// Without that test the two could drift silently: the client would go on
// accepting (or rejecting) a tag the server no longer writes, and the symptom
// would be an import that fails only for real users, only on files produced
// after the change.

export const WEBUI_SESSION_TRANSFER_FORMAT = "mcode-webui-session-transfer@1";

/**
 * A filesystem-safe name for an exported session file.
 *
 * A title made entirely of reserved characters reduces to a row of
 * underscores, which is a legal but useless filename, so a name with no
 * alphanumeric content falls back to the session id.
 *
 * It lives here because both sides of the HTTP boundary need it: the export
 * route writes the `Content-Disposition` header, and the WebUI's own runtime
 * module used to declare a second copy for the download name.
 */
export function webuiSessionTransferFileName(
  sessionId: string,
  session: { readonly title?: string; readonly agentName?: string },
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

/** The agent an import lands under when the caller names none. */
export const WEBUI_DEFAULT_IMPORT_AGENT = "main";
