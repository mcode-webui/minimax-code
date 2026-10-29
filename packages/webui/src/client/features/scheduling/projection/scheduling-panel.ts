// The scheduled-task panel's projection: wire DTOs in, display rows out.
//
// Pure functions, so the wording of every row is testable without a DOM. The panel renders what this
// module returns and decides nothing itself.
//
// Two honesty rules live here:
//
//   * **The hold label never names a host.** The task's row records no owner and an unmodified
//     Desktop publishes none, so the panel can say whether *this* client holds the task and that
//     another runtime instance may be running — naming one would be a promise nobody can keep.
//   * **An unknown schedule is shown as it is.** A cron expression this module cannot humanize is
//     printed verbatim rather than guessed at, because a wrong "every day at 09:00" is worse than
//     the expression the person actually typed.
import type { WebuiCronSchedule, WebuiCronTask } from "../../../../shared/contracts/cron.js";

export const WEBUI_SCHEDULING_EMPTY_TEXT = "还没有任何定时任务。";
export const WEBUI_SCHEDULING_LOADING_TEXT = "正在读取定时任务…";
export const WEBUI_SCHEDULING_NOT_HELD_TEXT = "本客户端未接管";
export const WEBUI_SCHEDULING_HELD_TEXT = "本客户端已接管";
export const WEBUI_SCHEDULING_OTHER_HOST_HINT =
  "同一台机器上可能还有另一个运行时实例在运行。";

export interface WebuiSchedulingRow {
  readonly cronId: string;
  readonly name: string;
  readonly scheduleLabel: string;
  readonly nextRunLabel: string;
  readonly enabledLabel: string;
  readonly holdLabel: string;
  readonly heldByThisClient: boolean;
  readonly enabled: boolean;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const MINUTE = 60_000;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD HH:mm` in the viewer's own time zone, without a locale-sensitive formatter. */
export function webuiTimestampLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A schedule in words.
 *
 * Only the shapes a person actually writes are translated; anything else is returned with its
 * expression intact and marked as not humanized, which the panel shows as-is.
 */
export function describeWebuiCronSchedule(schedule: WebuiCronSchedule): string {
  if (schedule.kind === "once") return `仅一次，${webuiTimestampLabel(schedule.runAtMs)}`;
  const parts = schedule.expression.trim().split(/\s+/u);
  const zone = schedule.timezone ? `（${schedule.timezone}）` : "";
  if (parts.length !== 5) return `自定义：${schedule.expression}${zone}`;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = parts;
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每分钟${zone}`;
  }
  const stepMinutes = /^\*\/(\d+)$/u.exec(minute);
  if (stepMinutes && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每 ${stepMinutes[1]} 分钟${zone}`;
  }
  if (/^\d{1,2}$/u.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每小时第 ${minute} 分钟${zone}`;
  }
  const stepHours = /^\*\/(\d+)$/u.exec(hour);
  if (/^\d{1,2}$/u.test(minute) && stepHours && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每 ${stepHours[1]} 小时${zone}`;
  }
  if (
    /^\d{1,2}$/u.test(minute) &&
    /^\d{1,2}$/u.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `每天 ${pad(Number(hour))}:${pad(Number(minute))}${zone}`;
  }
  if (
    /^\d{1,2}$/u.test(minute) &&
    /^\d{1,2}$/u.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    /^[0-6]$/u.test(dayOfWeek)
  ) {
    return `每周${WEEKDAYS[Number(dayOfWeek)]} ${pad(Number(hour))}:${pad(Number(minute))}${zone}`;
  }
  return `自定义：${schedule.expression}${zone}`;
}

/** When it next runs, relative to the viewer's clock. */
export function describeWebuiCronNextRun(nextRunAtMs: number | undefined, nowMs: number): string {
  if (nextRunAtMs === undefined) return "未安排下一次执行";
  if (nextRunAtMs <= nowMs) return "即将执行";
  const remainingMs = nextRunAtMs - nowMs;
  if (remainingMs < MINUTE) return `约 ${String(Math.max(1, Math.round(remainingMs / 1000)))} 秒后`;
  if (remainingMs < 60 * MINUTE) {
    return `${webuiTimestampLabel(nextRunAtMs)}（约 ${String(Math.round(remainingMs / MINUTE))} 分钟后）`;
  }
  return webuiTimestampLabel(nextRunAtMs);
}

export function webuiSchedulingRow(task: WebuiCronTask, nowMs: number): WebuiSchedulingRow {
  return {
    cronId: task.cronId,
    name: task.name,
    scheduleLabel: describeWebuiCronSchedule(task.schedule),
    nextRunLabel: describeWebuiCronNextRun(task.nextRunAtMs, nowMs),
    enabledLabel: task.enabled ? "已启用" : "已停用",
    holdLabel: task.heldByThisClient ? WEBUI_SCHEDULING_HELD_TEXT : WEBUI_SCHEDULING_NOT_HELD_TEXT,
    heldByThisClient: task.heldByThisClient,
    enabled: task.enabled,
  };
}

export function webuiSchedulingRows(
  tasks: readonly WebuiCronTask[],
  nowMs: number,
): readonly WebuiSchedulingRow[] {
  return tasks.map((task) => webuiSchedulingRow(task, nowMs));
}

// ---------------------------------------------------------------------------------------------
// The editor's draft, and the schedule a draft stands for.
//
// The presets exist so a person never has to type cron for the four schedules they actually want.
// What they choose is converted here, once, into the schedule the task stores — so the panel and the
// runtime never disagree about what "每天 09:00" means.
// ---------------------------------------------------------------------------------------------

export type WebuiCronSchedulePreset = "daily" | "weekly" | "hourly" | "once" | "custom";

export interface WebuiCronDraft {
  readonly name: string;
  readonly prompt: string;
  readonly preset: WebuiCronSchedulePreset;
  /** `HH:MM`, for the daily and weekly presets. */
  readonly time: string;
  /** `0`–`6`, Sunday first, for the weekly preset. */
  readonly weekday: string;
  /** `0`–`59`, for the hourly preset. */
  readonly minute: string;
  /** A `datetime-local` value, for the once preset. */
  readonly onceAt: string;
  /** The expression the custom preset stores verbatim. */
  readonly expression: string;
  readonly model: string;
  readonly project: string;
  /** A fresh session per run, or a fixed one the person names. */
  readonly sessionId: string;
}

export const WEBUI_CRON_PRESET_LABELS: Readonly<Record<WebuiCronSchedulePreset, string>> = {
  daily: "每天",
  weekly: "每周",
  hourly: "每小时",
  once: "仅一次",
  custom: "自定义",
};

export const WEBUI_CRON_EMPTY_DRAFT: WebuiCronDraft = {
  name: "",
  prompt: "",
  preset: "daily",
  time: "09:00",
  weekday: "1",
  minute: "0",
  onceAt: "",
  expression: "",
  model: "",
  project: "",
  sessionId: "",
};

export type WebuiCronScheduleFromDraft =
  | { readonly ok: true; readonly schedule: WebuiCronSchedule }
  | { readonly ok: false; readonly field: "time" | "weekday" | "onceAt" | "expression"; readonly message: string };

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/u;

/** The schedule a draft stands for, or the field that stopped it. */
export function webuiCronScheduleFromDraft(
  draft: WebuiCronDraft,
  nowMs: number,
): WebuiCronScheduleFromDraft {
  if (draft.preset === "custom") {
    const expression = draft.expression.trim();
    if (expression.split(/\s+/u).filter(Boolean).length !== 5) {
      return { ok: false, field: "expression", message: "自定义表达式需要五段。" };
    }
    return { ok: true, schedule: { kind: "recurring", expression } };
  }
  if (draft.preset === "once") {
    const runAtMs = Date.parse(draft.onceAt);
    if (!Number.isFinite(runAtMs)) {
      return { ok: false, field: "onceAt", message: "请选择执行时间。" };
    }
    if (runAtMs <= nowMs) {
      return { ok: false, field: "onceAt", message: "执行时间需要晚于现在。" };
    }
    return { ok: true, schedule: { kind: "once", runAtMs } };
  }
  if (draft.preset === "hourly") {
    const minute = Number(draft.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return { ok: false, field: "time", message: "分钟需要在 0 到 59 之间。" };
    }
    return { ok: true, schedule: { kind: "recurring", expression: `${String(minute)} * * * *` } };
  }
  const match = TIME_PATTERN.exec(draft.time.trim());
  if (!match) return { ok: false, field: "time", message: "时间格式需要是 HH:MM。" };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (draft.preset === "daily") {
    return {
      ok: true,
      schedule: { kind: "recurring", expression: `${String(minute)} ${String(hour)} * * *` },
    };
  }
  const weekday = Number(draft.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return { ok: false, field: "weekday", message: "星期需要在周日到周六之间。" };
  }
  return {
    ok: true,
    schedule: {
      kind: "recurring",
      expression: `${String(minute)} ${String(hour)} * * ${String(weekday)}`,
    },
  };
}

/** The draft an existing task opens in, so editing does not start from a blank form. */
export function webuiCronDraftFromTask(task: WebuiCronTask): WebuiCronDraft {
  const draft: WebuiCronDraft = {
    ...WEBUI_CRON_EMPTY_DRAFT,
    name: task.name,
    prompt: task.prompt,
    model: task.model ?? "",
    project: task.project ?? "",
    sessionId: task.sessionTarget.mode === "sessionId" ? (task.sessionTarget.sessionId ?? "") : "",
  };
  if (task.schedule.kind === "once") {
    const date = new Date(task.schedule.runAtMs);
    const local = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return { ...draft, preset: "once", onceAt: local };
  }
  const fields = task.schedule.expression.trim().split(/\s+/u);
  if (fields.length !== 5) return { ...draft, preset: "custom", expression: task.schedule.expression };
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  if (dom === "*" && month === "*" && dow === "*") {
    if (hour === "*") return { ...draft, preset: "hourly", minute };
    return { ...draft, preset: "daily", time: `${pad(Number(hour))}:${pad(Number(minute))}` };
  }
  if (dom === "*" && month === "*" && /^[0-6]$/u.test(dow)) {
    return {
      ...draft,
      preset: "weekly",
      weekday: dow,
      time: `${pad(Number(hour))}:${pad(Number(minute))}`,
    };
  }
  return { ...draft, preset: "custom", expression: task.schedule.expression };
}
