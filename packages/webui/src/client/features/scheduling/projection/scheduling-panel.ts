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
