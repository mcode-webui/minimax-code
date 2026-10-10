// The application event coordinator (plan §7.1 `application/event-coordinator.ts`).
//
// It is the **sole consumer of the process-event channel** and the sole owner of
// the two write paths that used to be spread across the shell, the composer and
// both workspace panels:
//
//   * it routes each process event to the *existing* domain reducers — the
//     activity reducer and the effect reducer are kept unchanged; what is
//     unified is the ingress, the owned effect execution and the write
//     authority, not the reducers themselves;
//   * it runs the effect commands the effect reducer produces against the
//     store's writers, so components no longer compute and apply business
//     effects from a raw event callback;
//   * it applies live stream frames through the single lease fence, so a
//     superseded attempt's frames produce zero writes.
//
// One channel, one coordinator: `attach` subscribes exactly once and `detach`
// only removes that one listener. The channel's lifetime belongs to the
// application, so unsubscribing never tears it down.

import type {
  WebuiRuntimeEvent,
  WebuiStreamFrame,
} from "../../shared/contracts/stream.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";
import {
  applyWebuiEffectCommands,
  reduceWebuiEffect,
} from "../projection/effect-reducer.js";
import type { WebuiEffectHandlers } from "../projection/effect-reducer.js";
// The same resolver the effect reducer's own session guard uses. It carries
// the nested-goal fallback for `thread_goal.*` events, whose payload declares
// the id inside `goal` rather than at the top level. Reading the top level
// only here dropped every such event before it could reach the reducer.
import { eventSessionId } from "../projection/event-parsers.js";
import {
  recogniseWebuiStreamPayload,
  reduceWebuiStreamFrame,
} from "../projection/stream-state.js";
import type { WebuiProcessEventChannel } from "./event-channel.js";
import { releaseWebuiLease } from "./stream-lease.js";
import type { WebuiSessionStore } from "./session-store.js";
import type { WebuiStreamLeaseController } from "./stream-lease-controller.js";

/** A live stream frame addressed to one session and one attempt generation. */
export interface WebuiEventStreamFrame {
  readonly sessionId: string;
  /**
   * The generation the producing attempt claimed. Omitted for a caller that
   * models no ownership; the fence then admits the frame only while no lease is
   * held.
   */
  readonly generation?: number;
  readonly frame: WebuiStreamFrame;
}

/** The parsed payload of a `workspace.git.changed` process event. */
export interface WebuiWorkspaceGitChangedPayload {
  readonly workspace?: string;
  readonly aliases?: readonly string[];
}

/**
 * The side effects the coordinator is permitted to kick off. They are injected
 * because the coordinator owns *when* an effect runs, not *how*: the transport
 * calls behind them live in the turn coordinator or the infrastructure layer.
 */
export interface WebuiEventEffects {
  readonly refreshPending?: (sessionId: string) => void | Promise<unknown>;
  readonly refreshGoal?: (sessionId: string) => void | Promise<unknown>;
  readonly attachStream?: (
    sessionId: string,
    turnId: string | undefined,
    mode: "attach" | "recheck",
  ) => void;
  readonly resumeOverflow?: (sessionId: string) => void;
  /**
   * The goal write path, routed to the session it names. Registered so the
   * goal-version guard (a late steering re-read must not clobber a newer goal
   * an event just applied) stays on the one writer that owns it. Absent, the
   * coordinator writes the store directly.
   */
  readonly setGoal?: (sessionId: string, goal: WebuiGoal | undefined) => void;
  /**
   * A `workspace.git.changed` event arrived. It carries no session id, so it is
   * delivered to this application-wide hook rather than a per-session effect;
   * the owner invalidates the workspace git and review queries.
   */
  readonly workspaceGitChanged?: (
    payload: WebuiWorkspaceGitChangedPayload,
  ) => void;
  /** The channel was accepted; re-read authoritative state. Not a barrier. */
  readonly channelReady?: () => void;
}

export interface WebuiEventCoordinatorDeps {
  readonly store: WebuiSessionStore;
  readonly leases: WebuiStreamLeaseController;
  readonly readActiveSessionId: () => string | undefined;
  /**
   * The unread controller, which owns the activity reduction and gates counted
   * events on hydration (plan §7.6 "Unread"). The coordinator routes every
   * event to it instead of reducing the activity map itself, so there is one
   * implementation of the activity write path.
   */
  readonly unread: WebuiActivityIngress;
  readonly effects?: WebuiEventEffects;
}

/**
 * The activity ingress the coordinator routes events to. A
 * `WebuiUnreadController` satisfies it structurally.
 */
export interface WebuiActivityIngress {
  readonly recordEvent: (
    event: WebuiRuntimeEvent,
    activeSessionId: string | undefined,
  ) => void;
}

export interface WebuiEventCoordinator {
  /** Subscribe to the channel exactly once; returns a detach that removes it. */
  readonly attach: (channel: WebuiProcessEventChannel) => () => void;
  readonly handleEvent: (event: WebuiRuntimeEvent) => void;
  readonly handleStreamFrame: (input: WebuiEventStreamFrame) => void;
  readonly detach: () => void;
  /** Whether the coordinator currently holds the channel subscription. */
  readonly isAttached: () => boolean;
}

export function createWebuiEventCoordinator(
  deps: WebuiEventCoordinatorDeps,
): WebuiEventCoordinator {
  const { store, leases, readActiveSessionId, unread } = deps;
  const effects = deps.effects ?? {};
  let unsubscribe: (() => void) | undefined;

  const handlersFor = (sessionId: string): WebuiEffectHandlers => ({
    refreshPending: () => effects.refreshPending?.(sessionId),
    refreshGoal: () => effects.refreshGoal?.(sessionId),
    setSending: (sending) =>
      store.updateSession(sessionId, (current) => ({ ...current, sending })),
    setStream: (patch) =>
      store.updateSession(sessionId, (current) => ({
        ...current,
        stream: patch(current.stream),
      })),
    setPermissions: (patch) =>
      store.updateSession(sessionId, (current) => ({
        ...current,
        permissions: patch(current.permissions),
      })),
    setQuestionnaire: (patch) =>
      store.updateSession(sessionId, (current) => ({
        ...current,
        questionnaire: patch(current.questionnaire),
      })),
    setGoal: (goal) => {
      if (effects.setGoal) {
        effects.setGoal(sessionId, goal);
        return;
      }
      store.updateSession(sessionId, (current) => ({ ...current, goal }));
    },
    attachStream: (turnId, mode) =>
      effects.attachStream?.(sessionId, turnId, mode),
  });

  const handleEvent = (event: WebuiRuntimeEvent): void => {
    if (store.isDisposed()) return;
    const activeSessionId = readActiveSessionId();
    // The unread controller owns the activity reduction, and accepts a counted
    // event only once hydration has completed — one write path, not the shell's
    // effect plus the coordinator's.
    unread.recordEvent(event, activeSessionId);
    // A workspace-git event carries no session id. It is routed to the
    // application-wide invalidation hook, not a per-session effect, so the
    // workspace panels' git and review queries are invalidated through the
    // coordinator instead of a second subscription in the panels.
    if (event.type === "workspace.git.changed") {
      const rawWorkspace = event.payload.workspace;
      const rawAliases = event.payload.aliases;
      effects.workspaceGitChanged?.({
        ...(typeof rawWorkspace === "string" ? { workspace: rawWorkspace } : {}),
        ...(Array.isArray(rawAliases)
          ? {
              aliases: rawAliases.filter(
                (alias): alias is string => typeof alias === "string",
              ),
            }
          : {}),
      });
      return;
    }
    const sessionId = eventSessionId(event);
    if (!sessionId) return;
    const current = store.readSession(sessionId);
    const { commands } = reduceWebuiEffect(
      {
        stream: current.stream,
        permissions: current.permissions,
        questionnaire: current.questionnaire,
        goal: current.goal,
      },
      event,
      sessionId,
    );
    // The effect executor is the existing one; it walks the command list in
    // order, and its `set-*` commands land on this coordinator's store writers.
    applyWebuiEffectCommands(commands, handlersFor(sessionId), () =>
      store.readSession(sessionId).stream,
    );
  };

  const handleStreamFrame = (input: WebuiEventStreamFrame): void => {
    if (store.isDisposed()) return;
    // The single fence. A superseded attempt's generation is not current, so it
    // returns the same state object and the store sees no change — zero writes.
    if (!leases.isCurrent(input.sessionId, input.generation)) return;
    const recognised = recogniseWebuiStreamPayload(input.frame.dataJson);
    if (recognised.kind === "resume_overflow") {
      // The server says our view is too far behind. Drop the lease with the
      // turn it belonged to and mark the resync, then let the owned effect
      // reload authoritative history and reopen a fresh subscription.
      store.updateSession(input.sessionId, (current) => ({
        ...current,
        stream: releaseWebuiLease({
          ...current.stream,
          phase: "reconnecting",
          resumeRequired: true,
        }),
      }));
      effects.resumeOverflow?.(input.sessionId);
      return;
    }
    store.updateSession(input.sessionId, (current) => ({
      ...current,
      stream: reduceWebuiStreamFrame(current.stream, input.frame),
    }));
  };

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  return {
    attach: (channel) => {
      if (unsubscribe) return unsubscribe;
      const off = channel.subscribe(
        (event) => handleEvent(event),
        () => effects.channelReady?.(),
      );
      unsubscribe = off;
      return off;
    },
    handleEvent,
    handleStreamFrame,
    detach,
    isAttached: () => unsubscribe !== undefined,
  };
}