// The subset of the Chrome extension API this extension uses.
//
// The extension has no build step and no node_modules, so `@types/chrome` is
// not available to it. Declaring only the members actually called keeps the
// ambient surface honest: anything the extension starts using has to be added
// here deliberately, which is also what a store review sees.

interface WebuiBrowserExtensionTab {
  readonly id?: number;
  readonly windowId?: number;
  readonly active?: boolean;
  readonly title?: string;
  readonly url?: string;
  readonly favIconUrl?: string;
  readonly status?: string;
}

interface WebuiBrowserExtensionStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface WebuiBrowserExtensionEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

interface WebuiBrowserExtensionTabs {
  query(queryInfo: Record<string, unknown>): Promise<WebuiBrowserExtensionTab[]>;
  get(tabId: number): Promise<WebuiBrowserExtensionTab>;
  captureVisibleTab(
    windowId?: number,
    options?: { format?: "png" | "jpeg"; quality?: number },
  ): Promise<string>;
  readonly onUpdated: WebuiBrowserExtensionEvent<
    (tabId: number, changeInfo: Record<string, unknown>, tab: WebuiBrowserExtensionTab) => void
  >;
  readonly onRemoved: WebuiBrowserExtensionEvent<(tabId: number) => void>;
}

interface WebuiBrowserExtensionWebNavigation {
  readonly onCommitted: WebuiBrowserExtensionEvent<
    (details: { tabId: number; frameId: number }) => void
  >;
}

interface WebuiBrowserExtensionDebuggerTarget {
  tabId?: number;
}

interface WebuiBrowserExtensionDebuggerProtocolMessage {
  method: string;
  params?: Record<string, unknown>;
}

interface WebuiBrowserExtensionDebugger {
  attach(target: WebuiBrowserExtensionDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: WebuiBrowserExtensionDebuggerTarget): Promise<void>;
  sendCommand(
    target: WebuiBrowserExtensionDebuggerTarget,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown>;
}

declare const chrome: {
  readonly runtime: {
    readonly id: string;
    readonly onStartup: WebuiBrowserExtensionEvent<() => void>;
    readonly onInstalled: WebuiBrowserExtensionEvent<
      (details: { reason: string; previousVersion?: string }) => void
    >;
    /**
     * The options page asking the worker to reconnect.
     *
     * A Manifest V3 service worker is lazy, so the page has to wake it
     * explicitly once the person has pasted the installation key.
     */
    readonly onMessage: WebuiBrowserExtensionEvent<
      (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined
    >;
    sendMessage(message: unknown): Promise<unknown>;
    getManifest(): { version: string };
  };
  readonly storage: {
    readonly local: WebuiBrowserExtensionStorageArea;
    readonly session: WebuiBrowserExtensionStorageArea;
  };
  readonly tabs: WebuiBrowserExtensionTabs;
  readonly webNavigation: WebuiBrowserExtensionWebNavigation;
  readonly debugger: WebuiBrowserExtensionDebugger;
};
