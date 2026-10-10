// The single stream-lease implementation (plan §7.1 `application/`, §7.2
// `mechanisms/stream-lease.ts`, ticket #45): claim, release and generation
// fencing in one place.
//
// The recovery policy the ticket calls "the highest-risk part" reduces to one
// rule: a stream attempt owns a *generation*, and only the newest generation
// may write. A superseded attempt — one whose `[DONE]` already arrived, or one
// the user replaced by retrying — holds an older generation, so its late
// chunks, its late `[DONE]` and its late refusal are dropped before they reach
// the store. That is what "frames from a superseded generation produce zero
// state writes" means, and it is why the fence lives here rather than in each
// caller.
//
// Why the counter lives in this module and not on the wire: only the client can
// tell two concurrent attempts apart. The server exposes no handle to cancel a
// stream, so a superseded attempt keeps producing frames; identity has to be
// assigned client-side. There is exactly one counter, one claim, one release and
// one fence predicate.

import type {
  WebuiStreamState,
  WebuiStreamSubscription,
  WebuiSubscriptionReleaseScope,
} from "../contracts/stream-state.js";

export type WebuiLeaseOwner = WebuiStreamSubscription["owner"];

/**
 * Monotonic client-side attempt identity. One counter for the whole client.
 *
 * **Every** claim path draws from it — the lease's own `claimWebuiLease` and the
 * loop sink's `claimSubscription`, which receives it through the injected
 * `streamState` bundle. Two counters would let two attempts claim the same
 * generation: both start at 0 and increment independently, so the numbers
 * overlap, and since both paths stamp the same `lastClaimedGeneration` field and
 * `isWebuiLeaseGenerationCurrent` compares only the number, a superseded claim
 * would answer "I am current". One counter is what makes that comparison mean
 * "newest", not "newest of one sequence".
 */
let leaseGeneration = 0;

export function nextWebuiLeaseGeneration(): number {
  leaseGeneration += 1;
  return leaseGeneration;
}

export interface WebuiLeaseClaimResult {
  readonly state: WebuiStreamState;
  readonly generation: number;
}

/**
 * Claim the session's stream for an attempt. Records the assessed turn id when
 * one is known (a local send learns its turn from the runtime's own
 * `session.start`, so it claims with none) and stamps the newest generation.
 */
export function claimWebuiLease(
  state: WebuiStreamState,
  owner: WebuiLeaseOwner,
  turnId?: string,
): WebuiLeaseClaimResult {
  const generation = nextWebuiLeaseGeneration();
  return {
    generation,
    state: {
      ...state,
      lastClaimedGeneration: generation,
      subscription: {
        owner,
        generation,
        ...(turnId ? { turnId } : {}),
      },
    },
  };
}

export interface WebuiLeaseReleaseScope {
  readonly generation?: number;
  readonly turnId?: string;
}

/**
 * Release the lease, optionally scoped. A scoped release only clears a matching
 * lease, so a superseded attempt's late terminal frame or a terminal *event*
 * for an older turn cannot strip the lease the current attempt just took. The
 * matching semantics are the existing projection's — this delegates so there is
 * not a second copy of the comparison.
 */
export function releaseWebuiLease(
  state: WebuiStreamState,
  scope?: WebuiLeaseReleaseScope,
): WebuiStreamState {
  return releaseWebuiSubscription(state, scope);
}

/**
 * Whether an attempt holding `generation` is still the newest claimant.
 *
 * Fencing is about *other* attempts, not about the lease still being visible: a
 * `[DONE]` releases the lease mid-attempt while the attempt keeps working (a
 * `resume_overflow` may already be pending a resync), so the test is "am I the
 * newest claimer", not "do I still hold a lease". Comparing against the lease
 * instead would re-admit a superseded attempt the instant the newer turn's
 * `[DONE]` cleared it.
 *
 * An attempt that never claimed a generation cannot be told apart from a live
 * one; it is admitted only while no lease is held, matching the loop sink's
 * historical behaviour.
 */
export function isWebuiLeaseGenerationCurrent(
  state: WebuiStreamState,
  generation: number | undefined,
): boolean {
  if (generation === undefined) return state.subscription === undefined;
  return state.lastClaimedGeneration === generation;
}

/** Apply a write only when `generation` is still the newest claimant. */
export function fenceWebuiLeaseStream(
  state: WebuiStreamState,
  generation: number | undefined,
  apply: (current: WebuiStreamState) => WebuiStreamState,
): WebuiStreamState {
  return isWebuiLeaseGenerationCurrent(state, generation) ? apply(state) : state;
}

/** Whether `generation` currently holds the lease (not merely newest). */
export function isWebuiLeaseHeldBy(
  state: WebuiStreamState,
  generation: number | undefined,
): boolean {
  if (generation === undefined) return state.subscription === undefined;
  return state.subscription?.generation === generation;
}

export function releaseWebuiSubscription(
  state: WebuiStreamState,
  scope?: WebuiSubscriptionReleaseScope,
): WebuiStreamState {
  const owned = state.subscription;
  if (owned === undefined) return state;
  if (scope?.generation !== undefined && owned.generation !== scope.generation)
    return state;
  if (scope?.turnId !== undefined && owned.turnId !== scope.turnId) return state;
  return { ...state, subscription: undefined };
}