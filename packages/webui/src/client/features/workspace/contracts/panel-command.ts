// The workspace panel's published command type. It is declared here, next to the
// rest of the workspace's contracts, because more than one business dispatches
// it: the transcript opens a turn review from a message footer, and the shell
// owns the panel. A consumer reads the type from the owner's contract rather than
// from the projection that happens to reduce it.

import type { WebuiTurnDiffView } from "../../../../shared/contracts/session.js";
import type { WebuiBrowserTargetId } from "../../../../shared/contracts/browser.js";

export type WorkspacePanelCommand =
  | { readonly type: "open-file"; readonly sessionId: string; readonly workspaceDir: string; readonly path: string; readonly lineStart?: number; readonly lineEnd?: number }
  /**
   * Open the session's plan file. It sits in the session's artifacts
   * directory rather than the workspace, so the content rides along instead of
   * being read through `readWorkspaceFile`, which refuses to leave the
   * workspace root.
   */
  | { readonly type: "open-plan-file"; readonly sessionId: string; readonly workspaceDir: string; readonly path: string; readonly content: string }
  /**
   * Opens the workspace's change set.
   *
   * `tabId` names the tab this opens into. The new tab page's changes tile
   * carries it, because a launcher is a tab's content like any other: choosing
   * the tile replaces that tab's content rather than activating a change set
   * somebody opened earlier. Absent means the singleton lookup.
   */
  | { readonly type: "open-workspace-review"; readonly sessionId: string; readonly workspaceDir: string; readonly selectedPath?: string; readonly tabId?: string }
  | { readonly type: "open-turn-review"; readonly sessionId: string; readonly workspaceDir: string; readonly messageId: string; readonly assistantMessageId?: string; readonly turnId?: string; readonly changeSetId?: string; readonly files: WebuiTurnDiffView["fileChanges"]; readonly selectedPath?: string }
  | { readonly type: "open-primary-view"; readonly kind: "files"; readonly sessionId?: string; readonly workspaceDir?: string }
  /**
   * Opens a web tab, or updates the one already bound to that target.
   *
   * The command carries the target the tab is bound to. The tab's own id is
   * the client's and is assigned when the tab is opened, so the same target
   * always finds the same tab.
   *
   * `tabId` names the tab the page belongs in, for the launcher: the person
   * typed the url in that tab, so that tab becomes the page. It is optional
   * because the runtime's snapshot names no tab — a snapshot has to reconcile
   * against whatever tab is already bound, and opens a tab of its own for a
   * page nothing is showing yet.
   */
  | { readonly type: "open-web-tab"; readonly target: WebuiBrowserTargetId; readonly title: string; readonly url: string; readonly faviconUrl?: string; readonly tabId?: string }
  /**
   * Opens one of the tool views, as the new tab page's tiles do.
   *
   * `tabId` names the tab this opens into, for the same reason as the changes
   * tile's. Absent means the singleton lookup — one tab per session and
   * directory — which is what every other caller wants.
   */
  | { readonly type: "open-tab"; readonly kind: WebuiWorkspaceOpenTabKind; readonly sessionId?: string; readonly workspaceDir?: string; readonly tabId?: string }
  /**
   * The new tab page's URL box has asked the runtime for a page.
   *
   * Dispatched before the browser's port is called, and again with the
   * runtime's refusal when there is one. The request rides on the tab's own
   * content because the port's answer and the runtime's snapshot can arrive in
   * either order, and both have to reach the tab that asked: the request is
   * what names it, and a launcher that is waiting for a page is the tab a
   * published page belongs to.
   */
  | { readonly type: "request-web-page"; readonly tabId: string; readonly url: string; readonly error?: string }
  /**
   * Open the new tab page.
   *
   * Dispatched by the strip's "+" affordance, which opens a fresh tab every
   * time: a person who wants a second url presses it again and gets a second
   * new tab page, because the one they used is a web page now and has no url
   * box left.
   */
  | { readonly type: "open-new-tab" }
  /** Open the panel, creating its first launcher only when it has no tabs. */
  | { readonly type: "open-panel" }
  | { readonly type: "select-tab"; readonly tabId: string }
  | { readonly type: "select-review-file"; readonly tabId: string; readonly path: string }
  | { readonly type: "set-review-snapshot"; readonly tabId: string; readonly reviewSnapshotId: string }
  | { readonly type: "close-tab"; readonly tabId: string }
  | { readonly type: "close-panel" }
  | { readonly type: "toggle-expanded" };

/**
 * The kinds an `open-tab` command may name: exactly those whose launcher tile
 * is an `open-tab`. Derived, so a kind that gains or loses a tile moves this
 * union with it.
 */
export type WebuiWorkspaceOpenTabKind = Extract<
  WebuiWorkspaceTileOpen,
  { readonly type: "open-tab" }
>["kind"];

/**
 * How a launcher tile opens its view. Data, so the component only dispatches it.
 *
 * These were the add menu's entries. The menu went when the launcher's tiles
 * took its place, and the rows that described them stayed: one row per kind,
 * each carrying the command its tile opens.
 */
export type WebuiWorkspaceTileOpen =
  | { readonly type: "open-workspace-review" }
  | { readonly type: "open-tab"; readonly kind: "files" | "canvas" | "terminal" };
