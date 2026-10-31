// The standalone presentation lease: the record of which Mini App is on screen
// in a browser tab of its own.
//
// ADR 0020, "The standalone presentation is a lease": the two presentations are
// two client documents that share nothing but the service, so the service is
// what knows which one is live. A standalone document declares its plugin, its
// session and its presentation when it connects, and the record is released when
// that document's socket closes.
//
// The lifetime is the point. This module holds no timers and no ownership of a
// connection: it is told to acquire, and told to release by whoever owns the
// socket. `server/operation/handlers/miniapp.ts` is that caller — the lease is
// acquired by the `watchMiniAppPresentation` stream and released when the stream
// ends, which is when the client's socket closed.
//
// Two properties are decisions rather than consequences:
//
//   * `presentationRevision` is monotonic per plugin and survives a release. It
//     is what makes a fast detach-then-release visible to a poll that would
//     otherwise see `detached: false` on both reads (the same property the field
//     has in the shipped desktop contract).
//   * A second acquisition for a plugin replaces the first, and the older
//     lease's release does not clear the newer. Two documents can overlap for a
//     moment — a tab reload, a switch that races a close — and the record must
//     follow the newest one rather than whichever socket happened to close last.

/** One live standalone presentation. */
export interface MiniAppPresentationLease {
  readonly pluginId: string;
  readonly sessionId: string;
  /**
   * How many times a standalone presentation of this plugin has been acquired,
   * counting this one. Never `0` on a lease: the first acquisition is `1`.
   */
  readonly presentationRevision: number;
}

export interface MiniAppPresentationLeases {
  /** Declare this document's presentation. Replaces a live one for the plugin. */
  acquire(input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }): MiniAppPresentationLease;
  /**
   * Release one lease, if it is still the live one.
   *
   * Identity, not plugin id: a lease that was already replaced has nothing to
   * release, and clearing the plugin's record because a stale document closed
   * would make the inline view report the wrong presentation.
   */
  release(lease: MiniAppPresentationLease): void;
  /** Whether a standalone presentation of this plugin is live. */
  detached(pluginId: string): boolean;
  /** The plugin's revision, live or not. `0` means never acquired. */
  revision(pluginId: string): number;
  /** The live presentations, for shutdown or a test. */
  live(): readonly MiniAppPresentationLease[];
}

export function createMiniAppPresentationLeases(): MiniAppPresentationLeases {
  const live = new Map<string, MiniAppPresentationLease>();
  const revisions = new Map<string, number>();

  return {
    acquire({ pluginId, sessionId }): MiniAppPresentationLease {
      const presentationRevision = (revisions.get(pluginId) ?? 0) + 1;
      revisions.set(pluginId, presentationRevision);
      const lease: MiniAppPresentationLease = {
        pluginId,
        sessionId,
        presentationRevision,
      };
      live.set(pluginId, lease);
      return lease;
    },
    release(lease) {
      if (live.get(lease.pluginId) !== lease) return;
      live.delete(lease.pluginId);
    },
    detached(pluginId) {
      return live.has(pluginId);
    },
    revision(pluginId) {
      return revisions.get(pluginId) ?? 0;
    },
    live() {
      return [...live.values()];
    },
  };
}
