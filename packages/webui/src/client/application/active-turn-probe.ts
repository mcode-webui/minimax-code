// Deduplicated same-session active-turn probe (plan §7.1 `application/`).
//
// `getActiveTurn` is the authoritative repair for a turn this client never saw:
// a `session.start` that arrived before the subscription was live, or was lost
// while `watchEvents` reconnected. Three callers ask it — the shell's rail
// probe (once per visible row), the composer's gap recovery, and the composer's
// recheck of a lease a `session.start` no longer matches — and two of them can
// ask about the same session within the same round trip.
//
// This module is the single place that probe policy lives. It coalesces
// *concurrent* requests for one session into one round trip: the second caller
// gets the first caller's promise. The in-flight entry is dropped the moment it
// settles, so a later, genuinely new probe (the reconnect nonce, a fresh mount)
// always goes to the wire again — the dedup is of overlap, not of intent. That
// is the whole difference from the callers' old `getActiveTurn({ id })`, which
// fired a request per caller.

import type {
  WebuiActiveTurnRequest,
  WebuiActiveTurnResult,
} from "../../shared/contracts/session.js";

export type WebuiActiveTurnProbeFn = (
  request: WebuiActiveTurnRequest,
) => Promise<WebuiActiveTurnResult>;

export interface WebuiActiveTurnProbe {
  /** Ask the server for the active turn; concurrent same-session calls share. */
  readonly probe: (sessionId: string) => Promise<WebuiActiveTurnResult>;
}

export function createWebuiActiveTurnProbe(
  getActiveTurn: WebuiActiveTurnProbeFn,
): WebuiActiveTurnProbe {
  const inFlight = new Map<string, Promise<WebuiActiveTurnResult>>();
  return {
    probe: (sessionId) => {
      const pending = inFlight.get(sessionId);
      if (pending) return pending;
      const shared = getActiveTurn({ id: sessionId }).finally(() => {
        // Only the entry this call installed is removed: a newer probe that
        // replaced it must not be cleared by an older one settling.
        if (inFlight.get(sessionId) === shared) inFlight.delete(sessionId);
      });
      inFlight.set(sessionId, shared);
      return shared;
    },
  };
}

// One probe per distinct `getActiveTurn` function, so the shell and the
// composer — which both receive the same transport method — share one in-flight
// map and their same-session requests coalesce across components. Keyed by the
// function itself (a `WeakMap`), so a replaced transport gets a fresh probe and
// nothing is retained past the transport's life.
const probes = new WeakMap<WebuiActiveTurnProbeFn, WebuiActiveTurnProbe>();

export function webuiActiveTurnProbeFor(
  getActiveTurn: WebuiActiveTurnProbeFn | undefined,
): WebuiActiveTurnProbe | undefined {
  if (!getActiveTurn) return undefined;
  let probe = probes.get(getActiveTurn);
  if (!probe) {
    probe = createWebuiActiveTurnProbe(getActiveTurn);
    probes.set(getActiveTurn, probe);
  }
  return probe;
}
