// WebuiDiffCard — the diff-card renderer and the pure state machine that
// drives it.
//
// W3 tier 2 lift: the four diff-state helpers
// (`initialWebuiDiffState`, `reduceWebuiDiffState`,
// `buildWebuiDiffMutationRequest`, `confirmWebuiDiffMutation`) and the
// `WebuiDiffCard` component were moved verbatim out of `app.tsx`. The body
// is byte-identical to what used to live there; the lift is move-only.
// `app.tsx` keeps a thin re-export block so existing consumers
// (`webui-round3-acceptance.test.tsx`, importers via `app.tsx`) keep
// their current import path during the W3 wave.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { WebuiIconDiffFile, WebuiIconDiffSummary } from "../icons.js";
import type {
  WebuiGetTurnDiffRequest,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiTurnDiffView,
} from "../../shared/contracts/session.js";
import type { WebuiDiffState, WebuiDiffStateAction } from "../contracts/review-view.js";
import type { WebuiTransport } from "../contracts/transport.js";

/** Capability subset the diff card consumes. The contract lives in
 * `WebuiTransport`; this alias keeps the prop block compact and avoids
 * per-key `WebuiTransport["x"]` redeclarations. */
type WebuiDiffCardCapabilities = Pick<
  WebuiTransport,
  "getTurnDiff" | "revertTurnDiff" | "reapplyTurnDiff"
>;

export const initialWebuiDiffState: WebuiDiffState = {
  unsupported: false,
  busy: false,
  expanded: false,
  reviewing: false,
};

export function reduceWebuiDiffState(
  state: WebuiDiffState,
  action: WebuiDiffStateAction,
): WebuiDiffState {
  switch (action.type) {
    case "loaded":
      return { ...state, view: action.view, unsupported: false, busy: false, mutationError: undefined };
    case "unsupported":
      return { ...state, unsupported: true, busy: false, mutationError: undefined };
    /* A failed mutation is not an absent capability: the runtime answered, it
     * just declined this operation. Keeping `unsupported` false is what leaves
     * the card interactive, and `buildWebuiDiffMutationRequest` gating on
     * `unsupported` is what otherwise makes the first failure permanent. */
    case "mutation-failed":
      return { ...state, unsupported: false, busy: false, mutationError: trimmedOrUndefined(action.error) };
    case "begin-mutation":
      // A retry supersedes the previous reason; leaving it up would report a
      // stale failure next to an attempt that is still running.
      return state.busy ? state : { ...state, busy: true, mutationError: undefined };
    case "mutation-succeeded":
      return { ...state, view: action.view, unsupported: false, busy: false, mutationError: undefined };
    case "dismiss-mutation-error":
      return { ...state, mutationError: undefined };
    case "toggle-expanded":
      return { ...state, expanded: !state.expanded };
    case "toggle-review":
      return { ...state, reviewing: !state.reviewing };
  }
}

/** A blank or whitespace-only reason explains nothing, so it is dropped
 * rather than rendered as an empty banner. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/* What the runtime says when a revert or reapply does not apply, and what a
 * person can do about it.
 *
 * The reasons are machine tokens, and the authoritative one is
 * `applyLocalTurnDiffSnapshotMutation`'s `unsafe_path`. Read the runtime, not
 * the name: `normalizeCapturePath` *accepts* a path resolving outside the
 * workspace, and returns `undefined` for in-workspace paths the capture layer
 * filters (`.git/`, `node_modules/`, the root itself). The `safeCapturedPath`
 * check also sits inside the write loop, so the operation is NOT all-or-nothing
 * — earlier entries have already been written or `fs.rm`'d. The copy below
 * therefore says the run was interrupted and earlier files may have changed,
 * because that is what happened. Surfacing the raw token tells the user
 * nothing, and the other codes read the same way — `conflict` in particular
 * does not say that the files changed *after* the turn, which is the part that
 * matters.
 *
 * A reason not in this table is passed through unchanged. That is deliberate:
 * `git apply` failures arrive as free-form stderr, and discarding them would
 * replace a real message with a guess. */
const WEBUI_DIFF_FAILURE_COPY: Readonly<Record<string, string>> = {
  unsafe_path: "这轮改动里有文件的路径无法安全定位，操作已中断，之前处理过的文件可能已改动。",
  conflict: "这轮改动之后文件又被修改过，撤销前请先确认当前内容。",
  not_undoable: "这轮文件改动没有留下可撤销的快照。",
  "Turn diff not found": "找不到这轮文件改动。",
  "Only the latest turn diff can be changed": "只能撤销最近一轮的文件改动。",
  "Turn diff is not undoable": "这轮文件改动没有可撤销的补丁。",
};

export function describeWebuiDiffFailure(reason: string | undefined): string | undefined {
  const trimmed = trimmedOrUndefined(reason);
  if (!trimmed) return undefined;
  return WEBUI_DIFF_FAILURE_COPY[trimmed] ?? trimmed;
}

/** Decides what a revert/reapply round trip meant.
 *
 * The two operations nest the resulting view differently, and reading either
 * shape as success is a silent failure:
 *
 *  * `revertTurnDiff` answers `{ success?, error?, turnDiff? }` — the view
 *    lives under `turnDiff`, and a refusal carries only `error`.
 *  * `reapplyTurnDiff` answers with the view itself (`success` required,
 *    `error` optional), so for reapply the result *is* the next view.
 *
 * Two independent things are therefore checked: whether the runtime said it
 * worked, and whether it handed back an applied file list. A view with no
 * files applied nothing, and the card renders `null` for an empty file list,
 * so accepting one would delete the card with no message at all. */
export function resolveWebuiDiffMutation(
  action: "revert" | "reapply",
  result: WebuiRevertTurnDiffResult | WebuiReapplyTurnDiffResult | undefined,
  thrown?: unknown,
): WebuiDiffStateAction {
  if (thrown !== undefined) {
    const message = thrown instanceof Error ? thrown.message : undefined;
    return { type: "mutation-failed", error: describeWebuiDiffFailure(message) };
  }
  // `success` is required on reapply and optional on revert; an explicit
  // `false` is a refusal even if a view rode along beside it.
  if (result?.success === false) {
    return { type: "mutation-failed", error: describeWebuiDiffFailure(result.error) };
  }
  const nextView =
    action === "revert"
      ? (result as WebuiRevertTurnDiffResult | undefined)?.turnDiff
      : (result as WebuiReapplyTurnDiffResult | undefined);
  if (nextView && (nextView.fileChanges ?? []).length > 0) {
    return { type: "mutation-succeeded", view: nextView };
  }
  return { type: "mutation-failed", error: describeWebuiDiffFailure(result?.error) };
}

export function buildWebuiDiffMutationRequest(
  state: WebuiDiffState,
  request: WebuiGetTurnDiffRequest,
  action: "revert" | "reapply",
): WebuiRevertTurnDiffRequest | WebuiReapplyTurnDiffRequest | undefined {
  if (state.busy || state.unsupported || !state.view?.changeSetId) return undefined;
  if (action === "revert" && (state.view.status === "reverted" || state.view.canUndo === false)) return undefined;
  if (action === "reapply" && (state.view.status !== "reverted" || state.view.canReapply === false)) return undefined;
  return { ...request, changeSetId: state.view.changeSetId };
}

export function confirmWebuiDiffMutation(
  state: WebuiDiffState,
  confirmed: boolean,
): WebuiDiffState {
  return confirmed
    ? reduceWebuiDiffState(state, { type: "begin-mutation" })
    : state;
}

export function WebuiDiffCard({
  sessionId,
  assistantMessageId,
  turnId,
  changeSetId,
  initialView,
  initialState,
  getTurnDiff,
  revertTurnDiff,
  reapplyTurnDiff,
  onReview,
}: {
  readonly sessionId?: string;
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
  readonly initialView?: WebuiTurnDiffView;
  readonly initialState?: Partial<WebuiDiffState>;
  readonly onReview?: (view: WebuiTurnDiffView, selectedPath?: string) => void;
} & WebuiDiffCardCapabilities): ReactElement | null {
  const [diffState, setDiffState] = useState<WebuiDiffState>(() => ({
    ...initialWebuiDiffState,
    ...initialState,
    ...(initialView ? { view: initialView } : {}),
  }));
  const { view, unsupported, busy, expanded, reviewing, mutationError } = diffState;
  const request = useMemo<WebuiGetTurnDiffRequest | undefined>(() => {
    if (!sessionId || !getTurnDiff) return undefined;
    // The runtime keys a turn diff by the turn: an `assistantMessageId` is
    // answered only for the turn's LAST assistant message, and any other
    // message of the same turn yields an empty file list (it also wins over
    // `turnId` when both are sent). The rendered group is keyed by its first
    // message, so ask by turn whenever the group knows one.
    return {
      id: sessionId,
      ...(turnId ? { turnId } : assistantMessageId ? { assistantMessageId } : {}),
      ...(changeSetId ? { changeSetId } : {}),
    };
  }, [assistantMessageId, changeSetId, getTurnDiff, sessionId, turnId]);

  useEffect(() => {
    if (!request || !getTurnDiff) return undefined;
    let cancelled = false;
    void getTurnDiff(request)
      .then((nextView) => {
        if (!cancelled) setDiffState((current) => reduceWebuiDiffState(current, { type: "loaded", view: nextView }));
      })
      .catch(() => {
        // The runtime deliberately reports an unavailable diff capability as a
        // neutral card state. The client must not infer success from edit-tool
        // output when the authoritative application is unavailable.
        if (!cancelled) setDiffState((current) => reduceWebuiDiffState(current, { type: "unsupported" }));
      });
    return () => {
      cancelled = true;
    };
  }, [getTurnDiff, request]);

  const mutate = async (action: "revert" | "reapply") => {
    if (!request || busy) return;
    const handler = action === "revert" ? revertTurnDiff : reapplyTurnDiff;
    if (!handler) {
      setDiffState((current) => reduceWebuiDiffState(current, { type: "unsupported" }));
      return;
    }
    const confirmed = window.confirm(action === "revert" ? "撤销这轮文件改动？" : "重新应用这轮文件改动？");
    if (!confirmed) return;
    const mutationRequest = buildWebuiDiffMutationRequest(diffState, request, action);
    if (!mutationRequest) return;
    setDiffState((current) => confirmWebuiDiffMutation(current, confirmed));
    try {
      const result = await handler(mutationRequest);
      setDiffState((current) => reduceWebuiDiffState(current, resolveWebuiDiffMutation(action, result)));
    } catch (error) {
      setDiffState((current) => reduceWebuiDiffState(current, resolveWebuiDiffMutation(action, undefined, error)));
    } finally {
      setDiffState((current) => ({ ...current, busy: false }));
    }
  };

  if (unsupported)
    return (
      <div className="webui-diff-card webui-diff-card--neutral" data-webui-diff-card="true" data-webui-diff-state="runtime-unsupported">
        <span className="webui-diff-header-title">文件改动暂不可用</span>
        <span className="webui-diff-neutral-copy">当前运行时未提供 session diff 能力。</span>
      </div>
    );
  if ((!getTurnDiff || !request) && !view) return null;
  if (!view || (view.fileChanges ?? []).length === 0) return null;
  const files = view.fileChanges ?? [];
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
              {/* Desktop's diff card hides the deletion badge when no lines
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
          <button type="button" className="webui-diff-review" data-webui-diff-review="true" data-testid="turn-diff-review" onClick={() => { if (view) onReview?.(view); if (!onReview) setDiffState((current) => reduceWebuiDiffState(current, { type: "toggle-review" })); }}>
            {reviewing ? "关闭 Review" : "Review"}
          </button>
        </div>
      </div>
      <ul className="webui-diff-files">
        {shown.map((file) => (
          <li className="webui-diff-file" key={file.file} data-webui-diff-file="true" data-file-path={file.file}>
            <span className="webui-diff-file-icon" data-testid="turn-diff-file-icon"><WebuiIconDiffFile fileName={basenameOf(file.file)} /></span>
            <button type="button" className="webui-diff-file-name" data-testid="turn-diff-file-name" title={file.file} onClick={() => { if (view) onReview?.(view, file.file); }}>{basenameOf(file.file)}</button>
            <span className="webui-diff-file-stats" data-webui-diff-file-stats="true">
              <span className="webui-diff-add">{`+${file.additions}`}</span>
              {file.deletions > 0 ? <span className="webui-diff-del">{`-${file.deletions}`}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {files.length > 3 ? (
        <button type="button" className="webui-diff-expand" data-webui-diff-expand="true" data-testid="turn-diff-show-more" onClick={() => setDiffState((current) => reduceWebuiDiffState(current, { type: "toggle-expanded" }))}>
          {expanded ? "收起" : `展开其余 ${files.length - 3} 个`}
        </button>
      ) : null}
      {reviewing && !onReview ? (
        <div className="webui-diff-review-panel" data-webui-diff-review-panel="true">
          {files.map((file) => (
            <details key={`${file.file}-review`} open>
              <summary>{file.file}</summary>
              {file.diff ? <pre>{file.diff}</pre> : file.patch ? <pre>{JSON.stringify(file.patch, null, 2)}</pre> : <p>当前运行时没有提供该文件的 patch 预览。</p>}
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
          <button type="button" className="webui-diff-error-dismiss" data-testid="turn-diff-mutation-error-dismiss" onClick={() => setDiffState((current) => reduceWebuiDiffState(current, { type: "dismiss-mutation-error" }))}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
