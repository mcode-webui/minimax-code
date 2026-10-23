import { useCallback, useEffect, useRef, useState, type AnimationEvent as ReactAnimationEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { Terminal } from "@xterm/xterm";
import { IconEdit } from "@tabler/icons-react";
import { FitAddon } from "@xterm/addon-fit";
import { basenamePath } from "../../../projection/common/paths.js";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import toml from "highlight.js/lib/languages/ini";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { WebuiMarkdown } from "../../transcript/ui/markdown.public.js";
// The browser panel is another business's published surface. The workspace
// may mount it and hand it a surface; it may not construct the browser
// state itself, which is why the host component exists.
//
// The strip itself lives in `WebuiWorkspaceTabStrip.public.tsx` — this file
// is over the size that "everything about the panel" fits in, and the strip
// is the part that crosses into the browser business through its published
// port. The strip subscribes to `watchBrowserWebTabs` and, for the active
// web tab, this file mounts `BrowserPanelHost` with the tab's target.
import { BrowserPanelHost } from "../../browser/ui/BrowserPanelHost.public.js";
import type { WebuiFileDiffInfoView } from "../../../../shared/contracts/session.js";
import type {
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
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
import {
  TERMINAL_RESIZE_DEBOUNCE_MS,
  terminalResizeRequest,
} from "../../terminal/projection/terminal-size.public.js";
import type { WebuiTerminalSize } from "../../terminal/contracts/terminal-port.js";
import type { WebuiTerminalOwner } from "../../terminal/contracts/terminal-owner.js";
import { WebuiIconChevronRight, WebuiIconClose, WebuiIconDiffFile, WebuiIconFolder, WebuiIconSearch, WebuiIconSidebarToggle, WebuiIconWorkspaceExpand } from "../../../shell/icons.js";
import { FileTree, filterWorkspaceFiles, findWorkspaceFile, getWorkspaceFileParentPaths, mergeWorkspaceFileChildren } from "./WorkspaceFileTree.js";
import { WorkspaceMediaPreview } from "./WorkspaceMediaPreview.js";
import { isMediaContent } from "../projection/media-preview.js";
import { WorkspaceCanvas } from "./WorkspaceCanvas.js";
import { WorkspaceArchiveView } from "./WorkspaceArchiveView.js";
import { WorkspaceHtmlPreview } from "./WorkspaceHtmlPreview.js";
import {
  WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE,
  chunkWebuiWorkspaceReviewFileIds,
} from "../../review/contracts/workspace-review.js";
import {
  useWebuiWorkspacePanelSurface,
  useWebuiWorkspaceQueries,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { WebuiWorkspaceLauncher, WebuiWorkspaceTabStrip } from "./WebuiWorkspaceTabStrip.public.js";
import { webuiFileLanguage, projectWebuiUnifiedDiffLines, isWorkspaceArchivePath, isWorkspaceHtmlPath } from "../projection/panel-projection.js";
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
const DESKTOP_COPY = { newTerminal: "新建终端", terminalLimit: "最多可以打开 5 个终端", terminalLabel: "终端", terminalExited: "已退出", terminalEmptyTitle: "还没有终端", terminalEmptyDescription: "可直接在右侧面板中启动当前工作区的 Shell。", terminalLoading: "正在读取终端…", fileClose: "关闭" } as const;

/**
 * How many PTYs the process half admits, per `runtime/terminal.ts`. The panel
 * checks it before asking, so a full set is stated rather than discovered by a
 * refused request.
 */
const DESKTOP_TERMINAL_LIMIT = 5;

const FILE_CODE_LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  toml,
  xml,
  yaml,
} as const;
for (const [name, language] of Object.entries(FILE_CODE_LANGUAGES)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
}

function highlightFileLine(line: string, language: string | undefined): string | undefined {
  if (!language || !hljs.getLanguage(language)) return undefined;
  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

export function WebuiDiffFileSection({ file, selected, loading = false, error, onSelect }: { readonly file: WebuiFileDiffInfoView; readonly selected: boolean; readonly loading?: boolean; readonly error?: string; readonly onSelect?: () => void }): ReactElement {
  const diff = typeof file.diff === "string" ? file.diff : "";
  const lines = projectWebuiUnifiedDiffLines(diff);
  const language = webuiFileLanguage(file.file);
  return <details className="webui-turn-review-file" open data-testid="turn-review-diff-file">
    <summary className="webui-turn-review-file-heading" aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <WebuiIconChevronRight className="webui-turn-review-chevron" />
      <span className="webui-diff-file-icon"><WebuiIconDiffFile fileName={file.file} /></span>
      <span className="webui-turn-review-file-path" title={file.file}>{file.file}</span>
      <span className="webui-diff-add">+{file.additions}</span>
      {file.deletions > 0 ? <span className="webui-diff-del">-{file.deletions}</span> : null}
    </summary>
    {loading ? <p className="webui-turn-review-unavailable" role="status">正在加载差异…</p> : error ? <p className="webui-turn-review-unavailable" role="alert">{error}</p> : lines.length ? <pre className="webui-file-code webui-turn-review-code"><code className={language ? `hljs language-${language}` : ""}>{lines.map((line, index) => {
      const highlighted = line.kind === "hunk" || line.kind === "noNewline" ? undefined : highlightFileLine(line.content, language);
      return <span className={`webui-turn-review-line webui-turn-review-line--${line.kind}`} key={`${index}-${line.kind}`}>
        {line.kind === "hunk" ? <span className="webui-turn-review-hunk">{line.content}</span> : line.kind === "noNewline" ? line.content : <>
          <span className="webui-turn-review-line-number">{line.oldLine ?? ""}</span>
          <span className="webui-turn-review-line-number">{line.newLine ?? ""}</span>
          <span className="webui-turn-review-marker">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
          <span className="webui-turn-review-source">{highlighted === undefined ? line.content : <span dangerouslySetInnerHTML={{ __html: highlighted }} />}</span>
        </>}
      </span>;
    })}</code></pre> : <p className="webui-turn-review-unavailable">当前运行时没有提供该文件的文本 patch。</p>}
  </details>;
}

export function WebuiFilePreview({ tabId, content, result, codeMode, workspaceFileUrl, }: {
  readonly tabId: string;
  readonly content: Extract<WebuiWorkspaceTabContent, { readonly kind: "file-preview" }>;
  readonly result?: { readonly loading: boolean; readonly content?: WebuiWorkspaceFileContent; readonly error?: string };
  readonly codeMode: boolean;
  readonly workspaceFileUrl?: (request: { readonly workspaceDir: string; readonly path: string }) => string;
}): ReactElement {
  const previewMarkdown = /\.md$/iu.test(content.path) && !codeMode;
  const text = result?.content?.content ?? "";
  const language = webuiFileLanguage(content.path);
  // Dispatched ahead of the read result on purpose: an archive never becomes
  // text, and an HTML preview is a stream the browser fetches rather than a
  // string the panel holds. Waiting on `readWorkspaceFile` first would either
  // flash a binary error or buffer a document nobody will read.
  const archive = isWorkspaceArchivePath(content.path)
    ? <WorkspaceArchiveView workspaceDir={content.workspaceDir} path={content.path} />
    : undefined;
  const html = !archive && isWorkspaceHtmlPath(content.path) && workspaceFileUrl
    ? <WorkspaceHtmlPreview path={content.path} fileUrl={workspaceFileUrl({ workspaceDir: content.workspaceDir, path: content.path })} content={result?.content} />
    : undefined;
  return <div className="webui-workspace-file-document" data-testid="workspace-file-preview" data-file-path={content.path}>
      {archive ?? html
        ?? (result?.loading ? <p role="status">正在加载文件…</p>
        : result?.error ? <p role="alert">{result.error}</p>
          : result?.content && isMediaContent(result.content, content.path) ? <WorkspaceMediaPreview path={content.path} content={result.content} fileUrl={workspaceFileUrl?.({ workspaceDir: content.workspaceDir, path: content.path })} />
            : result?.content?.error ? <p role="alert">{result.content.error}</p>
            : result?.content?.type === "binary" ? <p>无法在文本预览中显示二进制文件。</p>
              : result?.content ? previewMarkdown ? <WebuiMarkdown source={text} /> : <pre className="webui-file-code"><code className={language ? `hljs language-${language}` : ""}>{text.split("\n").map((line, index) => {
                const lineNumber = index + 1;
                const highlighted = highlightFileLine(line, language);
                return <span key={lineNumber} id={lineNumber === content.lineStart ? webuiFileLineTargetId(tabId, lineNumber) : undefined} tabIndex={lineNumber === content.lineStart ? -1 : undefined} data-line={lineNumber} data-scroll-target-line={lineNumber === content.lineStart ? "true" : undefined} className={`webui-file-code-line ${lineNumber >= (content.lineStart ?? 0) && lineNumber <= (content.lineEnd ?? content.lineStart ?? 0) ? "webui-file-preview-line-active" : ""}`} data-line-number={lineNumber} {...(highlighted !== undefined ? { dangerouslySetInnerHTML: { __html: highlighted || " " } } : {})}>{highlighted === undefined ? line || " " : undefined}</span>;
              })}</code></pre>
                : <p>文件读取能力暂不可用。</p>)}
  </div>;
}

export function WebuiWorkspacePanel({ state, dispatch, sessionId, workspaceDir, workspaceFileUrl, terminal: terminalOwner, onClose }: {
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
}): ReactElement {
  const [panelWidth, setPanelWidth] = useState<number>();
  const [panelCovering, setPanelCovering] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  const [expansionMotion, setExpansionMotion] = useState<"expanding" | "collapsing">();
  const panelStateRef = useRef(state);
  panelStateRef.current = state;
  const panelClosingRef = useRef(false);
  const pendingPanelClose = useRef<WorkspacePanelCommand | undefined>(undefined);
  const resizeGesture = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number } | undefined>(undefined);
  const { dom } = useWebuiBrowserCapabilities();
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
  const tab = activeTab?.content.kind ?? "files";
  const fileTreeScrollRef = useRef<HTMLDivElement>(null);
  const autoNavigationRequests = useRef(new Set<string>());
  const [fileSearch, setFileSearch] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [fileCodeMode, setFileCodeMode] = useState(false);
  const [reviewSearchQuery, setReviewSearchQuery] = useState("");
  const [terminals, setTerminalsState] = useState<readonly Record<string, unknown>[]>([]);
  /**
   * A terminal list answer is rendered directly (`terminals.find`, `terminals.map`),
   * so a runtime that answers something else must not reach the render: it becomes
   * an empty list.
   */
  const setTerminals = (answer: unknown): void => {
    setTerminalsState(Array.isArray(answer) ? (answer as readonly Record<string, unknown>[]) : []);
  };
  /** Mirror the owner's catalogue into the local render list. */
  const syncTerminalsFromOwner = (owner: WebuiTerminalOwner | undefined): void => {
    setTerminals(owner?.getSnapshot().terminals ?? []);
  };
  /**
   * Whether the roster has been read at least once for the current workspace.
   *
   * Without it the panel paints an empty terminal list on the first render and
   * then swaps in the real one a moment later. On a reload whose sessions already
   * hold PTYs that reads as "all my terminals exited" and offers a create button
   * that would exceed the limit — a flicker that misreports state, in the one
   * moment the user is deciding whether their shells survived.
   */
  const [terminalsReady, setTerminalsReady] = useState(false);
  /**
   * Monotonic read counter. Each roster read takes the next number and only
   * applies if it is still the newest: switching workspaces quickly starts a
   * second read, and the first one resolving late would otherwise overwrite the
   * newer answer with the previous workspace's terminals.
   */
  const rosterRead = useRef(0);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [terminalError, setTerminalError] = useState<string>();
  /**
   * The process half's limit, as the panel needs it.
   *
   * The client could learn the count only by attempting a create and being
   * refused, which reads to the user as a malfunction. The panel knows the rule
   * (`runtime/terminal.ts`), so it says so before the request instead of after
   * it — and it checks the count it already has, so the button explains itself
   * rather than failing.
   */
  const terminalSlotsFull = terminals.length >= DESKTOP_TERMINAL_LIMIT;
  const terminalSupport = terminalOwner?.support().create ?? "absent";
  const terminalAvailability = terminalSupport === "absent" ? "当前服务未提供终端。"
    : terminalSupport === "not-ready" ? "终端服务尚未就绪。"
      : terminalSupport === "incompatible" ? "终端接口与当前页面不兼容，请检查服务版本。" : undefined;
  const terminalCreateDisabled = terminalSlotsFull || !terminalOwner?.canCreate;
  const terminalCreateReason = terminalAvailability ?? (terminalSlotsFull ? DESKTOP_COPY.terminalLimit : undefined);
  const createTerminal = (): void => {
    if (!activeWorkspace || !terminalOwner?.canCreate) return;
    if (terminalSlotsFull) {
      setTerminalError(DESKTOP_COPY.terminalLimit);
      return;
    }
    void terminalOwner
      .create(activeWorkspace)
      .then((created) => {
        if (created) setActiveTerminalId(created.terminalId);
        syncTerminalsFromOwner(terminalOwner);
      })
      .catch((error: unknown) => setTerminalError(error instanceof Error ? error.message : String(error)));
  };
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal>();
  const terminalStop = useRef<(() => void) | undefined>();
  /**
   * The size this pane last told the runtime, so an unchanged measurement is
   * not sent twice. Deliberately NOT reset when the effect re-mounts the
   * terminal: the entry carries its terminal id, and a different terminal
   * cannot match it, so a fresh 80x24 pseudo-terminal still hears about the
   * grid it was fitted to.
   */
  const reportedTerminalSize = useRef<WebuiTerminalSize>();
  const activeWorkspace = activeTab && "workspaceDir" in activeTab.content ? activeTab.content.workspaceDir : workspaceDir;
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
  const visibleFiles = filterWorkspaceFiles(fileTree.files ?? [], fileSearch);
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
  const workspaceReviewFiles = reviewSummary !== undefined && reviewSummary.tabId === activeTab?.id ? reviewSummary.summary?.files ?? [] : [];
  const turnReviewFiles = activeTab?.content.kind === "review" && activeTab.content.source === "turn" ? activeTab.content.files ?? [] : [];
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
  const runReviewSearch = () => {
    if (activeTab?.content.kind !== "review" || activeTab.content.source !== "workspace" || !activeTab.content.reviewSnapshotId || !queries) return;
    void queries.searchReviewDiffs({ tabId: activeTab.id, workspaceDir: activeTab.content.workspaceDir, snapshotId: activeTab.content.reviewSnapshotId, query: reviewSearchQuery });
  };
  const toggleWorkspaceDirectory = (directory: WebuiWorkspaceFile) => {
    const path = directory.path;
    if (expandedDirectories.has(path)) {
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
  };
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
  useEffect(() => {
    if (!terminalOwner) {
      setTerminals([]);
      setTerminalsReady(true);
      return undefined;
    }
    const read = ++rosterRead.current;
    const stop = terminalOwner.subscribe(() => {
      syncTerminalsFromOwner(terminalOwner);
      setTerminalError(terminalOwner.getSnapshot().error);
    });
    // Not ready until the first answer lands, so a reload holding live PTYs does
    // not paint an empty list and invite a create that would exceed the limit.
    setTerminalsReady(false);
    void terminalOwner.refresh().then(() => {
      // A superseded read must not apply: its answer describes a workspace the
      // user has already left.
      if (rosterRead.current !== read) return;
      syncTerminalsFromOwner(terminalOwner);
      setTerminalsReady(true);
    });
    return () => {
      stop();
      // Unmounting invalidates this read for the same reason switching does.
      if (rosterRead.current === read) rosterRead.current += 1;
    };
  }, [terminalOwner, activeTab?.id, activeWorkspace]);
  // A view going away releases its watch and its xterm; it never kills a PTY.
  // Process death is the panel's explicit dispose button or the application's
  // disposal.
  useEffect(() => () => { terminalStop.current?.(); terminalInstance.current?.dispose(); }, []);
  const terminalTargetId = (terminals.find((candidate) => String(candidate.terminalId) === activeTerminalId) ?? terminals[0])?.terminalId;
  useEffect(() => {
    if (!terminalTargetId || !terminalHost.current) return;
    const terminalId = String(terminalTargetId);
    const styles = getComputedStyle(terminalHost.current);
    const terminal = new Terminal({ cols: 80, rows: 24, convertEol: true, theme: { background: styles.getPropertyValue("--bg_default_secondary").trim(), foreground: styles.getPropertyValue("--terminal_foreground").trim(), cursor: styles.getPropertyValue("--terminal_cursor").trim() } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHost.current);
    fit.fit();
    terminalInstance.current = terminal;
    terminalStop.current = terminalOwner?.attach(terminalId, (frame) => { terminal.write(frame.data); if (frame.exited) terminal.options.disableStdin = true; });
    // The fit moves the browser's viewport; this is what tells the runtime. The
    // size is read at send time, so a drag that ends in one place reports that
    // place once instead of replaying every frame of the drag.
    const reportTerminalSize = () => {
      const request = terminalResizeRequest({ terminalId, cols: terminal.cols, rows: terminal.rows, reported: reportedTerminalSize.current });
      if (!request) return;
      reportedTerminalSize.current = request;
      if (terminalOwner?.canResize) void terminalOwner.resize(request);
    };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      fit.fit();
      if (!terminalOwner?.canResize) return;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reportTerminalSize, TERMINAL_RESIZE_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(terminalHost.current);
    const input = terminal.onData((data) => { if (terminalOwner?.canWrite) void terminalOwner.write(terminalId, data); });
    return () => { input.dispose(); observer.disconnect(); if (resizeTimer !== undefined) clearTimeout(resizeTimer); terminalStop.current?.(); terminalStop.current = undefined; terminal.dispose(); terminalInstance.current = undefined; };
    // `terminalOwner` takes its place beside its neighbours rather than being
    // read through a ref: the owner is created once per mount by the binding and
    // its commands are stable, so a panel drag cannot re-run this effect and
    // rebuild a shell that is running.
  }, [terminalTargetId, terminalOwner, tab]);
  // The registry carries the kinds, their words and how each opens. Both the tab
  // glyphs the strip needs and the launcher's tiles live in the strip itself:
  // the new tab page took the place of this panel's add menu, which was the same
  // four kinds behind a dropdown.
  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (state.expanded || event.button !== 0) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    resizeGesture.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: panel.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const parentWidth = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const maxWidth = Math.max(1, parentWidth);
    const minWidth = Math.min(360, maxWidth);
    const requestedWidth = Math.min(maxWidth, Math.max(minWidth, gesture.startWidth - (event.clientX - gesture.startX)));
    setPanelWidth(requestedWidth);
    setPanelCovering(requestedWidth >= parentWidth - 1);
  };
  const stopPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeGesture.current?.pointerId !== event.pointerId) return;
    resizeGesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nudgePanelResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (state.expanded || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    const parentWidth = panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const currentWidth = panel?.getBoundingClientRect().width ?? parentWidth / 2;
    const maxWidth = Math.max(1, parentWidth);
    const requestedWidth = Math.min(maxWidth, Math.max(Math.min(360, maxWidth), currentWidth + (event.key === "ArrowLeft" ? 24 : -24)));
    setPanelWidth(requestedWidth);
    setPanelCovering(requestedWidth >= parentWidth - 1);
  };
  const handlePanelAnimationEnd = (event: ReactAnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.animationName === "webui-workspace-panel-exit") {
      const pendingClose = pendingPanelClose.current;
      pendingPanelClose.current = undefined;
      if (pendingClose) dispatch(pendingClose);
      else if (onClose) onClose();
      else dispatch({ type: "close-panel" });
    }
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
    setExpansionMotion(state.expanded ? "collapsing" : "expanding");
    dispatch({ type: "toggle-expanded" });
  };
  return <aside className={`webui-workspace-panel ${state.expanded ? "is-expanded" : ""} ${panelCovering && !state.expanded ? "is-covering" : ""} ${panelClosing ? "is-closing" : ""} ${expansionMotion ? `is-${expansionMotion}` : ""}`} onAnimationEnd={handlePanelAnimationEnd} style={panelWidth !== undefined && !state.expanded && !panelCovering ? { width: `${panelWidth}px`, flex: `0 0 ${panelWidth}px` } : undefined} data-testid="workspace-panel" data-active-tab={tab}>
    <div className="webui-workspace-panel-resize-handle" role="separator" aria-label="调整工作区面板宽度" aria-orientation="vertical" aria-valuenow={Math.round(panelWidth ?? 50)} tabIndex={state.expanded ? -1 : 0} onPointerDown={startPanelResize} onPointerMove={movePanelResize} onPointerUp={stopPanelResize} onPointerCancel={stopPanelResize} onKeyDown={nudgePanelResize} />
    <div className="webui-workspace-panel-header">
      <div className="webui-workspace-tabs" role="tablist" aria-label="工作区面板标签">
        <WebuiWorkspaceTabStrip state={state} dispatch={panelDispatch} sessionId={sessionId} />
      </div>
      <div className="webui-workspace-panel-actions">
        <button type="button" aria-label={state.expanded ? "收起面板" : "展开面板"} aria-pressed={state.expanded} onClick={toggleExpanded}><WebuiIconWorkspaceExpand expanded={state.expanded} className="size-[18px]" /></button>
        <button type="button" className="webui-workspace-panel-close" aria-label="关闭面板" disabled={panelClosing} onClick={startPanelClosing}><WebuiIconClose className="size-[18px]" /></button>
      </div>
    </div>
    {hasFileWorkspace ? <div className="webui-workspace-file-toolbar">
      <div className="webui-workspace-file-breadcrumb" aria-label="文件路径">
        {activeFilePath ? activeFilePath.split("/").map((part, index) => <span key={`${part}-${index}`} className={index === activeFilePath.split("/").length - 1 ? "is-current" : ""}>{index ? <WebuiIconChevronRight className="size-3" /> : null}{part}</span>) : <span className="is-current">{basenamePath(workspaceDir ?? "") || "工作区"}</span>}
      </div>
      {activeTab?.content.kind === "file-preview" && /\.md$/iu.test(activeTab.content.path) ? <div className="webui-workspace-file-mode" role="group" aria-label="文件显示模式">
        <button type="button" aria-pressed={!fileCodeMode} onClick={() => setFileCodeMode(false)}>预览</button>
        <button type="button" aria-pressed={fileCodeMode} onClick={() => setFileCodeMode(true)}>代码</button>
      </div> : null}
      {activeTab?.content.kind === "file-preview" ? <button type="button" className="webui-workspace-edit-action" aria-label="编辑文件（暂未支持）" title="编辑文件（暂未支持）" disabled><IconEdit aria-hidden="true" className="size-[18px]" size={18} stroke={1.7} /></button> : null}
      <button type="button" className="webui-workspace-tree-toggle" aria-label={fileTreeOpen ? "隐藏文件树" : "显示文件树"} aria-pressed={fileTreeOpen} onClick={() => setFileTreeOpen((open) => !open)}><WebuiIconSidebarToggle className="size-5" /></button>
    </div> : null}
    <div className="webui-workspace-panel-body">
      <div className="webui-workspace-view">
    {tab === "files" ? <div className="webui-workspace-files-empty" data-testid="workspace-files-empty"><WebuiIconFolder className="size-8" /><strong>查看文件</strong><p>从工作区目录树中选择文件</p></div> : null}
    {tab === "file-preview" && activeTab?.content.kind === "file-preview" ? <WebuiFilePreview tabId={activeTab.id} content={activeTab.content} result={fileResults.get(activeFileKey!)} codeMode={fileCodeMode} workspaceFileUrl={workspaceFileUrl} /> : null}
    {tab === "review" && activeTab?.content.kind === "review" && activeTab.content.source === "workspace" ? <div className="webui-turn-review" data-testid="workspace-review">
      {reviewSummary?.tabId !== activeTab.id || reviewSummary.loading && !reviewSummary.summary ? <p className="webui-turn-review-empty" role="status">正在收集变更…</p> : reviewSummary.error && !reviewSummary.summary ? <p className="webui-turn-review-empty" role="alert">{reviewSummary.error}</p> : reviewSummary.summary ? <>
        <div className="webui-turn-review-summary"><span>{reviewSummary.summary.totals.files} 个文件</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{reviewSummary.summary.totals.additions}</span>{reviewSummary.summary.totals.deletions ? <span className="webui-diff-del">-{reviewSummary.summary.totals.deletions}</span> : null}</span></div>
        {reviewSummary.stale || reviewSummary.error ? <p className="webui-workspace-review-status" role="status">变更列表可能已过期{reviewSummary.error ? `：${reviewSummary.error}` : "，正在刷新…"}</p> : null}
        {reviewSummary.summary.files.length ? <>
          <form className="webui-workspace-review-search" onSubmit={(event) => { event.preventDefault(); runReviewSearch(); }}><input aria-label="搜索变更" value={reviewSearchQuery} onChange={(event) => setReviewSearchQuery(event.currentTarget.value)} placeholder="搜索变更" /><button type="submit" disabled={!queries?.canSearchReviewDiffs || reviewSearch?.loading}>搜索</button></form>
          {reviewSearch?.tabId === activeTab.id && reviewSearch.snapshotId === activeReview?.reviewSnapshotId ? reviewSearch.loading ? <p className="webui-workspace-review-status" role="status">正在搜索变更…</p> : reviewSearch.error ? <p className="webui-workspace-review-status" role="alert">{reviewSearch.error}</p> : reviewSearch.result ? <ul className="webui-workspace-review-search-results" data-testid="workspace-review-search-results">{reviewSearch.result.matchedFiles.map((match) => <li key={match.fileId}><button type="button" onClick={() => dispatch({ type: "select-review-file", tabId: activeTab.id, path: match.path })}>{match.path} <small>{match.matchCount}</small></button></li>)}</ul> : null : null}
          {reviewDiffs?.error && reviewDiffs.tabId === activeTab.id && reviewDiffs.snapshotId === activeReview?.reviewSnapshotId ? <p className="webui-workspace-review-status" role="alert">{reviewDiffs.error}</p> : null}
          <div className="webui-turn-review-files">{reviewSummary.summary.files.map((file) => {
            const result = reviewDiffs?.tabId === activeTab.id && reviewDiffs.snapshotId === activeReview?.reviewSnapshotId ? reviewDiffs.diffs[file.fileId] : undefined;
            const loading = !result && (reviewDiffs?.tabId !== activeTab.id || reviewDiffs.snapshotId !== activeReview?.reviewSnapshotId || reviewDiffs.loading);
            return <WebuiDiffFileSection key={file.fileId} file={{ file: file.path, additions: file.additions, deletions: file.deletions, status: file.status, ...(result?.diff !== undefined ? { diff: result.diff } : {}) }} selected={selectedReviewPath === file.path} loading={loading} error={result?.binary ? "二进制文件无法显示文本差异。" : result?.error} onSelect={() => dispatch({ type: "select-review-file", tabId: activeTab.id, path: file.path })} />;
          })}</div>
        </> : <p className="webui-turn-review-empty">当前没有变更。</p>}
      </> : null}
    </div> : null}
    {tab === "review" && activeTab?.content.kind === "review" && activeTab.content.source === "turn" ? <div className="webui-turn-review" data-testid="turn-review-panel" data-session-id={activeTab.content.sessionId} data-message-id={activeTab.content.messageId} data-turn-id={activeTab.content.turnId} data-change-set-id={activeTab.content.changeSetId}>
      <div className="webui-turn-review-summary"><span>本轮改动</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{turnReviewFiles.reduce((sum, file) => sum + file.additions, 0)}</span>{turnReviewFiles.some((file) => file.deletions > 0) ? <span className="webui-diff-del">-{turnReviewFiles.reduce((sum, file) => sum + file.deletions, 0)}</span> : null}</span></div>
      {turnReviewFiles.length ? <div className="webui-turn-review-files">{turnReviewFiles.map((file) => <WebuiDiffFileSection key={file.file} file={file} selected={selectedReviewPath === file.file} />)}</div> : <p className="webui-turn-review-empty">本轮没有可审查的文件差异。</p>}
    </div> : null}
    {tab === "canvas" ? <WorkspaceCanvas sessionId={activeSessionId} /> : null}
    {tab === "web" && activeTab?.content.kind === "web" ? <div className="webui-workspace-web-tab" data-testid="workspace-web-tab" data-tab-id={activeTab.id}>
      <BrowserPanelHost target={activeTab.content.target} url={activeTab.content.url} />
    </div> : null}
    {tab === "launcher" && activeTab?.content.kind === "launcher" ? <WebuiWorkspaceLauncher tab={activeTab} dispatch={panelDispatch} sessionId={sessionId} workspaceDir={workspaceDir} /> : null}
    {tab === "terminal" && terminalAvailability ? <p role="status" data-webui-terminal-availability={terminalSupport}>{terminalAvailability}</p> : null}
    {tab === "terminal" && terminalError && terminals.length === 0 ? <p role="alert">{terminalError}</p> : null}
    {tab === "terminal" ? <div className="webui-terminal-empty">{!terminalsReady ? <><p>{DESKTOP_COPY.terminalLoading}</p></> : terminals.length === 0 ? <><strong>{DESKTOP_COPY.terminalEmptyTitle}</strong><p>{DESKTOP_COPY.terminalEmptyDescription}</p></> : <><div className="webui-terminal-tabs">{terminals.map((terminal, index) => <button type="button" key={String(terminal.terminalId)} className={`file-tab group/tab-close h-8 w-40 min-w-20 ${String(terminal.terminalId) === (activeTerminalId ?? String(terminals[0]?.terminalId)) ? "bg-bg_interaction_tertiary_selected" : ""}`} onClick={() => setActiveTerminalId(String(terminal.terminalId))}><span>#{index + 1}</span>{terminal.status === "exited" ? DESKTOP_COPY.terminalExited : DESKTOP_COPY.terminalLabel}<span className="file-tab-close opacity-0 group-hover/tab-close:opacity-100"><WebuiIconClose className="size-[14px]" /></span></button>)}</div><div ref={terminalHost} className="webui-xterm-host" />{terminalError ? <p role="alert">{terminalError}</p> : null}<div className="webui-terminal-actions"><button type="button" disabled={terminalCreateDisabled} title={terminalCreateReason} onClick={createTerminal}>{DESKTOP_COPY.newTerminal}</button><button type="button" onClick={() => { const active = terminals.find((candidate) => String(candidate.terminalId) === (activeTerminalId ?? String(terminals[0]?.terminalId))); if (active && terminalOwner?.canDispose) void terminalOwner.disposeProcess(String(active.terminalId)).then(() => syncTerminalsFromOwner(terminalOwner)); }}>{DESKTOP_COPY.fileClose}</button></div></> }{terminalsReady && terminals.length === 0 ? <button type="button" disabled={terminalCreateDisabled} title={terminalCreateReason} onClick={createTerminal}>{DESKTOP_COPY.newTerminal}</button> : null}</div> : null}
      </div>
      {hasFileWorkspace && fileTreeOpen ? <aside className="webui-workspace-file-tree-panel" aria-label="工作区文件树">
        <label className="webui-workspace-file-search"><WebuiIconSearch className="size-4" /><input aria-label="搜索文件" placeholder="搜索" value={fileSearch} onChange={(event) => setFileSearch(event.currentTarget.value)} /></label>
        <div className="webui-workspace-file-tree-scroll" ref={fileTreeScrollRef}>
          {fileTree.workspaceDir !== activeWorkspace || fileTree.loading ? <p role="status">正在加载文件…</p> : fileTree.error ? <p role="alert">{fileTree.error}</p> : fileTree.files.length ? visibleFiles.length ? <FileTree files={visibleFiles} expandedPaths={expandedDirectories} loadingPaths={fileTree.loadingDirectories} directoryErrors={fileTree.directoryErrors} onToggle={toggleWorkspaceDirectory} selectedPath={activeTab?.content.kind === "file-preview" ? selectedFilePath : activeTab?.content.kind === "review" ? selectedReviewPath : undefined} onOpen={(entry) => { const context = activeTab && "sessionId" in activeTab.content ? activeTab.content.sessionId : sessionId; if (!activeWorkspace || !context || entry.type === "directory") return; if (activeTab?.content.kind === "review" && activeTab.content.source === "turn" && turnReviewFiles.some((file) => file.file === entry.path) || activeTab?.content.kind === "review" && activeTab.content.source === "workspace" && workspaceReviewFiles.some((file) => file.path === entry.path)) dispatch({ type: "select-review-file", tabId: activeTab.id, path: entry.path }); else dispatch({ type: "open-file", sessionId: context, workspaceDir: activeWorkspace, path: entry.path }); }} /> : <p className="webui-workspace-tree-empty">没有匹配的文件。</p> : <p className="webui-workspace-tree-empty">此工作区没有可显示的文件。</p>}
        </div>
      </aside> : null}
    </div>
  </aside>;
}
