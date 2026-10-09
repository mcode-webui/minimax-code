// Session runtime store — module-level Map of session → runtime state.
//
// This module was lifted out of `app.tsx` in W2.75. The body of every
// function is byte-identical to what used to live there; the lift is a
// move-only refactor. **Do not** re-shape the Map, the listener set, the
// guard order in `updateSessionRuntimeState`, the no-notify call inside
// `migrateSessionRuntimeState`, or view subscription semantics inside
// `useSessionRuntimeState`. Each of those is load-bearing for the
// `WebuiClientFoundationApp` home → first-session flow (see the
// comments inline) and changing any of them is a behaviour change.
//
// `WebuiSessionRuntimeState`, `readSessionRuntimeState`,
// `updateSessionRuntimeState`, `migrateSessionRuntimeState`, and
// `useSessionRuntimeState` are imported by `app.tsx` and the
// Webui-transcript-widgets-integration test. The Map and the listener
// Set are the canonical path: there is exactly one instance, declared
// here, and every consumer reads / writes through the helpers above.

import { useEffect, useState } from "react";
import { initialWebuiStreamState } from "./projection/stream-state.js";
import type { WebuiComposerSubmitHandlers } from "./projection/composer-state.js";
import type { WebuiStreamState } from "./projection/stream-state.js";

interface WebuiSessionRuntimeState {
  readonly stream: WebuiStreamState;
  readonly sending: boolean;
}

export const HOME_SESSION_RUNTIME_KEY = "__webui-home__";

export interface SessionTurnRuntimeWriter<SessionId extends string = string> {
  readonly kind: "session";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
}

export interface HomeTurnRuntimeWriter {
  readonly kind: "home";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
  readonly migrateToSession: <SessionId extends string>(
    sessionId: SessionId,
  ) => SessionTurnRuntimeWriter<SessionId>;
}

export type SessionRuntimeWriterOwner<SessionId extends string = string> =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly sessionId: SessionId };

const sessionRuntimeStates = new Map<string, WebuiSessionRuntimeState>();
const sessionRuntimeListeners = new Map<
  string,
  Set<(state: WebuiSessionRuntimeState) => void>
>();

export function readSessionRuntimeState(
  sessionKey: string,
): WebuiSessionRuntimeState {
  return (
    sessionRuntimeStates.get(sessionKey) ?? {
      stream: initialWebuiStreamState,
      sending: false,
    }
  );
}

export function updateSessionRuntimeState(
  sessionKey: string,
  update: (current: WebuiSessionRuntimeState) => WebuiSessionRuntimeState,
): void {
  const next = update(readSessionRuntimeState(sessionKey));
  sessionRuntimeStates.set(sessionKey, next);
  for (const listener of sessionRuntimeListeners.get(sessionKey) ?? [])
    listener(next);
}

/**
 * A writer belongs to one turn, not whichever session is currently selected.
 * The only time its key changes is when a first message creates the session
 * that owns a stream which began on the home screen.
 */
export function createSessionRuntimeWriter<SessionId extends string>(
  owner: { readonly kind: "session"; readonly sessionId: SessionId },
): SessionTurnRuntimeWriter<SessionId>;
export function createSessionRuntimeWriter(
  owner: { readonly kind: "home" },
): HomeTurnRuntimeWriter;
export function createSessionRuntimeWriter<SessionId extends string>(
  owner: SessionRuntimeWriterOwner<SessionId>,
): SessionTurnRuntimeWriter<SessionId> | HomeTurnRuntimeWriter {
  let sessionKey = owner.kind === "home"
    ? HOME_SESSION_RUNTIME_KEY
    : owner.sessionId;
  const createSessionWriter = <Id extends string>(
    sessionId: Id,
  ): SessionTurnRuntimeWriter<Id> => ({
    kind: "session",
    setStream: (update) =>
      updateSessionRuntimeState(sessionId, (current) => ({
        ...current,
        stream: update(current.stream),
      })),
    setSending: (sending) =>
      updateSessionRuntimeState(sessionId, (current) => ({
        ...current,
        sending,
      })),
  });

  if (owner.kind === "session") return createSessionWriter(owner.sessionId);

  let migrated = false;
  const writeStream = (update: (current: WebuiStreamState) => WebuiStreamState) =>
    updateSessionRuntimeState(sessionKey, (current) => ({
      ...current,
      stream: update(current.stream),
    }));
  const writeSending = (sending: boolean) =>
    updateSessionRuntimeState(sessionKey, (current) => ({
      ...current,
      sending,
    }));
  return {
    kind: "home",
    setStream: writeStream,
    setSending: writeSending,
    migrateToSession: <Id extends string>(sessionId: Id) => {
      if (migrated) {
        throw new Error("Home turn runtime writer already migrated");
      }
      migrated = true;
      sessionKey = sessionId;
      return {
        ...createSessionWriter(sessionId),
        setStream: writeStream,
        setSending: writeSending,
      };
    },
  };
}

/**
 * Carry a session's live runtime state (stream + sending) to a new key and
 * clear the source. The first turn starts streaming before the session
 * exists — it writes to the home key — and `onSessionCreated` switches the
 * view mid-turn; migrating keeps the in-flight stream on screen and leaves
 * home clean so the next 新建任务 cannot replay the previous turn under the
 * welcome hero. Listeners are not notified on purpose: the only subscriber
 * is the view that is about to switch keys (its effect re-reads the target
 * key), and the target key has no subscriber yet.
 */
export function migrateSessionRuntimeState(
  fromKey: string,
  toKey: string,
): void {
  if (fromKey === toKey) return;
  const state = sessionRuntimeStates.get(fromKey);
  sessionRuntimeStates.delete(fromKey);
  if (state) sessionRuntimeStates.set(toKey, state);
}

export function useSessionRuntimeState(sessionId: string | undefined): {
  readonly state: WebuiSessionRuntimeState;
  readonly setStream: WebuiComposerSubmitHandlers["setStream"];
  readonly setSending: (sending: boolean) => void;
} {
  const sessionKey = sessionId ?? HOME_SESSION_RUNTIME_KEY;
  const [snapshot, setSnapshot] = useState(() => ({
    sessionKey,
    state: readSessionRuntimeState(sessionKey),
  }));
  // A render after a session switch must never paint the previously selected
  // session's live stream for one frame while the subscription effect catches
  // up. The effect below then subscribes this view to the selected key.
  const state = snapshot.sessionKey === sessionKey
    ? snapshot.state
    : readSessionRuntimeState(sessionKey);
  useEffect(() => {
    setSnapshot({ sessionKey, state: readSessionRuntimeState(sessionKey) });
    let listeners = sessionRuntimeListeners.get(sessionKey);
    if (!listeners) {
      listeners = new Set();
      sessionRuntimeListeners.set(sessionKey, listeners);
    }
    const listener = (next: WebuiSessionRuntimeState) =>
      setSnapshot({ sessionKey, state: next });
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) sessionRuntimeListeners.delete(sessionKey);
    };
  }, [sessionKey]);
  return {
    state,
    setStream: (update) =>
      updateSessionRuntimeState(sessionKey, (current) => ({
        ...current,
        stream: update(current.stream),
      })),
    setSending: (sending) =>
      updateSessionRuntimeState(sessionKey, (current) => ({
        ...current,
        sending,
      })),
  };
}
