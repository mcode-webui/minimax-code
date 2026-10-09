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
} from "../../shared/contracts/session.js";
import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type { WebuiModelSelectionRequest, WebuiModelPickerDraft } from "../contracts/model-view.js";

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

/** Build the model-selection request for a model or setting change. Per-pick
 *  values override the model's current runtime projection; an empty variant
 *  remains meaningful because it disables thinking. */
export function buildWebuiModelSelectionRequest(
  model: WebuiModelEntry,
  draft: WebuiModelPickerDraft,
  sessionId?: string,
): WebuiModelSelectionRequest {
  const variant = draft.variant !== undefined ? draft.variant : model.variant;
  const inheritedContextLimit =
    typeof model.contextLimit === "number" ? model.contextLimit : undefined;
  const contextLimit =
    draft.contextLimit !== undefined
      ? draft.contextLimit
      : inheritedContextLimit;
  const thinking =
    draft.thinkingEffort === undefined
      ? model.thinking
      : draft.thinkingEffort === null
        ? null
        : { effort: draft.thinkingEffort };
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(variant !== undefined ? { variant } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Compute the option value (`providerId/modelId/variant`) for a `<select>`
 *  model entry. The trailing `variant` is included even when empty so the
 *  lookup after a change selects the same catalog entry the user actually
 *  chose. */
export function webuiModelOptionValue(model: WebuiModelEntry): string {
  return `${model.providerId}/${model.modelId}/${model.variant ?? ""}`;
}
