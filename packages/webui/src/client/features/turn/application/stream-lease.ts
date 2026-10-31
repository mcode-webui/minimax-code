// The Turn-owned lease transitions.
//
// The generation counter and the currency predicate are the mechanism's
// (`client/conversation/stream-lease.ts`): a number, and whether that number is
// still the newest. What an attempt is *attached to* is this business's — the
// session's stream record, its subscription, and the turn it names. Those
// transforms live here so the mechanism imports no aggregate at all.
//
// This module is the other half of that split: the
// delivery loop/lease keep shared frame vocabulary and generation fencing, and the
// business translation sits with the business. Moving only the declarations while
// leaving these transforms in `conversation/` would have preserved the defect,
// because the mechanism would still have had to know the aggregate's shape to
// write it.
//
// Framework-free: no React, no DOM, no storage.

import type {
  WebuiStreamState,
  WebuiStreamSubscription,
  WebuiSubscriptionReleaseScope,
} from "../contracts/stream-state.js";
import { nextWebuiLeaseGeneration } from "../../../conversation/stream-lease.js";

/** Who is claiming a session's stream. */
export type WebuiLeaseOwner = WebuiStreamSubscription["owner"];

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
 * Clear the subscription, scoped to a generation and/or a turn when one is
 * given. An unscoped call clears whatever is held, which is what a "the turn is
 * over" path wants; a scoped one is what a late frame from an older attempt
 * needs, because it must not strip a lease it does not own.
 */
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
