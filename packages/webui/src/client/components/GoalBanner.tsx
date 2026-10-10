// WebuiGoalBanner — the thread-level goal banner (status, edit, clear).
//
// W3 tier 3 lift: this component owns the session-scoped goal card. Its
// transport calls stay on the existing WebUI goal contract while the visual
// surface follows Desktop's compact status/actions layout.

import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  formatWebuiGoalDuration,
  WEBUI_GOAL_STATUS_COPY,
  WEBUI_GOAL_WAIT_COPY,
} from "../projection/goal-state.js";
import type {
  WebuiGoal,
  WebuiGoalStatus,
} from "../../shared/contracts/goal.js";
import type { WebuiTransport } from "../contracts/transport.js";

/** Capability subset the goal banner consumes. Single source of truth lives
 *  in `WebuiTransport`; this alias keeps the prop block free of per-key
 *  `WebuiTransport["x"]` redeclarations. */
type WebuiGoalBannerCapabilities = Pick<WebuiTransport, "patchGoal" | "clearGoal">;
import {
  WebuiIconCommandGoal,
  WebuiIconClose,
  WebuiIconContextRename,
  WebuiIconContextTrash,
} from "../icons.js";

function GoalPauseIcon(): ReactElement {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="M6 4.5v11M14 4.5v11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

function GoalResumeIcon(): ReactElement {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="m7 4.5 8 5.5-8 5.5v-11Z" fill="currentColor" /></svg>;
}

export function WebuiGoalClearDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  return (
    <div
      className="webui-message-dialog webui-goal-clear-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="goal-clear-confirm-title"
      aria-describedby="goal-clear-confirm-description"
      data-testid="goal-clear-confirm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section className="webui-goal-clear-dialog-surface">
        <header className="webui-goal-clear-dialog-heading">
          <h2 id="goal-clear-confirm-title">删除目标？</h2>
          <button type="button" aria-label="关闭" title="关闭" onClick={onCancel} disabled={busy}>
            <WebuiIconClose />
          </button>
        </header>
        <p id="goal-clear-confirm-description">删除目标后，目标模式会关闭，转为普通模式继续。</p>
        {error ? <p className="webui-goal-clear-dialog-error" role="alert" data-testid="goal-clear-error">{error}</p> : null}
        <div className="webui-goal-clear-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" data-testid="goal-clear-confirm-confirm" onClick={onConfirm} disabled={busy}>
            {busy ? "删除中…" : "删除"}
          </button>
        </div>
      </section>
    </div>
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
} & WebuiGoalBannerCapabilities): ReactElement | null {
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
    if (!confirmClear) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setConfirmClear(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmClear, busy]);
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
      onCancel={() => { setConfirmClear(false); setError(undefined); }}
      onConfirm={clear}
    />
    : null;
  return (
    <section className="webui-goal-banner" data-testid="thread-goal-banner" data-goal-status={status} role="status" aria-live="polite">
      <div className="webui-goal-banner-row">
        <div className="webui-goal-banner-leading">
          <span className="webui-goal-banner-icon" aria-hidden="true"><WebuiIconCommandGoal /></span>
          <span className="webui-goal-status" data-testid="thread-goal-banner-status">{statusCopy}</span>
        </div>
        <div className="webui-goal-banner-content-row" data-testid="thread-goal-banner-content-row">
          <div className="webui-goal-banner-objective-group" data-testid="thread-goal-banner-objective-group">
            <button type="button" className="webui-goal-objective" data-testid="thread-goal-banner-objective" aria-expanded={objectiveExpanded} title={goal.objective} onClick={() => setObjectiveExpanded((value) => !value)}>{goal.objective}</button>
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
          {goal.status === "blocked" || goal.status === "paused" || goal.status === "usage_limited" ? <button type="button" className="webui-goal-action" data-testid="thread-goal-banner-resume" aria-label="继续目标" title="继续目标" onClick={() => submitPatch({ status: "active" })} disabled={busy || interactionBlocked}><GoalResumeIcon /></button> : null}
          {goal.status === "active" && !goal.executionWait ? <button type="button" className="webui-goal-action" data-testid="thread-goal-banner-pause" aria-label="暂停目标" title="暂停目标" onClick={() => submitPatch({ status: "paused" })} disabled={busy || interactionBlocked}><GoalPauseIcon /></button> : null}
          {goal.status === "active" || goal.status === "paused" || goal.status === "blocked" ? <button type="button" className="webui-goal-action" data-testid="thread-goal-banner-edit-button" aria-label="编辑目标" title="编辑目标" onClick={() => onEditGoal(goal.objective)} disabled={busy || interactionBlocked}><WebuiIconContextRename /></button> : null}
          {goal.status === "complete"
            ? <button type="button" className="webui-goal-action" data-testid="thread-goal-banner-close" aria-label="关闭完成标记" title="关闭完成标记" onClick={() => setDismissedGoalKey(goalKey)} disabled={busy}><WebuiIconClose /></button>
            : <button type="button" className="webui-goal-action" data-testid="thread-goal-banner-clear" aria-label="清除目标" title="清除目标" onClick={() => setConfirmClear(true)} disabled={busy || interactionBlocked}><WebuiIconContextTrash /></button>}
        </div>
      </div>
      {objectiveExpanded ? <div className="webui-goal-objective-expanded" data-testid="thread-goal-objective-expanded">{goal.objective}</div> : null}
      {error && !confirmClear ? <p role="alert" data-testid="thread-goal-error">{error}</p> : null}
      {clearDialog
        ? typeof document !== "undefined" ? createPortal(clearDialog, document.body) : clearDialog
        : null}
    </section>
  );
}
