// The workspace panel's tab strip, and the new tab page it opens.
//
// The strip is the workspace's one row of tabs: tool tabs (files, review,
// canvas, terminal) and web tabs interleaved in the order they were opened.
// It owns three things:
//   - the per-tab close button,
//   - the single active tab,
//   - the "+" affordance that opens a fresh tab showing the new tab page.
//
// The new tab page itself is a launcher — four tiles and a URL box — and it is
// a tab's content rather than a menu over the strip: choosing a tile or typing
// a url replaces that tab's content, and the tab keeps its id.
//
// The web tabs it shows come from the runtime's `watchBrowserWebTabs`
// snapshot, never a parallel copy the client keeps. The strip subscribes
// once, under the session's run id, and turns each published web tab into an
// `open-web-tab` panel command, so the workspace's own reducer is what holds
// the list — the reconciliation lives there, and a snapshot that lands
// twice changes nothing.
//
// `.public` because the Browser business's host renders the strip's
// active web tab: a foreign business's component renders the workspace's
// tabs, and reaching across the boundary from the other side is what the
// dependency rules allow.

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type ReactElement,
} from "react";

import {
  type WebuiBrowserTargetId,
  type WebuiBrowserWebTab,
  type WebuiBrowserWebTabSnapshot,
} from "../../../../shared/contracts/browser.js";
import { useWebuiPortSlice } from "../../../bindings/port-slices-context.js";
import {
  webuiWorkspaceLauncherTiles,
  webuiWorkspaceTabLabel,
  type WebuiWorkspaceLauncherTile,
  type WorkspacePanelCommand,
  type WorkspacePanelState,
  type WorkspacePanelTab,
} from "../projection/workspace-panel-state.js";
import {
  WebuiIconClose,
  WebuiIconDiffFile,
  WebuiIconFile,
  WebuiIconGlobe,
  WebuiIconSearch,
  WebuiIconSend,
  WebuiIconWorkspaceCanvas,
  WebuiIconWorkspaceReview,
  WebuiIconWorkspaceTerminal,
} from "../../../shell/icons.js";

const STRIP_COPY = {
  addTab: "新建标签页",
  fileClose: "关闭",
  tabsLabel: "工作区面板标签",
  launcherUrlLabel: "输入网址，打开为网页标签页",
  launcherUrlPlaceholder: "输入网址",
  launcherUrlSubmit: "打开网页",
  launcherPending: "正在打开…",
  launcherUnavailable: "当前运行时没有浏览器能力，无法打开网页。",
} as const;

/**
 * The strip's view of the panel.
 *
 * The strip is a presentation component over the workspace's reducer output:
 * the reducer holds the canonical list of tabs, and the strip diffs that
 * list against what the runtime just published through
 * `watchBrowserWebTabs`, dispatching an `open-web-tab` for each published
 * tab that has no panel tab yet.
 *
 * The strip does not keep its own list of web tabs. Two copies of "what is
 * open" disagree exactly when a tab is closed (issue #207), so the strip
 * owns the closing gesture only — knowing the tab is gone is the reducer's
 * job, and the strip's dispatch is what tells it.
 */
export interface WebuiWorkspaceTabStripProps {
  /** The panel's state, projected by the workspace's reducer. */
  readonly state: WorkspacePanelState;
  /** The dispatch the strip fires commands at. */
  readonly dispatch: (command: WorkspacePanelCommand) => void;
  /**
   * The session the strip belongs to, when there is one.
   *
   * It names the run whose web tabs the strip subscribes to. The pages of a
   * session are recorded under that run — whether the Agent opened them or the
   * person did — so one subscription shows both, and neither needs a second copy
   * of "what is open".
   */
  readonly sessionId?: string;
}

/**
 * The commands a published snapshot implies for the workspace.
 *
 * Exported for the test that exercises the reconciliation rule without a
 * DOM: a snapshot's tabs become `open-web-tab` commands for any target the
 * panel does not already have a tab for.
 */
export function webuiWorkspaceTabStripReconcile(
  tabs: readonly WorkspacePanelTab[],
  snapshot: WebuiBrowserWebTabSnapshot,
): readonly { readonly command: WorkspacePanelCommand; readonly target: WebuiBrowserWebTab["target"] }[] {
  const known = new Map(
    tabs
      .filter(
        (tab): tab is WorkspacePanelTab & { readonly content: Extract<WorkspacePanelTab["content"], { readonly kind: "web" }> } =>
          tab.content.kind === "web",
      )
      .map((tab) => [
        `${tab.content.target.browserId}/${tab.content.target.targetId}`,
        tab.content,
      ]),
  );
  return snapshot.tabs
    .filter((published) => {
      const current = known.get(`${published.target.browserId}/${published.target.targetId}`);
      // A web tab the panel does not have yet is new, and a web tab whose
      // title, url, favicon or generation moved is the same tab showing another page.
      // A snapshot that changes nothing produces no work.
      if (!current) return true;
      return (
        current.title !== published.title ||
        current.url !== published.url ||
        current.faviconUrl !== published.faviconUrl ||
        current.target.generation !== published.target.generation
      );
    })
    .map((published) => ({
      command: {
        type: "open-web-tab",
        target: published.target,
        title: published.title,
        url: published.url,
        ...(published.faviconUrl ? { faviconUrl: published.faviconUrl } : {}),
      },
      target: published.target,
    }));
}

/**
 * The glyph a tool tab carries.
 *
 * The registry carries the kinds, their words and how each opens; the glyphs
 * are the strip's, because a glyph is a rendering of the content rather than
 * a fact about it.
 */
function workspaceTabGlyph(item: WorkspacePanelTab): ReactElement {
  if (item.content.kind === "review") {
    return <WebuiIconWorkspaceReview className="webui-workspace-tab-file-icon" />;
  }
  if (item.content.kind === "terminal") {
    return <WebuiIconWorkspaceTerminal className="webui-workspace-tab-file-icon" />;
  }
  if (item.content.kind === "canvas") {
    return <WebuiIconWorkspaceCanvas className="webui-workspace-tab-file-icon" />;
  }
  if (item.content.kind === "files") {
    return <WebuiIconFile className="webui-workspace-tab-file-icon" />;
  }
  if (item.content.kind !== "file-preview") {
    return <WebuiIconFile className="webui-workspace-tab-file-icon" />;
  }
  const extension = item.content.path.split(/[./\\]/u).at(-1)?.toLowerCase();
  if (extension === "md" || extension === "mdx") {
    return <span className="webui-workspace-filetype-badge is-markdown" aria-hidden="true">M↓</span>;
  }
  if (["js", "jsx", "mjs", "cjs"].includes(extension ?? "")) {
    return <span className="webui-workspace-filetype-badge is-javascript" aria-hidden="true">JS</span>;
  }
  if (["ts", "tsx", "mts", "cts"].includes(extension ?? "")) {
    return <span className="webui-workspace-filetype-badge is-typescript" aria-hidden="true">TS</span>;
  }
  if (extension === "json") {
    return <span className="webui-workspace-filetype-badge is-json" aria-hidden="true">{ }</span>;
  }
  return <WebuiIconDiffFile fileName={item.content.path} className="webui-workspace-tab-file-icon" />;
}

function workspaceTabStripGlyph(item: WorkspacePanelTab): ReactElement {
  if (item.content.kind === "launcher") {
    return <span className="webui-workspace-tab-glyph webui-workspace-web-glyph" aria-hidden="true"><WebuiIconGlobe className="size-[18px]" /></span>;
  }
  if (item.content.kind === "web" && item.content.faviconUrl) {
    const pageUrl = item.content.url;
    return <span className="webui-workspace-tab-glyph webui-workspace-web-glyph" aria-hidden="true">
      <img src={item.content.faviconUrl} alt="" onError={(event) => {
        const image = event.currentTarget;
        if (image.dataset.fallback !== "true") {
          image.dataset.fallback = "true";
          try {
            const fallback = new URL("/favicon.ico", pageUrl);
            if ((fallback.protocol === "https:" || fallback.protocol === "http:") && fallback.href !== image.src) {
              image.src = fallback.href;
              return;
            }
          } catch {
            // A malformed page URL has no site-level fallback icon.
          }
        }
        image.hidden = true;
        image.nextElementSibling?.removeAttribute("hidden");
      }} />
      <span hidden><WebuiIconGlobe className="size-[18px]" /></span>
    </span>;
  }
  return item.content.kind === "web"
    ? <span className="webui-workspace-tab-glyph webui-workspace-web-glyph" aria-hidden="true"><WebuiIconGlobe className="size-[18px]" /></span>
    : workspaceTabGlyph(item);
}

/**
 * The strip component.
 *
 * Mounted by `WorkspacePanels` above the body of the active tab. Each
 * published web tab in the runtime's snapshot is brought into the
 * workspace's reducer through an `open-web-tab` dispatch, the same shape
 * the Agent uses to open a tab (issue #206), so a snapshot that lands
 * twice turns into no work and a tab that closes is what the reducer
 * records in its place.
 */
export function WebuiWorkspaceTabStrip({
  state,
  dispatch,
  sessionId,
}: WebuiWorkspaceTabStripProps): ReactElement {
  // The strip does not touch its own state. What it does is reconcile the
  // snapshot against the workspace's tabs: for each published web tab, dispatch
  // an `open-web-tab` if the panel does not already have one. The reducer's
  // existing-tab rule (issue #206) keeps duplicates out.
  const slice = useWebuiPortSlice("browser");
  const watchBrowserWebTabs = slice?.watchBrowserWebTabs;
  const closeBrowserWebTab = slice?.closeBrowserWebTab;

  /**
   * Closes a tab.
   *
   * A web tab's page is closed in the browser **first**, and the tab leaves
   * the strip after: the runtime stops publishing the tab when its page is
   * closed, and a tab that left the strip while the runtime still published
   * it would be re-added by the next snapshot. A tool tab holds no page, so
   * closing it is the client's business alone.
   */
  const closeTab = async (item: WorkspacePanelTab): Promise<void> => {
    if (item.content.kind === "web") {
      await closeBrowserWebTab?.({ target: item.content.target });
    }
    dispatch({ type: "close-tab", tabId: item.id });
  };

  // A ref-stable handle on the latest published web tabs. The effect that
  // subscribes to `watchBrowserWebTabs` is recreated only when the slice's
  // identity changes — the strip keeps an up-to-date view of the tabs in
  // a ref, so a snapshot that lands between renders is reconciled against
  // the tabs the reducer holds now.
  const latestTabsRef = useRef<WorkspacePanelState["tabs"]>(state.tabs);
  latestTabsRef.current = state.tabs;

  // The strip owns the row, so it is the strip that brings a focused,
  // off-screen tab into view. The row scrolls, the panel does not.
  const tabListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeTabId]);

  // The strip subscribes once. When the slice's `watchBrowserWebTabs` changes
  // identity we close the previous subscription and open a new one for the
  // slice the strip is now wired to.
  const watchKey = watchBrowserWebTabs ?? null;
  const runScope = useMemo(() => (sessionId ? { runId: sessionId } : {}), [sessionId]);
  useEffect(() => {
    if (!watchBrowserWebTabs) return;
    const stop = watchBrowserWebTabs(
      // The session's web tabs, under the session's run id: the run's selection
      // and the session's pages are recorded in the same cell, so a page opened
      // by the Agent and a page opened by the person arrive on one subscription.
      // With no session in view it is the panel's own cell, which is what the
      // person has when there is no run behind the workspace.
      { surface: "isolated-chromium", ...runScope },
      (snapshot: WebuiBrowserWebTabSnapshot) => {
        // The strip owns the closing gesture only; the reducer owns the
        // canonical list. Each published web tab that has no panel tab is
        // brought in through an `open-web-tab` dispatch — the same shape the
        // Agent uses to open a tab (issue #206). A snapshot that lands
        // twice turns into no work, because the target is the reducer's
        // identity for a web tab.
        for (const { command } of webuiWorkspaceTabStripReconcile(latestTabsRef.current, snapshot)) {
          dispatch(command);
        }
      },
    );
    return () => {
      stop();
    };
  }, [watchKey, dispatch, runScope]);

  return (
    <div className="webui-workspace-tab-list" data-testid="workspace-tab-strip" ref={tabListRef}>
      {state.tabs.map((item) => (
        <div
          key={item.id}
          className={`webui-workspace-tab ${state.activeTabId === item.id ? "is-active" : ""}`}
          role="presentation"
          data-testid={`workspace-tab-strip-item-${item.id}`}
          data-tab-kind={item.content.kind}
        >
          <button
            type="button"
            role="tab"
            aria-selected={state.activeTabId === item.id}
            data-testid={`workspace-tab-${item.id}`}
            onClick={() => dispatch({ type: "select-tab", tabId: item.id })}
          >
            {workspaceTabStripGlyph(item)}
            <span className="webui-workspace-tab-label">{webuiWorkspaceTabLabel(item)}</span>
          </button>
          <button
            type="button"
            aria-label={`${webuiWorkspaceTabLabel(item)} ${STRIP_COPY.fileClose}`}
            data-testid={`workspace-tab-${item.id}-close`}
            onClick={() => void closeTab(item)}
          >
            <WebuiIconClose className="size-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="webui-workspace-new-tab-trigger"
        aria-label={STRIP_COPY.addTab}
        data-testid="workspace-add-tab"
        onClick={() => dispatch({ type: "open-new-tab" })}
      >
        +
      </button>
    </div>
  );
}

export interface WebuiWorkspaceLauncherProps {
  /** The tab showing the new tab page. Its id survives whatever it opens. */
  readonly tab: WorkspacePanelTab;
  readonly dispatch: (command: WorkspacePanelCommand) => void;
  readonly sessionId?: string;
  readonly workspaceDir?: string;
}

/**
 * The new tab page.
 *
 * Four tiles and a URL box, and it is a tab's content rather than a menu over
 * the strip: choosing a tile opens that view in this tab, and typing a url
 * makes this tab the web page. The tab is not closed and not replaced, which is
 * why a tab is an id and a content in the first place.
 *
 * The URL box calls the browser business's port. That is the point of it: a
 * page typed by hand and a page opened by the Agent go through the same
 * `open_tab`, the same surface switch and the same refusals. The launcher does
 * not keep a browser of its own.
 */
export function WebuiWorkspaceLauncher({
  tab,
  dispatch,
  sessionId,
  workspaceDir,
}: WebuiWorkspaceLauncherProps): ReactElement | null {
  const request = tab.content.kind === "launcher" ? tab.content.request : undefined;
  const slice = useWebuiPortSlice("browser");
  const openBrowserWebTab = slice?.openBrowserWebTab;
  const [typed, setTyped] = useState("");
  if (tab.content.kind !== "launcher") return null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const url = webuiWorkspaceLauncherUrl(typed);
    if (!url || !openBrowserWebTab) return;
    setTyped("");
    void webuiWorkspaceLauncherOpenPage({
      tabId: tab.id,
      url,
      dispatch,
      open: openBrowserWebTab,
      // The run is named so the runtime can decide the bootstrap: the page joins
      // the run's selection only when the run has none at that moment. The
      // launcher does not decide it — it cannot see the run's selection, and
      // deciding it here would make the person a standing writer of the Agent's
      // cell.
      ...(sessionId ? { runId: sessionId } : {}),
    });
  };

  const tiles = webuiWorkspaceLauncherTiles()
    .map((tile) => ({
      tile,
      command: webuiWorkspaceLauncherTileCommand(tile, tab.id, { sessionId, workspaceDir }),
    }))
    .filter((entry) => entry.command !== undefined);

  return (
    <div className="webui-workspace-launcher" data-testid="workspace-launcher">
      {/*
        The address box comes first and sits in the middle of the page, the way
        a browser's new tab page is built: the one thing a person came here to
        do is the first thing in front of them, and the shortcuts follow it.
      */}
      <div className="webui-workspace-launcher-brand" data-testid="workspace-launcher-brand" role="img" aria-label="MiniMax">
        <span className="webui-workspace-launcher-wordmark" aria-hidden="true">
          <span className="webui-workspace-launcher-wordmark-mini">
            <span className="is-blue">M</span><span className="is-red is-lower">i</span><span className="is-yellow is-lower">n</span><span className="is-blue is-lower">i</span>
          </span><span className="webui-workspace-launcher-wordmark-max">
            <span className="is-green">M</span><span className="is-red is-lower">a</span><span className="is-blue is-lower is-final">x</span>
          </span>
        </span>
      </div>
      <form className="webui-workspace-launcher-omnibox" onSubmit={submit}>
        <WebuiIconSearch className="webui-workspace-launcher-omnibox-glyph size-5 shrink-0" />
        <input
          className="webui-workspace-launcher-omnibox-input"
          type="text"
          value={typed}
          aria-label={STRIP_COPY.launcherUrlLabel}
          placeholder={STRIP_COPY.launcherUrlPlaceholder}
          data-testid="workspace-launcher-url"
          onChange={(event) => setTyped(event.target.value)}
        />
        <button
          type="submit"
          className="webui-workspace-launcher-omnibox-submit"
          data-testid="workspace-launcher-url-submit"
          aria-label={request && !request.error ? STRIP_COPY.launcherPending : STRIP_COPY.launcherUrlSubmit}
          disabled={!openBrowserWebTab}
        >
          {request && !request.error ? (
            STRIP_COPY.launcherPending
          ) : (
            <WebuiIconSend className="size-4" />
          )}
        </button>
      </form>
      <div className="webui-workspace-launcher-tiles">
        {tiles.map(({ tile, command }) => (
          <button
            key={tile.kind}
            type="button"
            className="webui-workspace-launcher-tile"
            data-testid={`workspace-launcher-tile-${tile.kind}`}
            onClick={() => command && dispatch(command)}
          >
            <span className="webui-workspace-launcher-tile-icon" aria-hidden="true">
              {launcherTileGlyph(tile.kind)}
            </span>
            <span className="webui-workspace-launcher-tile-label">{tile.label}</span>
          </button>
        ))}
      </div>
      {openBrowserWebTab ? null : (
        <p className="webui-workspace-launcher-unavailable">{STRIP_COPY.launcherUnavailable}</p>
      )}
      {request?.error ? (
        <p className="webui-workspace-launcher-error" data-testid="workspace-launcher-error">
          {request.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The URL box, as one transition: ask the runtime, then bind the page or say
 * why there is none.
 *
 * The request is dispatched before the call rather than after it, because the
 * runtime publishes the page on its own snapshot as well: the request is what
 * tells the reducer which tab that page belongs to, and a snapshot that lands
 * while the call is in flight must not open a second tab beside it.
 *
 * `open` is the browser business's port call, so a page typed by hand and a page
 * opened by the Agent go through the same `open_tab` and the same refusal. The
 * refusal is the runtime's own message, kept rather than replaced: a person who
 * typed a url into a browser that is switched off is told the switch is off.
 *
 * `runId` is passed through rather than acted on. Naming the run is what lets the
 * runtime apply the one bootstrap — the page joins the run's selection when the
 * run has none — while a run that is already working on a page keeps it. What the
 * person typed is a tab, and the tab is the client's cell either way.
 *
 * Exported for the test that drives the transition without a DOM — the
 * component's only job here is the form around it.
 */
export async function webuiWorkspaceLauncherOpenPage(input: {
  readonly tabId: string;
  readonly url: string;
  readonly dispatch: (command: WorkspacePanelCommand) => void;
  readonly open: (request: {
    readonly url: string;
    readonly runId?: string;
  }) => Promise<{ readonly target: WebuiBrowserTargetId }>;
  readonly runId?: string;
}): Promise<void> {
  const { tabId, url, dispatch, open, runId } = input;
  dispatch({ type: "request-web-page", tabId, url });
  try {
    const { target } = await open({ url, ...(runId ? { runId } : {}) });
    // The title and the URL are the runtime's to report, and they arrive on the
    // snapshot; what the answer carries is the identity this tab is bound to.
    dispatch({ type: "open-web-tab", target, title: "", url, tabId });
  } catch (reason) {
    dispatch({
      type: "request-web-page",
      tabId,
      url,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

/**
 * The url the browser is told to open.
 *
 * A person types a host as often as a scheme, and a bare host is not something
 * the browser can open — so the scheme is added here rather than answered with
 * an error page. Anything that already carries one is passed as typed.
 */
export function webuiWorkspaceLauncherUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:(?:\/\/|$)/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The command a tile opens, or `undefined` when it cannot open one.
 *
 * The registry row says what the tile opens; the tab says where: the launcher
 * the tile is on. The changes tile keeps the requirements it had as a menu
 * entry, which are the session and the working directory the change set
 * belongs to — a tile that cannot open its view is not rendered rather than
 * rendered dead.
 */
export function webuiWorkspaceLauncherTileCommand(
  tile: WebuiWorkspaceLauncherTile,
  tabId: string,
  scope: { readonly sessionId?: string; readonly workspaceDir?: string },
): WorkspacePanelCommand | undefined {
  if (tile.opens.type === "open-workspace-review") {
    const { sessionId: session, workspaceDir: dir } = scope;
    return session && dir ? { ...tile.opens, sessionId: session, workspaceDir: dir, tabId } : undefined;
  }
  const { sessionId: session, workspaceDir: dir } = scope;
  return {
    ...tile.opens,
    ...(session ? { sessionId: session } : {}),
    ...(dir ? { workspaceDir: dir } : {}),
    tabId,
  };
}

/** The glyph a tile carries. The same icons the strip's own file tabs use. */
function launcherTileGlyph(kind: WebuiWorkspaceLauncherTile["kind"]): ReactElement {
  switch (kind) {
    case "review":
      return <WebuiIconWorkspaceReview className="size-6 shrink-0" />;
    case "terminal":
      return <WebuiIconWorkspaceTerminal className="size-6 shrink-0" />;
    case "canvas":
      return <WebuiIconWorkspaceCanvas className="size-6 shrink-0" />;
    default:
      return <WebuiIconFile className="size-6 shrink-0" />;
  }
}
