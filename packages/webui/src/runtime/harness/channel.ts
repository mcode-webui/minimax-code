// The 接入 IM cell of the harness port.
//
// The runtime already owns the IM channel bridge: `routeLocalChannelBridgeInfraApi` serves the
// routes Desktop's IM client calls, and the runtime host exposes them through one narrow surface
// (`LocalRuntimeApiHost.channelBridge`). This adapter forwards and converts, and it decides
// nothing — not which clients are bound, not whether a bind worked.
//
// Two things happen here:
//
//   * the runtime's channel types stop at this file. `shared/contracts/channel.ts` is what the
//     browser may name, and `src/shared` may not import the runtime's channel types, so every
//     field is read and re-emitted. A field the wire declares as required is either read or
//     failed on (`WebuiResultShapeError`), because a client rendered with a guessed name is worse
//     than one that reports it could not be read.
//   * a host that carries no channel bridge answers with one refusal. The six members are
//     required on the port and optional on the host, so the absence is resolved once, here,
//     instead of at six call sites.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireHostSlot } from "./requirements.js";
import { WebuiResultShapeError } from "./result-conversion.js";
import type {
  WebuiChannelClient,
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

/**
 * The runtime's channel-bridge surface, as this adapter reads it.
 *
 * The WebUI does not depend on the runtime package that owns the channel bridge, so the shape is
 * declared here and satisfied structurally. The runtime's own surface answers these calls with the
 * same fields, which is what keeps the two in step without a package dependency.
 */
export interface WebuiRuntimeChannelBridge {
  readonly listStatus: () => Promise<{
    readonly clients: readonly {
      readonly name: string;
      readonly platform: string;
      readonly agentName?: string;
    }[];
  }>;
  readonly connect: (request: {
    readonly name: string;
    readonly appId?: string;
    readonly appSecret?: string;
  }) => Promise<{ readonly ok: boolean; readonly error?: string; readonly code?: string }>;
  readonly disconnect: (request: {
    readonly name: string;
    readonly clearCredentials?: boolean;
    readonly platform?: string;
  }) => Promise<{ readonly ok: boolean; readonly error?: string; readonly code?: string }>;
  readonly checkConfig: (request: { readonly agent: string }) => Promise<{
    readonly configured: boolean;
    readonly detail?: string;
  }>;
  readonly getMessageFilter: (request: { readonly agent: string }) => Promise<{
    readonly mode: string;
    readonly includeToolSummary: boolean;
  }>;
  readonly updateMessageFilter: (request: {
    readonly agent: string;
    readonly filter: { readonly mode: string; readonly includeToolSummary: boolean };
  }) => Promise<{ readonly mode: string; readonly includeToolSummary: boolean }>;
}

/**
 * The host slot that carries the channel bridge.
 *
 * The runtime host publishes the surface as a public member, and a host composed for the browser
 * may hand the same object over under a slot of its own. Both are read, so the adapter works
 * whichever way the host is composed — and a host that carries neither refuses once, here.
 */
interface WebuiChannelBridgeSlot {
  readonly channelBridge?: WebuiRuntimeChannelBridge;
}

/**
 * The six members, already converted.
 *
 * A host may carry them itself (`host-contract.ts` declares the slot for exactly that), or the
 * adapter builds them from the runtime's raw bridge. Both paths end in the same six functions, so
 * the conversion lives in one place either way.
 */
interface WebuiChannelMembers {
  readonly listChannelStatus: () => Promise<WebuiChannelStatus>;
  readonly connectChannel: (
    request: WebuiChannelConnectRequest,
  ) => Promise<WebuiChannelOperationResult>;
  readonly disconnectChannel: (
    request: WebuiChannelDisconnectRequest,
  ) => Promise<WebuiChannelOperationResult>;
  readonly checkChannelConfig: (
    request: WebuiChannelConfigCheckRequest,
  ) => Promise<WebuiChannelConfigCheckResult>;
  readonly getChannelMessageFilter: (request: {
    readonly agent: string;
  }) => Promise<WebuiChannelMessageFilter>;
  readonly updateChannelMessageFilter: (
    request: WebuiChannelMessageFilterRequest,
  ) => Promise<WebuiChannelMessageFilter>;
}

const CHANNEL_MEMBER_NAMES = [
  "listChannelStatus",
  "connectChannel",
  "disconnectChannel",
  "checkChannelConfig",
  "getChannelMessageFilter",
  "updateChannelMessageFilter",
] as const;

/**
 * The six members, as one capability.
 *
 * They travel together: the runtime composes them from one channel bridge, so a host that has
 * three of them is broken rather than partial, and refusing all six is the message a client can
 * act on.
 */
function hasAllChannelMembers(candidate: Partial<WebuiChannelMembers>): boolean {
  return CHANNEL_MEMBER_NAMES.every((name) => typeof candidate[name] === "function");
}

/** The members the runtime's raw bridge answers, converted to the wire. */
function membersFromRuntimeBridge(bridge: WebuiRuntimeChannelBridge): WebuiChannelMembers {
  return {
    listChannelStatus: async () => ({ clients: toClients(await bridge.listStatus()) }),
    connectChannel: async (request) =>
      toOperationResult(
        await bridge.connect({
          name: request.name,
          ...(request.appId === undefined ? {} : { appId: request.appId }),
          ...(request.appSecret === undefined ? {} : { appSecret: request.appSecret }),
        }),
      ),
    disconnectChannel: async (request) =>
      toOperationResult(
        await bridge.disconnect({
          name: request.name,
          ...(request.clearCredentials === undefined
            ? {}
            : { clearCredentials: request.clearCredentials }),
          ...(request.platform === undefined ? {} : { platform: request.platform }),
        }),
      ),
    checkChannelConfig: async (request) => {
      const result = await bridge.checkConfig({ agent: request.agent });
      const detail = optionalText(result.detail);
      return {
        configured: requiredBoolean(result.configured, "configured"),
        ...(detail === undefined ? {} : { detail }),
      };
    },
    getChannelMessageFilter: async (request) =>
      toMessageFilter(await bridge.getMessageFilter({ agent: request.agent })),
    updateChannelMessageFilter: async (request) =>
      toMessageFilter(
        await bridge.updateMessageFilter({
          agent: request.agent,
          filter: {
            mode: request.filter.mode,
            includeToolSummary: request.filter.includeToolSummary,
          },
        }),
      ),
  };
}

/**
 * The six members, from whichever seam the host offers.
 *
 * A host that carries the members itself wins; a host that carries only the runtime's bridge
 * gets them converted here; a host that carries neither refuses with one stated error, so the
 * browser never reads an absent bridge as "no IM client is bound".
 */
function requireChannelMembers(host: WebuiRuntimeHostHandle): WebuiChannelMembers {
  const own = host as unknown as Partial<WebuiChannelMembers>;
  if (hasAllChannelMembers(own)) return own as WebuiChannelMembers;
  const slot = host as unknown as WebuiChannelBridgeSlot;
  const bridge = requireHostSlot(
    slot.channelBridge ??
      (host.apiHost as unknown as WebuiChannelBridgeSlot).channelBridge,
    "the channel bridge",
  );
  return membersFromRuntimeBridge(bridge);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebuiResultShapeError(`an IM channel field was not readable: ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new WebuiResultShapeError(`an IM channel field was not readable: ${field}`);
  }
  return value;
}

const MESSAGE_FILTER_MODES: readonly WebuiChannelMessageFilterMode[] = ["result", "full"];

function toMessageFilter(
  filter: { readonly mode: string; readonly includeToolSummary: boolean },
): WebuiChannelMessageFilter {
  const mode = filter.mode;
  if (!MESSAGE_FILTER_MODES.includes(mode as WebuiChannelMessageFilterMode)) {
    throw new WebuiResultShapeError(`an IM channel field was not readable: filter.mode`);
  }
  return {
    mode: mode as WebuiChannelMessageFilterMode,
    includeToolSummary: requiredBoolean(filter.includeToolSummary, "filter.includeToolSummary"),
  };
}

function toClients(status: {
  readonly clients: readonly {
    readonly name: string;
    readonly platform: string;
    readonly agentName?: string;
  }[];
}): WebuiChannelClient[] {
  if (!Array.isArray(status.clients)) {
    throw new WebuiResultShapeError("an IM channel status carried no clients list");
  }
  return status.clients.map((client) => {
    const agentName = optionalText(client.agentName);
    return {
      name: requiredText(client.name, "client.name"),
      platform: requiredText(client.platform, "client.platform"),
      ...(agentName === undefined ? {} : { agentName }),
    };
  });
}

/**
 * The runtime's verdict on one mutation, as the wire reports it.
 *
 * The runtime's own code comes first when it sent one, because that code is what the rest of the
 * runtime reads the refusal by; the message follows it so the browser can still say what happened.
 */
function toOperationResult(outcome: {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
}): WebuiChannelOperationResult {
  const code = optionalText(outcome.code);
  const error = optionalText(outcome.error);
  const detail = code === undefined ? error : error === undefined ? code : `${code}: ${error}`;
  return {
    success: outcome.ok === true,
    ...(detail === undefined ? {} : { error: detail }),
  };
}

export function createChannelAdapter(host: WebuiRuntimeHostHandle): Pick<
  WebuiHarnessPort,
  | "listChannelStatus"
  | "connectChannel"
  | "disconnectChannel"
  | "checkChannelConfig"
  | "getChannelMessageFilter"
  | "updateChannelMessageFilter"
> {
  return {
    async listChannelStatus(): Promise<WebuiChannelStatus> {
      return requireChannelMembers(host).listChannelStatus();
    },

    async connectChannel(request): Promise<WebuiChannelOperationResult> {
      return requireChannelMembers(host).connectChannel(request);
    },

    async disconnectChannel(request): Promise<WebuiChannelOperationResult> {
      return requireChannelMembers(host).disconnectChannel(request);
    },

    async checkChannelConfig(request): Promise<WebuiChannelConfigCheckResult> {
      return requireChannelMembers(host).checkChannelConfig(request);
    },

    async getChannelMessageFilter(request): Promise<WebuiChannelMessageFilter> {
      return requireChannelMembers(host).getChannelMessageFilter(request);
    },

    async updateChannelMessageFilter(request): Promise<WebuiChannelMessageFilter> {
      return requireChannelMembers(host).updateChannelMessageFilter(request);
    },
  };
}
