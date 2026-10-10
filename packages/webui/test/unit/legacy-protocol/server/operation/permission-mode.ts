import { WebuiErrorCode } from "../envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import {
  GET_PERMISSION_MODE_OPERATION_NAME,
  SET_PERMISSION_MODE_OPERATION_NAME,
} from "./names.js";

export type WebuiPermissionMode = "default" | "auto" | "bypassPermissions";

const modes = new Set<WebuiPermissionMode>([
  "default",
  "auto",
  "bypassPermissions",
]);

export const getPermissionModeOperation: WebuiOperation<Record<string, never>, unknown> = {
  name: GET_PERMISSION_MODE_OPERATION_NAME,
  validate: (body) =>
    body === undefined || (body !== null && typeof body === "object" && !Array.isArray(body))
      ? { ok: true, body: {} }
      : { ok: false, code: WebuiErrorCode.invalidBody, message: "getPermissionMode body must be an object" },
};

export const setPermissionModeOperation: WebuiOperation<
  { readonly mode: WebuiPermissionMode },
  unknown
> = {
  name: SET_PERMISSION_MODE_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "setPermissionMode body must be an object" };
    const mode = (body as Record<string, unknown>).mode;
    if (typeof mode !== "string" || !modes.has(mode as WebuiPermissionMode))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "mode must be default, auto, or bypassPermissions" };
    return { ok: true, body: { mode: mode as WebuiPermissionMode } };
  },
};
