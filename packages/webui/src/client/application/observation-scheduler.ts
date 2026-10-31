// The application's observation scheduler.
//
// Two bounded classes of periodic business read live here, and they exist because
// the reads have two different reasons to happen:
//
//   * **Activity** — "which of these sessions has a turn running?" One probe per
//     interested session, once, when that session becomes interesting (or is
//     invalidated by a reconnect). What matters is the *identity set*: the rail's
//     page object is a fresh value on every refresh and on every search
//     keystroke, and a probe per keystroke is work nobody asked for.
//   * **Inspection** — the foreground freshness policy. The data directory,
//     the configuration and the credentials are shared with the CLI and other
//     clients, and the event chain does not prove complete notification of
//     external change, so the shown session's model catalogue and account status
//     are re-read on a freshness budget (2 s) while the surface is interested.
//
// Three properties are what make it one mechanism rather than two timers:
//
//   * **Capacity is separate.** Activity may have 8 probes in flight; inspection
//     has its own 2. A saturated rail therefore cannot starve the composer's
//     read, and a slow inspection read cannot hide behind the rail's backlog.
//   * **Work is identity-addressed and coalesced.** Registering the same identity
//     set again schedules nothing; a *new* identity (or an invalidated one) is
//     scheduled once. Superseded queued work is dropped rather than run.
//   * **Hidden or uninterested means stopped.** Suspending issues nothing and
//     resumes by re-establishing freshness. It never touches accepted Turn
//     execution or delivery — those are not observations.

import type {
  WebuiObservationRequest,
  WebuiObservationSignal,
} from "../../shared/contracts/observations.js";

/**
 * One scheduled read, and the signal its runner is handed.
 *
 * The shapes live in `shared/contracts/observations.ts` because the businesses that
 * register reads must be able to name them without importing this file: a composer
 * that imported the scheduler to type one field would be depending on the rail's
 * mechanism to describe its own.
 */
export type { WebuiObservationRequest, WebuiObservationSignal };

export interface WebuiObservationStats {
  readonly activityInFlight: number;
  readonly inspectionInFlight: number;
  /** Probes actually issued, per class. The count that makes "zero extra" checkable. */
  readonly activityIssued: number;
  readonly inspectionIssued: number;
  readonly activityQueued: number;
  readonly inspectionQueued: number;
  /** Identities currently registered, per class. */
  readonly activityInterested: number;
  readonly inspectionInterested: number;
}

export interface WebuiObservationSchedulerOptions {
  /** Activity probes in flight at once. */
  readonly activityBudget?: number;
  /** Foreground inspection reads in flight at once. */
  readonly inspectionBudget?: number;
  /** How long an inspection identity stays fresh after a successful read. */
  readonly inspectionFreshnessMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, delayMs: number) => () => void;
}

export interface WebuiObservationScheduler {
  readonly setActivityInterest: (requests: readonly WebuiObservationRequest[]) => void;
  readonly setInspectionInterest: (requests: readonly WebuiObservationRequest[]) => void;
  /** Mark one identity stale: a known change, or a reconnect. */
  readonly invalidate: (identity: string) => void;
  readonly invalidateAll: () => void;
  /** Reconnect repair for activity without restarting a freshly resumed inspection. */
  readonly invalidateActivity: () => void;
  /** Hidden page or no interest: stop scheduling. Accepted execution is untouched. */
  readonly setSuspended: (suspended: boolean) => void;
  readonly isSuspended: () => boolean;
  readonly stats: () => WebuiObservationStats;
  readonly dispose: () => void;
}

const DEFAULT_ACTIVITY_BUDGET = 8;
const DEFAULT_INSPECTION_BUDGET = 2;
const DEFAULT_INSPECTION_FRESHNESS_MS = 2_000;

interface ClassState {
  readonly budget: number;
  /** When each interested identity was last read successfully. */
  readonly freshAt: Map<string, number>;
  readonly interested: Map<string, WebuiObservationRequest>;
  readonly queued: Map<string, WebuiObservationRequest>;
  /**
   * Identities with a read running right now.
   *
   * The budget counts reads in flight; this counts *which* identities have one, so a
   * deadline that fires while its own read is still running queues a follow-up instead
   * of starting a second, overlapping read of the same resource.
   */
  readonly inFlightIds: Set<string>;
  inFlight: number;
  issued: number;
}

export function createWebuiObservationScheduler(
  options: WebuiObservationSchedulerOptions = {},
): WebuiObservationScheduler {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((run: () => void, delayMs: number) => {
      const handle = setTimeout(run, delayMs);
      return () => clearTimeout(handle);
    });
  const activity: ClassState = {
    budget: options.activityBudget ?? DEFAULT_ACTIVITY_BUDGET,
    freshAt: new Map(),
    interested: new Map(),
    queued: new Map(),
    inFlightIds: new Set(),
    inFlight: 0,
    issued: 0,
  };
  const inspection: ClassState = {
    budget: options.inspectionBudget ?? DEFAULT_INSPECTION_BUDGET,
    freshAt: new Map(),
    interested: new Map(),
    queued: new Map(),
    inFlightIds: new Set(),
    inFlight: 0,
    issued: 0,
  };
  const inspectionFreshnessMs =
    options.inspectionFreshnessMs ?? DEFAULT_INSPECTION_FRESHNESS_MS;
  let suspended = false;
  let disposed = false;
  let cancelFreshnessTimer: (() => void) | undefined;

  const isCurrent = (state: ClassState, identity: string): boolean =>
    !disposed && state.interested.has(identity);

  const scheduleFreshness = (): void => {
    if (disposed || suspended) return;
    cancelFreshnessTimer?.();
    cancelFreshnessTimer = undefined;
    // The identity closest to being stale decides the next tick. With no
    // interested identity there is nothing to expire, so nothing is scheduled —
    // a detached composer costs no timer.
    let nearest: number | undefined;
    for (const identity of inspection.interested.keys()) {
      // An identity that has not been read yet is fresh *from registration*, which is
      // what `register` records. Reading the clock instead of the wall epoch matters:
      // an unanswered freshness deadline is computed against `0`, which on a real clock
      // is in the past, so the tick armed immediately and re-armed itself — a spin, not
      // a schedule. A test whose clock starts at zero cannot see that.
      const due = (inspection.freshAt.get(identity) ?? now()) + inspectionFreshnessMs;
      nearest = nearest === undefined ? due : Math.min(nearest, due);
    }
    if (nearest === undefined) return;
    const delay = Math.max(0, nearest - now());
    cancelFreshnessTimer = setTimer(() => {
      cancelFreshnessTimer = undefined;
      for (const identity of inspection.interested.keys()) {
        const due = (inspection.freshAt.get(identity) ?? 0) + inspectionFreshnessMs;
        if (due <= now()) inspection.queued.set(identity, inspection.interested.get(identity)!);
      }
      pump(inspection);
      scheduleFreshness();
    }, delay);
  };

  const pump = (state: ClassState): void => {
    if (disposed || suspended) return;
    while (state.inFlight < state.budget && state.queued.size > 0) {
      const [identity, request] = state.queued.entries().next().value as [
        string,
        WebuiObservationRequest,
      ];
      state.queued.delete(identity);
      // Work that stopped being interesting while queued is dropped, not run: a
      // probe for a session the user has left is exactly the work the identity
      // rule exists to remove.
      if (!state.interested.has(identity)) continue;
      if (state.inFlightIds.has(identity)) {
        // Its own read is still running, so this is a follow-up: put it back and stop
        // scanning, because nothing else in the queue can be issued ahead of it
        // without reordering work the caller asked for. The running read's completion
        // pumps again and this one goes then.
        state.queued.set(identity, request);
        break;
      }
      state.inFlight += 1;
      state.issued += 1;
      state.inFlightIds.add(identity);
      void Promise.resolve()
        .then(() => request.run({ isCurrent: () => isCurrent(state, identity) }))
        .catch(() => undefined)
        .finally(() => {
          state.inFlight -= 1;
          state.inFlightIds.delete(identity);
          if (isCurrent(state, identity)) state.freshAt.set(identity, now());
          pump(state);
        });
    }
  };

  const register = (
    state: ClassState,
    requests: readonly WebuiObservationRequest[],
  ): void => {
    if (disposed) return;
    const next = new Map(requests.map((request) => [request.identity, request]));
    for (const identity of [...state.interested.keys()]) {
      if (next.has(identity)) continue;
      // Left the interest set: forget its freshness and drop queued work for it.
      state.interested.delete(identity);
      state.queued.delete(identity);
      state.freshAt.delete(identity);
    }
    for (const [identity, request] of next) {
      const known = state.interested.get(identity);
      state.interested.set(identity, request);
      if (known) {
        // The identity was already interesting, so nothing new is scheduled: this
        // is the rule that makes a rail search keystroke cost zero probes. The
        // stored request is refreshed because the run closure may be new.
        continue;
      }
      state.queued.set(identity, request);
      // Fresh from now: the deadline is `now + freshness`, not an epoch-derived
      // instant that is already past.
      state.freshAt.set(identity, now());
    }
    pump(state);
  };

  const invalidate = (identity: string): void => {
    for (const state of [activity, inspection]) {
      if (!state.interested.has(identity)) continue;
      state.freshAt.delete(identity);
      state.queued.set(identity, state.interested.get(identity)!);
      pump(state);
    }
    scheduleFreshness();
  };

  return {
    setActivityInterest: (requests) => {
      register(activity, requests);
    },
    setInspectionInterest: (requests) => {
      register(inspection, requests);
      // An inspection identity is fresh for `inspectionFreshnessMs` after a read,
      // so the next read is due when that expires.
      scheduleFreshness();
    },
    invalidate,
    invalidateAll: () => {
      for (const state of [activity, inspection]) {
        state.freshAt.clear();
        for (const [identity, request] of state.interested) state.queued.set(identity, request);
        pump(state);
      }
      scheduleFreshness();
    },
    invalidateActivity: () => {
      activity.freshAt.clear();
      for (const [identity, request] of activity.interested) activity.queued.set(identity, request);
      pump(activity);
    },
    setSuspended: (next) => {
      if (suspended === next) return;
      suspended = next;
      if (suspended) {
        cancelFreshnessTimer?.();
        cancelFreshnessTimer = undefined;
        return;
      }
      // Resuming re-establishes freshness: a suspension is exactly the window in
      // which the shared data directory may have changed underneath us.
      for (const state of [activity, inspection]) {
        state.freshAt.clear();
        for (const [identity, request] of state.interested) state.queued.set(identity, request);
        pump(state);
      }
      scheduleFreshness();
    },
    isSuspended: () => suspended,
    stats: () => ({
      activityInFlight: activity.inFlight,
      inspectionInFlight: inspection.inFlight,
      activityIssued: activity.issued,
      inspectionIssued: inspection.issued,
      activityQueued: activity.queued.size,
      inspectionQueued: inspection.queued.size,
      activityInterested: activity.interested.size,
      inspectionInterested: inspection.interested.size,
    }),
    dispose: () => {
      disposed = true;
      cancelFreshnessTimer?.();
      cancelFreshnessTimer = undefined;
      for (const state of [activity, inspection]) {
        state.interested.clear();
        state.queued.clear();
        state.freshAt.clear();
      }
    },
  };
}
