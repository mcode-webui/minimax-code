import { describe, expect, it, vi } from "vitest";
import { Registry, type TurnAssemblyCtx, type ToolExecutionContext } from "@mavis/agent-runtime";
import { createNativeDesignControlExtension } from "../../../src/application/agent/design-control-extension.js";
import { createNativeDesignExecution } from "../../../src/application/agent/native-design-execution.js";
import { HostConnectorGateway } from "../../../src/service/host-connector-system/gateway.js";
import { narrowProfile } from "../../../src/service/turn-system/agent-host/preparation/config/local-agent-config-builder.js";
import type { LocalAgentExecutionProfile } from "../../../src/service/turn-system/index.js";
import type { NativeDesignExecution } from "../../../src/local/design-host-contract.js";

function context(profile: Readonly<Record<string, unknown>> = {}): TurnAssemblyCtx {
  return { sessionId: "session", turnId: "turn", agentName: "mavis", workspaceDir: "/synthetic/design", agentConfig: { capability_ceiling: { personaEnabled: true, features: { mavis: true, delegation: true, webSearch: true } }, agent_profile: { trusted_builtin: true, canonical_view_name: "mavis", surface: "interactive", ...profile } }, model: { provider: "synthetic", id: "synthetic", contextWindow: 100000 }, history: [], userInput: { text: "design" } };
}
describe("registered native Design tool", () => {
  it("uses existing per-turn selector and exposes read-only child/verifier variants", async () => {
    const execute = vi.fn(async () => ({ authoritative: true }));
    const registry = new Registry();
    await registry.initExtensions([createNativeDesignControlExtension({ executionWorkspaceDir: "/synthetic/design", execute })]);
    expect((await registry.assembleTurn(context())).tools.map((tool) => tool.def.name)).toContain("design");
    expect((await registry.assembleTurn(context({ config_selection: { tools: [] } }))).tools).toHaveLength(0);
    expect((await registry.assembleTurn(context({ config_selection: { disallowedTools: ["DeSiGn"] } }))).tools).toHaveLength(0);
    expect((await registry.assembleTurn(context({ config_selection: { tools: ["design"] } }))).tools).toHaveLength(1);
    for (const profile of [{ surface: "task-child" }, { canonical_view_name: "verifier" }, { canonical_view_name: "explore" }]) {
      const tool = (await registry.assembleTurn(context(profile))).tools[0];
      const result = await tool.impl.execute({ sessionId: "session", turnId: "turn" } as ToolExecutionContext, { action: "open" });
      expect(result.isError).toBe(true); expect(result.text).toContain("DESIGN_READ_ONLY");
      await tool.impl.execute({ sessionId: "session", turnId: "turn" } as ToolExecutionContext, { action: "read" });
    }
    expect(execute).toHaveBeenCalledTimes(3);
    const aborted = new AbortController(); aborted.abort();
    const tool = (await registry.assembleTurn(context())).tools[0];
    expect((await tool.impl.execute({ sessionId: "session", turnId: "turn" } as ToolExecutionContext, { action: "open" }, aborted.signal)).isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("retains opaque grant handles, value envelopes, auth fences and renewable native generations", async () => {
    let credentials: { accessToken?: string; realUserID?: string; authState: "authenticated" | "logged_out" } = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" };
    const audits: unknown[] = [];
    const call = vi.fn(async ({ onDispatch }: { onDispatch: () => void }) => { onDispatch(); return { resultJson: JSON.stringify({ node_id: "synthetic-output" }) }; });
    const gateway = new HostConnectorGateway({ credentialGetter: () => credentials, audit: { record: (event) => { audits.push(event); } }, client: { listConnectedTools: async () => ({ tools: [{ provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' }], providerFailures: [], partial: false }), callTool: call } });
    const native = createNativeDesignExecution({} as NativeDesignExecution["agent"], gateway, "synthetic-desktop");
    try {
      const first = await native.hostConnector.list(); const reference = first.tools[0].toolRef;
      expect(await native.hostConnector.call(reference, {})).toEqual({ value: { node_id: "synthetic-output" } });
      expect(audits).toContainEqual(expect.objectContaining({ callerKind: "native-client", clientId: "synthetic-desktop" }));
      credentials = { authState: "logged_out" }; gateway.authContextChanged();
      credentials = { accessToken: "synthetic-refreshed", realUserID: "synthetic-user", authState: "authenticated" }; gateway.authContextChanged();
      const renewed = await native.hostConnector.list(); expect(renewed.tools).toHaveLength(1);
      await expect(native.hostConnector.call(reference, {})).rejects.toMatchObject({ code: "TOOL_REF_STALE" });
      expect(call).toHaveBeenCalledTimes(1);
      expect(await native.hostConnector.call(renewed.tools[0].toolRef, {})).toEqual({ value: { node_id: "synthetic-output" } });
    } finally { await native.close(); await gateway.close(); }
  });

  it("keeps a tool reference valid across ordinary and concurrent inventory refreshes", async () => {
    const credentials = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" as const };
    const call = vi.fn(async ({ onDispatch }: { onDispatch: () => void }) => { onDispatch(); return { resultJson: JSON.stringify({ ok: true }) }; });
    const gateway = new HostConnectorGateway({
      credentialGetter: () => credentials,
      client: {
        listConnectedTools: async () => ({ tools: [{ provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' }], providerFailures: [], partial: false }),
        callTool: call,
      },
    });
    const native = createNativeDesignExecution({} as NativeDesignExecution["agent"], gateway);
    try {
      const first = await native.hostConnector.list();
      const reference = first.tools[0].toolRef;
      const second = await native.hostConnector.list();
      expect(second.tools[0].toolRef).toBe(reference);
      const [concurrentA, concurrentB] = await Promise.all([native.hostConnector.list(), native.hostConnector.list()]);
      expect(concurrentA.tools[0].toolRef).toBe(reference);
      expect(concurrentB.tools[0].toolRef).toBe(reference);
      expect(await native.hostConnector.call(reference, {})).toEqual({ value: { ok: true } });
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await native.close(); await gateway.close(); }
  });

  it("keeps image, video, audio and music references after a shared inventory refresh", async () => {
    const credentials = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" as const };
    const calls: string[] = [];
    const names = ["generate_image", "submit_video_generation", "synthesize_speech", "batch_text_to_music"];
    const gateway = new HostConnectorGateway({
      credentialGetter: () => credentials,
      client: {
        listConnectedTools: async () => ({ tools: names.map((name) => ({ provider: "matrix", providerToolName: name, runtimeToolName: `matrix_${name}`, inputSchemaJson: '{"type":"object"}' })), providerFailures: [], partial: false }),
        callTool: async ({ providerToolName, onDispatch }) => { onDispatch(); calls.push(providerToolName); return { resultJson: JSON.stringify({ tool: providerToolName }) }; },
      },
    });
    const native = createNativeDesignExecution({} as NativeDesignExecution["agent"], gateway);
    try {
      const first = await native.hostConnector.list();
      const references = new Map(first.tools.map((tool) => [tool.name.replace(/^matrix_/u, ""), tool.toolRef]));
      await native.hostConnector.list();
      for (const [name, reference] of references) {
        const second = await native.hostConnector.list();
        expect(second.tools.find((tool) => tool.name === `matrix_${name}`)?.toolRef).toBe(reference);
        expect(await native.hostConnector.call(reference, { prompt: "synthetic" })).toEqual({ value: { tool: name } });
      }
      expect(calls).toEqual(names);
    } finally { await native.close(); await gateway.close(); }
  });

  it("never turns a post-dispatch identity fence into an automatically retryable stale reference", async () => {
    let credentials: { accessToken?: string; realUserID?: string; authState: "authenticated" | "logged_out" } = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" };
    let gateway: HostConnectorGateway;
    const call = vi.fn(async ({ onDispatch }: { onDispatch: () => void }) => { onDispatch(); credentials = { authState: "logged_out" }; gateway.authContextChanged(); return { resultJson: '{"already_created":true}' }; });
    gateway = new HostConnectorGateway({ credentialGetter: () => credentials, client: { listConnectedTools: async () => ({ tools: [{ provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' }], providerFailures: [], partial: false }), callTool: call } });
    const native = createNativeDesignExecution({} as NativeDesignExecution["agent"], gateway);
    try { const inventory = await native.hostConnector.list(); await expect(native.hostConnector.call(inventory.tools[0].toolRef, {})).rejects.toMatchObject({ code: "CONNECTOR_OUTCOME_UNKNOWN", outcome: "unknown_after_dispatch" }); expect(call).toHaveBeenCalledTimes(1); }
    finally { await native.close(); await gateway.close(); }
  });

  it("narrows a session profile with the trusted per-turn selection instead of trusting a prompt", () => {
    const profile = {
      configSelection: { tools: ["read", "bash", "design"], disallowedTools: ["write"] },
      capabilityCeiling: {
        personaEnabled: true,
        features: { mavis: true, delegation: true, webSearch: true },
      },
      requestRef: "agent:mavis",
      resourceReadRef: "mavis",
      exactOwnerName: "mavis",
      canonicalViewName: "mavis",
      resolvedAgentName: "mavis",
      agentRole: "main",
      creationSource: "builtin",
      surface: "interactive",
      memoryReadAgentNames: [],
      corePrompt: "",
      surfacePrompt: "",
      provenance: { source: "builtin", assetAgentName: "mavis", locale: "en" },
    } as unknown as LocalAgentExecutionProfile;
    const narrowed = narrowProfile(profile, {
      tools: ["read", "design"],
      disallowedTools: ["bash"],
    });
    expect(narrowed?.configSelection).toMatchObject({
      tools: ["read", "design"],
      disallowedTools: ["write", "bash"],
    });
    expect(narrowProfile(profile, { tools: [] })?.configSelection?.tools).toEqual([]);
  });

  it("preserves provider failures and the partial inventory instead of returning an empty all-or-nothing list", async () => {
    const credentials = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" as const };
    const gateway = new HostConnectorGateway({
      credentialGetter: () => credentials,
      client: {
        listConnectedTools: async () => ({
          tools: [{ provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' }],
          providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE", message: "synthetic failure", retryable: true }],
          partial: true,
        }),
        callTool: async () => ({ resultJson: "{}" }),
      },
    });
    const native = createNativeDesignExecution({} as NativeDesignExecution["agent"], gateway);
    try {
      const inventory = await native.hostConnector.list();
      expect(inventory.tools).toHaveLength(1);
      expect(inventory.partial).toBe(true);
      expect(inventory.providerFailures).toEqual([{ provider: "other", code: "PROVIDER_UNAVAILABLE", retryable: true }]);
    } finally { await native.close(); await gateway.close(); }
  });
});
