import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRunner } from "../../src/runtime/design/agent-runner.mjs";

type AgentResult = {
  readonly sessionId?: string;
  readonly status: "finished" | "error" | "aborted";
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function context(
  descriptions: Record<string, string>,
  agentResult: AgentResult = {
    sessionId: "synthetic",
    status: "finished",
    text: "synthetic text result",
  },
) {
  const base = join(homedir(), ".cache/minimax-code-test-artifacts/design-text-material");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  cleanup.push(directory);
  const agent = {
    models: vi.fn(async () => ({ models: [], default: { providerId: "synthetic", modelId: "text" } })),
    run: vi.fn(async (_input: { text?: string; capabilitySelection?: unknown }) => agentResult),
    reply: vi.fn(async () => ({})),
    answer: vi.fn(async () => ({ sessionId: "synthetic", status: "finished" as const, text: "synthetic answer" })),
  };
  const hostConnector = {
    list: vi.fn(async () => ({
      tools: [{ toolRef: "describe", name: "matrix_describe_images", inputSchema: { type: "object" } }],
      providerFailures: [],
      partial: false,
    })),
    call: vi.fn(async (_ref: string, input: Readonly<Record<string, unknown>>) => {
      const info = (input.image_info ?? input.video_info ?? input.audio_info) as
        | readonly { readonly url?: string }[]
        | undefined;
      const url = String(info?.[0]?.url ?? "");
      return { value: { results: [{ success: true, description: descriptions[url] ?? `description for ${url}` }] } };
    }),
  };
  const runner = createAgentRunner({
    dataDir: directory,
    signal: new AbortController().signal,
    agent,
    hostConnector,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { runner, agent, hostConnector, directory };
}

function spec(references: readonly Record<string, unknown>[], prompt = "写出一段能复刻这张图的提示词") {
  return {
    documentId: "board",
    nodeId: "target",
    nodeType: "text",
    nodeTitle: "反推提示词",
    mode: "text",
    nodeMode: "generate",
    prompt,
    references,
    params: {},
    frames: [],
    segments: [],
    executionId: "x_synthetic",
    inputFingerprint: "fp_synthetic",
    capabilitySelection: { tools: [] },
  };
}

async function terminal(runner: ReturnType<typeof createAgentRunner>, id: string) {
  for (let count = 0; count < 200; count += 1) {
    const task = runner.get(id);
    if (task && !["running", "waiting-question", "queued"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("text material run did not settle");
}

describe("text node material context", () => {
  it("sends the understood content of a connected image, not only its URL", async () => {
    const url = "https://example.invalid/reference.png";
    const { runner, agent } = await context({ [url]: "一只橘猫坐在窗台上，午后侧光" });
    const task = await runner.startRun(spec([{ id: "upstream", title: "参考图", kind: "image", role: "input", media: [{ url, kind: "image" }] }]));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("done");
    const input = agent.run.mock.calls[0]?.[0] as { text?: string; capabilitySelection?: unknown };
    expect(input.text).toContain("一只橘猫坐在窗台上");
    expect(input.text).toContain("节点 upstream");
    expect(input.text).toContain(url);
    expect(input.capabilitySelection).toEqual({ tools: [] });
  });

  it("reads every upstream image and every mention, not only the first", async () => {
    const first = "https://example.invalid/first.png";
    const second = "https://example.invalid/second.png";
    const { runner, agent } = await context({
      [first]: "第一张图的内容",
      [second]: "第二张图的内容",
    });
    const task = await runner.startRun(spec([
      { id: "upstream-1", title: "第一张", kind: "image", role: "input", media: [{ url: first, kind: "image" }] },
      { id: "upstream-2", title: "第二张", kind: "image", role: "input", media: [{ url: second, kind: "image" }] },
    ]));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("done");
    const input = agent.run.mock.calls[0]?.[0] as { text?: string };
    expect(input.text).toContain("第一张图的内容");
    expect(input.text).toContain("第二张图的内容");
    expect(input.text).toContain("节点 upstream-1");
    expect(input.text).toContain("节点 upstream-2");
  });

  it("preserves the native {code,message} error DTO instead of turning it into '未知错误'", async () => {
    const { runner } = await context(
      {},
      {
        sessionId: "synthetic",
        status: "error",
        error: { code: "MODEL_UNAVAILABLE", message: "Synthetic provider is offline" },
      },
    );
    const task = await runner.startRun(spec([]));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("error");
    expect(settled.error).toContain("Synthetic provider is offline");
    expect(settled.errorCode).toBe("MODEL_UNAVAILABLE");
  });

  it("rejects more media than the mode's declared limit instead of reading part of it", async () => {
    const { runner, agent } = await context({});
    const media = Array.from({ length: 25 }, (_, index) => ({
      url: `https://example.invalid/${index}.png`,
      kind: "image",
    }));
    const task = await runner.startRun(spec([{ id: "many", title: "many", kind: "image", role: "input", media }]));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("error");
    expect(settled.errorCode).toBe("INVALID_ARGUMENTS");
    expect(settled.error).toMatch(/超过上限|最多/u);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("refuses an empty connected material before calling the model", async () => {
    const { runner, agent } = await context({});
    await expect(
      runner.startRun(spec([{ id: "empty", title: "空图", kind: "image", role: "input", media: [] }])),
    ).rejects.toMatchObject({ code: "MATERIAL_REQUIRED" });
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("reports a material whose local file disappeared in the task instead of continuing with a URL", async () => {
    const { runner, agent } = await context({});
    const task = await runner.startRun(spec([{ id: "gone", title: "丢失的图", kind: "image", role: "input", media: [{ url: "/design-assets/uploads/not-real.png", kind: "image" }] }]));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("error");
    expect(settled.error).toContain("素材文件已经不在了");
    expect(settled.errorCode).toBe("MEDIA_MISSING");
    expect(agent.run).not.toHaveBeenCalled();
  });
});
