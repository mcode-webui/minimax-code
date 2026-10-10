import { WebuiErrorCode } from "../../shared/envelope.js";
import { requireRecord } from "./operation-contract.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import { LIST_USER_MODEL_PROVIDERS_OPERATION_NAME, CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, TEST_USER_MODEL_PROVIDER_OPERATION_NAME, TEST_USER_MODEL_OPERATION_NAME, DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME, SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME, LIST_PROVIDER_PRESETS_OPERATION_NAME, GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME, UPSERT_MINIMAX_API_KEY_OPERATION_NAME, GET_CODEX_OAUTH_STATUS_OPERATION_NAME, GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, TEST_USER_MODEL_CANDIDATE_OPERATION_NAME, REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME, START_CODEX_OAUTH_LOGIN_OPERATION_NAME, CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME, REFRESH_MODELS_OPERATION_NAME, RUN_COMMAND_OPERATION_NAME, CANCEL_ACCOUNT_LOGIN_OPERATION_NAME } from "../../shared/operation-names.js";
function validateProviderRecord(name: string, body: unknown): WebuiOperationValidation<Record<string, unknown>> {
  return requireRecord(name, body);
}
function validateProviderId(name: string, body: unknown): WebuiOperationValidation<{ readonly providerId: string }> {
  const value = validateProviderRecord(name, body); if (!value.ok) return value;
  const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : "";
  return providerId ? { ok: true, body: { providerId } } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${name} body requires providerId` };
}
function providerRecordOperation(name: string): WebuiOperation<Record<string, unknown>, unknown> { return { name, validate: (body) => validateProviderRecord(name, body) }; }

export const listUserModelProvidersOperation: WebuiOperation<undefined, readonly Record<string, unknown>[]> = { name: LIST_USER_MODEL_PROVIDERS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${LIST_USER_MODEL_PROVIDERS_OPERATION_NAME} does not accept a body` } };
export const createUserModelProviderOperation = providerRecordOperation(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME);
export const updateUserModelProviderOperation = providerRecordOperation(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME);
export const deleteUserModelProviderOperation: WebuiOperation<{ readonly providerId: string }, unknown> = { name: DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, validate: (body) => validateProviderId(DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, body) };
export const testUserModelProviderOperation: WebuiOperation<{ readonly providerId: string; readonly apiKey?: string }, unknown> = { name: TEST_USER_MODEL_PROVIDER_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(TEST_USER_MODEL_PROVIDER_OPERATION_NAME, body); if (!value.ok) return value; const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : ""; const apiKey = value.body.apiKey; if (!providerId || (apiKey !== undefined && typeof apiKey !== "string")) return { ok: false, code: WebuiErrorCode.invalidBody, message: `${TEST_USER_MODEL_PROVIDER_OPERATION_NAME} body requires providerId and an optional string apiKey` }; return { ok: true, body: { providerId, ...(typeof apiKey === "string" ? { apiKey } : {}) } }; } };
export const testUserModelOperation: WebuiOperation<{ readonly providerId: string; readonly modelId: string }, unknown> = { name: TEST_USER_MODEL_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(TEST_USER_MODEL_OPERATION_NAME, body); if (!value.ok) return value; const providerId = typeof value.body.providerId === "string" ? value.body.providerId.trim() : ""; const modelId = typeof value.body.modelId === "string" ? value.body.modelId.trim() : ""; return providerId && modelId ? { ok: true, body: { providerId, modelId } } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${TEST_USER_MODEL_OPERATION_NAME} body requires providerId and modelId` }; } };
export const discoverUserModelsCandidateOperation = providerRecordOperation(DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME);
export const saveUserModelProviderCandidateOperation = providerRecordOperation(SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME);
export const listProviderPresetsOperation: WebuiOperation<undefined, readonly Record<string, unknown>[]> = { name: LIST_PROVIDER_PRESETS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${LIST_PROVIDER_PRESETS_OPERATION_NAME} does not accept a body` } };
export const getMiniMaxApiKeyStatusOperation: WebuiOperation<undefined, Record<string, unknown>> = { name: GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME} does not accept a body` } };
export const upsertMiniMaxApiKeyOperation: WebuiOperation<{ readonly apiKey: string; readonly saveAndUse?: boolean }, unknown> = { name: UPSERT_MINIMAX_API_KEY_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(UPSERT_MINIMAX_API_KEY_OPERATION_NAME, body); if (!value.ok) return value; const apiKey = typeof value.body.apiKey === "string" ? value.body.apiKey : ""; if (!apiKey) return { ok: false, code: WebuiErrorCode.invalidBody, message: "apiKey is required" }; return { ok: true, body: { apiKey, ...(typeof value.body.saveAndUse === "boolean" ? { saveAndUse: value.body.saveAndUse } : {}) } }; } };
export const getCodexOAuthStatusOperation: WebuiOperation<undefined, Record<string, unknown>> = { name: GET_CODEX_OAUTH_STATUS_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_CODEX_OAUTH_STATUS_OPERATION_NAME} does not accept a body` } };
export const getMiniMaxModelSourceOperation: WebuiOperation<undefined, "token_plan" | "minimax_api_key"> = { name: GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, validate: (body) => body === undefined ? { ok: true, body: undefined } : { ok: false, code: WebuiErrorCode.invalidBody, message: `${GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME} does not accept a body` } };
export const setMiniMaxModelSourceOperation: WebuiOperation<{ readonly source: "token_plan" | "minimax_api_key" }, "token_plan" | "minimax_api_key"> = { name: SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, validate: (body) => { const value = validateProviderRecord(SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, body); if (!value.ok) return value; const source = value.body.source; return source === "token_plan" || source === "minimax_api_key" ? { ok: true, body: { source } } : { ok: false, code: WebuiErrorCode.invalidBody, message: "setMiniMaxModelSource source is invalid" }; } };
export const testUserModelCandidateOperation = providerRecordOperation(TEST_USER_MODEL_CANDIDATE_OPERATION_NAME);
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
    const commands = ["help", "new", "compact", "status", "usage", "model"] as const;
    if (!commands.includes(candidate.command as (typeof commands)[number]))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "runCommand command is invalid" };
    for (const field of ["input", "sessionId", "agentName", "workspaceDir"] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== "string")
        return { ok: false, code: WebuiErrorCode.invalidBody, message: `${field} must be a string` };
    }
    return { ok: true, body: candidate as unknown as import("../../shared/contracts/terminal.js").WebuiRunCommandRequest };
  },
};





