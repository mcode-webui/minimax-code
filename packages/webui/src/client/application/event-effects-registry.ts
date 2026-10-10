// The per-session effects registry (ticket #45, pre-flip bridge).
//
// The event coordinator (`application/event-coordinator.ts`) is the sole
// consumer of the process-event channel, but the effects it runs — the
// authoritative permission/questionnaire re-read, the goal-version-guarded
// goal re-read, the attach/recheck decision and the reconnect probe — close
// over the transport calls and the current session, which is why they are
// defined where the session is known. The coordinator is constructed for the
// whole application, so it cannot close over one component's handlers
// directly.
//
// This registry is that seam: it holds one effect set per session and exposes
// a single `WebuiEventEffects` the coordinator consumes, routing each call to
// the session it names. It is framework-free and owns no state beyond the map
// — it is a registration surface, not a store, and it never subscribes to the
// channel itself.
//
// It is the live seam: the composer registers its handlers here and the
// application coordinator consumes `asWebuiEventEffects()` over the single
// process-event channel (ticket #45, the atomic ingress flip).

import type { WebuiEventEffects } from "./event-coordinator.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";

export interface WebuiEventEffectsRegistry {
  /**
   * Registers one session's effect set. Returns an unregister that removes it
   * only if this exact set is still the registered one, so a re-register does
   * not drop a newer set.
   */
  readonly register: (
    sessionId: string,
    effects: WebuiEventEffects,
  ) => () => void;
  /** The effect set currently registered for a session, if any. */
  readonly read: (sessionId: string) => WebuiEventEffects | undefined;
  /** Drops every registration (application disposal). */
  readonly clear: () => void;
  /**
   * One `WebuiEventEffects` the coordinator consumes: every per-session call is
   * routed to the session it names, and a channel-accepted signal fans out to
   * every registered session's reconnect probe.
   */
  readonly asWebuiEventEffects: () => WebuiEventEffects;
}

export function createWebuiEventEffectsRegistry(): WebuiEventEffectsRegistry {
  const perSession = new Map<string, WebuiEventEffects>();

  return {
    register: (sessionId, effects) => {
      perSession.set(sessionId, effects);
      return () => {
        if (perSession.get(sessionId) === effects) perSession.delete(sessionId);
      };
    },
    read: (sessionId) => perSession.get(sessionId),
    clear: () => perSession.clear(),
    asWebuiEventEffects: () => ({
      invalidatePending: (sessionId) =>
        perSession.get(sessionId)?.invalidatePending?.(sessionId),
      refreshPending: (sessionId) =>
        perSession.get(sessionId)?.refreshPending?.(sessionId),
      refreshGoal: (sessionId) =>
        perSession.get(sessionId)?.refreshGoal?.(sessionId),
      attachStream: (sessionId, turnId, mode) =>
        perSession.get(sessionId)?.attachStream?.(sessionId, turnId, mode),
      setGoal: (sessionId: string, goal: WebuiGoal | undefined) =>
        perSession.get(sessionId)?.setGoal?.(sessionId, goal),
      resumeOverflow: (sessionId) =>
        perSession.get(sessionId)?.resumeOverflow?.(sessionId),
      // The channel was accepted; re-read authoritative state per session. Not
      // a barrier — a `session.start` can still slip past it — so each
      // session's own probe decides what to recover.
      channelReady: () => {
        for (const effects of perSession.values()) effects.channelReady?.();
      },
    }),
  };
}
