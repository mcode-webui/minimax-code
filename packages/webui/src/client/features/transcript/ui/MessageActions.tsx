// Message-actions cluster — the per-message toolbar buttons, the feedback
// toggle, the row container, and the rewind preview dialog.
//
// Cluster map:
//   * `WebuiMessageActionButton` — single icon button
//   * `WebuiFeedbackActions`     — like / dislike pair
//   * `WebuiMessageActions`      — full action row (copy / rewind / edit / fork / timestamp)
//   * `WebuiRewindDialog`        — rewind preview modal
//   * helpers:
//       `WebuiMessageActionCapabilities` (type) lives in `features/transcript/contracts/transcript-view.ts`;
//         this cluster imports it rather than declaring it,
//       `WebuiCopyDependencies` (interface),
//       `toggleWebuiFeedback`,
//       `copyWebuiMessageText`,
//       `scheduleWebuiCopiedReset`,
//       `formatWebuiMessageTimestamp`

import { useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  WebuiIconMessageCopy,
  WebuiIconMessageCopied,
  WebuiIconMessageDislikeOff,
  WebuiIconMessageDislikeOn,
  WebuiIconMessageEdit,
  WebuiIconMessageEditUser,
  WebuiIconMessageFork,
  WebuiIconMessageLikeOff,
  WebuiIconMessageLikeOn,
  WebuiIconMessageRewind,
} from "../../../shell/icons.js";
import type { WebuiGetSessionRewindPreviewResult } from "../../../../shared/contracts/session.js";
import type { WebuiMessageActionCapabilities } from "../contracts/transcript-view.js";
import { formatWebuiMessageTimestamp } from "../projection/message-timestamp.js";
import { toggleWebuiFeedback, copyWebuiMessageText, scheduleWebuiCopiedReset } from "../application/message-feedback.js";
import type { WebuiCopyDependencies } from "../application/message-feedback.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";
import { FeedbackError } from "../../../ui/feedback.js";

export function WebuiMessageActionButton({
  testId,
  label,
  icon,
  onClick,
  disabled = false,
  active,
}: {
  readonly testId: string;
  readonly label: string;
  /** The action row is glyph-only: a 26px square holding a 16–18px icon. */
  readonly icon: ReactElement;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Selection state for the feedback toggles; the active glyph is painted differently. */
  readonly active?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`webui-message-action${active ? " webui-message-action-active" : ""}`}
      data-testid={testId}
      aria-label={label}
      title={label}
      {...(active === undefined ? {} : { "aria-pressed": active })}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function WebuiFeedbackActions({
  value,
  onChange,
}: {
  readonly value?: "like" | "dislike";
  readonly onChange: (value: "like" | "dislike") => void;
}): ReactElement {
  return (
    <span className="webui-message-feedback" data-testid="message-feedback-actions">
      <span data-testid="message-feedback-like">
        <WebuiMessageActionButton
          testId="message-feedback-like-action"
          label="赞"
          icon={value === "like" ? <WebuiIconMessageLikeOn size={18} /> : <WebuiIconMessageLikeOff size={18} />}
          active={value === "like"}
          onClick={() => onChange(toggleWebuiFeedback(value, "like"))}
        />
      </span>
      <span data-testid="message-feedback-dislike">
        <WebuiMessageActionButton
          testId="message-feedback-dislike-action"
          label="踩"
          icon={value === "dislike" ? <WebuiIconMessageDislikeOn size={18} /> : <WebuiIconMessageDislikeOff size={18} />}
          active={value === "dislike"}
          onClick={() => onChange(toggleWebuiFeedback(value, "dislike"))}
        />
      </span>
    </span>
  );
}

export function WebuiMessageActions({
  role,
  messageId,
  copyText,
  actions,
  onRewind,
  onEdit,
  onFork,
  timestamp,
}: {
  readonly role: "user" | "assistant";
  readonly messageId: string;
  readonly copyText: string;
  readonly actions?: WebuiMessageActionCapabilities;
  readonly onRewind?: () => void;
  readonly onEdit?: () => void;
  readonly onFork?: () => void;
  /** Epoch ms; printed inside the action row. */
  readonly timestamp?: number;
}): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"like" | "dislike">();
  const copy = async () => {
    try {
      const copied = await copyWebuiMessageText(copyText, {
        ...(typeof navigator !== "undefined" && navigator.clipboard
          ? { clipboard: navigator.clipboard }
          : {}),
        ...(dom.portalTarget()
          ? { fallback: () => dom.copyTextFallback(copyText) }
          : {}),
      });
      if (copied) {
        setCopied(true);
        scheduleWebuiCopiedReset(setCopied, window.setTimeout);
      } else setCopied(false);
    } catch {
      setCopied(false);
    }
  };
  const timestampLabel = formatWebuiMessageTimestamp(timestamp);
  const copyIcon = copied ? <WebuiIconMessageCopied size={18} /> : <WebuiIconMessageCopy size={18} />;
  return (
    <div
      className={`webui-message-actions ${role === "user" ? "webui-user-message-actions" : ""}`}
      data-testid={role === "user" ? "user-message-actions" : "message-actions"}
      data-message-id={messageId}
    >
      {role === "user" ? (
        <>
          {timestampLabel ? (
            <span className="webui-message-timestamp" data-testid="user-message-timestamp">{timestampLabel}</span>
          ) : null}
          {actions?.rewind && onRewind ? (
            <WebuiMessageActionButton testId="user-message-rewind-button" label="回退" icon={<WebuiIconMessageRewind size={18} />} onClick={onRewind} />
          ) : null}
          {(actions?.edit ?? actions?.rewind) && onEdit ? (
            <WebuiMessageActionButton testId="user-message-edit-button" label="编辑" icon={<WebuiIconMessageEditUser size={18} />} onClick={onEdit} />
          ) : null}
          {copyText ? (
            <WebuiMessageActionButton testId="user-message-copy-button" label={copied ? "已复制" : "复制"} icon={copyIcon} onClick={() => void copy()} />
          ) : null}
        </>
      ) : (
        <>
          <WebuiMessageActionButton testId="message-copy-button" label={copied ? "已复制" : "复制"} icon={copyIcon} onClick={() => void copy()} />
          {actions?.rewind && onRewind ? (
            <WebuiMessageActionButton testId="message-rewind-button" label="回退" icon={<WebuiIconMessageRewind size={16} />} onClick={onRewind} />
          ) : null}
          {(actions?.edit ?? actions?.rewind) && onEdit ? (
            <WebuiMessageActionButton testId="message-edit-button" label="编辑" icon={<WebuiIconMessageEdit size={16} />} onClick={onEdit} />
          ) : null}
          <WebuiFeedbackActions value={feedback} onChange={setFeedback} />
          {actions?.fork && onFork ? (
            <WebuiMessageActionButton testId="message-fork-button" label="复制为新会话" icon={<WebuiIconMessageFork size={18} />} onClick={onFork} />
          ) : null}
          {timestampLabel ? (
            <span className="webui-message-timestamp" data-testid="message-timestamp">{timestampLabel}</span>
          ) : null}
        </>
      )}
    </div>
  );
}

export function WebuiRewindDialog({
  messageId,
  preview,
  loading,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  readonly messageId: string;
  readonly preview?: WebuiGetSessionRewindPreviewResult;
  readonly loading: boolean;
  readonly error?: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (rewindTurnDiff: boolean) => void;
}): ReactElement {
  // A modal layer: the rewind preview answers its own dismissal.
  const layerId = useDialogLayer({ id: "rewind-dialog", onClose });
  const { dom } = useWebuiBrowserCapabilities();
  const files = preview?.turns.flatMap((turn) => turn.files) ?? [];
  const turns = preview?.turns.length ?? 1;
  const dialog = (
    <div className="webui-message-dialog" data-overlay-layer={layerId} role="dialog" aria-modal="true" data-testid="rewind-preview-dialog" data-message-id={messageId}>
      <div className="webui-message-dialog-surface">
        <h3>{"回退"}</h3>
        <p>{files.length > 0 ? `${turns} 轮对话将会回退 · ${files.length} 个文件将被修改。` : `${turns} 轮对话将会回退，不涉及任何文件改动。`}</p>
        <section data-testid="rewind-preview-files">
          <h4>受影响的文件改动</h4>
          {loading ? <p>正在检查当前文件…</p> : null}
          {!loading && error ? <FeedbackError message={<>暂时无法读取文件预览，仍可选择仅回退对话。</>} /> : null}
          {!loading && !error && files.length === 0 ? <p>没有受影响的文件改动。</p> : null}
          {files.map((file) => <div key={`${file.filePath}-${file.action}`} className="webui-rewind-file-row"><span>{file.filePath}</span><span>{file.skipped ? "跳过" : file.action}</span></div>)}
        </section>
        <div className="webui-message-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" onClick={() => onConfirm(false)} disabled={busy} data-testid="rewind-confirm-only">仅回退对话</button>
          {files.length > 0 ? <button type="button" onClick={() => onConfirm(true)} disabled={busy} data-testid="rewind-confirm-with-files" data-action-variant="danger">回退对话和文件</button> : null}
        </div>
      </div>
    </div>
  );
  const portalTarget = dom.portalTarget();
  return portalTarget ? createPortal(dialog, portalTarget) : dialog;
}
