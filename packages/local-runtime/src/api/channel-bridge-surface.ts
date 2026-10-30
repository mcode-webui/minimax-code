// The narrow public face of the IM channel bridge.
//
// The WebUI's 接入 IM tab needs the same facts Desktop's IM client reads over HTTP. Nothing
// here is a second implementation: every call is forwarded to the runtime's existing channel-bridge
// dispatcher (`routeLocalChannelBridgeInfraApi`), so binding, routing, credential storage and the
// platform adapters stay exactly where they live. This module only turns a route's JSON body into
// a narrow view, because the WebUI may not name the runtime's channel types.
//
// Two facts the surface keeps honest:
//
//   * **A host without the channel service refuses.** An empty client list would read as "no IM
//     clients are bound", which is a different answer from "this host cannot bind an IM client".
//   * **A route's own failure is the answer.** The dispatcher answers a refused bind with a body
//     that says so, and the surface passes that body on instead of reporting a success.
import type { LocalFeishuChannelApi } from "../channels/feishu.js";
import {
  routeLocalChannelBridgeInfraApi,
  type LocalChannelBridgeInfra,
} from "../channels/infra.js";
import type { LocalChannelRunner } from "../channels/runner.js";
import type { LocalTelegramChannelApi } from "../channels/telegram.js";
import type { LocalWeChatChannelApi } from "../channels/wechat.js";

/** One IM client the runtime knows, keyed by the name the user gave it. */
export interface LocalChannelBridgeClientView {
  readonly name: string;
  readonly platform: string;
  readonly agentName?: string;
}

export interface LocalChannelBridgeStatusView {
  readonly clients: readonly LocalChannelBridgeClientView[];
}

/** The outcome of one bind or unbind, as the route reported it. */
export interface LocalChannelBridgeMutationView {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
}

export interface LocalChannelBridgeConfigView {
  readonly configured: boolean;
  readonly detail?: string;
}

export interface LocalChannelBridgeMessageFilterView {
  readonly mode: "result" | "full";
  readonly includeToolSummary: boolean;
}

export interface LocalChannelBridgeConnectRequest {
  readonly name: string;
  readonly appId?: string;
  readonly appSecret?: string;
}

export interface LocalChannelBridgeDisconnectRequest {
  readonly name: string;
  readonly clearCredentials?: boolean;
  readonly platform?: string;
}

export interface LocalChannelBridgeAgentRequest {
  readonly agent: string;
}

export interface LocalChannelBridgeMessageFilterRequest extends LocalChannelBridgeAgentRequest {
  readonly filter: LocalChannelBridgeMessageFilterView;
}

export interface LocalChannelBridgeSurface {
  /** The bound IM clients, in the runtime's own order. */
  listStatus(): Promise<LocalChannelBridgeStatusView>;
  connect(request: LocalChannelBridgeConnectRequest): Promise<LocalChannelBridgeMutationView>;
  disconnect(request: LocalChannelBridgeDisconnectRequest): Promise<LocalChannelBridgeMutationView>;
  checkConfig(request: LocalChannelBridgeAgentRequest): Promise<LocalChannelBridgeConfigView>;
  getMessageFilter(request: LocalChannelBridgeAgentRequest): Promise<LocalChannelBridgeMessageFilterView>;
  updateMessageFilter(
    request: LocalChannelBridgeMessageFilterRequest,
  ): Promise<LocalChannelBridgeMessageFilterView>;
}

export interface LocalChannelBridgeDependencies {
  readonly infra: LocalChannelBridgeInfra;
  readonly runner?: LocalChannelRunner;
  readonly feishu?: LocalFeishuChannelApi;
  readonly telegram?: LocalTelegramChannelApi;
  readonly wechat?: LocalWeChatChannelApi;
  /**
   * Whether this host assembles the channel service at all. A host that does not answers every
   * call with a refusal instead of an empty list.
   */
  readonly enabled: boolean;
}

const CHANNEL_BRIDGE_ORIGIN = "http://local";

/** The runtime's own refusal when a host carries no channel service. */
export const LOCAL_CHANNEL_BRIDGE_UNAVAILABLE =
  "The IM channel service is not available on this host.";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The platform a client name carries, for the names the runtime prefixes. */
function platformFromName(name: string): string | undefined {
  const separator = name.indexOf(":");
  if (separator <= 0) return undefined;
  const prefix = name.slice(0, separator).toLowerCase();
  return prefix === "feishu" || prefix === "telegram" || prefix === "wechat" ? prefix : undefined;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await response.json()) as unknown;
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface ForwardedRoute {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Forwards one channel-bridge route to the existing dispatcher.
 *
 * The dispatcher reads its path from `parts` (the first segment is the route family) and its query
 * from `url`, so the caller builds both here rather than the dispatcher growing a second way in.
 */
async function forwardRoute(
  deps: LocalChannelBridgeDependencies,
  method: string,
  path: string,
  options: {
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<ForwardedRoute> {
  const url = new URL(`${CHANNEL_BRIDGE_ORIGIN}/channel-bridge/${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const hasBody = options.body !== undefined;
  const request = new Request(url, {
    method,
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await routeLocalChannelBridgeInfraApi({
    request,
    method,
    parts: ["channel-bridge", ...path.split("/")],
    url,
    infra: deps.infra,
    runner: deps.runner,
    feishu: deps.feishu,
    telegram: deps.telegram,
    wechat: deps.wechat,
  });
  return { status: response.status, body: await readJsonBody(response) };
}

function requireEnabled(deps: LocalChannelBridgeDependencies): void {
  if (deps.enabled) return;
  throw new Error(LOCAL_CHANNEL_BRIDGE_UNAVAILABLE);
}

/**
 * The failure a route body carries, if it carries one.
 *
 * A route acknowledges an unbind with `ok: true` even when it removed nothing
 * (`unbound: false`), so the effect decides the verdict here: an unbind that
 * changed nothing is not a success, and saying so is what keeps the browser
 * from showing "已解除绑定" over a client that is still bound.
 */
function mutationFailure(body: Record<string, unknown>): LocalChannelBridgeMutationView {
  const error = readString(body.error);
  const code = readString(body.code);
  const removedNothing = body.unbound === false || body.disconnected === false;
  return {
    ok: body.ok === true && !removedNothing,
    ...(error === undefined
      ? removedNothing
        ? { error: "No IM client was bound under that name." }
        : {}
      : { error }),
    ...(code === undefined ? {} : { code }),
  };
}

function messageFilterView(body: Record<string, unknown>): LocalChannelBridgeMessageFilterView {
  return {
    mode: body.mode === "full" ? "full" : "result",
    includeToolSummary: body.includeToolSummary === true,
  };
}

export function createLocalChannelBridgeSurface(
  deps: LocalChannelBridgeDependencies,
): LocalChannelBridgeSurface {
  return {
    listStatus: async () => {
      requireEnabled(deps);
      const { body } = await forwardRoute(deps, "GET", "status");
      const clients =
        body.clients && typeof body.clients === "object"
          ? (body.clients as Record<string, unknown>)
          : {};
      return {
        clients: Object.entries(clients).flatMap(([name, value]) => {
          if (!value || typeof value !== "object") return [];
          const record = value as Record<string, unknown>;
          const platform = readString(record.platform) ?? platformFromName(name);
          if (platform === undefined) return [];
          const agentName = readString(record.agentName);
          return [{ name, platform, ...(agentName === undefined ? {} : { agentName }) }];
        }),
      };
    },

    connect: async (request) => {
      requireEnabled(deps);
      const { body } = await forwardRoute(deps, "POST", "connect", {
        body: {
          name: request.name,
          ...(request.appId === undefined ? {} : { appId: request.appId }),
          ...(request.appSecret === undefined ? {} : { appSecret: request.appSecret }),
        },
      });
      return mutationFailure(body);
    },

    disconnect: async (request) => {
      requireEnabled(deps);
      const { body } = await forwardRoute(deps, "POST", "disconnect", {
        body: {
          name: request.name,
          clearCredentials: request.clearCredentials === true,
          ...(request.platform === undefined ? {} : { platform: request.platform }),
        },
      });
      return mutationFailure(body);
    },

    checkConfig: async (request) => {
      requireEnabled(deps);
      const { body } = await forwardRoute(deps, "GET", "config-check", {
        query: { agent: request.agent },
      });
      const detail = readString(body.error) ?? readString(body.code);
      return {
        configured: body.configured === true,
        ...(detail === undefined ? {} : { detail }),
      };
    },

    getMessageFilter: async (request) => {
      requireEnabled(deps);
      const { body } = await forwardRoute(deps, "GET", `message-filter/${encodeURIComponent(request.agent)}`);
      return messageFilterView(body);
    },

    updateMessageFilter: async (request) => {
      requireEnabled(deps);
      const { body } = await forwardRoute(
        deps,
        "PUT",
        `message-filter/${encodeURIComponent(request.agent)}`,
        { body: { mode: request.filter.mode, includeToolSummary: request.filter.includeToolSummary } },
      );
      return messageFilterView(body);
    },
  };
}
