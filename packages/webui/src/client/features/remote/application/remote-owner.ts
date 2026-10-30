// The 远程 page's tab owner.
//
// Framework-free — no React, no DOM — so the tab transition is testable against
// a scripted port (`packages/webui/AGENTS.md`: no jsdom in this package).
//
// The owner holds one fact: which of the page's two tabs is showing. It holds no
// phone-link state and no IM state — those belong to the two businesses the tabs
// render, and a second copy of either would be a second authority.
import {
  WEBUI_REMOTE_DEFAULT_TAB,
  WEBUI_REMOTE_TABS,
  type WebuiRemoteTab,
  type WebuiRemoteTabValue,
} from "../contracts/remote-page.js";

export interface WebuiRemoteSnapshot {
  readonly activeTab: WebuiRemoteTabValue;
  /**
   * Whether the SSH surface is showing in place of the tab body.
   *
   * The Desktop's pairing page carries an `SSH` link under its 连接 button, and
   * that link opens the SSH host management. On the WebUI the SSH business
   * lives in this package, so the link opens it here — one owner, and the page
   * keeps its own state instead of reaching into another business.
   */
  readonly showSsh: boolean;
}

export interface WebuiRemoteOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WebuiRemoteSnapshot;
  /** Selects one tab. Selecting the tab that is already showing changes nothing. */
  readonly selectTab: (value: WebuiRemoteTabValue) => void;
  /** Opens the SSH surface in place of the tab body. */
  readonly openSsh: () => void;
  /** Closes the SSH surface and returns to the tab that was showing. */
  readonly closeSsh: () => void;
}

export interface CreateWebuiRemoteOwnerOptions {
  /** The tab to open on; absent means the pairing page. */
  readonly initialTab?: WebuiRemoteTabValue;
}

export function createWebuiRemoteOwner(
  options: CreateWebuiRemoteOwnerOptions = {},
): WebuiRemoteOwner {
  const listeners = new Set<() => void>();
  let snapshot: WebuiRemoteSnapshot = {
    activeTab: options.initialTab ?? WEBUI_REMOTE_DEFAULT_TAB,
    showSsh: false,
  };

  const publish = (next: WebuiRemoteSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    selectTab: (value) => {
      // An unknown value is not a tab: the strip only offers the two, and
      // selecting something that does not exist must not blank the page.
      if (!WEBUI_REMOTE_TABS.some((tab) => tab.value === value)) return;
      if (snapshot.activeTab === value && !snapshot.showSsh) return;
      publish({ activeTab: value, showSsh: false });
    },
    openSsh: () => {
      if (snapshot.showSsh) return;
      publish({ activeTab: snapshot.activeTab, showSsh: true });
    },
    closeSsh: () => {
      if (!snapshot.showSsh) return;
      publish({ activeTab: snapshot.activeTab, showSsh: false });
    },
  };
}

/** The tab's label, for the strip and for the page's own accessible name. */
export function webuiRemoteTabLabel(value: WebuiRemoteTabValue): string {
  const tab: WebuiRemoteTab | undefined = WEBUI_REMOTE_TABS.find(
    (candidate) => candidate.value === value,
  );
  return tab?.label ?? value;
}
