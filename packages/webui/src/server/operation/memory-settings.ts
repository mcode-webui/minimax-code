import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import {
  GET_MEMORY_SETTINGS_OPERATION_NAME,
  SET_MEMORY_SETTINGS_OPERATION_NAME,
} from "./names.js";

/**
 * The two long-term-memory switches.
 *
 * The frame carries two optional booleans and nothing else. That is the whole
 * safety argument: the shared config file holds plaintext API keys under other
 * roots, the runtime masks them on read, and writing a general config payload
 * back would overwrite the real keys with their masks. A closed two-boolean
 * shape makes that mistake unrepresentable rather than merely discouraged.
 *
 * Each field is validated as a boolean when present so an unknown-typed value
 * cannot reach the config writer, and both may be omitted so a single-switch
 * toggle is a legal frame.
 */
function validateSwitches(
  body: unknown,
  operationName: string,
): ReturnType<WebuiOperation<Record<string, boolean>, unknown>["validate"]> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${operationName} body must be an object`,
    };
  const record = body as Record<string, unknown>;
  for (const key of ["enabled", "proactive"] as const) {
    const value = record[key];
    if (value !== undefined && typeof value !== "boolean")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${key} must be a boolean`,
      };
  }
  const patch: Record<string, boolean> = {};
  if (typeof record.enabled === "boolean") patch.enabled = record.enabled;
  if (typeof record.proactive === "boolean") patch.proactive = record.proactive;
  return { ok: true, body: patch };
}

export const getMemorySettingsOperation: WebuiOperation<undefined, unknown> = {
  name: GET_MEMORY_SETTINGS_OPERATION_NAME,
  validate: (body) => {
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body)))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "getMemorySettings does not take a body",
      };
    return { ok: true, body: undefined };
  },
};

export const setMemorySettingsOperation: WebuiOperation<
  { readonly enabled?: boolean; readonly proactive?: boolean },
  unknown
> = {
  name: SET_MEMORY_SETTINGS_OPERATION_NAME,
  validate: (body) =>
    validateSwitches(body, SET_MEMORY_SETTINGS_OPERATION_NAME),
};
