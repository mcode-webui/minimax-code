import { useEffect, useState, type ReactElement } from "react";
import type { WebuiWorkspaceEnvironment, WebuiWorkspaceGitMutationRequest } from "../../../../shared/contracts/workspace.js";
import type { WebuiWorkspaceEnvironmentCommands } from "../application/workspace-queries.js";
import type { WebuiWorkspaceSubagent } from "../projection/workspace-progress.js";
import type { WebuiTodo } from "../projection/panel-projection.js";
import {
  useWebuiWorkspacePanelSurface,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import { WebuiIconCheck, WebuiIconChevronDown, WebuiIconClose, WebuiIconFile, WebuiIconRunLocation, WebuiIconWorkspaceTerminal } from "../../../shell/icons.js";
import { WebuiAgentAvatar } from "../../../ui/agent-avatar.js";
import { WebuiField, WebuiTextarea, useWebuiFormValidation } from "../../../ui/field.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiDialog, WebuiDialogActions } from "../../../ui/dialog.js";
import { WebuiDisclosure, WebuiMotion, WebuiMotionSlot, WebuiPage, WebuiSkeletonProjection } from "../../../ui/page.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";

import { FeedbackEmpty } from "../../../ui/feedback.js";
const PROGRESS_COPY = {
  environment: "环境信息",
  progress: "进度",
  progressEmpty: "跟踪较长任务的进度",
  changes: "变更",
  commit: "提交或推送",
  openTerminal: "打开终端",
  unsupported: "WebUI 尚未接入此操作",
  close: "关闭",
} as const;

function WorkspaceProgressSection({ kind, className, title, titleMeta, collapsed, onToggle, children, busy }: {
  readonly kind: "environment" | "progress" | "subagents";
  readonly className: string;
  readonly title: string;
  /** Quiet metadata shown in the header next to the title (completion summary). */
  readonly titleMeta?: ReactElement;
  readonly collapsed: boolean;
  readonly onToggle?: () => void;
  readonly children: ReactElement | null;
  readonly busy?: boolean;
}): ReactElement {
  return <WebuiMotion as="section" kind="disclosure" state={collapsed ? "collapse" : "expand"} {...{ [`data-webui-${kind}-panel`]: "true" }} className={`webui-progress-section ${className}${collapsed ? " is-collapsed" : ""}`} data-workspace-section="true" aria-busy={busy || undefined}>
    <WebuiButton variant="quiet-secondary" size="header" className="webui-workspace-section-title" onClick={onToggle} aria-expanded={!collapsed}>
      <span data-workspace-section-title="true">{title}</span>
      {titleMeta}
      <WebuiMotionSlot kind="disclosure-transform" rotation={collapsed ? -90 : 0}>
        <WebuiIconChevronDown className="webui-progress-section-chevron" />
      </WebuiMotionSlot>
    </WebuiButton>
    <WebuiDisclosure as="div" open={!collapsed} className="webui-progress-section-body">
      {children}
    </WebuiDisclosure>
  </WebuiMotion>;
}

export function WebuiProgressPanel({ todos, showProgress = true, showEmptyState = false, collapsed = false, onToggle }: {
  readonly todos: readonly WebuiTodo[];
  readonly showProgress?: boolean;
  readonly showEmptyState?: boolean;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
}): ReactElement | null {
  if (!showProgress || (todos.length === 0 && !showEmptyState)) return null;
  // Completion summary for the section header: completed count over the whole
  // list. An empty list renders no summary (the empty state explains itself).
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const completionSummary = todos.length > 0
    ? `${completedCount}/${todos.length} 已完成 · ${Math.round((completedCount / todos.length) * 100)}%`
    : null;
  return <WorkspaceProgressSection kind="progress" className="webui-progress-panel" title={PROGRESS_COPY.progress} titleMeta={completionSummary === null ? undefined : <span className="ml-2 shrink-0 text-caption-base text-text_default_tertiary">{completionSummary}</span>} collapsed={collapsed} onToggle={onToggle}>
        {todos.length === 0 ? <div className="webui-progress-scroll"><FeedbackEmpty className="webui-progress-empty" title={PROGRESS_COPY.progressEmpty} /></div> : <div className="webui-progress-scroll">
          {todos.map((todo, index) => <div className={`webui-progress-row webui-progress-row--${todo.status}`} key={`${todo.content}-${index}`}>
            <span className="webui-progress-marker">{todo.status === "completed" ? <WebuiIconCheck className="size-3" /> : index + 1}</span>
            <span className={`min-w-0 flex-1 truncate ${todo.status === "completed" ? "line-through text-text_default_tertiary" : ""}`}>{todo.content}</span>
          </div>)}
        </div>}
  </WorkspaceProgressSection>;
}

export function WebuiSubagentsPanel({ subagents, collapsed = false, onToggle, onMemberClick }: {
  readonly subagents: readonly WebuiWorkspaceSubagent[];
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly onMemberClick?: (subagent: WebuiWorkspaceSubagent) => void;
}): ReactElement | null {
  if (subagents.length === 0) return null;
  return <WorkspaceProgressSection kind="subagents" className="webui-subagents-panel" title="Subagents" collapsed={collapsed} onToggle={onToggle}>
      <div className="webui-subagents-scroll">
        {subagents.map((subagent) => {
          const label = subagent.title?.trim() || subagent.agentName;
          return <WebuiButton variant="selectable-row" size="rail" className="webui-subagent-row" key={subagent.sessionId} onClick={() => onMemberClick?.(subagent)}>
            <WebuiAgentAvatar agentName={subagent.agentName} size="compact" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <span className={`webui-subagent-status webui-subagent-status--${subagent.status}`} aria-label={subagent.status}>
              {subagent.status === "completed" ? <WebuiIconCheck className="size-3" /> : subagent.status === "error" ? "!" : "·"}
            </span>
          </WebuiButton>;
        })}
      </div>
  </WorkspaceProgressSection>;
}

function WorkspaceCommitDialog({ open, environment, workspaceDir, mutateGit, onClose }: {
  readonly open: boolean;
  readonly environment: WebuiWorkspaceEnvironment;
  readonly workspaceDir: string;
  readonly mutateGit: (request: WebuiWorkspaceGitMutationRequest) => Promise<Record<string, unknown>>;
  readonly onClose: () => void;
}): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The commit or the push failed: the failure is said once, as a toast, and
  // is not drawn in the dialog's layout.
  useWebuiToastError(error);
  const { errors: fieldErrors, validateRequired, clearFieldError } = useWebuiFormValidation();
  const hasChanges = environment.changedFiles > 0;
  const submit = (action: "commit" | "commitAndPush" | "push") => {
    if (action !== "push" && !validateRequired([{ name: "message", label: "提交说明", value: message }])) return;
    setBusy(true);
    setError(undefined);
    // The mutation runs through the query owner, which invalidates exactly the
    // environment and review views for this workspace on completion.
    void mutateGit({ workspaceDir, action, ...(message.trim() ? { message: message.trim() } : {}) })
      .then(() => { onClose(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  return <WebuiDialog id="workspace-commit-dialog" open={open} title={PROGRESS_COPY.commit} onClose={onClose} dismissOnEscape portalTarget={dom.portalTarget()} width="compact" footer={<WebuiDialogActions>
    <WebuiButton variant="secondary" onClick={onClose} disabled={busy}>取消</WebuiButton>
    {hasChanges ? <WebuiButton variant="secondary" onClick={() => submit("commit")} disabled={busy}>提交</WebuiButton> : null}
    <WebuiButton variant="primary" onClick={() => submit(hasChanges ? "commitAndPush" : "push")} disabled={busy}>{hasChanges ? "提交并推送" : "推送"}</WebuiButton>
  </WebuiDialogActions>}>
    {hasChanges ? <WebuiField className="webui-commit-dialog-label" label="提交说明" required error={fieldErrors.message} control={(props) => <WebuiTextarea {...props} value={message} onChange={(event) => { setMessage(event.target.value); clearFieldError("message"); }} placeholder="例如：修复搜索框样式" autoFocus />} /> : <p className="webui-commit-dialog-hint">当前没有未提交变更，将推送当前分支。</p>}
  </WebuiDialog>;
}

export function WebuiEnvironmentPanel({ workspaceDir, isDefaultWorkspace = false, workspaceEnvironment, loading = false, queries: queriesProp, collapsed = false, onToggle, onOpenChanges, onOpenTerminal }: {
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly workspaceEnvironment?: WebuiWorkspaceEnvironment;
  readonly loading?: boolean;
  /** Injected in tests; defaults to the provided query owner. */
  readonly queries?: WebuiWorkspaceEnvironmentCommands;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly onOpenChanges?: () => void;
  readonly onOpenTerminal?: () => void;
}): ReactElement | null {
  const contextQueries = useWebuiWorkspacePanelSurface();
  const queries = queriesProp ?? contextQueries;
  const queryState = useWebuiWorkspaceQueriesState();
  const [commitOpen, setCommitOpen] = useState(false);
  const environmentRevision = queryState.environmentRevision;
  const environmentMatchesWorkspace = queryState.environment.workspaceDir === workspaceDir;
  const ownerEnvironment = environmentMatchesWorkspace ? queryState.environment.environment : undefined;
  const environment = workspaceEnvironment ?? ownerEnvironment;
  const environmentError = !environment && workspaceDir && environmentMatchesWorkspace && !queryState.environment.loading
    ? queryState.environment.error
    : undefined;
  useEffect(() => {
    if (workspaceEnvironment) return;
    if (!workspaceDir || isDefaultWorkspace || !queries?.canReadEnvironment) return;
    // `environmentRevision` re-runs the load when the owner invalidates this
    // workspace's environment (a commit or a git-changed signal).
    queries.loadEnvironment(workspaceDir);
  }, [queries, workspaceDir, isDefaultWorkspace, workspaceEnvironment, environmentRevision]);
  // The environment could not be read: the failure is said once, as a toast,
  // and is not drawn in the panel's body.
  useWebuiToastError(environmentError ? `环境信息加载失败：${environmentError}` : undefined);
  const pending = Boolean(!environment && !environmentError && !isDefaultWorkspace && (
    loading || (workspaceDir && queries?.canReadEnvironment && (!environmentMatchesWorkspace || queryState.environment.loading || !queryState.environment.environment))
  ));
  if (isDefaultWorkspace || (!pending && (!workspaceDir || (!queries?.canReadEnvironment && !workspaceEnvironment)))) return null;
  if (!pending && !environmentError && !environment?.isGitRepo) return null;
  const hasChanges = Boolean(environment && environment.changedFiles > 0);
  const canMutate = Boolean(environment && queries?.canMutateGit && !environment.changesError && !environment.metadataError && (hasChanges || environment.canPush));
  const hasLineChanges = Boolean(environment && environment.lineStatsStatus === "ready" && (environment.insertions > 0 || environment.deletions > 0));
  const environmentBody = <div className="webui-environment-body">
    <div className="webui-environment-workspace">{environment?.branch || " "}</div>
    <div className="webui-environment-actions">
      <WebuiButton variant="selectable-row" size="rail" className="webui-environment-action" skeletonOnPageLoading onClick={onOpenChanges} disabled={!onOpenChanges}>
        <WebuiIconRunLocation className="size-5" /><span>{PROGRESS_COPY.changes}</span>{hasLineChanges && environment ? <small aria-label={`新增 ${environment.insertions} 行，删除 ${environment.deletions} 行`}><span className="webui-diff-additions">+{environment.insertions}</span><span className="webui-diff-deletions">-{environment.deletions}</span></small> : null}
      </WebuiButton>
      <WebuiButton variant="selectable-row" size="rail" className="webui-environment-action" skeletonOnPageLoading onClick={() => setCommitOpen(true)} disabled={!canMutate}>
        <WebuiIconFile className="size-5" /><span>{PROGRESS_COPY.commit}</span>
      </WebuiButton>
      <WebuiButton variant="selectable-row" size="rail" className="webui-environment-action" skeletonOnPageLoading onClick={onOpenTerminal} disabled={!onOpenTerminal}>
        <WebuiIconWorkspaceTerminal className="size-5" /><span>{PROGRESS_COPY.openTerminal}</span>
      </WebuiButton>
    </div>
  </div>;
  return <>
    <WorkspaceProgressSection kind="environment" className={`webui-environment-panel${pending ? " is-loading" : ""}`} title={PROGRESS_COPY.environment} collapsed={collapsed} onToggle={onToggle} busy={pending}>
        <>
          {pending ? <FeedbackLiveRegion screenReaderOnly>正在加载环境信息</FeedbackLiveRegion> : null}
          {environment || pending ? <WebuiSkeletonProjection loading={pending}>{environmentBody}</WebuiSkeletonProjection> : null}
        </>
    </WorkspaceProgressSection>
    {environment && workspaceDir && queries?.canMutateGit ? <WorkspaceCommitDialog open={commitOpen} environment={environment} workspaceDir={workspaceDir} mutateGit={queries.mutateGit} onClose={() => setCommitOpen(false)} /> : null}
  </>;
}

interface WebuiProgressOverviewPanelProps {
  readonly open?: boolean;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly workspaceEnvironment?: WebuiWorkspaceEnvironment;
  readonly environmentLoading?: boolean;
  readonly todos: readonly WebuiTodo[];
  readonly subagents?: readonly WebuiWorkspaceSubagent[];
  readonly showProgress?: boolean;
  readonly environmentCollapsed?: boolean;
  readonly progressCollapsed?: boolean;
  readonly subagentsCollapsed?: boolean;
  readonly onToggleEnvironment?: () => void;
  readonly onToggleProgress?: () => void;
  readonly onToggleSubagents?: () => void;
  readonly onMemberClick?: (subagent: WebuiWorkspaceSubagent) => void;
  readonly onOpenChanges?: () => void;
  readonly onOpenTerminal?: () => void;
}

export function WebuiProgressOverviewPanel({ open = false, workspaceDir, isDefaultWorkspace = false, workspaceEnvironment, environmentLoading = false, todos, subagents = [], showProgress = true, environmentCollapsed = false, progressCollapsed = false, subagentsCollapsed = false, onToggleEnvironment, onToggleProgress, onToggleSubagents, onMemberClick, onOpenChanges, onOpenTerminal }: WebuiProgressOverviewPanelProps): ReactElement | null {
  const environmentQueries = useWebuiWorkspacePanelSurface();
  const environmentQueryState = useWebuiWorkspaceQueriesState();
  const environmentMatchesWorkspace = environmentQueryState.environment.workspaceDir === workspaceDir;
  const ownerEnvironment = environmentMatchesWorkspace ? environmentQueryState.environment.environment : undefined;
  const environment = workspaceEnvironment ?? ownerEnvironment;
  const environmentError = !environment && workspaceDir && environmentMatchesWorkspace && !environmentQueryState.environment.loading
    ? environmentQueryState.environment.error
    : undefined;
  const environmentPending = Boolean(!environment && !environmentError && !isDefaultWorkspace && (
    environmentLoading || (workspaceDir && environmentQueries?.canReadEnvironment && (!environmentMatchesWorkspace || environmentQueryState.environment.loading || !environmentQueryState.environment.environment))
  ));
  const environmentPanelVisible = !(
    isDefaultWorkspace || (!environmentPending && (!workspaceDir || (!environmentQueries?.canReadEnvironment && !workspaceEnvironment))) ||
    (!environmentPending && !environmentError && !environment?.isGitRepo)
  );
  const showEmptyProgress = showProgress && todos.length === 0 && subagents.length === 0 && !environmentPanelVisible;
  return <WebuiPage as="div" kind="panel" present={open} motion={{ kind: "panel", state: "enter", direction: "right" }} className="webui-progress-panel-motion">
    <aside className="webui-progress-overview-panel" data-testid="progress-overview-panel" aria-label="环境信息与进度">
      <div className="webui-progress-overview-card" data-testid="progress-overview-card">
        <div className="webui-progress-overview-main">
          <WebuiEnvironmentPanel workspaceDir={workspaceDir} isDefaultWorkspace={isDefaultWorkspace} workspaceEnvironment={workspaceEnvironment} loading={environmentLoading} collapsed={environmentCollapsed} onToggle={onToggleEnvironment} onOpenChanges={onOpenChanges} onOpenTerminal={onOpenTerminal} />
          <WebuiProgressPanel todos={todos} showProgress={showProgress} showEmptyState={showEmptyProgress} collapsed={progressCollapsed} onToggle={onToggleProgress} />
          <WebuiSubagentsPanel subagents={subagents} collapsed={subagentsCollapsed} onToggle={onToggleSubagents} onMemberClick={onMemberClick} />
        </div>
      </div>
    </aside>
  </WebuiPage>;
}
