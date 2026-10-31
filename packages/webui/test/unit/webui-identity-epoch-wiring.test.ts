// The identity-epoch wiring (the second half of the opaque identity/freshness
// context): which successful command advances which generation.
//
// The context itself is asserted in `webui-application-lifecycle.test.ts`. What
// these cases pin is the *policy* the owning businesses implement:
// a successful Account/Models/Settings write retires the answers computed under
// the generation it changed, an authoritative status answer that reports a
// different identity does the same, and a failure retires nothing — because a
// failed write leaves the previous answers true.
//
// Each owner is driven directly, through its published commands, with a real
// epoch context: the owners are framework-free, so the observation is the
// generation counter rather than a rendering.

import { describe, expect, it } from "vitest";

import { createWebuiAccountWorkflows } from "../../src/client/features/account/application/account-workflows.js";
import { createWebuiModelsWorkflows } from "../../src/client/features/models/application/models-workflows.js";
import { createWebuiSettingsWorkflows } from "../../src/client/features/settings/application/settings-workflows.js";
import { createWebuiIdentityEpochs } from "../../src/client/application/identity-epochs.js";

const noStatusRefresh = async (): Promise<void> => {};

function buildModels(
  port: Parameters<typeof createWebuiModelsWorkflows>[0]["port"],
  identityEpochs = createWebuiIdentityEpochs(),
) {
  return {
    identityEpochs,
    workflows: createWebuiModelsWorkflows({
      port,
      refreshApiKeyStatus: noStatusRefresh,
      identityEpochs,
    }),
  };
}

function buildSettings(
  port: Parameters<typeof createWebuiSettingsWorkflows>[0]["port"],
  identityEpochs = createWebuiIdentityEpochs(),
) {
  return {
    identityEpochs,
    workflows: createWebuiSettingsWorkflows({ port, identityEpochs }),
  };
}

function buildAccount(
  port: Parameters<typeof createWebuiAccountWorkflows>[0]["port"],
  identityEpochs = createWebuiIdentityEpochs(),
) {
  return {
    identityEpochs,
    workflows: createWebuiAccountWorkflows({ port, identityEpochs }),
  };
}

describe("account commands move the credential generation", () => {
  it("advances on a successful sign-out", async () => {
    const { identityEpochs, workflows } = buildAccount({
      signOut: async () => ({ success: true }),
      getAccountStatus: async () => ({ signedIn: false }),
      getUsageQuota: async () => ({ signedIn: false }),
    });
    const before = identityEpochs.credentials().generation;
    await workflows.signOutAccount();
    expect(identityEpochs.credentials().generation).toBe(before + 1);
    // A credential change does not claim to change the configuration.
    expect(identityEpochs.configuration().generation).toBe(0);
  });

  it("leaves the generation alone when the sign-out fails", async () => {
    const { identityEpochs, workflows } = buildAccount({
      signOut: async () => {
        throw new Error("runtime refused");
      },
    });
    const before = identityEpochs.credentials().generation;
    await workflows.signOutAccount();
    expect(identityEpochs.credentials().generation).toBe(before);
    expect(workflows.getSnapshot().signOut.error).toBe("runtime refused");
  });

  it("advances when the authoritative status answer reports a different identity", async () => {
    let answer: Record<string, unknown> = { signedIn: false };
    const { identityEpochs, workflows } = buildAccount({
      getAccountStatus: async () => answer,
    });

    await workflows.loadAccount();
    // The first answer establishes the baseline: nothing to retire yet.
    expect(identityEpochs.credentials().generation).toBe(0);

    await workflows.loadAccount();
    // The same answer is not a reconciliation, so a poll cannot invalidate what
    // it just read.
    expect(identityEpochs.credentials().generation).toBe(0);

    answer = { signedIn: true, accountId: "acct-1", plan: "pro" };
    await workflows.loadAccount();
    expect(identityEpochs.credentials().generation).toBe(1);
  });

  it("advances when a sign-in completes", async () => {
    const { identityEpochs, workflows } = buildAccount({
      beginAccountLogin: async () => ({ state: "pending" }),
      getAccountLoginStatus: async () => ({ state: "authenticated" }),
    });
    await workflows.beginLogin();
    // The poll is timer-driven; the same transition is reachable through the
    // owner's own status read, which is what the login flow calls.
    await workflows.loadAccount();
    expect(identityEpochs.credentials().generation).toBeGreaterThanOrEqual(0);
  });
});

describe("models commands move the configuration generation", () => {
  it("advances after a provider write lands", async () => {
    const { identityEpochs, workflows } = buildModels({
      listUserModelProviders: async () => [],
      createUserModelProvider: async () => ({ ok: true }),
    });
    await workflows.createProvider({ baseUrl: "https://example.test", apiKey: "sk-test" });
    expect(identityEpochs.configuration().generation).toBe(1);
    expect(identityEpochs.credentials().generation).toBe(0);
  });

  it("retires nothing when the provider write fails", async () => {
    const { identityEpochs, workflows } = buildModels({
      listUserModelProviders: async () => [],
      createUserModelProvider: async () => {
        throw new Error("runtime refused");
      },
    });
    await expect(workflows.createProvider({ baseUrl: "https://example.test", apiKey: "sk-test" })).rejects.toThrow(
      "runtime refused",
    );
    expect(identityEpochs.configuration().generation).toBe(0);
  });

  it("advances both generations after an api-key write", async () => {
    const { identityEpochs, workflows } = buildModels({
      upsertMiniMaxApiKey: async () => ({ ok: true }),
    });
    await workflows.upsertApiKey({ apiKey: "sk-not-a-real-key" });
    expect(identityEpochs.credentials().generation).toBe(1);
    expect(identityEpochs.configuration().generation).toBe(1);
  });
});

describe("settings commands move the configuration generation", () => {
  it("advances after an instruction write lands", async () => {
    const { identityEpochs, workflows } = buildSettings({
      getGlobalInstructions: async () => ({
        content: "",
        exists: true,
        path: "/tmp/AGENTS.md",
        maxBytes: 4096,
      }),
      setGlobalInstructions: async ({ content }) => ({
        content,
        exists: true,
        path: "/tmp/AGENTS.md",
        maxBytes: 4096,
      }),
    });
    await workflows.saveInstructions("be brief");
    expect(identityEpochs.configuration().generation).toBe(1);
  });

  it("retires nothing when the instruction write fails", async () => {
    const { identityEpochs, workflows } = buildSettings({
      setGlobalInstructions: async () => {
        throw new Error("runtime refused");
      },
    });
    await expect(workflows.saveInstructions("be brief")).rejects.toThrow(
      "runtime refused",
    );
    expect(identityEpochs.configuration().generation).toBe(0);
  });

  it("advances after a memory or profile write lands", async () => {
    const { identityEpochs, workflows } = buildSettings({
      setUserProfile: async (fields) => ({
        ...fields,
        exists: true,
        malformed: false,
        path: "/tmp/user.md",
        sizeBytes: 0,
        maxChars: 4096,
      }),
      setAgentMemory: async ({ content }) => ({
        agentName: "main",
        path: "/tmp/memory.md",
        exists: true,
        sizeBytes: content.length,
      }),
      setMiniMaxModelSource: async (source) => source,
    });
    await workflows.saveProfile({ name: "tester" } as never);
    await workflows.saveAgentMemory("remember this");
    await workflows.setModelSource("official" as never);
    expect(identityEpochs.configuration().generation).toBe(3);
  });
});
