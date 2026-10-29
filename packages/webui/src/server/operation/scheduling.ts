// The scheduled-task wire operations (ADR 0027).
//
// One operation so far: the list. Creating, editing, deleting, running and reading history arrive in
// their own tickets; they belong in this file because they are one domain and one client business,
// and splitting them across files would make the registry's order read as three unrelated groups.
//
// `listCronTasks` validates the paging envelope only. What a task *is* is the adapter's business:
// the runtime's cron view converts to a `WebuiCronTask` behind the harness port, so this layer
// checks the shape a browser may send and never learns the runtime's model.
import type { WebuiCronTaskListRequest, WebuiCronTaskPage } from "../../shared/contracts/cron.js";
import { WebuiErrorCode } from "../../shared/envelope.js";
import { LIST_CRON_TASKS_OPERATION_NAME } from "../../shared/operation-names.js";
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
