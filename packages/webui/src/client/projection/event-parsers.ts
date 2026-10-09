// Runtime event payload 的解析函数。

import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";

/**
 * Extract the session id a runtime event targets, accepting both camelCase
 * and snake_case spellings. The effect protocol uses this to filter out
 * events that belong to a different session before they reach the state
 * mutators.
 *
 * `thread_goal.updated` nests its id (`payload.goal.sessionId`) instead of
 * declaring it at the payload top level, so a top-level-only read made the
 * effect guard drop every goal update and left the banner showing whatever
 * `getGoal()` last returned — a start-of-session snapshot that only a page
 * refresh could replace. Fall back to the nested goal id, for goal events
 * ONLY: a general "dig into any nested payload" rule would let an unrelated
 * event that happens to carry a goal-shaped field through the session
 * boundary. The fix stays in this consumer on purpose: the wire contract is
 * shared with the TUI and Desktop, so the runtime is the better place to add a
 * top-level id, but that is a contract change every frontend has to agree to.
 */
export function eventSessionId(event: WebuiRuntimeEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const value = payload.sessionId ?? payload.session_id ?? nestedGoalSessionId(event);
  return typeof value === "string" ? value : undefined;
}

function nestedGoalSessionId(event: WebuiRuntimeEvent): string | undefined {
  if (!event.type.startsWith("thread_goal.")) return undefined;
  const goal = event.payload.goal;
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) return undefined;
  const value = (goal as Record<string, unknown>).sessionId;
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse a `permission.ask` event into the pending-permission view model the
 * UI stores. Returns undefined when the payload is missing any required
 * field — callers (including the effect reducer) treat that as "ignore".
 */
export function pendingPermissionFromEvent(
  event: WebuiRuntimeEvent,
): WebuiPendingPermission | undefined {
  const payload = event.payload;
  if (
    typeof payload.requestId !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.agentName !== "string" ||
    typeof payload.toolName !== "string" ||
    !Array.isArray(payload.ruleContents) ||
    !payload.ruleContents.every((item) => typeof item === "string") ||
    typeof payload.reason !== "string" ||
    typeof payload.allowAlwaysSupported !== "boolean" ||
    typeof payload.createdAt !== "number"
  )
    return undefined;
  return {
    requestId: payload.requestId,
    sessionId: payload.sessionId,
    agentName: payload.agentName,
    toolName: payload.toolName,
    ruleContents: payload.ruleContents,
    ...(typeof payload.toolInput === "string"
      ? { toolInput: payload.toolInput }
      : {}),
    ...(typeof payload.toolDescription === "string"
      ? { toolDescription: payload.toolDescription }
      : {}),
    reason: payload.reason,
    allowAlwaysSupported: payload.allowAlwaysSupported,
    createdAt: payload.createdAt,
  };
}

/**
 * Parse a `questionnaire.ask` event into the questionnaire view model. The
 * wire frame carries the request under `payload.request`, with a couple of
 * required shape checks the runtime contract requires us to validate.
 */
export function questionnaireFromEvent(
  event: WebuiRuntimeEvent,
): WebuiQuestionnaireRequest | undefined {
  const value = event.payload.request;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const request = value as Partial<WebuiQuestionnaireRequest>;
  if (
    typeof request.id !== "string" ||
    typeof request.schemaVersion !== "number" ||
    !Array.isArray(request.steps)
  )
    return undefined;
  return request as WebuiQuestionnaireRequest;
}

/**
 * Replace-or-append a permission entry. The reducer uses this to land the
 * `permission.ask` payload: any existing entry with the same `requestId` is
 * dropped, then the new entry is appended. Order is preserved so the
 * panel's existing tests (which assert the order) keep working.
 */
export function replacePermission(
  current: readonly WebuiPendingPermission[],
  next: WebuiPendingPermission,
): readonly WebuiPendingPermission[] {
  return [
    ...current.filter((permission) => permission.requestId !== next.requestId),
    next,
  ];
}
