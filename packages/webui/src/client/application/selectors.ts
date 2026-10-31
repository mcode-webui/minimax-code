// Snapshot selectors.
//
// Components subscribe to the application snapshot through the React bindings
// and then narrow it with these pure selectors; they never read a store writer.
// Keeping the narrowing here — rather than in each component — is what lets a
// component's subscription answer "did *my* slice change" without knowing the
// shape of the whole application state.

import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type { WebuiClientMessagePage } from "../features/transcript/contracts/message-view.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type { WebuiSessionActivity } from "../features/sessions/projection/session-activity.js";
import type { WebuiStreamState } from "../features/turn/projection/stream-state.js";
import { initialWebuiApplicationSessionState } from "./state.js";
import type {
  WebuiApplicationSessionState,
  WebuiApplicationState,
} from "./state.js";

export function selectWebuiSession(
  state: WebuiApplicationState,
  sessionId: string,
): WebuiApplicationSessionState | undefined {
  return state.sessions.get(sessionId);
}

/** The session's live stream, or the idle initial stream when unknown. */
export function selectWebuiSessionStream(
  state: WebuiApplicationState,
  sessionId: string,
): WebuiStreamState {
  return (
    state.sessions.get(sessionId)?.stream ??
    initialWebuiApplicationSessionState.stream
  );
}

/**
 * The session's pending permissions, or the empty list when unknown. Reading a
 * slice through the snapshot (rather than through a store writer) is what lets
 * the composer hold no writer for it.
 */
export function selectWebuiSessionPermissions(
  state: WebuiApplicationState,
  sessionId: string,
): readonly WebuiPendingPermission[] {
  return (
    state.sessions.get(sessionId)?.permissions ??
    initialWebuiApplicationSessionState.permissions
  );
}

/** The session's pending questionnaire, or `undefined` when none is open. */
export function selectWebuiSessionQuestionnaire(
  state: WebuiApplicationState,
  sessionId: string,
): WebuiQuestionnaireRequest | undefined {
  return state.sessions.get(sessionId)?.questionnaire;
}

/** The session's goal, or `undefined` when it has none. */
export function selectWebuiSessionGoal(
  state: WebuiApplicationState,
  sessionId: string,
): WebuiGoal | undefined {
  return state.sessions.get(sessionId)?.goal;
}

export function selectWebuiSelectedSessionId(
  state: WebuiApplicationState,
): string | undefined {
  return state.selectedSessionId;
}

/**
 * The session's transcript page, or an empty page when the session is unknown.
 *
 * The transcript history owner owns the `loadMessages` RPC and commits each
 * answer here. A reader that needs
 * the history — the shell's workspace-progress backfill, for one — projects this
 * slice instead of fetching a second copy, so the RPC, its request fence and its
 * error state stay with one owner.
 */
export function selectWebuiSessionTranscriptPage(
  state: WebuiApplicationState,
  sessionId: string | undefined,
): WebuiClientMessagePage {
  if (!sessionId) return emptyTranscriptPage;
  return state.sessions.get(sessionId)?.transcript.page ?? emptyTranscriptPage;
}

const emptyTranscriptPage: WebuiClientMessagePage = {};