import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createAgentRunner } from "../../src/runtime/design/agent-runner.mjs";

type UploadEvidence = { readonly mime: string; readonly filename: string; readonly magic: string };
const uploads: UploadEvidence[] = [];
let uploadPort = 0;
let uploadServer: ReturnType<typeof createServer>;
const cleanup: string[] = [];

beforeAll(async () => {
  uploadServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = await new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "content-type": String(request.headers["content-type"] ?? "") },
      body: Buffer.concat(chunks),
    }).formData();
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const bytes = Buffer.from(await file.arrayBuffer());
      uploads.push({
        mime: file.type,
        filename: file.name,
        magic: bytes.subarray(0, 8).toString("hex"),
      });
    }
    response.writeHead(200);
    response.end();
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
  const address = uploadServer.address();
  if (!address || typeof address === "string") throw new Error("upload server did not bind");
  uploadPort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
});

afterEach(async () => {
  uploads.splice(0);
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function runnerFor() {
  const base = join(homedir(), ".cache/minimax-code-test-artifacts/design-media-kind");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  cleanup.push(directory);
  await mkdir(join(directory, "uploads"), { recursive: true });
  let uploadCounter = 0;
  const described: string[] = [];
  const videoUnderstood: string[] = [];
  const audioUnderstood: string[] = [];
  const agentRun = vi.fn(async () => ({
    sessionId: "synthetic",
    status: "finished" as const,
    text: "synthetic result",
  }));
  const hostConnector = {
    list: vi.fn(async () => ({
      tools: [
        { toolRef: "upload", name: "matrix_upload_temp_url", inputSchema: { type: "object" } },
        { toolRef: "describe", name: "matrix_describe_images", inputSchema: { type: "object" } },
        { toolRef: "video", name: "matrix_videos_understand", inputSchema: { type: "object" } },
        { toolRef: "audio", name: "matrix_audios_understand", inputSchema: { type: "object" } },
      ],
      providerFailures: [],
      partial: false,
    })),
    call: vi.fn(async (reference: string, input: Readonly<Record<string, unknown>>) => {
      if (reference === "upload") {
        uploadCounter += 1;
        return {
          value: {
            upload_host: `http://127.0.0.1:${uploadPort}/upload`,
            temp_url: `https://example.invalid/upload/${uploadCounter}`,
            fields: {},
          },
        };
      }
      if (reference === "describe") {
        const info = (input as { readonly image_info?: readonly { readonly url?: string }[] }).image_info;
        described.push(String(info?.[0]?.url ?? ""));
        return { value: { results: [{ success: true, description: "image understood" }] } };
      }
      if (reference === "video") {
        const info = (input as { readonly video_info?: readonly { readonly url?: string }[] }).video_info;
        videoUnderstood.push(String(info?.[0]?.url ?? ""));
        return { value: { results: [{ success: true, description: "video understood" }] } };
      }
      if (reference === "audio") {
        const info = (input as { readonly audio_info?: readonly { readonly url?: string }[] }).audio_info;
        audioUnderstood.push(String(info?.[0]?.url ?? ""));
        return { value: { results: [{ success: true, description: "audio understood" }] } };
      }
      throw new Error(`unexpected connector ${reference}`);
    }),
  };
  const runner = createAgentRunner({
    dataDir: directory,
    signal: new AbortController().signal,
    agent: {
      models: async () => ({ models: [], default: { providerId: "synthetic", modelId: "text" } }),
      run: agentRun,
      reply: async () => ({}),
      answer: async () => ({ sessionId: "synthetic", status: "finished" as const }),
    },
    hostConnector,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { runner, directory, agentRun, described, videoUnderstood, audioUnderstood };
}

function spec(nodeMode: "describe" | "video2text" | "generate", mediaUrl: string, kind: "image" | "video" | "audio") {
  return {
    documentId: "board",
    nodeId: `target-${kind}`,
    nodeType: "text",
    nodeTitle: kind,
    mode: "text",
    nodeMode,
    prompt: "read the material",
    references: [{ id: kind, title: kind, kind, role: "input", media: [{ url: mediaUrl, kind }] }],
    params: {},
    frames: [],
    segments: [],
    executionId: `x_${kind}`,
    inputFingerprint: `fp_${kind}`,
    capabilitySelection: { tools: [] },
  };
}

async function terminal(runner: ReturnType<typeof createAgentRunner>, id: string) {
  for (let count = 0; count < 300; count += 1) {
    const task = runner.get(id);
    if (task && !["running", "waiting-question", "queued"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("media kind run did not settle");
}

describe("media kind preparation", () => {
  it("keeps a local image an image and never turns it into an MP4", async () => {
    const { runner, directory, described, videoUnderstood } = await runnerFor();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(directory, "uploads", "sample.png"), png);
    const task = await runner.startRun(spec("describe", "/design-assets/uploads/sample.png", "image"));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("done");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ mime: "image/png" });
    expect(uploads[0]?.magic.startsWith("89504e47")).toBe(true);
    expect(described).toEqual(["https://example.invalid/upload/1"]);
    expect(videoUnderstood).toEqual([]);
    expect(uploads.some((upload) => upload.mime.includes("mp4"))).toBe(false);
  });

  it("rejects audio on a text mode whose declared limit is zero instead of preparing it as video", async () => {
    const { runner, directory, described, videoUnderstood, audioUnderstood } = await runnerFor();
    const source = join(directory, "uploads", "sample.wav");
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "pcm_s16le",
      source,
    ], { stdio: "pipe" });
    const task = await runner.startRun(spec("generate", "/design-assets/uploads/sample.wav", "audio"));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("error");
    expect(settled.errorCode).toBe("INVALID_ARGUMENTS");
    expect(settled.error).toMatch(/音频|超过上限/u);
    expect(uploads).toHaveLength(0);
    expect(audioUnderstood).toEqual([]);
    expect(described).toEqual([]);
    expect(videoUnderstood).toEqual([]);
  });

  it("keeps video frame shrinking for video and sends the compressed video to video understanding", async () => {
    const { runner, directory, described, videoUnderstood } = await runnerFor();
    const source = join(directory, "uploads", "sample.mp4");
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=60:duration=2",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      source,
    ], { stdio: "pipe" });
    const task = await runner.startRun(spec("video2text", "/design-assets/uploads/sample.mp4", "video"));
    const settled = await terminal(runner, task.id);
    expect(settled.status).toBe("done");
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    expect(uploads.every((upload) => upload.mime === "video/mp4")).toBe(true);
    expect(described).toEqual([]);
    expect(videoUnderstood).toHaveLength(1);
    expect(videoUnderstood[0]).not.toBe("https://example.invalid/upload/1");
    expect(videoUnderstood[0]).toMatch(/^https:\/\/example\.invalid\/upload\/[2-9]\d*$/u);
  });
});
