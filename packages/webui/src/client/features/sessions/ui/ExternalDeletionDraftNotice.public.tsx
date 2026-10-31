// The notice that reports a session somebody else deleted, and what it does with
// the input that was still unsent for it.
//
// It is the only new user-visible surface here, and deliberately a
// per-feature notice rather than a shell notification system: the fact is
// Sessions', the input is the composer's, and the three ways out are the user's.
// It reuses the banner pattern the conversation surface already renders, so it
// appears where the user is composing rather than in a corner they have to notice.
//
// It is disabled-by-default in the sense that matters: the retained input is not
// inserted into any editor, is not resent, and is not re-created as a task. The
// three actions are the only ways it leaves — copy the text, transfer it to the
// task the user is in, or discard it — and each of them retires the record, which
// is why the notice disappears when the user acts rather than when a later read
// happens to notice.

import type { ReactElement } from "react";

import type { WebuiRetainedDeletionDraft } from "../application/session-workflows.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";

export interface WebuiExternalDeletionNoticeProps {
  readonly drafts: readonly WebuiRetainedDeletionDraft[];
  /** Hands the text back for copying; the record retires in the owner. */
  readonly onCopy: (sessionId: string) => void;
  /** Puts the input into the composer's current slot. */
  readonly onTransfer: (sessionId: string) => void;
  readonly onDiscard: (sessionId: string) => void;
}

export function WebuiExternalDeletionNotice({
  drafts,
  onCopy,
  onTransfer,
  onDiscard,
}: WebuiExternalDeletionNoticeProps): ReactElement | null {
  if (drafts.length === 0) return null;
  return (
    <FeedbackLiveRegion
      testId="external-deletion-notice"
      className="mx-auto w-full max-w-[743px] rounded-lg border border-border_default bg-bg_default_secondary px-spacing_8 py-spacing_4 text-size_12 leading-line_height_16"
    >
      {drafts.map((draft) => {
        const staged = draft.attachments.length + draft.urlReferences.length;
        return (
          <div key={draft.sessionId} data-testid={`external-deletion-draft-${draft.sessionId}`}>
            <p>这个任务已被其他客户端删除。</p>
            <p>
              未发送的内容仍保留在这里：
              {draft.draft ? <span data-testid="external-deletion-draft-text">{draft.draft}</span> : null}
              {staged > 0 ? <span data-testid="external-deletion-draft-attachments">（{staged} 个附件）</span> : null}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onCopy(draft.sessionId)}>
                复制文本
              </button>
              <button type="button" onClick={() => onTransfer(draft.sessionId)}>
                转移到当前任务
              </button>
              <button type="button" onClick={() => onDiscard(draft.sessionId)}>
                丢弃
              </button>
            </div>
          </div>
        );
      })}
    </FeedbackLiveRegion>
  );
}
