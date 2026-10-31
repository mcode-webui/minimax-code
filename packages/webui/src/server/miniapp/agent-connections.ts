// Which Mini App page this service is currently serving, and under which runtime
// generation.
//
// The page bridge needs two facts that no page may supply and no request carries
// on its own: the plugin a call runs as, and the generation the runtime keys
// authorization on. Both are properties of a live presentation, so they are
// recorded here when a Mini App is started for this client and dropped when it
// stops.
//
// `runId` is the launch's own `runId`, which is the Mini App process generation —
// the same value the runtime registered its agent arena under. Minting a fresh
// per-page value would produce a caller the runtime has never authorised, and
// every call would refuse with an availability failure that reads like a bridge
// bug rather than a policy decision.
//
// `connection` is this service's own counter, not the runtime's: it increments on
// each start so a response, an event or a cancellation produced for the document
// that was framed before a restart cannot be delivered into its replacement. A
// caller naming a generation this registry does not hold is a stale page, and a
// stale page gets no authority.

import type { WebuiMiniAppAgentCaller } from "../../runtime/port.js";

/** One live presentation this service is serving. */
export interface MiniAppAgentConnection {
  readonly pluginId: string;
  /** The runtime process generation the launch reported. */
  readonly runId: string;
  /** This service's presentation-and-connection generation, 1-based per plugin. */
  readonly connection: number;
}

export interface MiniAppAgentConnections {
  /** Records a started Mini App and answers its generation. Replaces the previous one. */
  readonly register: (input: {
    readonly pluginId: string;
    readonly runId: string;
  }) => MiniAppAgentConnection;
  /**
   * The caller a request runs as, or nothing when this service is not serving that
   * plugin at that generation.
   *
   * `hostSessionId` is the session whose view framed the page. It is required: a
   * page call with no host session could still run a turn, but it could never show
   * one, and the runtime treats a page caller without a host session as
   * `not_permitted` rather than guessing which chat is looking.
   */
  readonly callerFor: (input: {
    readonly pluginId: string;
    readonly hostSessionId: string;
    readonly connection: number;
  }) => WebuiMiniAppAgentCaller | undefined;
  /** Drops a stopped plugin: its next start is a new generation. */
  readonly revoke: (pluginId: string) => void;
  /** The live presentations, for shutdown or a test. */
  readonly live: () => readonly MiniAppAgentConnection[];
}

export function createMiniAppAgentConnections(): MiniAppAgentConnections {
  const live = new Map<string, MiniAppAgentConnection>();
  const generations = new Map<string, number>();

  return {
    register({ pluginId, runId }) {
      const connection = (generations.get(pluginId) ?? 0) + 1;
      generations.set(pluginId, connection);
      const record: MiniAppAgentConnection = { pluginId, runId, connection };
      live.set(pluginId, record);
      return record;
    },
    callerFor({ pluginId, hostSessionId, connection }) {
      const record = live.get(pluginId);
      // Generation before identity: a caller from a replaced document is refused
      // even though its plugin id is still the one being served.
      if (!record || record.connection !== connection) return undefined;
      return {
        pluginId: record.pluginId,
        runId: record.runId,
        hostSessionId,
      };
    },
    revoke(pluginId) {
      // The generation counter is deliberately kept: a later start must not reuse
      // a number an older document could still be holding.
      live.delete(pluginId);
    },
    live: () => [...live.values()],
  };
}
