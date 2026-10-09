// Snapshot selectors (plan §7.1 `application/`, §7.6 readers).
//
// Components subscribe to the application snapshot through the React bindings
// and then narrow it with these pure selectors; they never read a store writer.
// Keeping the narrowing here — rather than in each component — is what lets a
// component's subscription answer "did *my* slice change" without knowing the
// shape of the whole application state.

import type { WebuiSessionActivity } from "../session-activity.js";
import type { WebuiStreamState } from "../stream.js";
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

export function selectWebuiSessionSending(
  state: WebuiApplicationState,
  sessionId: string,
): boolean {
  return state.sessions.get(sessionId)?.sending ?? false;
}

export function selectWebuiSessionActivity(
  state: WebuiApplicationState,
  sessionId: string,
): WebuiSessionActivity | undefined {
  return state.activity[sessionId];
}

export function selectWebuiSelectedSessionId(
  state: WebuiApplicationState,
): string | undefined {
  return state.selectedSessionId;
}
