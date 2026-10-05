import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import { GET_USER_PROFILE_OPERATION_NAME, SET_USER_PROFILE_OPERATION_NAME } from "./names.js";

/**
 * The `关于你` region of `user.md`.
 *
 * No body: the server owns the file path and the marker pair, and the client
 * has no business choosing either. What it may change is the text between the
 * markers, and nothing else — a save that dropped the runtime's appended
 * entries would delete memory the collector wrote.
 */
export const getUserProfileOperation: WebuiOperation<
  undefined,
  unknown
> = {
  name: GET_USER_PROFILE_OPERATION_NAME,
  validate: (body) => {
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body)))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "getUserProfile does not take a body",
      };
    return { ok: true, body: undefined };
  },
};

export const setUserProfileOperation: WebuiOperation<
  { readonly content: string },
  unknown
> = {
  name: SET_USER_PROFILE_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setUserProfile body must be an object",
      };
    const content = (body as Record<string, unknown>).content;
    // Empty is legal and means "clear the profile". A missing or non-string
    // content must never reach the writer: it would clear a region the user
    // never opened.
    if (typeof content !== "string")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setUserProfile requires a string content",
      };
    return { ok: true, body: { content } };
  },
};
