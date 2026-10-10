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

import type { WebuiSessionActivity } from "../projection/session-activity.js";
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
} from "../application/session-commands.js";
import {
  attachWebuiTurn,
  sendWebuiTurn,
  type WebuiAttachTurnDeps,
  type WebuiSendTurnArgs,
} from "../application/turn-commands.js";
import { buildWebuiStreamLoopSink } from "../mechanisms/stream-loop.js";
import { streamStateBundle } from "../application/stream-state-bundle.js";
import {
  useWebuiApplicationOptional,
  useWebuiSessionStoreContext,
  useWebuiSessionStoreSnapshot,
} from "./application-context.js";

export function useWebuiTranscriptHistoryOwner() {
  return useWebuiApplicationOptional()?.transcriptHistory;
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
 * component calls `replacePendingPermissions` / `removePendingPermission` /
 * `applyQuestionnaire` / `applyGoal` through this, never a store setter; the
 * interaction writer stays inside the binding and is rebuilt only when the
 * owner key changes.
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
 * the two turn intents and an imperative `readStream` for the async turn paths
 * that cannot subscribe (plan §7.6; ticket #45 prerequisite 5).
 *
 * The store writer stays inside this hook, and so does the attempt's sink: a
 * component *submits* `attachTurn` / `sendTurn` and never receives a factory
 * that could mint a lease of its own and take one from a newer turn. The
 * callbacks each intent needs are plain data; the capabilities it needs
 * (`resumeSession`, `sendMessage`, …) are the ones the component already holds
 * for its transport. `readStream` reads the current slice off the same store
 * rather than a module-level map.
 */
export type WebuiTurnAttachIntent = Omit<
  WebuiAttachTurnDeps,
  "sessionId" | "readStream" | "setSending" | "sink"
>;

/** What a component submits to send (or retry) a turn. */
export interface WebuiTurnSendIntent
  extends Omit<WebuiSendTurnArgs, "sessionId" | "callbacks" | "createWriter" | "readStream"> {
  readonly onDraftChange: (next: string) => void;
  readonly onNeedsSession?: (draft: string) => void;
  readonly onSessionCreated?: (sessionId: string) => void;
  readonly onQueued?: () => void;
}

export function useWebuiSessionCommands(sessionId: string | undefined): {
  readonly commands: WebuiSessionCommands;
  readonly readStream: () => WebuiStreamState;
  readonly attachTurn: (input: WebuiTurnAttachIntent) => void;
  readonly sendTurn: (input: WebuiTurnSendIntent) => Promise<void>;
} {
  const store = useWebuiSessionStoreContext();
  return useMemo(() => {
    const writerFor = () =>
      sessionId
        ? store.createSessionWriter({ kind: "session", sessionId })
        : store.createSessionWriter({ kind: "home" });
    const writer = writerFor();
    const readStream = () =>
      store.readSession(sessionId ?? WEBUI_HOME_SESSION_KEY).stream;
    return {
      commands: createWebuiSessionCommands({
        setStream: writer.setStream,
        setSending: writer.setSending,
      }),
      readStream,
      // One sink per attachment, minted here: it claims the lease, fences every
      // write against the generation it claimed, and releases it on terminal.
      attachTurn: ({ turnId, resumeSession, loadMessages }) =>
        attachWebuiTurn({
          sessionId,
          turnId,
          resumeSession,
          loadMessages,
          readStream,
          setSending: writer.setSending,
          sink: buildWebuiStreamLoopSink(writer.setStream, streamStateBundle),
        }),
      sendTurn: ({
        onDraftChange,
        onNeedsSession,
        onSessionCreated,
        onQueued,
        ...args
      }) =>
        sendWebuiTurn({
          sessionId,
          ...args,
          readStream,
          callbacks: { onDraftChange, onNeedsSession, onSessionCreated, onQueued },
          // Builds the turn's writer — and, through it, the sink — inside the
          // command, so the home→session migration keeps working without the
          // component ever naming a key or holding a factory.
          createWriter: () => createWebuiTurnCommands(writerFor()),
        }),
    };
  }, [store, sessionId]);
}
