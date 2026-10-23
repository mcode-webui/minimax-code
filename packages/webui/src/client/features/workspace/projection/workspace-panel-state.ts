import type { WebuiTurnDiffView } from "../../../../shared/contracts/session.js";
import type { WebuiBrowserTargetId } from "../../../../shared/contracts/browser.js";
import { basenamePath } from "../../../projection/common/paths.js";

// ---------------------------------------------------------------------------
// The tab-kind registry. The kinds used to be enumerated in three places — the
// union here, the label map and the launcher's four tiles — so adding a kind
// meant finding all three, and the type system caught only two of them. They are
// declared once, below, and everything else derives: the union from the shapes'
// keys, the tab's label from the table, and the launcher's tiles from the table
// plus their order.
//
// The registry may carry a host render branch, which is why the *icons* and the
// dispatch calls stay in the component: this module has no React and no
// dispatcher. What it owns is the closed set and the words.
// ---------------------------------------------------------------------------

/**
 * What a tab's slot is showing.
 *
 * A tab is a stable slot whose content can be replaced in place: a tab that
 * shows the new tab page and the same tab that later shows a web page are one
 * tab, and the strip does not flicker when the content changes. The kinds are
 * the content's own discriminants.
 *
 * `review` has two variants because one tab serves both the workspace's change
 * set and a turn's; the discriminant is `source`, not `kind`.
 */
export type WebuiWorkspaceTabContent =
  | {
      readonly kind: "files" | "canvas" | "terminal";
      readonly sessionId?: string;
      readonly workspaceDir?: string;
    }
  | {
      readonly kind: "file-preview";
      readonly sessionId: string;
      readonly workspaceDir: string;
      readonly path: string;
      readonly lineStart?: number;
      readonly lineEnd?: number;
      readonly content?: string;
    }
  | {
      readonly kind: "review";
      readonly source: "workspace";
      readonly sessionId: string;
      readonly workspaceDir: string;
      readonly selectedPath?: string;
      readonly reviewSnapshotId?: string;
    }
  | {
      readonly kind: "review";
      readonly source: "turn";
      readonly sessionId: string;
      readonly workspaceDir: string;
      readonly messageId: string;
      readonly assistantMessageId?: string;
      readonly turnId?: string;
      readonly changeSetId?: string;
      readonly files: WebuiTurnDiffView["fileChanges"];
      readonly selectedPath?: string;
    }
  | {
      readonly kind: "web";
      /**
       * The target the web tab is bound to.
       *
       * The binding is the runtime's target identity, not the tab's own
       * identity: a page that navigates keeps its target id and gains a
       * generation, and the tab that holds it is still the same tab.
       */
      readonly target: WebuiBrowserTargetId;
      /** The page's title, as the runtime publishes it. */
      readonly title: string;
      /** The page's url, as the runtime publishes it. */
      readonly url: string;
      /** The page's declared favicon, when the runtime provides one. */
      readonly faviconUrl?: string;
    }
  | {
      /**
       * The new tab page.
       *
       * Opened by the strip's "new tab" affordance: a launcher with four tiles
       * and a URL box, and choosing either replaces this content. It is a
       * content like any other, which is the whole reason the tab is an id and
       * a content — the tab that shows the launcher and the tab that later
       * shows the page are one tab.
       */
      readonly kind: "launcher";
      /**
       * The page this launcher has asked the runtime to open, once it has asked.
       *
       * `undefined` is the new tab page as the person sees it. The request is
       * part of the content rather than of the component because the port's
       * answer and the runtime's own snapshot can arrive in either order, and
       * both have to reach the tab that asked: this is what names it, and it is
       * what tells a launcher it is waiting rather than idle.
       */
      readonly request?: {
        readonly url: string;
        /**
         * The refusal, when the runtime refused rather than answered. The
         * launcher keeps its url box and says why, because a page that cannot
         * be opened is not a closed page.
         */
        readonly error?: string;
      };
    };

/** The content's kinds — the closed set, derived from the content itself. */
export type WebuiWorkspaceTabKind = WebuiWorkspaceTabContent["kind"];

/**
 * A tab: a stable id and the content it is showing.
 *
 * The id belongs to the client. It is assigned when the tab is opened and it
 * does not change when the content does, so it says nothing about what the
 * tab is showing — and two web tabs in one session are two tabs.
 */
export interface WorkspacePanelTab {
  readonly id: string;
  readonly content: WebuiWorkspaceTabContent;
}

/**
 * The content, when it is the workspace's change set.
 *
 * The two review variants are one `kind` with a `source` discriminant, and a
 * caller that wants the workspace's one has to say so. The narrowing lives
 * here rather than at each call site, so the rule is written once.
 */
export function webuiWorkspaceReviewContent(
  content: WebuiWorkspaceTabContent | undefined,
): Extract<WebuiWorkspaceTabContent, { readonly kind: "review"; readonly source: "workspace" }> | undefined {
  if (!content || content.kind !== "review" || content.source !== "workspace") return undefined;
  return content;
}

/**
 * A key that names what a tab is showing, not which slot it is.
 *
 * The caches are keyed by this rather than by the tab's id. The id is stable
 * and the content is not, so a cache keyed by the id would hand the previous
 * content's result to the new one — a tab that changed from one file to
 * another would keep showing the first file.
 */
export function webuiWorkspaceTabContentKey(content: WebuiWorkspaceTabContent): string {
  switch (content.kind) {
    case "file-preview":
      return `file:${content.sessionId}:${content.workspaceDir}:${content.path}`;
    case "review":
      return `review:${content.source}:${content.sessionId}:${content.workspaceDir}:${
        content.source === "turn" ? content.messageId : ""
      }`;
    case "web":
      return `web:${content.target.browserId}:${content.target.targetId}`;
    case "launcher":
      return "launcher";
    default:
      return `${content.kind}:${content.sessionId ?? ""}:${content.workspaceDir ?? ""}`;
  }
}

// Both unions describe the shape of a panel command, so they live with it in the
// workspace's contract (see `features/workspace/contracts/panel-command.ts`); they
// are re-exported here for the panel code that already read them from this module.
export type { WebuiWorkspaceTileOpen, WebuiWorkspaceOpenTabKind };


export interface WebuiWorkspaceTabKindEntry {
  /** The tab's label, and the launcher's tile label when it has one. */
  readonly label: string;
  /**
   * The launcher tile, or `null` for a kind opened only by an instance — a file
   * preview is opened by a path from the tree, and a web tab is opened by
   * typing a url or by the Agent.
   */
  readonly tile: WebuiWorkspaceTileOpen | null;
}

export const WEBUI_WORKSPACE_TAB_KINDS: Readonly<
  Record<WebuiWorkspaceTabKind, WebuiWorkspaceTabKindEntry>
> = {
  files: { label: "查看文件", tile: { type: "open-tab", kind: "files" } },
  "file-preview": { label: "文件", tile: null },
  review: { label: "变更", tile: { type: "open-workspace-review" } },
  canvas: { label: "画布", tile: { type: "open-tab", kind: "canvas" } },
  terminal: { label: "终端", tile: { type: "open-tab", kind: "terminal" } },
  /**
   * A web tab.
   *
   * It has no tile of its own: a web tab is opened by typing a url in the new
   * tab page, or by the Agent, and the browser tool tab it used to stand for is
   * gone.
   */
  web: { label: "网页", tile: null },
  /**
   * The new tab page.
   *
   * It has no tile of its own: it is the page the tiles are on, opened by the
   * strip's "new tab" affordance.
   */
  launcher: { label: "新建标签页", tile: null },
};

/**
 * The launcher's tiles, in the order they are laid out. It is not the table's:
 * 变更 leads and 查看文件 trails the kinds that open a process.
 */
export const WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER: readonly WebuiWorkspaceTabKind[] = [
  "review",
  "terminal",
  "canvas",
  "files",
];

export interface WebuiWorkspaceLauncherTile {
  readonly kind: WebuiWorkspaceTabKind;
  readonly label: string;
  readonly opens: WebuiWorkspaceTileOpen;
}

/** The launcher's tiles, derived from the table — entries and order both live there. */
export function webuiWorkspaceLauncherTiles(): readonly WebuiWorkspaceLauncherTile[] {
  return WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER.flatMap((kind) => {
    const entry = WEBUI_WORKSPACE_TAB_KINDS[kind];
    return entry.tile ? [{ kind, label: entry.label, opens: entry.tile }] : [];
  });
}

/**
 * A tab's label, by one rule instead of two copies: a file preview shows its
 * file, a turn's review says "Review" (it is not the workspace's change set), and
 * every other kind shows the registry's word.
 */
export function webuiWorkspaceTabLabel(tab: WorkspacePanelTab): string {
  const content = tab.content;
  if (content.kind === "file-preview") return basenamePath(content.path);
  if (content.kind === "review" && content.source === "turn") return "Review";
  // A web tab is titled by the page, and the title is the runtime's to
  // report. A tab whose page has no title yet falls back to the registry's word.
  if (content.kind === "web") return content.title || WEBUI_WORKSPACE_TAB_KINDS.web.label;
  return WEBUI_WORKSPACE_TAB_KINDS[content.kind].label;
}

export interface WorkspacePanelState {
  readonly open: boolean;
  readonly expanded: boolean;
  readonly tabs: readonly WorkspacePanelTab[];
  readonly activeTabId?: string;
  /**
   * The next tab number.
   *
   * The tab's id is assigned by the client when the tab is opened and it does
   * not change when the content does, so it cannot be derived from the
   * content. The counter is what makes the assignment unique — and it is why
   * two web tabs in one session are two tabs rather than one.
   */
  readonly nextTabNumber: number;
}

export interface WorkspacePanelSessionState {
  readonly workspacePanel: WorkspacePanelState;
  readonly progressPanelOpen: boolean;
}

/**
 * The coordinator-produced signal that a workspace's git state changed. It is
 * what replaces the panels' own `watchEvents` subscription: the application
 * event coordinator receives `workspace.git.changed` on the single channel and
 * hands the payload here, and the panels react to the signal rather than to a
 * raw process event. `revision` bumps on every signal so an effect keyed on it
 * re-runs even when two events name the same workspace.
 */
export interface WebuiWorkspaceGitChangedSignal {
  readonly revision: number;
  readonly workspace?: string;
  readonly aliases?: readonly string[];
}

export type WorkspacePanelSessionStates = ReadonlyMap<string, WorkspacePanelSessionState>;

export function getWorkspacePanelSessionState(
  states: WorkspacePanelSessionStates,
  sessionId: string,
): WorkspacePanelSessionState {
  return states.get(sessionId) ?? initialWorkspacePanelSessionState;
}

export function reduceWorkspacePanelSessionState(
  states: WorkspacePanelSessionStates,
  sessionId: string,
  command: WorkspacePanelCommand,
): WorkspacePanelSessionStates {
  const current = getWorkspacePanelSessionState(states, sessionId);
  const workspacePanel = reduceWorkspacePanelState(current.workspacePanel, command);
  const progressPanelOpen = workspacePanel.open ? false : current.progressPanelOpen;
  if (states.has(sessionId) && workspacePanel === current.workspacePanel && progressPanelOpen === current.progressPanelOpen) return states;
  const next: WorkspacePanelSessionState = {
    workspacePanel,
    // The two right-side panels occupy the same surface. Keep this invariant
    // in the state transition so session changes and batched React updates
    // cannot briefly render both panels together.
    progressPanelOpen,
  };
  const updated = new Map(states);
  updated.set(sessionId, next);
  return updated;
}

export function setWorkspaceSessionProgressPanelOpen(
  states: WorkspacePanelSessionStates,
  sessionId: string,
  open: boolean,
): WorkspacePanelSessionStates {
  const current = getWorkspacePanelSessionState(states, sessionId);
  const progressPanelOpen = open && !current.workspacePanel.open;
  if (current.progressPanelOpen === progressPanelOpen && states.has(sessionId)) return states;
  const updated = new Map(states);
  updated.set(sessionId, { ...current, progressPanelOpen });
  return updated;
}

import type {
  WebuiWorkspaceTileOpen,
  WebuiWorkspaceOpenTabKind,
  WorkspacePanelCommand,
} from "../contracts/panel-command.js";

export type { WorkspacePanelCommand };


export const initialWorkspacePanelState: WorkspacePanelState = {
  open: false,
  expanded: false,
  tabs: [],
  nextTabNumber: 1,
};

export const initialWorkspacePanelSessionState: WorkspacePanelSessionState = {
  workspacePanel: initialWorkspacePanelState,
  progressPanelOpen: true,
};

/**
 * Opens a tab with a fresh id and makes it the active one.
 *
 * The id is assigned here, by the client, because the tab's id belongs to the
 * client: it is assigned when the tab is opened and it does not change when
 * the content does. Nothing derives it from the content, so two web tabs in
 * one session are two tabs.
 */
function openNewTab(
  state: WorkspacePanelState,
  content: WebuiWorkspaceTabContent,
): WorkspacePanelState {
  const id = `tab-${state.nextTabNumber}`;
  return activate(
    { ...state, nextTabNumber: state.nextTabNumber + 1 },
    { id, content },
  );
}

/**
 * Whether the content is the same instance view.
 *
 * The files view, the canvas and the terminal are one tab per session and
 * directory. Their ids used to say so, and the id no longer says anything —
 * so the rule is written here instead.
 */
function isSameInstance(
  content: WebuiWorkspaceTabContent,
  kind: "files" | "canvas" | "terminal",
  sessionId?: string,
  workspaceDir?: string,
): boolean {
  return (
    content.kind === kind &&
    content.sessionId === sessionId &&
    content.workspaceDir === workspaceDir
  );
}

/**
 * The tab that is already showing this content, when there is one.
 *
 * The rules that used to fall out of the id — the same file opens one tab,
 * the workspace's change set and a turn's review are one tab — are content
 * checks now, because the id says nothing about what the tab is showing.
 */
function tabShowing(
  state: WorkspacePanelState,
  matches: (content: WebuiWorkspaceTabContent) => boolean,
): WorkspacePanelTab | undefined {
  return state.tabs.find((tab) => matches(tab.content));
}

function activate(state: WorkspacePanelState, tab: WorkspacePanelTab): WorkspacePanelState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  return {
    ...state,
    open: true,
    tabs: existing ? state.tabs.map((candidate) => candidate.id === tab.id ? tab : candidate) : [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

/**
 * Puts new content in one tab, keeping the tab.
 *
 * This is what the new tab page does when a tile or a url is chosen: the slot
 * the person opened is the slot that shows what they asked for, so the tab is
 * neither closed nor replaced and its id — which every cache in the panel is
 * keyed by — does not move.
 *
 * The tab is **not** activated: a person who asked for a page and then looked
 * at another tab keeps looking at that other tab, and the page waits for them
 * in the tab they typed it in.
 */
function replaceTabContent(
  state: WorkspacePanelState,
  tabId: string,
  content: WebuiWorkspaceTabContent,
): WorkspacePanelState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return state;
  return updateWorkspacePanelTab(state, tabId, () => ({ ...tab, content }));
}

export function reduceWorkspacePanelState(state: WorkspacePanelState, command: WorkspacePanelCommand): WorkspacePanelState {
  switch (command.type) {
    case "open-file": {
      const path = command.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
      if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) return state;
      const content: WebuiWorkspaceTabContent = {
        kind: "file-preview",
        sessionId: command.sessionId,
        workspaceDir: command.workspaceDir,
        path,
        ...(command.lineStart !== undefined ? { lineStart: command.lineStart } : {}),
        ...(command.lineEnd !== undefined ? { lineEnd: command.lineEnd } : {}),
      };
      // The same file opens one tab. The rule is a content check now, not an
      // id derivation: the id belongs to the client and says nothing about
      // what the tab is showing.
      const existing = tabShowing(
        state,
        (candidate) =>
          candidate.kind === "file-preview" &&
          candidate.path === path &&
          candidate.sessionId === command.sessionId &&
          candidate.workspaceDir === command.workspaceDir,
      );
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-plan-file": {
      const path = command.path.replace(/\\/gu, "/").replace(/^\.\//u, "");
      const content: WebuiWorkspaceTabContent = {
        kind: "file-preview",
        sessionId: command.sessionId,
        workspaceDir: command.workspaceDir,
        path,
        content: command.content,
      };
      const existing = tabShowing(
        state,
        (candidate) =>
          candidate.kind === "file-preview" &&
          candidate.path === path &&
          candidate.sessionId === command.sessionId &&
          candidate.workspaceDir === command.workspaceDir,
      );
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-workspace-review": {
      const content: WebuiWorkspaceTabContent = {
        kind: "review",
        source: "workspace",
        sessionId: command.sessionId,
        workspaceDir: command.workspaceDir,
        ...(command.selectedPath ? { selectedPath: command.selectedPath } : {}),
      };
      // The launcher's changes tile opens the change set in the tab the tile is
      // on, and the singleton lookup is for every other caller.
      if (command.tabId) return replaceTabContent(state, command.tabId, content);
      // The workspace's change set and a turn's review are two tabs. They used
      // to derive the same id, so opening one replaced the other.
      const existing = tabShowing(
        state,
        (candidate) => candidate.kind === "review" && candidate.source === "workspace",
      );
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-turn-review": {
      const content: WebuiWorkspaceTabContent = {
        kind: "review",
        source: "turn",
        sessionId: command.sessionId,
        workspaceDir: command.workspaceDir,
        messageId: command.messageId,
        assistantMessageId: command.assistantMessageId,
        turnId: command.turnId,
        changeSetId: command.changeSetId,
        files: command.files ?? [],
        ...(command.selectedPath ? { selectedPath: command.selectedPath } : {}),
      };
      const existing = tabShowing(
        state,
        (candidate) => candidate.kind === "review" && candidate.source === "turn",
      );
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-web-tab": {
      const content: WebuiWorkspaceTabContent = {
        kind: "web",
        target: command.target,
        title: command.title,
        url: command.url,
        ...(command.faviconUrl ? { faviconUrl: command.faviconUrl } : {}),
      };
      // A web tab is bound to its target, and a tab already bound to that
      // target is the same tab: the runtime publishes a snapshot, and applying
      // a snapshot twice changes nothing.
      const existing = tabShowing(
        state,
        (candidate) =>
          candidate.kind === "web" &&
          candidate.target.browserId === command.target.browserId &&
          candidate.target.targetId === command.target.targetId,
      );
      if (existing) {
        // The page behind the tab moved: the content updates under a tab that
        // is already open, and the person keeps looking at whatever they were
        // looking at. A snapshot that changes nothing changes nothing here
        // either, so the panel is not re-rendered for no reason.
        const current = existing.content;
        if (
          current.kind === "web" &&
          current.title === content.title &&
          current.url === content.url &&
          current.faviconUrl === content.faviconUrl &&
          current.target.generation === content.target.generation
        ) {
          return state;
        }
        return {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.id === existing.id ? { ...existing, content } : tab,
          ),
        };
      }
      // The launcher asked for this page: the person typed its url in that tab,
      // so that tab becomes the web page rather than a second tab appearing
      // beside it. The answer names the tab, and the snapshot below names it
      // through the request — either order, the same tab.
      if (command.tabId) return replaceTabContent(state, command.tabId, content);
      // A page nothing is bound to yet, and a launcher waiting for one: the new
      // tab page is a tab whose content is a placeholder for whatever comes
      // next, so a page the panel has not bound takes it over. This is what
      // keeps the runtime's snapshot and the port's answer from opening two
      // tabs for one page when the snapshot lands first.
      const waiting = tabShowing(
        state,
        (candidate) => candidate.kind === "launcher" && candidate.request !== undefined,
      );
      if (waiting) return replaceTabContent(state, waiting.id, content);
      // Nothing is waiting for it: the Agent opened the page, so it opens a tab
      // of its own and becomes the active one.
      return openNewTab(state, content);
    }
    case "request-web-page": {
      // The request is recorded before the runtime is asked, so a snapshot that
      // lands while the call is in flight finds the tab that asked. A refusal
      // keeps the request and adds the reason: the launcher still has a url box,
      // and the person can say something else.
      const tab = state.tabs.find((candidate) => candidate.id === command.tabId);
      if (tab?.content.kind !== "launcher") return state;
      const content: WebuiWorkspaceTabContent = {
        kind: "launcher",
        request: {
          url: command.url,
          ...(command.error ? { error: command.error } : {}),
        },
      };
      return replaceTabContent(state, command.tabId, content);
    }
    case "open-primary-view": {
      const content: WebuiWorkspaceTabContent = {
        kind: "files",
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.workspaceDir ? { workspaceDir: command.workspaceDir } : {}),
      };
      // The files view is a singleton per session and directory, and that is
      // an explicit rule now: the id no longer implies it, because the id
      // says nothing about what the tab is showing.
      const existing = tabShowing(state, (candidate) => isSameInstance(candidate, "files", command.sessionId, command.workspaceDir));
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-tab": {
      const content: WebuiWorkspaceTabContent = {
        kind: command.kind,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.workspaceDir ? { workspaceDir: command.workspaceDir } : {}),
      };
      // A tile on the new tab page opens its view in the tab the tile is on.
      if (command.tabId) return replaceTabContent(state, command.tabId, content);
      const existing = tabShowing(state, (candidate) => isSameInstance(candidate, command.kind, command.sessionId, command.workspaceDir));
      if (existing) return activate(state, { ...existing, content });
      return openNewTab(state, content);
    }
    case "open-new-tab": {
      // A fresh tab page every time the "+" is pressed. It is a browser's rule,
      // and here it is the launcher's: the page a person typed a url into is a
      // web page now and has no url box left, so pressing "+" again is how they
      // ask for another one — without losing the page they just opened.
      const content: WebuiWorkspaceTabContent = { kind: "launcher" };
      return openNewTab(state, content);
    }
    case "open-panel": {
      // Reopening the panel reveals its existing tabs. Only the first open
      // needs a launcher; creating one on every panel open duplicates tabs.
      if (state.tabs.length > 0) return { ...state, open: true };
      return openNewTab(state, { kind: "launcher" });
    }
    case "select-tab":
      return state.tabs.some((tab) => tab.id === command.tabId) ? { ...state, open: true, activeTabId: command.tabId } : state;
    case "select-review-file":
      return updateWorkspacePanelTab(state, command.tabId, (tab) =>
        tab.content.kind === "review" ? { ...tab, content: { ...tab.content, selectedPath: command.path } } : tab,
      );
    case "set-review-snapshot": {
      const current = state.tabs.find((tab) => tab.id === command.tabId);
      if (
        current?.content.kind !== "review" ||
        current.content.source !== "workspace" ||
        current.content.reviewSnapshotId === command.reviewSnapshotId
      ) {
        return state;
      }
      return updateWorkspacePanelTab(state, command.tabId, (tab) =>
        tab.content.kind === "review"
          ? { ...tab, content: { ...tab.content, reviewSnapshotId: command.reviewSnapshotId } }
          : tab,
      );
    }
    case "close-tab": {
      const index = state.tabs.findIndex((tab) => tab.id === command.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== command.tabId);
      const activeTabId = state.activeTabId === command.tabId ? tabs[Math.min(index, tabs.length - 1)]?.id : state.activeTabId;
      return { ...state, tabs, activeTabId, open: tabs.length > 0 };
    }
    case "close-panel":
      return { ...state, open: false };
    case "toggle-expanded":
      return { ...state, expanded: !state.expanded };
  }
}

export function updateWorkspacePanelTab(state: WorkspacePanelState, tabIdValue: string, update: (tab: WorkspacePanelTab) => WorkspacePanelTab): WorkspacePanelState {
  return { ...state, tabs: state.tabs.map((tab) => tab.id === tabIdValue ? update(tab) : tab) };
}
