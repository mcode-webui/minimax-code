// Binds the single stream-lease implementation to the session store, so the
// coordinators speak in session ids while the fencing rules stay in one pure
// module (`stream-lease.ts`).
//
// This is the entry point plan §7.6 calls "turn coordinator claims and releases
// through one entry": every claim, release and fence in the application goes
// through here, and every one of them reads and writes the same store.

import type { WebuiStreamState } from "../stream.js";
import type { WebuiSessionStore } from "./session-store.js";
import {
  claimWebuiLease,
  fenceWebuiLeaseStream,
  isWebuiLeaseGenerationCurrent,
  isWebuiLeaseHeldBy,
  releaseWebuiLease,
} from "./stream-lease.js";
import type {
  WebuiLeaseOwner,
  WebuiLeaseReleaseScope,
} from "./stream-lease.js";

export interface WebuiStreamLeaseController {
  /** Claim the session's stream; returns the generation the claimant owns. */
  claim: (
    sessionId: string,
    owner: WebuiLeaseOwner,
    turnId?: string,
  ) => number;
  /** Release the lease, optionally scoped to a generation or turn. */
  release: (sessionId: string, scope?: WebuiLeaseReleaseScope) => void;
  /** Whether `generation` is still the newest claimant for the session. */
  isCurrent: (sessionId: string, generation: number | undefined) => boolean;
  /** Whether `generation` currently holds the lease (not merely newest). */
  heldBy: (sessionId: string, generation: number | undefined) => boolean;
  /** Apply a stream write only when `generation` is current. */
  fence: (
    sessionId: string,
    generation: number | undefined,
    apply: (current: WebuiStreamState) => WebuiStreamState,
  ) => WebuiStreamState;
}

export function createWebuiStreamLeaseController(
  store: WebuiSessionStore,
): WebuiStreamLeaseController {
  return {
    claim: (sessionId, owner, turnId) => {
      const result = claimWebuiLease(
        store.readSession(sessionId).stream,
        owner,
        turnId,
      );
      store.updateSession(sessionId, (current) => ({
        ...current,
        stream: result.state,
      }));
      return result.generation;
    },
    release: (sessionId, scope) => {
      store.updateSession(sessionId, (current) => ({
        ...current,
        stream: releaseWebuiLease(current.stream, scope),
      }));
    },
    isCurrent: (sessionId, generation) =>
      isWebuiLeaseGenerationCurrent(
        store.readSession(sessionId).stream,
        generation,
      ),
    heldBy: (sessionId, generation) =>
      isWebuiLeaseHeldBy(store.readSession(sessionId).stream, generation),
    fence: (sessionId, generation, apply) =>
      fenceWebuiLeaseStream(
        store.readSession(sessionId).stream,
        generation,
        apply,
      ),
  };
}
