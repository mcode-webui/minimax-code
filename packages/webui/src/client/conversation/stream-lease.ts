// The mechanism half of stream ownership: the single generation counter and the
// currency predicate, plus the two facts they read from whatever holds a lease.
//
// The recovery policy reduces to one rule: a stream attempt owns a *generation*,
// and only the newest generation may write. A superseded attempt — one whose
// `[DONE]` already arrived, or one the user replaced by retrying — holds an older
// generation, so its late chunks, its late `[DONE]` and its late refusal are
// dropped before they reach the aggregate.
//
// Why the counter lives here and not on the wire: only the client can tell two
// concurrent attempts apart. The server exposes no handle to cancel a stream, so a
// superseded attempt keeps producing frames; identity has to be assigned
// client-side.
//
// What this module deliberately does **not** know: what an attempt is attached to,
// or what its aggregate looks like. The claim and the scoped release — which write
// the owner, the generation and the turn into the session's stream record — live
// with that aggregate's owner (`features/turn/application/stream-lease.ts`).
// Importing the aggregate here is what made a reusable mechanism depend on one
// conversation composition.

/**
 * The two facts the mechanism reads from whatever holds a lease.
 *
 * Structural on purpose: the Turn aggregate satisfies it, and so would another
 * aggregate, without this module importing either one. `subscription` is opaque —
 * the mechanism only distinguishes present from absent. The business aggregate
 * that carries those two facts, and every transform applied to it, lives with its
 * owner (`features/turn/application/stream-lease.ts`). Importing that aggregate
 * here is what made a reusable mechanism depend on one conversation composition.
 */
export interface WebuiLeaseGenerationState {
  /** The newest generation any attempt claimed. */
  readonly lastClaimedGeneration?: number;
  /** Present while an attempt holds the lease; its shape is the owner's. */
  readonly subscription?: unknown;
}

/**
 * Monotonic client-side attempt identity. One counter for the whole client.
 *
 * **Every** claim path draws from it — the Turn owner's claim and the loop sink's
 * `claimSubscription`, which receives it through the injected `streamState`
 * bundle. Two counters would let two attempts claim the same generation: both
 * start at 0 and increment independently, so the numbers overlap, and since both
 * paths stamp the same `lastClaimedGeneration` field and the currency check
 * compares only the number, a superseded claim would answer "I am current". One
 * counter is what makes that comparison mean "newest", not "newest of one
 * sequence".
 */
let leaseGeneration = 0;

export function nextWebuiLeaseGeneration(): number {
  leaseGeneration += 1;
  return leaseGeneration;
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
  state: WebuiLeaseGenerationState,
  generation: number | undefined,
): boolean {
  if (generation === undefined) return state.subscription === undefined;
  return state.lastClaimedGeneration === generation;
}
