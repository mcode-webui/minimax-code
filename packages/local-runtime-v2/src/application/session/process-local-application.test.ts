import { describe, expect, it, vi } from "vitest";

import type { LocalRuntimeApplication } from "./process-local-application-contract.js";
import { createProcessLocalApplication } from "./process-local-application.js";
import { composeProcessLocalApplication } from "./process-local-composition.js";
import { toSessionMessageView } from "./content-application.js";

describe("composeProcessLocalApplication workspace ownership", () => {
  it("routes environment reads and review through the V2 WorkspaceGitService", async () => {
    const workspaceGit = {
      getMetadata: vi.fn(async () => ({ branch: "v2-main" })),
      getChanges: vi.fn(async () => ({ changedFiles: 2 })),
      getReviewSummary: vi.fn(),
      listReviewFileDiffs: vi.fn(),
      getReviewFileContent: vi.fn(),
      searchReviewDiffs: vi.fn(),
    };
    const legacyWorkspaceGit = {
      getMetadata: vi.fn(async () => ({ branch: "legacy-main" })),
      getChanges: vi.fn(async () => ({ changedFiles: 0 })),
    };
    const application = composeProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      usageCommits: undefined,
      workspaceGit: workspaceGit as never,
      compatibility: {
        skills: { listSkills: vi.fn(), listRuntimeSkills: vi.fn() },
        peripherals: { workspace: { git: legacyWorkspaceGit } },
      } as never,
      listRuntimeSkills: vi.fn(),
      plugins: {} as never,
      pluginControl: {} as never,
      miniApp: undefined,
      planEntryEnabled: () => false,
      mcp: {} as never,
      modelProvider: {
        application: {} as never,
        providers: {} as never,
        listProviderPresets: vi.fn(),
        oauth: {} as never,
      },
    });

    expect(application.workspace?.git.getReviewSummary).toBeDefined();
    await expect(application.workspace?.git.getMetadata("/repo")).resolves.toEqual({ branch: "v2-main" });
    await expect(application.workspace?.git.getChanges?.("/repo", "full")).resolves.toEqual({ changedFiles: 2 });
    expect(workspaceGit.getMetadata).toHaveBeenCalledWith("/repo");
    expect(workspaceGit.getChanges).toHaveBeenCalledWith("/repo", "full");
    expect(legacyWorkspaceGit.getMetadata).not.toHaveBeenCalled();
    expect(legacyWorkspaceGit.getChanges).not.toHaveBeenCalled();
    await application.workspace?.git.getReviewSummary?.("/repo", { type: "workspace" });
    expect(workspaceGit.getReviewSummary).toHaveBeenCalledWith("/repo", { type: "workspace" });
  });
});

describe("composeProcessLocalApplication Mini App agent exposure", () => {
  function compose(miniAppAgent: unknown) {
    return composeProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      usageCommits: undefined,
      workspaceGit: {
        getMetadata: vi.fn(),
        getChanges: vi.fn(),
        getReviewSummary: vi.fn(),
        listReviewFileDiffs: vi.fn(),
        getReviewFileContent: vi.fn(),
        searchReviewDiffs: vi.fn(),
      } as never,
      compatibility: {
        skills: { listSkills: vi.fn(), listRuntimeSkills: vi.fn() },
        peripherals: {},
      } as never,
      listRuntimeSkills: vi.fn(),
      plugins: {} as never,
      pluginControl: {} as never,
      miniApp: undefined,
      miniAppAgent: miniAppAgent as never,
      planEntryEnabled: () => false,
      mcp: {} as never,
      modelProvider: {
        application: {} as never,
        providers: {} as never,
        listProviderPresets: vi.fn(),
        oauth: {} as never,
      },
    });
  }

  function gatewayDouble() {
    return {
      bind: vi.fn(),
      registerArena: vi.fn(),
      panelOpened: vi.fn(async () => undefined),
      panelClosed: vi.fn(async () => undefined),
      subscribePermissionAsks: vi.fn(),
      run: vi.fn(async () => ({ sessionId: "s", status: "finished" as const })),
      models: vi.fn(async () => ({ models: [], default: { providerId: "p", modelId: "m" } })),
      agents: vi.fn(async () => ({ agents: [] })),
      session: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ sessionId: "s" })),
      reply: vi.fn(async () => undefined),
      answer: vi.fn(async () => ({ sessionId: "s", status: "finished" as const })),
      open: vi.fn(async () => ({ sessionId: "s", hostSessionId: "chat" })),
    };
  }

  it("publishes the client operations without the gateway or its ports", () => {
    const application = compose(gatewayDouble());

    expect(Object.keys(application.miniAppAgent ?? {}).sort()).toEqual([
      "agents",
      "answer",
      "create",
      "models",
      "open",
      "panelClosed",
      "panelOpened",
      "reply",
      "run",
      "session",
    ]);
    for (const internal of ["bind", "registerArena", "ports", "subscribePermissionAsks"]) {
      expect(application.miniAppAgent).not.toHaveProperty(internal);
    }
    // Nothing else on the facade grew a hole into the gateway.
    expect(JSON.stringify(application)).not.toContain("registerArena");
  });

  it("publishes no agent API when the runtime has no gateway", () => {
    const application = compose(undefined);

    expect(application.miniAppAgent).toBeUndefined();
  });
});

describe("SessionContentApplication history message serialization", () => {
  it("keeps ordered activity parts in the opaque rawJson channel", () => {
    const parts = [
      { id: "think-1", type: "thinking", content: "reasoning" },
      { id: "tool-1", type: "tool_call", tool_call: { name: "bash", status: 1 } },
      { id: "text-1", type: "text", content: "finished" },
    ];
    const view = toSessionMessageView({ msg_id: "history-1", role: "assistant", parts });
    expect(JSON.parse(view.rawJson ?? "{}").parts).toEqual(parts);
  });
});

describe("createProcessLocalApplication account and usage", () => {
  it("uses the recovered model route for account login checks while preserving live token presence", async () => {
    const application = createProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      skills: {} as never,
      plugins: {} as never,
      workspace: {} as never,
      plan: {} as never,
      peripherals: {
        account: {
          getStatus: async () => ({
            selection: {
              providerId: "custom_provider:minimax-legacy-2",
              modelId: "retired",
            },
            provider: {
              id: "custom_provider:minimax-legacy-2",
              authMode: "api-key",
            },
            auth: { tokenPresent: false },
          }),
        },
      } as never,
      modelProvider: {
        application: {
          list: async () => [
            {
              providerId: "minimax",
              modelId: "MiniMax-M3",
              providerKind: "minimax-managed",
              selected: true,
            },
          ],
        } as never,
        providers: { getMinimaxModelSource: () => "token_plan" } as never,
        listProviderPresets: vi.fn(async () => []),
        oauth: { getStatus: vi.fn(), startLogin: vi.fn() } as never,
      },
    });
    await expect(
      application.account?.getStatus({ sessionId: "old-session" }),
    ).resolves.toMatchObject({
      selection: { providerId: "minimax", modelId: "MiniMax-M3" },
      provider: { id: "minimax", authMode: "managed-login" },
      modelSource: "token-plan",
      auth: { tokenPresent: false },
    });
  });
  it("projects committed usage notifications through the process-local boundary", async () => {
    let notify: ((sessionId: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const abortController = new AbortController();
    const application = createProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      usageCommits: {
        subscribe: (listener) => {
          notify = listener;
          return unsubscribe;
        },
      },
      skills: {} as never,
      plugins: {} as never,
      workspace: {} as never,
      plan: {} as never,
      peripherals: { account: { getStatus: vi.fn() } } as never,
      modelProvider: {
        application: {} as never,
        providers: { getMinimaxModelSource: vi.fn() } as never,
      } as never,
    });

    const iterator = application.usage?.watchCommits(abortController.signal);
    const next = iterator?.next();
    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    notify?.("session-1");

    await expect(next).resolves.toEqual({ done: false, value: "session-1" });
    abortController.abort();
    await iterator?.return(undefined);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports the builtin MiniMax API-key route as BYOK account access", async () => {
    const getStatus = vi.fn(async () => ({
      selection: { providerId: "minimax", modelId: "MiniMax-M3" },
      provider: { id: "minimax", authMode: "managed-login" },
      auth: { tokenPresent: false },
    }));
    const getMinimaxModelSource = vi.fn(() => "minimax_api_key" as const);
    const application = createProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      skills: {} as never,
      plugins: {} as never,
      workspace: {} as never,
      plan: {} as never,
      peripherals: { account: { getStatus } } as never,
      modelProvider: {
        application: {} as never,
        providers: { getMinimaxModelSource } as never,
        listProviderPresets: vi.fn(async () => []),
        oauth: { getStatus: vi.fn(), startLogin: vi.fn() } as never,
      },
    });

    await expect(
      application.account?.getStatus({ sessionId: "session-1" }),
    ).resolves.toMatchObject({
      selection: { providerId: "minimax", modelId: "MiniMax-M3" },
      provider: { id: "minimax", authMode: "managed-login" },
      auth: { tokenPresent: false },
      modelSource: "byok",
    });
    expect(getStatus).toHaveBeenCalledWith({ sessionId: "session-1" });
  });
});

describe("createProcessLocalApplication capabilities", () => {
  it("projects the V2 model owner with the other process-local capabilities", async () => {
    const skills = { listSkills: vi.fn(), listRuntimeSkills: vi.fn() };
    const workspace = { git: { getMetadata: vi.fn() } };
    const plugins = {
      refresh: vi.fn(),
      listMarketplacePlugins: vi.fn(),
      listInstalledPlugins: vi.fn(),
      installPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
    };
    const peripherals = {
      mcp: { listLocalMcpServers: vi.fn(), listMcpCapabilities: vi.fn() },
      goals: {
        isEnabled: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
        clear: vi.fn(),
      },
      questionnaires: { getPending: vi.fn(), reply: vi.fn(), dismiss: vi.fn() },
      permissions: { listPending: vi.fn(), reply: vi.fn() },
      account: { getStatus: vi.fn() },
      diagnostics: { getRuntimeSnapshot: vi.fn() },
      configuration: { getPermissionMode: vi.fn(), setPermissionMode: vi.fn() },
    };
    const modelApplication = {
      list: vi.fn(async () => []),
      select: vi.fn(async () => true),
    };
    const modelProviders = {
      listUserProviders: vi.fn(() => []),
      getMinimaxApiKeyStatus: vi.fn(() => ({ hasApiKey: false })),
      getMinimaxModelSource: vi.fn(() => "token_plan" as const),
      setMinimaxModelSource: vi.fn(async () => "minimax_api_key" as const),
      upsertMinimaxApiKey: vi.fn(),
      createUserProvider: vi.fn(),
      discoverUserModelsCandidate: vi.fn(async () => [{ modelId: "latest" }]),
      saveUserModelProviderCandidate: vi.fn(async () => ({
        ok: true,
        provider: { providerId: "custom_provider:openai" },
      })),
      updateUserProvider: vi.fn(),
      testUserModelCandidate: vi.fn(async () => ({ ok: true, status: { state: "available" } })),
      revealModelProviderApiKey: vi.fn(() => "sk-revealed"),
      deleteUserProvider: vi.fn(),
      testProvider: vi.fn(async () => ({
        ok: true,
        status: { state: "available" },
      })),
      testModel: vi.fn(async () => ({
        ok: true,
        status: { state: "available" },
      })),
    };
    const listProviderPresets = vi.fn(async () => [
      {
        providerId: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiFormat: "openai-responses" as const,
        models: [{ modelId: "gpt-5.6", toolCall: true }],
      },
    ]);
    const oauth = {
      cancelLogin: vi.fn(() => ({
        state: "disconnected" as const,
        providerId: "openai-codex" as const,
      })),
      getStatus: vi.fn(() => ({
        state: "disconnected" as const,
        providerId: "openai-codex" as const,
      })),
      startLogin: vi.fn(async () => ({
        state: "pending" as const,
        providerId: "openai-codex" as const,
        authUrl: "https://auth.example",
      })),
      refreshModels: vi.fn(async () => ({ models: [{ modelId: "gpt-5.6" }] })),
    };

    const application = createProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      skills: skills as LocalRuntimeApplication["skills"],
      plugins,
      workspace,
      plan: { isEntryEnabled: vi.fn(() => true) },
      peripherals: peripherals as never,
      modelProvider: {
        application: modelApplication as never,
        providers: modelProviders as never,
        listProviderPresets,
        oauth,
      },
    });

    expect(application).not.toHaveProperty("sessions");
    expect(application.skills).toBeDefined();
    await application.skills.listRuntimeSkills({ workspaceDir: "/repo" });
    expect(skills.listRuntimeSkills).toHaveBeenCalledWith({
      workspaceDir: "/repo",
    });
    expect(application.plugins).toBe(plugins);
    expect(application.workspace).toBe(workspace);
    expect(application.goals).toBe(peripherals.goals);
    expect(application.questionnaires).toBe(peripherals.questionnaires);
    expect(application.plan?.isEntryEnabled()).toBe(true);
    expect(application.permissions).toBe(peripherals.permissions);
    await expect(application.models?.list()).resolves.toEqual([]);
    expect(modelApplication.list).toHaveBeenCalledOnce();
    await expect(
      application.modelProviders?.getMiniMaxModelSource(),
    ).resolves.toBe("token_plan");
    expect(modelProviders.getMinimaxModelSource).toHaveBeenCalledOnce();
    await expect(
      application.modelProviders?.listProviderPresets(),
    ).resolves.toEqual([
      expect.objectContaining({
        providerId: "openai",
        apiFormat: "openai-responses",
      }),
    ]);
    await expect(
      application.modelProviders?.getCodexOAuthStatus(),
    ).resolves.toEqual({
      state: "disconnected",
      providerId: "openai-codex",
    });
    await expect(
      application.modelProviders?.startCodexOAuthLogin({
        method: "device_code",
      }),
    ).resolves.toEqual({
      state: "pending",
      providerId: "openai-codex",
      authUrl: "https://auth.example",
    });
    expect(listProviderPresets).toHaveBeenCalledOnce();
    expect(oauth.getStatus).toHaveBeenCalledOnce();
    expect(oauth.startLogin).toHaveBeenCalledWith({ method: "device_code" });
    await expect(application.modelProviders?.refreshModels()).resolves.toEqual({ models: [{ modelId: "gpt-5.6" }] });
    expect(oauth.refreshModels).toHaveBeenCalledOnce();
    expect(application.modelProviders?.revealModelProviderApiKey({ providerId: "custom_provider:work" })).toBe("sk-revealed");
    expect(modelProviders.revealModelProviderApiKey).toHaveBeenCalledWith({ providerId: "custom_provider:work" });
    await expect(application.modelProviders?.testUserModelCandidate({ candidate: { baseUrl: "https://models.example/v1" }, modelId: "model-1" })).resolves.toMatchObject({ ok: true });
    expect(modelProviders.testUserModelCandidate).toHaveBeenCalledWith({ baseUrl: "https://models.example/v1" }, "model-1");
    await application.modelProviders?.testProvider({ providerId: "custom_provider:work", apiKey: "sk-unsaved" });
    expect(modelProviders.testProvider).toHaveBeenCalledWith("custom_provider:work", { apiKeyOverride: "sk-unsaved" });
    await application.modelProviders?.cancelCodexOAuthLogin("attempt-1");
    expect(oauth.cancelLogin).toHaveBeenCalledWith("attempt-1");
    await expect(
      application.modelProviders?.saveCandidate({
        candidate: {
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          apiFormat: "openai-responses",
          models: [{ modelId: "gpt-5.6", reasoning: true }],
        },
        modelId: "gpt-5.6",
        saveAndUse: true,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(modelProviders.saveUserModelProviderCandidate).toHaveBeenCalledWith({
      candidate: {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        apiFormat: "openai-responses",
        models: [{ modelId: "gpt-5.6", reasoning: true }],
      },
      modelId: "gpt-5.6",
      saveAndUse: true,
    });
    const savedCandidate = {
      providerId: "custom_provider:work",
      expectedRevision: "rev-1",
      baseUrl: "https://models.example/v1",
    };
    await expect(
      application.modelProviders?.discoverCandidate(savedCandidate),
    ).resolves.toEqual([{ modelId: "latest" }]);
    expect(modelProviders.discoverUserModelsCandidate).toHaveBeenCalledWith(
      savedCandidate,
    );
    await application.modelProviders?.saveCandidate({
      candidate: {
        ...savedCandidate,
        models: [{ modelId: "latest", configurationSource: "discovered" }],
      },
      skipConnectionTest: true,
      saveAndUse: false,
    });
    expect(
      modelProviders.saveUserModelProviderCandidate,
    ).toHaveBeenLastCalledWith({
      candidate: {
        ...savedCandidate,
        models: [{ modelId: "latest", configurationSource: "discovered" }],
      },
      skipConnectionTest: true,
      saveAndUse: false,
    });
    expect(application.events.watch).toEqual(expect.any(Function));
  });
});
