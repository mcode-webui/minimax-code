import { useEffect, useRef, useState, type ReactElement } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
import { WebuiMarkdown } from "../markdown.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";
import type { WebuiFileDiffInfoView } from "../../shared/contracts/session.js";
import type {
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import type { WorkspacePanelCommand, WorkspacePanelState, WorkspacePanelTab } from "../projection/workspace-panel-state.js";
import { focusWebuiFileLine, webuiFileLineTargetId } from "../bindings/browser-effects.js";
import {
  projectWebuiWorkspaceHistory,
  type WebuiWorkspaceSubagent,
  type WebuiWorkspaceTodo,
} from "../projection/workspace-progress.js";
import { WebuiIconAgent, WebuiIconCheck, WebuiIconChevronDown, WebuiIconClose, WebuiIconDiffFile, WebuiIconFile, WebuiIconFolder, WebuiIconRunLocation, WebuiIconSearch, WebuiIconSidebarToggle, WebuiIconWorkspaceCanvas, WebuiIconWorkspaceExpand, WebuiIconWorkspaceReview, WebuiIconWorkspaceTerminal } from "../icons.js";
import { FileTree, filterWorkspaceFiles, findWorkspaceFile, getWorkspaceFileParentPaths, mergeWorkspaceFileChildren } from "./WorkspaceFileTree.js";
import { WorkspaceMediaPreview, isMediaContent } from "./WorkspaceMediaPreview.js";
import { WorkspaceCanvas } from "./WorkspaceCanvas.js";
import type { CanvasOperation } from "./WorkspaceCanvas.js";
import { WorkspaceArchiveView } from "./WorkspaceArchiveView.js";
import { WorkspaceHtmlPreview } from "./WorkspaceHtmlPreview.js";
import {
  WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE,
  chunkWebuiWorkspaceReviewFileIds,
  type WebuiWorkspaceQueries,
} from "../application/workspace-queries.js";
import {
  useWebuiWorkspaceQueries,
  useWebuiWorkspaceQueriesState,
} from "../bindings/use-query-state.js";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";

export type WebuiTodo = WebuiWorkspaceTodo;
// `mergeWorkspaceFileChildren`, `chunkWebuiWorkspaceReviewFileIds` and
// `WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE` are re-exported below: the panel
// tests import them from this module, which stays the panel's public surface.
// The implementations moved to `projection/workspace-file-tree.ts` and
// `application/workspace-queries.ts`.
export {
  mergeWorkspaceFileChildren,
  chunkWebuiWorkspaceReviewFileIds,
  WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE,
};
const DESKTOP_COPY = { environment: "环境信息", progress: "进度", progressEmpty: "跟踪较长任务的进度", newTerminal: "新建终端", terminalLimit: "最多可以打开 5 个终端", terminalLabel: "终端", terminalExited: "已退出", terminalEmptyTitle: "还没有终端", terminalEmptyDescription: "可直接在右侧面板中启动当前工作区的 Shell。", fileClose: "关闭", changes: "变更", commit: "提交或推送", openTerminal: "打开终端", unsupported: "WebUI 尚未接入此操作" } as const;

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

const FILE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: "c", cjs: "javascript", cpp: "cpp", css: "css", go: "go", h: "c", htm: "xml", html: "xml", java: "java",
  js: "javascript", json: "json", jsx: "javascript", md: "markdown", mjs: "javascript", mts: "typescript",
  py: "python", rs: "rust", sh: "bash", svg: "xml", toml: "toml", ts: "typescript", tsx: "typescript", xml: "xml", yaml: "yaml", yml: "yaml",
};

export function webuiFileLanguage(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const language = extension ? FILE_LANGUAGE_BY_EXTENSION[extension] : undefined;
  return language && hljs.getLanguage(language) ? language : undefined;
}

function highlightFileLine(line: string, language: string | undefined): string | undefined {
  if (!language || !hljs.getLanguage(language)) return undefined;
  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

export type WebuiUnifiedDiffLine = {
  readonly kind: "addition" | "context" | "deletion" | "hunk";
  readonly content: string;
  readonly oldLine?: number;
  readonly newLine?: number;
};

export function projectWebuiUnifiedDiffLines(diff: string): WebuiUnifiedDiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const lines: WebuiUnifiedDiffLine[] = [];
  for (const raw of diff.split(/\r?\n/u)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", content: raw });
      continue;
    }
    if (!raw || raw.startsWith("diff --git ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "addition", ...(newLine === undefined ? {} : { newLine: newLine++ }), content: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "deletion", ...(oldLine === undefined ? {} : { oldLine: oldLine++ }), content: raw.slice(1) });
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      lines.push({ kind: "context", ...(oldLine === undefined ? {} : { oldLine: oldLine++ }), ...(newLine === undefined ? {} : { newLine: newLine++ }), content });
    }
  }
  return lines;
}

export function WebuiDiffFileSection({ file, selected, loading = false, error, onSelect }: { readonly file: WebuiFileDiffInfoView; readonly selected: boolean; readonly loading?: boolean; readonly error?: string; readonly onSelect?: () => void }): ReactElement {
  const diff = typeof file.diff === "string" ? file.diff : "";
  const lines = projectWebuiUnifiedDiffLines(diff);
  const language = webuiFileLanguage(file.file);
  return <details className="webui-turn-review-file" open data-testid="turn-review-diff-file">
    <summary className="webui-turn-review-file-heading" aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className="webui-diff-file-icon"><WebuiIconDiffFile fileName={file.file} /></span>
      <span className="webui-turn-review-file-path" title={file.file}>{file.file}</span>
      <span className="webui-diff-add">+{file.additions}</span>
      {file.deletions > 0 ? <span className="webui-diff-del">-{file.deletions}</span> : null}
    </summary>
    {loading ? <p className="webui-turn-review-unavailable" role="status">正在加载差异…</p> : error ? <p className="webui-turn-review-unavailable" role="alert">{error}</p> : lines.length ? <pre className="webui-file-code webui-turn-review-code"><code className={language ? `hljs language-${language}` : ""}>{lines.map((line, index) => {
      const highlighted = line.kind === "hunk" ? undefined : highlightFileLine(line.content, language);
      return <span className={`webui-turn-review-line webui-turn-review-line--${line.kind}`} key={`${index}-${line.kind}`}>
        {line.kind === "hunk" ? <span className="webui-turn-review-hunk">{line.content}</span> : <>
          <span className="webui-turn-review-line-number">{line.oldLine ?? ""}</span>
          <span className="webui-turn-review-line-number">{line.newLine ?? ""}</span>
          <span className="webui-turn-review-marker">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
          <span className="webui-turn-review-source">{highlighted === undefined ? line.content : <span dangerouslySetInnerHTML={{ __html: highlighted }} />}</span>
        </>}
      </span>;
    })}</code></pre> : <p className="webui-turn-review-unavailable">当前运行时没有提供该文件的文本 patch。</p>}
  </details>;
}

export function projectWebuiTodos(messages: readonly Record<string, unknown>[]): WebuiTodo[] {
  return projectWebuiWorkspaceHistory(
    messages as never,
  ).todos as WebuiTodo[];
}

export function WebuiProgressPanel({ todos, showProgress = true, showEmptyProgress = true, collapsed = false, onToggle }: { readonly todos: readonly WebuiTodo[]; readonly showProgress?: boolean; readonly showEmptyProgress?: boolean; readonly collapsed?: boolean; readonly onToggle?: () => void }): ReactElement | null {
  if (!showProgress || (!showEmptyProgress && todos.length === 0)) return null;
  return <div className="flex shrink-0 flex-col" data-webui-progress-panel="true" data-workspace-section="true">
    <div className="group/card flex shrink-0 flex-col overflow-hidden">
      <div className="flex flex-col">
        <button type="button" className="webui-workspace-section-title flex h-7 w-full cursor-pointer items-center justify-between border-none bg-transparent pl-1.5 pr-1.5 text-sm text-text_default_secondary" onClick={onToggle} aria-expanded={!collapsed}>
          <span className="min-w-0 flex-1 truncate text-left font-normal leading-5" data-workspace-section-title="true">{DESKTOP_COPY.progress}</span><WebuiIconChevronDown className={collapsed ? "size-4 -rotate-90 text-icon_default_tertiary transition-transform duration-[180ms] ease-out" : "size-4 text-icon_default_tertiary transition-transform duration-[180ms] ease-out"} />
        </button>
      </div>
      <div className={`grid transition-[grid-template-rows,opacity] duration-[180ms] ease-out ${collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`} aria-hidden={collapsed}>
        <div className="min-h-0 overflow-hidden">
          {todos.length === 0 ? <p className="webui-progress-empty">{DESKTOP_COPY.progressEmpty}</p> : todos.map((todo, index) => <div className={`webui-progress-row webui-progress-row--${todo.status}`} key={`${todo.content}-${index}`}>
            <span className="webui-progress-marker">{todo.status === "completed" ? <WebuiIconCheck className="size-3" /> : index + 1}</span>
            <span className={`min-w-0 flex-1 truncate ${todo.status === "completed" ? "line-through text-text_default_tertiary" : ""}`}>{todo.content}</span>
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}

export function WebuiSubagentsPanel({ subagents, collapsed = false, onToggle, onMemberClick }: {
  readonly subagents: readonly WebuiWorkspaceSubagent[];
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly onMemberClick?: (subagent: WebuiWorkspaceSubagent) => void;
}): ReactElement | null {
  if (subagents.length === 0) return null;
  return <div className="webui-subagents-panel" data-webui-subagents-panel="true" data-workspace-section="true">
    <button type="button" className="webui-workspace-section-title" onClick={onToggle} aria-expanded={!collapsed}>
      <span data-workspace-section-title="true">Subagents</span>
      <WebuiIconChevronDown className={collapsed ? "size-4 -rotate-90 text-icon_default_tertiary transition-transform duration-[180ms] ease-out" : "size-4 text-icon_default_tertiary transition-transform duration-[180ms] ease-out"} />
    </button>
    <div className={`grid transition-[grid-template-rows,opacity] duration-[180ms] ease-out ${collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`} aria-hidden={collapsed}>
      <div className="min-h-0 overflow-hidden">
        {subagents.map((subagent) => {
          const label = subagent.title?.trim() || subagent.agentName;
          return <button type="button" className="webui-subagent-row" key={subagent.sessionId} onClick={() => onMemberClick?.(subagent)}>
            <WebuiIconAgent className="webui-subagent-avatar" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <span className={`webui-subagent-status webui-subagent-status--${subagent.status}`} aria-label={subagent.status}>
              {subagent.status === "completed" ? <WebuiIconCheck className="size-3" /> : subagent.status === "error" ? "!" : "·"}
            </span>
          </button>;
        })}
      </div>
    </div>
  </div>;
}

function WorkspaceCommitDialog({ environment, workspaceDir, mutateGit, onClose }: {
  readonly environment: WebuiWorkspaceEnvironment;
  readonly workspaceDir: string;
  readonly mutateGit: (request: WebuiWorkspaceGitMutationRequest) => Promise<Record<string, unknown>>;
  readonly onClose: () => void;
}): ReactElement {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hasChanges = environment.changedFiles > 0;
  const submit = (action: "commit" | "commitAndPush" | "push") => {
    if (action !== "push" && !message.trim()) return;
    setBusy(true);
    setError(undefined);
    // The mutation runs through the query owner, which invalidates exactly the
    // environment and review views for this workspace on completion.
    void mutateGit({ workspaceDir, action, ...(message.trim() ? { message: message.trim() } : {}) })
      .then(() => { onClose(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  return <div className="webui-commit-dialog" role="dialog" aria-modal="true" aria-label={DESKTOP_COPY.commit}>
    <div className="webui-commit-dialog-header"><strong>{DESKTOP_COPY.commit}</strong><button type="button" aria-label={DESKTOP_COPY.fileClose} onClick={onClose}><WebuiIconClose className="size-4" /></button></div>
    {hasChanges ? <label className="webui-commit-dialog-label"><span>提交说明</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入提交说明" autoFocus /></label> : <p className="webui-commit-dialog-hint">当前没有未提交变更，将推送当前分支。</p>}
    {error ? <p className="webui-commit-dialog-error" role="alert">{error}</p> : null}
    <div className="webui-commit-dialog-actions">
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      {hasChanges ? <button type="button" onClick={() => submit("commit")} disabled={busy || !message.trim()}>提交</button> : null}
      <button type="button" onClick={() => submit(hasChanges ? "commitAndPush" : "push")} disabled={busy || (hasChanges && !message.trim())}>{hasChanges ? "提交并推送" : "推送"}</button>
    </div>
  </div>;
}

export function WebuiEnvironmentPanel({ workspaceDir, isDefaultWorkspace = false, workspaceEnvironment, queries: queriesProp, collapsed = false, onToggle, onOpenChanges, onOpenTerminal }: {
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly workspaceEnvironment?: WebuiWorkspaceEnvironment;
  /** Injected in tests; defaults to the provided query owner. */
  readonly queries?: WebuiWorkspaceQueries;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly onOpenChanges?: () => void;
  readonly onOpenTerminal?: () => void;
}): ReactElement | null {
  const contextQueries = useWebuiWorkspaceQueries();
  const queries = queriesProp ?? contextQueries;
  const queryState = useWebuiWorkspaceQueriesState();
  const [commitOpen, setCommitOpen] = useState(false);
  const environmentRevision = queryState.environmentRevision;
  const ownerEnvironment = queryState.environment.workspaceDir === workspaceDir ? queryState.environment.environment : undefined;
  const environment = workspaceEnvironment ?? ownerEnvironment;
  useEffect(() => {
    if (workspaceEnvironment) return;
    if (!workspaceDir || isDefaultWorkspace || !queries?.canReadEnvironment) return;
    // `environmentRevision` re-runs the load when the owner invalidates this
    // workspace's environment (a commit or a git-changed signal).
    queries.loadEnvironment(workspaceDir);
  }, [queries, workspaceDir, isDefaultWorkspace, workspaceEnvironment, environmentRevision]);
  if (!workspaceDir || isDefaultWorkspace || (!queries?.canReadEnvironment && !workspaceEnvironment) || !environment?.isGitRepo) return null;
  const hasChanges = environment.changedFiles > 0;
  const canMutate = Boolean(queries?.canMutateGit && !environment.changesError && !environment.metadataError && (hasChanges || environment.canPush));
  const hasLineChanges = environment.lineStatsStatus === "ready" && (environment.insertions > 0 || environment.deletions > 0);
  return <>
    <div className="webui-environment-panel" data-webui-environment-panel="true" data-workspace-section="true">
      <button type="button" className="webui-workspace-section-title" onClick={onToggle} aria-expanded={!collapsed}>
        <span data-workspace-section-title="true">{DESKTOP_COPY.environment}</span>
        <WebuiIconChevronDown className={collapsed ? "size-4 -rotate-90 text-icon_default_tertiary transition-transform duration-[180ms] ease-out" : "size-4 text-icon_default_tertiary transition-transform duration-[180ms] ease-out"} />
      </button>
      <div className={`webui-environment-body transition-[max-height,opacity] duration-[180ms] ease-out ${collapsed ? "max-h-0 overflow-hidden opacity-0" : "max-h-64 opacity-100"}`} aria-hidden={collapsed}>
        <div className="webui-environment-workspace" title={workspaceDir}>{environment.branch || " "}</div>
        <div className="webui-environment-actions">
          <button type="button" className="webui-environment-action" onClick={onOpenChanges} disabled={!onOpenChanges} title={environment.changesError ?? undefined}>
            <WebuiIconRunLocation className="size-5" /><span>{DESKTOP_COPY.changes}</span>{hasLineChanges ? <small aria-label={`新增 ${environment.insertions} 行，删除 ${environment.deletions} 行`}><span className="webui-diff-additions">+{environment.insertions}</span><span className="webui-diff-deletions">-{environment.deletions}</span></small> : null}
          </button>
          <button type="button" className="webui-environment-action" onClick={() => setCommitOpen(true)} disabled={!canMutate} title={!queries?.canMutateGit ? DESKTOP_COPY.unsupported : environment.metadataError ?? environment.changesError}>
            <WebuiIconFile className="size-5" /><span>{DESKTOP_COPY.commit}</span>
          </button>
          <button type="button" className="webui-environment-action" onClick={onOpenTerminal} disabled={!onOpenTerminal}>
            <WebuiIconRunLocation className="size-5" /><span>{DESKTOP_COPY.openTerminal}</span>
          </button>
        </div>
      </div>
    </div>
    {commitOpen && queries?.canMutateGit ? <WorkspaceCommitDialog environment={environment} workspaceDir={workspaceDir} mutateGit={queries.mutateGit} onClose={() => setCommitOpen(false)} /> : null}
  </>;
}

export function WebuiWorkspacePanelControls({ filePanelOpen, progressPanelOpen, onOpenFiles, onToggleProgressPanel }: { readonly filePanelOpen: boolean; readonly progressPanelOpen: boolean; readonly onOpenFiles: () => void; readonly onToggleProgressPanel: () => void }): ReactElement {
  return <div className="webui-workspace-panel-controls" data-testid="workspace-panel-controls">
    <button type="button" className={`webui-workspace-icon-button ${filePanelOpen ? "is-active" : ""}`} aria-label="工作区文件侧栏" title="工作区文件侧栏" aria-pressed={filePanelOpen} onClick={onOpenFiles}><WebuiIconFolder className="size-5" /></button>
    <button type="button" className={`webui-workspace-icon-button ${progressPanelOpen ? "is-active" : ""}`} aria-label="环境信息与进度" title="环境信息与进度" aria-pressed={progressPanelOpen} onClick={onToggleProgressPanel}><WebuiIconSidebarToggle className="size-5" /></button>
  </div>;
}

export function WebuiProgressOverviewPanel({ workspaceDir, isDefaultWorkspace = false, workspaceEnvironment, todos, subagents = [], showProgress = true, showEmptyProgress = true, environmentCollapsed = false, progressCollapsed = false, subagentsCollapsed = false, onToggleEnvironment, onToggleProgress, onToggleSubagents, onMemberClick, onOpenChanges, onOpenTerminal }: { readonly workspaceDir?: string; readonly isDefaultWorkspace?: boolean; readonly workspaceEnvironment?: WebuiWorkspaceEnvironment; readonly todos: readonly WebuiTodo[]; readonly subagents?: readonly WebuiWorkspaceSubagent[]; readonly showProgress?: boolean; readonly showEmptyProgress?: boolean; readonly environmentCollapsed?: boolean; readonly progressCollapsed?: boolean; readonly subagentsCollapsed?: boolean; readonly onToggleEnvironment?: () => void; readonly onToggleProgress?: () => void; readonly onToggleSubagents?: () => void; readonly onMemberClick?: (subagent: WebuiWorkspaceSubagent) => void; readonly onOpenChanges?: () => void; readonly onOpenTerminal?: () => void }): ReactElement {
  return <div className="webui-progress-overview-card" data-testid="progress-overview-card">
    <WebuiEnvironmentPanel workspaceDir={workspaceDir} isDefaultWorkspace={isDefaultWorkspace} workspaceEnvironment={workspaceEnvironment} collapsed={environmentCollapsed} onToggle={onToggleEnvironment} onOpenChanges={onOpenChanges} onOpenTerminal={onOpenTerminal} />
    <WebuiProgressPanel todos={todos} showProgress={showProgress} showEmptyProgress={showEmptyProgress} collapsed={progressCollapsed} onToggle={onToggleProgress} />
    <WebuiSubagentsPanel subagents={subagents} collapsed={subagentsCollapsed} onToggle={onToggleSubagents} onMemberClick={onMemberClick} />
  </div>;
}

const WORKSPACE_ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar"] as const;
const WORKSPACE_HTML_EXTENSIONS = [".html", ".htm"] as const;

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

export function isWorkspaceArchivePath(path: string): boolean {
  return hasExtension(path, WORKSPACE_ARCHIVE_EXTENSIONS);
}

export function isWorkspaceHtmlPath(path: string): boolean {
  return hasExtension(path, WORKSPACE_HTML_EXTENSIONS);
}

export function WebuiFilePreview({ tab, result, codeMode, workspaceFileUrl, readWorkspaceArchive, extractWorkspaceArchive }: {
  readonly tab: Extract<WorkspacePanelTab, { readonly kind: "file-preview" }>;
  readonly result?: { readonly loading: boolean; readonly content?: WebuiWorkspaceFileContent; readonly error?: string };
  readonly codeMode: boolean;
  readonly workspaceFileUrl?: (request: { readonly workspaceDir: string; readonly path: string }) => string;
  readonly readWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveListing>;
  readonly extractWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly destination: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveExtractResult>;
}): ReactElement {
  const previewMarkdown = /\.md$/iu.test(tab.path) && !codeMode;
  const content = result?.content?.content ?? "";
  const language = webuiFileLanguage(tab.path);
  // Dispatched ahead of the read result on purpose: an archive never becomes
  // text, and an HTML preview is a stream the browser fetches rather than a
  // string the panel holds. Waiting on `readWorkspaceFile` first would either
  // flash a binary error or buffer a document nobody will read.
  const archive = isWorkspaceArchivePath(tab.path)
    ? <WorkspaceArchiveView workspaceDir={tab.workspaceDir} path={tab.path} readWorkspaceArchive={readWorkspaceArchive} extractWorkspaceArchive={extractWorkspaceArchive} />
    : undefined;
  const html = !archive && isWorkspaceHtmlPath(tab.path) && workspaceFileUrl
    ? <WorkspaceHtmlPreview path={tab.path} fileUrl={workspaceFileUrl({ workspaceDir: tab.workspaceDir, path: tab.path })} content={result?.content} />
    : undefined;
  return <div className="webui-workspace-file-document" data-testid="workspace-file-preview" data-file-path={tab.path}>
      {archive ?? html
        ?? (result?.loading ? <p role="status">正在加载文件…</p>
        : result?.error ? <p role="alert">{result.error}</p>
          : result?.content && isMediaContent(result.content, tab.path) ? <WorkspaceMediaPreview path={tab.path} content={result.content} fileUrl={workspaceFileUrl?.({ workspaceDir: tab.workspaceDir, path: tab.path })} />
            : result?.content?.error ? <p role="alert">{result.content.error}</p>
            : result?.content?.type === "binary" ? <p>无法在文本预览中显示二进制文件。</p>
              : result?.content ? previewMarkdown ? <WebuiMarkdown source={content} /> : <pre className="webui-file-code"><code className={language ? `hljs language-${language}` : ""}>{content.split("\n").map((line, index) => {
                const lineNumber = index + 1;
                const highlighted = highlightFileLine(line, language);
                return <span key={lineNumber} id={lineNumber === tab.lineStart ? webuiFileLineTargetId(tab.id, lineNumber) : undefined} tabIndex={lineNumber === tab.lineStart ? -1 : undefined} data-line={lineNumber} data-scroll-target-line={lineNumber === tab.lineStart ? "true" : undefined} className={`webui-file-code-line ${lineNumber >= (tab.lineStart ?? 0) && lineNumber <= (tab.lineEnd ?? tab.lineStart ?? 0) ? "webui-file-preview-line-active" : ""}`} data-line-number={lineNumber} {...(highlighted !== undefined ? { dangerouslySetInnerHTML: { __html: highlighted || " " } } : {})}>{highlighted === undefined ? line || " " : undefined}</span>;
              })}</code></pre>
                : <p>文件读取能力暂不可用。</p>)}
  </div>;
}

export function WebuiWorkspacePanel({ state, dispatch, sessionId, workspaceDir, workspaceFileUrl, readWorkspaceArchive, extractWorkspaceArchive, readCanvas, applyCanvas, createTerminal, listTerminals, writeTerminal, disposeTerminal, watchTerminal, onClose }: {
  readonly state: WorkspacePanelState;
  readonly dispatch: (command: WorkspacePanelCommand) => void;
  readonly sessionId?: string; readonly workspaceDir?: string;
  readonly workspaceFileUrl?: (request: { readonly workspaceDir: string; readonly path: string }) => string;
  readonly readWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveListing>;
  readonly extractWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly destination: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveExtractResult>;
  readonly readCanvas?: (request: { sessionId: string }) => Promise<WebuiCanvasDocument>;
  // The canvas builds its own operation objects, so the panel adopts the
  // component's operation type rather than restating it: one definition, and
  // a drift between the two would only surface as a call the runtime rejects.
  readonly applyCanvas?: (request: { sessionId: string; operation: CanvasOperation }) => Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
  readonly createTerminal?: (request: { workspaceDir: string }) => Promise<{ terminalId: string; status: string }>;
  readonly listTerminals?: () => Promise<readonly Record<string, unknown>[]>;
  readonly writeTerminal?: (request: { terminalId: string; data: string }) => Promise<unknown>;
  readonly disposeTerminal?: (request: { terminalId: string }) => Promise<unknown>;
  readonly watchTerminal?: (request: { terminalId: string }, onFrame: (frame: { terminalId: string; data: string; exited: boolean }) => void) => () => void;
  readonly onClose?: () => void;
}): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  // Query truth lives in the owner; this component reads its snapshot and
  // submits query commands. Display state — active tab, expansion, search box,
  // code mode — stays here (ticket #51).
  const queries = useWebuiWorkspaceQueries();
  const queryState = useWebuiWorkspaceQueriesState();
  const fileTree = queryState.fileTree;
  const fileResults = queryState.files;
  const reviewSummary = queryState.reviewSummary;
  const reviewDiffs = queryState.reviewDiffs;
  const reviewSearch = queryState.reviewSearch;
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const tab = activeTab?.kind ?? "files";
  const tabListRef = useRef<HTMLDivElement>(null);
  const fileTreeScrollRef = useRef<HTMLDivElement>(null);
  const autoNavigationRequests = useRef(new Set<string>());
  const [fileSearch, setFileSearch] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [fileCodeMode, setFileCodeMode] = useState(false);
  const [reviewSearchQuery, setReviewSearchQuery] = useState("");
  const [terminals, setTerminals] = useState<readonly Record<string, unknown>[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [terminalError, setTerminalError] = useState<string>();
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal>();
  const terminalStop = useRef<(() => void) | undefined>();
  const activeWorkspace = activeTab && "workspaceDir" in activeTab ? activeTab.workspaceDir : workspaceDir;
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const activeFileResult = activeTab?.kind === "file-preview" ? fileResults.get(activeTab.id)?.content : undefined;
  const selectedFilePath = activeTab?.kind === "file-preview" ? activeFileResult?.resolvedPath ?? activeTab.path : undefined;
  const hasFileWorkspace = tab === "files" || activeTab?.kind === "file-preview" || activeTab?.kind === "review";
  const visibleFiles = filterWorkspaceFiles(fileTree.files, fileSearch);
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
    setFileCodeMode(activeTab?.kind === "file-preview" && activeTab.lineStart !== undefined);
  }, [activeTab?.id]);
  useEffect(() => {
    tabListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab?.id]);
  useEffect(() => {
    if (!activeWorkspace) return;
    queries?.loadFileTree(activeWorkspace);
  }, [activeWorkspace, queries]);
  useEffect(() => {
    if (activeTab?.kind !== "file-preview" || !queries) return undefined;
    // A tab opened with inline content (the session's plan file) has nothing
    // to read: `readWorkspaceFile` would reject the path anyway, since the
    // artifacts directory is outside the workspace root.
    if (activeTab.content !== undefined) {
      queries.setInlineFile(activeTab.id, activeTab.content, activeTab.path);
      return undefined;
    }
    queries.readFile(activeTab.id, activeTab.workspaceDir, activeTab.path);
    return undefined;
  }, [activeTab?.id, queries]);
  useEffect(() => {
    if (activeTab?.kind !== "file-preview" || activeTab.lineStart === undefined || fileResults.get(activeTab.id)?.loading || !fileResults.get(activeTab.id)?.content || fileResults.get(activeTab.id)?.error) return;
    const target = dom.getElementById(webuiFileLineTargetId(activeTab.id, activeTab.lineStart));
    if (target) focusWebuiFileLine(target);
  }, [activeTab?.id, activeTab?.kind === "file-preview" ? activeTab.lineStart : undefined, dom, fileResults]);
  useEffect(() => {
    if (activeTab?.kind !== "review" || activeTab.source !== "workspace" || !queries) return undefined;
    void queries.loadReviewSummary(activeTab.id, activeTab.workspaceDir).then((summary) => {
      if (summary) dispatch({ type: "set-review-snapshot", tabId: activeTab.id, reviewSnapshotId: summary.reviewSnapshotId });
    });
    return undefined;
  }, [activeTab?.id, activeTab?.kind === "review" && activeTab.source === "workspace" ? activeTab.workspaceDir : undefined, queries, queryState.reviewRevision]);
  const workspaceReviewSelectedPath = activeTab?.kind === "review" && activeTab.source === "workspace" ? activeTab.selectedPath : undefined;
  const workspaceReviewFiles = reviewSummary !== undefined && reviewSummary.tabId === activeTab?.id ? reviewSummary.summary?.files ?? [] : [];
  const turnReviewFiles = activeTab?.kind === "review" && activeTab.source === "turn" ? activeTab.files ?? [] : [];
  const selectedReviewPath = activeTab?.kind === "review" && activeTab.source === "workspace"
    ? workspaceReviewFiles.some((file) => file.path === workspaceReviewSelectedPath) ? workspaceReviewSelectedPath : workspaceReviewFiles[0]?.path
    : activeTab?.kind === "review" && activeTab.source === "turn" ? activeTab.selectedPath ?? turnReviewFiles[0]?.file : undefined;
  useEffect(() => {
    if (activeTab?.kind !== "review" || activeTab.source !== "workspace" || !selectedReviewPath || selectedReviewPath === activeTab.selectedPath) return;
    dispatch({ type: "select-review-file", tabId: activeTab.id, path: selectedReviewPath });
  }, [activeTab?.id, activeTab?.kind === "review" && activeTab.source === "workspace" ? activeTab.selectedPath : undefined, selectedReviewPath, dispatch]);
  useEffect(() => {
    const summary = reviewSummary && reviewSummary.tabId === activeTab?.id ? reviewSummary.summary : undefined;
    if (activeTab?.kind !== "review" || activeTab.source !== "workspace" || !summary || !activeTab.reviewSnapshotId || summary.reviewSnapshotId !== activeTab.reviewSnapshotId || !queries) return undefined;
    void queries.loadReviewDiffs({ tabId: activeTab.id, workspaceDir: activeTab.workspaceDir, snapshotId: activeTab.reviewSnapshotId, fileIds: summary.files.map((file) => file.fileId) });
    return undefined;
  }, [activeTab?.id, activeTab?.kind === "review" && activeTab.source === "workspace" ? activeTab.reviewSnapshotId : undefined, activeTab?.kind === "review" && activeTab.source === "workspace" ? activeTab.workspaceDir : undefined, reviewSummary?.summary?.reviewSnapshotId, queries]);
  const runReviewSearch = () => {
    if (activeTab?.kind !== "review" || activeTab.source !== "workspace" || !activeTab.reviewSnapshotId || !queries) return;
    void queries.searchReviewDiffs({ tabId: activeTab.id, workspaceDir: activeTab.workspaceDir, snapshotId: activeTab.reviewSnapshotId, query: reviewSearchQuery });
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
    if (activeTab?.kind !== "file-preview" || !selectedFilePath || !activeWorkspace || !queries || fileTree.workspaceDir !== activeWorkspace || fileTree.loading) return;
    let cancelled = false;
    const isCurrentFile = () => {
      const currentTab = currentPanelState.current.tabs.find((candidate) => candidate.id === currentPanelState.current.activeTabId);
      return activeWorkspaceRef.current === activeWorkspace
        && currentTab?.kind === "file-preview"
        && currentTab.id === activeTab.id
        && (filesRef.current.get(currentTab.id)?.content?.resolvedPath ?? currentTab.path) === selectedFilePath;
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
  }, [activeTab?.id, activeTab?.kind === "file-preview" ? activeTab.path : undefined, selectedFilePath, activeWorkspace, fileTree.workspaceDir, fileTree.loading, queries]);
  useEffect(() => {
    fileTreeScrollRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedFilePath, selectedReviewPath, expandedDirectories, visibleFiles]);
  const activeSessionId = activeTab && "sessionId" in activeTab ? activeTab.sessionId : sessionId;
  useEffect(() => {
    if (!listTerminals) return undefined;
    let cancelled = false;
    void listTerminals().then((next) => { if (!cancelled) setTerminals(next); }).catch(() => { if (!cancelled) setTerminals([]); });
    return () => { cancelled = true; };
  }, [listTerminals, activeTab?.id, activeWorkspace]);
  useEffect(() => () => { terminalStop.current?.(); terminalInstance.current?.dispose(); }, []);
  useEffect(() => {
    const active = terminals.find((candidate) => String(candidate.terminalId) === activeTerminalId) ?? terminals[0];
    if (!active || !terminalHost.current) return;
    const styles = getComputedStyle(terminalHost.current);
    const terminal = new Terminal({ cols: 80, rows: 24, convertEol: true, theme: { background: styles.getPropertyValue("--bg_default_secondary").trim(), foreground: styles.getPropertyValue("--terminal_foreground").trim(), cursor: styles.getPropertyValue("--terminal_cursor").trim() } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHost.current);
    fit.fit();
    terminalInstance.current = terminal;
    terminalStop.current = watchTerminal?.({ terminalId: String(active.terminalId) }, (frame) => { terminal.write(frame.data); if (frame.exited) terminal.options.disableStdin = true; });
    const onResize = () => { fit.fit(); };
    const observer = new ResizeObserver(onResize);
    observer.observe(terminalHost.current);
    const input = terminal.onData((data) => { if (writeTerminal) void writeTerminal({ terminalId: String(active.terminalId), data }); });
    return () => { input.dispose(); observer.disconnect(); terminalStop.current?.(); terminalStop.current = undefined; terminal.dispose(); terminalInstance.current = undefined; };
  }, [activeTerminalId, terminals, watchTerminal, writeTerminal]);
  const tabLabel = (item: WorkspacePanelTab): string => item.kind === "file-preview" ? item.path.split("/").at(-1) ?? item.path : item.kind === "review" && item.source === "turn" ? "Review" : ({ files: "查看文件", review: "变更", canvas: "画布", terminal: "终端" } as const)[item.kind];
  const fileTabGlyph = (item: WorkspacePanelTab) => {
    if (item.kind === "files") return <WebuiIconFile className="webui-workspace-tab-file-icon" />;
    if (item.kind !== "file-preview") return null;
    const extension = item.path.split(/[./\\]/u).at(-1)?.toLowerCase();
    if (extension === "md" || extension === "mdx") return <span className="webui-workspace-filetype-badge is-markdown" aria-hidden="true">M↓</span>;
    if (["js", "jsx", "mjs", "cjs"].includes(extension ?? "")) return <span className="webui-workspace-filetype-badge is-javascript" aria-hidden="true">JS</span>;
    if (["ts", "tsx", "mts", "cts"].includes(extension ?? "")) return <span className="webui-workspace-filetype-badge is-typescript" aria-hidden="true">TS</span>;
    if (extension === "json") return <span className="webui-workspace-filetype-badge is-json" aria-hidden="true">{ }</span>;
    return <WebuiIconDiffFile fileName={item.path} className="webui-workspace-tab-file-icon" />;
  };
  return <aside className={`webui-workspace-panel ${state.expanded ? "is-expanded" : ""}`} data-testid="workspace-panel" data-active-tab={tab}>
    <div className="webui-workspace-panel-header">
      <div className="webui-workspace-tabs" role="tablist" aria-label="工作区面板标签">
        <div className="webui-workspace-tab-list" ref={tabListRef}>
          {state.tabs.map((item) => <div key={item.id} className={`webui-workspace-tab ${state.activeTabId === item.id ? "is-active" : ""}`} role="presentation">
            <button type="button" role="tab" aria-selected={state.activeTabId === item.id} onClick={() => dispatch({ type: "select-tab", tabId: item.id })}>{fileTabGlyph(item)}<span className="webui-workspace-tab-label">{tabLabel(item)}</span></button>
            <button type="button" aria-label={`${tabLabel(item)} ${DESKTOP_COPY.fileClose}`} onClick={() => dispatch({ type: "close-tab", tabId: item.id })}><WebuiIconClose className="size-3" /></button>
          </div>)}
        </div>
        <div className="webui-workspace-add-anchor">
          <button type="button" className="webui-workspace-add-trigger" aria-label="添加标签" aria-haspopup="menu" aria-expanded={state.addMenuOpen} onClick={() => dispatch({ type: "toggle-add-menu" })}>+</button>
          {state.addMenuOpen ? <div className="webui-workspace-add-menu" role="menu" aria-label="添加工作区标签">
            {sessionId && workspaceDir ? <button type="button" role="menuitem" onClick={() => dispatch({ type: "open-workspace-review", sessionId, workspaceDir })}><WebuiIconWorkspaceReview className="size-[18px] shrink-0" /><span>审查</span></button> : null}
            <button type="button" role="menuitem" onClick={() => dispatch({ type: "open-tab", kind: "terminal", sessionId, workspaceDir })}><WebuiIconWorkspaceTerminal className="size-[18px] shrink-0" /><span>终端</span></button>
            <button type="button" role="menuitem" onClick={() => dispatch({ type: "open-tab", kind: "canvas", sessionId, workspaceDir })}><WebuiIconWorkspaceCanvas className="size-[18px] shrink-0" /><span>画布</span></button>
            <button type="button" role="menuitem" onClick={() => dispatch({ type: "open-tab", kind: "files", sessionId, workspaceDir })}><WebuiIconFile className="size-[18px] shrink-0" /><span>查看文件</span></button>
          </div> : null}
        </div>
      </div>
      <div className="webui-workspace-panel-actions">
        <button type="button" aria-label={state.expanded ? "收起面板" : "展开面板"} aria-pressed={state.expanded} onClick={() => dispatch({ type: "toggle-expanded" })}><WebuiIconWorkspaceExpand className="size-[18px]" /></button>
        <button type="button" className="webui-workspace-panel-close" aria-label="关闭面板" onClick={onClose}><WebuiIconClose className="size-[18px]" /></button>
      </div>
    </div>
    {hasFileWorkspace ? <div className="webui-workspace-file-toolbar">
      <div className="webui-workspace-file-breadcrumb" aria-label="文件路径">
        {activeTab?.kind === "file-preview" ? activeTab.path.split("/").map((part, index) => <span key={`${part}-${index}`} className={index === activeTab.path.split("/").length - 1 ? "is-current" : ""}>{index ? <span aria-hidden="true">›</span> : null}{part}</span>) : <span className="is-current">{workspaceDir?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "工作区"}</span>}
      </div>
      {activeTab?.kind === "file-preview" && /\.md$/iu.test(activeTab.path) ? <div className="webui-workspace-file-mode" role="group" aria-label="文件显示模式">
        <button type="button" aria-pressed={!fileCodeMode} onClick={() => setFileCodeMode(false)}>预览</button>
        <button type="button" aria-pressed={fileCodeMode} onClick={() => setFileCodeMode(true)}>代码</button>
      </div> : null}
      {activeTab?.kind === "file-preview" ? <button type="button" className="webui-workspace-edit-action" aria-label="编辑文件（暂未支持）" title="编辑文件（暂未支持）" disabled><svg className="size-[18px]" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12.7 3.3 4 4M3.5 16.5l3.1-.6L16 6.5a1.4 1.4 0 0 0-2-2l-9.4 9.4-.6 2.6Z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg></button> : null}
      <button type="button" className="webui-workspace-tree-toggle" aria-label={fileTreeOpen ? "隐藏文件树" : "显示文件树"} aria-pressed={fileTreeOpen} onClick={() => setFileTreeOpen((open) => !open)}><WebuiIconSidebarToggle className="size-5" /></button>
    </div> : null}
    <div className="webui-workspace-panel-body">
      <div className="webui-workspace-view">
    {tab === "files" ? <div className="webui-workspace-files-empty" data-testid="workspace-files-empty"><WebuiIconFolder className="size-8" /><strong>查看文件</strong><p>从工作区目录树中选择文件</p></div> : null}
    {tab === "file-preview" && activeTab?.kind === "file-preview" ? <WebuiFilePreview tab={activeTab} result={fileResults.get(activeTab.id)} codeMode={fileCodeMode} workspaceFileUrl={workspaceFileUrl} readWorkspaceArchive={readWorkspaceArchive} extractWorkspaceArchive={extractWorkspaceArchive} /> : null}
    {tab === "review" && activeTab?.kind === "review" && activeTab.source === "workspace" ? <div className="webui-turn-review" data-testid="workspace-review">
      {reviewSummary?.tabId !== activeTab.id || reviewSummary.loading && !reviewSummary.summary ? <p className="webui-turn-review-empty" role="status">正在收集变更…</p> : reviewSummary.error && !reviewSummary.summary ? <p className="webui-turn-review-empty" role="alert">{reviewSummary.error}</p> : reviewSummary.summary ? <>
        <div className="webui-turn-review-summary"><span>{reviewSummary.summary.totals.files} 个文件</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{reviewSummary.summary.totals.additions}</span>{reviewSummary.summary.totals.deletions ? <span className="webui-diff-del">-{reviewSummary.summary.totals.deletions}</span> : null}</span></div>
        {reviewSummary.stale || reviewSummary.error ? <p className="webui-workspace-review-status" role="status">变更列表可能已过期{reviewSummary.error ? `：${reviewSummary.error}` : "，正在刷新…"}</p> : null}
        {reviewSummary.summary.files.length ? <>
          <form className="webui-workspace-review-search" onSubmit={(event) => { event.preventDefault(); runReviewSearch(); }}><input aria-label="搜索变更" value={reviewSearchQuery} onChange={(event) => setReviewSearchQuery(event.currentTarget.value)} placeholder="搜索变更" /><button type="submit" disabled={!queries?.canSearchReviewDiffs || reviewSearch?.loading}>搜索</button></form>
          {reviewSearch?.tabId === activeTab.id && reviewSearch.snapshotId === activeTab.reviewSnapshotId ? reviewSearch.loading ? <p className="webui-workspace-review-status" role="status">正在搜索变更…</p> : reviewSearch.error ? <p className="webui-workspace-review-status" role="alert">{reviewSearch.error}</p> : reviewSearch.result ? <ul className="webui-workspace-review-search-results" data-testid="workspace-review-search-results">{reviewSearch.result.matchedFiles.map((match) => <li key={match.fileId}><button type="button" onClick={() => dispatch({ type: "select-review-file", tabId: activeTab.id, path: match.path })}>{match.path} <small>{match.matchCount}</small></button></li>)}</ul> : null : null}
          {reviewDiffs?.error && reviewDiffs.tabId === activeTab.id && reviewDiffs.snapshotId === activeTab.reviewSnapshotId ? <p className="webui-workspace-review-status" role="alert">{reviewDiffs.error}</p> : null}
          <div className="webui-turn-review-files">{reviewSummary.summary.files.map((file) => {
            const result = reviewDiffs?.tabId === activeTab.id && reviewDiffs.snapshotId === activeTab.reviewSnapshotId ? reviewDiffs.diffs[file.fileId] : undefined;
            const loading = !result && (reviewDiffs?.tabId !== activeTab.id || reviewDiffs.snapshotId !== activeTab.reviewSnapshotId || reviewDiffs.loading);
            return <WebuiDiffFileSection key={file.fileId} file={{ file: file.path, additions: file.additions, deletions: file.deletions, status: file.status, ...(result?.diff !== undefined ? { diff: result.diff } : {}) }} selected={selectedReviewPath === file.path} loading={loading} error={result?.binary ? "二进制文件无法显示文本差异。" : result?.error} onSelect={() => dispatch({ type: "select-review-file", tabId: activeTab.id, path: file.path })} />;
          })}</div>
        </> : <p className="webui-turn-review-empty">当前没有变更。</p>}
      </> : null}
    </div> : null}
    {tab === "review" && activeTab?.kind === "review" && activeTab.source === "turn" ? <div className="webui-turn-review" data-testid="turn-review-panel" data-session-id={activeTab.sessionId} data-message-id={activeTab.messageId} data-turn-id={activeTab.turnId} data-change-set-id={activeTab.changeSetId}>
      <div className="webui-turn-review-summary"><span>本轮改动</span><span className="webui-diff-header-stats"><span className="webui-diff-add">+{turnReviewFiles.reduce((sum, file) => sum + file.additions, 0)}</span>{turnReviewFiles.some((file) => file.deletions > 0) ? <span className="webui-diff-del">-{turnReviewFiles.reduce((sum, file) => sum + file.deletions, 0)}</span> : null}</span></div>
      {turnReviewFiles.length ? <div className="webui-turn-review-files">{turnReviewFiles.map((file) => <WebuiDiffFileSection key={file.file} file={file} selected={selectedReviewPath === file.file} />)}</div> : <p className="webui-turn-review-empty">本轮没有可审查的文件差异。</p>}
    </div> : null}
    {tab === "canvas" ? <WorkspaceCanvas sessionId={activeSessionId} readCanvas={readCanvas} applyCanvas={applyCanvas} /> : null}
    {tab === "terminal" ? <div className="webui-terminal-empty">{terminals.length === 0 ? <><strong>{DESKTOP_COPY.terminalEmptyTitle}</strong><p>{DESKTOP_COPY.terminalEmptyDescription}</p></> : <><div className="webui-terminal-tabs">{terminals.map((terminal, index) => <button type="button" key={String(terminal.terminalId)} className={`file-tab group/tab-close h-8 w-40 min-w-20 ${String(terminal.terminalId) === (activeTerminalId ?? String(terminals[0]?.terminalId)) ? "bg-bg_interaction_tertiary_selected" : ""}`} onClick={() => setActiveTerminalId(String(terminal.terminalId))}><span>#{index + 1}</span>{terminal.status === "exited" ? DESKTOP_COPY.terminalExited : DESKTOP_COPY.terminalLabel}<span className="file-tab-close opacity-0 group-hover/tab-close:opacity-100"><WebuiIconClose className="size-[14px]" /></span></button>)}</div><div ref={terminalHost} className="webui-xterm-host" />{terminalError ? <p role="alert">{terminalError}</p> : null}<div className="webui-terminal-actions"><button type="button" onClick={() => { if (!activeWorkspace || !createTerminal) return; void createTerminal({ workspaceDir: activeWorkspace }).then((created) => { setActiveTerminalId(created.terminalId); return listTerminals?.().then(setTerminals); }).catch((error: unknown) => setTerminalError(error instanceof Error ? error.message : String(error))); }}>{DESKTOP_COPY.newTerminal}</button><button type="button" onClick={() => { const active = terminals.find((candidate) => String(candidate.terminalId) === (activeTerminalId ?? String(terminals[0]?.terminalId))); if (active && disposeTerminal) void disposeTerminal({ terminalId: String(active.terminalId) }).then(() => listTerminals?.().then(setTerminals)); }}>{DESKTOP_COPY.fileClose}</button></div></> }{terminals.length === 0 ? <button type="button" onClick={() => { if (!activeWorkspace || !createTerminal) return; void createTerminal({ workspaceDir: activeWorkspace }).then((created) => { setActiveTerminalId(created.terminalId); return listTerminals?.().then(setTerminals); }).catch((error: unknown) => setTerminalError(error instanceof Error ? error.message : String(error))); }}>{DESKTOP_COPY.newTerminal}</button> : null}</div> : null}
      </div>
      {hasFileWorkspace && fileTreeOpen ? <aside className="webui-workspace-file-tree-panel" aria-label="工作区文件树">
        <label className="webui-workspace-file-search"><WebuiIconSearch className="size-4" /><input aria-label="搜索文件" placeholder="搜索" value={fileSearch} onChange={(event) => setFileSearch(event.currentTarget.value)} /></label>
        <div className="webui-workspace-file-tree-scroll" ref={fileTreeScrollRef}>
          {fileTree.workspaceDir !== activeWorkspace || fileTree.loading ? <p role="status">正在加载文件…</p> : fileTree.error ? <p role="alert">{fileTree.error}</p> : fileTree.files.length ? visibleFiles.length ? <FileTree files={visibleFiles} expandedPaths={expandedDirectories} loadingPaths={fileTree.loadingDirectories} directoryErrors={fileTree.directoryErrors} onToggle={toggleWorkspaceDirectory} selectedPath={activeTab?.kind === "file-preview" ? selectedFilePath : activeTab?.kind === "review" ? selectedReviewPath : undefined} onOpen={(entry) => { const context = activeTab && "sessionId" in activeTab ? activeTab.sessionId : sessionId; if (!activeWorkspace || !context || entry.type === "directory") return; if (activeTab?.kind === "review" && activeTab.source === "turn" && turnReviewFiles.some((file) => file.file === entry.path) || activeTab?.kind === "review" && activeTab.source === "workspace" && workspaceReviewFiles.some((file) => file.path === entry.path)) dispatch({ type: "select-review-file", tabId: activeTab.id, path: entry.path }); else dispatch({ type: "open-file", sessionId: context, workspaceDir: activeWorkspace, path: entry.path }); }} /> : <p className="webui-workspace-tree-empty">没有匹配的文件。</p> : <p className="webui-workspace-tree-empty">此工作区没有可显示的文件。</p>}
        </div>
      </aside> : null}
    </div>
  </aside>;
}
