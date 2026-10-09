// The download name for an exported session.
//
// The transfer *format* lives in the runtime
// (`@mavis/local-runtime-v2` -> `SessionTransferApplication`), which is the
// only layer that can read both storage layers without losing anything. This
// file is down to the one thing that is genuinely the WebUI's business: what
// the browser should call the file it just downloaded.
//
// An earlier version also read `messages.jsonl` straight off disk and walked
// `getMessages` for the display side, so that no port change was needed. That
// produced a file that looked complete but was not: `getMessages` returns a
// view prepared for rendering, and on roughly 1% of real rows -- every
// compaction and fork-origin row -- it drops the `operationId` and
// `committedRevision` receipts that tie a display row back to the canonical
// event that produced it.

/**
 * A filesystem-safe name.
 *
 * A title made entirely of reserved characters reduces to a row of
 * underscores, which is a legal but useless filename, so a name with no
 * alphanumeric content falls back to the session id.
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
