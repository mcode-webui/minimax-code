export interface WebuiMentionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface WebuiSlashRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export function findWebuiMentionRange(
  value: string,
  caret: number,
): WebuiMentionRange | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCaret);
  if (!match) return undefined;
  const start = beforeCaret.length - match[1]!.length - 1;
  return { start, end: caret, query: match[1]! };
}

/**
 * The slash token the caret currently sits in, mirroring `findWebuiMentionRange`.
 * Any slash opens the palette — the token may start the draft or follow
 * whitespace — so `帮我 /pl` ranks commands the same way `/pl` does. Requiring
 * `(?:^|\s)` keeps a `/` glued to another character out: `http://x` is a URL,
 * not a command. The `$` anchor means a space typed after the token (or a
 * caret that has moved past it) closes the palette again.
 */
export function findWebuiSlashRange(
  value: string,
  caret: number,
): WebuiSlashRange | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|\s)\/([^\s/]*)$/u.exec(beforeCaret);
  if (!match) return undefined;
  const start = beforeCaret.length - match[1]!.length - 1;
  return { start, end: caret, query: match[1]! };
}

/**
 * Drops the slash token, keeping whatever surrounds it. Escape and the
 * outside-pointerdown dismissal share this so both cancel an invocation the
 * same way, wherever in the draft the token sits.
 */
export function removeWebuiSlashToken(
  value: string,
  range: WebuiSlashRange,
): string {
  return `${value.slice(0, range.start)}${value.slice(range.end)}`;
}

/**
 * Swaps the slash token for `replacement` and reports where the caret lands.
 * Picking from the palette rewrites only the token the caret is in: the draft
 * may already hold an earlier "/skill" the user committed, and replacing the
 * whole draft silently dropped it.
 */
export function replaceWebuiSlashToken(
  value: string,
  range: WebuiSlashRange,
  replacement: string,
): { readonly value: string; readonly caret: number } {
  return {
    value: `${value.slice(0, range.start)}${replacement}${value.slice(range.end)}`,
    caret: range.start + replacement.length,
  };
}

export function insertWebuiMention(
  value: string,
  range: WebuiMentionRange,
  insertion: string,
): { readonly value: string; readonly caret: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const text = `${prefix}${insertion} `;
  return {
    value: `${before}${text}${after}`,
    caret: before.length + text.length,
  };
}

export const WEBUI_MAX_ATTACHMENT_COUNT = 10;
// Attachments travel as data URLs over the local WebSocket. Keep the decoded
// aggregate below its 100 MiB frame limit after base64 expansion.
export const WEBUI_MAX_ATTACHMENT_TOTAL_BYTES = 70 * 1024 * 1024;

export function webuiAttachmentLimitError(
  current: readonly { readonly sizeBytes: number }[],
  incoming: readonly { readonly sizeBytes: number }[],
): string | undefined {
  if (current.length + incoming.length > WEBUI_MAX_ATTACHMENT_COUNT)
    return `最多添加 ${WEBUI_MAX_ATTACHMENT_COUNT} 个文件`;
  const total = [...current, ...incoming].reduce(
    (sum, item) => sum + item.sizeBytes,
    0,
  );
  if (total > WEBUI_MAX_ATTACHMENT_TOTAL_BYTES)
    return "附件总大小不能超过 70 MB";
  return undefined;
}

/**
 * The data URL a hand-seeded text attachment needs, in the same
 * `data:<mime>;base64,…` shape `readAsDataURL` produces for a picked file.
 *
 * UTF-8 first, then base64 — never `btoa(text)` directly. `btoa` throws on
 * anything above U+00FF, and the one file this exists to carry is almost
 * entirely Chinese, so the naive call fails on the real input and passes on
 * every ASCII test.
 */
export function webuiTextAttachmentDataUrl(mimeType: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // Chunked so a 100KB memory file does not build one enormous string via
  // repeated concatenation; the per-byte loop is the slow part either way.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
