import { randomUUID } from "node:crypto";

/** What the panel is showing: one Mini App of one session. */
export interface MiniAppPresentation {
  readonly sessionId: string;
  readonly pluginId: string;
}

export type MiniAppPresentationIntent =
  | {
      readonly epoch: string;
      readonly revision: number;
      readonly action: "open";
      readonly sessionId: string;
      readonly pluginId: string;
      /**
       * The origin-relative page the Agent asked for, when it asked for one.
       *
       * The Agent's `open` action may name a path inside the Mini App. The
       * presenter does not resolve it — the server owns the URL the page is framed
       * at — but it has to carry it, because the client is what opens the Mini App.
       */
      readonly path?: string;
    }
  | { readonly epoch: string; readonly revision: number; readonly action: "close"; readonly pluginId: string; readonly sessionId: string };

/**
 * The browser implementation of the host-owned Mini App presenter.
 *
 * The desktop client's presenter moves a native view; there is no such view here. ADR 0020 maps the
 * page's `open` onto the session rail plus the standalone presentation: `open` selects that session
 * through the client's ordinary selection path and records that the panel is showing that Mini App,
 * and `close` stops showing it. Selection is what makes a Mini-App-created session's permission asks
 * answerable, so the record has to follow the selection rather than the page's wishes.
 */
export interface MiniAppPresenterLike {
  open(input: {
    readonly sessionId: string;
    readonly pluginId: string;
    /**
     * The origin-relative page the Agent asked for, when it asked for one.
     *
     * The runtime's presenter port carries it, so this presenter accepts it and
     * records it on the intent rather than dropping it.
     */
    readonly path?: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  close(input: { readonly pluginId: string }): Promise<void>;
}

export interface MiniAppPresenterView {
  /** The Mini App the panel is showing, or undefined when it shows none. */
  presented(): MiniAppPresentation | undefined;
  /** Current intent plus notifications, consumed by the WebUI client watcher. */
  snapshot(): MiniAppPresentationIntent | undefined;
  subscribe(listener: (intent: MiniAppPresentationIntent) => void): () => void;
  readonly presenter: MiniAppPresenterLike;
}

export interface CreateMiniAppPresenterInput {
  /**
   * The client's ordinary selection path, where there is one.
   *
   * Optional because selection belongs to the client document: the WebUI's rail
   * is browser state, and this presenter runs on the server, which cannot select
   * anything. What it records is the presentation — which session's panel is
   * showing which Mini App — and the client reads that through the view it
   * mounts. A host that does own a selection path supplies it.
   */
  readonly selectSession?: (input: { readonly sessionId: string; readonly pluginId: string }) => void;
  /** Reports the panel as closed when its Mini App stops being shown. */
  readonly onClosed?: (input: { readonly pluginId: string }) => void;
}

/**
 * One presenter per service. It holds one presentation, because the panel shows one session at a time:
 * a second `open` replaces the first, and `close` only clears the record when it names the Mini App
 * currently presented.
 */
export function createMiniAppPresenter(input: CreateMiniAppPresenterInput): MiniAppPresenterView {
  const epoch = randomUUID();
  let presentation: MiniAppPresentation | undefined;
  let revision = 0;
  let latestIntent: MiniAppPresentationIntent | undefined;
  const listeners = new Set<(intent: MiniAppPresentationIntent) => void>();

  const publish = (intent: MiniAppPresentationIntent): void => {
    for (const listener of listeners) listener(intent);
  };

  return {
    presented: () => presentation,
    snapshot: () => latestIntent,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    presenter: {
      async open(openInput) {
        openInput.signal?.throwIfAborted();
        presentation = { sessionId: openInput.sessionId, pluginId: openInput.pluginId };
        revision += 1;
        const intent: MiniAppPresentationIntent = {
          action: "open",
          epoch,
          revision,
          ...presentation,
          ...(openInput.path !== undefined ? { path: openInput.path } : {}),
        };
        latestIntent = intent;
        publish(intent);
        input.selectSession?.({ sessionId: openInput.sessionId, pluginId: openInput.pluginId });
      },
      async close(closeInput) {
        if (presentation?.pluginId !== closeInput.pluginId) return;
        const { sessionId } = presentation;
        presentation = undefined;
        revision += 1;
        const intent: MiniAppPresentationIntent = {
          action: "close",
          epoch,
          revision,
          pluginId: closeInput.pluginId,
          sessionId,
        };
        latestIntent = intent;
        publish(intent);
        input.onClosed?.({ pluginId: closeInput.pluginId });
      },
    },
  };
}

/**
 * The panel stops showing a Mini App when the person selects another session or closes the panel, and
 * the record has to follow, or the service would keep reporting a presentation that no longer exists.
 */
export function followSelection(input: {
  readonly view: MiniAppPresenterView;
  readonly selectedSessionId: string | undefined;
}): void {
  const presentation = input.view.presented();
  if (!presentation) return;
  if (presentation.sessionId === input.selectedSessionId) return;
  // The presenter's own `onClosed` reports the closure; reporting here too would say it twice.
  void input.view.presenter.close({ pluginId: presentation.pluginId });
}
