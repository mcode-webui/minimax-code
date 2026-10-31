// WebuiGoalBanner — the thread-level goal banner (status, edit, clear).
//
// This component owns the session-scoped goal card. Its transport calls stay on
// the existing WebUI goal contract while the visual surface keeps a compact
// status/actions layout.

import { useEffect, useState, type ReactElement } from "react";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  formatWebuiGoalDuration,
  WEBUI_GOAL_STATUS_COPY,
  WEBUI_GOAL_WAIT_COPY,
} from "../projection/goal-state.js";
import type {
  WebuiGoal,
  WebuiGoalStatus,
} from "../../../../shared/contracts/goal.js";
import type { WebuiGoalCommands } from "../contracts/goal-port.js";
import { FeedbackError, FeedbackLiveRegion } from "../../../ui/feedback.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiDialog } from "../../../ui/dialog.js";
import {
  WebuiIconCommandGoal,
  WebuiIconClose,
  WebuiIconContextRename,
  WebuiIconContextTrash,
} from "../../../shell/icons.js";

function GoalPauseIcon(): ReactElement {
  return <IconPlayerPause aria-hidden="true" size={18} stroke={1.5} />;
}

function GoalResumeIcon(): ReactElement {
  return <IconPlayerPlay aria-hidden="true" size={18} stroke={1.5} />;
}

export function WebuiGoalClearDialog({
  busy,
  error,
  portalTarget,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly portalTarget: HTMLElement | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  /**
   * The confirmation is a layer, so the coordinator answers Escape and the
   * outside press for it (ADR 0028 § Overlay coordination). It used to answer
   * both itself — a `window` keydown listener and a mask `onMouseDown` — which
   * meant two listeners for one overlay and a dialog the overlay gate could
   * not see, because it carried no `role="dialog"`.
   *
   * Not dismissible while the delete is in flight: the attempt is answered with
   * "nothing to do" rather than consumed, so a press aimed at what the dialog
   * holds still reaches it, and the dialog does not close under a delete that
   * is still running.
   */
  return (
    <WebuiDialog
      id="goal-clear-confirm"
      title="删除目标？"
      description="删除目标后，目标模式会关闭，转为普通模式继续。"
      portalTarget={portalTarget}
      onClose={onCancel}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      testId="goal-clear-confirm"
      width="compact"
      footer={
        <>
          <WebuiButton variant="secondary" onClick={onCancel} disabled={busy}>取消</WebuiButton>
          <WebuiButton
            variant="danger"
            data-testid="goal-clear-confirm-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "删除中…" : "删除"}
          </WebuiButton>
        </>
      }
    >
      {error ? <FeedbackError message={error} className="webui-goal-clear-dialog-error" testId="goal-clear-error" /> : null}
    </WebuiDialog>
  );
}

export function WebuiGoalBanner({
  goal,
  patchGoal,
  clearGoal,
  onEditGoal,
  onCleared,
  interactionBlocked = false,
}: {
  readonly goal?: WebuiGoal;

  readonly onEditGoal: (objective: string) => void;
  readonly onCleared?: () => void;
  readonly interactionBlocked?: boolean;
} & WebuiGoalCommands): ReactElement | null {
  const { dom } = useWebuiBrowserCapabilities();
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [dismissedGoalKey, setDismissedGoalKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setObjectiveExpanded(false);
    setConfirmClear(false);
  }, [goal?.sessionId, goal?.goalId]);
  useEffect(() => {
    setDismissedGoalKey(undefined);
  }, [goal?.sessionId, goal?.goalId]);
  useEffect(() => {
    if (!goal || goal.status !== "active" || goal.executionWait) {
      setElapsedSeconds(0);
      return undefined;
    }
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - goal.updatedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [goal]);
  if (!goal) return null;
  const goalKey = `${goal.sessionId}:${goal.goalId}`;
  if (dismissedGoalKey === goalKey) return null;
  const status = updated ? "updated" : goal.status;
  const statusCopy = status === "updated"
    ? WEBUI_GOAL_STATUS_COPY.updated
    : goal.status === "active" && goal.executionWait
    ? WEBUI_GOAL_WAIT_COPY[goal.executionWait.reason] ?? WEBUI_GOAL_WAIT_COPY.unknown
    : WEBUI_GOAL_STATUS_COPY[status];
  const submitPatch = (patch: { status?: WebuiGoalStatus; objective?: string; tokenBudget?: number | null }) => {
    if (!patchGoal) return;
    setBusy(true);
    setError(undefined);
    void patchGoal({ sessionId: goal.sessionId, ...patch })
      .then(() => { setUpdated(true); window.setTimeout(() => setUpdated(false), 2_400); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  const clear = () => {
    if (!clearGoal) return;
    setBusy(true);
    setError(undefined);
    void clearGoal({ sessionId: goal.sessionId })
      .then(() => {
        setConfirmClear(false);
        onCleared?.();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  const clearDialog = confirmClear
    ? <WebuiGoalClearDialog
      busy={busy}
      error={error}
      portalTarget={dom.portalTarget()}
      onCancel={() => { setConfirmClear(false); setError(undefined); }}
      onConfirm={clear}
    />
    : null;
  return (
    <section className="webui-goal-banner" data-testid="thread-goal-banner" data-goal-status={status}>
      <div className="webui-goal-banner-row">
        <div className="webui-goal-banner-leading">
          <span className="webui-goal-banner-icon" aria-hidden="true"><WebuiIconCommandGoal /></span>
          <FeedbackLiveRegion className="webui-goal-status" testId="thread-goal-banner-status">{statusCopy}</FeedbackLiveRegion>
        </div>
        <div className="webui-goal-banner-content-row" data-testid="thread-goal-banner-content-row">
          <div className="webui-goal-banner-objective-group" data-testid="thread-goal-banner-objective-group">
            <WebuiButton variant="quiet-secondary" size="inline" className="webui-goal-objective" data-testid="thread-goal-banner-objective" aria-expanded={objectiveExpanded} title={goal.objective} onClick={() => setObjectiveExpanded((value) => !value)}>{goal.objective}</WebuiButton>
          </div>
          <div className="webui-goal-usage" data-testid="thread-goal-usage">
            <span data-testid="thread-goal-tokens-used">{goal.tokensUsed} tokens</span>
            <span data-testid="thread-goal-turns-used">{goal.turnsUsed} 轮</span>
            {goal.status === "budget_limited" ? <span className="webui-goal-budget-guide" data-testid="thread-goal-banner-budget-guide">创建新目标后继续</span> : null}
            {goal.status === "usage_limited" ? <span className="webui-goal-usage-guide" data-testid="thread-goal-usage-guide">服务商额度恢复后可继续</span> : null}
          </div>
          <span className="webui-goal-time-divider" data-testid="thread-goal-banner-time-divider" aria-hidden="true" />
          <span className="webui-goal-timer" data-testid="thread-goal-timer">{formatWebuiGoalDuration(goal.timeUsedSeconds + elapsedSeconds)}</span>
        </div>
        <div className="webui-goal-banner-actions-slot" data-testid="thread-goal-banner-actions-slot">
          {goal.status === "blocked" || goal.status === "paused" || goal.status === "usage_limited" ? <WebuiIconButton tone="bare" className="webui-goal-action" data-testid="thread-goal-banner-resume" label="继续目标" title="继续目标" onClick={() => submitPatch({ status: "active" })} disabled={busy || interactionBlocked}><GoalResumeIcon /></WebuiIconButton> : null}
          {goal.status === "active" && !goal.executionWait ? <WebuiIconButton tone="bare" className="webui-goal-action" data-testid="thread-goal-banner-pause" label="暂停目标" title="暂停目标" onClick={() => submitPatch({ status: "paused" })} disabled={busy || interactionBlocked}><GoalPauseIcon /></WebuiIconButton> : null}
          {goal.status === "active" || goal.status === "paused" || goal.status === "blocked" ? <WebuiIconButton tone="bare" className="webui-goal-action" data-testid="thread-goal-banner-edit-button" label="编辑目标" title="编辑目标" onClick={() => onEditGoal(goal.objective)} disabled={busy || interactionBlocked}><WebuiIconContextRename /></WebuiIconButton> : null}
          {goal.status === "complete"
            ? <WebuiIconButton tone="bare" className="webui-goal-action" data-testid="thread-goal-banner-close" label="关闭完成标记" title="关闭完成标记" onClick={() => setDismissedGoalKey(goalKey)} disabled={busy}><WebuiIconClose /></WebuiIconButton>
            : <WebuiIconButton tone="bare" className="webui-goal-action" data-testid="thread-goal-banner-clear" label="清除目标" title="清除目标" onClick={() => setConfirmClear(true)} disabled={busy || interactionBlocked}><WebuiIconContextTrash /></WebuiIconButton>}
        </div>
      </div>
      {objectiveExpanded ? <div className="webui-goal-objective-expanded" data-testid="thread-goal-objective-expanded">{goal.objective}</div> : null}
      {error && !confirmClear ? <FeedbackError message={error} testId="thread-goal-error" /> : null}
      {clearDialog}
    </section>
  );
}
