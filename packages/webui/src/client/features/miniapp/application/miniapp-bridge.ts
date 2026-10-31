// The page bridge's host side: what the WebUI client does with a Mini App's
// `postMessage`.
//
// The proxy injects the page half (`server/miniapp/bridge.ts`); this is the half
// that runs in the client and answers. Three rules make it safe to point at an
// untrusted page:
//
//   * **The sender is checked, not trusted.** A message is only read when its
//     origin is the Mini App's own proxy origin and its source is the frame this
//     view created. Any other window can post to this one, and a bridge that
//     answered them would let any page in the browser append to the composer.
//   * **The text is bounded and never sent.** An append writes the composer's
//     draft; it never submits, so a page cannot spend the person's turn.
//   * **A person confirms it.** The confirmation is injected so this module has
//     no DOM, and declining is `user_cancelled` with the draft untouched.
//
// The identity fields the runtime's contract mentions (`sessionId`, `pluginId`,
// `pluginName`) are supplied by the host from the view, never by the page: a page
// that could name another Mini App's session would be a page that writes into a
// transcript it cannot see.

import {
  WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST,
  WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH,
  type WebuiMiniAppBridgeAppendRequest,
  type WebuiMiniAppComposerResult,
} from "../../../../shared/contracts/miniapp.js";

/** Reads one append request out of a message's data, or nothing. */
export function webuiMiniAppBridgeRequest(
  data: unknown,
): WebuiMiniAppBridgeAppendRequest | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.type !== WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST) return undefined;
  const requestId = record.requestId;
  const text = record.text;
  if (typeof requestId !== "string" || !requestId) return undefined;
  if (typeof text !== "string") return undefined;
  return { requestId, text };
}

/**
 * Whether a message came from the frame this view created, on the origin this
 * view framed.
 *
 * `viewUrl` is the proxy's URL the server answered with, so its origin is the one
 * the browser reports for the document: comparing them is what tells the frame
 * this view owns from a second frame, or from the page's own window.
 */
export function webuiMiniAppBridgeSenderAllowed(input: {
  readonly origin: string;
  readonly viewUrl: string;
  readonly source: unknown;
  readonly frame: unknown;
}): boolean {
  if (!input.frame || input.source !== input.frame) return false;
  try {
    return new URL(input.viewUrl).origin === input.origin;
  } catch {
    // A view URL that cannot be parsed frames nothing, so nothing is allowed.
    return false;
  }
}

/**
 * The draft an append produces.
 *
 * Existing text is kept and the appended text follows on a line of its own: a
 * page that appends "/review this" beside a half-written sentence would be
 * editing something the person wrote, and an append is not an edit.
 */
export function webuiMiniAppDraftWithAppend(draft: string, text: string): string {
  if (!draft) return text;
  return draft.endsWith("\n") ? `${draft}${text}` : `${draft}\n${text}`;
}

/**
 * One append, decided.
 *
 * The order matters: size before identity, identity before confirmation, and the
 * confirmation before anything is written. A declined append performs no write
 * at all, which is the property the ticket's criterion names.
 */
export async function webuiMiniAppBridgeAppend(input: {
  readonly request: WebuiMiniAppBridgeAppendRequest;
  /** The session whose composer takes the draft; absent means "no target". */
  readonly sessionId?: string;
  readonly pluginName: string;
  readonly confirm: (question: string) => boolean | Promise<boolean>;
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
}): Promise<WebuiMiniAppComposerResult> {
  const { text } = input.request;
  if (text.length > WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH) {
    return { success: false, code: "text_too_large" };
  }
  if (!input.sessionId) return { success: false, code: "target_unavailable" };
  const confirmed = await input.confirm(
    `Mini App「${input.pluginName}」要把内容追加到输入框，是否允许？`,
  );
  if (!confirmed) return { success: false, code: "user_cancelled" };
  input.writeDraft(webuiMiniAppDraftWithAppend(input.readDraft(), text));
  return { success: true };
}
