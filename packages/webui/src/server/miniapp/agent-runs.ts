// The Mini App agent turns this service is following, and the one thing the page
// can do about them that the transport cannot express.
//
// A page's promise cannot be dropped: a turn that stops being read is still a
// turn. Cancellation is therefore an explicit call naming the request, and this
// registry is what makes that call reach the controller the turn is running under.
//
// Two rules come straight from the desktop client's broker, because a page written
// against it must see the same outcomes here:
//
//   * **Cancelling is not the same as detaching.** A client that goes away aborts
//     its own turn silently; a page that asks for a cancellation is waiting for an
//     answer and gets one.
//   * **An unconfirmed abort is `result_unknown`, never a clean cancellation.** The
//     runtime may have started the turn before the abort arrived, and reporting
//     "cancelled" would invite a retry of work that already ran.
//
// One request id is one turn per plugin. A second `run` naming a live id is
// `busy`: two turns sharing an id would also share its events and its settlement.

export interface MiniAppAgentRun {
  readonly pluginId: string;
  readonly requestId: string;
  readonly controller: AbortController;
}

export interface MiniAppAgentRunHandle extends MiniAppAgentRun {
  /**
   * Marks the turn as settled: its id is free again and no later cancellation can
   * reach the controller it used.
   */
  readonly end: () => void;
  /**
   * Registers what a page's cancellation of this turn does, once.
   *
   * The turn's owner supplies it because only that layer knows whether a terminal
   * frame can still be delivered: the abort itself is the registry's, the report is
   * the caller's.
   */
  readonly onCancelled: (callback: () => void) => void;
}

export interface MiniAppAgentRuns {
  /**
   * Claims one turn id, or `undefined` when the id is already in flight for that
   * plugin.
   */
  readonly begin: (input: {
    readonly pluginId: string;
    readonly requestId: string;
  }) => MiniAppAgentRunHandle | undefined;
  /**
   * Aborts the turn one id names on one plugin. Answers whether there was one.
   *
   * Idempotent: a second cancellation of a settled turn is a no-op rather than an
   * error, because the page cannot tell a lost answer from a lost call.
   */
  readonly cancel: (input: { readonly pluginId: string; readonly requestId: string }) => boolean;
  /** The live turns of one plugin, for teardown. */
  readonly cancelPlugin: (pluginId: string) => void;
  /** How many turns are in flight; shutdown and tests. */
  readonly size: () => number;
}

function keyOf(pluginId: string, requestId: string): string {
  return `${pluginId}\u0000${requestId}`;
}

/** One claimed id: the handle its caller holds, and what cancelling it does. */
interface LiveRun {
  readonly handle: MiniAppAgentRunHandle;
  cancelTurn: () => void;
}

export function createMiniAppAgentRuns(): MiniAppAgentRuns {
  const live = new Map<string, LiveRun>();

  return {
    begin({ pluginId, requestId }) {
      const key = keyOf(pluginId, requestId);
      if (live.has(key)) return undefined;
      const controller = new AbortController();
      let cancelled: (() => void) | undefined;
      let entry: LiveRun;
      const handle: MiniAppAgentRunHandle = {
        pluginId,
        requestId,
        controller,
        end() {
          if (live.get(key) !== entry) return;
          live.delete(key);
          cancelled = undefined;
        },
        onCancelled(callback) {
          cancelled = callback;
        },
      };
      // `cancel` reaches the owner's report through this entry, so a page's
      // cancellation runs the report rather than a bare abort that nobody observes.
      entry = {
        handle,
        cancelTurn() {
          controller.abort();
          cancelled?.();
        },
      };
      live.set(key, entry);
      return handle;
    },
    cancel({ pluginId, requestId }) {
      const entry = live.get(keyOf(pluginId, requestId));
      if (!entry) return false;
      entry.cancelTurn();
      return true;
    },
    cancelPlugin(pluginId) {
      for (const entry of [...live.values()]) {
        if (entry.handle.pluginId !== pluginId) continue;
        entry.cancelTurn();
      }
    },
    size: () => live.size,
  };
}
