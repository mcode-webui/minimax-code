// 定时任务 — the desktop's create / edit dialog, field for field.
//
// `D:\temp\mmx-webui-cron\CONTRACT.md` §6 freezes the mapping from the desktop
// controls to the v2 wire fields; §3 forbids handing the user a raw cron
// expression to type. So the schedule is a structured control (周期 + 时间) that
// *produces* `WebuiCronSchedule`, and this module owns that translation in both
// directions so the panel and the tests share one implementation.
//
// The component is controlled and presentational: it owns no transport and no
// effects, so the panel owns the wire and the shell's SSR tests can render the
// real form without a DOM.

import type { ReactElement } from "react";
import type {
  WebuiAgentRef,
  WebuiCreateCronDefinitionRequest,
  WebuiCronDefinition,
  WebuiCronSchedule,
  WebuiCronSessionTarget,
  WebuiUpdateCronDefinitionRequest,
} from "../contracts.js";
import type { WebuiModelEntry } from "../../server/port.js";

/** Desktop limits (CONTRACT §6): 名称 n/50, 指令 n/8000. */
export const CRON_NAME_LIMIT = 50;
export const CRON_PROMPT_LIMIT = 8000;

/** The runtime's own default agent, as the rest of the WebUI resolves it
 *  (`commands/runner.ts`, `WebuiClientFoundationApp`'s `selectedAgentName`). */
export const DEFAULT_AGENT_NAME = "main";

/** The desktop's four periods. There is no `once` entry: a one-shot task is
 *  something the runtime can already hold, not something this form creates, so
 *  editing one shows it read-only instead (see `onceAtMs`). */
export type WebuiCronPeriod = "minutes" | "hours" | "daily" | "weekly";

export const CRON_PERIOD_OPTIONS: readonly { readonly value: WebuiCronPeriod; readonly label: string }[] = [
  { value: "minutes", label: "每 {N} 分钟" },
  { value: "hours", label: "每 {N} 小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
];

/** The interval sub-selectors' value sets. Each period shows only the ones its
 *  expression needs: `每 N 分钟` takes one, `每 N 小时` takes two, 每天 and 每周
 *  take a clock time instead. */
export const CRON_MINUTE_INTERVALS: readonly number[] = [1, 2, 5, 10, 15, 20, 30, 45];
export const CRON_HOUR_INTERVALS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];
export const CRON_HOUR_MINUTES: readonly number[] = [0, 5, 10, 15, 20, 30, 45];

/** cron day-of-week, 0 = 周日. */
export const CRON_WEEKDAYS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

export interface WebuiCronDraft {
  readonly name: string;
  readonly agentName: string;
  readonly prompt: string;
  /** `new` → 每次新建对话；`sessionId` → 始终使用同一对话。 */
  readonly sessionMode: "new" | "sessionId";
  /** The conversation 始终使用同一对话 targets. Empty means "let the server
   *  bind it", which the contract allows by leaving `sessionId` off. */
  readonly sessionId: string;
  /** Workspace directory, or "" for 不需要项目. */
  readonly project: string;
  /** Model id, or "" for 使用当前模型. */
  readonly model: string;
  readonly period: WebuiCronPeriod;
  /** N in `每 N 分钟`. */
  readonly intervalMinutes: number;
  /** N in `每 N 小时`. */
  readonly intervalHours: number;
  /** M in `每 N 小时`'s `M` + step-`N` hour field. */
  readonly minuteOfHour: number;
  /** 0 = 周日 … 6 = 周六. */
  readonly weekday: number;
  /** `HH:MM`, 24-hour, for 每天 and 每周. */
  readonly time: string;
  /** Set only when editing an existing `kind: "once"` task. The schedule is
   *  then read-only and the update request omits `schedule` entirely. */
  readonly onceAtMs?: number;
  /** An expression this module did not produce, kept verbatim so editing a
   *  task the desktop created cannot quietly rewrite its schedule. */
  readonly rawExpression: string;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

export function emptyCronDraft(agentName: string = DEFAULT_AGENT_NAME): WebuiCronDraft {
  return {
    name: "",
    agentName,
    prompt: "",
    sessionMode: "new",
    sessionId: "",
    project: "",
    model: "",
    period: "daily",
    intervalMinutes: 5,
    intervalHours: 2,
    minuteOfHour: 0,
    weekday: 1,
    time: "09:00",
    rawExpression: "",
  };
}

/** 「默认」 entry: the runtime's default agent when `listAgents` has not
 *  answered yet, otherwise the listed agent of that name. */
export function resolveDefaultAgentName(agents: readonly WebuiAgentRef[]): string {
  return agents.some((agent) => agent.agentName === DEFAULT_AGENT_NAME)
    ? DEFAULT_AGENT_NAME
    : agents[0]?.agentName ?? DEFAULT_AGENT_NAME;
}

/** The wire is untyped at runtime: `listAgents` answers a bare
 *  `WebuiAgentRef[]`, and one entry that is not an agent ref must not empty the
 *  whole Agent dropdown. */
export function readAgentRefs(value: unknown): readonly WebuiAgentRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is WebuiAgentRef =>
      typeof item === "object" && item !== null && typeof (item as WebuiAgentRef).agentName === "string",
  );
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/u;

const inRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

/** Structured control → `WebuiCronSchedule`, per the desktop's four periods:
 *  `每 N 分钟` puts a step-N field in the minute column, `每 N 小时` pairs a
 *  minute with a step-N hour column, 每天 is `M H * * *`, and 每周 appends the
 *  weekday: `M H * * D`. Undefined means "not fillable yet", which is what keeps
 *  确认 disabled rather than raising. */
export function buildCronSchedule(draft: WebuiCronDraft): WebuiCronSchedule | undefined {
  if (draft.onceAtMs !== undefined) return { kind: "once", runAtMs: draft.onceAtMs };
  if (draft.rawExpression.trim()) return { kind: "recurring", expression: draft.rawExpression.trim() };
  if (draft.period === "minutes") {
    return inRange(draft.intervalMinutes, 1, 59)
      ? { kind: "recurring", expression: `*/${draft.intervalMinutes} * * * *` }
      : undefined;
  }
  if (draft.period === "hours") {
    if (!inRange(draft.intervalHours, 1, 23) || !inRange(draft.minuteOfHour, 0, 59)) return undefined;
    return { kind: "recurring", expression: `${draft.minuteOfHour} */${draft.intervalHours} * * *` };
  }
  const time = TIME_PATTERN.exec(draft.time.trim());
  if (!time) return undefined;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59)) return undefined;
  const clock = `${minute} ${hour}`;
  if (draft.period === "weekly") {
    return inRange(draft.weekday, 0, 6)
      ? { kind: "recurring", expression: `${clock} * * ${draft.weekday}` }
      : undefined;
  }
  return { kind: "recurring", expression: `${clock} * * *` };
}

/** `WebuiCronSchedule` → the control's fields. A `once` schedule comes back as
 *  `onceAtMs` (read-only), and an expression this module cannot decompose comes
 *  back as `rawExpression`, so neither can be silently rewritten into a daily
 *  one by opening the editor. */
export function scheduleFields(schedule: WebuiCronSchedule): {
  period: WebuiCronPeriod;
  intervalMinutes: number;
  intervalHours: number;
  minuteOfHour: number;
  weekday: number;
  time: string;
  onceAtMs?: number;
  rawExpression: string;
} {
  const fallback = { rawExpression: "" };
  if (schedule.kind === "once") {
    // There is no `once` period in the control, so the draft is marked instead.
    return { ...fallback, period: "daily", intervalMinutes: 5, intervalHours: 2, minuteOfHour: 0, weekday: 1, time: "09:00", onceAtMs: schedule.runAtMs };
  }
  const undecodable = (): ReturnType<typeof scheduleFields> => ({
    period: "daily",
    intervalMinutes: 5,
    intervalHours: 2,
    minuteOfHour: 0,
    weekday: 1,
    time: "09:00",
    rawExpression: schedule.expression,
  });
  const fields = schedule.expression.trim().split(/\s+/u);
  if (fields.length !== 5) return undecodable();
  const base = { ...fallback, period: "daily" as WebuiCronPeriod, intervalMinutes: 5, intervalHours: 2, minuteOfHour: 0, weekday: 1, time: "09:00" };

  // A step-N minute column with every other column wildcard → 每 N 分钟.
  const step = /^\*\/(\d{1,2})$/u.exec(fields[0]);
  if (step && inRange(Number(step[1]), 1, 59) && fields.slice(1).every((field) => field === "*"))
    return { ...base, period: "minutes", intervalMinutes: Number(step[1]) };

  // A minute plus a step-N hour column → 每 N 小时.
  if (fields[2] === "*" && fields[3] === "*" && fields[4] === "*") {
    const hourStep = /^\*\/(\d{1,2})$/u.exec(fields[1]);
    const minute = Number(fields[0]);
    if (hourStep && inRange(Number(hourStep[1]), 1, 23) && inRange(minute, 0, 59))
      return { ...base, period: "hours", intervalHours: Number(hourStep[1]), minuteOfHour: minute };
    // A plain hour in the same shape is 每天, not an interval.
    const hour = Number(fields[1]);
    if (/^\d{1,2}$/u.test(fields[1]) && inRange(hour, 0, 23) && inRange(minute, 0, 59))
      return { ...base, time: `${pad2(hour)}:${pad2(minute)}` };
    return undecodable();
  }

  // `M H * * D` → 每周, `M H * * *` → 每天.
  if (fields[2] === "*" && fields[3] === "*") {
    const minute = Number(fields[0]);
    const hour = Number(fields[1]);
    if (!inRange(minute, 0, 59) || !inRange(hour, 0, 23)) return undecodable();
    const time = `${pad2(hour)}:${pad2(minute)}`;
    if (fields[4] === "*") return { ...base, time };
    const weekday = Number(fields[4]);
    return inRange(weekday, 0, 6) ? { ...base, period: "weekly", time, weekday } : undecodable();
  }
  return undecodable();
}

export function cronDraftFromDefinition(definition: WebuiCronDefinition): WebuiCronDraft {
  return {
    ...emptyCronDraft(definition.agentName || DEFAULT_AGENT_NAME),
    name: definition.name,
    agentName: definition.agentName,
    prompt: definition.prompt,
    sessionMode: definition.sessionTarget.mode === "sessionId" ? "sessionId" : "new",
    sessionId: definition.sessionTarget.mode === "sessionId" ? definition.sessionTarget.sessionId ?? "" : "",
    project: definition.project ?? "",
    model: definition.model ?? "",
    ...scheduleFields(definition.schedule),
  };
}

/** Empty string when 确认 may be pressed; otherwise the reason it may not. */
export function cronDraftIssue(draft: WebuiCronDraft): string {
  if (!draft.name.trim()) return "请填写名称";
  if (draft.name.length > CRON_NAME_LIMIT) return `名称不能超过 ${CRON_NAME_LIMIT} 个字符`;
  if (!draft.agentName.trim()) return "请选择 Agent";
  if (!draft.prompt.trim()) return "请填写指令";
  if (draft.prompt.length > CRON_PROMPT_LIMIT) return `指令不能超过 ${CRON_PROMPT_LIMIT} 个字符`;
  if (!buildCronSchedule(draft)) return "请填写执行时间";
  return "";
}

/** `始终使用同一对话` with no session yet submits `sessionId` absent, which the
 *  contract allows and the server binds. */
function sessionTargetFrom(draft: WebuiCronDraft): WebuiCronSessionTarget {
  if (draft.sessionMode !== "sessionId") return { mode: "new" };
  const sessionId = draft.sessionId.trim();
  return sessionId ? { mode: "sessionId", sessionId } : { mode: "sessionId" };
}

/** The frozen `WebuiCreateCronDefinitionRequest`, or undefined while the draft
 *  is still incomplete — the same condition that disables 确认. A `once` draft
 *  is edit-only: the form cannot express a one-shot, so it cannot create one. */
export function createCronRequestFromDraft(
  draft: WebuiCronDraft,
): WebuiCreateCronDefinitionRequest | undefined {
  if (draft.onceAtMs !== undefined) return undefined;
  if (cronDraftIssue(draft)) return undefined;
  const schedule = buildCronSchedule(draft);
  if (!schedule) return undefined;
  return {
    name: draft.name.trim(),
    agentName: draft.agentName.trim(),
    schedule,
    prompt: draft.prompt.trim(),
    sessionTarget: sessionTargetFrom(draft),
    project: draft.project.trim() || null,
    model: draft.model.trim() || null,
  };
}

/** The frozen update request. A task whose schedule the form does not own — a
 *  one-shot, or an expression the control could not decompose — is saved
 *  without a `schedule` field at all, so the stored schedule is left alone
 *  instead of being rewritten. */
export function updateCronRequestFromDraft(
  draft: WebuiCronDraft,
  cronId: string,
): WebuiUpdateCronDefinitionRequest | undefined {
  if (cronDraftIssue(draft)) return undefined;
  const schedule = buildCronSchedule(draft);
  const scheduleOwned = draft.onceAtMs === undefined && draft.rawExpression.trim() === "";
  return {
    cronId,
    name: draft.name.trim(),
    ...(scheduleOwned && schedule ? { schedule } : {}),
    prompt: draft.prompt.trim(),
    sessionTarget: sessionTargetFrom(draft),
    project: draft.project.trim() || null,
    model: draft.model.trim() || null,
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
    <span className="text-text_default_tertiary" data-testid="cron-field-required" aria-hidden="true">
      *
    </span>
  );
}

function FieldLabel({ children }: { readonly children: ReactElement | string }): ReactElement {
  return <span className="text-[13px] leading-5 text-text_default_primary">{children}</span>;
}

/** 「每 {N} 分钟」 carries the currently chosen interval, so the dropdown label
 *  matches the sub-selector sitting next to it. */
function periodLabel(
  option: { readonly value: WebuiCronPeriod; readonly label: string },
  draft: WebuiCronDraft,
): string {
  if (option.value === "minutes") return `每 ${draft.intervalMinutes} 分钟`;
  if (option.value === "hours") return `每 ${draft.intervalHours} 小时`;
  return option.label;
}

const formatOnceAt = (runAtMs: number): string => {
  const at = new Date(runAtMs);
  if (Number.isNaN(at.getTime())) return EMPTY_ONCE_LABEL;
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
};

const EMPTY_ONCE_LABEL = "（时间未知）";

export interface WebuiCronCreateDialogProps {
  readonly title?: string;
  readonly draft: WebuiCronDraft;
  readonly onDraftChange: (next: WebuiCronDraft) => void;
  readonly agents?: readonly WebuiAgentRef[];
  readonly models?: readonly WebuiModelEntry[];
  readonly projects?: readonly string[];
  readonly busy?: boolean;
  /** 确认 on the desktop; the 在对话中创建 flow closes with 完成并创建. */
  readonly submitLabel?: string;
  /** Set by the 在对话中创建 path: the conversation session is the target and
   *  cannot be pointed elsewhere from the form. */
  readonly lockedSessionId?: string;
  /** The session 始终使用同一对话 defaults to. The server binds one when the
   *  dialog has none, so this only pre-fills the field. */
  readonly currentSessionId?: string;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

/** The desktop dialog: 名称 / Agent, 指令, 运行模式 / 项目 / 模型, 执行时间,
 *  取消 / 确认. 确认 stays disabled until every starred field is filled. */
export function WebuiCronCreateDialog({
  title = "定时任务",
  draft,
  onDraftChange,
  agents = [],
  models = [],
  projects = [],
  busy = false,
  submitLabel = "确认",
  lockedSessionId,
  currentSessionId,
  onSubmit,
  onClose,
}: WebuiCronCreateDialogProps): ReactElement {
  const issue = cronDraftIssue(draft);
  const patch = (next: Partial<WebuiCronDraft>): void => onDraftChange({ ...draft, ...next });
  const defaultAgent = resolveDefaultAgentName(agents);
  const agentOptions = [
    ...agents.filter((agent) => agent.agentName !== DEFAULT_AGENT_NAME),
  ];
  const projectOptions = [...new Set(projects.map((dir) => dir.trim()).filter(Boolean))];
  const rawExpression = draft.rawExpression.trim();
  // A schedule the form does not own — a one-shot, or an expression the control
  // could not decompose — is shown but not editable, and the update request
  // leaves it out.
  const onceAtMs = draft.onceAtMs;
  const scheduleReadOnly = onceAtMs !== undefined || rawExpression !== "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={DIALOG_MASK}
      data-testid="cron-create-dialog"
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
          data-testid="cron-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="cron-name">
              <span className="flex items-center justify-between">
                <FieldLabel>{"名称"}</FieldLabel>
                <RequiredMark />
              </span>
              <span className="flex items-center">
                <input
                  id="cron-name"
                  aria-label="名称"
                  required
                  maxLength={CRON_NAME_LIMIT}
                  className={`${FIELD_CONTROL} border-0 px-0`}
                  value={draft.name}
                  placeholder="给任务起个名字"
                  onChange={(event) => patch({ name: event.currentTarget.value })}
                />
                <span className="pl-2 text-[12px] text-text_default_tertiary" data-testid="cron-name-count">
                  {draft.name.length}/{CRON_NAME_LIMIT}
                </span>
              </span>
            </label>
            <label className={FIELD_LABEL} htmlFor="cron-agent">
              <span className="flex items-center justify-between">
                <FieldLabel>{"Agent"}</FieldLabel>
                <RequiredMark />
              </span>
              <select
                id="cron-agent"
                aria-label="Agent"
                required
                className={FIELD_CONTROL}
                value={draft.agentName || defaultAgent}
                onChange={(event) => patch({ agentName: event.currentTarget.value })}
              >
                <option value={defaultAgent}>默认</option>
                {agentOptions.map((agent) => (
                  <option key={agent.agentName} value={agent.agentName}>
                    {agent.displayName || agent.agentName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={`${FIELD_LABEL} flex-none`} htmlFor="cron-prompt">
            <span className="flex items-center justify-between">
              <FieldLabel>{"指令"}</FieldLabel>
              <RequiredMark />
            </span>
            <span className="flex flex-col items-end">
              <textarea
                id="cron-prompt"
                aria-label="指令"
                required
                maxLength={CRON_PROMPT_LIMIT}
                className={`${FIELD_CONTROL} h-[132px] resize-none py-2`}
                value={draft.prompt}
                placeholder="描述你希望 Agent 执行的操作..."
                onChange={(event) => patch({ prompt: event.currentTarget.value })}
              />
              <span className="pl-2 text-[12px] text-text_default_tertiary" data-testid="cron-prompt-count">
                {draft.prompt.length}/{CRON_PROMPT_LIMIT}
              </span>
            </span>
          </label>

          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="cron-session-mode">
              <FieldLabel>{"运行模式"}</FieldLabel>
              <select
                id="cron-session-mode"
                aria-label="运行模式"
                className={FIELD_CONTROL}
                disabled={lockedSessionId !== undefined}
                value={draft.sessionMode}
                onChange={(event) =>
                  patch({ sessionMode: event.currentTarget.value === "sessionId" ? "sessionId" : "new" })
                }
              >
                <option value="new">每次新建对话</option>
                <option value="sessionId">始终使用同一对话</option>
              </select>
              {draft.sessionMode === "sessionId" ? (
                <span
                  className="min-w-0 truncate text-[12px] leading-4 text-text_default_tertiary"
                  data-testid="cron-session-target"
                >
                  {lockedSessionId ?? draft.sessionId ?? currentSessionId ?? "由服务端绑定当前会话"}
                </span>
              ) : null}
            </label>
            <label className={FIELD_LABEL} htmlFor="cron-project">
              <FieldLabel>{"项目"}</FieldLabel>
              <span className="flex items-center gap-1">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" className="shrink-0 text-icon_default_tertiary">
                  <path d="M2.7 5.7c0-.7.5-1.2 1.2-1.2h4l1.6 1.8h6.6c.7 0 1.2.5 1.2 1.2v7.1c0 .7-.5 1.2-1.2 1.2H3.9c-.7 0-1.2-.5-1.2-1.2V5.7Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                </svg>
                <select
                  id="cron-project"
                  aria-label="项目"
                  className={FIELD_CONTROL}
                  value={draft.project}
                  onChange={(event) => patch({ project: event.currentTarget.value })}
                >
                  <option value="">不需要项目</option>
                  {projectOptions.map((dir) => (
                    <option key={dir} value={dir}>
                      {dir.split(/[\\/]/u).filter(Boolean).at(-1) || dir}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className={FIELD_LABEL} htmlFor="cron-model">
              <FieldLabel>{"模型"}</FieldLabel>
              <select
                id="cron-model"
                aria-label="模型"
                className={FIELD_CONTROL}
                value={draft.model}
                onChange={(event) => patch({ model: event.currentTarget.value })}
              >
                <option value="">默认（使用当前模型）</option>
                {models.map((model) => (
                  <option key={`${model.providerId}/${model.modelId}`} value={model.modelId}>
                    {model.displayName || model.modelId}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex gap-3">
            <label className={FIELD_LABEL} htmlFor="cron-period">
              <span className="flex items-center justify-between">
                <FieldLabel>{"执行时间"}</FieldLabel>
                <RequiredMark />
              </span>
              <span className="flex items-center gap-2">
                <select
                  id="cron-period"
                  aria-label="周期"
                  className={FIELD_CONTROL}
                  disabled={scheduleReadOnly}
                  value={draft.period}
                  onChange={(event) => patch({ period: event.currentTarget.value as WebuiCronPeriod })}
                >
                  {CRON_PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {periodLabel(option, draft)}
                    </option>
                  ))}
                </select>
                {/* The sub-selectors are the period's own: 每 N 分钟 takes one,
                    每 N 小时 takes two, 每天 takes a clock time and 每周 takes a
                    weekday plus one. Nothing is rendered that the chosen
                    expression does not use. */}
                {draft.period === "minutes" ? (
                  <select
                    aria-label="间隔分钟"
                    className={FIELD_CONTROL}
                    disabled={scheduleReadOnly}
                    value={String(draft.intervalMinutes)}
                    onChange={(event) => patch({ intervalMinutes: Number(event.currentTarget.value) })}
                  >
                    {CRON_MINUTE_INTERVALS.map((value) => (
                      <option key={value} value={String(value)}>
                        {value} 分钟
                      </option>
                    ))}
                  </select>
                ) : null}
                {draft.period === "hours" ? (
                  <>
                    <select
                      aria-label="间隔小时"
                      className={FIELD_CONTROL}
                      disabled={scheduleReadOnly}
                      value={String(draft.intervalHours)}
                      onChange={(event) => patch({ intervalHours: Number(event.currentTarget.value) })}
                    >
                      {CRON_HOUR_INTERVALS.map((value) => (
                        <option key={value} value={String(value)}>
                          {value} 小时
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="整点分钟"
                      className={FIELD_CONTROL}
                      disabled={scheduleReadOnly}
                      value={String(draft.minuteOfHour)}
                      onChange={(event) => patch({ minuteOfHour: Number(event.currentTarget.value) })}
                    >
                      {CRON_HOUR_MINUTES.map((value) => (
                        <option key={value} value={String(value)}>
                          {value} 分
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {draft.period === "weekly" ? (
                  <select
                    aria-label="星期"
                    className={FIELD_CONTROL}
                    disabled={scheduleReadOnly}
                    value={String(draft.weekday)}
                    onChange={(event) => patch({ weekday: Number(event.currentTarget.value) })}
                  >
                    {CRON_WEEKDAYS.map((day) => (
                      <option key={day.value} value={String(day.value)}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {draft.period === "daily" || draft.period === "weekly" ? (
                  <input
                    aria-label="时间"
                    type="time"
                    className={FIELD_CONTROL}
                    disabled={scheduleReadOnly}
                    value={draft.time}
                    onChange={(event) => patch({ time: event.currentTarget.value })}
                  />
                ) : null}
              </span>
            </label>
          </div>

          {onceAtMs !== undefined ? (
            <p
              className="text-[12px] leading-4 text-text_default_secondary"
              data-testid="cron-once-readonly"
            >
              该任务是一次性任务，执行时间 {formatOnceAt(onceAtMs)} 不可在此修改；保存时不会提交执行时间。
            </p>
          ) : null}
          {rawExpression ? (
            <p className="text-[12px] leading-4 text-text_default_secondary" data-testid="cron-raw-expression">
              该任务的执行时间无法用结构化控件表示，将保持原表达式：{rawExpression}
            </p>
          ) : null}

          <footer className="mt-2 flex items-center justify-end gap-3">
            <button type="button" className={GHOST_BUTTON} onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className={PRIMARY_BUTTON}
              data-testid="cron-create-submit"
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
