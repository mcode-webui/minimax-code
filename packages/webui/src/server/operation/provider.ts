import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  WEBUI_RUN_COMMAND_NAMES,
  type WebuiRunCommandName,
} from "../../shared/contracts/commands.js";
import { requireRecord } from "./operation-contract.js";
import type {
  ValidationFailure,
  WebuiOperation,
  WebuiOperationValidation,
} from "./operation-contract.js";
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "../../shared/contracts/models.js";
import { LIST_USER_MODEL_PROVIDERS_OPERATION_NAME, CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, TEST_USER_MODEL_PROVIDER_OPERATION_NAME, TEST_USER_MODEL_OPERATION_NAME, DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME, SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME, LIST_PROVIDER_PRESETS_OPERATION_NAME, GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME, UPSERT_MINIMAX_API_KEY_OPERATION_NAME, GET_CODEX_OAUTH_STATUS_OPERATION_NAME, GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, TEST_USER_MODEL_CANDIDATE_OPERATION_NAME, REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME, START_CODEX_OAUTH_LOGIN_OPERATION_NAME, CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME, REFRESH_MODELS_OPERATION_NAME, RUN_COMMAND_OPERATION_NAME } from "../../shared/operation-names.js";
function validateProviderRecord(name: string, body: unknown): WebuiOperationValidation<Record<string, unknown>> {
  return requireRecord(name, body);
}
function validateProviderId(name: string, body: unknown): WebuiOperationValidation<{ readonly providerId: string }> {
  const value = validateProviderRecord(name, body); if (!value.ok) return value;
  const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : "";
  return providerId ? { ok: true, body: { providerId } } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${name} body requires providerId` };
}
function providerRecordOperation(name: string): WebuiOperation<Record<string, unknown>, unknown> { return { name, validate: (body) => validateProviderRecord(name, body) }; }

export const listUserModelProvidersOperation: WebuiOperation<undefined, readonly WebuiModelProviderView[]> = { name: LIST_USER_MODEL_PROVIDERS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${LIST_USER_MODEL_PROVIDERS_OPERATION_NAME} does not accept a body` } };
export const createUserModelProviderOperation: WebuiOperation<WebuiCreateUserModelProviderRequest, unknown> = {
  name: CREATE_USER_MODEL_PROVIDER_OPERATION_NAME,
  validate: createUserModelProviderValidator,
};
export const updateUserModelProviderOperation: WebuiOperation<WebuiUpdateUserModelProviderRequest, unknown> = {
  name: UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME,
  validate: updateUserModelProviderValidator,
};
export const deleteUserModelProviderOperation: WebuiOperation<{ readonly providerId: string }, unknown> = { name: DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, validate: (body) => validateProviderId(DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, body) };
export const testUserModelProviderOperation: WebuiOperation<{ readonly providerId: string; readonly apiKey?: string }, unknown> = { name: TEST_USER_MODEL_PROVIDER_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(TEST_USER_MODEL_PROVIDER_OPERATION_NAME, body); if (!value.ok) return value; const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : ""; const apiKey = value.body.apiKey; if (!providerId || (apiKey !== undefined && typeof apiKey !== "string")) return { ok: false, code: WebuiErrorCode.invalidBody, message: `${TEST_USER_MODEL_PROVIDER_OPERATION_NAME} body requires providerId and an optional string apiKey` }; return { ok: true, body: { providerId, ...(typeof apiKey === "string" ? { apiKey } : {}) } }; } };
export const testUserModelOperation: WebuiOperation<{ readonly providerId: string; readonly modelId: string }, unknown> = { name: TEST_USER_MODEL_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(TEST_USER_MODEL_OPERATION_NAME, body); if (!value.ok) return value; const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : ""; const modelId = typeof value.body.modelId === "string" ? value.body.modelId.trim() : ""; return providerId && modelId ? { ok: true, body: { providerId, modelId } } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${TEST_USER_MODEL_OPERATION_NAME} body requires providerId and modelId` }; } };
export const discoverUserModelsCandidateOperation: WebuiOperation<WebuiDiscoverUserModelsCandidateRequest, unknown> = {
  name: DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME,
  validate: discoverUserModelsCandidateValidator,
};
export const saveUserModelProviderCandidateOperation: WebuiOperation<WebuiSaveUserModelProviderCandidateRequest, unknown> = {
  name: SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME,
  validate: saveUserModelProviderCandidateValidator,
};
export const listProviderPresetsOperation: WebuiOperation<undefined, readonly Record<string, unknown>[]> = { name: LIST_PROVIDER_PRESETS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${LIST_PROVIDER_PRESETS_OPERATION_NAME} does not accept a body` } };
export const getMiniMaxApiKeyStatusOperation: WebuiOperation<undefined, Record<string, unknown>> = { name: GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME} does not accept a body` } };
export const upsertMiniMaxApiKeyOperation: WebuiOperation<{ readonly apiKey: string; readonly saveAndUse?: boolean }, unknown> = { name: UPSERT_MINIMAX_API_KEY_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(UPSERT_MINIMAX_API_KEY_OPERATION_NAME, body); if (!value.ok) return value; const apiKey = typeof value.body.apiKey === "string" ? value.body.apiKey : ""; if (!apiKey) return { ok: false, code: WebuiErrorCode.invalidBody, message: "apiKey is required" }; return { ok: true, body: { apiKey, ...(typeof value.body.saveAndUse === "boolean" ? { saveAndUse: value.body.saveAndUse } : {}) } }; } };
export const getCodexOAuthStatusOperation: WebuiOperation<undefined, Record<string, unknown>> = { name: GET_CODEX_OAUTH_STATUS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_CODEX_OAUTH_STATUS_OPERATION_NAME} does not accept a body` } };
export const getMiniMaxModelSourceOperation: WebuiOperation<undefined, "token_plan" | "minimax_api_key"> = { name: GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME} does not accept a body` } };
export const setMiniMaxModelSourceOperation: WebuiOperation<{ readonly source: "token_plan" | "minimax_api_key" }, "token_plan" | "minimax_api_key"> = { name: SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, body); if (!value.ok) return value; const source = value.body.source; return source === "token_plan" || source === "minimax_api_key" ? { ok: true, body: { source } } : { ok: false, code: WebuiErrorCode.invalidBody, message: "setMiniMaxModelSource source is invalid" }; } };
export const testUserModelCandidateOperation: WebuiOperation<WebuiTestUserModelCandidateRequest, unknown> = {
  name: TEST_USER_MODEL_CANDIDATE_OPERATION_NAME,
  validate: testUserModelCandidateValidator,
};
export const revealModelProviderApiKeyOperation: WebuiOperation<{ readonly providerId: string }, string> = { name: REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME, validate: (body) => validateProviderId(REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME, body) };
export const startCodexOAuthLoginOperation = providerRecordOperation(START_CODEX_OAUTH_LOGIN_OPERATION_NAME);
export const cancelCodexOAuthLoginOperation: WebuiOperation<{ readonly loginId: string }, unknown> = { name: CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME, body); if (!value.ok) return value; const loginId = typeof value.body.loginId === "string" ? value.body.loginId.trim() : ""; return loginId ? { ok: true, body: { loginId } } : { ok: false, code: WebuiErrorCode.invalidBody, message: "cancelCodexOAuthLogin body requires loginId" }; } };
export const refreshModelsOperation: WebuiOperation<undefined, unknown> = { name: REFRESH_MODELS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${REFRESH_MODELS_OPERATION_NAME} does not accept a body` } };

export const runCommandOperation: WebuiOperation<
  import("../../shared/contracts/terminal.js").WebuiRunCommandRequest,
  import("../../shared/contracts/terminal.js").WebuiRunCommandResult
> = {
  name: RUN_COMMAND_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "runCommand body must be an object" };
    const candidate = body as Record<string, unknown>;
    const commands = WEBUI_RUN_COMMAND_NAMES;
    if (!commands.includes(candidate.command as WebuiRunCommandName))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "runCommand command is invalid" };
    for (const field of ["input", "sessionId", "agentName", "workspaceDir"] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== "string")
        return { ok: false, code: WebuiErrorCode.invalidBody, message: `${field} must be a string` };
    }
    return { ok: true, body: candidate as unknown as import("../../shared/contracts/terminal.js").WebuiRunCommandRequest };
  },
};

/* ------------------------------------------------------------------ *
 * Provider write validation.
 *
 * These five are the provider operations whose body is validated at ingress:
 * `createUserModelProvider`, `updateUserModelProvider`,
 * `discoverUserModelsCandidate`, `saveUserModelProviderCandidate` and
 * `testUserModelCandidate`. Everything else in this file keeps the scope it had
 * — the narrow delete / test-provider / test-model / key-upsert / key-reveal
 * validators, and the record-forwarders for the operations whose real contract
 * is still an open record.
 *
 * The checks mirror the runtime's own provider input normalisation
 * (`local-runtime-v2`'s `service-input.ts`): known fields are checked when they
 * are supplied, nested model/header/remove-header structures are checked, and
 * the discovery branches are enforced. Unknown fields are **preserved** — the
 * runtime forwards extensions, so rebuilding a whitelist here would drop them.
 *
 * A malformed body now fails here with `invalidBody` instead of reaching the
 * runtime and failing there. That reclassification is deliberate.
 * ------------------------------------------------------------------ */

/** A bad known field: the whole body is an ingress failure. */
function fieldFailure(name: string, detail: string): ValidationFailure {
  return { ok: false, code: WebuiErrorCode.invalidBody, message: `${name} ${detail}` };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check one optional field. `requireNonEmpty` is for fields the runtime refuses
 * when blank; omitting it accepts `""`, which some provider fields treat as a
 * meaningful value rather than an absent one.
 */
function checkOptionalString(
  name: string,
  body: Record<string, unknown>,
  field: string,
  options?: { readonly requireNonEmpty?: boolean },
): ValidationFailure | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fieldFailure(name, `field ${field} must be a string`);
  if (options?.requireNonEmpty && !value.trim())
    return fieldFailure(name, `field ${field} must not be empty`);
  return undefined;
}

function checkRequiredString(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (typeof value !== "string" || !value.trim())
    return fieldFailure(name, `requires a non-empty ${field}`);
  return undefined;
}

function checkOptionalBoolean(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? undefined : fieldFailure(name, `field ${field} must be a boolean`);
}

/** A map of string values, as the runtime's `headers` input is. */
function checkOptionalStringMap(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return fieldFailure(name, `field ${field} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string")
      return fieldFailure(name, `field ${field}.${key} must be a string`);
  }
  return undefined;
}

/** An array of strings, as the runtime's `removeHeaders` input is. */
function checkOptionalStringArray(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fieldFailure(name, `field ${field} must be an array`);
  for (const entry of value) {
    if (typeof entry !== "string")
      return fieldFailure(name, `field ${field} must contain only strings`);
  }
  return undefined;
}

/**
 * The model inputs. A supplied entry must be a record with a non-empty string
 * `modelId`; the remaining fields are the runtime's to read, so they are not
 * enumerated here.
 */
function checkOptionalModels(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fieldFailure(name, `field ${field} must be an array`);
  for (const entry of value) {
    if (!isPlainRecord(entry) || typeof entry.modelId !== "string" || !entry.modelId.trim())
      return fieldFailure(name, `every ${field} entry needs a non-empty modelId`);
  }
  return undefined;
}

/**
 * The nested candidate a save or a test carries. `baseUrl` is required on every
 * branch; the optional fields are the saved-provider identity, the new-provider
 * credentials, the header edits and the model list.
 */
function checkCandidate(
  name: string,
  body: Record<string, unknown>,
  field: string,
): ValidationFailure | undefined {
  const value = body[field];
  if (!isPlainRecord(value)) return fieldFailure(name, `field ${field} must be an object`);
  return (
    checkRequiredString(name, value, "baseUrl") ??
    checkOptionalString(name, value, "providerId", { requireNonEmpty: true }) ??
    checkOptionalString(name, value, "expectedRevision", { requireNonEmpty: true }) ??
    checkOptionalString(name, value, "name") ??
    checkOptionalString(name, value, "apiKey") ??
    checkOptionalString(name, value, "apiFormat") ??
    checkOptionalStringMap(name, value, "headers") ??
    checkOptionalStringArray(name, value, "removeHeaders") ??
    checkOptionalModels(name, value, "models")
  );
}

function createUserModelProviderValidator(
  body: unknown,
): WebuiOperationValidation<WebuiCreateUserModelProviderRequest> {
  const value = requireRecord(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, body);
  if (!value.ok) return value;
  const failure =
    checkRequiredString(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "baseUrl") ??
    checkRequiredString(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "apiKey") ??
    checkOptionalString(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "name") ??
    checkOptionalString(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "apiFormat") ??
    checkOptionalStringMap(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "headers") ??
    checkOptionalModels(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "models") ??
    checkOptionalBoolean(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "saveAndUse");
  if (failure) return failure;
  return { ok: true, body: value.body as WebuiCreateUserModelProviderRequest }
};

function updateUserModelProviderValidator(
  body: unknown,
): WebuiOperationValidation<WebuiUpdateUserModelProviderRequest> {
  const value = requireRecord(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, body);
  if (!value.ok) return value;
  const failure =
    checkRequiredString(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "providerId") ??
    checkOptionalString(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "name") ??
    // An empty `apiKey` clears the stored key; omitting it keeps it. Both are
    // legal, so only the type is checked.
    checkOptionalString(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "apiKey") ??
    checkOptionalString(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "baseUrl") ??
    checkOptionalString(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "apiFormat") ??
    checkOptionalStringMap(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "headers") ??
    checkOptionalStringArray(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "removeHeaders") ??
    checkOptionalModels(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "models") ??
    checkOptionalBoolean(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "enabled") ??
    checkOptionalBoolean(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, value.body, "saveAndUse");
  if (failure) return failure;
  return { ok: true, body: value.body as WebuiUpdateUserModelProviderRequest }
};

/**
 * Discovery is a union of two branches and never an optional bag: the saved
 * provider is named by its id and the revision the client last read, a new one
 * by its name, key and format. Whichever branch the caller started must be
 * complete.
 */
function discoverUserModelsCandidateValidator(
  body: unknown,
): WebuiOperationValidation<WebuiDiscoverUserModelsCandidateRequest> {
  const value = requireRecord(DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME, body);
  if (!value.ok) return value;
  const name = DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME;
  const missingEndpoint = checkRequiredString(name, value.body, "baseUrl");
  if (missingEndpoint) return missingEndpoint;
  if (value.body.providerId !== undefined) {
    const failure =
      checkOptionalString(name, value.body, "providerId", { requireNonEmpty: true }) ??
      checkRequiredString(name, value.body, "expectedRevision");
    if (failure) return failure;
  } else {
    const failure =
      checkRequiredString(name, value.body, "name") ??
      checkRequiredString(name, value.body, "apiKey") ??
      checkRequiredString(name, value.body, "apiFormat");
    if (failure) return failure;
  }
  return { ok: true, body: value.body as WebuiDiscoverUserModelsCandidateRequest }
};

function saveUserModelProviderCandidateValidator(
  body: unknown,
): WebuiOperationValidation<WebuiSaveUserModelProviderCandidateRequest> {
  const value = requireRecord(SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME, body);
  if (!value.ok) return value;
  const name = SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME;
  const failure =
    checkCandidate(name, value.body, "candidate") ??
    // The panel submits the first typed model id, which is empty until the user
    // types one; the runtime treats the field as optional, so an empty string is
    // forwarded rather than rejected.
    checkOptionalString(name, value.body, "modelId") ??
    checkOptionalBoolean(name, value.body, "saveAndUse") ??
    checkOptionalBoolean(name, value.body, "skipConnectionTest");
  if (failure) return failure;
  return { ok: true, body: value.body as WebuiSaveUserModelProviderCandidateRequest }
};

function testUserModelCandidateValidator(
  body: unknown,
): WebuiOperationValidation<WebuiTestUserModelCandidateRequest> {
  const value = requireRecord(TEST_USER_MODEL_CANDIDATE_OPERATION_NAME, body);
  if (!value.ok) return value;
  const name = TEST_USER_MODEL_CANDIDATE_OPERATION_NAME;
  const failure =
    checkCandidate(name, value.body, "candidate") ??
    checkRequiredString(name, value.body, "modelId");
  if (failure) return failure;
  return { ok: true, body: value.body as WebuiTestUserModelCandidateRequest }
};