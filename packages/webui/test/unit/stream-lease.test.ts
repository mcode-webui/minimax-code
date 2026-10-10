// The stream lease's generation counter (plan §7.2
// `client/mechanisms/stream-lease.ts`).
//
// These pin the property the module's own header states: there is exactly one
// counter. Two claim paths stamp the same `lastClaimedGeneration` field — the
// lease's `claimWebuiLease` and the loop sink's `claimSubscription`, which
// receives its number through the injected `streamState` bundle — and
// `isWebuiLeaseGenerationCurrent` compares only the number. With two counters
// both starting at 0 and incrementing independently the numbers overlap, so a
// superseded claim answers "I am current". These tests fail if a second counter
// is reintroduced.

import { describe, expect, it } from "vitest";

import {
  claimWebuiLease,
  isWebuiLeaseGenerationCurrent,
  nextWebuiLeaseGeneration,
} from "../../src/client/mechanisms/stream-lease.js";
import { streamStateBundle } from "../../src/client/application/stream-state-bundle.js";
import { initialWebuiStreamState } from "../../src/client/projection/stream-state.js";
import type { WebuiStreamState } from "../../src/client/contracts/stream-state.js";

/** What the loop sink's `claimSubscription` does, without a React store. */
function claimFromLoop(state: WebuiStreamState): {
  state: WebuiStreamState;
  generation: number;
} {
  const generation = streamStateBundle.nextSubscriptionGeneration();
  return {
    generation,
    state: {
      ...state,
      lastClaimedGeneration: generation,
      subscription: { owner: "local-send", generation },
    },
  };
}

describe("stream lease — one generation counter", () => {
  it("hands out strictly increasing numbers across both claim paths", () => {
    const first = claimFromLoop(initialWebuiStreamState);
    const second = claimWebuiLease(first.state, "recovered");
    const third = claimFromLoop(second.state);

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(third.generation).toBeGreaterThan(second.generation);
    // The bundle draws from the same counter the lease does, so no number is
    // ever handed out twice.
    expect(new Set([first.generation, second.generation, third.generation]).size).toBe(3);
  });

  it("does not let a lease claim share a number with a loop claim", () => {
    // With two counters this is exactly the collision: the loop takes 1 from its
    // own counter, the lease takes 1 from the other one.
    const loop = claimFromLoop(initialWebuiStreamState);
    const lease = claimWebuiLease(initialWebuiStreamState, "recovered");
    expect(lease.generation).not.toBe(loop.generation);
  });

  it("marks a loop claim superseded once the lease claims", () => {
    const loop = claimFromLoop(initialWebuiStreamState);
    expect(isWebuiLeaseGenerationCurrent(loop.state, loop.generation)).toBe(true);

    const lease = claimWebuiLease(loop.state, "recovered");
    expect(isWebuiLeaseGenerationCurrent(lease.state, loop.generation)).toBe(false);
    expect(isWebuiLeaseGenerationCurrent(lease.state, lease.generation)).toBe(true);
  });

  it("marks a lease claim superseded once the loop claims", () => {
    const lease = claimWebuiLease(initialWebuiStreamState, "recovered");
    const loop = claimFromLoop(lease.state);

    expect(isWebuiLeaseGenerationCurrent(loop.state, lease.generation)).toBe(false);
    expect(isWebuiLeaseGenerationCurrent(loop.state, loop.generation)).toBe(true);
  });

  it("keeps the fence honest against the raw counter too", () => {
    const generation = nextWebuiLeaseGeneration();
    const state: WebuiStreamState = {
      ...initialWebuiStreamState,
      lastClaimedGeneration: generation,
      subscription: { owner: "local-send", generation },
    };
    expect(isWebuiLeaseGenerationCurrent(state, generation)).toBe(true);
    expect(isWebuiLeaseGenerationCurrent(state, generation - 1)).toBe(false);
  });
});
