// React subscription to a session's snapshot (plan §7.2
// `client/bindings/use-session-state.ts`).
//
// It is the split-out React half of the old `session-runtime-store` hook: the
// store and its writer now live in `client/application/session-store.ts`, and
// this hook only *reads* the store's snapshot and narrows it with the
// application selectors. No second map is created here — the hook holds no
// state of its own beyond what `useSyncExternalStore` needs to schedule a
// render when the application notifies.
//
// The interaction commands are built here too, bound to the store's interaction
// writer for the owner key, so the composer submits `applyGoal` /
// `replacePendingPermissions` and holds no writer for that state (plan §7.6;
// ticket #45).

import { useMemo } from "react";

import type { WebuiSessionActivity } from "../session-activity.js";
import type { WebuiSessionStore } from "../application/session-store.js";
import {
  selectWebuiSession,
  selectWebuiSessionActivity,
  selectWebuiSessionGoal,
  selectWebuiSessionPermissions,
  selectWebuiSessionQuestionnaire,
  selectWebuiSessionSending,
  selectWebuiSessionStream,
} from "../application/selectors.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type { WebuiApplicationSessionState } from "../application/state.js";
import { initialWebuiApplicationSessionState } from "../application/state.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import {
  createWebuiInteractionCommands,
  type WebuiInteractionCommands,
} from "../application/session-commands.js";
import {
  useWebuiSessionStoreContext,
  useWebuiSessionStoreSnapshot,
} from "./application-context.js";

/** The session store for imperative reads outside render. */
export function useWebuiSessionStore(): WebuiSessionStore {
  return useWebuiSessionStoreContext();
}

export function useWebuiSessionState(
  sessionId: string | undefined,
): WebuiApplicationSessionState {
  const snapshot = useWebuiSessionStoreSnapshot();
  if (!sessionId) return initialWebuiApplicationSessionState;
  return selectWebuiSession(snapshot, sessionId) ?? initialWebuiApplicationSessionState;
}

export function useWebuiSessionStream(
  sessionId: string | undefined,
): WebuiStreamState {
  const snapshot = useWebuiSessionStoreSnapshot();
  if (!sessionId) return initialWebuiApplicationSessionState.stream;
  return selectWebuiSessionStream(snapshot, sessionId);
}

export function useWebuiSessionSending(sessionId: string | undefined): boolean {
  const snapshot = useWebuiSessionStoreSnapshot();
  return sessionId ? selectWebuiSessionSending(snapshot, sessionId) : false;
}

export function useWebuiSessionActivity(
  sessionId: string | undefined,
): WebuiSessionActivity | undefined {
  const snapshot = useWebuiSessionStoreSnapshot();
  return sessionId ? selectWebuiSessionActivity(snapshot, sessionId) : undefined;
}

/** The session's pending permissions, read through the selector. */
export function useWebuiSessionPermissions(
  sessionId: string | undefined,
): readonly WebuiPendingPermission[] {
  const snapshot = useWebuiSessionStoreSnapshot();
  if (!sessionId) return initialWebuiApplicationSessionState.permissions;
  return selectWebuiSessionPermissions(snapshot, sessionId);
}

/** The session's pending questionnaire, read through the selector. */
export function useWebuiSessionQuestionnaire(
  sessionId: string | undefined,
): WebuiQuestionnaireRequest | undefined {
  const snapshot = useWebuiSessionStoreSnapshot();
  return sessionId ? selectWebuiSessionQuestionnaire(snapshot, sessionId) : undefined;
}

/** The session's goal, read through the selector. */
export function useWebuiSessionGoal(
  sessionId: string | undefined,
): WebuiGoal | undefined {
  const snapshot = useWebuiSessionStoreSnapshot();
  return sessionId ? selectWebuiSessionGoal(snapshot, sessionId) : undefined;
}

/**
 * The interaction command surface for one session (or the home slot). The
 * component calls `replacePendingPermissions` / `updateQuestionnaire` /
 * `applyGoal` through this, never a store setter; the interaction writer stays
 * inside the binding and is rebuilt only when the owner key changes.
 */
export function useWebuiInteractionCommands(
  sessionId: string | undefined,
): WebuiInteractionCommands {
  const store = useWebuiSessionStoreContext();
  return useMemo(
    () =>
      createWebuiInteractionCommands(
        store.createInteractionWriter(
          sessionId
            ? { kind: "session", sessionId }
            : { kind: "home" },
        ),
      ),
    [store, sessionId],
  );
}
