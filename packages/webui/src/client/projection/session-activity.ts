// Per-session activity for the session rail: when each session last did
// something, and which ones are running right now.
//
// The runtime already runs sessions in parallel -- `queue.dispatcher.ts` keeps
// one drain loop per session id -- so a turn keeps going after the user
// switches away. Nothing in the client showed that. The rail listed sessions
// with no hint of which were busy or when they were last touched, so a task
// that finished ten minutes ago looks identical to one that never ran.
//
// This module is the state half of that fix. It is deliberately pure: the
// host owns the subscription, the probe and the tick, and calls in here.
//
// Three inputs, because no single one is enough:
//
//   - `seedWebuiSessionActivity` from the session list. Without it the rail is
//     blank on first paint, and a page that was open for an hour shows nothing
//     for the sessions that ran during that hour.
//   - `reduceWebuiSessionActivity` from the event stream. The stream is global
//     -- `watchEvents` takes no session id -- so one subscription covers every
//     row, and the reducer is where events get attributed.
//   - `applyWebuiActiveTurn` from `getActiveTurn`. A `session.start` that
//     arrived before the client finished subscribing, or during a reconnect,
//     is simply never seen. `SessionComposer` already documents this gap and
//     probes the server for exactly this reason; the rail has the same gap and
//     needs the same probe, once, for the sessions it is about to draw.
//
// What this does not claim: that `updatedAt` is the last *conversation* time.
// It is the session record's own timestamp and can move for reasons that have
// nothing to do with a turn. It is a starting value to be corrected by the
// event stream, not a claim about when the user last talked to the agent.

import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";
import type { WebuiActiveTurn } from "../../shared/contracts/session.js";
import type { WebuiClientSession } from "../contracts/session-view.js";

export interface WebuiSessionBusy {
  readonly turnId: string;
  readonly busyReason: WebuiActiveTurn["busyReason"];
}

export interface WebuiSessionActivity {
  /** Epoch ms of the newest thing this session is known to have done. */
  readonly lastActivityAt: number;
  /** Present only while a turn holds the session. */
  readonly busy?: WebuiSessionBusy;
  /**
   * Turns that finished while the user was looking elsewhere. `undefined` and
   * `0` both mean "nothing waiting"; the rail treats them identically, so a
   * read session carries no key rather than a zero.
   */
  readonly unread?: number;
}

export type WebuiSessionActivityMap = Readonly<Record<string, WebuiSessionActivity>>;

export const initialWebuiSessionActivity: WebuiSessionActivityMap = {};

/**
 * Turn-start events. `session.start` is the only one that makes a session busy.
 *
 * A compaction also occupies the session -- `getActiveTurn` reports it as
 * `busyReason: "compaction"` -- but it produces no transcript and this list has
 * no entry for it. Rather than guess at an event name that may not exist, the
 * compaction case is left to the probe, which reads the authoritative reason
 * off the server. The event path claims only what it can actually observe.
 */
const BUSY_START_EVENT_TYPES: ReadonlySet<string> = new Set(["session.start"]);

/**
 * Turn-end events. `session.finish` is the clean exit; the other three are the
 * ways a turn stops without finishing, and a session left spinning after an
 * abort is worse than one that never showed a spinner.
 */
const BUSY_END_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.finish",
  "session.error",
  "session.abort",
  "session.aborted",
]);

/**
 * Events that count as "this session did something". `session.status_updated`
 * is in because a status change is activity the user would expect the row to
 * reflect. Nothing else is: an event that names no session cannot be
 * attributed, and a `todo_updated` for a subagent would otherwise stamp the
 * parent's row with a time the parent was not active at.
 */
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...BUSY_START_EVENT_TYPES,
  ...BUSY_END_EVENT_TYPES,
  "session.status_updated",
]);

/**
 * The session an event is about, or `undefined` when it names none.
 *
 * A missing id is not an error to report and not a reason to ignore the event
 * silently in the log -- it simply cannot be attributed to a row, so the
 * reducer returns its input unchanged. `effect-reducer.ts` makes the same call
 * for the same reason when it drops an event that is not addressed to the
 * session it is rendering.
 */
export function readWebuiEventSessionId(event: WebuiRuntimeEvent): string | undefined {
  const sessionId = event.payload.sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
}

/**
 * First-paint values from the session list.
 *
 * `updatedAt` seeds `lastActivityAt`; it never invents a `busy`, because the
 * list carries no turn id and a stale "running" row is a lie the user acts on.
 * Only `reduceWebuiSessionActivity` and `applyWebuiActiveTurn` may set `busy`.
 *
 * A session the event stream already knows more about is left alone. The list
 * can arrive *after* the events -- a refresh racing a live turn would otherwise
 * stamp `updatedAt` over a turn that started a second ago and make a running
 * session look idle.
 */
export function seedWebuiSessionActivity(
  previous: WebuiSessionActivityMap,
  sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
): WebuiSessionActivityMap {
  if (sessions.length === 0) return previous;
  let changed = false;
  const next: Record<string, WebuiSessionActivity> = { ...previous };
  for (const session of sessions) {
    const current = next[session.sessionId];
    if (current && current.lastActivityAt >= session.updatedAt) continue;
    next[session.sessionId] = {
      lastActivityAt: session.updatedAt,
      ...(current?.busy ? { busy: current.busy } : {}),
      ...(current?.unread ? { unread: current.unread } : {}),
    };
    changed = true;
  }
  return changed ? next : previous;
}

/**
 * Fold one runtime event into the map.
 *
 * Returns the *same object* when the event changes nothing, so the host can
 * skip a re-render on the high-volume events that are not about a session.
 */
export function reduceWebuiSessionActivity(
  previous: WebuiSessionActivityMap,
  event: WebuiRuntimeEvent,
  options: { readonly activeSessionId?: string } = {},
): WebuiSessionActivityMap {
  if (!ACTIVITY_EVENT_TYPES.has(event.type)) return previous;
  const sessionId = readWebuiEventSessionId(event);
  if (!sessionId) return previous;

  const current = previous[sessionId];
  const lastActivityAt = Math.max(current?.lastActivityAt ?? 0, event.timestamp);

  if (BUSY_START_EVENT_TYPES.has(event.type)) {
    const rawTurnId = event.payload.turnId;
    const busy: WebuiSessionBusy = {
      turnId: typeof rawTurnId === "string" ? rawTurnId : "",
      busyReason: "turn",
    };
    if (current?.busy?.turnId === busy.turnId && current.lastActivityAt === lastActivityAt) {
      return previous;
    }
    return {
      ...previous,
      [sessionId]: {
        lastActivityAt,
        busy,
        ...(current?.unread ? { unread: current.unread } : {}),
      },
    };
  }

  if (BUSY_END_EVENT_TYPES.has(event.type)) {
    if (!current) {
      // An end for a session the rail has not seen start -- a turn that began
      // before this client subscribed. Recording it is what lets the probe tell
      // "finished long ago" from "running": without an entry there is nothing
      // for the probe to clear.
      return { ...previous, [sessionId]: { lastActivityAt } };
    }
    // A finished turn counts as unread only for a session the user is not
    // sitting in. The open session is the one place where "3 new turns" is
    // noise rather than news, and a badge over the row being read is the
    // fastest way to make the badge stop being read at all.
    const unread =
      event.type === "session.finish" && options.activeSessionId !== sessionId
        ? (current.unread ?? 0) + 1
        : current.unread;
    if (!current.busy && current.lastActivityAt === lastActivityAt && unread === current.unread) {
      return previous;
    }
    return { ...previous, [sessionId]: { lastActivityAt, ...(unread ? { unread } : {}) } };
  }

  // `session.status_updated` and friends: activity, no change of busy state.
  if (current && current.lastActivityAt === lastActivityAt) return previous;
  return {
    ...previous,
    [sessionId]: {
      lastActivityAt,
      ...(current?.busy ? { busy: current.busy } : {}),
      ...(current?.unread ? { unread: current.unread } : {}),
    },
  };
}

/**
 * Clear a session's unread count -- the user opened it.
 *
 * Drops the key rather than storing a zero so a read session and a session that
 * never ran are the same object, and so the stored map only ever holds sessions
 * that are actually waiting.
 */
export function markWebuiSessionRead(
  previous: WebuiSessionActivityMap,
  sessionId: string,
): WebuiSessionActivityMap {
  const current = previous[sessionId];
  if (!current?.unread) return previous;
  const { unread: _unread, ...rest } = current;
  return { ...previous, [sessionId]: rest };
}

/**
 * Re-apply stored counts to a freshly built map.
 *
 * Restored on top of the seeded state rather than merged into it, so a count
 * survives the list refresh that would otherwise rebuild the map around
 * `updatedAt` alone. Sessions the user currently has open are dropped: the
 * open transcript already shows them.
 */
export function applyWebuiUnreadCounts(
  previous: WebuiSessionActivityMap,
  counts: Readonly<Record<string, number>>,
  activeSessionId?: string,
): WebuiSessionActivityMap {
  const entries = Object.entries(counts).filter(
    ([sessionId, count]) => count > 0 && sessionId !== activeSessionId,
  );
  if (entries.length === 0) return previous;
  const next = { ...previous };
  for (const [sessionId, count] of entries) {
    const current = next[sessionId];
    // The restored count is a floor, not an answer. It was written by an
    // earlier run of this same code and can only be as fresh as the last
    // successful write, whereas the live value has been counting events since.
    // Overwriting with it would let a badge shrink on its own the moment the
    // rail re-rendered -- and a write that failed (quota, private mode) makes
    // that guaranteed rather than merely possible, because what is on disk is
    // then permanently behind.
    const live = current?.unread ?? 0;
    next[sessionId] = {
      ...(current ?? { lastActivityAt: 0 }),
      unread: live > count ? live : count,
    };
  }
  return next;
}

/**
 * Apply one `getActiveTurn` answer.
 *
 * This is the authoritative path and it can contradict the event stream, which
 * is the point: the probe exists to repair the events this client never saw.
 * `undefined` means the server says nothing is running, so any `busy` the event
 * stream left behind is dropped -- a stale spinner outlives its turn otherwise.
 */
export function applyWebuiActiveTurn(
  previous: WebuiSessionActivityMap,
  sessionId: string,
  active: WebuiActiveTurn | undefined,
  observedAt: number,
): WebuiSessionActivityMap {
  const current = previous[sessionId];
  if (!active) {
    if (!current?.busy) return previous;
    const { busy: _busy, ...rest } = current;
    return { ...previous, [sessionId]: rest };
  }
  const busy: WebuiSessionBusy = { turnId: active.turnId, busyReason: active.busyReason };
  if (current?.busy?.turnId === busy.turnId && current.busy.busyReason === busy.busyReason) {
    return previous;
  }
  // Only `busy` is the probe's to write. Carrying `unread` across matters: this
  // answer is asked on a timer and can land after the turn it describes has
  // already finished, so rebuilding the entry without it would read as "the
  // user went back and looked".
  return {
    ...previous,
    [sessionId]: {
      lastActivityAt: current?.lastActivityAt ?? 0,
      busy,
      ...(current?.unread ? { unread: current.unread } : {}),
    },
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact age, the form the rail has room for.
 *
 * Units rather than `Intl.RelativeTimeFormat`: that renders "21分钟前" in zh,
 * which does not fit beside a truncated session name, and the rail's other
 * badges are already terse.
 *
 * A clock skewed behind the timestamp yields a negative age; that is rendered
 * as "now" rather than as a negative number, because a row reading "-3m" is a
 * bug report waiting to happen and the difference it hides is under a minute.
 */
export function formatWebuiSessionAge(lastActivityAt: number, now: number): string {
  const age = now - lastActivityAt;
  if (age < MINUTE_MS) return "now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`;
  if (age < 30 * DAY_MS) return `${Math.floor(age / DAY_MS)}d`;
  return new Date(lastActivityAt).toISOString().slice(0, 10);
}
