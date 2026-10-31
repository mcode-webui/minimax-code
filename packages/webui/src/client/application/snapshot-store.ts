// The owner's snapshot.
//
// What an application owner publishes: one immutable state object, a listener
// set, and one way to replace it. That is all.
//
// This replaces `query-store.ts`, which was this object plus a per-key version
// guard that dropped a superseded answer instead of applying it over a newer one.
// The guard is gone because `conversation/request-freshness.ts` does that job
// properly now — with a commit token that also fences the owner incarnation, and
// with an outcome the caller can branch on — and both owners read through it. Two
// implementations of one rule is how the two drifted in the first place.
//
// So what remains here is deliberately not a cached-read store. It knows nothing
// about reads, requests or freshness: it holds state and tells listeners when it
// changed. An owner that wants a read cached, fenced and reported goes to the
// keyed resource; this is only where its answer is *published*, so a surface can
// render it.
//
// Framework-free: no React, no DOM, no storage.

export interface WebuiSnapshotStore<State extends object> {
  readonly getSnapshot: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Replace the snapshot.
   *
   * A no-op update — one that returns the current object — notifies nobody.
   * Owners publish from a resource's subscriber, which fires for every commit,
   * so an unchanged answer must not cost a render.
   */
  readonly set: (update: (current: State) => State) => void;
}

export function createWebuiSnapshotStore<State extends object>(
  initial: State,
): WebuiSnapshotStore<State> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (update) => {
      const next = update(state);
      if (next === state) return;
      state = next;
      // Iterated over a copy: a listener that unsubscribes — or subscribes —
      // while it is being notified must not change what this pass visits.
      for (const listener of [...listeners]) listener();
    },
  };
}
