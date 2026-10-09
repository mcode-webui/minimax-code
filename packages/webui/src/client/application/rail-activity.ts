// The rail-activity slice, relocated to the application layer
// (plan §7.1 `application/unread.ts` — "absorbs the ordering rules now spread
// across six component effects"; §7.7 stage 4, the FoundationApp activity
// slice).
//
// The shell keeps one `watchEvents` subscription and one piece of React state;
// what moves here is *ownership of the slice*: the seed from the session list,
// the mark-read on opening a session, the restore of persisted counts, the
// persistence write, and the active-turn probe. Each is a framework-free unit
// the shell's effects call with its state setter and storage accessors, so the
// ordering rules (seed on the list, restore on the selection, persist gated on
// the restore having run, one probe per visible session) have a single home
// instead of being implicit in effect order.
//
// The unread persistence format is untouched: `session-unread.ts` still owns
// the key, the validation and the shape, and `persistWebuiRailUnreadCounts`
// writes exactly the positive counts it always did.
//
// The probe is the *deduplicated* one (`active-turn-probe.ts`): the shell and
// the composer ask the same transport, so a same-session probe racing between
// them collapses to one round trip.

import type { WebuiActiveTurnResult } from "../../shared/contracts/session.js";
import type { WebuiClientSession } from "../contracts/session-view.js";
import {
  applyWebuiActiveTurn,
  applyWebuiUnreadCounts,
  markWebuiSessionRead,
  seedWebuiSessionActivity,
  type WebuiSessionActivityMap,
} from "../session-activity.js";
import type { WebuiActiveTurnProbe } from "./active-turn-probe.js";

/** A React state updater for the activity map, as the shell's `setState`. */
export type WebuiRailActivityUpdate = (
  update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
) => void;

/** First-paint times from the session list; never invents a `busy`. */
export function seedWebuiRailActivity(
  update: WebuiRailActivityUpdate,
  sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
): void {
  update((current) => seedWebuiSessionActivity(current, sessions));
}

/** Opening a session clears its unread badge. */
export function markWebuiRailSessionRead(
  update: WebuiRailActivityUpdate,
  sessionId: string,
): void {
  update((current) => markWebuiSessionRead(current, sessionId));
}

/** Restore stored counts as a floor, excluding the session the user has open. */
export function restoreWebuiRailUnreadCounts(
  update: WebuiRailActivityUpdate,
  counts: Readonly<Record<string, number>>,
  activeSessionId: string | undefined,
): void {
  update((current) => applyWebuiUnreadCounts(current, counts, activeSessionId));
}

/**
 * Persist the positive counts — the single writer for the unread key, called
 * with the same `writeWebuiUnreadCounts` the shell always used.
 */
export function persistWebuiRailUnreadCounts(
  activity: WebuiSessionActivityMap,
  write: (counts: Readonly<Record<string, number>>) => void,
): void {
  const counts: Record<string, number> = {};
  for (const [sessionId, entry] of Object.entries(activity)) {
    if (entry.unread && entry.unread > 0) counts[sessionId] = entry.unread;
  }
  write(counts);
}

/**
 * One probe per visible session, applied as each answer lands. Returns a cancel
 * that drops answers arriving after the caller's effect has torn down — the
 * same `cancelled` guard the shell's inline loop carried.
 */
export function probeWebuiRailActiveTurns(args: {
  readonly sessions: readonly { readonly sessionId: string }[];
  readonly probe: WebuiActiveTurnProbe;
  readonly update: WebuiRailActivityUpdate;
  readonly now: () => number;
}): () => void {
  let cancelled = false;
  for (const session of args.sessions) {
    void args.probe
      .probe(session.sessionId)
      .then((active: WebuiActiveTurnResult) => {
        if (cancelled) return;
        args.update((current) =>
          applyWebuiActiveTurn(current, session.sessionId, active, args.now()),
        );
      })
      .catch(() => undefined);
  }
  return () => {
    cancelled = true;
  };
}
