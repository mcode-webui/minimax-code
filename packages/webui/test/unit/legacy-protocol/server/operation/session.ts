import { WebuiErrorCode } from "../envelope.js";
import {
  invalidBody,
  requireNonEmptyString,
  requireRecord,
} from "./operation-contract.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import type {
  WebuiActiveTurnResult,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiSessionListRequest,
  WebuiSessionLookupRequest,
  WebuiSessionLookupResult,
  WebuiSessionTreeRequest,
  WebuiSessionTreePage,
} from "../port.js";
import { validateAbsoluteDirectory, validateSessionIdBody } from "./common.js";
import { VERSION_OPERATION_NAME, LIST_SESSIONS_OPERATION_NAME, LIST_VISIBLE_PROJECTS_OPERATION_NAME, GET_SESSION_TREE_OPERATION_NAME, CREATE_SESSION_OPERATION_NAME, GET_SESSION_OPERATION_NAME, GET_ACTIVE_TURN_OPERATION_NAME } from "./names.js";
type VersionRequestBody = undefined;

interface VersionResponseBody {
  readonly version: string;
  readonly protocolVersion: number;
}

function validateVersionRequestBody(
  body: unknown,
): WebuiOperationValidation<VersionRequestBody> {
  // The version operation carries no body. A present-but-empty JSON
  // value (`null`, `[]`, `{}`) is rejected so a future caller cannot
  // smuggle a field in by encoding the body as something other than
  // an absent field.
  if (body === undefined) return { ok: true, body: undefined };
  return invalidBody("version operation does not accept a body");
}

export const versionOperation: WebuiOperation<VersionRequestBody> = {
  name: VERSION_OPERATION_NAME,
  validate: validateVersionRequestBody,
};

function validateListSessionsRequestBody(
  body: unknown,
): WebuiOperationValidation<WebuiSessionListRequest> {
  const record = requireRecord("listSessions", body);
  if (!record.ok) return record;
  const candidate = record.body;
  const name = requireNonEmptyString("listSessions", candidate, "name");
  if (typeof name !== "string") return name;
  for (const key of ["limit", "offset"] as const) {
    if (
      candidate[key] !== undefined &&
      (!Number.isInteger(candidate[key]) || (candidate[key] as number) < 0)
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${key} must be a non-negative integer`,
      };
  }
  if (candidate.cursor !== undefined && typeof candidate.cursor !== "string")
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "cursor must be a string",
    };
  return { ok: true, body: candidate as unknown as WebuiSessionListRequest };
}

export const listSessionsOperation: WebuiOperation<
  WebuiSessionListRequest,
  import("../port.js").WebuiSessionPage
> = {
  name: LIST_SESSIONS_OPERATION_NAME,
  validate: validateListSessionsRequestBody,
};

export const listVisibleProjectsOperation: WebuiOperation<
  { readonly limit?: number },
  readonly import("../port.js").WebuiProjectRecord[]
> = {
  name: LIST_VISIBLE_PROJECTS_OPERATION_NAME,
  validate(body) {
    if (body === undefined) return { ok: true, body: {} };
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return invalidBody("listVisibleProjects body must be an object");
    const limit = (body as Record<string, unknown>).limit;
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100))
      return invalidBody("limit must be an integer between 1 and 100");
    return { ok: true, body: limit === undefined ? {} : { limit: limit as number } };
  },
};

function validateGetSessionTreeRequestBody(
  body: unknown,
): WebuiOperationValidation<WebuiSessionTreeRequest> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "getSessionTree body must be an object",
    };
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "")
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "getSessionTree body requires a non-empty name",
    };
  if (
    candidate.limit !== undefined &&
    (!Number.isInteger(candidate.limit) || (candidate.limit as number) < 0)
  )
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "limit must be a non-negative integer",
    };
  if (candidate.cursor !== undefined && typeof candidate.cursor !== "string")
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "cursor must be a string",
    };
  for (const key of [
    "includeArchived",
    "onlyArchived",
    "onlyCompressed",
    "includeHidden",
  ] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "boolean")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${key} must be a boolean`,
      };
  }
  for (const key of [
    "includePurposePrefix",
    "excludePurposePrefix",
  ] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${key} must be a string`,
      };
  }
  return { ok: true, body: candidate as unknown as WebuiSessionTreeRequest };
}

export const getSessionTreeOperation: WebuiOperation<
  WebuiSessionTreeRequest,
  WebuiSessionTreePage
> = {
  name: GET_SESSION_TREE_OPERATION_NAME,
  validate: validateGetSessionTreeRequestBody,
};

function validateCreateSessionRequestBody(
  body: unknown,
): WebuiOperationValidation<WebuiCreateSessionRequest> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "createSession body must be an object",
    };
  const candidate = body as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name)
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "createSession body requires a non-empty name",
    };
  // `workspaceDir` is optional: the harness resolves a default workspace
  // when it is absent (desktop's 不需要项目 / default-directory flows).
  // When present it must be a real absolute path — relative and missing
  // directories are still rejected. The browser project picker cannot
  // produce one (see `validateAbsoluteDirectory`), so this is also what
  // stops a bare folder name from becoming a session's cwd.
  const workspaceDir =
    typeof candidate.workspaceDir === "string"
      ? candidate.workspaceDir.trim()
      : "";
  if (candidate.workspaceDir !== undefined && !workspaceDir)
    return invalidBody(
      `${CREATE_SESSION_OPERATION_NAME} workspaceDir must not be empty`,
    );
  if (workspaceDir) {
    const dir = validateAbsoluteDirectory(
      CREATE_SESSION_OPERATION_NAME,
      "workspaceDir",
      workspaceDir,
    );
    if (!dir.ok) return dir;
  }
  if (
    candidate.teamModeOff !== undefined &&
    typeof candidate.teamModeOff !== "boolean"
  )
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "teamModeOff must be a boolean",
    };
  return {
    ok: true,
    body: {
      name,
      // Absent stays absent (do not coerce to ""): the harness treats an
      // undefined workspaceDir as "use the default workspace".
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(candidate.teamModeOff === undefined
        ? {}
        : { teamModeOff: candidate.teamModeOff }),
    },
  };
}

export const createSessionOperation: WebuiOperation<
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult
> = {
  name: CREATE_SESSION_OPERATION_NAME,
  validate: validateCreateSessionRequestBody,
};


export const getSessionOperation: WebuiOperation<
  WebuiSessionLookupRequest,
  WebuiSessionLookupResult
> = {
  name: GET_SESSION_OPERATION_NAME,
  validate: (body) => validateSessionIdBody(GET_SESSION_OPERATION_NAME, body),
};

/**
 * Authoritative "is a turn running, and which one" probe.
 *
 * `session.start` is the only notice a client gets when the server starts a
 * turn it did not initiate (the goal flow posts a hidden continuation prompt,
 * a queued message drains, another client sends). Events can also arrive
 * before a client has finished subscribing, or be missed entirely across a
 * `watchEvents` reconnect — and the session list cannot answer the question
 * because its `status` carries no turn id and never refreshes on those events.
 * This is the gap-recovery read.
 */
export const getActiveTurnOperation: WebuiOperation<
  WebuiSessionLookupRequest,
  WebuiActiveTurnResult
> = {
  name: GET_ACTIVE_TURN_OPERATION_NAME,
  validate: (body) => validateSessionIdBody(GET_ACTIVE_TURN_OPERATION_NAME, body),
};
