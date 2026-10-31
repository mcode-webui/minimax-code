// The single session store and write authority.
//
// One store per application instance owns one map of session records; every
// writer is created from it, so there is exactly one place a session's state is
// written and exactly one map. Components never receive a writer — the bindings
// layer subscribes to snapshots and submits commands; the writer
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
// into `client/bindings/use-session-state.ts`; it reads this store's snapshot and
// creates no second map.

import type {
  WebuiSessionActivity,
  WebuiSessionActivityMap,
} from "../features/sessions/projection/session-activity.js";
import { initialWebuiSessionActivity } from "../features/sessions/projection/session-activity.js";
import type { WebuiSessionCatalogState } from "../features/sessions/application/session-catalog.public.js";
import { initialWebuiSessionCatalogState } from "../features/sessions/application/session-catalog.public.js";
import type { WebuiStreamState } from "../features/turn/projection/stream-state.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type { WebuiTranscriptHistoryWriter } from "../conversation/transcript-history.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import {
  initialWebuiApplicationSessionState,
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
 * What a guarded transfer did. Every member is distinct and actionable, so a
 * caller must decide — there is no "nothing happened" that reads like success.
 */
export type WebuiSessionTransferOutcome =
  /** The source held a record, the destination did not, and the record moved. */
  | "transferred"
  /** Nothing to move: the source held no record, or source and destination are the same key. */
  | "no-source"
  /** The destination already holds a record. The destination wins; both are left untouched. */
  | "target-exists"
  /** The destination is a purged id; carrying anything onto it would resurrect a deleted session. */
  | "purged"
  /** The captured source incarnation is no longer the live one (an explicit New Task intervened). */
  | "stale-source"
  /** The store is terminal; nothing can be written. */
  | "disposed";

export interface WebuiSessionTransferResult {
  readonly outcome: WebuiSessionTransferOutcome;
  /** The incarnation of the source at the moment of the attempt, when the source was the home slot. */
  readonly sourceIncarnation?: number;
}

/**
 * The interaction slice's write targets. It is what the interaction commands
 * (`session-commands.ts`) are bound to, so a component submits
 * `replacePendingPermissions` / `applyGoal` and never holds one of these
 * setters itself.
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
  /** The one catalog slice's writer. */
  updateCatalog: (
    update: (current: WebuiSessionCatalogState) => WebuiSessionCatalogState,
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
   * its interaction commands from this and never keeps the writer.
   */
  createInteractionWriter: (
    owner: WebuiSessionWriterOwner,
  ) => WebuiInteractionWriter;
  /**
   * The home slot's incarnation. It advances whenever the home record is reset
   * (an explicit New Task), so a creation that started before that reset can be
   * told apart from one that started after it: a late creation whose captured
   * incarnation is no longer the live one is refused with `stale-source` rather
   * than adopted onto a home the user has already replaced.
   */
  readonly readHomeIncarnation: () => number;
  /** Start a fresh home record: drop the current one and advance its incarnation. */
  readonly resetHomeRecord: () => void;
  /** Whether one key currently holds a record. */
  readonly hasSession: (sessionId: string) => boolean;
  /**
   * The guarded home→session transfer.
   *
   * `migrateSession` below is the unconditional move the adoption sites use; this
   * one is the API the creation use case drives. It never overwrites a
   * destination that already holds a record
   * and never resurrects a purged id, and it reports every outcome — including
   * the ones that moved nothing — so a submission cannot be left unsettled by a
   * silent no-op.
   */
  readonly transferSession: (
    sourceKey: string,
    targetKey: string,
    options?: { readonly expectSourceIncarnation?: number },
  ) => WebuiSessionTransferResult;
  /**
   * Carry a session's live record (stream + sending + interaction slices) from
   * one key to another and clear the source. It deliberately does **not**
   * notify: the only subscriber is the view that is about to switch keys (its
   * effect re-reads the target key) and the target key has no subscriber yet.
   * This is the application-store form of the old
   * `migrateSessionRuntimeState`, and the no-notify semantics are load-bearing
   * for the home → first-session flow.
   */
  migrateSession: (fromKey: string, toKey: string) => void;
  /**
   * Drop every server-derived slice for one session id: the session record
   * (stream + sending + permissions + questionnaire + goal + transcript) and
   * the activity entry (busy hint and last activity time). The catalog slice is
   * updated separately, by the delete workflow that owns it. Idempotent, and a
   * no-op after `dispose` — a successful delete, a delete followed by a late
   * completion and a recovery retry that lands on a removed session all share
   * this one purge entry point.
   */
  purgeSession: (sessionId: string) => void;
}

export function createWebuiSessionStore(options?: {
  /** Seed the catalog (SSR pass / tests); never a second map. */
  readonly catalog?: WebuiSessionCatalogState;
}): WebuiSessionStore {
  const sessions = new Map<string, WebuiApplicationSessionState>();
  const listeners = new Set<() => void>();
  // The session ids the application has explicitly purged. Both write paths
  // consult it, so a late completion (a stream frame or event that arrived
  // after `remove`) cannot resurrect a deleted session's record or its activity
  // entry. Session ids are server-generated and never reused within one
  // application instance, so the set only grows with the number of deletions.
  const purged = new Set<string>();
  let activity: WebuiSessionActivityMap = initialWebuiSessionActivity;
  let catalog: WebuiSessionCatalogState =
    options?.catalog ?? initialWebuiSessionCatalogState;
  let selectedSessionId: string | undefined;
  let disposed = false;
  /**
   * The home slot's incarnation. It starts at 1 so a
   * capture of `0` can never be mistaken for a live one, and it advances
   * whenever an explicit New Task resets the home record. The counter is
   * deliberately not part of the session map: it describes the home slot's
   * identity, not any session's state.
   */
  let homeIncarnation = 1;
  // The first snapshot must reflect the seeded catalog, not the empty initial
  // one: `getSnapshot` is read before any notify (SSR first paint).
  let snapshot: WebuiApplicationState = {
    sessions: new Map(),
    activity,
    catalog,
  };

  const readSession = (sessionId: string): WebuiApplicationSessionState =>
    sessions.get(sessionId) ?? initialWebuiApplicationSessionState;

  const notify = (): void => {
    snapshot = {
      sessions: new Map(sessions),
      activity,
      catalog,
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
    // A purged session id is dead in the application store: a stream frame
    // that arrives late, a retry that lands after delete, and a hung turn
    // all share this one guard.
    if (purged.has(sessionId)) return;
    const current = readSession(sessionId);
    const next = update(current);
    if (next === current) return;
    sessions.set(sessionId, next);
    notify();
  };

  /**
   * Strip a purged session id back out of an activity map. An event callback
   * that read the map before the delete, or a hydration that lands after it,
   * must not put the removed session's badge or busy hint back.
   */
  const withoutPurgedActivity = (
    map: WebuiSessionActivityMap,
  ): WebuiSessionActivityMap => {
    if (purged.size === 0) return map;
    let next: Record<string, WebuiSessionActivity> | undefined;
    for (const sessionId of Object.keys(map)) {
      if (!purged.has(sessionId)) continue;
      next ??= { ...map };
      delete next[sessionId];
    }
    return next ?? map;
  };

  /**
   * Shallow comparison by key and value identity. Activity entries are
   * immutable, so an entry that did not change is the same object.
   */
  const sameActivity = (
    a: WebuiSessionActivityMap,
    b: WebuiSessionActivityMap,
  ): boolean => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
  };

  const updateActivity = (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ): void => {
    if (disposed) return;
    const proposed = update(activity);
    if (proposed === activity) return;
    const next = withoutPurgedActivity(proposed);
    // The purge filter can collapse a real write back onto the current map —
    // a late event for a session that has already been deleted. Notifying
    // anyway would re-render every subscriber for a session that no longer
    // exists.
    if (sameActivity(next, activity)) return;
    activity = next;
    notify();
  };

  const updateCatalog = (
    update: (current: WebuiSessionCatalogState) => WebuiSessionCatalogState,
  ): void => {
    if (disposed) return;
    const next = update(catalog);
    if (next === catalog) return;
    catalog = next;
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
    updateCatalog,
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
      // one committed transition (`turn-coordinator.ts`).
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
    readHomeIncarnation: () => homeIncarnation,
    resetHomeRecord: () => {
      if (disposed) return;
      // One notification only when a record actually went away: a second New
      // Task with an already-empty home changes the incarnation and nothing a
      // subscriber can see, and notifying would re-render every one of them.
      const had = sessions.delete(WEBUI_HOME_SESSION_KEY);
      homeIncarnation += 1;
      if (had) notify();
    },
    hasSession: (sessionId) => sessions.has(sessionId),
    transferSession: (fromKey, toKey, options) => {
      const sourceIncarnation =
        fromKey === WEBUI_HOME_SESSION_KEY ? homeIncarnation : undefined;
      if (disposed) return { outcome: "disposed" };
      // The incarnation is checked before anything is touched: an explicit New
      // Task between capture and completion means the record this transfer
      // would carry is not the record the user is looking at.
      if (
        options?.expectSourceIncarnation !== undefined &&
        sourceIncarnation !== undefined &&
        options.expectSourceIncarnation !== sourceIncarnation
      )
        return { outcome: "stale-source", sourceIncarnation };
      if (purged.has(toKey)) return { outcome: "purged", sourceIncarnation };
      if (fromKey === toKey || !sessions.has(fromKey))
        return { outcome: "no-source", sourceIncarnation };
      // The destination wins: a record that is already there carries the
      // authoritative event, and overwriting it would erase that. Both records
      // are left exactly as they were.
      if (sessions.has(toKey)) return { outcome: "target-exists", sourceIncarnation };
      const state = sessions.get(fromKey);
      sessions.delete(fromKey);
      if (state) sessions.set(toKey, state);
      return { outcome: "transferred", sourceIncarnation };
    },
    migrateSession: (fromKey, toKey) => {
      // A key this instance has purged is dead in the store, exactly as it is
      // for `updateSession`: carrying a record onto it would resurrect the
      // deleted session (the home→session adoption runs on its own schedule,
      // so the session it names can be deleted before the move lands).
      // The source is deliberately left alone — a refused move must not also
      // clear the record the caller still owns.
      if (disposed || fromKey === toKey || purged.has(toKey)) return;
      const state = sessions.get(fromKey);
      sessions.delete(fromKey);
      if (state) sessions.set(toKey, state);
      // No `notify()` on purpose (the module-level store's
      // `migrateSessionRuntimeState` had the same semantics). The only
      // subscriber is the view switching keys, which re-reads the target key in
      // its own effect; the target key has no subscriber yet.
    },
    purgeSession: (sessionId) => {
      if (disposed || sessionId === WEBUI_HOME_SESSION_KEY) return;
      purged.add(sessionId);
      const hadSession = sessions.delete(sessionId);
      const hadActivity = Object.prototype.hasOwnProperty.call(
        activity,
        sessionId,
      );
      if (hadActivity) activity = withoutPurgedActivity(activity);
      // One notification for one purge. A second call for the same id is a
      // no-op: nothing is left to drop, so nothing changes and nothing is
      // emitted.
      if (hadSession || hadActivity) notify();
    },
  };

  return store;
}

/**
 * The conversation substrate's view of the transcript slice, satisfied by this
 * store. The substrate may not import the record repository, so the assembly
 * hands it this instead: one narrow writer over the slice it owns.
 */
export function createWebuiTranscriptHistoryWriter(
  store: WebuiSessionStore,
): WebuiTranscriptHistoryWriter {
  return {
    updateTranscript: (sessionId, update) =>
      store.updateSession(sessionId, (current) => ({
        ...current,
        transcript: update(current.transcript),
      })),
  };
}
