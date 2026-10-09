// The single session store and write authority (plan §7.1 `application/`,
// §7.6 "Final state ownership and write authority").
//
// One store per application instance owns one map of session records; every
// writer is created from it, so there is exactly one place a session's state is
// written and exactly one map. Components never receive a writer — the bindings
// layer (plan §7.2) subscribes to snapshots and submits commands; the writer
// stays inside the application.
//
// Two guards are load-bearing:
//
//   * **Disposal.** After `dispose`, a late completion — a stream frame that
//     arrived after the application unmounted, a retry that settled late —
//     writes nothing. The store is the last line of defence because a writer
//     captured before disposal would otherwise resurrect a dead application.
//   * **Listener isolation.** A throwing snapshot listener must not stop the
//     other subscribers from being notified: one broken component cannot freeze
//     every other component's view of the application.
//
// The React hook that used to live beside the module-level store is split out
// into `client/bindings/use-session-state.ts` (plan §7.2); it reads this store's
// snapshot and creates no second map.

import type { WebuiSessionActivityMap } from "../session-activity.js";
import { initialWebuiSessionActivity } from "../session-activity.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import {
  initialWebuiApplicationSessionState,
  initialWebuiApplicationState,
  WEBUI_HOME_SESSION_KEY,
} from "./state.js";
import type {
  WebuiApplicationSessionState,
  WebuiApplicationState,
} from "./state.js";

export interface WebuiSessionWriter {
  readonly kind: "session";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
}

export interface WebuiHomeSessionWriter {
  readonly kind: "home";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
  readonly migrateToSession: <SessionId extends string>(
    sessionId: SessionId,
  ) => WebuiSessionWriter;
}

export type WebuiSessionWriterOwner<SessionId extends string = string> =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly sessionId: SessionId };

/**
 * The interaction slice's write targets. It is what the interaction commands
 * (`session-commands.ts`) are bound to, so a component submits
 * `replacePendingPermissions` / `applyGoal` and never holds one of these
 * setters itself (plan §7.6; ticket #45).
 */
export interface WebuiInteractionWriter {
  readonly setPermissions: (
    update: (
      current: readonly WebuiPendingPermission[],
    ) => readonly WebuiPendingPermission[],
  ) => void;
  readonly setQuestionnaire: (
    value:
      | WebuiQuestionnaireRequest
      | undefined
      | ((
          current: WebuiQuestionnaireRequest | undefined,
        ) => WebuiQuestionnaireRequest | undefined),
  ) => void;
  readonly setGoal: (goal: WebuiGoal | undefined) => void;
}

export interface WebuiSessionStore {
  getSnapshot: () => WebuiApplicationState;
  subscribe: (listener: () => void) => () => void;
  readSession: (sessionId: string) => WebuiApplicationSessionState;
  updateSession: (
    sessionId: string,
    update: (
      current: WebuiApplicationSessionState,
    ) => WebuiApplicationSessionState,
  ) => void;
  updateActivity: (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ) => void;
  select: (sessionId: string | undefined) => void;
  getSelectedSessionId: () => string | undefined;
  isDisposed: () => boolean;
  dispose: () => void;
  createSessionWriter: {
    <SessionId extends string>(owner: {
      readonly kind: "session";
      readonly sessionId: SessionId;
    }): WebuiSessionWriter;
    (owner: { readonly kind: "home" }): WebuiHomeSessionWriter;
  };
  /**
   * The interaction slice's writer, bound to one owner key. A component builds
   * its interaction commands from this and never keeps the writer (plan §7.6).
   */
  createInteractionWriter: (
    owner: WebuiSessionWriterOwner,
  ) => WebuiInteractionWriter;
  /**
   * Carry a session's live record (stream + sending + interaction slices) from
   * one key to another and clear the source. It deliberately does **not**
   * notify: the only subscriber is the view that is about to switch keys (its
   * effect re-reads the target key) and the target key has no subscriber yet.
   * This is the application-store form of the old
   * `migrateSessionRuntimeState` (plan §7.7 stage 4), and the no-notify
   * semantics are load-bearing for the home → first-session flow.
   */
  migrateSession: (fromKey: string, toKey: string) => void;
}

export function createWebuiSessionStore(): WebuiSessionStore {
  const sessions = new Map<string, WebuiApplicationSessionState>();
  const listeners = new Set<() => void>();
  let activity: WebuiSessionActivityMap = initialWebuiSessionActivity;
  let selectedSessionId: string | undefined;
  let disposed = false;
  let snapshot: WebuiApplicationState = initialWebuiApplicationState;

  const readSession = (sessionId: string): WebuiApplicationSessionState =>
    sessions.get(sessionId) ?? initialWebuiApplicationSessionState;

  const notify = (): void => {
    snapshot = {
      sessions: new Map(sessions),
      activity,
      ...(selectedSessionId ? { selectedSessionId } : {}),
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // A throwing listener is contained: the remaining subscribers are the
        // ones a broken component must not be able to black out.
        try {
          // eslint-disable-next-line no-console
          console.error("[webui] application listener threw:", error);
        } catch {
          // console.error can throw in extreme environments; give up.
        }
      }
    }
  };

  const updateSession = (
    sessionId: string,
    update: (
      current: WebuiApplicationSessionState,
    ) => WebuiApplicationSessionState,
  ): void => {
    if (disposed) return;
    const current = readSession(sessionId);
    const next = update(current);
    if (next === current) return;
    sessions.set(sessionId, next);
    notify();
  };

  const updateActivity = (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ): void => {
    if (disposed) return;
    const next = update(activity);
    if (next === activity) return;
    activity = next;
    notify();
  };

  const createSessionWriter = <Id extends string>(sessionId: Id): WebuiSessionWriter => ({
    kind: "session",
    setStream: (update) =>
      updateSession(sessionId, (current) => ({
        ...current,
        stream: update(current.stream),
      })),
    setSending: (sending) =>
      updateSession(sessionId, (current) => ({ ...current, sending })),
  });

  const createInteractionWriterFor = (
    sessionKey: string,
  ): WebuiInteractionWriter => ({
    setPermissions: (update) =>
      updateSession(sessionKey, (current) => ({
        ...current,
        permissions: update(current.permissions),
      })),
    setQuestionnaire: (value) =>
      updateSession(sessionKey, (current) => ({
        ...current,
        questionnaire:
          typeof value === "function" ? value(current.questionnaire) : value,
      })),
    setGoal: (goal) =>
      updateSession(sessionKey, (current) => ({ ...current, goal })),
  });

  const store: WebuiSessionStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readSession,
    updateSession,
    updateActivity,
    select: (sessionId) => {
      if (disposed || sessionId === selectedSessionId) return;
      selectedSessionId = sessionId;
      notify();
    },
    getSelectedSessionId: () => selectedSessionId,
    isDisposed: () => disposed,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
    createSessionWriter: (<Id extends string>(
      owner: WebuiSessionWriterOwner<Id>,
    ): WebuiSessionWriter | WebuiHomeSessionWriter => {
      if (owner.kind === "session")
        return createSessionWriter(owner.sessionId);
      // Home turn: the first message streams before the session exists, so the
      // writer starts on the home key and migrates onto the created session in
      // one committed transition (plan §7.1, `turn-coordinator.ts`).
      let sessionKey = WEBUI_HOME_SESSION_KEY;
      let migrated = false;
      const writeStream = (
        update: (current: WebuiStreamState) => WebuiStreamState,
      ): void =>
        updateSession(sessionKey, (current) => ({
          ...current,
          stream: update(current.stream),
        }));
      const writeSending = (sending: boolean): void =>
        updateSession(sessionKey, (current) => ({ ...current, sending }));
      return {
        kind: "home",
        setStream: writeStream,
        setSending: writeSending,
        migrateToSession: (sessionId) => {
          if (migrated)
            throw new Error("Home turn session writer already migrated");
          migrated = true;
          // Re-point only. The writer belongs to one turn and its key changes
          // only when the first home turn creates the session that owns its
          // stream. Carrying the already-written record across the keys is a
          // separate, silent step the caller runs
          // (`store.migrateSession`), exactly as the module-level store's
          // `migrateSessionRuntimeState` did; doing it here would notify a
          // subscriber that must not see the intermediate state.
          sessionKey = sessionId;
          return {
            kind: "session",
            setStream: writeStream,
            setSending: writeSending,
          };
        },
      };
    }) as WebuiSessionStore["createSessionWriter"],
    createInteractionWriter: (owner) =>
      createInteractionWriterFor(
        owner.kind === "home" ? WEBUI_HOME_SESSION_KEY : owner.sessionId,
      ),
    migrateSession: (fromKey, toKey) => {
      if (disposed || fromKey === toKey) return;
      const state = sessions.get(fromKey);
      sessions.delete(fromKey);
      if (state) sessions.set(toKey, state);
      // No `notify()` on purpose (plan §7.7 stage 4; the module-level store's
      // `migrateSessionRuntimeState` had the same semantics). The only
      // subscriber is the view switching keys, which re-reads the target key in
      // its own effect; the target key has no subscriber yet.
    },
  };

  return store;
}