import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import type {
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiMessagesRequest,
  WebuiMessagesResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
} from "../port.js";
import { validateSessionIdBody, validateObjectBody, validateConversationMutationBody, validateBooleanField } from "./common.js";
import { GET_MESSAGES_OPERATION_NAME, GET_SESSION_DIFF_OPERATION_NAME, GET_TURN_DIFF_OPERATION_NAME, REVERT_TURN_DIFF_OPERATION_NAME, REAPPLY_TURN_DIFF_OPERATION_NAME, GET_SESSION_REWIND_PREVIEW_OPERATION_NAME, REWIND_SESSION_OPERATION_NAME, EDIT_SESSION_MESSAGE_OPERATION_NAME } from "./names.js";
function validateGetMessagesBody(
  body: unknown,
): WebuiOperationValidation<WebuiMessagesRequest> {
  const session = validateSessionIdBody(GET_MESSAGES_OPERATION_NAME, body);
  if (!session.ok) return session;
  const candidate = body as Record<string, unknown>;
  if (
    candidate.limit !== undefined &&
    (!Number.isInteger(candidate.limit) || (candidate.limit as number) < 0)
  )
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "limit must be a non-negative integer",
    };
  if (candidate.before !== undefined && typeof candidate.before !== "string")
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "before must be a string",
    };
  if (
    candidate.includeAttachmentReadUrls !== undefined &&
    typeof candidate.includeAttachmentReadUrls !== "boolean"
  )
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "includeAttachmentReadUrls must be a boolean",
    };
  return {
    ok: true,
    body: {
      id: session.body.id,
      ...(candidate.limit === undefined
        ? {}
        : { limit: candidate.limit as number }),
      ...(candidate.before === undefined
        ? {}
        : { before: candidate.before as string }),
      ...(candidate.includeAttachmentReadUrls === undefined
        ? {}
        : {
            includeAttachmentReadUrls:
              candidate.includeAttachmentReadUrls as boolean,
          }),
    },
  };
}

export const getMessagesOperation: WebuiOperation<
  WebuiMessagesRequest,
  WebuiMessagesResult
> = {
  name: GET_MESSAGES_OPERATION_NAME,
  validate: validateGetMessagesBody,
};

function validateDiffRequestBody<T>(
  operation: string,
  body: unknown,
): WebuiOperationValidation<T> {
  const result = validateObjectBody(operation, body);
  if (!result.ok) return result as WebuiOperationValidation<T>;
  if (typeof result.body.id !== "string" || !result.body.id.trim())
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${operation} body requires a non-empty id`,
    };
  for (const key of ["messageId", "assistantMessageId", "turnId", "changeSetId"])
    if (result.body[key] !== undefined && typeof result.body[key] !== "string")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${key} must be a string`,
      };
  return { ok: true, body: result.body as unknown as T };
}

export const getSessionDiffOperation: WebuiOperation<
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult
> = {
  name: GET_SESSION_DIFF_OPERATION_NAME,
  validate: (body) =>
    validateDiffRequestBody<WebuiGetSessionDiffRequest>(GET_SESSION_DIFF_OPERATION_NAME, body),
};

export const getTurnDiffOperation: WebuiOperation<
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult
> = {
  name: GET_TURN_DIFF_OPERATION_NAME,
  validate: (body) =>
    validateDiffRequestBody<WebuiGetTurnDiffRequest>(GET_TURN_DIFF_OPERATION_NAME, body),
};

export const revertTurnDiffOperation: WebuiOperation<
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult
> = {
  name: REVERT_TURN_DIFF_OPERATION_NAME,
  validate: (body) =>
    validateDiffRequestBody<WebuiRevertTurnDiffRequest>(REVERT_TURN_DIFF_OPERATION_NAME, body),
};

export const reapplyTurnDiffOperation: WebuiOperation<
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult
> = {
  name: REAPPLY_TURN_DIFF_OPERATION_NAME,
  validate: (body) =>
    validateDiffRequestBody<WebuiReapplyTurnDiffRequest>(REAPPLY_TURN_DIFF_OPERATION_NAME, body),
};
export const getSessionRewindPreviewOperation: WebuiOperation<WebuiGetSessionRewindPreviewRequest, WebuiGetSessionRewindPreviewResult> = {
  name: GET_SESSION_REWIND_PREVIEW_OPERATION_NAME,
  validate: (body) => {
    const result = validateConversationMutationBody(GET_SESSION_REWIND_PREVIEW_OPERATION_NAME, body, ["id", "userMessageId"]);
    return result.ok ? { ok: true, body: result.body as unknown as WebuiGetSessionRewindPreviewRequest } : result as WebuiOperationValidation<WebuiGetSessionRewindPreviewRequest>;
  },
};

export const rewindSessionOperation: WebuiOperation<WebuiRewindSessionRequest, WebuiRewindSessionResult> = {
  name: REWIND_SESSION_OPERATION_NAME,
  validate: (body) => {
    const result = validateConversationMutationBody(REWIND_SESSION_OPERATION_NAME, body, ["id", "userMessageId", "clientRequestId"]);
    if (!result.ok) return result as WebuiOperationValidation<WebuiRewindSessionRequest>;
    const error = validateBooleanField(REWIND_SESSION_OPERATION_NAME, result.body, "rewindTurnDiff");
    if (error) return error as WebuiOperationValidation<WebuiRewindSessionRequest>;
    return { ok: true, body: result.body as unknown as WebuiRewindSessionRequest };
  },
};

export const editSessionMessageOperation: WebuiOperation<WebuiEditSessionMessageRequest, WebuiEditSessionMessageResult> = {
  name: EDIT_SESSION_MESSAGE_OPERATION_NAME,
  validate: (body) => {
    const result = validateConversationMutationBody(EDIT_SESSION_MESSAGE_OPERATION_NAME, body, ["id", "userMessageId", "clientRequestId", "content"]);
    if (!result.ok) return result as WebuiOperationValidation<WebuiEditSessionMessageRequest>;
    const error = validateBooleanField(EDIT_SESSION_MESSAGE_OPERATION_NAME, result.body, "rewindTurnDiff");
    if (error) return error as WebuiOperationValidation<WebuiEditSessionMessageRequest>;
    if (result.body.attachments !== undefined && !Array.isArray(result.body.attachments))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "attachments must be an array" };
    return { ok: true, body: result.body as unknown as WebuiEditSessionMessageRequest };
  },
};
