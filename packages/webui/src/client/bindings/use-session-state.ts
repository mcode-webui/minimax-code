// React subscription to a session's snapshot (plan §7.2
// `client/bindings/use-session-state.ts`).
//
// It is the split-out React half of the retired module-level session store
// hook: the store and its writer now live in
// `client/application/session-store.ts`, and
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
import {
  initialWebuiApplicationSessionState,
  WEBUI_HOME_SESSION_KEY,
} from "../application/state.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import {
  createWebuiInteractionCommands,
  createWebuiSessionCommands,
  createWebuiTurnCommands,
  type WebuiInteractionCommands,
  type WebuiSessionCommands,
  type WebuiTurnCommandWriter,
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

/**
 * The stream/sending command surface for one session (or the home slot), plus
 * an imperative `readStream` for the async turn paths that cannot subscribe
 * (plan §7.6; ticket #45 prerequisite 5). The store writer stays inside this
 * hook: the component submits `clearStream` / `updateStream` / `setTurnSending`
 * / `awaitInteraction` and never holds a setter, and `readStream` reads the
 * current slice off the same store rather than a module-level map.
 */
export function useWebuiSessionCommands(
  sessionId: string | undefined,
): {
  readonly commands: WebuiSessionCommands;
  readonly readStream: () => WebuiStreamState;
} {
  const store = useWebuiSessionStoreContext();
  return useMemo(() => {
    const writer = sessionId
      ? store.createSessionWriter({ kind: "session", sessionId })
      : store.createSessionWriter({ kind: "home" });
    return {
      commands: createWebuiSessionCommands(writer),
      readStream: () =>
        store.readSession(sessionId ?? WEBUI_HOME_SESSION_KEY).stream,
    };
  }, [store, sessionId]);
}

/**
 * The turn-writer binding: build the command-shaped writer a send streams into
 * (plan §7.1 `turn-coordinator.ts`; ticket #45 prerequisite 5). The composer's
 * send path calls this factory once per turn — home-keyed until the created
 * session owns the stream — and from then on submits `updateStream` /
 * `setTurnSending` / `migrateToSession`. The store writer never leaves this
 * binding, and it is the *application* store, not the old module-level map.
 */
export function useWebuiTurnWriter(): (
  owner:
    | { readonly kind: "home" }
    | { readonly kind: "session"; readonly sessionId: string },
) => WebuiTurnCommandWriter {
  const store = useWebuiSessionStoreContext();
  return useMemo(
    () => (owner) =>
      createWebuiTurnCommands(
        owner.kind === "home"
          ? store.createSessionWriter(owner)
          : store.createSessionWriter(owner),
      ),
    [store],
  );
}
