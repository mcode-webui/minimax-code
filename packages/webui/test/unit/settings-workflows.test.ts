// Unit tests for the settings workflow owner.
//
// The owner is framework-free, so these run the real decision logic the
// settings dialog delegates to: that a superseded read is dropped rather than
// applied over a newer one, and that a successful write invalidates exactly the
// caches it affects.
//
// The catalogue, the selection and the provider list are `models`' owner, so
// their cases live in `models-workflows.test.ts`.

import { describe, expect, it } from "vitest";

import { createWebuiSettingsWorkflows } from "../../src/client/features/settings/application/settings-workflows.js";
import { createWebuiIdentityEpochs } from "../../src/client/application/identity-epochs.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
} from "../../src/shared/contracts/personalization.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const instructions = (content: string): WebuiGlobalInstructionsView => ({
  content,
  exists: true,
  path: "/data/AGENTS.md",
  maxBytes: 32 * 1024,
});

describe("the settings owner discards a superseded read", () => {
  it("keeps the newest instructions answer when an older one lands later", async () => {
    // The invalidation here is a write, which is what retires an answer in
    // production. Two concurrent reads of the same key now share one request
    // instead of racing, so "an older answer lands later" is reached the way it
    // actually happens: a write lands between the request and its answer.
    let resolveFirst: (value: WebuiGlobalInstructionsView) => void = () => undefined;
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getGlobalInstructions: () =>
          new Promise<WebuiGlobalInstructionsView>((resolve) => {
            resolveFirst = resolve;
          }),
        setGlobalInstructions: ({ content }) => Promise.resolve(instructions(content)),
      },
      identityEpochs: createWebuiIdentityEpochs(),
    });

    void workflows.loadInstructions();
    await workflows.saveInstructions("second");
    resolveFirst(instructions("first"));
    await flush();

    expect(workflows.getSnapshot().instructions.value?.content).toBe("second");
  });

  it("records an unavailable capability as one error, not a silent empty", async () => {
    const workflows = createWebuiSettingsWorkflows({ port: {} });
    await workflows.loadInstructions();
    expect(workflows.getSnapshot().instructions).toEqual({
      status: "error",
      error: "当前运行时不支持自定义指令读写。",
    });
  });
});

describe("a settings write invalidates exactly what it affects", () => {
  it("refreshes the cached read and bumps the revision on save", async () => {
    let stored = "old";
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getGlobalInstructions: async () => instructions(stored),
        setGlobalInstructions: async ({ content }) => {
          stored = content;
          return instructions(content);
        },
      },
    });

    await workflows.loadInstructions();
    expect(workflows.getSnapshot().instructions.value?.content).toBe("old");
    const before = workflows.getSnapshot().revision;

    await workflows.saveInstructions("new");
    expect(workflows.getSnapshot().instructions.value?.content).toBe("new");
    expect(workflows.getSnapshot().revision).toBe(before + 1);
  });

  it("surfaces a write against an unwired capability as an error", async () => {
    const workflows = createWebuiSettingsWorkflows({ port: {} });
    await expect(workflows.saveInstructions("x")).rejects.toThrow(
      "当前运行时不支持自定义指令读写。",
    );
  });
});

describe("the memory summary and the memory body are two request identities", () => {
  const memory = (content: string | undefined): WebuiAgentMemoryView => ({
    agentName: "mavis",
    path: "/data/agents/mavis/memory/MEMORY.md",
    exists: content !== undefined,
    sizeBytes: content?.length ?? 0,
    ...(content === undefined ? {} : { content }),
  });

  it("settles an overlapping pair in either order without confusing the two", async () => {
    let releaseSummary: (value: WebuiAgentMemoryView) => void = () => undefined;
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getAgentMemory: (request) =>
          request?.includeContent === true
            ? Promise.resolve(memory("# body"))
            : new Promise<WebuiAgentMemoryView>((resolve) => {
                releaseSummary = resolve;
              }),
      },
    });

    // The summary is still in flight when the body read settles.
    const summary = workflows.loadAgentMemory();
    const content = await workflows.loadAgentMemory(true);
    expect(content.status).toBe("ready");

    releaseSummary(memory(undefined));
    expect((await summary).status).toBe("ready");

    // Each snapshot field holds its own answer: the summary is not the body.
    expect(workflows.getSnapshot().agentMemorySummary.value?.content).toBeUndefined();
    expect(workflows.getSnapshot().agentMemoryContent.value?.content).toBe("# body");
  });

  it("reports each request's own outcome rather than one shared status", async () => {
    let releaseContent: (value: WebuiAgentMemoryView) => void = () => undefined;
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getAgentMemory: (request) =>
          request?.includeContent === true
            ? new Promise<WebuiAgentMemoryView>((resolve) => {
                releaseContent = resolve;
              })
            : Promise.resolve(memory(undefined)),
      },
    });

    const pending = workflows.loadAgentMemory(true);
    const summary = await workflows.loadAgentMemory();
    expect(summary.status).toBe("ready");
    // The body has not answered yet, and that is visible as *pending* rather
    // than as the summary's answer leaking across into a second field.
    expect(workflows.getSnapshot().agentMemoryContent.status).toBe("loading");
    expect(workflows.getSnapshot().agentMemoryContent.value).toBeUndefined();

    releaseContent(memory("# body"));
    expect((await pending).status).toBe("ready");
  });

  it("reports a superseded read distinctly rather than as an empty answer", async () => {
    let releaseFirst: (value: WebuiAgentMemoryView) => void = () => undefined;
    let call = 0;
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getAgentMemory: () => {
          call += 1;
          if (call === 1) {
            return new Promise<WebuiAgentMemoryView>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve(memory("# newer"));
        },
        setAgentMemory: () => Promise.resolve(memory("# written")),
      },
      identityEpochs: createWebuiIdentityEpochs(),
    });

    const first = workflows.loadAgentMemory(true);
    // A write retires the configuration answers, so the in-flight read is refused
    // and says so — it does not resolve as though it had found nothing.
    await workflows.saveAgentMemory("# written");
    releaseFirst(memory("# older"));

    expect((await first).status).toBe("superseded");
  });

  it("reports a read issued after disposal instead of hanging", async () => {
    const workflows = createWebuiSettingsWorkflows({
      port: { getAgentMemory: () => Promise.resolve(memory(undefined)) },
    });
    workflows.dispose();
    // "Never answers" has to be distinguishable from "answers empty": disposal
    // is the answer, and the transport is never reached.
    expect((await workflows.loadAgentMemory()).status).toBe("disposed");
  });

  it("reports an unwired capability as this request's failure, not an idle field", async () => {
    const workflows = createWebuiSettingsWorkflows({ port: {} });
    const outcome = await workflows.loadAgentMemory();
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error instanceof Error && outcome.error.message).toBe(
      "当前运行时不支持长期记忆读写。",
    );
  });
});

describe("a settings read reports its own request outcome", () => {
  it("carries the value a caller needs without re-reading the snapshot", async () => {
    const workflows = createWebuiSettingsWorkflows({
      port: { getGlobalInstructions: () => Promise.resolve(instructions("hello")) },
    });
    const outcome = await workflows.loadInstructions();
    // The caller gets the value from the outcome; the snapshot is what a surface
    // renders, not how this request discovers what it received.
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("unreachable");
    expect(outcome.value.content).toBe("hello");
  });

  it("shares one request between concurrent reads of the same key", async () => {
    let release: (value: WebuiGlobalInstructionsView) => void = () => undefined;
    let calls = 0;
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getGlobalInstructions: () => {
          calls += 1;
          return new Promise<WebuiGlobalInstructionsView>((resolve) => {
            release = resolve;
          });
        },
      },
    });

    // Two surfaces opening the same read is one request, and both receive the
    // same answer — which is what makes the outcome reportable at all.
    const first = workflows.loadInstructions();
    const second = workflows.loadInstructions();
    release(instructions("shared"));

    expect(await first).toBe(await second);
    expect(calls).toBe(1);
    expect(workflows.getSnapshot().instructions.value?.content).toBe("shared");
  });

  it("surfaces a read failure as this request's error", async () => {
    const workflows = createWebuiSettingsWorkflows({
      port: {
        getGlobalInstructions: () => Promise.reject(new Error("运行时拒绝了这次读取")),
      },
    });
    const outcome = await workflows.loadInstructions();
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error instanceof Error && outcome.error.message).toBe(
      "运行时拒绝了这次读取",
    );
  });
});

