// The application unread controller (plan §7.1 `application/unread.ts`;
// §7.6 "Unread"; ticket #49 criterion 4).
//
// It is the **single owner of unread hydration ordering**. The ordering rules
// used to be spread across the shell: a `unreadCountsReady` flag, a persist
// effect gated on it and a restore effect that raised it. That split is what
// this module replaces — the shell no longer holds a `ready` flag, a persist
// effect or a restore effect, and there is exactly one implementation that
// sequences "read the stored counts, apply them as a floor, then persist".
//
// The contract the module enforces:
//
//   * **Hydration before counted events.** `hydrate` reads storage, applies the
//     counts (as a floor, excluding the open session) and marks the controller
//     hydrated. `recordEvent` refuses to fold a counted event into the activity
//     map until that flag is set, so a `session.finish` that lands before the
//     stored counts are in place cannot be counted against an empty map and
//     then overwritten. The composition root hydrates synchronously before it
//     opens the process-event channel, so this is a guarantee rather than a
//     race.
//   * **One persistence writer.** `persist` writes the current positive counts
//     through the injected storage adapter — the same key, the same
//     positive-integer validation on the way in (`infrastructure/storage.ts`),
//     the same positive-count filter on the way out. A store subscription calls
//     it on every activity change *after* hydration, which is the ordering the
//     shell's two effects used to encode by hand.
//
// The persistence format is untouched: `infrastructure/storage.ts` owns the
// key, the validation and the shape, and it is *injected* here (this module is
// the application layer and may not import infrastructure), so the byte layout
// on disk is exactly what it always was.
//
// The probe is the deduplicated one (`active-turn-probe.ts`): the shell asks
// the same transport, so a same-session probe collapses to one round trip.

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
 * reader, writer and subscription. A `WebuiSessionStore` satisfies it
 * structurally, so the composition root binds the controller to the one store
 * without adapting it.
 */
export interface WebuiUnreadStore {
  readonly getSnapshot: () => { readonly activity: WebuiSessionActivityMap };
  readonly updateActivity: (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface WebuiUnreadControllerDeps {
  readonly store: WebuiUnreadStore;
  /** Reads the persisted counts (the storage adapter's `read`). */
  readonly read?: () => Readonly<Record<string, number>>;
  /** Writes the positive counts (the storage adapter's `write`). */
  readonly write?: (counts: Readonly<Record<string, number>>) => void;
}

export interface WebuiUnreadController {
  /** Whether hydration has completed; counted events wait for this. */
  readonly isHydrated: () => boolean;
  /**
   * Read the stored counts, apply them as a floor (excluding the open session),
   * mark hydrated and persist. Idempotent and safe to re-run on a session
   * switch — the open session's freshly-cleared badge must not be re-raised by
   * a stale stored value.
   */
  readonly hydrate: (activeSessionId: string | undefined) => void;
  /**
   * Persist the positive counts. Gated on hydration, so the empty map the
   * first render sees can never overwrite the key before the restore read it.
   */
  readonly persist: () => void;
  /** First-paint times from the session list; never invents a `busy`. */
  readonly seed: (
    sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
  ) => void;
  /** Opening a session clears its unread badge. */
  readonly markRead: (sessionId: string) => void;
  /**
   * Fold one process event into the activity map. Gated on hydration: a
   * counted event is accepted only once the stored counts are in place.
   */
  readonly recordEvent: (
    event: WebuiRuntimeEvent,
    activeSessionId: string | undefined,
  ) => void;
  /**
   * One probe per visible session, applied as each answer lands. Returns a
   * cancel that drops answers arriving after the caller's effect has torn down.
   */
  readonly probeActiveTurns: (args: {
    readonly sessions: readonly { readonly sessionId: string }[];
    readonly probe: WebuiActiveTurnProbe;
    readonly now: () => number;
  }) => () => void;
}

export function createWebuiUnreadController(
  deps: WebuiUnreadControllerDeps,
): WebuiUnreadController {
  const { store } = deps;
  const read = deps.read ?? (() => ({}));
  const write = deps.write ?? (() => undefined);
  let hydrated = false;
  let lastActivity = store.getSnapshot().activity;

  const persist = (): void => {
    if (!hydrated) return;
    const activity = store.getSnapshot().activity;
    const counts: Record<string, number> = {};
    for (const [sessionId, entry] of Object.entries(activity)) {
      if (entry.unread && entry.unread > 0) counts[sessionId] = entry.unread;
    }
    write(counts);
  };

  // The one persistence trigger. It fires on every activity change; before
  // hydration the gate above makes it a no-op, so the empty first map cannot
  // reach storage.
  store.subscribe(() => {
    const activity = store.getSnapshot().activity;
    if (activity === lastActivity) return;
    lastActivity = activity;
    persist();
  });

  return {
    isHydrated: () => hydrated,
    hydrate: (activeSessionId) => {
      const counts = read();
      store.updateActivity((current) =>
        applyWebuiUnreadCounts(current, counts, activeSessionId),
      );
      lastActivity = store.getSnapshot().activity;
      hydrated = true;
      // Match the old restore effect: the restore *and* the persist that
      // followed it in the shell. The stored value is deliberately dropped for
      // the now-open session here.
      persist();
    },
    persist,
    seed: (sessions) => {
      store.updateActivity((current) =>
        seedWebuiSessionActivity(current, sessions),
      );
    },
    markRead: (sessionId) => {
      store.updateActivity((current) => markWebuiSessionRead(current, sessionId));
    },
    recordEvent: (event, activeSessionId) => {
      // Hydration is the gate: a counted event is not accepted until the
      // stored counts are in place.
      if (!hydrated) return;
      store.updateActivity((current) =>
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
            store.updateActivity((current) =>
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
