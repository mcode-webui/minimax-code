// The 远程控制 wire operations.
//
// Nine operations: the status, the stream that carries the live phase, the mutations that open and
// close the phone link, the credentials the browser signs and pushes down, the pending unbind the
// user has to confirm, and the composer mode the phone sets on a session.
//
// They live in one file because they are one domain and one client business.
//
// Each validator checks the shape a browser may send — a flag, an identity, the three fields a
// signed ticket carries — and never learns the bridge's model: the bridge's `RCStatus`,
// `RCConnectResult` and `RcPendingUnbind` stay behind the harness adapter, and the wire contract
// (`shared/contracts/remote-control.ts`) is what the browser is given.
//
// The ticket is never logged, never persisted and never echoed back: a validator that rejected a
// credential would leak it into an error message, so the credential's shape is checked here and
// its *value* travels no further than the service that consumes it.
import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  APPLY_REMOTE_CONTROL_CREDENTIALS_OPERATION_NAME,
  CONNECT_REMOTE_CONTROL_OPERATION_NAME,
  DISCONNECT_REMOTE_CONTROL_OPERATION_NAME,
  GET_REMOTE_CONTROL_PENDING_UNBIND_OPERATION_NAME,
  GET_REMOTE_CONTROL_STATUS_OPERATION_NAME,
  PUBLISH_REMOTE_CONTROL_COMPOSER_MODE_OPERATION_NAME,
  REPORT_REMOTE_CONTROL_BINDING_LOST_OPERATION_NAME,
  RESOLVE_REMOTE_CONTROL_UNBIND_OPERATION_NAME,
  WATCH_REMOTE_CONTROL_STATUS_OPERATION_NAME,
} from "../../shared/operation-names.js";
import type {
  WebuiRemoteControlComposerMode,
  WebuiRemoteControlConnectRequest,
  WebuiRemoteControlConnectResult,
  WebuiRemoteControlCredentials,
  WebuiRemoteControlDisconnectRequest,
  WebuiRemoteControlOperationResult,
  WebuiRemoteControlPendingUnbind,
  WebuiRemoteControlStatus,
  WebuiWatchRemoteControlResult,
} from "../../shared/contracts/remote-control.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";

/** The one refusal shape the nine validators share. */
function invalid(message: string): {
  readonly ok: false;
  readonly code: typeof WebuiErrorCode.invalidBody;
  readonly message: string;
} {
  return { ok: false, code: WebuiErrorCode.invalidBody, message };
}

/** A body the browser may omit entirely. */
function validateNoBody(operation: string, body: unknown): WebuiOperationValidation<undefined> {
  if (body === undefined || body === null) return { ok: true, body: undefined };
  if (typeof body === "object" && !Array.isArray(body)) {
    const keys = Object.keys(body as Record<string, unknown>);
    if (keys.length === 0) return { ok: true, body: undefined };
  }
  return invalid(`${operation} does not take a body`);
}

export const getRemoteControlStatusOperation: WebuiOperation<
  undefined,
  WebuiRemoteControlStatus
> = {
  name: GET_REMOTE_CONTROL_STATUS_OPERATION_NAME,
  validate: (body) => validateNoBody(GET_REMOTE_CONTROL_STATUS_OPERATION_NAME, body),
};

export const watchRemoteControlStatusOperation: WebuiOperation<
  undefined,
  WebuiWatchRemoteControlResult
> = {
  name: WATCH_REMOTE_CONTROL_STATUS_OPERATION_NAME,
  // The status stream is the one stream with no payload of its own to observe, so it is the one
  // that acknowledges: the browser learns "accepted" before the first frame arrives.
  acknowledgesStream: true,
  validate: (body) => validateNoBody(WATCH_REMOTE_CONTROL_STATUS_OPERATION_NAME, body),
};

export const connectRemoteControlOperation: WebuiOperation<
  WebuiRemoteControlConnectRequest,
  WebuiRemoteControlConnectResult
> = {
  name: CONNECT_REMOTE_CONTROL_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null) return { ok: true, body: {} };
    if (typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${CONNECT_REMOTE_CONTROL_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const requestCode = value.requestCode;
    if (requestCode !== undefined && typeof requestCode !== "boolean") {
      return invalid("requestCode must be a boolean");
    }
    return {
      ok: true,
      body: requestCode === undefined ? {} : { requestCode: requestCode as boolean },
    };
  },
};

export const disconnectRemoteControlOperation: WebuiOperation<
  WebuiRemoteControlDisconnectRequest,
  WebuiRemoteControlOperationResult
> = {
  name: DISCONNECT_REMOTE_CONTROL_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null) return { ok: true, body: {} };
    if (typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${DISCONNECT_REMOTE_CONTROL_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const unbind = value.unbind;
    if (unbind !== undefined && typeof unbind !== "boolean") {
      return invalid("unbind must be a boolean");
    }
    return { ok: true, body: unbind === undefined ? {} : { unbind: unbind as boolean } };
  },
};

export const applyRemoteControlCredentialsOperation: WebuiOperation<
  WebuiRemoteControlCredentials,
  WebuiRemoteControlOperationResult
> = {
  name: APPLY_REMOTE_CONTROL_CREDENTIALS_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${APPLY_REMOTE_CONTROL_CREDENTIALS_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const bindingId = value.bindingId;
    if (typeof bindingId !== "number" || !Number.isSafeInteger(bindingId)) {
      return invalid("bindingId must be a safe integer");
    }
    const ticket = value.ticket;
    if (typeof ticket !== "string" || ticket === "") {
      return invalid("ticket must be a non-empty string");
    }
    const endpoint = value.endpoint;
    if (typeof endpoint !== "string" || endpoint === "") {
      return invalid("endpoint must be a non-empty string");
    }
    const producerGeneration = value.producerGeneration;
    if (
      producerGeneration !== undefined &&
      (typeof producerGeneration !== "number" || !Number.isSafeInteger(producerGeneration))
    ) {
      return invalid("producerGeneration must be a safe integer");
    }
    const requestEpoch = value.requestEpoch;
    if (
      requestEpoch !== undefined &&
      (typeof requestEpoch !== "number" || !Number.isSafeInteger(requestEpoch))
    ) {
      return invalid("requestEpoch must be a safe integer");
    }
    return {
      ok: true,
      body: {
        bindingId,
        ticket,
        endpoint,
        ...(producerGeneration === undefined ? {} : { producerGeneration }),
        ...(requestEpoch === undefined ? {} : { requestEpoch }),
      },
    };
  },
};

export const reportRemoteControlBindingLostOperation: WebuiOperation<
  undefined,
  WebuiRemoteControlOperationResult
> = {
  name: REPORT_REMOTE_CONTROL_BINDING_LOST_OPERATION_NAME,
  validate: (body) => validateNoBody(REPORT_REMOTE_CONTROL_BINDING_LOST_OPERATION_NAME, body),
};

export const getRemoteControlPendingUnbindOperation: WebuiOperation<
  undefined,
  WebuiRemoteControlPendingUnbind | null
> = {
  name: GET_REMOTE_CONTROL_PENDING_UNBIND_OPERATION_NAME,
  validate: (body) => validateNoBody(GET_REMOTE_CONTROL_PENDING_UNBIND_OPERATION_NAME, body),
};

export const resolveRemoteControlUnbindOperation: WebuiOperation<
  { readonly requestId: string; readonly confirmed: boolean },
  WebuiRemoteControlOperationResult
> = {
  name: RESOLVE_REMOTE_CONTROL_UNBIND_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${RESOLVE_REMOTE_CONTROL_UNBIND_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const requestId = value.requestId;
    if (typeof requestId !== "string" || requestId.trim() === "") {
      return invalid("requestId must be a non-empty string");
    }
    const confirmed = value.confirmed;
    if (typeof confirmed !== "boolean") {
      return invalid("confirmed must be a boolean");
    }
    return { ok: true, body: { requestId, confirmed } };
  },
};

const COMPOSER_MODES = ["default", "goal", "plan"] as const;

export const publishRemoteControlComposerModeOperation: WebuiOperation<
  WebuiRemoteControlComposerMode,
  { readonly accepted: boolean }
> = {
  name: PUBLISH_REMOTE_CONTROL_COMPOSER_MODE_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${PUBLISH_REMOTE_CONTROL_COMPOSER_MODE_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const sessionId = value.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      return invalid("sessionId must be a non-empty string");
    }
    const mode = value.mode;
    if (
      typeof mode !== "string" ||
      !COMPOSER_MODES.includes(mode as (typeof COMPOSER_MODES)[number])
    ) {
      return invalid(`mode must be one of ${COMPOSER_MODES.join(", ")}`);
    }
    return { ok: true, body: { sessionId, mode: mode as (typeof COMPOSER_MODES)[number] } };
  },
};

/** The nine descriptors, in the order the 远程控制 tab uses them. */
export const remoteControlOperations = [
  getRemoteControlStatusOperation,
  watchRemoteControlStatusOperation,
  connectRemoteControlOperation,
  disconnectRemoteControlOperation,
  applyRemoteControlCredentialsOperation,
  reportRemoteControlBindingLostOperation,
  getRemoteControlPendingUnbindOperation,
  resolveRemoteControlUnbindOperation,
  publishRemoteControlComposerModeOperation,
] as const;
