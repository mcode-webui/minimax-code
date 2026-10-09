// The rail-activity command surface, on the application layer
// (plan §7.1 `application/unread.ts` — "absorbs the ordering rules now spread
// across six component effects"; §7.7 stage 4, the FoundationApp activity
// slice; §7.6 "Unread": the event, mark-read and hydration commands).
//
// The shell owns one `watchEvents` subscription and one application store; what
// moves here is *ownership of the slice and its writes*: the seed from the
// session list, the mark-read on opening a session, the restore of persisted
// counts, the persistence write, the event reduction and the active-turn probe.
// Each is a named command on this surface, bound once to the application
// store's activity writer — so the shell subscribes to the slice and submits
// commands, and never holds a writer or a `setState` for it.
//
// The unread persistence format is untouched: `infrastructure/storage.ts` owns
// the key, the validation and the shape, and the persist command writes exactly
// the positive counts it always did (same storage key, same positive-count
// filter).
//
// The probe is the *deduplicated* one (`active-turn-probe.ts`): the shell and
// the composer ask the same transport, so a same-session probe racing between
// them collapses to one round trip.

import type { WebuiActiveTurnResult } from "../../shared/contracts/session.js";
import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";
import type { WebuiClientSession } from "../contracts/session-view.js";
import {
  applyWebuiActiveTurn,
  applyWebuiUnreadCounts,
  markWebuiSessionRead,
  reduceWebuiSessionActivity,
  seedWebuiSessionActivity,
  type WebuiSessionActivityMap,
} from "../projection/session-activity.js";
import type { WebuiActiveTurnProbe } from "./active-turn-probe.js";

/**
 * The activity slice's write authority: the application store's activity
 * reader and writer. A `WebuiSessionStore` satisfies it structurally, so the
 * shell binds the surface to the one store without adapting it.
 */
export interface WebuiRailActivityStore {
  readonly getSnapshot: () => { readonly activity: WebuiSessionActivityMap };
  readonly updateActivity: (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ) => void;
}

export interface WebuiRailActivityCommands {
  /** First-paint times from the session list; never invents a `busy`. */
  readonly seed: (
    sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
  ) => void;
  /** Opening a session clears its unread badge. */
  readonly markRead: (sessionId: string) => void;
  /** Restore stored counts as a floor, excluding the session the user has open. */
  readonly restoreUnreadCounts: (
    counts: Readonly<Record<string, number>>,
    activeSessionId: string | undefined,
  ) => void;
  /**
   * Persist the positive counts — the single writer for the unread key, called
   * with the same `writeWebuiUnreadCounts` the shell always used.
   */
  readonly persistUnreadCounts: (
    write: (counts: Readonly<Record<string, number>>) => void,
  ) => void;
  /**
   * Apply one process event to the activity map (the shell's event subscription
   * calls this instead of reducing and setting state itself).
   */
  readonly recordEvent: (
    event: WebuiRuntimeEvent,
    activeSessionId: string | undefined,
  ) => void;
  /**
   * One probe per visible session, applied as each answer lands. Returns a
   * cancel that drops answers arriving after the caller's effect has torn down
   * — the same `cancelled` guard the shell's inline loop carried.
   */
  readonly probeActiveTurns: (args: {
    readonly sessions: readonly { readonly sessionId: string }[];
    readonly probe: WebuiActiveTurnProbe;
    readonly now: () => number;
  }) => () => void;
}

export function createWebuiRailActivityCommands(
  store: WebuiRailActivityStore,
): WebuiRailActivityCommands {
  const update = store.updateActivity;
  return {
    seed: (sessions) => {
      update((current) => seedWebuiSessionActivity(current, sessions));
    },
    markRead: (sessionId) => {
      update((current) => markWebuiSessionRead(current, sessionId));
    },
    restoreUnreadCounts: (counts, activeSessionId) => {
      update((current) =>
        applyWebuiUnreadCounts(current, counts, activeSessionId),
      );
    },
    persistUnreadCounts: (write) => {
      const activity = store.getSnapshot().activity;
      const counts: Record<string, number> = {};
      for (const [sessionId, entry] of Object.entries(activity)) {
        if (entry.unread && entry.unread > 0) counts[sessionId] = entry.unread;
      }
      write(counts);
    },
    recordEvent: (event, activeSessionId) => {
      update((current) =>
        reduceWebuiSessionActivity(
          current,
          event,
          activeSessionId ? { activeSessionId } : {},
        ),
      );
    },
    probeActiveTurns: (args) => {
      let cancelled = false;
      for (const session of args.sessions) {
        void args.probe
          .probe(session.sessionId)
          .then((active: WebuiActiveTurnResult) => {
            if (cancelled) return;
            update((current) =>
              applyWebuiActiveTurn(
                current,
                session.sessionId,
                active,
                args.now(),
              ),
            );
          })
          .catch(() => undefined);
      }
      return () => {
        cancelled = true;
      };
    },
  };
}
