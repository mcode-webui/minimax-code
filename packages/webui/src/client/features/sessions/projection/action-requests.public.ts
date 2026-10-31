// Action request builders — turn the local UI choices into the wire request
// objects the runtime consumes.
//
// Each builder is a pure function: it does no I/O, no React state, no
// `Date.now()`. The action buttons call them with the form input the user
// has typed, get back the request payload, and hand it to the transport.
// `webuiClientRequestId` is the only side-effecting helper here: it
// generates a fresh id every time, but it does not touch component state
// either — callers feed the id into a builder and forward the result.

import type {
  WebuiEditSessionMessageRequest,
  WebuiForkSessionRequest,
  WebuiRewindSessionRequest,
} from "../../../../shared/contracts/session.js";

/** Rewind a session to a specific user message, optionally reverting the
 *  file changes that turn produced. */
export function buildWebuiRewindRequest(
  id: string,
  userMessageId: string,
  clientRequestId: string,
  rewindTurnDiff: boolean,
): WebuiRewindSessionRequest {
  return { id, userMessageId, clientRequestId, rewindTurnDiff };
}

/** Edit a previously-sent user message. Returns undefined when the trimmed
 *  content is empty so the caller can short-circuit before sending the
 *  request. */
export function buildWebuiEditRequest(
  id: string,
  userMessageId: string,
  clientRequestId: string,
  content: string,
): WebuiEditSessionMessageRequest | undefined {
  const trimmed = content.trim();
  return trimmed
    ? { id, userMessageId, clientRequestId, content: trimmed }
    : undefined;
}

/** Full fork request. The renderer passes the user-controlled toggles
 *  (title, suggested-title opt-in, isolated-worktree opt-in) and the
 *  builder composes them with the session id. */
export function buildWebuiForkRequest(args: {
  readonly id: string;
  readonly assistantMessageId?: string;
  readonly clientRequestId: string;
  readonly title?: string;
  readonly useSuggestedTitle: boolean;
  readonly createIsolatedWorktree: boolean;
}): WebuiForkSessionRequest {
  const title = args.title?.trim();
  return {
    id: args.id,
    ...(args.assistantMessageId ? { assistantMessageId: args.assistantMessageId } : {}),
    clientRequestId: args.clientRequestId,
    ...(title ? { title } : {}),
    useSuggestedTitle: args.useSuggestedTitle,
    createIsolatedWorktree: args.createIsolatedWorktree,
  };
}

/** Shorthand fork request for the message-row action button: forks at the
 *  given assistant message with the user-supplied title. When the title is
 *  empty the request opts into the runtime-suggested title. */
export function buildWebuiMessageForkRequest(
  id: string,
  assistantMessageId: string,
  clientRequestId: string,
  title: string,
): WebuiForkSessionRequest {
  return buildWebuiForkRequest({
    id,
    assistantMessageId,
    clientRequestId,
    title,
    useSuggestedTitle: !title.trim(),
    createIsolatedWorktree: false,
  });
}

/** Generate a unique `clientRequestId` for an action request. Prefixes help
 *  the runtime tell the requests apart in the log; the random portion is
 *  a UUID when the runtime is available, otherwise a `Date.now()`-based
 *  fallback. */
export function webuiClientRequestId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

