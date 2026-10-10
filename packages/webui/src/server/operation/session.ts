import { WebuiErrorCode } from "../../shared/envelope.js";
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
} from "../../shared/contracts/session.js";
import { validateAbsoluteDirectory, validateSessionIdBody } from "./common.js";
import { VERSION_OPERATION_NAME, LIST_SESSIONS_OPERATION_NAME, LIST_VISIBLE_PROJECTS_OPERATION_NAME, GET_SESSION_TREE_OPERATION_NAME, CREATE_SESSION_OPERATION_NAME, GET_SESSION_OPERATION_NAME, GET_ACTIVE_TURN_OPERATION_NAME, ARCHIVE_SESSION_OPERATION_NAME, DELETE_SESSION_OPERATION_NAME, UPDATE_SESSION_OPERATION_NAME, GET_SESSION_FORK_OPTIONS_OPERATION_NAME, FORK_SESSION_OPERATION_NAME } from "../../shared/operation-names.js";
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

export const archiveSessionOperation: WebuiOperation<{ readonly id: string; readonly archived?: boolean }, { readonly success?: boolean }> = {
  name: ARCHIVE_SESSION_OPERATION_NAME,
  validate: (body) => {
    const value = validateSessionIdBody(ARCHIVE_SESSION_OPERATION_NAME, body);
    if (!value.ok) return value;
    const candidate = body as Record<string, unknown>;
    if (candidate.archived !== undefined && typeof candidate.archived !== "boolean") {
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "archiveSession archived must be a boolean" };
    }
    return { ok: true, body: { id: value.body.id, ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}) } };
  },
};
export const deleteSessionOperation: WebuiOperation<{ readonly id: string }, { readonly success?: boolean }> = { name: DELETE_SESSION_OPERATION_NAME, validate: (body) => validateSessionIdBody(DELETE_SESSION_OPERATION_NAME, body) };
export const updateSessionOperation: WebuiOperation<import("../../shared/contracts/session.js").WebuiUpdateSessionRequest, import("../../shared/contracts/session.js").WebuiUpdateSessionResult> = {
  name: UPDATE_SESSION_OPERATION_NAME,
  validate: (body) => {
    const value = validateSessionIdBody(UPDATE_SESSION_OPERATION_NAME, body);
    if (!value.ok) return value;
    const candidate = body as Record<string, unknown>;
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    return title
      ? { ok: true, body: { id: value.body.id, title } }
      : { ok: false, code: WebuiErrorCode.invalidBody, message: "updateSession requires a non-empty title" };
  },
};
export const getSessionForkOptionsOperation: WebuiOperation<import("../../shared/contracts/session.js").WebuiGetSessionForkOptionsRequest, import("../../shared/contracts/session.js").WebuiGetSessionForkOptionsResult> = {
  name: GET_SESSION_FORK_OPTIONS_OPERATION_NAME,
  validate: (body) => {
    const value = validateSessionIdBody(GET_SESSION_FORK_OPTIONS_OPERATION_NAME, body);
    if (!value.ok) return value;
    const candidate = body as Record<string, unknown>;
    const assistantMessageId = candidate.assistantMessageId;
    if (assistantMessageId !== undefined && (typeof assistantMessageId !== "string" || !assistantMessageId.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "assistantMessageId must be a non-empty string" };
    return {
      ok: true,
      body: {
        id: value.body.id,
        ...(typeof assistantMessageId === "string" ? { assistantMessageId: assistantMessageId.trim() } : {}),
      },
    };
  },
};
export const forkSessionOperation: WebuiOperation<import("../../shared/contracts/session.js").WebuiForkSessionRequest, import("../../shared/contracts/session.js").WebuiForkSessionResult> = {
  name: FORK_SESSION_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "forkSession body must be an object" };
    const candidate = body as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const clientRequestId = typeof candidate.clientRequestId === "string" ? candidate.clientRequestId.trim() : "";
    if (!id || !clientRequestId || typeof candidate.useSuggestedTitle !== "boolean" || typeof candidate.createIsolatedWorktree !== "boolean")
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "forkSession requires id, clientRequestId, useSuggestedTitle, and createIsolatedWorktree" };
    const assistantMessageId = candidate.assistantMessageId;
    if (assistantMessageId !== undefined && (typeof assistantMessageId !== "string" || !assistantMessageId.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "assistantMessageId must be a non-empty string" };
    const title = candidate.title === undefined ? undefined : typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (candidate.title !== undefined && !title)
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "forkSession title must not be empty" };
    return { ok: true, body: { id, ...(typeof assistantMessageId === "string" ? { assistantMessageId: assistantMessageId.trim() } : {}), clientRequestId, useSuggestedTitle: candidate.useSuggestedTitle, createIsolatedWorktree: candidate.createIsolatedWorktree, ...(title ? { title } : {}) } };
  },
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
  import("../../shared/contracts/session.js").WebuiSessionPage
> = {
  name: LIST_SESSIONS_OPERATION_NAME,
  validate: validateListSessionsRequestBody,
};

export const listVisibleProjectsOperation: WebuiOperation<
  { readonly limit?: number },
  readonly import("../../shared/contracts/session.js").WebuiProjectRecord[]
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
