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
import {
  applyWebuiEffectCommands,
  reduceWebuiEffect,
} from "../projection/effect-reducer.js";
import type { WebuiEffectHandlers } from "../projection/effect-reducer.js";
import {
  readWebuiEventSessionId,
  reduceWebuiSessionActivity,
} from "../session-activity.js";
import {
  recogniseWebuiStreamPayload,
  reduceWebuiStreamFrame,
} from "../stream.js";
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
  /** The channel was accepted; re-read authoritative state. Not a barrier. */
  readonly channelReady?: () => void;
}

export interface WebuiEventCoordinatorDeps {
  readonly store: WebuiSessionStore;
  readonly leases: WebuiStreamLeaseController;
  readonly readActiveSessionId: () => string | undefined;
  readonly effects?: WebuiEventEffects;
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
  const { store, leases, readActiveSessionId } = deps;
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
    setGoal: (goal) =>
      store.updateSession(sessionId, (current) => ({ ...current, goal })),
    attachStream: (turnId, mode) =>
      effects.attachStream?.(sessionId, turnId, mode),
  });

  const handleEvent = (event: WebuiRuntimeEvent): void => {
    if (store.isDisposed()) return;
    const activeSessionId = readActiveSessionId();
    store.updateActivity((current) =>
      reduceWebuiSessionActivity(
        current,
        event,
        activeSessionId ? { activeSessionId } : {},
      ),
    );
    const sessionId = readWebuiEventSessionId(event);
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
