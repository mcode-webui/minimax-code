import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import {
  GET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
  SET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
} from "./names.js";

export const getGlobalInstructionsOperation: WebuiOperation<
  Record<string, never>,
  unknown
> = {
  name: GET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
  validate: (body) =>
    body === undefined || (body !== null && typeof body === "object" && !Array.isArray(body))
      ? { ok: true, body: {} }
      : {
          ok: false,
          code: WebuiErrorCode.invalidBody,
          message: "getGlobalInstructions body must be an object",
        },
};

export const setGlobalInstructionsOperation: WebuiOperation<
  { readonly content: string },
  unknown
> = {
  name: SET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setGlobalInstructions body must be an object",
      };
    const content = (body as Record<string, unknown>).content;
    // Empty is legal: the runtime deletes the file. Undefined and non-strings
    // are not, because they would silently truncate the file to empty.
    if (typeof content !== "string")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setGlobalInstructions requires a string content",
      };
    return { ok: true, body: { content } };
  },
};
