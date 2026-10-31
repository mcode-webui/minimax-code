/**
 * Context-window usage reads, published by the composer.
 *
 * Both callers ask the same question — "what is the context usage for what the
 * user can see right now" — and both need the same answer when the message page
 * carries a server snapshot: prefer it, fall back to the newest message that
 * reported usage, and never invent a value when neither exists.
 *
 * Moved here from `projection/`: the stream loop's recovery bundle is the second
 * reader, and it belongs to the conversation substrate, which may not import
 * another business's private projection. The functions are pure reads over a
 * message page, so the composer's published surface is where the second reader
 * is allowed to find them. The bodies are unchanged.
 */

import {
  projectWebuiMessageToStreamMessage,
  readUsageNumber,
} from "../../transcript/contracts/message-stream.js";
import type { WebuiClientMessagePage } from "../../transcript/contracts/message-view.js";

/** Newest message that carried a context usage, searching from the end. */
export function latestContextUsage(
  messages: readonly { readonly contextUsage?: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const contextUsage = messages[index]?.contextUsage;
    if (contextUsage) return contextUsage;
  }
  return undefined;
}

/** The `usage` object of a server context snapshot, when it is well shaped. */
export function readContextUsageSnapshot(
  snapshot: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const usage = snapshot?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : undefined;
}

/**
 * The context-window reading a session's HISTORY holds.
 *
 * A message page carries the reading twice over, and this prefers the richer
 * half: the server's context snapshot (which names the window the runtime
 * billed against) and, failing that, the newest message that reported usage.
 *
 * This is a READ of the transcript's own record, and it stays one. The reading
 * used to be copied out of the page and into the live turn's record, which made
 * the live record hold two things it did not own — a turn's own snapshot and a
 * history's reading — and the copy was the one that could be lost: a turn
 * starting again reset the record, and a page read that lost its race with a
 * refresh left the ring blank for the rest of the session's life, with no
 * error anywhere to point at it. A reading read from its owner has no copy to
 * lose, and it arrives whenever the owner commits it.
 */
export function readContextUsageFromPage(
  page: WebuiClientMessagePage | undefined,
): Record<string, unknown> | undefined {
  const snapshot = readContextUsageSnapshot(page?.contextSnapshot);
  if (snapshot) return snapshot;
  return latestContextUsage(
    (page?.messages ?? []).map(projectWebuiMessageToStreamMessage),
  );
}

/**
 * How much of the context window a session has spent, and how big that window
 * is.
 *
 * The two numbers travel under two different sets of names, and the readout
 * needs both of them whichever way they arrive:
 *
 *   - the LIVE snapshot (`context_usage` on a frame) spells them
 *     `usedTokens` and `contextWindowTokens`;
 *   - the PERSISTED record (a session message's `usage`) spells them
 *     `totalTokens` and `contextWindow`;
 *   - the runtime PROTOCOL fixes them as `total_tokens` and `context_window`,
 *     and the server's context snapshot publishes them under those names.
 *
 * Reading one set and not the others is what made the ring vanish for every
 * reloaded session: the page answered with a usage record, its fields were
 * spelled in a way this read did not look at, and there was nothing to draw —
 * with no error to point at it.
 *
 * `limit` is optional on purpose: a model whose window the runtime does not
 * know still has a spent window, and "we spent this much and do not know how
 * big the window is" is a fact the readout can carry.
 */
export function readContextWindowUsage(
  usage: Record<string, unknown> | undefined,
): { readonly used?: number; readonly limit?: number } {
  return {
    used: readUsageNumber(usage, "total_tokens", "totalTokens", "usedTokens", "used_tokens"),
    limit: readUsageNumber(
      usage,
      "context_window",
      "contextWindow",
      "contextWindowTokens",
      "context_window_tokens",
    ),
  };
}
