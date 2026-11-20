import type { ApplyDesignActionRequest, GetDesignStateRequest, DesignState } from "../../shared/contracts/design.js";
import { APPLY_DESIGN_ACTION_OPERATION_NAME, GET_DESIGN_STATE_OPERATION_NAME } from "../../shared/operation-names.js";
import { WebuiErrorCode } from "../../shared/envelope.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import { designActionError, isDesignAction } from "../../shared/design-input.js";

function readIdentity(body: unknown): WebuiOperationValidation<GetDesignStateRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "Design request body must be an object" };
  const record = body as Record<string, unknown>;
  if (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !record.sessionId.trim())) return { ok: false, code: WebuiErrorCode.invalidBody, message: "sessionId must be a non-empty string" };
  if (record.documentId !== undefined && (typeof record.documentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.documentId))) return { ok: false, code: WebuiErrorCode.invalidBody, message: "documentId must be a plain Design identifier" };
  return { ok: true, body: { ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}), ...(typeof record.documentId === "string" ? { documentId: record.documentId } : {}) } };
}
export const getDesignStateOperation: WebuiOperation<GetDesignStateRequest, DesignState> = { name: GET_DESIGN_STATE_OPERATION_NAME, validate: readIdentity };
export const applyDesignActionOperation: WebuiOperation<ApplyDesignActionRequest, DesignState> = {
  name: APPLY_DESIGN_ACTION_OPERATION_NAME,
  validate(body) {
    const identity = readIdentity(body);
    if (!identity.ok) return identity;
    const record = body as Record<string, unknown>;
    if (!isDesignAction(record.action)) return { ok: false, code: WebuiErrorCode.invalidBody, message: designActionError(record.action)! };
    if (record.expectedRevision !== undefined && (typeof record.expectedRevision !== "string" || !record.expectedRevision)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "expectedRevision must be a non-empty string" };
    return { ok: true, body: { ...identity.body, action: record.action, ...(typeof record.expectedRevision === "string" ? { expectedRevision: record.expectedRevision } : {}) } };
  },
};
