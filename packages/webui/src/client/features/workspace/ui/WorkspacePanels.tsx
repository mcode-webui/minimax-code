import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiInline } from "../../../ui/layout-primitives.js";
import { WebuiSearchField, WebuiTextInput } from "../../../ui/field.js";
import { WebuiDisclosure, WebuiMotion, WebuiPage } from "../../../ui/page.js";
import { IconAdjustmentsHorizontal, IconEdit, IconLayoutColumns, IconListCheck } from "@tabler/icons-react";
import { basenamePath } from "../../../projection/common/paths.js";
import { webuiPanelWidthBounds, webuiSurfaceTier, type WebuiSurfaceTier } from "../../../ui/layout-thresholds.js";
// The browser panel is another business's published surface. The workspace
// may mount it and hand it a surface; it may not construct the browser
// state itself, which is why the host component exists.
//
// The strip itself lives in `WebuiWorkspaceTabStrip.public.tsx` — this file
// is over the size that "everything about the panel" fits in, and the strip
// is the part that crosses into the browser business through its published
// port. The strip subscribes to `watchBrowserWebTabs` and, for the active
// web tab, this file mounts `BrowserPanelHost` with the tab's target.
//
// The panel is now layout and tab composition only. A file's diff is
// `WorkspaceDiffFileSection.tsx`, a file's content is `WorkspaceFilePreview.tsx`,
// the grammar table and line highlighting are `projection/file-highlight.ts`,
// and the terminal — roster, xterm, resize reporting — is the
// `bindings/use-workspace-terminal.ts` binding.
import { BrowserPanelHost, WebuiBrowserToolbar } from "../../browser/ui/BrowserPanelHost.public.js";
import { MiniAppPicker } from "../../miniapp/ui/MiniAppPicker.public.js";
import type {
  WebuiWorkspaceFile,
} from "../../../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../../../shared/contracts/review.js";
import type {
  WebuiWorkspaceTabContent,
  WorkspacePanelCommand,
  WorkspacePanelState,
  WorkspacePanelTab,
} from "../projection/workspace-panel-state.js";
import {
  webuiWorkspaceReviewContent,
  webuiWorkspaceTabContentKey,
} from "../projection/workspace-panel-state.js";
import { focusWebuiFileLine, webuiFileLineTargetId } from "../../../bindings/browser-effects.js";
import type { WebuiTerminalOwner } from "../../terminal/contracts/terminal-owner.js";
import { WebuiIconChevronRight, WebuiIconClose, WebuiIconFolder, WebuiIconSearch, WebuiIconSidebarToggle, WebuiIconWorkspaceExpand } from "../../../shell/icons.js";
import { FileTree, filterWorkspaceFiles, findWorkspaceFile, getWorkspaceFileParentPaths, mergeWorkspaceFileChildren } from "./WorkspaceFileTree.js";
import { DesignSurface } from "../../design/ui/DesignSurface.public.js";
import { WebuiWorkspaceLauncher, WebuiWorkspaceTabStrip, webuiWorkspaceLauncherOpenPage, webuiWorkspaceLauncherUrl } from "./WebuiWorkspaceTabStrip.public.js";
import { WebuiDiffFileSection } from "./WorkspaceDiffFileSection.js";
import { WebuiFilePreview } from "./WorkspaceFilePreview.js";
import {
  WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE,
  chunkWebuiWorkspaceReviewFileIds,
} from "../../review/contracts/workspace-review.js";
import {
  useWebuiWorkspacePanelSurface,
  useWebuiWorkspaceQueries,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import { useWebuiPortSlice } from "../../../bindings/port-slices-context.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useWorkspaceTerminal } from "../bindings/use-workspace-terminal.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { FeedbackEmpty } from "../../../ui/feedback.js";
import {
  projectWebuiDiffFile,
  projectWebuiDiffFiles,
} from "../../../projection/common/diff-workspace-boundary.js";
// `mergeWorkspaceFileChildren`, `chunkWebuiWorkspaceReviewFileIds` and
// `WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE` are re-exported below: the panel
// tests import them from this module, which stays the panel's public surface.
// The implementations moved to `features/workspace/projection/workspace-file-tree.ts`
// and the review owner (`features/review/application/workspace-review-owner.ts`).
export {
  mergeWorkspaceFileChildren,
  chunkWebuiWorkspaceReviewFileIds,
  WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE,
};
const WEBUI_TERMINAL_COPY = { terminalExited: "已退出", terminalLoading: "正在读取终端…" } as const;

/**
 * The tab, when it is showing the Mini App tool page.
 *
 * The check is on the content's own discriminant, so the tab that comes back
 * carries the picker's session — which is what the page needs to open a Mini
 * App into.
 */
function isMiniAppPickerTab(
  tab: WorkspacePanelTab | undefined,
): tab is WorkspacePanelTab & {
  readonly content: Extract<WorkspacePanelTab["content"], { readonly kind: "miniapp-picker" }>;
} {
  return tab?.content.kind === "miniapp-picker";
}

function WebuiWorkspacePanelView({ state, dispatch, sessionId, workspaceDir, workspaceFileUrl, terminal: terminalOwner, onClose, onManageMiniApps, onMiniAppMountTarget, onMiniAppToolbarTarget, onOpenDesignSession }: {
  readonly state: WorkspacePanelState;
  readonly dispatch: (command: WorkspacePanelCommand) => void;
  readonly sessionId?: string; readonly workspaceDir?: string;
  readonly workspaceFileUrl?: (request: { readonly workspaceDir: string; readonly path: string }) => string;
  /**
   * The Terminal business's published owner. The panel used to take six
   * raw capability methods and keep the catalogue and the watch handle itself;
   * it now renders the owner's catalogue and drives the owner's commands, while
   * the xterm instance, the fit observer and the caret stay local.
   */
  readonly terminal?: WebuiTerminalOwner;
  readonly onClose?: () => void;
  readonly onManageMiniApps?: () => void;
  readonly onOpenDesignSession?: (sessionId: string) => void;
  readonly onMiniAppMountTarget?: (target: HTMLDivElement | null) => void;
  readonly onMiniAppToolbarTarget?: (target: HTMLDivElement | null) => void;
}): ReactElement {
  const browserPort = useWebuiPortSlice("browser");
  const [panelWidth, setPanelWidth] = useState<number>();
  const [panelClosing, setPanelClosing] = useState(false);
  const [expansionMotion, setExpansionMotion] = useState<"expand" | "collapse">();
  /**
   * The tier this panel takes on the surface it shares with the conversation
   * column (ADR 0025).
   *
   * The tier is measured rather than queried: the surface is not the window,
   * because the navigation rail takes its share of the window first, and a
   * panel that sized itself against the window could cover the navigation
   * rail. The panel reports the tier on itself and the stylesheet owns what
   * each tier looks like.
   */
  const [surfaceTier, setSurfaceTier] = useState<WebuiSurfaceTier>("split");
  const panelStateRef = useRef(state);
  panelStateRef.current = state;
  const panelClosingRef = useRef(false);
  const pendingPanelClose = useRef<WorkspacePanelCommand | undefined>(undefined);
  const resizeGesture = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number; requestedWidth: number } | undefined>(undefined);
  const panelRef = useRef<HTMLElement | null>(null);
  /** The surface's width, read by the drag without a re-render on every frame. */
  const surfaceWidthRef = useRef<number>();
  /** The width the person asked for, read the same way. */
  const panelWidthRef = useRef<number>();
  panelWidthRef.current = panelWidth;
  const { dom, dataDir } = useWebuiBrowserCapabilities();
  // Query truth lives in the owner; this component reads its snapshot and
  // submits query commands. Display state — active tab, expansion, search box,
  // code mode — stays here.
  const queries = useWebuiWorkspacePanelSurface();
  const queryState = useWebuiWorkspaceQueriesState();
  const fileTree = queryState.fileTree;
  const fileResults = queryState.files;
  const reviewSummary = queryState.reviewSummary;
  const reviewDiffs = queryState.reviewDiffs;
  const reviewSearch = queryState.reviewSearch;
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const activeTurnReviewSessionId = activeTab?.content.kind === "review" && activeTab.content.source === "turn"
    ? activeTab.content.sessionId
    : undefined;
  const activeWebTab = activeTab && activeTab.content.kind === "web"
    ? { id: activeTab.id, content: activeTab.content }
    : undefined;
  // Keep the most recently viewed browser tab mounted while another workspace
  // tab is selected. BrowserPanelHost owns the live frame subscription and its
  // image element; unmounting it here forces a new subscription and leaves a
  // visible blank interval on every return to a web tab.
  const retainedWebTabId = useRef<string | undefined>(
    activeWebTab?.id ?? state.tabs.find((candidate) => candidate.content.kind === "web")?.id,
  );
  useLayoutEffect(() => {
    if (activeWebTab) retainedWebTabId.current = activeWebTab.id;
  }, [activeWebTab?.id]);
  const retainedWebTab = state.tabs.find(
    (candidate): candidate is WorkspacePanelTab & { readonly content: Extract<WorkspacePanelTab["content"], { readonly kind: "web" }> } =>
      candidate.id === retainedWebTabId.current && candidate.content.kind === "web",
  );
  const browserTab = activeWebTab ?? retainedWebTab;
  const tab = activeTab?.content.kind ?? "files";
  /**
   * The surface measurement.
   *
   * `useLayoutEffect` rather than `useEffect`: the tier decides whether the
   * panel is a column beside the conversation or an overlay over it, and the
   * measurement has to land before the first paint or the panel is drawn in
   * the wrong form for a frame.
   *
   * The observer is also what re-clamps the width. A window that narrows after
   * a drag never moves the pointer, so a clamp that only ran while the pointer
   * moved left the panel wider than the surface.
   */
  useLayoutEffect(() => {
    const surface = panelRef.current?.closest<HTMLElement>(
      '[data-webui-shell-region="surface"]',
    );
    if (!surface) return;
    const measure = (width: number): void => {
      surfaceWidthRef.current = width;
      const tier = webuiSurfaceTier(width);
      setSurfaceTier((current) => (current === tier ? current : tier));
      const desired = panelWidthRef.current;
      if (desired === undefined) return;
      const bounds = webuiPanelWidthBounds(width);
      if (desired > bounds.max) setPanelWidth(Math.max(bounds.min, bounds.max));
    };
    measure(surface.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      measure(entry.contentRect.width);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  /**
   * A degradation discards the width the person set.
   *
   * The panel gives the space back to the conversation column, and widening the
   * window again does not take it back: a panel that silently reclaimed the
   * space the conversation is using would be the same squeeze in a later form.
   */
  useEffect(() => {
    if (surfaceTier === "overlay") setPanelWidth(undefined);
  }, [surfaceTier]);
  const fileTreeScrollRef = useRef<HTMLDivElement>(null);
  const autoNavigationRequests = useRef(new Set<string>());
  const [fileSearch, setFileSearch] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const expandedDirectoriesRef = useRef(expandedDirectories);
  expandedDirectoriesRef.current = expandedDirectories;
  const [fileCodeMode, setFileCodeMode] = useState(false);
  const [reviewSearchQuery, setReviewSearchQuery] = useState("");
  const [reviewSearchAppliedQuery, setReviewSearchAppliedQuery] = useState("");
  const [reviewSectionsExpanded, setReviewSectionsExpanded] = useState<boolean>();
  const [reviewDiffLayout, setReviewDiffLayout] = useState<"unified" | "split">("unified");
  const [reviewShowContext, setReviewShowContext] = useState(true);
  const setMiniAppToolbarTarget = onMiniAppToolbarTarget ?? (() => undefined);
  const setMiniAppMountTarget = onMiniAppMountTarget ?? (() => undefined);
  const activeWorkspace = activeTab && "workspaceDir" in activeTab.content ? activeTab.content.workspaceDir : workspaceDir;
  // The terminal tab's roster, xterm and resize reporting. The panel says which
  // tab is on screen and where the PTY belongs; the binding owns what the
  // browser and the runtime have to agree on — the read generation, the ready
  // flag, the auto-create latch, the grid measurement and the reported size.
  const terminal = useWorkspaceTerminal({
    owner: terminalOwner,
    tabKind: tab,
    tabId: activeTab?.id,
    workspaceDir: activeWorkspace,
  });
  // The file tree could not be read: the failure is said once, as a toast, and
  // is not drawn in the tree's own scroll area.
  useWebuiToastError(fileTree.workspaceDir === activeWorkspace && !fileTree.loading ? fileTree.error : undefined);
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const activeFilePath = activeTab?.content.kind === "file-preview" ? activeTab.content.path : undefined;
  // The file results are keyed by what the tab is showing, not by which slot
  // it is: the id is stable and the content is not, so a cache keyed by the id
  // would hand the previous file's content to the new one.
  const activeFileKey = activeTab?.content.kind === "file-preview" ? webuiWorkspaceTabContentKey(activeTab.content) : undefined;
  const activeFileResult = activeTab?.content.kind === "file-preview" ? fileResults.get(activeFileKey!)?.content : undefined;
  const selectedFilePath = activeTab?.content.kind === "file-preview" ? activeFileResult?.resolvedPath ?? activeTab.content.path : undefined;
  const hasFileWorkspace = tab === "files" || activeTab?.content.kind === "file-preview" || activeTab?.content.kind === "review";
  const hasMiniAppView = tab === "miniapp" && activeTab?.content.kind === "miniapp";
  const hasWorkspaceToolbar = hasFileWorkspace || hasMiniAppView;
  const visibleFiles = useMemo(
    () => filterWorkspaceFiles(fileTree.files ?? [], fileSearch),
    [fileSearch, fileTree.files],
  );
  const currentPanelState = useRef(state);
  currentPanelState.current = state;
  const filesRef = useRef(fileResults);
  filesRef.current = fileResults;
  useEffect(() => {
    queries?.selectWorkspace(activeWorkspace);
    setFileSearch("");
    setExpandedDirectories(new Set());
  }, [activeWorkspace, queries]);
  useEffect(() => {
    setFileCodeMode(activeTab?.content.kind === "file-preview" && activeTab.content.lineStart !== undefined);
  }, [activeTab?.id]);
  useEffect(() => {
    if (!activeWorkspace) return;
    queries?.loadFileTree(activeWorkspace);
  }, [activeWorkspace, queries]);
  useEffect(() => {
    if (activeTab?.content.kind !== "file-preview" || !queries) return undefined;
    // A tab opened with inline content (the session's plan file) has nothing
    // to read: `readWorkspaceFile` would reject the path anyway, since the
    // artifacts directory is outside the workspace root.
    if (activeTab.content.content !== undefined) {
      queries.setInlineFile(activeFileKey!, activeTab.content.content, activeTab.content.path);
      return undefined;
    }
    queries.readFile(activeFileKey!, activeTab.content.workspaceDir, activeTab.content.path);
    return undefined;
    // The cache key is the dependency, not the id: the id is stable and the
    // content is not, so a tab that changed from one file to another has to
    // read the new one. The content *object* is not a dependency — a content
    // that is replaced by an equal one is the same file, and re-reading it
    // would supersede the read that is already in flight.
  }, [activeTab?.id, activeFileKey, queries]);
  useEffect(() => {
    if (activeTab?.content.kind !== "file-preview" || activeTab.content.lineStart === undefined || fileResults.get(activeFileKey!)?.loading || !fileResults.get(activeFileKey!)?.content || fileResults.get(activeFileKey!)?.error) return;
    const target = dom.getElementById(webuiFileLineTargetId(activeTab.id, activeTab.content.lineStart));
    if (target) focusWebuiFileLine(target);
  }, [activeTab?.id, activeFileKey, activeTab?.content.kind === "file-preview" ? activeTab.content.lineStart : undefined, dom, fileResults]);
  useEffect(() => {
    if (activeTab?.content.kind !== "review" || activeTab.content.source !== "workspace" || !queries) return undefined;
    void queries.loadReviewSummary(activeTab.id, activeTab.content.workspaceDir).then((summary) => {
      if (summary) dispatch({ type: "set-review-snapshot", tabId: activeTab.id, reviewSnapshotId: summary.reviewSnapshotId });
    });
    return undefined;
    // The content is a dependency here too: a tab that changes from a turn's
    // review to the workspace's review has to load the summary it now needs.
  }, [activeTab?.id, activeTab?.content, activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.workspaceDir : undefined, queries, queryState.reviewRevision]);
  const workspaceReviewSelectedPath = activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.selectedPath : undefined;
  const workspaceReviewWorkspaceDir = activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.workspaceDir : undefined;
  const workspaceReviewFiles = reviewSummary !== undefined && reviewSummary.tabId === activeTab?.id ? reviewSummary.summary?.files ?? [] : [];
  const currentWorkspaceReviewSearch = activeTab?.content.kind === "review" && activeTab.content.source === "workspace"
    && reviewSearch?.tabId === activeTab.id && reviewSearch.snapshotId === activeTab.content.reviewSnapshotId
    ? reviewSearch
    : undefined;
  const matchedWorkspaceReviewFiles = reviewSearchAppliedQuery && currentWorkspaceReviewSearch?.result
    ? currentWorkspaceReviewSearch.result.matchedFiles
      .map((match) => workspaceReviewFiles.find((file) => file.fileId === match.fileId))
      .filter((file): file is NonNullable<typeof file> => file !== undefined)
    : workspaceReviewFiles;
  const showingWorkspaceReviewSearchResults = Boolean(reviewSearchAppliedQuery && currentWorkspaceReviewSearch?.result && !currentWorkspaceReviewSearch.loading && !currentWorkspaceReviewSearch.error);
  // The turn's files are projected through the workspace boundary before they
  // are rendered: a file outside the workspace keeps its name and its counts,
  // and loses the body that would have shown its content.
  const turnReviewFiles = activeTab?.content.kind === "review" && activeTab.content.source === "turn"
    ? projectWebuiDiffFiles(activeTab.content.files, activeTab.content.workspaceDir, {
      dataDir,
      sessionId: activeTab.content.sessionId,
    })
    : [];
  const reviewFileCount = activeTab?.content.kind !== "review" ? 0
    : activeTab.content.source === "turn" ? turnReviewFiles.length
      : workspaceReviewFiles.length;
  const reviewFilesExpanded = reviewSectionsExpanded ?? !showingWorkspaceReviewSearchResults;
  const selectedReviewPath = activeTab?.content.kind === "review" && activeTab.content.source === "workspace"
    ? workspaceReviewFiles.some((file) => file.path === workspaceReviewSelectedPath) ? workspaceReviewSelectedPath : workspaceReviewFiles[0]?.path
    : activeTab?.content.kind === "review" && activeTab.content.source === "turn" ? activeTab.content.selectedPath ?? turnReviewFiles[0]?.file : undefined;
  useEffect(() => {
    if (activeTab?.content.kind !== "review" || activeTab.content.source !== "workspace" || !selectedReviewPath || selectedReviewPath === activeTab.content.selectedPath) return;
    dispatch({ type: "select-review-file", tabId: activeTab.id, path: selectedReviewPath });
  }, [activeTab?.id, activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.selectedPath : undefined, selectedReviewPath, dispatch]);
  useEffect(() => {
    const summary = reviewSummary && reviewSummary.tabId === activeTab?.id ? reviewSummary.summary : undefined;
    if (activeTab?.content.kind !== "review" || activeTab.content.source !== "workspace" || !summary || !activeTab.content.reviewSnapshotId || summary.reviewSnapshotId !== activeTab.content.reviewSnapshotId || !queries) return undefined;
    void queries.loadReviewDiffs({ tabId: activeTab.id, workspaceDir: activeTab.content.workspaceDir, snapshotId: activeTab.content.reviewSnapshotId, fileIds: summary.files.map((file) => file.fileId) });
    return undefined;
  }, [activeTab?.id, activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.reviewSnapshotId : undefined, activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? activeTab.content.workspaceDir : undefined, reviewSummary?.summary?.reviewSnapshotId, queries]);
  const runReviewSearch = (input: string) => {
    if (activeTab?.content.kind !== "review" || activeTab.content.source !== "workspace" || !activeTab.content.reviewSnapshotId || !queries) return;
    const query = input.trim();
    setReviewSearchAppliedQuery(query);
    if (!query) return;
    void queries.searchReviewDiffs({ tabId: activeTab.id, workspaceDir: activeTab.content.workspaceDir, snapshotId: activeTab.content.reviewSnapshotId, query });
  };
  const activeReviewTabId = activeTab?.content.kind === "review" ? activeTab.id : undefined;
  const selectWorkspaceReviewFile = useCallback((path: string) => {
    if (activeReviewTabId) dispatch({ type: "select-review-file", tabId: activeReviewTabId, path });
  }, [activeReviewTabId, dispatch]);
  const toggleWorkspaceDirectory = useCallback((directory: WebuiWorkspaceFile) => {
    const path = directory.path;
    if (expandedDirectoriesRef.current.has(path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpandedDirectories((current) => new Set(current).add(path));
    if (directory.children !== undefined || fileTree.loadedDirectories.has(path) || fileTree.loadingDirectories.has(path)) return;
    if (!activeWorkspace || !queries) return;
    void queries.loadDirectory(activeWorkspace, path);
  }, [activeWorkspace, fileTree.loadedDirectories, fileTree.loadingDirectories, queries]);
  const workspaceTreeOpenContext = useRef({ activeTab, activeWorkspace, sessionId, turnReviewFiles, workspaceReviewFiles });
  workspaceTreeOpenContext.current = { activeTab, activeWorkspace, sessionId, turnReviewFiles, workspaceReviewFiles };
  const openWorkspaceTreeFile = useCallback((entry: WebuiWorkspaceFile) => {
    const { activeTab, activeWorkspace, sessionId, turnReviewFiles, workspaceReviewFiles } = workspaceTreeOpenContext.current;
    const context = activeTab && "sessionId" in activeTab.content ? activeTab.content.sessionId : sessionId;
    if (!activeWorkspace || !context || entry.type === "directory") return;
    const isReviewFile = activeTab?.content.kind === "review" && (
      activeTab.content.source === "turn"
        ? turnReviewFiles.some((file) => file.file === entry.path)
        : workspaceReviewFiles.some((file) => file.path === entry.path)
    );
    if (isReviewFile && activeTab) dispatch({ type: "select-review-file", tabId: activeTab.id, path: entry.path });
    else dispatch({ type: "open-file", sessionId: context, workspaceDir: activeWorkspace, path: entry.path });
  }, [dispatch]);
  useEffect(() => {
    if (activeTab?.content.kind !== "file-preview" || !selectedFilePath || !activeWorkspace || !queries || fileTree.workspaceDir !== activeWorkspace || fileTree.loading) return;
    let cancelled = false;
    const isCurrentFile = () => {
      const currentTab = currentPanelState.current.tabs.find((candidate) => candidate.id === currentPanelState.current.activeTabId);
      return activeWorkspaceRef.current === activeWorkspace
        && currentTab?.content.kind === "file-preview"
        && currentTab.id === activeTab.id
        && (filesRef.current.get(currentTab.id)?.content?.resolvedPath ?? currentTab.content.path) === selectedFilePath;
    };
    const navigateToFile = async () => {
      setFileSearch("");
      let tree = fileTree.files;
      const parentPaths = getWorkspaceFileParentPaths(selectedFilePath);
      for (const [index, path] of parentPaths.entries()) {
        if (cancelled || !isCurrentFile()) return;
        const directory = findWorkspaceFile(tree, path);
        if (directory?.type !== "directory") return;
        setExpandedDirectories((current) => current.has(path) ? current : new Set(current).add(path));
        const expectedChildPath = parentPaths[index + 1] ?? selectedFilePath;
        const expectedChildExists = Boolean(findWorkspaceFile(directory.children ?? [], expectedChildPath));
        const refreshMissingPath = directory.children !== undefined && !expectedChildExists;
        if (!refreshMissingPath && (directory.children !== undefined || fileTree.loadedDirectories.has(path))) continue;
        const requestKey = `${activeWorkspace}\0${path}`;
        if (fileTree.loadingDirectories.has(path) || autoNavigationRequests.current.has(requestKey)) return;
        autoNavigationRequests.current.add(requestKey);
        try {
          const children = await queries.loadDirectory(activeWorkspace, path);
          if (cancelled || !isCurrentFile()) return;
          if (children === undefined) return;
          tree = mergeWorkspaceFileChildren(tree, path, children);
          if (!findWorkspaceFile(children, expectedChildPath)) {
            queries.reportDirectoryError(activeWorkspace, path, `无法在工作区文件树中定位 ${selectedFilePath}。`);
            return;
          }
        } catch {
          return;
        } finally {
          autoNavigationRequests.current.delete(requestKey);
        }
      }
    };
    void navigateToFile();
    return () => { cancelled = true; };
  }, [activeTab?.id, activeTab?.content.kind === "file-preview" ? activeTab.content.path : undefined, selectedFilePath, activeWorkspace, fileTree.workspaceDir, fileTree.loading, queries]);
  useEffect(() => {
    fileTreeScrollRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedFilePath, selectedReviewPath, expandedDirectories, visibleFiles]);
  const activeSessionId = activeTab && "sessionId" in activeTab.content ? activeTab.content.sessionId : sessionId;
  const activeReview = webuiWorkspaceReviewContent(activeTab?.content);
  // The review summary, the search and the diffs each answer with their own
  // failure; each one is said once, as a toast, and none of them is drawn in
  // the layout.
  const workspaceReviewSummaryError = reviewSummary && reviewSummary.error && !reviewSummary.summary ? reviewSummary.error : undefined;
  const workspaceReviewSearchError = reviewSearchAppliedQuery ? currentWorkspaceReviewSearch?.error : undefined;
  const workspaceReviewDiffError = reviewDiffs && reviewDiffs.tabId === activeTab?.id && reviewDiffs.snapshotId === activeReview?.reviewSnapshotId ? reviewDiffs.error : undefined;
  useWebuiToastError(workspaceReviewSummaryError);
  useWebuiToastError(workspaceReviewSearchError);
  useWebuiToastError(workspaceReviewDiffError);
  // The registry carries the kinds, their words and how each opens. Both the tab
  // glyphs the strip needs and the launcher's tiles live in the strip itself:
  // the new tab page took the place of this panel's add menu, which was the same
  // four kinds behind a dropdown.
  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The overlay's width belongs to the stylesheet, so there is nothing to
    // drag; the panel's own form is not the drag's business.
    if (state.expanded || surfaceTier !== "split" || event.button !== 0) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const startWidth = panel.getBoundingClientRect().width;
    resizeGesture.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, requestedWidth: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const surfaceWidth = surfaceWidthRef.current
      ?? event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width
      ?? window.innerWidth;
    // The surface excludes the navigation rail and bounds the overlap.
    const bounds = webuiPanelWidthBounds(surfaceWidth);
    const requestedWidth = Math.min(bounds.max, Math.max(bounds.min, gesture.startWidth - (event.clientX - gesture.startX)));
    gesture.requestedWidth = requestedWidth;
    const panel = panelRef.current;
    if (!panel) return;
    // A drag is continuous input. Write its geometry directly so each pointer
    // sample does not reconcile the panel's file tree, diff view and transcript.
    panel.style.width = `${requestedWidth}px`;
    panel.style.flex = `0 0 ${requestedWidth}px`;
    panel.style.setProperty("--webui-workspace-width", `${requestedWidth}px`);
  };
  const stopPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;
    resizeGesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (Math.abs(gesture.requestedWidth - gesture.startWidth) > 0.5)
      setPanelWidth(gesture.requestedWidth);
  };
  const nudgePanelResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (state.expanded || surfaceTier !== "split" || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    const surfaceWidth = surfaceWidthRef.current
      ?? panel?.parentElement?.getBoundingClientRect().width
      ?? window.innerWidth;
    const currentWidth = panel?.getBoundingClientRect().width ?? surfaceWidth / 2;
    const bounds = webuiPanelWidthBounds(surfaceWidth);
    const requestedWidth = Math.min(bounds.max, Math.max(bounds.min, currentWidth + (event.key === "ArrowLeft" ? 24 : -24)));
    setPanelWidth(requestedWidth);
  };
  const handlePanelExitComplete = () => {
    const pendingClose = pendingPanelClose.current;
    pendingPanelClose.current = undefined;
    if (pendingClose) dispatch(pendingClose);
    else if (onClose) onClose();
    else dispatch({ type: "close-panel" });
  };
  const startPanelClosing = () => {
    if (panelClosingRef.current) return;
    panelClosingRef.current = true;
    setPanelClosing(true);
  };
  const panelDispatch = useCallback((command: WorkspacePanelCommand) => {
    if (command.type === "close-tab" && panelStateRef.current.tabs.length === 1) {
      pendingPanelClose.current = command;
      startPanelClosing();
      return;
    }
    dispatch(command);
  }, [dispatch]);
  const toggleExpanded = () => {
    setExpansionMotion(state.expanded ? "collapse" : "expand");
    dispatch({ type: "toggle-expanded" });
  };
  return <WebuiPage as="aside" kind="panel" present={!panelClosing} motion={{ kind: "panel", state: expansionMotion ?? "enter", direction: "right" }} ref={panelRef} className={`webui-workspace-panel ${state.expanded ? "is-expanded" : ""} ${panelClosing ? "is-closing" : ""}`} onExitComplete={handlePanelExitComplete} style={panelWidth !== undefined && !state.expanded && surfaceTier === "split" ? { width: `${panelWidth}px`, flex: `0 0 ${panelWidth}px`, "--webui-workspace-width": `${panelWidth}px` } as React.CSSProperties : undefined} data-testid="workspace-panel" data-active-tab={tab} data-webui-surface-tier={surfaceTier}>
    <div className="webui-workspace-panel-resize-handle" role="separator" aria-label="调整工作区面板宽度" aria-orientation="vertical" aria-valuenow={Math.round(panelWidth ?? 50)} tabIndex={state.expanded ? -1 : 0} onPointerDown={startPanelResize} onPointerMove={movePanelResize} onPointerUp={stopPanelResize} onPointerCancel={stopPanelResize} onKeyDown={nudgePanelResize} />
    <div className="webui-workspace-panel-header">
      <div className="webui-workspace-tabs">
        <WebuiWorkspaceTabStrip state={state} dispatch={panelDispatch} sessionId={sessionId} />
      </div>
      <div className="webui-workspace-panel-actions">
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" aria-label={state.expanded ? "收起面板" : "展开面板"} aria-pressed={state.expanded} onClick={toggleExpanded}><WebuiIconWorkspaceExpand expanded={state.expanded} className="size-[18px]" /></WebuiButton>
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action webui-workspace-panel-close" aria-label="关闭面板" disabled={panelClosing} onClick={startPanelClosing}><WebuiIconClose className="size-[18px]" /></WebuiButton>
      </div>
    </div>
    {hasWorkspaceToolbar ? <div className={`webui-workspace-file-toolbar${activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? " webui-workspace-file-toolbar--review" : ""}${hasMiniAppView ? " webui-workspace-file-toolbar--miniapp" : ""}`}>
      <div className="webui-workspace-file-breadcrumb" role="navigation" aria-label="文件路径">
        {activeFilePath ? activeFilePath.split("/").map((part, index) => <span key={`${part}-${index}`} className={index === activeFilePath.split("/").length - 1 ? "is-current" : ""}>{index ? <WebuiIconChevronRight className="size-3" /> : null}{part}</span>) : <span className="is-current">{basenamePath(workspaceDir ?? "") || "工作区"}</span>}
      </div>
      {activeTab?.content.kind === "file-preview" && /\.md$/iu.test(activeTab.content.path) ? <div className="webui-workspace-file-mode" role="group" aria-label="文件显示模式">
        <WebuiButton variant="segmented" size="compact" className="webui-workspace-file-mode-button" aria-pressed={!fileCodeMode} onClick={() => setFileCodeMode(false)}>预览</WebuiButton>
        <WebuiButton variant="segmented" size="compact" className="webui-workspace-file-mode-button" aria-pressed={fileCodeMode} onClick={() => setFileCodeMode(true)}>代码</WebuiButton>
      </div> : null}
      {activeTab?.content.kind === "file-preview" ? <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" aria-label="编辑文件（暂未支持）" disabled><IconEdit aria-hidden="true" className="size-[18px]" size={18} stroke={1.7} /></WebuiButton> : null}
      {hasMiniAppView ? <div className="webui-workspace-miniapp-toolbar" role="toolbar" aria-label="应用工具栏" ref={setMiniAppToolbarTarget} /> : tab === "review" ? <div className="webui-workspace-review-toolbar" role="toolbar" aria-label="差异工具栏">
        {activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? <WebuiSearchField className="webui-workspace-review-search-field" icon={<WebuiIconSearch className="size-4" />} label="搜索变更" value={reviewSearchQuery} onChange={(event) => { const query = event.currentTarget.value; setReviewSearchQuery(query); runReviewSearch(query); }} placeholder="搜索变更" /> : null}
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" type="button" disabled={!reviewFileCount} aria-label={reviewFilesExpanded ? "收起所有文件差异" : "展开所有文件差异"} aria-pressed={reviewFilesExpanded} title={reviewFilesExpanded ? "收起所有文件差异" : "展开所有文件差异"} data-testid="workspace-review-toolbar-expand" onClick={() => setReviewSectionsExpanded(!reviewFilesExpanded)}>
          <IconListCheck aria-hidden="true" className="size-[18px]" size={18} stroke={1.7} />
        </WebuiButton>
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" type="button" aria-label={reviewDiffLayout === "unified" ? "切换到并排差异视图" : "切换到统一差异视图"} aria-pressed={reviewDiffLayout === "split"} title={reviewDiffLayout === "unified" ? "并排差异视图" : "统一差异视图"} data-testid="workspace-review-toolbar-layout" onClick={() => setReviewDiffLayout((layout) => layout === "unified" ? "split" : "unified")}>
          <IconLayoutColumns aria-hidden="true" className="size-[18px]" size={18} stroke={1.7} />
        </WebuiButton>
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" type="button" aria-label={reviewShowContext ? "隐藏未修改行" : "显示未修改行"} aria-pressed={!reviewShowContext} title={reviewShowContext ? "隐藏未修改行" : "显示未修改行"} data-testid="workspace-review-toolbar-context" onClick={() => setReviewShowContext((visible) => !visible)}>
          <IconAdjustmentsHorizontal aria-hidden="true" className="size-[18px]" size={18} stroke={1.7} />
        </WebuiButton>
        <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" aria-label={fileTreeOpen ? "隐藏文件树" : "显示文件树"} aria-pressed={fileTreeOpen} title={fileTreeOpen ? "隐藏文件树" : "显示文件树"} data-testid="workspace-review-toolbar-tree" onClick={() => setFileTreeOpen((open) => !open)}><WebuiIconSidebarToggle className="size-5" /></WebuiButton>
      </div> : <WebuiButton variant="quiet-action" size="inline" className="webui-workspace-panel-action" aria-label={fileTreeOpen ? "隐藏文件树" : "显示文件树"} aria-pressed={fileTreeOpen} onClick={() => setFileTreeOpen((open) => !open)}><WebuiIconSidebarToggle className="size-5" /></WebuiButton>}
    </div> : null}
    <div className="webui-workspace-panel-body">
      <div className="webui-workspace-view">
    {tab === "files" ? <div className="webui-workspace-files-empty" data-testid="workspace-files-empty"><WebuiIconFolder className="size-8" /><strong>查看文件</strong><p>从工作区目录树中选择文件</p></div> : null}
    {tab === "file-preview" && activeTab?.content.kind === "file-preview" ? <WebuiFilePreview tabId={activeTab.id} content={activeTab.content} result={fileResults.get(activeFileKey!)} codeMode={fileCodeMode} workspaceFileUrl={workspaceFileUrl} /> : null}
    {tab === "review" && activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? <div className="webui-turn-review" data-testid="workspace-review">
      {/* 下面的状态文案都是播报通道，交给共享契约；类名不变，样式继续命中。 */}
      {reviewSummary?.tabId !== activeTab.id || reviewSummary.loading && !reviewSummary.summary ? <FeedbackLiveRegion className="webui-turn-review-empty">正在收集变更…</FeedbackLiveRegion> : reviewSummary.summary ? <>
        <WebuiInline gap="medium" justify="between" className="webui-turn-review-summary"><span>{reviewSummary.summary.totals.files} 个文件</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{reviewSummary.summary.totals.additions}</span>{reviewSummary.summary.totals.deletions ? <span className="webui-diff-del">-{reviewSummary.summary.totals.deletions}</span> : null}</span></WebuiInline>
        {reviewSummary.summary.files.length ? <>
          {reviewSearchAppliedQuery && currentWorkspaceReviewSearch?.loading ? <FeedbackLiveRegion className="webui-workspace-review-status">正在搜索变更…</FeedbackLiveRegion> : null}
          {showingWorkspaceReviewSearchResults && matchedWorkspaceReviewFiles.length === 0 ? <FeedbackLiveRegion className="webui-turn-review-empty">没有匹配的变更文件。</FeedbackLiveRegion> : null}
          {!reviewSearchAppliedQuery || !currentWorkspaceReviewSearch?.loading && !currentWorkspaceReviewSearch?.error && matchedWorkspaceReviewFiles.length > 0 ? <div className="webui-turn-review-files" data-show-context={reviewShowContext ? "true" : "false"} data-testid={showingWorkspaceReviewSearchResults ? "workspace-review-search-results" : undefined}>{matchedWorkspaceReviewFiles.map((file) => {
            const result = reviewDiffs?.tabId === activeTab.id && reviewDiffs.snapshotId === activeReview?.reviewSnapshotId ? reviewDiffs.diffs[file.fileId] : undefined;
            const loading = !result && (reviewDiffs?.tabId !== activeTab.id || reviewDiffs.snapshotId !== activeReview?.reviewSnapshotId || reviewDiffs.loading);
            return <WebuiDiffFileSection key={`${file.fileId}:${showingWorkspaceReviewSearchResults ? "search" : "list"}:${reviewSectionsExpanded ?? "default"}`} file={projectWebuiDiffFile({ file: file.path, additions: file.additions, deletions: file.deletions, status: file.status, ...(result?.diff !== undefined ? { diff: result.diff } : {}) }, workspaceReviewWorkspaceDir)} selected={selectedReviewPath === file.path} loading={loading} error={result?.binary ? "二进制文件无法显示文本差异。" : result?.error} defaultOpen={reviewSectionsExpanded ?? !showingWorkspaceReviewSearchResults} diffLayout={reviewDiffLayout} onSelect={selectWorkspaceReviewFile} />;
          })}</div> : null}
        </> : <FeedbackEmpty className="webui-turn-review-empty" title={"当前没有变更。"} />}
      </> : null}
    </div> : null}
    {tab === "review" && activeTab?.content.kind === "review" && activeTab.content.source === "turn" ? <div className="webui-turn-review" data-testid="turn-review-panel" data-session-id={activeTab.content.sessionId} data-message-id={activeTab.content.messageId} data-turn-id={activeTab.content.turnId} data-change-set-id={activeTab.content.changeSetId}>
      <WebuiInline gap="medium" justify="between" className="webui-turn-review-summary"><span>本轮改动</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{turnReviewFiles.reduce((sum, file) => sum + file.additions, 0)}</span>{turnReviewFiles.some((file) => file.deletions > 0) ? <span className="webui-diff-del">-{turnReviewFiles.reduce((sum, file) => sum + file.deletions, 0)}</span> : null}</span></WebuiInline>
      {turnReviewFiles.length ? <div className="webui-turn-review-files">{turnReviewFiles.map((file) => <WebuiDiffFileSection key={`${file.file}:${reviewSectionsExpanded ?? "default"}`} file={file} selected={selectedReviewPath === file.file} defaultOpen={reviewSectionsExpanded ?? true} diffLayout={reviewDiffLayout} showContext={reviewShowContext} onOpenOutsideFile={(path) => {
        if (!activeTurnReviewSessionId) return;
        const normalized = path.replace(/\\/gu, "/");
        const separator = normalized.lastIndexOf("/");
        if (separator <= 0 || !basenamePath(normalized)) return;
        dispatch({ type: "open-file", sessionId: activeTurnReviewSessionId, workspaceDir: normalized.slice(0, separator), path: basenamePath(normalized) });
      }} />)}</div> : <FeedbackEmpty className="webui-turn-review-empty" title={"本轮没有可审查的文件差异。"} />}
    </div> : null}
    {tab === "canvas" ? <DesignSurface sessionId={activeSessionId} openSession={onOpenDesignSession} /> : null}
    {browserTab ? <div className="webui-workspace-web-tab" data-testid="workspace-web-tab" data-tab-id={browserTab.id} data-inactive={!activeWebTab ? "true" : undefined} aria-hidden={!activeWebTab}>
      <BrowserPanelHost
        target={browserTab.content.target}
        url={browserTab.content.url}
        canGoBack={browserTab.content.canGoBack}
        canGoForward={browserTab.content.canGoForward}
        onReturnToNewTab={async () => {
          const { target } = browserTab.content;
          const tabId = browserTab.id;
          await browserPort?.closeBrowserWebTab?.({ target });
          dispatch({ type: "return-web-tab-to-launcher", tabId });
        }}
      />
    </div> : null}
    {tab === "launcher" && activeTab?.content.kind === "launcher" ? <div className="webui-workspace-web-tab" data-testid="workspace-launcher-tab">
      <WebuiBrowserToolbar
        navigationDisabled
        onNavigate={(input) => {
          const url = webuiWorkspaceLauncherUrl(input);
          const open = browserPort?.openBrowserWebTab;
          if (!url || !open) return;
          void webuiWorkspaceLauncherOpenPage({
            tabId: activeTab.id,
            url,
            dispatch,
            open,
            ...(sessionId ? { runId: sessionId } : {}),
          });
        }}
      />
      <WebuiWorkspaceLauncher tab={activeTab} dispatch={panelDispatch} sessionId={sessionId} workspaceDir={workspaceDir} />
    </div> : null}
    {/* The Mini App tool page. It is the tab's content like any other: the
        tile on the new tab page replaces that tab's content with it, and the
        choice made in it replaces the page with the Mini App's own. */}
    {tab === "miniapp-picker" && isMiniAppPickerTab(activeTab) ? (
      <div
        className="webui-workspace-miniapp-tab"
        data-testid="workspace-miniapp-picker-tab"
        data-tab-id={activeTab.id}
      >
        <MiniAppPicker
          sessionId={activeTab.content.sessionId}
          onManage={onManageMiniApps}
          onOpened={(pluginId) =>
            panelDispatch({
              type: "open-tab",
              kind: "miniapp",
              sessionId: activeTab.content.sessionId,
              pluginId,
              tabId: activeTab.id,
            })
          }
        />
      </div>
    ) : null}
    {/* A Mini App's page. The mounted component belongs to the Mini App
        business, which owns the view URL, the runtime state and the page
        bridge; this panel decides only that the tab is where it goes. */}
    {tab === "miniapp" && activeTab?.content.kind === "miniapp" ? (
      <div
        className="webui-workspace-miniapp-tab webui-workspace-miniapp-tab--view"
        data-testid="workspace-miniapp-tab"
        data-tab-id={activeTab.id}
        data-plugin-id={activeTab.content.pluginId}
      >
        <div className="webui-workspace-miniapp-view-mount" ref={setMiniAppMountTarget} />
      </div>
    ) : null}
    {tab === "terminal" ? <div className="webui-terminal-content">
        <div ref={terminal.hostRef} className="webui-xterm-host" />
        {/* A terminal that failed is said once, as a toast; a terminal still
            coming up is a status and is announced as one. The two are
            different states, so each carries the shared family's own channel.
            The line keeps no paragraph of its own: the family's channel is the
            element, and the terminal's own metrics come from
            `.webui-terminal-content > .webui-terminal-status`. */}
        {!terminal.ready || !terminal.hasTerminal && terminal.availability ? (
          <FeedbackLiveRegion
            className="webui-terminal-status"
            testId="workspace-terminal-status"
            dataAttributes={{ "data-webui-terminal-availability": terminal.support }}
          >
            {!terminal.ready ? WEBUI_TERMINAL_COPY.terminalLoading : terminal.availability}
          </FeedbackLiveRegion>
        ) : null}
    </div> : null}
      </div>
      {hasFileWorkspace ? <WebuiDisclosure as="aside" open={fileTreeOpen} axis="horizontal" className="webui-workspace-file-tree-panel" data-webui-page="panel" aria-label="工作区文件树">
        <WebuiSearchField className="webui-workspace-file-search" icon={<WebuiIconSearch className="size-4" />} label="搜索文件" placeholder="搜索" value={fileSearch} onChange={(event) => setFileSearch(event.currentTarget.value)} />
        <div className="webui-workspace-file-tree-scroll" ref={fileTreeScrollRef}>
          {/* 加载中是一条播报；播报通道交给共享契约。契约本身带 role="status"，
              仍是这个滚动容器的直接子元素，`.webui-workspace-file-tree-scroll > [role="status"]` 继续命中。 */}
          {fileTree.workspaceDir !== activeWorkspace || fileTree.loading ? <FeedbackLiveRegion>正在加载文件…</FeedbackLiveRegion> : fileTree.files.length ? visibleFiles.length ? <FileTree files={visibleFiles} expandedPaths={expandedDirectories} loadingPaths={fileTree.loadingDirectories} directoryErrors={fileTree.directoryErrors} onToggle={toggleWorkspaceDirectory} selectedPath={activeTab?.content.kind === "file-preview" ? selectedFilePath : activeTab?.content.kind === "review" ? selectedReviewPath : undefined} onOpen={openWorkspaceTreeFile} /> : <FeedbackEmpty className="webui-workspace-tree-empty" title={"没有匹配的文件。"} /> : <FeedbackEmpty className="webui-workspace-tree-empty" title={"此工作区没有可显示的文件。"} />}
        </div>
      </WebuiDisclosure> : null}
    </div>
  </WebuiPage>;
}

export const WebuiWorkspacePanel = memo(WebuiWorkspacePanelView);
