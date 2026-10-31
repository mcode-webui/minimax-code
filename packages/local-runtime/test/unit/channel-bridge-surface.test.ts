/**
 * The runtime's public IM channel-bridge surface.
 *
 * One claim, and it is the one that matters for the WebUI's 接入 IM tab: the surface forwards to
 * the channel-bridge routes the runtime already serves, and it does not re-implement any of them.
 * The proof is that the route answers come back unchanged — the clients the status route reports,
 * the filter the store holds, the refusal a bind route sends — and that a host without the
 * channel service refuses every call instead of answering an empty list.
 *
 * Only the runtime's leaves are scripted here: the dispatcher, the platform adapters and the
 * stores are the real ones.
 */
import { describe, expect, it } from "vitest";

import { createLocalChannelBridgeSurface } from "../../src/api/channel-bridge-surface.js";
import type { LocalChannelBridgeInfra } from "../../src/channels/infra.js";

/** The runtime's channel-bridge infrastructure, with only the leaves scripted. */
function infraStub(overrides: Record<string, unknown> = {}): LocalChannelBridgeInfra {
  return {
    status: async () => ({ clients: {}, localRuntime: true }),
    bindingStore: {
      list: async () => [],
      getMessageFilter: async () => ({ mode: "result", includeToolSummary: false }),
      setMessageFilter: async (_key: string, filter: unknown) => filter,
    },
    routeResolver: { resolveLegacy: async () => ({ blocked: true }) },
    resolveAgentReadScope: async (name: string) => ({
      canonicalName: name,
      compatibleNames: [name],
    }),
    resolveAgentWriteTarget: async (name: string) => name,
    reportResourceAmbiguity: () => undefined,
    ...overrides,
  } as unknown as LocalChannelBridgeInfra;
}

/** One platform adapter, with only the leaves the route under test touches scripted. */
function feishuStub(overrides: Record<string, unknown> = {}) {
  return {
    statusClients: async () => ({
      mavis: { ok: true, platform: "feishu", clientId: "mavis", agentName: "mavis", connected: true },
    }),
    configCheck: async (agentName?: string) => ({
      configured: agentName === "mavis",
      source: "local-runtime",
      hasCredentials: true,
      platform: "feishu",
      clientId: agentName ?? "mavis",
      localRuntime: true,
    }),
    bindBody: async (body: Record<string, unknown>) => ({
      record: { agentName: "mavis", clientId: String(body.name ?? "mavis") },
    }),
    hasBindingBody: async () => true,
    unbindBody: async () =>
      new Response(JSON.stringify({ ok: true, unbound: true, disconnected: true }), {
        headers: { "content-type": "application/json" },
      }),
    ...overrides,
  } as never;
}

describe("the runtime's channel-bridge surface", () => {
  it("reports the clients the status route reports", async () => {
    const surface = createLocalChannelBridgeSurface({
      infra: infraStub(),
      feishu: feishuStub(),
      enabled: true,
    });

    expect(await surface.listStatus()).toEqual({
      clients: [{ name: "mavis", platform: "feishu", agentName: "mavis" }],
    });
  });

  it("answers the configuration check the route answers", async () => {
    const surface = createLocalChannelBridgeSurface({
      infra: infraStub(),
      feishu: feishuStub(),
      enabled: true,
    });

    expect(await surface.checkConfig({ agent: "mavis" })).toEqual({ configured: true });
    expect(await surface.checkConfig({ agent: "nobody" })).toEqual({ configured: false });
  });

  it("reads and writes the message filter the store holds", async () => {
    const written: Array<{ key: string; filter: unknown }> = [];
    const surface = createLocalChannelBridgeSurface({
      infra: infraStub({
        bindingStore: {
          getMessageFilter: async (key: string) => ({ key }),
          setMessageFilter: async (key: string, filter: unknown) => {
            written.push({ key, filter });
            return filter;
          },
        },
      }),
      enabled: true,
    });

    expect(await surface.getMessageFilter({ agent: "mavis" })).toEqual({
      mode: "result",
      includeToolSummary: false,
    });
    expect(
      await surface.updateMessageFilter({
        agent: "mavis",
        filter: { mode: "full", includeToolSummary: true },
      }),
    ).toEqual({ mode: "full", includeToolSummary: true });
    expect(written).toEqual([
      { key: "mavis", filter: { mode: "full", includeToolSummary: true } },
    ]);
  });

  it("forwards a bind and reports the route's own refusal", async () => {
    const surface = createLocalChannelBridgeSurface({
      infra: infraStub(),
      feishu: feishuStub({
        bindBody: async () => ({
          error: new Response(JSON.stringify({ ok: false, error: "no", code: "NOPE" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        }),
      }),
      enabled: true,
    });

    expect(await surface.connect({ name: "mavis", appId: "cli_x", appSecret: "secret" })).toEqual({
      ok: false,
      error: "no",
      code: "NOPE",
    });
  });

  it("reports an unbind that removed nothing as a failure, not a success", async () => {
    const surface = createLocalChannelBridgeSurface({
      infra: infraStub(),
      feishu: feishuStub({
        unbindBody: async () =>
          new Response(JSON.stringify({ ok: true, unbound: false, disconnected: false }), {
            headers: { "content-type": "application/json" },
          }),
      }),
      enabled: true,
    });

    const outcome = await surface.disconnect({ name: "mavis", clearCredentials: true });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("No IM client was bound");
  });

  it("refuses every call when the host carries no channel service", async () => {
    const surface = createLocalChannelBridgeSurface({ infra: infraStub(), enabled: false });

    await expect(surface.listStatus()).rejects.toThrow(/channel service is not available/);
    await expect(surface.connect({ name: "mavis" })).rejects.toThrow(
      /channel service is not available/,
    );
    await expect(surface.disconnect({ name: "mavis" })).rejects.toThrow(
      /channel service is not available/,
    );
    await expect(surface.checkConfig({ agent: "mavis" })).rejects.toThrow(
      /channel service is not available/,
    );
    await expect(surface.getMessageFilter({ agent: "mavis" })).rejects.toThrow(
      /channel service is not available/,
    );
    await expect(
      surface.updateMessageFilter({
        agent: "mavis",
        filter: { mode: "result", includeToolSummary: false },
      }),
    ).rejects.toThrow(/channel service is not available/);
  });
});
