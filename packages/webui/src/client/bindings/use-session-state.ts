// React subscription to a session's snapshot (plan §7.2
// `client/bindings/use-session-state.ts`).
//
// It is the split-out React half of the old `session-runtime-store` hook: the
// store and its writer now live in `client/application/session-store.ts`, and
// this hook only *reads* the store's snapshot and narrows it with the
// application selectors. No second map is created here — the hook holds no
// state of its own beyond what `useSyncExternalStore` needs to schedule a
// render when the application notifies.

import type { WebuiSessionActivity } from "../session-activity.js";
import type { WebuiSessionStore } from "../application/session-store.js";
import {
  selectWebuiSession,
  selectWebuiSessionActivity,
  selectWebuiSessionSending,
  selectWebuiSessionStream,
} from "../application/selectors.js";
import type { WebuiApplicationSessionState } from "../application/state.js";
import { initialWebuiApplicationSessionState } from "../application/state.js";
import type { WebuiStreamState } from "../stream.js";
import {
  useWebuiApplication,
  useWebuiApplicationSnapshot,
} from "./application-context.js";

/** The session store for imperative reads outside render. */
export function useWebuiSessionStore(): WebuiSessionStore {
  return useWebuiApplication().store;
}

export function useWebuiSessionState(
  sessionId: string | undefined,
): WebuiApplicationSessionState {
  const snapshot = useWebuiApplicationSnapshot();
  if (!sessionId) return initialWebuiApplicationSessionState;
  return selectWebuiSession(snapshot, sessionId) ?? initialWebuiApplicationSessionState;
}

export function useWebuiSessionStream(
  sessionId: string | undefined,
): WebuiStreamState {
  const snapshot = useWebuiApplicationSnapshot();
  if (!sessionId) return initialWebuiApplicationSessionState.stream;
  return selectWebuiSessionStream(snapshot, sessionId);
}

export function useWebuiSessionSending(sessionId: string | undefined): boolean {
  const snapshot = useWebuiApplicationSnapshot();
  return sessionId ? selectWebuiSessionSending(snapshot, sessionId) : false;
}

export function useWebuiSessionActivity(
  sessionId: string | undefined,
): WebuiSessionActivity | undefined {
  const snapshot = useWebuiApplicationSnapshot();
  return sessionId ? selectWebuiSessionActivity(snapshot, sessionId) : undefined;
}
