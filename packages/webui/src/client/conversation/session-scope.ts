// The session scope manager.
//
// Interest in a session is not the same thing as a component being mounted on
// it. A turn this client started keeps running after the user navigates away, a
// send that was accepted still owes a settlement, and a reconciliation still
// owes a result — so a scope cannot be released merely because the view moved.
// This manager tracks *why* a session is still needed, as separate leases:
//
//   * **selected-view** — held by the selection itself. Selecting another session
//     releases this lease and nothing else.
//   * **secondary** — an explicit second consumer (a workspace tab, a named
//     command). It releases its own lease when it closes.
//   * **delivery** — an accepted send/attach attempt. It ends on terminal
//     completion, supersession or explicit delivery detach, never on navigation.
//   * **settlement** — an accepted mutation or a reconciliation obligation. It
//     ends after the outcome and the invalidation it owes are committed, or after
//     the failure has been recorded.
//
// The manager owns bookkeeping only. What a lease means for IO — whether a dirty
// marker is reconciled now or retained until interest arrives — belongs to the
// owners that hold the leases.

export type WebuiSessionLeaseKind =
  | "selected-view"
  | "secondary"
  | "delivery"
  | "settlement";

/** The holder id the selection itself uses; callers never pass it. */
const SELECTED_VIEW_HOLDER = "::selected-view";

export interface WebuiSessionScopeManager {
  /**
   * Points the selected view at a session. Activates that session's scope and
   * releases the previous selection's lease — and only that lease, so an
   * accepted delivery or an outstanding settlement survives the navigation.
   */
  readonly select: (sessionId: string | undefined) => void;
  readonly selected: () => string | undefined;
  /**
   * Acquires interest in one session for one holder. The same holder and kind
   * acquiring twice is idempotent. Returns the release for that lease; the
   * holder may also release everything it holds with `releaseHolder`.
   */
  readonly acquire: (
    sessionId: string,
    kind: WebuiSessionLeaseKind,
    holderId: string,
  ) => () => void;
  /** Releases every lease one holder holds, across sessions and kinds. */
  readonly releaseHolder: (holderId: string) => void;
  /** Whether anything still needs the session. */
  readonly isInterested: (sessionId: string) => boolean;
  /** The sessions with any interest, in the order they first became interesting. */
  readonly interested: () => readonly string[];
  /** Which kinds keep a session interesting; for diagnostics and tests. */
  readonly kinds: (sessionId: string) => readonly WebuiSessionLeaseKind[];
  /**
   * Whether a session's owner or fence may be recreated. An eligible outstanding
   * completion keeps its session interested, so this is false while any lease
   * remains — the guard against recreating an owner over work that is still owed.
   */
  readonly mayEvict: (sessionId: string) => boolean;
  /** Revokes every lease for one session (session delete / purge). */
  readonly purge: (sessionId: string) => void;
  /** Application disposal: revokes every browser lease. */
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
  readonly retention: () => { readonly sessions: number; readonly leases: number; readonly deletionFences: number };
}

export function createWebuiSessionScopeManager(): WebuiSessionScopeManager {
  /** sessionId → holder key → kind. Insertion order is the interest order. */
  const leases = new Map<string, Map<string, WebuiSessionLeaseKind>>();
  // No replay barrier proves a deleted id safe to reuse during this application.
  const purged = new Set<string>();
  let selected: string | undefined;
  let disposed = false;

  const holderKey = (kind: WebuiSessionLeaseKind, holderId: string): string =>
    `${kind}\u0000${holderId}`;

  const release = (sessionId: string, key: string): void => {
    const held = leases.get(sessionId);
    if (!held) return;
    held.delete(key);
    if (held.size === 0) leases.delete(sessionId);
  };

  return {
    select: (sessionId) => {
      if (disposed) return;
      if (sessionId !== undefined && purged.has(sessionId)) return;
      if (selected === sessionId) return;
      if (selected !== undefined) {
        release(selected, holderKey("selected-view", SELECTED_VIEW_HOLDER));
      }
      selected = sessionId;
      if (sessionId === undefined) return;
      const held = leases.get(sessionId) ?? new Map<string, WebuiSessionLeaseKind>();
      held.set(holderKey("selected-view", SELECTED_VIEW_HOLDER), "selected-view");
      leases.set(sessionId, held);
    },
    selected: () => selected,
    acquire: (sessionId, kind, holderId) => {
      if (!disposed && !purged.has(sessionId)) {
        const key = holderKey(kind, holderId);
        const held = leases.get(sessionId) ?? new Map<string, WebuiSessionLeaseKind>();
        held.set(key, kind);
        leases.set(sessionId, held);
      }
      return () => {
        if (disposed) return;
        release(sessionId, holderKey(kind, holderId));
      };
    },
    releaseHolder: (holderId) => {
      if (disposed) return;
      for (const [sessionId, held] of [...leases]) {
        for (const key of [...held.keys()]) {
          if (key.endsWith(`\u0000${holderId}`)) release(sessionId, key);
        }
      }
    },
    isInterested: (sessionId) => (leases.get(sessionId)?.size ?? 0) > 0,
    interested: () => [...leases.keys()],
    kinds: (sessionId) => [...(leases.get(sessionId)?.values() ?? [])],
    mayEvict: (sessionId) => !(leases.get(sessionId)?.size),
    purge: (sessionId) => {
      if (disposed) return;
      purged.add(sessionId);
      leases.delete(sessionId);
      if (selected === sessionId) selected = undefined;
    },
    dispose: () => {
      disposed = true;
      leases.clear();
      purged.clear();
      selected = undefined;
    },
    isDisposed: () => disposed,
    retention: () => ({ sessions: leases.size,
      leases: [...leases.values()].reduce((count, held) => count + held.size, 0),
      deletionFences: purged.size }),
  };
}
