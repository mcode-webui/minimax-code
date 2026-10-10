import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
} from "../port.js";
import { validateGoalSessionBody } from "./common.js";
import { IS_GOAL_ENABLED_OPERATION_NAME, GET_GOAL_OPERATION_NAME, CREATE_GOAL_OPERATION_NAME, PATCH_GOAL_OPERATION_NAME, CLEAR_GOAL_OPERATION_NAME } from "./names.js";
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "complete", "budget_limited", "usage_limited"]);

export const isGoalEnabledOperation: WebuiOperation<undefined, WebuiGoalEnabledResult> = {
  name: IS_GOAL_ENABLED_OPERATION_NAME,
  validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${IS_GOAL_ENABLED_OPERATION_NAME} does not accept a body` },
};

export const getGoalOperation: WebuiOperation<{ readonly sessionId: string }, WebuiGoal | undefined> = {
  name: GET_GOAL_OPERATION_NAME,
  validate: (body) => validateGoalSessionBody(GET_GOAL_OPERATION_NAME, body),
};

export const createGoalOperation: WebuiOperation<WebuiGoalCreateRequest, WebuiGoal> = {
  name: CREATE_GOAL_OPERATION_NAME,
  validate: (body) => {
    const result = validateGoalSessionBody(CREATE_GOAL_OPERATION_NAME, body);
    if (!result.ok) return result as WebuiOperationValidation<WebuiGoalCreateRequest>;
    const value = body as Record<string, unknown>;
    if (typeof value.objective !== "string" || !value.objective.trim()) return { ok: false, code: WebuiErrorCode.invalidBody, message: "createGoal body requires a non-empty objective" };
    if (value.tokenBudget !== undefined && value.tokenBudget !== null && (typeof value.tokenBudget !== "number" || !Number.isInteger(value.tokenBudget) || value.tokenBudget <= 0)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "tokenBudget must be a positive integer or null" };
    return { ok: true, body: { sessionId: result.body.sessionId, objective: value.objective, ...(value.tokenBudget !== undefined ? { tokenBudget: value.tokenBudget as number | null } : {}) } };
  },
};

export const patchGoalOperation: WebuiOperation<WebuiGoalPatchRequest, WebuiGoal> = {
  name: PATCH_GOAL_OPERATION_NAME,
  validate: (body) => {
    const result = validateGoalSessionBody(PATCH_GOAL_OPERATION_NAME, body);
    if (!result.ok) return result as WebuiOperationValidation<WebuiGoalPatchRequest>;
    const value = body as Record<string, unknown>;
    if (value.status !== undefined && (typeof value.status !== "string" || !GOAL_STATUSES.has(value.status))) return { ok: false, code: WebuiErrorCode.invalidBody, message: "status is not a valid goal status" };
    if (value.objective !== undefined && (typeof value.objective !== "string" || !value.objective.trim())) return { ok: false, code: WebuiErrorCode.invalidBody, message: "objective must be a non-empty string" };
    if (value.tokenBudget !== undefined && value.tokenBudget !== null && (typeof value.tokenBudget !== "number" || !Number.isInteger(value.tokenBudget) || value.tokenBudget <= 0)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "tokenBudget must be a positive integer or null" };
    if (value.status === undefined && value.objective === undefined && value.tokenBudget === undefined) return { ok: false, code: WebuiErrorCode.invalidBody, message: "patchGoal requires a patch" };
    return { ok: true, body: { sessionId: result.body.sessionId, ...(value.status !== undefined ? { status: value.status as WebuiGoalPatchRequest["status"] } : {}), ...(value.objective !== undefined ? { objective: value.objective as string } : {}), ...(value.tokenBudget !== undefined ? { tokenBudget: value.tokenBudget as number | null } : {}) } };
  },
};

export const clearGoalOperation: WebuiOperation<{ readonly sessionId: string }, { readonly success: boolean }> = {
  name: CLEAR_GOAL_OPERATION_NAME,
  validate: (body) => validateGoalSessionBody(CLEAR_GOAL_OPERATION_NAME, body),
};
