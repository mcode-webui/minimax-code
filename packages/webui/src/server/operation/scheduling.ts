// The scheduled-task wire operations (ADR 0027).
//
// One operation so far: the list. Creating, editing, deleting, running and reading history arrive in
// their own tickets; they belong in this file because they are one domain and one client business,
// and splitting them across files would make the registry's order read as three unrelated groups.
//
// `listCronTasks` validates the paging envelope only. What a task *is* is the adapter's business:
// the runtime's cron view converts to a `WebuiCronTask` behind the harness port, so this layer
// checks the shape a browser may send and never learns the runtime's model.
import type {
  WebuiCronRun,
  WebuiCronRunListRequest,
  WebuiCronRunPage,
  WebuiCronSchedule,
  WebuiCronSessionTarget,
  WebuiCronTask,
  WebuiCronTaskCreateRequest,
  WebuiCronTaskDeleteRequest,
  WebuiCronTaskListRequest,
  WebuiCronTaskPage,
  WebuiCronTaskRunRequest,
  WebuiCronTaskUpdateRequest,
} from "../../shared/contracts/cron.js";
import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  CREATE_CRON_TASK_OPERATION_NAME,
  DELETE_CRON_TASK_OPERATION_NAME,
  LIST_CRON_TASK_RUNS_OPERATION_NAME,
  LIST_CRON_TASKS_OPERATION_NAME,
  RUN_CRON_TASK_NOW_OPERATION_NAME,
  UPDATE_CRON_TASK_OPERATION_NAME,
} from "../../shared/operation-names.js";
import type { WebuiOperation } from "./operation-contract.js";

const MAX_LIST_LIMIT = 200;

export const listCronTasksOperation: WebuiOperation<WebuiCronTaskListRequest, WebuiCronTaskPage> = {
  name: LIST_CRON_TASKS_OPERATION_NAME,
  validate: (body) => {
    // A list request with no body is the common case: the panel asks for the first page.
    if (body === undefined || body === null) return { ok: true, body: {} };
    if (typeof body !== "object" || Array.isArray(body)) {
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${LIST_CRON_TASKS_OPERATION_NAME} body must be an object when present`,
      };
    }
    const value = body as Record<string, unknown>;
    const agentName = value.agentName;
    if (agentName !== undefined && (typeof agentName !== "string" || agentName.trim() === "")) {
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "agentName must be a non-empty string",
      };
    }
    const cursor = value.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.trim() === "")) {
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "cursor must be a non-empty string",
      };
    }
    const limit = value.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT)
    ) {
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `limit must be an integer between 1 and ${String(MAX_LIST_LIMIT)}`,
      };
    }
    return {
      ok: true,
      body: {
        ...(agentName === undefined ? {} : { agentName: agentName as string }),
        ...(cursor === undefined ? {} : { cursor: cursor as string }),
        ...(limit === undefined ? {} : { limit: limit as number }),
      },
    };
  },
};

/** The one refusal shape the three mutations share, so the panel can name the field. */
function invalid(message: string): {
  readonly ok: false;
  readonly code: typeof WebuiErrorCode.invalidBody;
  readonly message: string;
} {
  return { ok: false, code: WebuiErrorCode.invalidBody, message };
}

function readText(value: unknown, field: string): string | { readonly error: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: `${field}不能为空。` };
  return value;
}

function readNullableText(
  value: unknown,
  field: string,
): string | null | undefined | { readonly error: string } {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return { error: `${field}必须是字符串或空值。` };
  return value;
}

function readSchedule(value: unknown): WebuiCronSchedule | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "schedule必须是对象。" };
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "once") {
    if (
      typeof record.runAtMs !== "number" ||
      !Number.isInteger(record.runAtMs) ||
      record.runAtMs <= 0
    ) {
      return { error: "schedule.runAtMs必须是未来的毫秒时间戳。" };
    }
    return { kind: "once", runAtMs: record.runAtMs };
  }
  if (record.kind !== "recurring") return { error: "schedule.kind必须是recurring或once。" };
  if (typeof record.expression !== "string" || record.expression.trim() === "") {
    return { error: "schedule.expression不能为空。" };
  }
  // Five fields is the cron grammar every host reads. Rejecting anything else here means the
  // editor learns which field is wrong instead of the scheduler skipping the job silently.
  const fields = record.expression.trim().split(/\s+/u);
  if (fields.length !== 5) return { error: "schedule.expression必须是五段的 cron 表达式。" };
  const timezone = record.timezone;
  if (timezone !== undefined && (typeof timezone !== "string" || timezone.trim() === "")) {
    return { error: "schedule.timezone必须是非空字符串。" };
  }
  const maxRuns = record.maxRuns;
  if (
    maxRuns !== undefined &&
    (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns <= 0)
  ) {
    return { error: "schedule.maxRuns必须是正整数。" };
  }
  return {
    kind: "recurring",
    expression: record.expression.trim(),
    ...(timezone === undefined ? {} : { timezone: timezone as string }),
    ...(maxRuns === undefined ? {} : { maxRuns: maxRuns as number }),
  };
}

function readSessionTarget(value: unknown): WebuiCronSessionTarget | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "sessionTarget必须是对象。" };
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "new") return { mode: "new" };
  if (record.mode !== "sessionId") return { error: "sessionTarget.mode必须是new或sessionId。" };
  if (record.sessionId === undefined) return { mode: "sessionId" };
  if (typeof record.sessionId !== "string" || record.sessionId.trim() === "") {
    return { error: "sessionTarget.sessionId必须是非空字符串。" };
  }
  return { mode: "sessionId", sessionId: record.sessionId };
}

export const createCronTaskOperation: WebuiOperation<WebuiCronTaskCreateRequest, WebuiCronTask> = {
  name: CREATE_CRON_TASK_OPERATION_NAME,
  validate: (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("createCronTask需要对象请求体。");
    }
    const value = body as Record<string, unknown>;
    const name = readText(value.name, "name");
    if (typeof name !== "string") return invalid(name.error);
    const agentName = readText(value.agentName, "agentName");
    if (typeof agentName !== "string") return invalid(agentName.error);
    const prompt = readText(value.prompt, "prompt");
    if (typeof prompt !== "string") return invalid(prompt.error);
    const schedule = readSchedule(value.schedule);
    if ("error" in schedule) return invalid(schedule.error);
    const sessionTarget = readSessionTarget(value.sessionTarget);
    if ("error" in sessionTarget) return invalid(sessionTarget.error);
    const project = readNullableText(value.project, "project");
    if (project !== undefined && project !== null && typeof project === "object") {
      return invalid(project.error);
    }
    const model = readNullableText(value.model, "model");
    if (model !== undefined && model !== null && typeof model === "object") {
      return invalid(model.error);
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      return invalid("enabled必须是布尔值。");
    }
    return {
      ok: true,
      body: {
        name,
        agentName,
        prompt,
        schedule,
        sessionTarget,
        ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
        ...(project === undefined ? {} : { project: project as string | null }),
        ...(model === undefined ? {} : { model: model as string | null }),
      },
    };
  },
};

export const updateCronTaskOperation: WebuiOperation<WebuiCronTaskUpdateRequest, WebuiCronTask> = {
  name: UPDATE_CRON_TASK_OPERATION_NAME,
  validate: (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("updateCronTask需要对象请求体。");
    }
    const value = body as Record<string, unknown>;
    const cronId = readText(value.cronId, "cronId");
    if (typeof cronId !== "string") return invalid(cronId.error);
    const patch: Record<string, unknown> = { cronId };
    if (value.name !== undefined) {
      const name = readText(value.name, "name");
      if (typeof name !== "string") return invalid(name.error);
      patch.name = name;
    }
    if (value.prompt !== undefined) {
      const prompt = readText(value.prompt, "prompt");
      if (typeof prompt !== "string") return invalid(prompt.error);
      patch.prompt = prompt;
    }
    if (value.schedule !== undefined) {
      const schedule = readSchedule(value.schedule);
      if ("error" in schedule) return invalid(schedule.error);
      patch.schedule = schedule;
    }
    if (value.sessionTarget !== undefined) {
      const sessionTarget = readSessionTarget(value.sessionTarget);
      if ("error" in sessionTarget) return invalid(sessionTarget.error);
      patch.sessionTarget = sessionTarget;
    }
    if (value.enabled !== undefined) {
      if (typeof value.enabled !== "boolean") return invalid("enabled必须是布尔值。");
      patch.enabled = value.enabled;
    }
    const project = readNullableText(value.project, "project");
    if (project !== undefined && project !== null && typeof project === "object") {
      return invalid(project.error);
    }
    if (project !== undefined) patch.project = project;
    const model = readNullableText(value.model, "model");
    if (model !== undefined && model !== null && typeof model === "object") {
      return invalid(model.error);
    }
    if (model !== undefined) patch.model = model;
    // A patch that changes nothing is a mistake, not a no-op: the panel sends one field at a time
    // and an empty body means it built the command wrong.
    if (Object.keys(patch).length === 1) return invalid("updateCronTask没有要修改的字段。");
    return { ok: true, body: patch as unknown as WebuiCronTaskUpdateRequest };
  },
};

export const deleteCronTaskOperation: WebuiOperation<
  WebuiCronTaskDeleteRequest,
  { readonly success?: boolean }
> = {
  name: DELETE_CRON_TASK_OPERATION_NAME,
  validate: (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("deleteCronTask需要对象请求体。");
    }
    const cronId = readText((body as Record<string, unknown>).cronId, "cronId");
    if (typeof cronId !== "string") return invalid(cronId.error);
    return { ok: true, body: { cronId } };
  },
};

export const runCronTaskNowOperation: WebuiOperation<WebuiCronTaskRunRequest, WebuiCronRun> = {
  name: RUN_CRON_TASK_NOW_OPERATION_NAME,
  validate: (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("runCronTaskNow需要对象请求体。");
    }
    const cronId = readText((body as Record<string, unknown>).cronId, "cronId");
    if (typeof cronId !== "string") return invalid(cronId.error);
    return { ok: true, body: { cronId } };
  },
};

export const listCronTaskRunsOperation: WebuiOperation<
  WebuiCronRunListRequest,
  WebuiCronRunPage
> = {
  name: LIST_CRON_TASK_RUNS_OPERATION_NAME,
  validate: (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("listCronTaskRuns需要对象请求体。");
    }
    const value = body as Record<string, unknown>;
    const cronId = readText(value.cronId, "cronId");
    if (typeof cronId !== "string") return invalid(cronId.error);
    const cursor = value.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.trim() === "")) {
      return invalid("cursor must be a non-empty string");
    }
    const limit = value.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT)
    ) {
      return invalid(`limit must be an integer between 1 and ${String(MAX_LIST_LIMIT)}`);
    }
    return {
      ok: true,
      body: {
        cronId,
        ...(cursor === undefined ? {} : { cursor: cursor as string }),
        ...(limit === undefined ? {} : { limit: limit as number }),
      },
    };
  },
};
