// The 接入 IM list owner.
//
// Framework-free — no React, no DOM — so the transitions are testable against a scripted port
// (`packages/webui/AGENTS.md`: no jsdom in this package).
//
// Three facts it has to get right:
//
//   * **An unwired transport is not an empty list.** "This host cannot list IM clients" and "no
//     IM client is bound" are different answers, and only the second one belongs in the empty
//     state.
//   * **A refresh keeps the rows on screen.** A read in flight shows the previous list with its
//     own status, because a panel that blanks out every few seconds is worse than one that is a
//     little stale.
//   * **The message filter is keyed by the IM client's own name.** The runtime stores one filter
//     per client (`mavis` for Feishu, `wechat:mavis` for WeChat), so the selected client's name is
//     what travels in the request the wire names `agent`.
import type {
  WebuiChannelClient,
  WebuiChannelConfigCheckResult,
  WebuiChannelConnectRequest,
  WebuiChannelDisconnectRequest,
  WebuiChannelMessageFilter,
  WebuiChannelMessageFilterRequest,
} from "../../../../shared/contracts/channel.js";
import type { ChannelPort } from "../contracts/channel-port.js";

export type WebuiChannelLoadStatus = "idle" | "loading" | "ready" | "error";

export interface WebuiChannelSnapshot {
  readonly status: WebuiChannelLoadStatus;
  /** The bound IM clients, in the runtime's own order. */
  readonly clients: readonly WebuiChannelClient[];
  /** The client whose detail the pane shows. */
  readonly selectedName?: string;
  /** Present when the last read failed; the rows are then the last good ones. */
  readonly error?: string;
  /** Present when the last mutation failed. */
  readonly actionError?: string;
  /** Whether the selected client's agent has an IM channel configured on this host. */
  readonly config?: WebuiChannelConfigCheckResult;
  /** The selected client's message filter. */
  readonly filter?: WebuiChannelMessageFilter;
  /** Present when the message filter could not be read. */
  readonly filterError?: string;
  readonly loadedAtMs?: number;
}

/**
 * What a mutation answered.
 *
 * A failure is a value, not a thrown error, because the pane's job is to put the reason next to
 * the button that caused it: the runtime's own refusal belongs there, not in a generic error
 * boundary that cannot name it.
 */
export type WebuiChannelMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface WebuiChannelOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WebuiChannelSnapshot;
  /** Reads the bound clients once. Concurrent calls share one request. */
  readonly load: () => Promise<void>;
  /** Re-reads on an interval while the pane is open. Returns the stop function. */
  readonly startRefreshing: () => () => void;
  /** Selects a client and reads what belongs to it. */
  readonly select: (name: string | undefined) => Promise<void>;
  readonly connect: (request: WebuiChannelConnectRequest) => Promise<WebuiChannelMutation>;
  readonly disconnect: (request: WebuiChannelDisconnectRequest) => Promise<WebuiChannelMutation>;
  readonly updateMessageFilter: (
    request: WebuiChannelMessageFilterRequest,
  ) => Promise<WebuiChannelMutation>;
}

export const WEBUI_CHANNEL_UNAVAILABLE =
  "这个运行时无法管理 IM 接入（宿主没有 IM 通道服务）。";
export const WEBUI_CHANNEL_READ_FAILED = "读取 IM 接入列表失败。";
export const WEBUI_CHANNEL_FAILED = "操作 IM 接入失败。";
export const WEBUI_CHANNEL_FILTER_FAILED = "读取消息过滤设置失败。";

export interface CreateWebuiChannelOwnerOptions {
  readonly port: ChannelPort;
  readonly nowMs?: () => number;
  /** How often the open pane re-reads. Five seconds: a bot bound elsewhere shows up. */
  readonly refreshMs?: number;
  readonly setIntervalFn?: (callback: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_REFRESH_MS = 5_000;

export function createWebuiChannelOwner(
  options: CreateWebuiChannelOwnerOptions,
): WebuiChannelOwner {
  const nowMs = options.nowMs ?? Date.now;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms) as unknown);
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as never));

  const listeners = new Set<() => void>();
  let snapshot: WebuiChannelSnapshot = { status: "idle", clients: [] };
  let inFlight: Promise<void> | undefined;

  const publish = (next: WebuiChannelSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const failureMessage = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : WEBUI_CHANNEL_FAILED;

  const load = async (): Promise<void> => {
    if (inFlight) return inFlight;
    const read = options.port.listChannelStatus;
    if (!read) {
      publish({ ...snapshot, status: "error", error: WEBUI_CHANNEL_UNAVAILABLE });
      return;
    }
    publish({ ...snapshot, status: "loading" });
    inFlight = (async () => {
      try {
        const status = await read();
        publish({
          ...snapshot,
          status: "ready",
          clients: status.clients,
          loadedAtMs: nowMs(),
        });
      } catch (error) {
        publish({
          ...snapshot,
          status: "error",
          error: error instanceof Error && error.message ? error.message : WEBUI_CHANNEL_READ_FAILED,
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  /** The selected client, as the last read left it. */
  const selectedClient = (
    current: WebuiChannelSnapshot,
  ): WebuiChannelClient | undefined =>
    current.selectedName === undefined
      ? undefined
      : current.clients.find((client) => client.name === current.selectedName);

  /**
   * Reads what belongs to the selected client.
   *
   * The configuration state is the agent's, and the message filter is the client's own — the
   * runtime stores one filter per IM client, not per agent.
   */
  const loadSelection = async (name: string | undefined): Promise<void> => {
    const client = name === undefined ? undefined : snapshot.clients.find((c) => c.name === name);
    if (!client) {
      publish({ ...snapshot, config: undefined, filter: undefined, filterError: undefined });
      return;
    }
    const checkConfig = options.port.checkChannelConfig;
    const readFilter = options.port.getChannelMessageFilter;
    let config: WebuiChannelConfigCheckResult | undefined;
    let filter: WebuiChannelMessageFilter | undefined;
    let filterError: string | undefined;
    if (checkConfig && client.agentName !== undefined) {
      try {
        config = await checkConfig({ agent: client.agentName });
      } catch (error) {
        config = undefined;
        filterError = failureMessage(error);
      }
    }
    if (readFilter) {
      try {
        filter = await readFilter({ agent: client.name });
      } catch (error) {
        filter = undefined;
        filterError = error instanceof Error && error.message ? error.message : WEBUI_CHANNEL_FILTER_FAILED;
      }
    }
    publish({ ...snapshot, config, filter, filterError });
  };

  const select = async (name: string | undefined): Promise<void> => {
    publish({ ...snapshot, selectedName: name, config: undefined, filter: undefined, filterError: undefined });
    await loadSelection(name);
  };

  /** Runs one mutation, then re-reads the list so the pane shows what the runtime stored. */
  const mutate = async (
    run: (() => Promise<{ readonly success?: boolean; readonly error?: string }>) | undefined,
    refusal: string,
  ): Promise<WebuiChannelMutation> => {
    if (!run) return { ok: false, message: WEBUI_CHANNEL_UNAVAILABLE };
    try {
      const answer = await run();
      if (answer.success === false) {
        const message = answer.error ?? refusal;
        publish({ ...snapshot, actionError: message });
        return { ok: false, message };
      }
      publish({ ...snapshot, actionError: undefined });
      await load();
      return { ok: true };
    } catch (error) {
      const message = failureMessage(error);
      publish({ ...snapshot, actionError: message });
      return { ok: false, message };
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    load,
    startRefreshing: () => {
      const handle = setIntervalFn(() => void load(), refreshMs);
      return () => clearIntervalFn(handle);
    },
    select,
    connect: (request) =>
      mutate(
        options.port.connectChannel
          ? () => options.port.connectChannel!(request)
          : undefined,
        WEBUI_CHANNEL_FAILED,
      ),
    disconnect: (request) =>
      mutate(
        options.port.disconnectChannel
          ? () => options.port.disconnectChannel!(request)
          : undefined,
        WEBUI_CHANNEL_FAILED,
      ),
    updateMessageFilter: async (request) => {
      const write = options.port.updateChannelMessageFilter;
      if (!write) return { ok: false, message: WEBUI_CHANNEL_UNAVAILABLE };
      try {
        const filter = await write(request);
        publish({ ...snapshot, filter, filterError: undefined, actionError: undefined });
        return { ok: true };
      } catch (error) {
        const message = failureMessage(error);
        publish({ ...snapshot, actionError: message });
        return { ok: false, message };
      }
    },
  };
}
