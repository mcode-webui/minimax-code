// 定时任务 — the create/edit form, field for field, over the WebUI's own
// scheduled-task wire contract (`packages/webui/src/server/port.ts`).
//
// The file name is inherited from the retired v2 cron branch, where the form
// built a cron expression. This module does not: the merged backend takes
// exactly two schedule kinds, `once` and `interval`, so the schedule is a pair
// of structured controls and there is no expression to type, decode, or keep
// verbatim. The name stays so the panel's import reads the same as the branch
// the layout came from.
//
// It also owns the controls the store does not have columns for. The desktop
// dialog offers 项目 / 模型 / 每天几点 / 每周几; the merged table has no
// `project` and no `model`, and `schedule_kind` is only `once` | `interval`.
// Inventing those fields into the request body would either be dropped by
// validation or stored nowhere, and rendering them disabled would look like a
// feature. So the gap is stated in a line under the form instead.
//
// The component is controlled and presentational: it owns no transport and no
// effects, so the panel owns the wire and the shell's SSR tests can render the
// real form without a DOM.

import type { ReactElement } from "react";
import type {
  WebuiCreateScheduledTaskRequest,
  WebuiScheduledTask,
  WebuiScheduledTaskScheduleKind,
  WebuiScheduledTaskSessionTarget,
  WebuiUpdateScheduledTaskRequest,
} from "../contracts.js";

/** Desktop limits: name `n/50`, instruction `n/8000`. */
export const SCHEDULED_TASK_NAME_LIMIT = 50;
export const SCHEDULED_TASK_PROMPT_LIMIT = 8000;

/**
 * The server's floor for `intervalMs` (`MIN_INTERVAL_MS` in
 * `operation/scheduled-task.ts`). One minute clears it with room to spare, and
 * a sub-minute schedule is not a thing the panel offers anyway.
 */
export const SCHEDULED_TASK_MIN_INTERVAL_MINUTES = 1;

/** The interval sub-selector's values, in minutes. */
export const SCHEDULED_TASK_INTERVAL_MINUTES: readonly number[] = [
  1, 5, 10, 15, 30, 60, 180, 360, 1440,
];

/**
 * The runtime's own default agent, as the rest of the WebUI resolves it
 * (`WebuiClientFoundationApp`'s `selectedAgentName`). Only a fallback for a
 * panel opened before the session list answered.
 */
export const DEFAULT_AGENT_NAME = "main";

/** The two schedule kinds, as the two labels the control shows. */
export const SCHEDULED_TASK_SCHEDULE_OPTIONS: readonly {
  readonly value: WebuiScheduledTaskScheduleKind;
  readonly label: string;
}[] = [
  { value: "once", label: "仅一次" },
  { value: "interval", label: "每 N 分钟" },
];

export interface WebuiScheduledTaskDraft {
  readonly name: string;
  readonly agentName: string;
  readonly prompt: string;
  /** `new` opens a fresh session per run; `existing` reuses `sessionId`. */
  readonly sessionTarget: WebuiScheduledTaskSessionTarget;
  readonly sessionId: string;
  readonly scheduleKind: WebuiScheduledTaskScheduleKind;
  /** `YYYY-MM-DDTHH:mm`, the value a `datetime-local` input speaks. */
  readonly runAtLocal: string;
  /** N in 「每 N 分钟」. */
  readonly intervalMinutes: number;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The `datetime-local` value one hour from `now`, to the minute. */
export function defaultRunAtLocal(now: number = Date.now()): string {
  const at = new Date(now + 60 * 60 * 1000);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

export function emptyScheduledTaskDraft(agentName: string = DEFAULT_AGENT_NAME): WebuiScheduledTaskDraft {
  return {
    name: "",
    agentName,
    prompt: "",
    sessionTarget: "new",
    sessionId: "",
    scheduleKind: "once",
    runAtLocal: defaultRunAtLocal(),
    intervalMinutes: 5,
  };
}

/** `2026-10-05 16:30`, or an empty string when the input holds nothing usable. */
export function formatScheduledTaskTime(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The `datetime-local` value of a timestamp, for the once-subject input. */
export function toRunAtLocal(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The first listed agent, else the runtime's default. */
export function resolveDefaultAgentName(agents: readonly string[]): string {
  return agents[0] ?? DEFAULT_AGENT_NAME;
}

/**
 * The Agent dropdown's data source is the session list the client already
 * loads — the merged backend has no `listAgents`, and adding one would mean
 * touching the server this change must not touch. Deduplicated, order kept.
 */
export function deriveAgentNames(
  sessions: readonly { readonly agentName?: string }[] | undefined,
): readonly string[] {
  const names: string[] = [];
  for (const session of sessions ?? []) {
    const name = session.agentName?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The three fields the schedule is made of, or undefined while unfillable. */
export function buildScheduledTaskSchedule(
  draft: WebuiScheduledTaskDraft,
): { readonly scheduleKind: WebuiScheduledTaskScheduleKind; readonly runAtMs: number | null; readonly intervalMs: number | null } | undefined {
  if (draft.scheduleKind === "once") {
    const at = Date.parse(draft.runAtLocal);
    if (!Number.isFinite(at)) return undefined;
    return { scheduleKind: "once", runAtMs: at, intervalMs: null };
  }
  const minutes = draft.intervalMinutes;
  if (!Number.isInteger(minutes) || minutes < SCHEDULED_TASK_MIN_INTERVAL_MINUTES) return undefined;
  return { scheduleKind: "interval", runAtMs: null, intervalMs: minutes * 60_000 };
}

/** Empty string when 确认 may be pressed; otherwise the reason it may not. */
export function scheduledTaskDraftIssue(draft: WebuiScheduledTaskDraft): string {
  if (!draft.name.trim()) return "请填写名称";
  if (draft.name.length > SCHEDULED_TASK_NAME_LIMIT) return `名称不能超过 ${SCHEDULED_TASK_NAME_LIMIT} 个字符`;
  if (!draft.agentName.trim()) return "请选择 Agent";
  if (!draft.prompt.trim()) return "请填写指令";
  if (draft.prompt.length > SCHEDULED_TASK_PROMPT_LIMIT) return `指令不能超过 ${SCHEDULED_TASK_PROMPT_LIMIT} 个字符`;
  // The store binds a session itself for `new`, but `existing` names one and
  // the server rejects the row without it — so it is required here, not optional.
  if (draft.sessionTarget === "existing" && !draft.sessionId.trim()) return "请选择要使用的对话";
  if (!buildScheduledTaskSchedule(draft)) return "请填写执行时间";
  return "";
}

/**
 * The frozen create request, or undefined while the draft is still incomplete —
 * the same condition that disables 确认. `sessionId` is sent only for
 * `existing`, because the create operation requires it there and ignores it
 * otherwise.
 */
export function createScheduledTaskRequestFromDraft(
  draft: WebuiScheduledTaskDraft,
): WebuiCreateScheduledTaskRequest | undefined {
  if (scheduledTaskDraftIssue(draft)) return undefined;
  const schedule = buildScheduledTaskSchedule(draft);
  if (!schedule) return undefined;
  return {
    name: draft.name.trim(),
    agentName: draft.agentName.trim(),
    prompt: draft.prompt.trim(),
    sessionTarget: draft.sessionTarget,
    ...(draft.sessionTarget === "existing" ? { sessionId: draft.sessionId.trim() } : {}),
    scheduleKind: schedule.scheduleKind,
    runAtMs: schedule.runAtMs,
    intervalMs: schedule.intervalMs,
  };
}

/** The frozen update request. The panel owns every field the form shows, so an
 *  edit sends the whole form back rather than a partial patch. */
export function updateScheduledTaskRequestFromDraft(
  draft: WebuiScheduledTaskDraft,
  taskId: string,
): WebuiUpdateScheduledTaskRequest | undefined {
  const create = createScheduledTaskRequestFromDraft(draft);
  const trimmed = taskId.trim();
  if (!create || !trimmed) return undefined;
  return {
    taskId: trimmed,
    name: create.name,
    prompt: create.prompt,
    agentName: create.agentName,
    sessionTarget: create.sessionTarget,
    ...(create.sessionId !== undefined ? { sessionId: create.sessionId } : {}),
    scheduleKind: create.scheduleKind,
    runAtMs: create.runAtMs,
    intervalMs: create.intervalMs,
  };
}

/** The form seeded from a stored task, so 编辑 shows what the store holds. */
export function scheduledTaskDraftFromTask(task: WebuiScheduledTask): WebuiScheduledTaskDraft {
  return {
    name: task.name,
    agentName: task.agentName,
    prompt: task.prompt,
    sessionTarget: task.sessionTarget,
    sessionId: task.sessionId ?? "",
    scheduleKind: task.scheduleKind,
    runAtLocal: task.scheduleKind === "once" ? toRunAtLocal(task.runAtMs) : "",
    intervalMinutes:
      task.scheduleKind === "interval" && typeof task.intervalMs === "number" && Number.isFinite(task.intervalMs)
        ? Math.max(1, Math.round(task.intervalMs / 60_000))
        : 5,
  };
}

const DIALOG_MASK = "fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.25)]";
const DIALOG_SURFACE = "w-[520px] max-w-[calc(100vw-32px)] overflow-clip rounded-[20px] bg-bg_grouped_secondary p-6";
const FIELD_LABEL = "flex min-w-0 flex-1 flex-col gap-1 text-sm text-text_default_secondary";
const FIELD_CONTROL =
  "h-9 w-full min-w-0 rounded-[8px] border-[0.5px] border-border_default bg-bg_default_primary px-2 text-sm text-text_default_primary outline-none disabled:opacity-50";
const GHOST_BUTTON =
  "inline-flex h-9 min-w-[68px] items-center justify-center gap-1.5 rounded-[8px] px-4 text-sm text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50";
const PRIMARY_BUTTON =
  "inline-flex h-9 min-w-[68px] items-center justify-center gap-1.5 rounded-[8px] bg-bg_interaction_primary_default px-4 text-sm text-text_default_inverted transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50";

function RequiredMark(): ReactElement {
  return (
    <span className="text-text_default_tertiary" data-testid="scheduled-task-field-required" aria-hidden="true">
      *
    </span>
  );
}

function FieldLabel({ children }: { readonly children: ReactElement | string }): ReactElement {
  return <span className="text-[13px] leading-5 text-text_default_primary">{children}</span>;
}

export interface WebuiCronCreateDialogProps {
  readonly title?: string;
  readonly draft: WebuiScheduledTaskDraft;
  readonly onDraftChange: (next: WebuiScheduledTaskDraft) => void;
  /** Agent names derived from the session list. Empty renders the empty state
   *  below rather than a select with nothing in it. */
  readonly agents?: readonly string[];
  /** Session ids offered for 始终使用同一对话. */
  readonly sessions?: readonly { readonly sessionId: string; readonly title?: string }[];
  readonly busy?: boolean;
  /** 确认 on the manual path; the 在对话中创建 flow closes with 完成并创建. */
  readonly submitLabel?: string;
  /** Set by the 在对话中创建 path: the conversation session is the target and
   *  cannot be pointed elsewhere from the form. */
  readonly lockedSessionId?: string;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

/** 名称 / Agent, 指令, 运行模式, 执行时间, 取消 / 确认. 确认 stays disabled
 *  until every starred field is filled. */
export function WebuiCronCreateDialog({
  title = "定时任务",
  draft,
  onDraftChange,
  agents = [],
  sessions = [],
  busy = false,
  submitLabel = "确认",
  lockedSessionId,
  onSubmit,
  onClose,
}: WebuiCronCreateDialogProps): ReactElement {
  const issue = scheduledTaskDraftIssue(draft);
  const patch = (next: Partial<WebuiScheduledTaskDraft>): void => onDraftChange({ ...draft, ...next });
  const sessionId = lockedSessionId ?? draft.sessionId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={DIALOG_MASK}
      data-testid="scheduled-task-create-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={DIALOG_SURFACE}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex items-center justify-between">
          <h3 className="text-[18px] font-medium leading-[26px] text-text_default_primary">{title}</h3>
          <button
            type="button"
            aria-label="关闭"
            className="flex size-[22px] items-center justify-center text-icon_default_tertiary hover:text-icon_default_secondary"
            onClick={onClose}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <form
          className="mt-6 flex flex-col gap-4"
          data-testid="scheduled-task-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="scheduled-task-name">
              <span className="flex items-center justify-between">
                <FieldLabel>{"名称"}</FieldLabel>
                <RequiredMark />
              </span>
              <span className="flex items-center">
                <input
                  id="scheduled-task-name"
                  aria-label="名称"
                  required
                  maxLength={SCHEDULED_TASK_NAME_LIMIT}
                  className={`${FIELD_CONTROL} border-0 px-0`}
                  value={draft.name}
                  placeholder="给任务起个名字"
                  onChange={(event) => patch({ name: event.currentTarget.value })}
                />
                <span className="pl-2 text-[12px] text-text_default_tertiary" data-testid="scheduled-task-name-count">
                  {draft.name.length}/{SCHEDULED_TASK_NAME_LIMIT}
                </span>
              </span>
            </label>
            <label className={FIELD_LABEL} htmlFor="scheduled-task-agent">
              <span className="flex items-center justify-between">
                <FieldLabel>{"Agent"}</FieldLabel>
                <RequiredMark />
              </span>
              {agents.length === 0 ? (
                <span className="text-[12px] leading-4 text-text_default_tertiary" data-testid="scheduled-task-agents-empty">
                  暂无可选 Agent：先在 WebUI 里新建一个会话。
                </span>
              ) : (
                <select
                  id="scheduled-task-agent"
                  aria-label="Agent"
                  required
                  className={FIELD_CONTROL}
                  value={draft.agentName}
                  onChange={(event) => patch({ agentName: event.currentTarget.value })}
                >
                  {agents.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>

          <label className={`${FIELD_LABEL} flex-none`} htmlFor="scheduled-task-prompt">
            <span className="flex items-center justify-between">
              <FieldLabel>{"指令"}</FieldLabel>
              <RequiredMark />
            </span>
            <span className="flex flex-col items-end">
              <textarea
                id="scheduled-task-prompt"
                aria-label="指令"
                required
                maxLength={SCHEDULED_TASK_PROMPT_LIMIT}
                className={`${FIELD_CONTROL} h-[132px] resize-none py-2`}
                value={draft.prompt}
                placeholder="描述你希望 Agent 执行的操作..."
                onChange={(event) => patch({ prompt: event.currentTarget.value })}
              />
              <span className="pl-2 text-[12px] text-text_default_tertiary" data-testid="scheduled-task-prompt-count">
                {draft.prompt.length}/{SCHEDULED_TASK_PROMPT_LIMIT}
              </span>
            </span>
          </label>

          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="scheduled-task-session-target">
              <FieldLabel>{"运行模式"}</FieldLabel>
              <select
                id="scheduled-task-session-target"
                aria-label="运行模式"
                className={FIELD_CONTROL}
                disabled={lockedSessionId !== undefined}
                value={draft.sessionTarget}
                onChange={(event) =>
                  patch({ sessionTarget: event.currentTarget.value === "existing" ? "existing" : "new" })
                }
              >
                <option value="new">每次新建对话</option>
                <option value="existing">始终使用同一对话</option>
              </select>
              {draft.sessionTarget === "existing" ? (
                lockedSessionId !== undefined ? (
                  <span
                    className="min-w-0 truncate text-[12px] leading-4 text-text_default_tertiary"
                    data-testid="scheduled-task-session-target"
                  >
                    {lockedSessionId}
                  </span>
                ) : sessions.length === 0 ? (
                  <span className="text-[12px] leading-4 text-text_default_tertiary">
                    暂无可选对话：先在 WebUI 里新建一个会话。
                  </span>
                ) : (
                  <select
                    aria-label="使用对话"
                    className={FIELD_CONTROL}
                    value={draft.sessionId}
                    onChange={(event) => patch({ sessionId: event.currentTarget.value })}
                  >
                    <option value="">请选择对话</option>
                    {sessions.map((session) => (
                      <option key={session.sessionId} value={session.sessionId}>
                        {session.title || session.sessionId}
                      </option>
                    ))}
                  </select>
                )
              ) : null}
            </label>
          </div>

          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="scheduled-task-schedule-kind">
              <span className="flex items-center justify-between">
                <FieldLabel>{"执行时间"}</FieldLabel>
                <RequiredMark />
              </span>
              <span className="flex items-center gap-2">
                <select
                  id="scheduled-task-schedule-kind"
                  aria-label="周期"
                  className={FIELD_CONTROL}
                  value={draft.scheduleKind}
                  onChange={(event) =>
                    patch({ scheduleKind: event.currentTarget.value === "interval" ? "interval" : "once" })
                  }
                >
                  {SCHEDULED_TASK_SCHEDULE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value === "interval" ? `每 ${draft.intervalMinutes} 分钟` : option.label}
                    </option>
                  ))}
                </select>
                {/* Only the control the chosen kind uses. A one-shot needs a
                    moment; a recurring task needs a step and nothing else. */}
                {draft.scheduleKind === "once" ? (
                  <input
                    aria-label="执行时刻"
                    type="datetime-local"
                    className={FIELD_CONTROL}
                    value={draft.runAtLocal}
                    onChange={(event) => patch({ runAtLocal: event.currentTarget.value })}
                  />
                ) : (
                  <select
                    aria-label="间隔分钟"
                    className={FIELD_CONTROL}
                    value={String(draft.intervalMinutes)}
                    onChange={(event) => patch({ intervalMinutes: Number(event.currentTarget.value) })}
                  >
                    {SCHEDULED_TASK_INTERVAL_MINUTES.map((value) => (
                      <option key={value} value={String(value)}>
                        {value} 分钟
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </label>
          </div>

          {/* Stated rather than faked: the store has no `project` / `model`
              columns, and `schedule_kind` is only `once` | `interval`, so
              每天几点 / 每周几 has nowhere to go yet. */}
          <p className="text-[12px] leading-4 text-text_default_tertiary" data-testid="scheduled-task-unsupported-note">
            项目、模型、每天/每周几等日历周期暂不支持，待存储扩展后提供。
          </p>

          <footer className="mt-2 flex items-center justify-end gap-3">
            <button type="button" className={GHOST_BUTTON} onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className={PRIMARY_BUTTON}
              data-testid="scheduled-task-create-submit"
              disabled={busy || issue !== ""}
              title={issue || undefined}
            >
              {submitLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default WebuiCronCreateDialog;
