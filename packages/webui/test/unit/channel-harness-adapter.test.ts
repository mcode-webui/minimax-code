/**
 * The 接入 IM cell of the harness port.
 *
 * Two claims, both about the boundary rather than about the channel bridge:
 *
 *   * the runtime's channel-bridge answers convert into the WebUI's own wire DTOs — every required
 *     field read or failed on, every optional field elided rather than emitted as `undefined`, and
 *     a refusal reported as the runtime's own code;
 *   * a host that carries no channel bridge answers with one `capability_unavailable` refusal
 *     instead of an empty client list that reads as "no IM client is bound".
 *
 * The real adapter and the real conversions run here; only the host leaves are scripted.
 */
import { describe, expect, it } from "vitest";

import {
  createChannelAdapter,
  type WebuiRuntimeChannelBridge,
} from "../../src/runtime/harness/channel.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";

type ChannelPort = Pick<
  WebuiHarnessPort,
  | "listChannelStatus"
  | "connectChannel"
  | "disconnectChannel"
  | "checkChannelConfig"
  | "getChannelMessageFilter"
  | "updateChannelMessageFilter"
>;

/** The runtime's channel-bridge surface, as the host hands it over. */
function bridgeStub(overrides: Partial<WebuiRuntimeChannelBridge> = {}): WebuiRuntimeChannelBridge {
  return {
    listStatus: async () => ({ clients: [] }),
    connect: async () => ({ ok: true }),
    disconnect: async () => ({ ok: true }),
    checkConfig: async () => ({ configured: true }),
    getMessageFilter: async () => ({ mode: "result", includeToolSummary: false }),
    updateMessageFilter: async () => ({ mode: "result", includeToolSummary: false }),
    ...overrides,
  };
}

/** A host that publishes the bridge the way the runtime host does: on the api host. */
function adapterWith(bridge: WebuiRuntimeChannelBridge): ChannelPort {
  return createChannelAdapter({
    apiHost: { close: async () => {}, channelBridge: bridge } as never,
  });
}

/** Settles a refusal: an `Error`'s `message` is not an own enumerable property, so read it. */
async function refusal(call: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error = (await call().catch((reason: unknown) => reason)) as {
    code?: string;
    message?: string;
  };
  return { ...(error.code === undefined ? {} : { code: error.code }), message: error.message ?? "" };
}

describe("the 接入 IM adapter", () => {
  it("converts the runtime's clients into the wire clients", async () => {
    const port = adapterWith(
      bridgeStub({
        listStatus: async () => ({
          clients: [
            { name: "mavis", platform: "feishu", agentName: "mavis" },
            { name: "wechat:mavis", platform: "wechat" },
          ],
        }),
      }),
    );

    const status = await port.listChannelStatus();

    expect(status).toEqual({
      clients: [
        { name: "mavis", platform: "feishu", agentName: "mavis" },
        // The agent the runtime did not report is elided, not emitted as `undefined`.
        { name: "wechat:mavis", platform: "wechat" },
      ],
    });
  });

  it("fails on a client the runtime could not name", async () => {
    const port = adapterWith(
      bridgeStub({
        listStatus: async () => ({
          clients: [{ name: "", platform: "feishu" }],
        }),
      }),
    );

    const failure = await refusal(() => port.listChannelStatus());

    expect(failure.message).toContain("client.name");
  });

  it("fails on a status that carries no client list at all", async () => {
    const port = adapterWith(
      bridgeStub({
        listStatus: async () => ({ clients: undefined }) as never,
      }),
    );

    const failure = await refusal(() => port.listChannelStatus());

    expect(failure.message).toContain("clients");
  });

  it("forwards the bind and reports the runtime's own verdict", async () => {
    const seen: unknown[] = [];
    const port = adapterWith(
      bridgeStub({
        connect: async (request) => {
          seen.push(request);
          return { ok: false, error: "Local channel platform runner is not implemented." , code: "LOCAL_CHANNEL_RUNNER_UNAVAILABLE" };
        },
      }),
    );

    const result = await port.connectChannel({
      name: "mavis",
      appId: "cli_x",
      appSecret: "secret",
    });

    expect(seen).toEqual([{ name: "mavis", appId: "cli_x", appSecret: "secret" }]);
    expect(result).toEqual({
      success: false,
      error: "LOCAL_CHANNEL_RUNNER_UNAVAILABLE: Local channel platform runner is not implemented.",
    });
  });

  it("forwards the unbind with the platform the client carries", async () => {
    const seen: unknown[] = [];
    const port = adapterWith(
      bridgeStub({
        disconnect: async (request) => {
          seen.push(request);
          return { ok: true };
        },
      }),
    );

    const result = await port.disconnectChannel({
      name: "wechat:mavis",
      clearCredentials: true,
      platform: "wechat",
    });

    expect(seen).toEqual([{ name: "wechat:mavis", clearCredentials: true, platform: "wechat" }]);
    expect(result).toEqual({ success: true });
  });

  it("converts the per-agent configuration state", async () => {
    const port = adapterWith(
      bridgeStub({
        checkConfig: async () => ({ configured: false, detail: "Channel config for feishu is ambiguous" }),
      }),
    );

    expect(await port.checkChannelConfig({ agent: "mavis" })).toEqual({
      configured: false,
      detail: "Channel config for feishu is ambiguous",
    });
  });

  it("converts the message filter and fails on a mode the wire does not declare", async () => {
    const port = adapterWith(
      bridgeStub({
        getMessageFilter: async () => ({ mode: "full", includeToolSummary: true }),
        updateMessageFilter: async () => ({ mode: "nonsense", includeToolSummary: false }),
      }),
    );

    expect(await port.getChannelMessageFilter({ agent: "wechat:mavis" })).toEqual({
      mode: "full",
      includeToolSummary: true,
    });
    const failure = await refusal(() =>
      port.updateChannelMessageFilter({
        agent: "wechat:mavis",
        filter: { mode: "result", includeToolSummary: false },
      }),
    );
    expect(failure.message).toContain("filter.mode");
  });

  it("refuses every member once, when the host carries no channel bridge", async () => {
    const port = createChannelAdapter({ apiHost: { close: async () => {} } });

    const failure = await refusal(() => port.listChannelStatus());

    expect(failure.code).toBe("capability_unavailable");
    expect(failure.message).toBe("runtime host does not expose the channel bridge");
  });

  it("reads the bridge from a host slot as well as from the api host", async () => {
    const port = createChannelAdapter({
      apiHost: { close: async () => {} },
      channelBridge: bridgeStub({
        listStatus: async () => ({ clients: [{ name: "mavis", platform: "feishu" }] }),
      }),
    } as never);

    expect(await port.listChannelStatus()).toEqual({
      clients: [{ name: "mavis", platform: "feishu" }],
    });
  });

  it("forwards a host that already carries the six members", async () => {
    // `host-contract.ts` declares the slot for a host that answers the 接入 IM members itself;
    // the adapter forwards those as they are.
    const port = createChannelAdapter({
      apiHost: { close: async () => {} },
      listChannelStatus: async () => ({ clients: [{ name: "mavis", platform: "feishu" }] }),
      connectChannel: async () => ({ success: true }),
      disconnectChannel: async () => ({ success: true }),
      checkChannelConfig: async () => ({ configured: true }),
      getChannelMessageFilter: async () => ({ mode: "result", includeToolSummary: false }),
      updateChannelMessageFilter: async () => ({ mode: "full", includeToolSummary: true }),
    } as never);

    expect(await port.listChannelStatus()).toEqual({
      clients: [{ name: "mavis", platform: "feishu" }],
    });
    expect(
      await port.updateChannelMessageFilter({
        agent: "mavis",
        filter: { mode: "full", includeToolSummary: true },
      }),
    ).toEqual({ mode: "full", includeToolSummary: true });
  });
});
