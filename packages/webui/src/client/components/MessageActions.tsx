// Message-actions cluster — the per-message toolbar buttons, the feedback
// toggle, the row container, and the rewind preview dialog.
//
// W3 tier 2 lift: this cluster (4 components + 5 helpers/types) was moved
// verbatim out of `app.tsx`. The bodies are byte-identical to what used to
// live there; the lift is move-only. `app.tsx` keeps a thin re-export block
// so existing consumers (`webui-round3-acceptance.test.tsx`, importers via
// `app.tsx`) keep their current import path during the W3 wave.
//
// Cluster map:
//   * `WebuiMessageActionButton` — single icon button
//   * `WebuiFeedbackActions`     — like / dislike pair
//   * `WebuiMessageActions`      — full action row (copy / rewind / edit / fork / timestamp)
//   * `WebuiRewindDialog`        — rewind preview modal
//   * helpers:
//       `WebuiMessageActionCapabilities` (type) lives in `contracts/transcript-view.ts`;
//         this cluster imports it rather than declaring it (plan §3),
//       `WebuiCopyDependencies` (interface),
//       `toggleWebuiFeedback`,
//       `copyWebuiMessageText`,
//       `scheduleWebuiCopiedReset`,
//       `formatWebuiMessageTimestamp`

import { useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
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
} from "../icons.js";
import type { WebuiGetSessionRewindPreviewResult } from "../../shared/contracts/session.js";
import type { WebuiMessageActionCapabilities } from "../contracts/transcript-view.js";

export function toggleWebuiFeedback(
  value: "like" | "dislike" | undefined,
  next: "like" | "dislike",
): "like" | "dislike" {
  return value === next ? (next === "like" ? "dislike" : "like") : next;
}

export interface WebuiCopyDependencies {
  readonly clipboard?: { readonly writeText: (value: string) => Promise<void> };
  readonly fallback?: () => void;
}

export async function copyWebuiMessageText(
  value: string,
  dependencies: WebuiCopyDependencies,
): Promise<boolean> {
  try {
    if (dependencies.clipboard) await dependencies.clipboard.writeText(value);
    else if (dependencies.fallback) dependencies.fallback();
    else return false;
    return true;
  } catch {
    return false;
  }
}

export function scheduleWebuiCopiedReset(
  setCopied: (value: boolean) => void,
  schedule: (callback: () => void, delayMs: number) => unknown,
): void {
  schedule(() => setCopied(false), 1_200);
}

/** Desktop timestamp format for the action row: `9月22日, 22:37`. */
export function formatWebuiMessageTimestamp(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  /** The desktop's action row is glyph-only: a 26px square holding a 16–18px icon. */
  readonly icon: ReactElement;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Selection state for the feedback toggles; the desktop paints the active glyph differently. */
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
  /** Epoch ms; the desktop prints it inside the action row. */
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
  const { dom } = useWebuiBrowserCapabilities();
  const files = preview?.turns.flatMap((turn) => turn.files) ?? [];
  const turns = preview?.turns.length ?? 1;
  const dialog = (
    <div className="webui-message-dialog" role="dialog" aria-modal="true" data-testid="rewind-preview-dialog" data-message-id={messageId}>
      <div className="webui-message-dialog-surface">
        <h3>{"回退"}</h3>
        <p>{files.length > 0 ? `${turns} 轮对话将会回退 · ${files.length} 个文件将被修改。` : `${turns} 轮对话将会回退，不涉及任何文件改动。`}</p>
        <section data-testid="rewind-preview-files">
          <h4>受影响的文件改动</h4>
          {loading ? <p>正在检查当前文件…</p> : null}
          {!loading && error ? <p role="alert">暂时无法读取文件预览，仍可选择仅回退对话。</p> : null}
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
