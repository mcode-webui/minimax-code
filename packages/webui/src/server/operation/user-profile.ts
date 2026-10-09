import { WebuiErrorCode } from "../../shared/envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import { GET_USER_PROFILE_OPERATION_NAME, SET_USER_PROFILE_OPERATION_NAME } from "../../shared/operation-names.js";

/**
 * The `关于你` region of `user.md`.
 *
 * No body: the server owns the file path and the marker pair, and the client
 * has no business choosing either. What it may change is the three fields
 * between the markers, and nothing else — a save that dropped the runtime's
 * appended entries would delete memory the collector wrote.
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
  { readonly nickname: string; readonly occupation: string; readonly moreAbout: string },
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
    const record = body as Record<string, unknown>;
    // Empty is legal for every field and means "this one is blank". A missing
    // or non-string field must never reach the writer: defaulting one to ""
    // would silently erase a value the user never touched.
    for (const field of ["nickname", "occupation", "moreAbout"] as const) {
      if (typeof record[field] !== "string")
        return {
          ok: false,
          code: WebuiErrorCode.invalidBody,
          message: `setUserProfile requires a string ${field}`,
        };
    }
    return {
      ok: true,
      body: {
        nickname: record.nickname as string,
        occupation: record.occupation as string,
        moreAbout: record.moreAbout as string,
      },
    };
  },
};
