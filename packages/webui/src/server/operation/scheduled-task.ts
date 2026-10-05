// Scheduled tasks (`定时任务`) — the six WebUI operations.
//
// Validation is structural only: non-empty names and prompts, a recognised
// session target and schedule kind, and a schedule that is actually
// expressible. Nothing here parses a schedule expression or reaches for a
// scheduler, because the port this surface is defined against is deliberately
// engine-free — a host may satisfy it with an interval timer, a calendar, or
// something not written yet, and this file must not decide which.
//
// Two asymmetries are deliberate and load-bearing:
//   * `deleteScheduledTask` is idempotent and reports presence in `success`.
//   * `updateScheduledTask` has no such field and raises for an unknown task.
// A panel retries a delete after an ambiguous disconnect; it never retries an
// edit, so an edit that silently reported "gone" would lose the user's change.

import { WebuiErrorCode } from "../envelope.js";
import {
  invalidBody,
  requireNonEmptyString,
  requireRecord,
} from "./operation-contract.js";
import type {
  ValidationFailure,
  WebuiOperation,
  WebuiOperationValidation,
} from "./operation-contract.js";
import type {
  WebuiCreateScheduledTaskRequest,
  WebuiListScheduledTasksRequest,
  WebuiScheduledTask,
  WebuiScheduledTaskCapability,
  WebuiScheduledTaskListResult,
  WebuiScheduledTaskTriggerRequest,
  WebuiScheduledTaskTriggerResult,
  WebuiUpdateScheduledTaskRequest,
} from "../port.js";
import {
  CREATE_SCHEDULED_TASK_OPERATION_NAME,
  DELETE_SCHEDULED_TASK_OPERATION_NAME,
  GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME,
  LIST_SCHEDULED_TASKS_OPERATION_NAME,
  TRIGGER_SCHEDULED_TASK_OPERATION_NAME,
  UPDATE_SCHEDULED_TASK_OPERATION_NAME,
} from "./names.js";

const SESSION_TARGETS = new Set(["new", "existing"]);
const SCHEDULE_KINDS = new Set(["once", "interval"]);
const MAX_TASK_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20_000;
const MIN_INTERVAL_MS = 1_000;

/**
 * Whether a helper returned a validation failure rather than a value.
 *
 * A `typeof value === "object"` test is wrong here: every helper in this file
 * can legitimately return `null` — an absent timestamp, an absent interval —
 * and `typeof null` is `"object"`, so that test would hand a `null` back to
 * the dispatcher as if it were a failure object. The discriminant is the
 * `ok: false` marker `invalidBody` produces.
 */
function isValidationFailure(value: unknown): value is ValidationFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { readonly ok: unknown }).ok === false
  );
}

/** Tolerant timestamp check: finite, and not so large it overflows a double. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readOptionalTimestamp(
  operation: string,
  key: string,
  value: unknown,
): number | null | ValidationFailure {
  if (value === undefined || value === null) return null;
  return isTimestamp(value)
    ? value
    : invalidBody(`${operation} body requires ${key} to be a timestamp or null`);
}

function readOptionalInterval(
  operation: string,
  value: unknown,
): number | null | ValidationFailure {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_INTERVAL_MS)
    return invalidBody(
      `${operation} body requires intervalMs to be at least ${MIN_INTERVAL_MS}ms`,
    );
  return value;
}

function requireTaskId(
  operation: string,
  body: Record<string, unknown>,
): string | ValidationFailure {
  return requireNonEmptyString(operation, body, "taskId");
}

export const listScheduledTasksOperation: WebuiOperation<
  WebuiListScheduledTasksRequest,
  WebuiScheduledTaskListResult
> = {
  name: LIST_SCHEDULED_TASKS_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined) return { ok: true, body: {} };
    const record = requireRecord(LIST_SCHEDULED_TASKS_OPERATION_NAME, body);
    if (!record.ok) return record as WebuiOperationValidation<WebuiListScheduledTasksRequest>;
    const agentName = record.body.agentName;
    if (agentName !== undefined && (typeof agentName !== "string" || !agentName.trim()))
      return invalidBody(
        `${LIST_SCHEDULED_TASKS_OPERATION_NAME} body requires agentName to be a non-empty string`,
      );
    return {
      ok: true,
      body: agentName === undefined ? {} : { agentName: agentName as string },
    };
  },
};

export const createScheduledTaskOperation: WebuiOperation<
  WebuiCreateScheduledTaskRequest,
  WebuiScheduledTask
> = {
  name: CREATE_SCHEDULED_TASK_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(CREATE_SCHEDULED_TASK_OPERATION_NAME, body);
    if (!record.ok)
      return record as WebuiOperationValidation<WebuiCreateScheduledTaskRequest>;
    const value = record.body;
    const name = requireNonEmptyString(
      CREATE_SCHEDULED_TASK_OPERATION_NAME,
      value,
      "name",
    );
    if (isValidationFailure(name)) return name;
    if (name.length > MAX_TASK_NAME_LENGTH)
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires a name of at most ${MAX_TASK_NAME_LENGTH} characters`,
      );
    const agentName = requireNonEmptyString(
      CREATE_SCHEDULED_TASK_OPERATION_NAME,
      value,
      "agentName",
    );
    if (isValidationFailure(agentName)) return agentName;
    const prompt = requireNonEmptyString(
      CREATE_SCHEDULED_TASK_OPERATION_NAME,
      value,
      "prompt",
    );
    if (isValidationFailure(prompt)) return prompt;
    if (prompt.length > MAX_PROMPT_LENGTH)
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires a prompt of at most ${MAX_PROMPT_LENGTH} characters`,
      );
    if (typeof value.sessionTarget !== "string" || !SESSION_TARGETS.has(value.sessionTarget))
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires sessionTarget to be "new" or "existing"`,
      );
    const sessionTarget = value.sessionTarget as "new" | "existing";
    if (sessionTarget === "existing") {
      const sessionId = requireNonEmptyString(
        CREATE_SCHEDULED_TASK_OPERATION_NAME,
        value,
        "sessionId",
      );
      if (isValidationFailure(sessionId)) return sessionId;
    }
    if (typeof value.scheduleKind !== "string" || !SCHEDULE_KINDS.has(value.scheduleKind))
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires scheduleKind to be "once" or "interval"`,
      );
    const scheduleKind = value.scheduleKind as "once" | "interval";
    const runAtMs = readOptionalTimestamp(
      CREATE_SCHEDULED_TASK_OPERATION_NAME,
      "runAtMs",
      value.runAtMs,
    );
    if (isValidationFailure(runAtMs)) return runAtMs;
    const intervalMs = readOptionalInterval(
      CREATE_SCHEDULED_TASK_OPERATION_NAME,
      value.intervalMs,
    );
    if (isValidationFailure(intervalMs)) return intervalMs;
    // An expressible schedule is the whole point of the row: a recurring task
    // needs an interval, a one-shot task needs a moment, and neither may be
    // created with the other's missing half.
    if (scheduleKind === "interval" && intervalMs === null)
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires intervalMs for an interval schedule`,
      );
    if (scheduleKind === "once" && runAtMs === null)
      return invalidBody(
        `${CREATE_SCHEDULED_TASK_OPERATION_NAME} body requires runAtMs for a one-shot schedule`,
      );
    return {
      ok: true,
      body: {
        name,
        agentName,
        prompt,
        sessionTarget,
        ...(sessionTarget === "existing"
          ? { sessionId: value.sessionId as string }
          : {}),
        scheduleKind,
        runAtMs,
        intervalMs,
      },
    };
  },
};

export const updateScheduledTaskOperation: WebuiOperation<
  WebuiUpdateScheduledTaskRequest,
  WebuiScheduledTask
> = {
  name: UPDATE_SCHEDULED_TASK_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(UPDATE_SCHEDULED_TASK_OPERATION_NAME, body);
    if (!record.ok)
      return record as WebuiOperationValidation<WebuiUpdateScheduledTaskRequest>;
    const value = record.body;
    const taskId = requireTaskId(UPDATE_SCHEDULED_TASK_OPERATION_NAME, value);
    if (isValidationFailure(taskId)) return taskId;
    const patch: Record<string, unknown> = { taskId };
    if (value.name !== undefined) {
      const name = requireNonEmptyString(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        value,
        "name",
      );
      if (isValidationFailure(name)) return name;
      if (name.length > MAX_TASK_NAME_LENGTH)
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires a name of at most ${MAX_TASK_NAME_LENGTH} characters`,
        );
      patch.name = name;
    }
    if (value.prompt !== undefined) {
      const prompt = requireNonEmptyString(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        value,
        "prompt",
      );
      if (isValidationFailure(prompt)) return prompt;
      if (prompt.length > MAX_PROMPT_LENGTH)
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires a prompt of at most ${MAX_PROMPT_LENGTH} characters`,
        );
      patch.prompt = prompt;
    }
    if (value.agentName !== undefined) {
      const agentName = requireNonEmptyString(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        value,
        "agentName",
      );
      if (isValidationFailure(agentName)) return agentName;
      patch.agentName = agentName;
    }
    if (value.sessionTarget !== undefined) {
      if (typeof value.sessionTarget !== "string" || !SESSION_TARGETS.has(value.sessionTarget))
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires sessionTarget to be "new" or "existing"`,
        );
      patch.sessionTarget = value.sessionTarget;
    }
    if (value.sessionId !== undefined) {
      if (value.sessionId !== null && (typeof value.sessionId !== "string" || !value.sessionId.trim()))
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires sessionId to be a non-empty string or null`,
        );
      patch.sessionId = value.sessionId;
    }
    if (value.scheduleKind !== undefined) {
      if (typeof value.scheduleKind !== "string" || !SCHEDULE_KINDS.has(value.scheduleKind))
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires scheduleKind to be "once" or "interval"`,
        );
      patch.scheduleKind = value.scheduleKind;
    }
    if (value.runAtMs !== undefined) {
      const runAtMs = readOptionalTimestamp(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        "runAtMs",
        value.runAtMs,
      );
      if (isValidationFailure(runAtMs)) return runAtMs;
      patch.runAtMs = runAtMs;
    }
    if (value.intervalMs !== undefined) {
      const intervalMs = readOptionalInterval(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        value.intervalMs,
      );
      if (isValidationFailure(intervalMs)) return intervalMs;
      patch.intervalMs = intervalMs;
    }
    if (value.nextRunAtMs !== undefined) {
      const nextRunAtMs = readOptionalTimestamp(
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        "nextRunAtMs",
        value.nextRunAtMs,
      );
      if (isValidationFailure(nextRunAtMs)) return nextRunAtMs;
      patch.nextRunAtMs = nextRunAtMs;
    }
    if (value.enabled !== undefined) {
      if (typeof value.enabled !== "boolean")
        return invalidBody(
          `${UPDATE_SCHEDULED_TASK_OPERATION_NAME} body requires enabled to be a boolean`,
        );
      patch.enabled = value.enabled;
    }
    // An update that changes nothing is a client bug worth surfacing rather
    // than a silent no-op row write.
    if (Object.keys(patch).length === 1)
      return invalidBody(`${UPDATE_SCHEDULED_TASK_OPERATION_NAME} requires a patch`);
    return { ok: true, body: patch as unknown as WebuiUpdateScheduledTaskRequest };
  },
};

export const deleteScheduledTaskOperation: WebuiOperation<
  { readonly taskId: string },
  { readonly success: boolean }
> = {
  name: DELETE_SCHEDULED_TASK_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(DELETE_SCHEDULED_TASK_OPERATION_NAME, body);
    if (!record.ok) return record as WebuiOperationValidation<{ readonly taskId: string }>;
    const taskId = requireTaskId(DELETE_SCHEDULED_TASK_OPERATION_NAME, record.body);
    if (isValidationFailure(taskId)) return taskId;
    return { ok: true, body: { taskId } };
  },
};

export const triggerScheduledTaskNowOperation: WebuiOperation<
  WebuiScheduledTaskTriggerRequest,
  WebuiScheduledTaskTriggerResult
> = {
  name: TRIGGER_SCHEDULED_TASK_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(TRIGGER_SCHEDULED_TASK_OPERATION_NAME, body);
    if (!record.ok)
      return record as WebuiOperationValidation<WebuiScheduledTaskTriggerRequest>;
    const taskId = requireTaskId(TRIGGER_SCHEDULED_TASK_OPERATION_NAME, record.body);
    if (isValidationFailure(taskId)) return taskId;
    return { ok: true, body: { taskId } };
  },
};

export const getScheduledTaskCapabilityOperation: WebuiOperation<
  undefined,
  WebuiScheduledTaskCapability
> = {
  name: GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME,
  validate: (body) =>
    body === undefined
      ? { ok: true, body: undefined }
      : {
          ok: false,
          code: WebuiErrorCode.invalidBody,
          message: `${GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME} does not accept a body`,
        },
};
