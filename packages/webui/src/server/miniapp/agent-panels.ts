// The Mini App sessions this service has told the runtime are on screen.
//
// The runtime's approval router reads one fact to decide whether a Mini App
// session's permission ask can be answered: is some host surface showing it
// (`panelOpened`) or not (`panelClosed`). The client reports both, but the client
// is a document that can vanish — a stop, a crash, a closed tab — and a record that
// exists only in that document keeps a session answerable when nothing shows it.
//
// So the service keeps its own copy, and a stop closes every entry it holds for the
// plugin *before* the generation that authorises the call is revoked. That ordering
// is the whole point: `callerFor` refuses a stale generation, so a close report
// sent after the revoke could never be delivered.
//
// Idempotent in both directions, because the client may report the same panel
// twice: a re-announced selection must not create a second entry, and a second
// close of a panel that is already gone is a no-op rather than an error.

/** One Mini App session a host surface is showing. */
export interface MiniAppAgentPanel {
  readonly pluginId: string;
  readonly sessionId: string;
  readonly hostSessionId: string;
}

export interface MiniAppAgentPanels {
  /** Records one shown panel. Re-announcing the same one changes nothing. */
  readonly opened: (panel: MiniAppAgentPanel) => void;
  /** Forgets one shown panel, if it is recorded. */
  readonly closed: (panel: MiniAppAgentPanel) => void;
  /** The panels recorded for one plugin, for shutdown or a test. */
  readonly forPlugin: (pluginId: string) => readonly MiniAppAgentPanel[];
  /**
   * Every panel of one plugin, removed from the record.
   *
   * Used by a stop: the caller closes each one with the runtime, and the entries
   * are gone even if some of those calls fail — a panel that could not be closed
   * is still not a panel this service may claim to show.
   */
  readonly take: (pluginId: string) => readonly MiniAppAgentPanel[];
}

function keyOf(panel: MiniAppAgentPanel): string {
  return `${panel.pluginId}\u0000${panel.hostSessionId}\u0000${panel.sessionId}`;
}

export function createMiniAppAgentPanels(): MiniAppAgentPanels {
  const shown = new Map<string, MiniAppAgentPanel>();

  return {
    opened(panel) {
      shown.set(keyOf(panel), panel);
    },
    closed(panel) {
      shown.delete(keyOf(panel));
    },
    forPlugin(pluginId) {
      return [...shown.values()].filter((panel) => panel.pluginId === pluginId);
    },
    take(pluginId) {
      const taken: MiniAppAgentPanel[] = [];
      for (const [key, panel] of shown) {
        if (panel.pluginId !== pluginId) continue;
        shown.delete(key);
        taken.push(panel);
      }
      return taken;
    },
  };
}
