/**
 * Scheduled tasks (`定时任务`) — the five WebUI operations plus the thin
 * mapping layer between the wire shapes in `../port.ts` and the runtime cron
 * engine's own model.
 *
 * Why the mapping lives here rather than being imported: the engine's
 * `CronTaskState` / `CronConfig` / `SessionConfig` belong to `@mavis/cron`
 * and the equivalent contract glue to `@mavis/local-runtime`, and neither is
 * a dependency of this package (ADR 0005 keeps the WebUI build graph narrow).
 * So the engine side is declared structurally, exactly as `host.ts` declares
 * the runtime host, and the semantics are ported 1:1 from
 * `packages/local-runtime/src/cron/contract.ts`:
 *
 *  - wire `enabled` ↔ engine `disabled` (polarity flip),
 *  - wire `session` (tagged union) ↔ engine `session` (tagged union),
 *  - wire `activeHours` / `timezone` pass-through, empty timezone clears,
 *  - duplicate cron → 409, not-found → 404, validation → 400.
 *
 * Cron expression *parsing* stays with the engine: `registry.createTask` /
 * `updateConfig` both run their own scheduler check before touching the
 * store, so a bad expression is rejected once, by the same code path the
 * desktop and the CLI use. What this module does check up front is the
 * structural part (field count, character set) so an obviously malformed
 * expression never reaches the store as a 500.
 */

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
  WebuiCreateCronRequest,
  WebuiCronSession,
  WebuiCronTask,
  WebuiDeleteCronRequest,
  WebuiListCronsResult,
  WebuiTriggerCronRequest,
  WebuiUpdateCronRequest,
} from "../port.js";
import {
  CREATE_CRON_OPERATION_NAME,
  DELETE_CRON_OPERATION_NAME,
  LIST_CRONS_OPERATION_NAME,
  TRIGGER_CRON_OPERATION_NAME,
  UPDATE_CRON_OPERATION_NAME,
} from "./names.js";

const CRON_NAME_RE = /^[^\s/\\:*?"<>|]+$/;
const ACTIVE_HOURS_RE = /^\d{2}:\d{2}$/;
const MAX_CRON_NAME_LENGTH = 64;
const CRON_FIELD_COUNT_RE = /^[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+(\s+[^\s]+)?$/;

/* Engine-side shapes.
 *
 * Structural mirrors of `@mavis/cron`'s `CronTaskState` / `CronConfig` and of
 * the six `CronRegistry` methods this surface uses. `host.ts` narrows the
 * runtime's `cronRuntime` onto these, so the assembly type-check is what
 * proves the two models still line up. */

export interface WebuiCronEngineConfig {
  readonly disabled?: boolean;
  readonly schedule: string;
  readonly scheduleType?: "cron" | "once";
  readonly prompt: string;
  readonly timezone?: string;
  readonly activeHours?: { readonly start: string; readonly end: string };
  /** Engine tagged union — structurally identical to the wire `session`. */
  readonly session: WebuiCronSession;
}

export interface WebuiCronEngineConfigUpdate {
  disabled?: boolean;
  schedule?: string;
  prompt?: string;
  /** `null` clears the timezone, mirroring the engine's own update shape. */
  timezone?: string | null;
}

export interface WebuiCronEngineTaskState {
  readonly agentName: string;
  readonly cronName: string;
  readonly cronId?: string;
  readonly config: WebuiCronEngineConfig;
  readonly enabled: boolean;
  readonly lastRun: number | null;
  readonly lastResult: string | null;
  readonly lastError: string | null;
  readonly nextRun: number | null;
  readonly status: "idle" | "running" | "skipped";
}

export interface WebuiCronEngineRegistry {
  listAllTasks(): readonly WebuiCronEngineTaskState[];
  getTask(agentName: string, cronName: string): WebuiCronEngineTaskState | undefined;
  createTask(
    agentName: string,
    cronName: string,
    config: WebuiCronEngineConfig,
  ): Promise<WebuiCronEngineTaskState>;
  updateConfig(
    agentName: string,
    cronName: string,
    update: WebuiCronEngineConfigUpdate,
  ): Promise<WebuiCronEngineTaskState | undefined>;
  deleteTask(agentName: string, cronName: string): Promise<boolean>;
  triggerTask(agentName: string, cronName: string): Promise<unknown>;
}

/**
 * The runtime's scheduled-task engine. Optional on the host handle: a host
 * that predates it (and every existing test double) keeps type-checking, and
 * `host.ts` fails each cron port method closed with one clear message.
 */
export interface WebuiCronRuntime {
  /**
   * Starts the scheduler on demand. The WebUI never relies on a cold-start
   * restore (ADR 0002 keeps `startupExecutionPolicy: 'quarantined'`), so this
   * call is what pulls the scheduler up before the registry is read.
   */
  ensureStarted(reason?: string): Promise<void>;
  readonly registry: WebuiCronEngineRegistry;
}

/* ── Error mapping ────────────────────────────────────────────────────────── */

/**
 * A cron failure with the status the desktop contract would have returned.
 * The WebUI envelope has one `harness_error` code, so the status travels in
 * the message and on this class; the panel branches on the wording the
 * runtime itself produced.
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

/** Mirror of `local-runtime`'s `toCronContractError`. */
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
  // The registry raises duplicates as `CRON_TASK_EXISTS` / statusCode 409,
  // but older store paths throw a plain Error that would otherwise land on
  // 500. Both have to read as "this name is taken".
  const duplicate =
    code === "CRON_TASK_EXISTS" ||
    /already exists|already registered/i.test(message);
  if (duplicate) {
    status = 409;
  } else if (status === 500 && /not found/i.test(message)) {
    status = 404;
  }
  return new WebuiCronError(status, message, code);
}

/* ── Mapping ──────────────────────────────────────────────────────────────── */

/** Engine tagged union → wire session. */
export function webuiSessionFromEngineSession(
  session: WebuiCronSession,
): WebuiCronSession {
  if (session.mode === "new") {
    return session.keepSessions === undefined || session.keepSessions === null
      ? { mode: "new" }
      : { mode: "new", keepSessions: session.keepSessions };
  }
  return session.mode === "sessionId"
    ? { mode: "sessionId", sessionId: session.sessionId }
    : { mode: "root" };
}

/** Engine task state → wire task. */
export function webuiCronTaskFromEngineState(
  state: WebuiCronEngineTaskState,
): WebuiCronTask {
  return {
    cronName: state.cronName,
    agentName: state.agentName,
    ...(state.cronId ? { cronId: state.cronId } : {}),
    schedule: state.config.schedule,
    scheduleType: state.config.scheduleType === "once" ? "once" : "cron",
    ...(state.config.timezone !== undefined
      ? { timezone: state.config.timezone }
      : {}),
    enabled: state.enabled,
    prompt: state.config.prompt,
    session: webuiSessionFromEngineSession(state.config.session),
    ...(state.config.activeHours
      ? {
          activeHours: {
            start: state.config.activeHours.start,
            end: state.config.activeHours.end,
          },
        }
      : {}),
    status: state.status,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    lastError: state.lastError,
    nextRun: state.nextRun,
  };
}

/** Wire create request → engine config (`enabled` ↔ `disabled` flip). */
export function webuiCreateRequestToEngineConfig(
  request: WebuiCreateCronRequest,
): WebuiCronEngineConfig {
  return {
    schedule: request.schedule,
    scheduleType: "cron",
    prompt: request.prompt,
    ...(request.timezone ? { timezone: request.timezone } : {}),
    ...(request.activeHours
      ? {
          activeHours: {
            start: request.activeHours.start,
            end: request.activeHours.end,
          },
        }
      : {}),
    session: request.session ?? { mode: "new" },
    disabled: request.enabled === undefined ? false : !request.enabled,
  };
}

/** Wire update request → engine config update (absent field = untouched). */
export function webuiUpdateRequestToEngineUpdate(
  request: WebuiUpdateCronRequest,
): WebuiCronEngineConfigUpdate {
  const update: {
    disabled?: boolean;
    schedule?: string;
    prompt?: string;
    timezone?: string | null;
  } = {};
  if (request.enabled !== undefined) update.disabled = !request.enabled;
  if (request.schedule !== undefined) update.schedule = request.schedule;
  if (request.prompt !== undefined) update.prompt = request.prompt;
  // Empty string is the wire's "clear the timezone" signal, not a zone.
  if (request.timezone !== undefined)
    update.timezone = request.timezone === "" ? null : request.timezone;
  return update;
}

/* ── Validation ───────────────────────────────────────────────────────────── */

export const listCronsOperation: WebuiOperation<undefined, WebuiListCronsResult> =
  {
    name: LIST_CRONS_OPERATION_NAME,
    validate: (body) =>
      body === undefined
        ? { ok: true, body: undefined }
        : {
            ok: false,
            code: WebuiErrorCode.invalidBody,
            message: `${LIST_CRONS_OPERATION_NAME} does not accept a body`,
          },
  };

export const createCronOperation: WebuiOperation<WebuiCreateCronRequest> = {
  name: CREATE_CRON_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(CREATE_CRON_OPERATION_NAME, body);
    if (!record.ok) return record;
    const value = record.body;
    const agentName = requireNonEmptyString(
      CREATE_CRON_OPERATION_NAME,
      value,
      "agentName",
    );
    if (typeof agentName !== "string") return agentName;
    const cronName = cronNameField(CREATE_CRON_OPERATION_NAME, value);
    if (typeof cronName !== "string") return cronName;
    const schedule = requireNonEmptyString(
      CREATE_CRON_OPERATION_NAME,
      value,
      "schedule",
    );
    if (typeof schedule !== "string") return schedule;
    const scheduleProblem = cronScheduleProblem(schedule);
    if (scheduleProblem)
      return invalidBody(`${CREATE_CRON_OPERATION_NAME} ${scheduleProblem}`);
    const prompt = requireNonEmptyString(CREATE_CRON_OPERATION_NAME, value, "prompt");
    if (typeof prompt !== "string") return prompt;
    if (value.timezone !== undefined && typeof value.timezone !== "string")
      return invalidBody(`${CREATE_CRON_OPERATION_NAME} timezone must be a string`);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
      return invalidBody(`${CREATE_CRON_OPERATION_NAME} enabled must be a boolean`);
    const activeHours = activeHoursField(value);
    if (activeHours === null)
      return invalidBody(
        `${CREATE_CRON_OPERATION_NAME} activeHours must be { start, end } in HH:MM format`,
      );
    const session = sessionField(value);
    if (session === null)
      return invalidBody(
        `${CREATE_CRON_OPERATION_NAME} session must be { mode: "root" }, { mode: "sessionId", sessionId } or { mode: "new", keepSessions }`,
      );
    return {
      ok: true,
      body: {
        agentName,
        cronName,
        schedule,
        prompt,
        ...(value.timezone ? { timezone: value.timezone as string } : {}),
        ...(value.enabled !== undefined
          ? { enabled: value.enabled as boolean }
          : {}),
        ...(session ? { session } : {}),
        ...(activeHours ? { activeHours } : {}),
      },
    };
  },
};

export const updateCronOperation: WebuiOperation<WebuiUpdateCronRequest> = {
  name: UPDATE_CRON_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(UPDATE_CRON_OPERATION_NAME, body);
    if (!record.ok) return record;
    const value = record.body;
    const agentName = requireNonEmptyString(
      UPDATE_CRON_OPERATION_NAME,
      value,
      "agentName",
    );
    if (typeof agentName !== "string") return agentName;
    const cronName = cronNameField(UPDATE_CRON_OPERATION_NAME, value);
    if (typeof cronName !== "string") return cronName;
    if (value.schedule !== undefined) {
      if (typeof value.schedule !== "string" || !value.schedule.trim())
        return invalidBody(
          `${UPDATE_CRON_OPERATION_NAME} schedule must be a non-empty string`,
        );
      const scheduleProblem = cronScheduleProblem(value.schedule);
      if (scheduleProblem) return invalidBody(`${UPDATE_CRON_OPERATION_NAME} ${scheduleProblem}`);
    }
    if (
      value.prompt !== undefined &&
      (typeof value.prompt !== "string" || !value.prompt.trim())
    )
      return invalidBody(`${UPDATE_CRON_OPERATION_NAME} prompt must be a non-empty string`);
    // The empty string is the documented "clear the timezone" value, so it
    // passes here and becomes `null` in the engine update.
    if (value.timezone !== undefined && typeof value.timezone !== "string")
      return invalidBody(`${UPDATE_CRON_OPERATION_NAME} timezone must be a string`);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
      return invalidBody(`${UPDATE_CRON_OPERATION_NAME} enabled must be a boolean`);
    return {
      ok: true,
      body: {
        agentName,
        cronName,
        ...(value.schedule !== undefined ? { schedule: value.schedule as string } : {}),
        ...(value.prompt !== undefined ? { prompt: value.prompt as string } : {}),
        ...(value.timezone !== undefined
          ? { timezone: value.timezone as string }
          : {}),
        ...(value.enabled !== undefined ? { enabled: value.enabled as boolean } : {}),
      },
    };
  },
};

export const deleteCronOperation: WebuiOperation<WebuiDeleteCronRequest> = {
  name: DELETE_CRON_OPERATION_NAME,
  validate: (body) => validateCronKeyBody(DELETE_CRON_OPERATION_NAME, body),
};

export const triggerCronOperation: WebuiOperation<WebuiTriggerCronRequest> = {
  name: TRIGGER_CRON_OPERATION_NAME,
  validate: (body) => validateCronKeyBody(TRIGGER_CRON_OPERATION_NAME, body),
};

function validateCronKeyBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<WebuiDeleteCronRequest> {
  const record = requireRecord(operation, body);
  if (!record.ok) return record;
  const agentName = requireNonEmptyString(operation, record.body, "agentName");
  if (typeof agentName !== "string") return agentName;
  const cronName = cronNameField(operation, record.body);
  if (typeof cronName !== "string") return cronName;
  return { ok: true, body: { agentName, cronName } };
}

/** `null` marks "present but unusable"; `undefined` means "absent". */
function cronNameField(
  operation: string,
  body: Record<string, unknown>,
): string | ValidationFailure {
  const cronName = requireNonEmptyString(operation, body, "cronName");
  if (typeof cronName !== "string") return cronName;
  if (cronName.length > MAX_CRON_NAME_LENGTH || !CRON_NAME_RE.test(cronName))
    return invalidBody(
      `${operation} cronName must be 1-${MAX_CRON_NAME_LENGTH} characters without whitespace or / \\ : * ? " < > |`,
    );
  return cronName;
}

/** `null` marks "present but unusable"; `undefined` means "absent". */
function activeHoursField(
  body: Record<string, unknown>,
): { readonly start: string; readonly end: string } | undefined | null {
  const value = body.activeHours;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  const { start, end } = candidate;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!ACTIVE_HOURS_RE.test(start) || !ACTIVE_HOURS_RE.test(end)) return null;
  return { start, end };
}

function sessionField(
  body: Record<string, unknown>,
): WebuiCronSession | undefined | null {
  const value = body.session;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "root") return { mode: "root" };
  if (candidate.mode === "sessionId") {
    return typeof candidate.sessionId === "string" && candidate.sessionId
      ? { mode: "sessionId", sessionId: candidate.sessionId }
      : null;
  }
  if (candidate.mode === "new") {
    const keep = candidate.keepSessions;
    if (keep === undefined || keep === null) return { mode: "new" };
    if (typeof keep === "number" && Number.isInteger(keep) && keep >= 1)
      return { mode: "new", keepSessions: keep };
    return null;
  }
  return null;
}

/**
 * Structural schedule check only. The authoritative parse is the engine's own
 * `assertSchedulable`, which `createTask` / `updateConfig` run before the
 * store sees the config; this keeps an obviously malformed expression from
 * reaching it as a request the engine cannot interpret.
 */
function cronScheduleProblem(schedule: string): string | undefined {
  const trimmed = schedule.trim();
  if (!CRON_FIELD_COUNT_RE.test(trimmed))
    return "schedule must have 5 or 6 whitespace-separated fields";
  return undefined;
}
