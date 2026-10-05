// 定时任务 — 在对话中创建.
//
// The second creation path. Instead of filling the form first, the user gets a
// real conversation: the panel opens a session, seeds it with one guidance
// message, and the user describes the task in their own words. The closing
// action is the user's own click on 「完成并创建」 — this version is
// WebUI-orchestrated, it does not parse the transcript into a schedule.
//
// The created task targets that conversation (`sessionTarget: "existing"` with
// the session's id), so the run continues where the user already described it
// rather than starting cold in a new session.

import type { ReactElement } from "react";
import type { WebuiCreateScheduledTaskRequest } from "../contracts.js";
import {
  WebuiCronCreateDialog,
  createScheduledTaskRequestFromDraft,
  type WebuiScheduledTaskDraft,
} from "./CronCreateDialog.js";

/** The one message the flow seeds the new conversation with. */
export const CHAT_CREATE_GUIDE_PROMPT =
  "我想创建一个定时任务。请帮我把它说清楚：\n" +
  "1. 这个 Agent 要执行什么（例如「汇总昨天的提交并写进 CHANGELOG.md」）；\n" +
  "2. 多久执行一次（仅在某个时刻执行一次，或每 N 分钟执行一次）。\n" +
  "说完之后回到「定时」页面，点「完成并创建」把它保存成定时任务。";

/** The frozen create request for the conversational path: same fields as the
 *  manual dialog, but the session the user just talked in is the target. A
 *  session is required here — this path always knows which conversation it
 *  means. */
export function buildChatScheduledTaskRequest(
  draft: WebuiScheduledTaskDraft,
  sessionId: string,
): WebuiCreateScheduledTaskRequest | undefined {
  const trimmed = sessionId.trim();
  if (!trimmed) return undefined;
  return createScheduledTaskRequestFromDraft({
    ...draft,
    sessionTarget: "existing",
    sessionId: trimmed,
  });
}

export interface WebuiCronChatCreateFlowProps {
  /** The conversation opened for this task, or undefined before the user
   *  starts one. Lifted by the panel so it survives the view switch into the
   *  conversation and back. */
  readonly sessionId?: string;
  readonly draft: WebuiScheduledTaskDraft;
  readonly onDraftChange: (next: WebuiScheduledTaskDraft) => void;
  readonly agents?: Parameters<typeof WebuiCronCreateDialog>[0]["agents"];
  readonly busy?: boolean;
  readonly onStart: () => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

export function WebuiCronChatCreateFlow({
  sessionId,
  draft,
  onDraftChange,
  agents,
  busy = false,
  onStart,
  onSubmit,
  onClose,
}: WebuiCronChatCreateFlowProps): ReactElement {
  if (!sessionId) {
    return (
      <section
        className="flex flex-col gap-3 rounded-[16px] border-[0.5px] border-border_default bg-bg_default_secondary p-4"
        data-testid="scheduled-task-chat-create-intro"
      >
        <h3 className="text-[15px] font-medium leading-6 text-text_default_primary">在对话中创建</h3>
        <p className="text-sm leading-6 text-text_default_secondary">
          先开一个对话，把定时任务说清楚：我会新创建一个会话并把引导语发进去，
          你在对话里描述想让 Agent 执行什么、多久执行一次，
          说完回到这里点「完成并创建」保存。
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-lg border-[0.5px] border-border_default bg-bg_interaction_primary_default px-3 text-sm text-text_default_inverted transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50"
            data-testid="scheduled-task-chat-create-start"
            disabled={busy}
            onClick={onStart}
          >
            开始对话
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-lg border-[0.5px] border-border_default px-3 text-sm text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
            onClick={onClose}
          >
            返回
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3" data-testid="scheduled-task-chat-create-session">
      <div className="flex flex-col gap-2 rounded-[16px] border-[0.5px] border-border_default bg-bg_default_secondary p-4">
        <h3 className="text-[15px] font-medium leading-6 text-text_default_primary">在对话中创建</h3>
        <p className="text-sm leading-6 text-text_default_secondary">
          已在会话 <code className="text-text_default_primary">{sessionId}</code>{" "}
          里发起了引导。请在对话中把任务说清楚，然后回到这里补全下面的字段并点「完成并创建」；
          这个任务会继续使用该会话。
        </p>
        <blockquote
          className="whitespace-pre-wrap rounded-[8px] bg-bg_default_primary px-3 py-2 text-[13px] leading-5 text-text_default_secondary"
          data-testid="scheduled-task-chat-create-guide"
        >
          {CHAT_CREATE_GUIDE_PROMPT}
        </blockquote>
      </div>
      <WebuiCronCreateDialog
        title="完成并创建"
        draft={draft}
        onDraftChange={onDraftChange}
        {...(agents ? { agents } : {})}
        busy={busy}
        lockedSessionId={sessionId}
        submitLabel="完成并创建"
        onSubmit={onSubmit}
        onClose={onClose}
      />
    </section>
  );
}

export default WebuiCronChatCreateFlow;
