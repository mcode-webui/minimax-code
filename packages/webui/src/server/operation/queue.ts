import { WebuiErrorCode } from "../../shared/envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import { validateSessionIdBody, validateOptionalObjectBody } from "./common.js";
import { ABORT_SESSION_OPERATION_NAME, LIST_QUEUE_MESSAGES_OPERATION_NAME, DELETE_QUEUE_ITEM_OPERATION_NAME, LIST_MODELS_OPERATION_NAME, SELECT_MODEL_OPERATION_NAME, LIST_SKILLS_OPERATION_NAME, GET_SESSION_USAGE_OPERATION_NAME } from "../../shared/operation-names.js";
export const abortSessionOperation: WebuiOperation<
  {
    readonly id: string;
  },
  { readonly success?: boolean }
> = {
  name: ABORT_SESSION_OPERATION_NAME,
  validate: (body) => validateSessionIdBody(ABORT_SESSION_OPERATION_NAME, body),
};

export const listQueueMessagesOperation: WebuiOperation<
  {
    readonly id: string;
  },
  {
    readonly items?: readonly import("../../shared/contracts/queue.js").WebuiQueueItem[];
    readonly paused?: boolean;
    readonly pendingCount?: number;
  }
> = {
  name: LIST_QUEUE_MESSAGES_OPERATION_NAME,
  validate: (body) =>
    validateSessionIdBody(LIST_QUEUE_MESSAGES_OPERATION_NAME, body),
};

export const deleteQueueItemOperation: WebuiOperation<
  {
    readonly id: string;
    readonly itemId: string;
  },
  { readonly item?: import("../../shared/contracts/queue.js").WebuiQueueItem }
> = {
  name: DELETE_QUEUE_ITEM_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "deleteQueueItem body must be an object",
      };
    const candidate = body as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const itemId =
      typeof candidate.itemId === "string" ? candidate.itemId.trim() : "";
    if (!id || !itemId)
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "deleteQueueItem body requires id and itemId",
      };
    return { ok: true, body: { id, itemId } };
  },
};

export const listModelsOperation: WebuiOperation<
  { readonly sessionId?: string },
  readonly import("../../shared/contracts/models.js").WebuiModelEntry[]
> = {
  name: LIST_MODELS_OPERATION_NAME,
  validate: (body) => {
    const value = validateOptionalObjectBody(LIST_MODELS_OPERATION_NAME, body);
    if (!value.ok) return value;
    if (
      value.body.sessionId !== undefined &&
      typeof value.body.sessionId !== "string"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "sessionId must be a string",
      };
    return {
      ok: true,
      body: value.body.sessionId ? { sessionId: value.body.sessionId } : {},
    };
  },
};

export const listSkillsOperation: WebuiOperation<
  { readonly agentName?: string },
  { readonly skills: readonly import("../../shared/contracts/models.js").WebuiSkillEntry[] }
> = {
  name: LIST_SKILLS_OPERATION_NAME,
  validate: (body) => {
    const value = validateOptionalObjectBody(LIST_SKILLS_OPERATION_NAME, body);
    if (!value.ok) return value;
    if (
      value.body.agentName !== undefined &&
      typeof value.body.agentName !== "string"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "agentName must be a string",
      };
    return {
      ok: true,
      body: value.body.agentName ? { agentName: value.body.agentName } : {},
    };
  },
};

export const selectModelOperation: WebuiOperation<
  {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
    readonly contextLimit?: number;
    readonly thinking?: { readonly effort?: string } | null;
    readonly sessionId?: string;
  },
  { readonly success?: boolean }
> = {
  name: SELECT_MODEL_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "selectModel body must be an object",
      };
    const candidate = body as Record<string, unknown>;
    const providerId =
      typeof candidate.providerId === "string"
        ? candidate.providerId.trim()
        : "";
    const modelId =
      typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
    if (!providerId || !modelId)
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "selectModel body requires providerId and modelId",
      };
    if (
      candidate.variant !== undefined &&
      typeof candidate.variant !== "string"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "variant must be a string",
      };
    if (
      candidate.contextLimit !== undefined &&
      (typeof candidate.contextLimit !== "number" ||
        !Number.isSafeInteger(candidate.contextLimit) ||
        candidate.contextLimit <= 0)
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "contextLimit must be a positive safe integer",
      };
    if (
      candidate.thinking !== undefined &&
      candidate.thinking !== null &&
      (typeof candidate.thinking !== "object" ||
        Array.isArray(candidate.thinking) ||
        typeof (candidate.thinking as Record<string, unknown>).effort !== "string" ||
        !(candidate.thinking as { effort: string }).effort.trim())
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "thinking must be null or an object with an effort string",
      };
    if (
      candidate.sessionId !== undefined &&
      typeof candidate.sessionId !== "string"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "sessionId must be a string",
      };
    return {
      ok: true,
      body: {
        providerId,
        modelId,
        ...(typeof candidate.variant === "string"
          ? { variant: candidate.variant }
          : {}),
        ...(typeof candidate.contextLimit === "number"
          ? { contextLimit: candidate.contextLimit }
          : {}),
        ...(candidate.thinking === null
          ? { thinking: null }
          : candidate.thinking !== undefined
            ? { thinking: { effort: (candidate.thinking as { effort: string }).effort } }
            : {}),
        ...(typeof candidate.sessionId === "string"
          ? { sessionId: candidate.sessionId }
          : {}),
      },
    };
  },
};

export const getSessionUsageOperation: WebuiOperation<
  { readonly id: string },
  Record<string, unknown>
> = {
  name: GET_SESSION_USAGE_OPERATION_NAME,
  validate: (body) =>
    validateSessionIdBody(GET_SESSION_USAGE_OPERATION_NAME, body),
};


