// WebuiDiffCard — the diff-card renderer.
//
// It renders; it does not own the query or the mutation. Those belong to the
// review owner: the card asks the owner for a turn and the owner answers with
// whatever the runtime said — an answer a second surface asked for is the same
// answer. What stays here is presentation: which files are shown, whether the
// review panel is open, and the confirmation.
//
// The runtime keys a turn diff by the turn: an `assistantMessageId` is answered
// only for the turn's LAST assistant message, and any other message of the same
// turn yields an empty file list (it also wins over `turnId` when both are sent).
// The rendered group is keyed by its first message, so the card asks by turn
// whenever the group knows one.

import { useState, type ReactElement } from "react";
import { WebuiIconDiffFile, WebuiIconDiffSummary } from "../../../shell/icons.js";
import type { WebuiTurnDiffView } from "../../../../shared/contracts/session.js";
import type { WebuiDiffState } from "../../review/contracts/review-view.js";
import { useWebuiTurnReview } from "../../review/bindings/use-turn-review.public.js";
import {
  projectWebuiDiffFiles,
  WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE,
} from "../../../projection/common/diff-workspace-boundary.js";

export function WebuiDiffCard({
  sessionId,
  workspaceDir,
  assistantMessageId,
  turnId,
  changeSetId,
  initialView,
  initialState,
  onReview,
}: {
  readonly sessionId?: string;
  /** The session's workspace root. It is what the boundary is judged against;
   *  without it the entries are shown as they are. */
  readonly workspaceDir?: string;
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
  readonly initialView?: WebuiTurnDiffView;
  readonly initialState?: Partial<WebuiDiffState>;
  readonly onReview?: (view: WebuiTurnDiffView, selectedPath?: string) => void;
}): ReactElement | null {
  // Presentation, owned here and nowhere else: the expansion and review-panel
  // state are local.
  const [expanded, setExpanded] = useState(initialState?.expanded ?? false);
  const [reviewing, setReviewing] = useState(initialState?.reviewing ?? false);
  const { state: reviewState, mutate: runMutation, dismissError } = useWebuiTurnReview(
    sessionId
      ? {
          sessionId,
          ...(turnId ? { turnId } : {}),
          ...(assistantMessageId ? { assistantMessageId } : {}),
          ...(changeSetId ? { changeSetId } : {}),
        }
      : undefined,
  );
  // The owner's answer, or the seed the caller passed for a first render (an
  // SSR pass, or the shell's initial markup). The seed is an initial value, not
  // a second owner: once the owner has an answer for the turn, that is the one.
  const view = reviewState.view ?? initialView;
  const unsupported = reviewState.unsupported || (initialState?.unsupported ?? false);
  const busy = reviewState.busy;
  const mutationError = reviewState.mutationError ?? initialState?.mutationError;

  const mutate = (action: "revert" | "reapply") => {
    if (busy) return;
    // The confirmation is the card's: the owner is told what to do, not how it
    // was agreed.
    const confirmed = window.confirm(action === "revert" ? "撤销这轮文件改动？" : "重新应用这轮文件改动？");
    if (!confirmed) return;
    runMutation(action);
  };

  if (unsupported)
    return (
      <div className="webui-diff-card webui-diff-card--neutral" data-webui-diff-card="true" data-webui-diff-state="runtime-unsupported">
        <span className="webui-diff-header-title">文件改动暂不可用</span>
        <span className="webui-diff-neutral-copy">当前运行时未提供 session diff 能力。</span>
      </div>
    );
  if (!view) return null;
  if (!view || (view.fileChanges ?? []).length === 0) return null;
  // The workspace boundary is applied to the entries themselves, not to the
  // markup below: a file outside the workspace arrives here without a body, so
  // there is nothing for the renderer to leak even if it forgets to ask.
  const files = projectWebuiDiffFiles(view.fileChanges, workspaceDir);
  const shown = expanded ? files : files.slice(0, 3);
  const totalAdded = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeleted = files.reduce((sum, file) => sum + file.deletions, 0);
  const reverted = view.status === "reverted";
  const basenameOf = (path: string): string => {
    if (!path) return "";
    const normalized = path.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    return idx === -1 ? normalized : normalized.slice(idx + 1);
  };
  return (
    <div
      className="webui-diff-card"
      data-webui-diff-card="true"
      data-testid="turn-diff-card"
      data-webui-diff-state={view.status ?? "active"}
      data-change-set-id={view.changeSetId}
      data-source-message-id={view.sourceMessageId ?? assistantMessageId}
    >
      <div className="webui-diff-header">
        <div className="webui-diff-summary" data-testid="turn-diff-summary">
          <span className="webui-diff-icon" aria-hidden="true"><WebuiIconDiffSummary /></span>
          <span className="webui-diff-header-content">
            <span className="webui-diff-header-title">{`已编辑 ${files.length} 个文件`}</span>
            <span className="webui-diff-header-stats" data-webui-diff-stats="true">
              <span className="webui-diff-add">{`+${totalAdded}`}</span>
              {/* The diff card hides the deletion badge when no lines
               * were removed from the change set — keeping the row additions-only
               * avoids the misleading "+{n}-0" stat the WebUI used to render. */}
              {totalDeleted > 0 ? <span className="webui-diff-del">{`-${totalDeleted}`}</span> : null}
            </span>
          </span>
        </div>
        <span className="webui-diff-header-divider" aria-hidden="true" />
        <div className="webui-diff-actions">
          {reverted ? (
            <button type="button" className="webui-diff-reapply" data-testid="turn-diff-undo" disabled={busy || view.canReapply === false} onClick={() => void mutate("reapply")}>
              重新应用
            </button>
          ) : (
            <button type="button" className="webui-diff-revert" data-testid="turn-diff-undo" disabled={busy || view.canUndo === false} onClick={() => void mutate("revert")}>
              撤销
            </button>
          )}
          <button type="button" className="webui-diff-review" data-webui-diff-review="true" data-testid="turn-diff-review" onClick={() => { if (view) onReview?.(view); if (!onReview) setReviewing((open) => !open); }}>
            {reviewing ? "关闭 Review" : "Review"}
          </button>
        </div>
      </div>
      <ul className="webui-diff-files">
        {shown.map((file) => (
          <li className="webui-diff-file" key={file.file} data-webui-diff-file="true" data-file-path={file.file} data-webui-diff-outside-workspace={file.withinWorkspace ? undefined : "true"}>
            <span className="webui-diff-file-icon" data-testid="turn-diff-file-icon"><WebuiIconDiffFile fileName={basenameOf(file.file)} /></span>
            <button type="button" className="webui-diff-file-name" data-testid="turn-diff-file-name" title={file.file} onClick={() => { if (view) onReview?.({ ...view, fileChanges: files }, file.file); }}>{basenameOf(file.file)}</button>
            <span className="webui-diff-file-stats" data-webui-diff-file-stats="true">
              <span className="webui-diff-add">{`+${file.additions}`}</span>
              {file.deletions > 0 ? <span className="webui-diff-del">{`-${file.deletions}`}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {files.length > 3 ? (
        <button type="button" className="webui-diff-expand" data-webui-diff-expand="true" data-testid="turn-diff-show-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起" : `展开其余 ${files.length - 3} 个`}
        </button>
      ) : null}
      {reviewing && !onReview ? (
        <div className="webui-diff-review-panel" data-webui-diff-review-panel="true">
          {files.map((file) => (
            <details key={`${file.file}-review`} open>
              <summary>{file.file}</summary>
              {file.withinWorkspace
                ? file.diff ? <pre>{file.diff}</pre> : file.patch ? <pre>{JSON.stringify(file.patch, null, 2)}</pre> : <p>当前运行时没有提供该文件的 patch 预览。</p>
                : <p data-testid="turn-diff-outside-workspace">{WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE}</p>}
            </details>
          ))}
        </div>
      ) : null}
      {mutationError ? (
        /* `role="alert"` because this replaces what used to be no feedback at
         * all: the operation did nothing, and the file list above is now known
         * to be out of date. The controls stay live so the user can retry. */
        <div className="webui-diff-error" role="alert" data-webui-diff-error="true" data-testid="turn-diff-mutation-error">
          <span className="webui-diff-error-copy">
            <span className="webui-diff-error-title">这轮文件改动没有生效</span>
            <span className="webui-diff-error-reason" data-testid="turn-diff-mutation-error-reason">{mutationError}</span>
          </span>
          <button type="button" className="webui-diff-error-dismiss" data-testid="turn-diff-mutation-error-dismiss" onClick={dismissError}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
