/**
 * The wire's provider requests, rebuilt as the runtime's own.
 *
 * The WebUI's provider DTOs are deliberately open: they carry extension keys the runtime
 * may grow, and `capabilities` is a bag the runtime owns the meaning of. The runtime's
 * declarations are closed and stricter — mutable arrays, a named capability type, no index
 * signature — so the wire body is not assignable to them.
 *
 * That difference is why these conversions exist. The declared fields are named one by one
 * rather than spread wholesale, so a field added to the wire is a decision made in this
 * file; the extension keys are forwarded, because forwarding them is what they are for, and
 * they go through the one helper whose cast states that no declaration covers them.
 *
 * The target types are read off `CliService` instead of transcribed: the runtime owns them,
 * and a copy here is a copy that drifts.
 *
 * This lives in the harness, not in the server: the server's job is network validation,
 * dispatch and wire projection, and knowing the concrete host request layout is not part of it.
 * The port stays the WebUI's own seam — its inputs are WebUI DTOs — and the adaptation to the
 * host's shapes happens here, applied at the one place that builds the port (`adapter.ts`).
 */

import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelProviderCandidateInput,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
  WebuiUserModelInput,
  WebuiTestUserModelCandidateRequest,
} from "../../shared/contracts/models.js";
import { asText } from "./result-conversion.js";

/** The runtime's own request shapes for the provider mutations. */
export type RuntimeCreateProviderRequest = Parameters<CliService["createUserModelProvider"]>[0];
export type RuntimeUpdateProviderRequest = Parameters<CliService["updateUserModelProvider"]>[0];
export type RuntimeDiscoverCandidateRequest = Parameters<
  CliService["discoverUserModelsCandidate"]
>[0];
export type RuntimeSaveCandidateRequest = Parameters<
  CliService["saveUserModelProviderCandidate"]
>[0];

/** One model entry, as the runtime declares it. */
type RuntimeModelInput = NonNullable<RuntimeCreateProviderRequest["models"]>[number];

/** The candidate nested in a save or discover request, as the runtime declares it. */
type RuntimeCandidate = RuntimeSaveCandidateRequest["candidate"];

/**
 * The declared fields plus the extension keys the wire carried.
 *
 * The provider DTOs are open on purpose and the runtime is meant to see those extra keys: a
 * runtime that grows a field keeps receiving it while this build has no name for it, which
 * is the whole reason the wire type has an index signature. The cast is the one place that
 * states it — an extension key is by definition outside the declaration, so no type-level
 * proof of it exists.
 */
function withExtensions<T extends object>(
  declared: T,
  wire: Record<string, unknown>,
  handled: readonly string[],
): T {
  // `{ ...declared }` is a fresh object with `T`'s fields; it is read and copied as a record
  // because the extension keys being merged in are not in `T` at all.
  const merged = { ...declared } as Record<string, unknown>;
  for (const [key, value] of Object.entries(wire)) {
    if (!handled.includes(key)) merged[key] = value;
  }
  return merged as T;
}

/** Copies a wire header map into the runtime's mutable one. */
function toHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  return headers === undefined ? undefined : { ...headers };
}

const MODEL_FIELDS = [
  "modelId",
  "displayName",
  "configurationSource",
  "enabled",
  "attachment",
  "reasoning",
  "toolCall",
  "temperature",
  "capabilities",
  "modalities",
  "limit",
  "thinkingConfig",
  "effortOptions",
] as const;

/** Rebuilds one model entry field by field, carrying its extension keys. */
function toModel(input: WebuiUserModelInput): RuntimeModelInput {
  const modalities = input.modalities;
  const declared = {
    modelId: input.modelId,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.configurationSource === undefined
      ? {}
      : { configurationSource: input.configurationSource }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.capabilities === undefined
      ? {}
      : {
          capabilities: input.capabilities as RuntimeModelInput["capabilities"],
        }),
    ...(modalities === undefined
      ? {}
      : {
          modalities: {
            ...(modalities.input === undefined ? {} : { input: [...modalities.input] }),
            ...(modalities.output === undefined ? {} : { output: [...modalities.output] }),
          },
        }),
    ...(input.limit === undefined ? {} : { limit: { ...input.limit } }),
    ...(input.thinkingConfig === undefined ? {} : { thinkingConfig: { ...input.thinkingConfig } }),
    ...(input.effortOptions === undefined ? {} : { effortOptions: [...input.effortOptions] }),
  };
  return withExtensions(declared, input, MODEL_FIELDS);
}

function toModels(
  models: readonly WebuiUserModelInput[] | undefined,
): readonly RuntimeModelInput[] | undefined {
  return models === undefined ? undefined : models.map(toModel);
}

const CANDIDATE_FIELDS = [
  "providerId",
  "expectedRevision",
  "name",
  "baseUrl",
  "apiKey",
  "apiFormat",
  "headers",
  "removeHeaders",
  "models",
] as const;

/** Rebuilds the nested candidate field by field, carrying its extension keys. */
function toCandidate(
  input: WebuiModelProviderCandidateInput,
): RuntimeCandidate {
  const declared = {
    baseUrl: input.baseUrl,
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.apiFormat === undefined ? {} : { apiFormat: input.apiFormat }),
    ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
    ...(input.removeHeaders === undefined ? {} : { removeHeaders: [...input.removeHeaders] }),
    ...(input.models === undefined ? {} : { models: input.models.map(toModel) }),
  };
  return withExtensions(declared, input, CANDIDATE_FIELDS);
}

const CREATE_FIELDS = [
  "name",
  "baseUrl",
  "apiKey",
  "apiFormat",
  "headers",
  "models",
  "saveAndUse",
] as const;

export function toRuntimeCreateProviderRequest(
  body: WebuiCreateUserModelProviderRequest,
): RuntimeCreateProviderRequest {
  const models = toModels(body.models);
  const headers = toHeaders(body.headers);
  const declared = {
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.apiFormat === undefined ? {} : { apiFormat: body.apiFormat }),
    ...(headers === undefined ? {} : { headers }),
    ...(models === undefined ? {} : { models }),
    ...(body.saveAndUse === undefined ? {} : { saveAndUse: body.saveAndUse }),
  };
  return withExtensions(declared, body, CREATE_FIELDS);
}

const UPDATE_FIELDS = [
  "providerId",
  "name",
  "baseUrl",
  "apiKey",
  "apiFormat",
  "headers",
  "removeHeaders",
  "enabled",
  "models",
  "saveAndUse",
] as const;

export function toRuntimeUpdateProviderRequest(
  body: WebuiUpdateUserModelProviderRequest,
): RuntimeUpdateProviderRequest {
  const models = toModels(body.models);
  const headers = toHeaders(body.headers);
  const declared = {
    providerId: body.providerId,
    // `apiKey` is forwarded as written, empty string included: an empty key clears the
    // stored one where an absent field keeps it, and collapsing the two here would erase
    // that distinction before the runtime can read it.
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    ...(body.apiFormat === undefined ? {} : { apiFormat: body.apiFormat }),
    ...(headers === undefined ? {} : { headers }),
    ...(body.removeHeaders === undefined ? {} : { removeHeaders: [...body.removeHeaders] }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(models === undefined ? {} : { models }),
    ...(body.saveAndUse === undefined ? {} : { saveAndUse: body.saveAndUse }),
  };
  return withExtensions(declared, body, UPDATE_FIELDS);
}

const DISCOVER_FIELDS = [
  "baseUrl",
  "providerId",
  "expectedRevision",
  "name",
  "apiKey",
  "apiFormat",
] as const;

export function toRuntimeDiscoverCandidateRequest(
  body: WebuiDiscoverUserModelsCandidateRequest,
): RuntimeDiscoverCandidateRequest {
  // The wire declares the endpoint plus exactly one branch, and the runtime's input is the
  // same union. The branch is named here rather than the fields being merged into one bag:
  // the saved-provider branch carries an id and a revision, the new-provider branch a name
  // and a key, and a body with both is a rejection the type is meant to make unspellable.
  if (typeof body.providerId === "string" && typeof body.expectedRevision === "string") {
    return withExtensions(
      {
        baseUrl: body.baseUrl,
        providerId: body.providerId,
        expectedRevision: body.expectedRevision,
      },
      body,
      DISCOVER_FIELDS,
    );
  }
  if (
    typeof body.name === "string" &&
    typeof body.apiKey === "string" &&
    typeof body.apiFormat === "string"
  ) {
    return withExtensions(
      {
        baseUrl: body.baseUrl,
        name: body.name,
        apiKey: body.apiKey,
        apiFormat: body.apiFormat,
      },
      body,
      DISCOVER_FIELDS,
    );
  }
  // Unreachable through the declared union, and stated rather than forwarded: a body that
  // names neither branch has no endpoint to discover against, and inventing one here would
  // turn a rejected request into a discovery against the wrong address.
  throw new Error(
    "discoverUserModelsCandidate: the request names neither branch",
  );
}

const SAVE_FIELDS = [
  "candidate",
  "modelId",
  "saveAndUse",
  "skipConnectionTest",
] as const;

export function toRuntimeSaveCandidateRequest(
  body: WebuiSaveUserModelProviderCandidateRequest,
): RuntimeSaveCandidateRequest {
  const declared = {
    candidate: toCandidate(body.candidate),
    ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
    ...(body.saveAndUse === undefined ? {} : { saveAndUse: body.saveAndUse }),
    ...(body.skipConnectionTest === undefined ? {} : { skipConnectionTest: body.skipConnectionTest }),
  };
  return withExtensions(declared, body, SAVE_FIELDS);
}

export function toRuntimeTestCandidateRequest(
  body: WebuiTestUserModelCandidateRequest,
): Parameters<CliService["testUserModelCandidate"]>[0] {
  const candidate = toCandidate({
    ...body.candidate,
    baseUrl: asText(body.candidate.baseUrl, "a provider base URL"),
  });
  const { models, ...fields } = candidate;
  return withExtensions(
    {
      candidate: {
        ...fields,
        ...(models === undefined
          ? {}
          : {
              models: models.map(({ modalities, ...model }) => ({
                ...model,
                ...(modalities === undefined
      ? {}
      : {
          modalities: {
            ...(modalities.input === undefined ? {} : { input: [...modalities.input] }),
            ...(modalities.output === undefined ? {} : { output: [...modalities.output] }),
          },
        }),
              })),
            }),
      },
      modelId: asText(body.modelId, "a model id"),
    },
    body,
    ["candidate", "modelId"],
  );
}
