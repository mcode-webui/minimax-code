/**
 * The Models-owned provider editor.
 *
 * What these cases cover: opening/editing/testing/saving/deleting from the
 * editor's own interface without React, the header semantics a saved provider
 * carries, a changed candidate after a successful test, late reveal/discovery/
 * test/save completions, and disposal clearing the credential-bearing fields.
 */
import { describe, expect, it } from "vitest";

import {
  createWebuiProviderEditor,
  type WebuiProviderEditor,
  type WebuiProviderEditorCommands,
} from "../../src/client/features/models/application/provider-editor.js";
import type {
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "../../src/shared/contracts/models.js";
import type {
  WebuiProviderSaveOutcome,
  WebuiProviderTestOutcome,
} from "../../src/client/features/models/contracts/provider-outcome.js";

/** Add a model row and give it an id — what the form's "添加模型" does. */
function addModel(editor: WebuiProviderEditor, modelId: string): string {
  editor.addModel();
  const snapshot = editor.getSnapshot();
  const row = snapshot.models[snapshot.models.length - 1];
  if (!row) throw new Error("the editor added no model row");
  editor.changeModel(row.id, { modelId });
  return row.id;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const savedProvider = (overrides: Partial<WebuiModelProviderView> = {}): WebuiModelProviderView => ({
  providerId: "p1",
  name: "mine",
  source: "custom",
  kind: "custom",
  enabled: true,
  baseUrl: "https://example.test/v1",
  apiFormat: "openai-completions",
  hasApiKey: true,
  maskedApiKey: "sk-****abcd",
  headerNames: ["X-A"],
  configRevision: "rev-9",
  models: [
    {
      providerId: "p1",
      modelId: "m1",
      modelConfigId: "m1",
      displayName: "m1",
      enabled: true,
      selected: false,
    },
  ],
  ...overrides,
});

interface Harness {
  readonly commands: WebuiProviderEditorCommands;
  readonly calls: {
    reveal: string[];
    test: WebuiTestUserModelCandidateRequest[];
    save: WebuiSaveUserModelProviderCandidateRequest[];
    discover: WebuiDiscoverUserModelsCandidateRequest[];
    update: WebuiUpdateUserModelProviderRequest[];
    remove: string[];
  };
}

function harness(overrides: Partial<WebuiProviderEditorCommands> = {}): Harness {
  const calls = {
    reveal: [] as string[],
    test: [] as WebuiTestUserModelCandidateRequest[],
    save: [] as WebuiSaveUserModelProviderCandidateRequest[],
    discover: [] as WebuiDiscoverUserModelsCandidateRequest[],
    update: [] as WebuiUpdateUserModelProviderRequest[],
    remove: [] as string[],
  };
  const commands: WebuiProviderEditorCommands = {
    canManageProviders: true,
    revealApiKey: async (providerId) => {
      calls.reveal.push(providerId);
      return "sk-revealed";
    },
    createProvider: async () => ({ ok: true }),
    updateProvider: async (body) => {
      calls.update.push(body);
      return { ok: true };
    },
    deleteProvider: async (providerId) => {
      calls.remove.push(providerId);
      return { ok: true };
    },
    // The commands answer with the typed outcome the Models owner decodes, so
    // these fixtures state the outcome rather than a raw result record — which is
    // the whole point: an editor that could not tell success from a refusal is
    // no longer expressible.
    discoverCandidate: async (body) => {
      calls.discover.push(body);
      return { outcome: "success", models: [] };
    },
    saveCandidate: async (body) => {
      calls.save.push(body);
      return { outcome: "success" };
    },
    testCandidate: async (body) => {
      calls.test.push(body);
      return { outcome: "success", models: [] };
    },
    ...overrides,
  };
  return { commands, calls };
}

describe("opening a draft", () => {
  it("starts a new provider blank, with no identity and no revision", () => {
    const { commands } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    const snapshot = editor.getSnapshot();
    expect(snapshot.open).toBe(true);
    expect(snapshot.editingProviderId).toBeUndefined();
    expect(snapshot.configRevision).toBeUndefined();
    // Discovery is offered on a new provider too — the runtime's create branch
    // asks the endpoint with the key the provider would be created with.
    expect(snapshot.canDiscover).toBe(true);
    expect(snapshot.baseUrl).toBe("");
    expect(snapshot.apiFormat).toBe("openai-completions");
    expect(snapshot.tested).toBe(false);
  });

  it("opens a saved provider with its revision, names-only header rows and revealed key", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider());
    const snapshot = editor.getSnapshot();
    expect(calls.reveal).toEqual(["p1"]);
    expect(snapshot.editingProviderId).toBe("p1");
    expect(snapshot.configRevision).toBe("rev-9");
    expect(snapshot.canDiscover).toBe(true);
    expect(snapshot.apiKey).toBe("sk-revealed");
    expect(snapshot.models.map((model) => model.modelId)).toEqual(["m1"]);
    // A saved row is a blank value carrying its persisted name: untouched, it
    // means "keep the stored value".
    expect(snapshot.headers).toEqual([
      { id: "p1-0", name: "X-A", value: "", persistedName: "X-A" },
    ]);
  });

  it("reports a failed reveal without leaving the form unusable", async () => {
    const { commands } = harness({
      revealApiKey: async () => Promise.reject(new Error("denied")),
    });
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider());
    const snapshot = editor.getSnapshot();
    expect(snapshot.error).toBe("denied");
    expect(snapshot.busy).toBe(false);
    expect(snapshot.open).toBe(true);
  });
});

describe("test validity", () => {
  it("marks the draft tested and clears it on the next edit", async () => {
    const { commands } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    addModel(editor, "m1");
    await editor.test();
    expect(editor.getSnapshot().tested).toBe(true);
    editor.changeField("baseUrl", "https://other.test");
    expect(editor.getSnapshot().tested).toBe(false);
  });

  it("cannot mark a newer draft tested with an older test's answer", async () => {
    const gate = deferred<WebuiProviderTestOutcome>();
    const { commands } = harness({ testCandidate: () => gate.promise });
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    addModel(editor, "m1");
    const pending = editor.test();
    // The user edits while the probe is in flight: the answer describes the
    // candidate that no longer exists.
    editor.changeField("baseUrl", "https://changed.test");
    gate.resolve({ outcome: "success", models: [] });
    await pending;
    expect(editor.getSnapshot().tested).toBe(false);
  });

  it("reads the producer's refusal shape", async () => {
    const { commands } = harness({
      testCandidate: async () => ({
        outcome: "refusal",
        code: "harness_error",
        message: "bad key",
      }),
    });
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    addModel(editor, "m1");
    await editor.test();
    expect(editor.getSnapshot().error).toBe("bad key");
    expect(editor.getSnapshot().tested).toBe(false);
  });

  it("does nothing without a model id", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    await editor.test();
    expect(calls.test).toEqual([]);
  });
});

describe("saving", () => {
  it("refuses until the draft is proven or the test is skipped", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    addModel(editor, "m1");
    await editor.save();
    expect(calls.save).toEqual([]);
    editor.setSkipConnectionTest(true);
    await editor.save();
    expect(calls.save).toHaveLength(1);
  });

  it("writes the saved provider's identity, revision and header removals", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider({ headerNames: ["X-A", "X-B"] }));
    // Drop X-B, replace X-A's value.
    editor.setHeaders([
      { id: "p1-0", name: "X-A", value: "new", persistedName: "X-A" },
    ]);
    editor.setSkipConnectionTest(true);
    await editor.save();
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0]?.candidate).toMatchObject({
      providerId: "p1",
      expectedRevision: "rev-9",
      baseUrl: "https://example.test/v1",
      headers: { "X-A": "new" },
      removeHeaders: ["X-B"],
    });
  });

  it("closes the form on success and stays open with an error on refusal", async () => {
    const refused = harness({
      saveCandidate: async () => ({ outcome: "refusal", code: "harness_error", message: "保存失败" }),
    });
    const failing = createWebuiProviderEditor({ commands: refused.commands });
    failing.openNew();
    failing.changeField("baseUrl", "https://example.test");
    failing.setSkipConnectionTest(true);
    await failing.save();
    expect(failing.getSnapshot().open).toBe(true);
    expect(failing.getSnapshot().error).toBe("保存失败");

    const accepted = harness();
    const saving = createWebuiProviderEditor({ commands: accepted.commands });
    saving.openNew();
    saving.changeField("baseUrl", "https://example.test");
    saving.setSkipConnectionTest(true);
    await saving.save();
    expect(saving.getSnapshot().open).toBe(false);
    expect(saving.getSnapshot().error).toBeUndefined();
  });

  it("refuses a draft whose header rows are invalid", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider());
    editor.setHeaders([{ id: "p1-0", name: "X-Renamed", value: "", persistedName: "X-A" }]);
    editor.setSkipConnectionTest(true);
    await editor.save();
    expect(calls.save).toEqual([]);
    expect(editor.getSnapshot().error).toBe("新增 Header 必须填写值");
  });
});

describe("the model rows", () => {
  it("carries each model's own limits, levels and attachments in the candidate", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    const id = addModel(editor, "m1");
    editor.changeModel(id, {
      contextLimit: "128000",
      maxOutputTokens: "8000",
      effortOptions: ["low", "high"],
      modalities: ["image"],
    });
    editor.setSkipConnectionTest(true);
    await editor.save();
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0]?.candidate.models).toEqual([
      {
        modelId: "m1",
        displayName: "m1",
        limit: { context: 128000, output: 8000 },
        effortOptions: ["low", "high"],
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    ]);
  });

  it("seeds a saved provider's models with what they were stored with", async () => {
    const { commands } = harness();
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(
      savedProvider({
        models: [
          {
            providerId: "p1",
            modelId: "m1",
            modelConfigId: "m1",
            displayName: "M One",
            enabled: true,
            selected: false,
            contextLimit: 128000,
            maxOutputTokens: 8000,
            effortOptions: ["low", "high"],
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        ],
      }),
    );
    expect(editor.getSnapshot().models[0]).toMatchObject({
      modelId: "m1",
      displayName: "M One",
      contextLimit: "128000",
      maxOutputTokens: "8000",
      effortOptions: ["low", "high"],
      modalities: ["image"],
    });
  });

  it("leaves a limit out when the field is not a positive number", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    const id = addModel(editor, "m1");
    editor.changeModel(id, { contextLimit: "abc", maxOutputTokens: "0" });
    editor.setSkipConnectionTest(true);
    await editor.save();
    expect(calls.save[0]?.candidate.models?.[0]).not.toHaveProperty("limit");
  });

  it("adds and removes model rows", () => {
    const { commands } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    expect(editor.getSnapshot().models).toEqual([]);
    editor.addModel();
    const row = editor.getSnapshot().models[0];
    expect(row).toBeDefined();
    editor.removeModel(row!.id);
    expect(editor.getSnapshot().models).toEqual([]);
  });

  it("reports a failed probe on the row that failed", async () => {
    const { commands } = harness({
      testCandidate: async () => ({
        outcome: "refusal",
        code: "harness_error",
        message: "bad key",
      }),
    });
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    const id = addModel(editor, "m1");
    await editor.testModel(id);
    expect(editor.getSnapshot().models[0]?.error).toBe("bad key");
    expect(editor.getSnapshot().tested).toBe(false);
  });

  it("probes every row that carries an id", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    addModel(editor, "m1");
    addModel(editor, "m2");
    await editor.test();
    expect(calls.test.map((call) => call.modelId)).toEqual(["m1", "m2"]);
    expect(editor.getSnapshot().tested).toBe(true);
  });
});

describe("discovery", () => {
  it("needs the saved revision and sends it", async () => {
    const discovered: WebuiDiscoverUserModelsCandidateRequest[] = [];
    const { commands } = harness({
      discoverCandidate: async (body) => {
        discovered.push(body);
        return {
          outcome: "success",
          models: [{ modelId: "m1" }, { modelId: "m2" }],
        };
      },
    });
    const editor = createWebuiProviderEditor({ commands });
    await editor.openNew();
    await editor.discover();
    expect(discovered).toEqual([]);

    await editor.openExisting(savedProvider());
    await editor.discover();
    expect(discovered).toEqual([
      { providerId: "p1", expectedRevision: "rev-9", baseUrl: "https://example.test/v1" },
    ]);
    // The discovered ids replace the draft's list and the draft is unproven again.
    expect(editor.getSnapshot().models.map((model) => model.modelId)).toEqual(["m1", "m2"]);
    expect(editor.getSnapshot().tested).toBe(false);
  });
});

describe("the form view's lifetime", () => {
  it("closing ends the view, keeps the draft and fences a late save", async () => {
    const gate = deferred<WebuiProviderSaveOutcome>();
    const { commands } = harness({ saveCandidate: () => gate.promise });
    const editor = createWebuiProviderEditor({ commands });
    editor.openNew();
    editor.changeField("baseUrl", "https://example.test");
    editor.setSkipConnectionTest(true);
    const pending = editor.save();
    editor.close();
    expect(editor.getSnapshot().open).toBe(false);
    expect(editor.getSnapshot().pending).toBeUndefined();
    gate.resolve({ outcome: "success", providerId: "p-new" });
    await pending;
    // The late completion neither reopens the form nor repopulates an error.
    expect(editor.getSnapshot().open).toBe(false);
    expect(editor.getSnapshot().error).toBeUndefined();
    expect(editor.getSnapshot().baseUrl).toBe("https://example.test");
  });

  it("disposal clears the credential-bearing fields and stops publishing", async () => {
    const { commands, calls } = harness();
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider());
    let notifications = 0;
    editor.subscribe(() => {
      notifications += 1;
    });
    editor.dispose();
    expect(notifications).toBe(0);
    editor.changeField("apiKey", "sk-typed-after-dispose");
    expect(editor.getSnapshot().apiKey).toBe("");
    expect(calls.update).toEqual([]);
  });

  it("deletes through the commands and reports a refusal", async () => {
    const removed: string[] = [];
    const { commands } = harness({
      deleteProvider: async (providerId) => {
        removed.push(providerId);
        return Promise.reject(new Error("in use"));
      },
    });
    const editor = createWebuiProviderEditor({ commands });
    await editor.openExisting(savedProvider());
    await editor.remove();
    expect(removed).toEqual(["p1"]);
    expect(editor.getSnapshot().error).toBe("in use");
  });
});
