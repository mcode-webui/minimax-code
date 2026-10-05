/**
 * Scheduled tasks (`定时任务`) — the seven WebUI operations over the v2 cron
 * service, plus the structural declaration of that service.
 *
 * Why the service is declared here rather than imported: `CronService` and its
 * views belong to `@mavis/local-runtime-v2` and the equivalent contract glue
 * to `@mavis/local-runtime`, neither of which is a dependency of this package
 * (ADR 0005 keeps the WebUI build graph narrow). So the engine side is declared
 * structurally, exactly as `host.ts` declares the runtime host, and every field
 * is a verbatim copy of the frozen v2 contract
 * (`D:\temp\mmx-webui-cron\CONTRACT.md` §2 ←
 * `packages/local-runtime-v2/src/service/cron/contracts.ts`). The assembly
 * type-check is what proves the two models still line up.
 *
 * v2 moved addressing from `agentName` + `cronName` to a single `cronId`, and
 * replaced the v1 string schedule with a structured `CronSchedule`. There is no
 * polarity flip left to port: the wire `enabled` and the stored `active` are
 * both spelled `enabled` on the v2 command surface.
 *
 * Expression *parsing* stays with the runtime: `createDefinition` /
 * `updateDefinition` run the scheduler's own check before touching the store,
 * so a bad expression is rejected once, by the same code path the desktop and
 * the CLI use. What this module checks up front is the structural part so an
 * obviously malformed schedule never reaches the store as a 500.
 */

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
  WebuiCreateCronDefinitionRequest,
  WebuiCronDefinition,
  WebuiCronIdRequest,
  WebuiCronMutationResult,
  WebuiCronPage,
  WebuiCronRun,
  WebuiCronSchedule,
  WebuiCronSessionTarget,
  WebuiListCronDefinitionsRequest,
  WebuiListCronRunsRequest,
  WebuiUpdateCronDefinitionRequest,
} from "../port.js";
import {
  CREATE_CRON_DEFINITION_OPERATION_NAME,
  DELETE_CRON_DEFINITION_OPERATION_NAME,
  GET_CRON_DEFINITION_OPERATION_NAME,
  LIST_CRON_DEFINITIONS_OPERATION_NAME,
  LIST_CRON_RUNS_OPERATION_NAME,
  TRIGGER_CRON_RUN_OPERATION_NAME,
  UPDATE_CRON_DEFINITION_OPERATION_NAME,
} from "./names.js";

/* Engine-side shapes.
 *
 * Structural mirror of the v2 `CronService`. `host.ts` narrows the runtime's
 * `services.cron` onto this, so the assembly type-check is what proves the two
 * models still line up. The metric-context arguments the runtime accepts are
 * omitted: the WebUI never passes them, and leaving them out keeps this
 * declaration to exactly the surface it calls. */
export interface WebuiCronService {
  listDefinitions(query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeDeleted?: boolean;
    readonly agentName?: string;
  }): WebuiCronPage<WebuiCronDefinition>;
  getDefinition(cronId: string): WebuiCronDefinition | undefined;
  createDefinition(
    command: WebuiCreateCronDefinitionRequest,
  ): Promise<WebuiCronDefinition>;
  updateDefinition(
    command: WebuiUpdateCronDefinitionRequest,
  ): Promise<WebuiCronDefinition>;
  deleteDefinition(command: WebuiCronIdRequest): void | Promise<void>;
  deleteDefinitionsByAgent(agentName: string): void;
  triggerManualRun(cronId: string): Promise<WebuiCronRun>;
  listRuns(query: {
    readonly cronId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): WebuiCronPage<WebuiCronRun>;
}

/* ── Error mapping ────────────────────────────────────────────────────────── */

/**
 * A cron failure carrying the status the frozen desktop contract would have
 * returned. The WebUI envelope has one `harness_error` code, so the status
 * travels in the message and on this class; the panel branches on the wording
 * the runtime itself produced.
 */
export class WebuiCronError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly cronCode?: string,
  ) {
    super(message);
    this.name = "WebuiCronError";
  }
}

/** Mirror of the runtime's own cron contract error projection. */
export function toWebuiCronError(error: unknown): WebuiCronError {
  if (error instanceof WebuiCronError) return error;
  const candidate = (error ?? {}) as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message : String(error);
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  let status =
    typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : typeof candidate.status === "number"
        ? candidate.status
        : 500;
  // The repository raises duplicates as `CRON_DEFINITION_EXISTS` /
  // statusCode 409, but a store that cannot be opened throws a plain Error
  // that would otherwise land on 500. Both have to read as "this name is
  // taken".
  const duplicate =
    code === "CRON_TASK_EXISTS" ||
    code === "CRON_DEFINITION_EXISTS" ||
    /already exists|already registered/i.test(message);
  if (duplicate) {
    status = 409;
  } else if (status === 500 && /not found/i.test(message)) {
    status = 404;
  }
  return new WebuiCronError(status, message, code);
}

/* ── Shared field readers ─────────────────────────────────────────────────── */

/** `null` marks "present but unusable"; `undefined` means "absent". */
function scheduleField(
  operation: string,
  body: Record<string, unknown>,
): WebuiCronSchedule | undefined | null {
  const value = body.schedule;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "once") {
    const runAtMs = candidate.runAtMs;
    return typeof runAtMs === "number" && Number.isFinite(runAtMs)
      ? { kind: "once", runAtMs }
      : null;
  }
  if (candidate.kind === "recurring") {
    const expression = candidate.expression;
    if (typeof expression !== "string" || !expression.trim()) return null;
    const timezone = candidate.timezone;
    if (timezone !== undefined && typeof timezone !== "string") return null;
    const maxRuns = candidate.maxRuns;
    if (
      maxRuns !== undefined &&
      (!Number.isInteger(maxRuns) || (maxRuns as number) < 1)
    )
      return null;
    return {
      kind: "recurring",
      expression,
      ...(timezone !== undefined ? { timezone: timezone as string } : {}),
      ...(maxRuns !== undefined ? { maxRuns: maxRuns as number } : {}),
    };
  }
  return null;
}

/** `null` marks "present but unusable"; `undefined` means "absent". */
function sessionTargetField(
  operation: string,
  body: Record<string, unknown>,
): WebuiCronSessionTarget | undefined | null {
  const value = body.sessionTarget;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "new") return { mode: "new" };
  if (candidate.mode === "sessionId") {
    const sessionId = candidate.sessionId;
    // `sessionId` is optional on the v2 union: absent means "bind the first
    // session this definition creates".
    if (sessionId === undefined) return { mode: "sessionId" };
    return typeof sessionId === "string" && sessionId
      ? { mode: "sessionId", sessionId }
      : null;
  }
  return null;
}

/**
 * An absent optional field, kept distinct from a present-and-`null` one:
 * `project: null` is the "no project" value the panel sends, not an omission.
 */
type OptionalField<T> =
  | { readonly present: false }
  | { readonly present: true; readonly value: T };

function isValidationFailure<T>(
  field: OptionalField<T> | ValidationFailure,
): field is ValidationFailure {
  return (field as ValidationFailure).ok === false;
}

function optionalBooleanField(
  operation: string,
  body: Record<string, unknown>,
  key: string,
): OptionalField<boolean> | ValidationFailure {
  const value = body[key];
  if (value === undefined) return { present: false };
  if (typeof value !== "boolean")
    return invalidBody(`${operation} ${key} must be a boolean`);
  return { present: true, value };
}

/** `project` / `model` are `string | null`; anything else is unusable. */
function optionalNullableStringField(
  operation: string,
  body: Record<string, unknown>,
  key: string,
): OptionalField<string | null> | ValidationFailure {
  const value = body[key];
  if (value === undefined) return { present: false };
  if (value !== null && typeof value !== "string")
    return invalidBody(`${operation} ${key} must be a string or null`);
  return { present: true, value: value as string | null };
}

/* ── Validation ───────────────────────────────────────────────────────────── */

export const listCronDefinitionsOperation: WebuiOperation<
  WebuiListCronDefinitionsRequest,
  WebuiCronPage<WebuiCronDefinition>
> = {
  name: LIST_CRON_DEFINITIONS_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined) return { ok: true, body: {} };
    const record = requireRecord(LIST_CRON_DEFINITIONS_OPERATION_NAME, body);
    if (!record.ok) return record;
    const value = record.body;
    const page = pageValidation(LIST_CRON_DEFINITIONS_OPERATION_NAME, value);
    if (!page.ok) return page;
    if (value.agentName !== undefined && typeof value.agentName !== "string")
      return invalidBody(
        `${LIST_CRON_DEFINITIONS_OPERATION_NAME} agentName must be a string`,
      );
    return {
      ok: true,
      body: {
        ...page.body,
        ...(value.agentName !== undefined
          ? { agentName: value.agentName as string }
          : {}),
      },
    };
  },
};

export const getCronDefinitionOperation: WebuiOperation<
  WebuiCronIdRequest,
  WebuiCronDefinition | undefined
> = {
  name: GET_CRON_DEFINITION_OPERATION_NAME,
  validate: (body) => validateCronIdBody(GET_CRON_DEFINITION_OPERATION_NAME, body),
};

export const createCronDefinitionOperation: WebuiOperation<WebuiCreateCronDefinitionRequest> =
  {
    name: CREATE_CRON_DEFINITION_OPERATION_NAME,
    validate: (body) => {
      const record = requireRecord(CREATE_CRON_DEFINITION_OPERATION_NAME, body);
      if (!record.ok) return record;
      const value = record.body;
      const name = requireNonEmptyString(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "name",
      );
      if (typeof name !== "string") return name;
      const agentName = requireNonEmptyString(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "agentName",
      );
      if (typeof agentName !== "string") return agentName;
      const prompt = requireNonEmptyString(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "prompt",
      );
      if (typeof prompt !== "string") return prompt;
      const schedule = scheduleField(CREATE_CRON_DEFINITION_OPERATION_NAME, value);
      if (!schedule)
        return invalidBody(
          `${CREATE_CRON_DEFINITION_OPERATION_NAME} schedule must be { kind: "recurring", expression } or { kind: "once", runAtMs }`,
        );
      const sessionTarget = sessionTargetField(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
      );
      if (!sessionTarget)
        return invalidBody(
          `${CREATE_CRON_DEFINITION_OPERATION_NAME} sessionTarget must be { mode: "new" } or { mode: "sessionId", sessionId }`,
        );
      const enabled = optionalBooleanField(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "enabled",
      );
      if (isValidationFailure(enabled)) return enabled;
      const project = optionalNullableStringField(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "project",
      );
      if (isValidationFailure(project)) return project;
      const model = optionalNullableStringField(
        CREATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "model",
      );
      if (isValidationFailure(model)) return model;
      return {
        ok: true,
        body: {
          name,
          agentName,
          prompt,
          schedule,
          sessionTarget,
          ...(enabled.present ? { enabled: enabled.value } : {}),
          ...(project.present ? { project: project.value } : {}),
          ...(model.present ? { model: model.value } : {}),
        },
      };
    },
  };

export const updateCronDefinitionOperation: WebuiOperation<WebuiUpdateCronDefinitionRequest> =
  {
    name: UPDATE_CRON_DEFINITION_OPERATION_NAME,
    validate: (body) => {
      const record = requireRecord(UPDATE_CRON_DEFINITION_OPERATION_NAME, body);
      if (!record.ok) return record;
      const value = record.body;
      const cronId = requireNonEmptyString(
        UPDATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "cronId",
      );
      if (typeof cronId !== "string") return cronId;
      if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim()))
        return invalidBody(
          `${UPDATE_CRON_DEFINITION_OPERATION_NAME} name must be a non-empty string`,
        );
      if (value.prompt !== undefined && (typeof value.prompt !== "string" || !value.prompt.trim()))
        return invalidBody(
          `${UPDATE_CRON_DEFINITION_OPERATION_NAME} prompt must be a non-empty string`,
        );
      let schedule: WebuiCronSchedule | undefined;
      if (value.schedule !== undefined) {
        const parsed = scheduleField(UPDATE_CRON_DEFINITION_OPERATION_NAME, value);
        if (!parsed)
          return invalidBody(
            `${UPDATE_CRON_DEFINITION_OPERATION_NAME} schedule must be { kind: "recurring", expression } or { kind: "once", runAtMs }`,
          );
        schedule = parsed;
      }
      let sessionTarget: WebuiCronSessionTarget | undefined;
      if (value.sessionTarget !== undefined) {
        const parsed = sessionTargetField(
          UPDATE_CRON_DEFINITION_OPERATION_NAME,
          value,
        );
        if (!parsed)
          return invalidBody(
            `${UPDATE_CRON_DEFINITION_OPERATION_NAME} sessionTarget must be { mode: "new" } or { mode: "sessionId", sessionId }`,
          );
        sessionTarget = parsed;
      }
      const enabled = optionalBooleanField(
        UPDATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "enabled",
      );
      if (isValidationFailure(enabled)) return enabled;
      const project = optionalNullableStringField(
        UPDATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "project",
      );
      if (isValidationFailure(project)) return project;
      const model = optionalNullableStringField(
        UPDATE_CRON_DEFINITION_OPERATION_NAME,
        value,
        "model",
      );
      if (isValidationFailure(model)) return model;
      return {
        ok: true,
        body: {
          cronId,
          ...(value.name !== undefined ? { name: value.name as string } : {}),
          ...(value.prompt !== undefined ? { prompt: value.prompt as string } : {}),
          ...(schedule !== undefined ? { schedule } : {}),
          ...(sessionTarget !== undefined ? { sessionTarget } : {}),
          ...(enabled.present ? { enabled: enabled.value } : {}),
          ...(project.present ? { project: project.value } : {}),
          ...(model.present ? { model: model.value } : {}),
        },
      };
    },
  };

export const deleteCronDefinitionOperation: WebuiOperation<
  WebuiCronIdRequest,
  WebuiCronMutationResult
> = {
  name: DELETE_CRON_DEFINITION_OPERATION_NAME,
  validate: (body) =>
    validateCronIdBody(DELETE_CRON_DEFINITION_OPERATION_NAME, body),
};

export const triggerCronRunOperation: WebuiOperation<
  WebuiCronIdRequest,
  WebuiCronRun
> = {
  name: TRIGGER_CRON_RUN_OPERATION_NAME,
  validate: (body) => validateCronIdBody(TRIGGER_CRON_RUN_OPERATION_NAME, body),
};

export const listCronRunsOperation: WebuiOperation<
  WebuiListCronRunsRequest,
  WebuiCronPage<WebuiCronRun>
> = {
  name: LIST_CRON_RUNS_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(LIST_CRON_RUNS_OPERATION_NAME, body);
    if (!record.ok) return record;
    const cronId = requireNonEmptyString(
      LIST_CRON_RUNS_OPERATION_NAME,
      record.body,
      "cronId",
    );
    if (typeof cronId !== "string") return cronId;
    const page = pageValidation(LIST_CRON_RUNS_OPERATION_NAME, record.body);
    if (!page.ok) return page;
    return { ok: true, body: { cronId, ...page.body } };
  },
};

function validateCronIdBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<WebuiCronIdRequest> {
  const record = requireRecord(operation, body);
  if (!record.ok) return record;
  const cronId = requireNonEmptyString(operation, record.body, "cronId");
  if (typeof cronId !== "string") return cronId;
  return { ok: true, body: { cronId } };
}

/**
 * Shared optional `cursor` / `limit` reader. Mirrors the validation-result
 * shape the operations already return so callers can forward a failure without
 * inspecting which union member they got.
 */
function pageValidation(
  operation: string,
  body: Record<string, unknown>,
): WebuiOperationValidation<{
  readonly cursor?: string;
  readonly limit?: number;
}> {
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) < 1))
    return invalidBody(`${operation} limit must be a positive integer`);
  if (body.cursor !== undefined && typeof body.cursor !== "string")
    return invalidBody(`${operation} cursor must be a string`);
  return {
    ok: true,
    body: {
      ...(body.cursor !== undefined ? { cursor: body.cursor as string } : {}),
      ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
    },
  };
}
