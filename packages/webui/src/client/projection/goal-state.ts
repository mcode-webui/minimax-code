// Goal projection — the pure helpers that the goal banner component
// consumes. The component owns its own form state; these helpers translate
// that state into the wire requests and the small view-model pieces
// (status copy, wait-reason copy, duration formatting, message upsert).

import type { WebuiStreamMessage } from "../stream.js";
import type {
  WebuiGoal,
  WebuiGoalPatchRequest,
  WebuiGoalStatus,
} from "../../shared/contracts/goal.js";

/**
 * Build a synthetic transcript message for one of the
 * `thread_goal.{objective_updated,objective_steering,updated}` events. The
 * effect reducer upserts the result by id (`thread-goal-${goal.goalId}`) so
 * subsequent updates replace the bubble in place rather than appending.
 */
export function projectWebuiThreadGoalMessage(
  eventType: string,
  goal: WebuiGoal,
): WebuiStreamMessage | undefined {
  if (
    eventType !== "thread_goal.objective_updated" &&
    eventType !== "thread_goal.objective_steering" &&
    eventType !== "thread_goal.updated"
  )
    return undefined;
  return {
    id: `thread-goal-${goal.goalId}`,
    answer: goal.objective,
    thinking: "",
    role: "user",
    timestamp: goal.updatedAt,
    isGoal: true,
  };
}

/** Chinese copy for each `WebuiGoalStatus`. The banner paints a chip using
 *  this map; the `updated` key is the transient "saved" badge the banner
 *  flashes after a successful patch. */
export const WEBUI_GOAL_STATUS_COPY: Record<WebuiGoalStatus | "updated", string> = {
  active: "进行中",
  paused: "已停止",
  blocked: "受阻",
  complete: "已完成",
  budget_limited: "已达上限",
  usage_limited: "服务商受限",
  updated: "已更新",
};

/** Chinese copy for each `goal.executionWait` reason the runtime emits. */
export const WEBUI_GOAL_WAIT_COPY: Record<string, string> = {
  questionnaire: "等待你回答问题",
  permission: "等待你确认权限",
  plan: "等待 Plan 流程结束",
  required_background: "等待后台任务完成",
  automation_owner_conflict: "等待自动任务结束",
  dependency_unavailable: "等待依赖恢复",
  verification: "等待验证完成",
  unknown: "等待运行条件满足",
};

/** Human-readable duration formatting for the goal banner's elapsed timer.
 *  Falls back to a 0-second display for non-finite or negative inputs. */
export function formatWebuiGoalDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}min` : ""}`;
  if (minutes > 0) return `${minutes}min${rest > 0 ? `${rest}s` : ""}`;
  return `${rest}s`;
}

export type WebuiGoalPatchBuildResult =
  | { readonly ok: true; readonly patch: { readonly objective: string; readonly tokenBudget: number | null } }
  | { readonly ok: false; readonly error: string };

/**
 * Parse the goal-edit form into a patch request. Returns `ok: false` with a
 * user-facing error when the input is invalid so the banner can surface it
 * inline without crashing. Accepts `K`/`M` suffixes on the budget field.
 */
export function buildWebuiGoalEditPatch(
  objective: string,
  budget: string,
): WebuiGoalPatchBuildResult {
  const text = objective.trim();
  if (!text) return { ok: false, error: "目标内容不能为空" };
  const trimmedBudget = budget.trim();
  const parsedBudget = trimmedBudget
    ? Number(trimmedBudget.replace(/k$/iu, "000").replace(/m$/iu, "000000"))
    : null;
  if (trimmedBudget && (parsedBudget === null || !Number.isInteger(parsedBudget) || parsedBudget <= 0))
    return {
      ok: false,
      error:
        "预算值无效：请填正整数、K/M 后缀,或留空以取消上限。",
    };
  return { ok: true, patch: { objective: text, tokenBudget: parsedBudget } };
}

/** Compose a status-only patch — used when the user clicks one of the
 *  status toggles in the banner without touching objective/budget. */
export function buildWebuiGoalStatusPatch(
  status: WebuiGoalStatus,
): Pick<WebuiGoalPatchRequest, "status"> {
  return { status };
}