import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPermissionDecision,
  WebuiQuestionnaireAnswer,
} from "../../shared/contracts/interactions.js";
import { validateOptionalObjectBody, validateNamedSessionBody, validatePermissionDecision } from "./common.js";
import { WATCH_EVENTS_OPERATION_NAME, LIST_PENDING_PERMISSIONS_OPERATION_NAME, GET_PENDING_QUESTIONNAIRE_OPERATION_NAME, REPLY_PERMISSION_OPERATION_NAME, REPLY_QUESTIONNAIRE_OPERATION_NAME, DISMISS_QUESTIONNAIRE_OPERATION_NAME } from "./names.js";
export const watchEventsOperation: WebuiOperation<Record<string, unknown>> = {
  name: WATCH_EVENTS_OPERATION_NAME,
  // The event watcher is the only stream the client has to reason about
  // before any payload arrives, so it is the only one that acknowledges.
  acknowledgesStream: true,
  validate: (body) =>
    validateOptionalObjectBody(WATCH_EVENTS_OPERATION_NAME, body),
};

export const listPendingPermissionsOperation: WebuiOperation<
  Record<string, unknown>
> = {
  name: LIST_PENDING_PERMISSIONS_OPERATION_NAME,
  validate: (body) =>
    validateOptionalObjectBody(LIST_PENDING_PERMISSIONS_OPERATION_NAME, body),
};


export const getPendingQuestionnaireOperation: WebuiOperation<
  {
    readonly name: string;
    readonly sessionId: string;
  },
  { readonly request?: import("../../shared/contracts/interactions.js").WebuiQuestionnaireRequest }
> = {
  name: GET_PENDING_QUESTIONNAIRE_OPERATION_NAME,
  validate: (body) =>
    validateNamedSessionBody(GET_PENDING_QUESTIONNAIRE_OPERATION_NAME, body),
};


export const replyPermissionOperation: WebuiOperation<
  {
    readonly name: string;
    readonly requestId: string;
    readonly reply: WebuiPermissionDecision;
  },
  import("../../shared/contracts/interactions.js").WebuiInteractionReplyResult
> = {
  name: REPLY_PERMISSION_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "replyPermission body must be an object",
      };
    const candidate = body as Record<string, unknown>;
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    const requestId =
      typeof candidate.requestId === "string" ? candidate.requestId.trim() : "";
    if (!name || !requestId || !validatePermissionDecision(candidate.reply))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message:
          "replyPermission body requires name, requestId and a valid reply",
      };
    return { ok: true, body: { name, requestId, reply: candidate.reply } };
  },
};


function validateQuestionnaireAnswers(
  value: unknown,
): value is WebuiQuestionnaireAnswer[] {
  return (
    Array.isArray(value) &&
    value.every((answer) => {
      if (
        answer === null ||
        typeof answer !== "object" ||
        Array.isArray(answer)
      )
        return false;
      const candidate = answer as Record<string, unknown>;
      if (typeof candidate.stepId !== "string" || !candidate.stepId.trim())
        return false;
      if (
        candidate.selectedOptionIds !== undefined &&
        (!Array.isArray(candidate.selectedOptionIds) ||
          !candidate.selectedOptionIds.every((id) => typeof id === "string"))
      )
        return false;
      return (
        (candidate.selectedOther === undefined ||
          typeof candidate.selectedOther === "boolean") &&
        (candidate.otherText === undefined ||
          typeof candidate.otherText === "string") &&
        (candidate.skipped === undefined ||
          typeof candidate.skipped === "boolean")
      );
    })
  );
}


export const replyQuestionnaireOperation: WebuiOperation<
  {
    readonly name: string;
    readonly requestId: string;
    readonly schemaVersion: number;
    readonly answers: WebuiQuestionnaireAnswer[];
  },
  import("../../shared/contracts/interactions.js").WebuiInteractionReplyResult
> = {
  name: REPLY_QUESTIONNAIRE_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "replyQuestionnaire body must be an object",
      };
    const candidate = body as Record<string, unknown>;
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    const requestId =
      typeof candidate.requestId === "string" ? candidate.requestId.trim() : "";
    if (
      !name ||
      !requestId ||
      !Number.isInteger(candidate.schemaVersion) ||
      !validateQuestionnaireAnswers(candidate.answers)
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message:
          "replyQuestionnaire body requires name, requestId, schemaVersion and answers",
      };
    return {
      ok: true,
      body: {
        name,
        requestId,
        schemaVersion: candidate.schemaVersion as number,
        answers: candidate.answers,
      },
    };
  },
};

export const dismissQuestionnaireOperation: WebuiOperation<
  {
    readonly name: string;
    readonly requestId: string;
  },
  import("../../shared/contracts/interactions.js").WebuiInteractionReplyResult
> = {
  name: DISMISS_QUESTIONNAIRE_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "dismissQuestionnaire body must be an object",
      };
    const raw = body as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const requestId =
      typeof raw.requestId === "string" ? raw.requestId.trim() : "";
    if (!name || !requestId)
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "dismissQuestionnaire body requires name and requestId",
      };
    return { ok: true, body: { name, requestId } };
  },
};
