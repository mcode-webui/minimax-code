// MessageItem — the single message renderer shared by persisted history and
// the live turn.
//
// The component consumes the narrowed `WebuiTurnView` (union of
// `WebuiHistoricalTurnView` and `WebuiLiveTurnView`) as the data source.
// Side-specific fields (`initialDiff`, `streaming`, `processSegments`, …)
// are accessed via narrow on `view.source`. The previous per-field legacy
// prop block was deleted (E-revise-DG-02 narrow); the runtime contract is
// now view-only.
//
// The shell still decides which source owns the turn (history after done,
// composer while active), but the DOM for either role is produced here.

import { useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import type {
  WebuiGetSessionForkOptionsResult,
  WebuiGetSessionRewindPreviewResult,
} from "../../shared/contracts/session.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type { WebuiMessageFileReference } from "../projection/message-file-reference.js";
import type { WorkspacePanelCommand } from "../projection/workspace-panel-state.js";
import type {
  WebuiHistoricalTurnView,
  WebuiLiveTurnView,
  WebuiTurnView,
} from "../projection/transcript-shape.js";

/** Capability subset the message item consumes. Single source of truth
 *  lives in `WebuiTransport`; this alias keeps the prop block free of
 *  per-key `WebuiTransport["x"]` redeclarations. */
type WebuiMessageItemCapabilities = Pick<
  WebuiTransport,
  | "getTurnDiff"
  | "revertTurnDiff"
  | "reapplyTurnDiff"
  | "getSessionForkOptions"
  | "forkSession"
  | "getSessionRewindPreview"
  | "rewindSession"
  | "editSessionMessage"
>;
import { WebuiAssistantBody } from "./AssistantBody.js";
import { WebuiIconCommandGoal } from "../icons.js";
import {
  WebuiMessageActions,
  WebuiRewindDialog,
} from "./MessageActions.js";
import {
  buildWebuiEditRequest,
  buildWebuiMessageForkRequest,
  buildWebuiRewindRequest,
  webuiClientRequestId,
} from "../projection/action-requests.js";

/**
 * The single message renderer shared by persisted history and the live turn.
 * Data flows in exclusively through `view`; no per-field legacy props.
 *
 * The single remaining non-view prop is `wallClockDurationMs` — it is
 * group-level (sum-of-frame span across the assistant group), not a
 * per-message fact. Neither adapter can produce it; `SessionTranscript`
 * computes it on the group and passes it here. Documented in
 * `transcript-shape.ts:170-180`.
 */
export function MessageItem({
  view,
  wallClockDurationMs,
  getTurnDiff,
  revertTurnDiff,
  reapplyTurnDiff,
  getSessionForkOptions,
  forkSession,
  getSessionRewindPreview,
  rewindSession,
  editSessionMessage,
  workspaceDir,
  onOpenFile,
  onOpenTurnReview,
}: {
  /** Narrowed leaf-renderer input (historical or live). */
  readonly view: WebuiTurnView;
  /** Group-level turn duration; computed by SessionTranscript's group collapse. */
  readonly wallClockDurationMs?: number;
  readonly workspaceDir?: string;
  readonly onOpenFile?: (input: { readonly sessionId: string; readonly workspaceDir: string; readonly reference: WebuiMessageFileReference }) => void;
  readonly onOpenTurnReview?: (command: Extract<WorkspacePanelCommand, { type: "open-turn-review" }>) => void;
} & WebuiMessageItemCapabilities): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  // Narrowing: historical view can read historical-only fields; live view
  // can read live-only fields. The union member types live in
  // `transcript-shape.ts`.
  const messageId = view.messageId;
  const role = view.role;
  const isHistorical = view.source === "historical";
  const historicalView: WebuiHistoricalTurnView | undefined = isHistorical
    ? view
    : undefined;
  const liveView: WebuiLiveTurnView | undefined = !isHistorical
    ? view
    : undefined;
  // Shared fields are read directly from the union base.
  const sessionId = view.sessionId;
  const userText = view.userText;
  const thinking = view.thinking;
  const tools = view.tools;
  const answers = view.answers;
  const timestamp = view.timestamp;
  const isGoal = view.isGoal;
  const totalRequestDurationMs = view.totalRequestDurationMs;
  const totalOutputTokens = view.totalOutputTokens;
  // Historical-only (Plan A: `turnId` / `thinkingDurationMs` /
  // `initialDiff` / `actions` / `attachments`).
  const turnId = historicalView?.turnId;
  const processForceExpanded = historicalView?.processForceExpanded;
  const thinkingDurationMs = historicalView?.thinkingDurationMs;
  const initialDiff = historicalView?.initialDiff;
  const actions = historicalView?.actions;
  const attachments = historicalView?.attachments;
  // Live-only fields. `processSegments` is shared on the view because
  // history supplies it at group level and the live adapter supplies it.
  const assistantMessageId = liveView?.assistantMessageId;
  const streaming = liveView?.streaming;
  const streamMessageId = liveView?.streamMessageId;
  const messageRootId = liveView?.messageRootId;
  const processingStartedAtMs = liveView?.processingStartedAtMs;
  const processSegments = view.processSegments;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(userText ?? "");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPreview, setRewindPreview] = useState<WebuiGetSessionRewindPreviewResult>();
  const [rewindLoading, setRewindLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string>();
  const [forkTitle, setForkTitle] = useState("");
  const [forkOpen, setForkOpen] = useState(false);
  const [forkOptions, setForkOptions] = useState<WebuiGetSessionForkOptionsResult>();
  const openRewind = () => {
    setRewindOpen(true);
    setRewindPreview(undefined);
    setMutationError(undefined);
    if (!sessionId || !getSessionRewindPreview) return;
    setRewindLoading(true);
    void getSessionRewindPreview({ id: sessionId, userMessageId: messageId })
      .then(setRewindPreview)
      .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRewindLoading(false));
  };
  const confirmRewind = (rewindTurnDiff: boolean) => {
    if (!sessionId || !rewindSession) return;
    setMutationBusy(true);
    void rewindSession(buildWebuiRewindRequest(sessionId, messageId, webuiClientRequestId("rewind"), rewindTurnDiff))
      .then(() => { setRewindOpen(false); })
      .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)))
      .finally(() => setMutationBusy(false));
  };
  const submitEdit = () => {
    if (!sessionId || !editSessionMessage) return;
    const request = buildWebuiEditRequest(sessionId, messageId, webuiClientRequestId("edit"), editText);
    if (!request) return;
    setMutationBusy(true);
    void editSessionMessage(request)
      .then(() => { setEditing(false); })
      .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)))
      .finally(() => setMutationBusy(false));
  };
  const confirmFork = () => {
    if (!sessionId || !forkSession || forkOptions?.canFork === false) return;
    setMutationBusy(true);
    void forkSession(buildWebuiMessageForkRequest(sessionId, messageId, webuiClientRequestId("fork"), forkTitle))
      .then(() => { setForkOpen(false); })
      .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)))
      .finally(() => setMutationBusy(false));
  };
  const openFork = () => {
    setForkOpen(true);
    setForkOptions(undefined);
    if (!sessionId || !getSessionForkOptions) return;
    void getSessionForkOptions({ id: sessionId, assistantMessageId: assistantMessageId ?? messageId })
      .then((nextOptions) => {
        setForkOptions(nextOptions);
        if (nextOptions.suggestedTitle) setForkTitle(nextOptions.suggestedTitle);
      })
      .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)));
  };
  const actionProps = {
    role,
    messageId,
    copyText: role === "user" ? userText ?? "" : answers?.join("\n\n") ?? "",
    actions,
    onRewind: role === "user" ? openRewind : undefined,
    onEdit: role === "user" ? () => { setEditText(userText ?? ""); setEditing(true); } : undefined,
    onFork: role === "assistant" ? openFork : undefined,
    timestamp,
  };
  const forkDialog = forkOpen ? (
    <div className="webui-message-dialog" role="dialog" aria-modal="true" data-testid="fork-dialog">
      <div className="webui-message-dialog-surface">
        <h3>复制为新会话</h3>
        <p>{forkOptions?.unavailableReason ?? "保留当前上下文，在新会话中继续"}</p>
        <input aria-label="会话名称" value={forkTitle} onChange={(event) => setForkTitle(event.target.value)} placeholder="使用简短且不同的名称，便于识别" disabled={forkOptions?.canFork === false} />
        <div className="webui-message-dialog-actions">
          <button type="button" onClick={() => setForkOpen(false)} disabled={mutationBusy}>取消</button>
          <button type="button" onClick={confirmFork} disabled={mutationBusy || forkOptions?.canFork === false}>复制并进入</button>
        </div>
      </div>
    </div>
  ) : null;
  const portalTarget = dom.portalTarget();
  const renderedForkDialog = forkDialog && portalTarget
    ? createPortal(forkDialog, portalTarget)
    : forkDialog;
  if (role === "user") {
    return (
      <div
        className="webui-message message-animate-in group relative"
        data-webui-stream-message={streamMessageId}
        data-webui-message-root={messageRootId ?? messageId}
        data-webui-message-role="user"
        data-testid="message-item"
        data-role="user"
        data-message-id={messageId}
        data-webui-goal-message={isGoal ? "true" : undefined}
        data-message-timestamp={timestamp}
      >
        <div className="flex w-full justify-end">
          <div className="flex w-full flex-col items-end gap-spacing_8">
            {editing ? (
              <div className="webui-user-inline-editor" data-testid="user-message-inline-editor">
                <textarea aria-label="编辑" value={editText} onChange={(event) => setEditText(event.target.value)} autoFocus />
                <div className="webui-inline-editor-actions"><button type="button" onClick={() => setEditing(false)} disabled={mutationBusy}>取消</button><button type="button" onClick={submitEdit} disabled={mutationBusy || !editText.trim()}>发送</button></div>
              </div>
            ) : <div
              className="webui-user-bubble rounded-[16px] px-3 py-2 max-w-[80%]"
              data-webui-user-bubble="true"
            >
              <div className="webui-user-text-clamp">
                <p
                  className="webui-user-text"
                  data-webui-message-kind="user"
                  data-webui-user-text="true"
                >
                  {isGoal ? (
                    <span className="webui-user-goal-label" data-webui-goal-label="true">
                      <WebuiIconCommandGoal aria-hidden="true" />
                      <span>Goal</span>
                    </span>
                  ) : null}
                  <span>{userText ?? ""}</span>
                </p>
              </div>
            </div>}
            {!editing ? <WebuiMessageActions {...actionProps} /> : null}
            {rewindOpen ? <WebuiRewindDialog messageId={messageId} preview={rewindPreview} loading={rewindLoading} error={mutationError} busy={mutationBusy} onClose={() => setRewindOpen(false)} onConfirm={confirmRewind} /> : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="webui-message message-animate-in group relative"
      data-webui-stream-message={streamMessageId}
      data-webui-message-root={messageRootId ?? messageId}
      data-webui-message-role="assistant"
      data-testid="message-item"
      data-role="assistant"
      data-message-id={messageId}
    >
      <WebuiAssistantBody
        messageId={messageId}
        sessionId={sessionId}
        workspaceDir={workspaceDir}
        onOpenFile={(reference) => { if (sessionId && workspaceDir) onOpenFile?.({ sessionId, workspaceDir, reference }); }}
        onOpenTurnReview={(review, selectedPath) => {
          if (!sessionId || !workspaceDir) return;
          onOpenTurnReview?.({ type: "open-turn-review", sessionId, workspaceDir, messageId, assistantMessageId: review.sourceMessageId ?? assistantMessageId ?? messageId, ...(turnId ? { turnId } : {}), ...(review.changeSetId ? { changeSetId: review.changeSetId } : {}), files: review.fileChanges, ...(selectedPath ? { selectedPath } : {}) });
        }}
        assistantMessageId={assistantMessageId ?? initialDiff?.sourceMessageId ?? messageId}
        turnId={turnId}
        changeSetId={initialDiff?.changeSetId}
        initialDiff={initialDiff}
        getTurnDiff={getTurnDiff}
        revertTurnDiff={revertTurnDiff}
        reapplyTurnDiff={reapplyTurnDiff}
        thinking={thinking}
        thinkingDurationMs={thinkingDurationMs}
        tools={tools}
        answers={answers ?? []}
        attachments={attachments}
        streaming={streaming}
        processingStartedAtMs={processingStartedAtMs}
        totalRequestDurationMs={totalRequestDurationMs}
        totalOutputTokens={totalOutputTokens}
        wallClockDurationMs={wallClockDurationMs}
        processSegments={processSegments}
        processForceExpanded={processForceExpanded}
      />
      <WebuiMessageActions {...actionProps} />
      {renderedForkDialog}
      {mutationError && !rewindOpen && !forkOpen ? <p role="alert" className="webui-message-mutation-error">{mutationError}</p> : null}
    </div>
  );
}
