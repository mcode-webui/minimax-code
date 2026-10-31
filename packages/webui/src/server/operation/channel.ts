// The 接入 IM wire operations.
//
// Six operations: the bound-client list, the bind and unbind of one IM client, the per-agent
// configuration check, and the read and write of one agent's message filter.
//
// They live in one file because they are one domain and one client business.
//
// Each validator checks the shape a browser may send — the name a client is keyed by, the
// credentials a bind carries, the two fields a filter carries — and never learns the runtime's
// model: the runtime's channel-bridge routes answer behind the harness adapter, and the wire
// contract (`shared/contracts/channel.ts`) is what the browser is given.
//
// The app secret travels once, in the request, and is never echoed back: it is read here for its
// shape and handed to the service that binds the client, and no validator ever puts its value in
// a message.
import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  CHECK_CHANNEL_CONFIG_OPERATION_NAME,
  CONNECT_CHANNEL_OPERATION_NAME,
  DISCONNECT_CHANNEL_OPERATION_NAME,
  GET_CHANNEL_MESSAGE_FILTER_OPERATION_NAME,
  LIST_CHANNEL_STATUS_OPERATION_NAME,
  UPDATE_CHANNEL_MESSAGE_FILTER_OPERATION_NAME,
} from "../../shared/operation-names.js";
import type {
  WebuiChannelConfigCheckRequest,
  WebuiChannelConfigCheckResult,
  WebuiChannelConnectRequest,
  WebuiChannelDisconnectRequest,
  WebuiChannelMessageFilter,
  WebuiChannelMessageFilterMode,
  WebuiChannelMessageFilterRequest,
  WebuiChannelOperationResult,
  WebuiChannelStatus,
} from "../../shared/contracts/channel.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";

/** The one refusal shape the six validators share. */
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

/** The name a client is keyed by. It is the identity the runtime stores the binding under. */
function readName(value: unknown): string | { readonly error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "name must be a non-empty string" };
  }
  return value;
}

/** The agent a per-agent read or write names. */
function readAgent(value: unknown): string | { readonly error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "agent must be a non-empty string" };
  }
  return value;
}

/** An optional string a browser may omit; a present one still has to be a string. */
function readOptionalText(
  value: unknown,
  field: string,
): string | undefined | { readonly error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return { error: `${field} must be a string` };
  return value;
}

const MESSAGE_FILTER_MODES: readonly WebuiChannelMessageFilterMode[] = ["result", "full"];

export const listChannelStatusOperation: WebuiOperation<undefined, WebuiChannelStatus> = {
  name: LIST_CHANNEL_STATUS_OPERATION_NAME,
  validate: (body) => validateNoBody(LIST_CHANNEL_STATUS_OPERATION_NAME, body),
};

export const connectChannelOperation: WebuiOperation<
  WebuiChannelConnectRequest,
  WebuiChannelOperationResult
> = {
  name: CONNECT_CHANNEL_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null) {
      return invalid(`${CONNECT_CHANNEL_OPERATION_NAME} body must be an object`);
    }
    if (typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${CONNECT_CHANNEL_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const name = readName(value.name);
    if (typeof name !== "string") return invalid(name.error);
    const appId = readOptionalText(value.appId, "appId");
    if (appId !== undefined && typeof appId !== "string") return invalid(appId.error);
    const appSecret = readOptionalText(value.appSecret, "appSecret");
    if (appSecret !== undefined && typeof appSecret !== "string") return invalid(appSecret.error);
    return {
      ok: true,
      body: {
        name,
        ...(appId === undefined ? {} : { appId }),
        ...(appSecret === undefined ? {} : { appSecret }),
      },
    };
  },
};

export const disconnectChannelOperation: WebuiOperation<
  WebuiChannelDisconnectRequest,
  WebuiChannelOperationResult
> = {
  name: DISCONNECT_CHANNEL_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${DISCONNECT_CHANNEL_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const name = readName(value.name);
    if (typeof name !== "string") return invalid(name.error);
    const clearCredentials = value.clearCredentials;
    if (clearCredentials !== undefined && typeof clearCredentials !== "boolean") {
      return invalid("clearCredentials must be a boolean");
    }
    const platform = readOptionalText(value.platform, "platform");
    if (platform !== undefined && typeof platform !== "string") return invalid(platform.error);
    return {
      ok: true,
      body: {
        name,
        ...(clearCredentials === undefined ? {} : { clearCredentials }),
        ...(platform === undefined ? {} : { platform }),
      },
    };
  },
};

export const checkChannelConfigOperation: WebuiOperation<
  WebuiChannelConfigCheckRequest,
  WebuiChannelConfigCheckResult
> = {
  name: CHECK_CHANNEL_CONFIG_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${CHECK_CHANNEL_CONFIG_OPERATION_NAME} body must be an object`);
    }
    const agent = readAgent((body as Record<string, unknown>).agent);
    if (typeof agent !== "string") return invalid(agent.error);
    return { ok: true, body: { agent } };
  },
};

export const getChannelMessageFilterOperation: WebuiOperation<
  { readonly agent: string },
  WebuiChannelMessageFilter
> = {
  name: GET_CHANNEL_MESSAGE_FILTER_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${GET_CHANNEL_MESSAGE_FILTER_OPERATION_NAME} body must be an object`);
    }
    const agent = readAgent((body as Record<string, unknown>).agent);
    if (typeof agent !== "string") return invalid(agent.error);
    return { ok: true, body: { agent } };
  },
};

export const updateChannelMessageFilterOperation: WebuiOperation<
  WebuiChannelMessageFilterRequest,
  WebuiChannelMessageFilter
> = {
  name: UPDATE_CHANNEL_MESSAGE_FILTER_OPERATION_NAME,
  validate: (body) => {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      return invalid(`${UPDATE_CHANNEL_MESSAGE_FILTER_OPERATION_NAME} body must be an object`);
    }
    const value = body as Record<string, unknown>;
    const agent = readAgent(value.agent);
    if (typeof agent !== "string") return invalid(agent.error);
    const filter = value.filter;
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      return invalid("filter must be an object");
    }
    const record = filter as Record<string, unknown>;
    const mode = record.mode;
    if (typeof mode !== "string" || !MESSAGE_FILTER_MODES.includes(mode as WebuiChannelMessageFilterMode)) {
      return invalid("filter.mode must be 'result' or 'full'");
    }
    if (typeof record.includeToolSummary !== "boolean") {
      return invalid("filter.includeToolSummary must be a boolean");
    }
    return {
      ok: true,
      body: {
        agent,
        filter: {
          mode: mode as WebuiChannelMessageFilterMode,
          includeToolSummary: record.includeToolSummary,
        },
      },
    };
  },
};
