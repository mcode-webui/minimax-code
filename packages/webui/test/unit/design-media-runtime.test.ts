import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWebuiDesignService } from "../../src/runtime/design/design-service.js";
import type { DesignMedia, DesignNode, DesignState } from "../../src/shared/contracts/design.js";
import { DesignMedia as DesignMediaView } from "../../src/client/features/design/ui/DesignMedia.js";
import { DesignClipPanel } from "../../src/client/features/design/ui/DesignClipPanel.js";
import { wirePlayhead } from "../../src/client/features/design/bindings/clip-playhead.mjs";
import { wirePreviewLoop } from "../../src/client/features/design/bindings/preview-loop.mjs";
import { waveformPeaks, frameStops } from "../../src/client/features/design/bindings/strip.mjs";
import { DesignTaskPanel } from "../../src/client/features/design/ui/DesignTaskPanel.js";
import { DesignQuestionnaire } from "../../src/client/features/design/ui/DesignQuestionnaire.js";
import { designQuestionSteps, designQuestionError, designSkippedAnswers } from "../../src/client/features/design/projection/design-questionnaire.js";
import { panelClosed, panelTasks } from "../../src/shared/design/run-watch.mjs";

it("persists bounded video posters outside the visible library, fences stale sources and protects document/draft references during GC", async () => {
  const scratch = process.env.WEBUI_DESIGN_TEST_ROOT ?? path.join(homedir(), ".cache/minimax-code-test-artifacts/design");
  await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(path.join(scratch, "posters-")), run = promisify(execFile);
  const video = path.join(directory, "source.mp4"), red = path.join(directory, "red.jpg"), blue = path.join(directory, "blue.jpg");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:s=64x48:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", video]);
  for (const [color, file] of [["red", red], ["blue", blue]]) await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=${color}:s=64x48`, "-frames:v", "1", "-threads", "1", file]);
  const service = await createWebuiDesignService(directory);
  try {
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "video" } }); const nodeId = state.document!.nodes[0].id;
    const uploaded = await service.apply({ documentId: id, action: { type: "upload", name: "source.mp4", kind: "video", base64: (await readFile(video)).toString("base64") } }); const source = uploaded.result as DesignMedia;
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { media: [source], status: "success" } } } });
    const apply = (base64: string, sourceUrl = source.url) => service.apply({ documentId: id, action: { type: "set_media_poster", nodeId, sourceUrl, base64 } });
    state = await apply((await readFile(red)).toString("base64")); const first = String(state.document!.nodes[0].metadata.output.posterUrl), revision = state.document!.updatedAt;
    expect(first).toMatch(/^\/design-assets\/assets\/thumb_[a-f0-9]{64}\.jpg$/); expect(state.committedRevision).toBe(revision); expect(state.library.some((asset) => asset.url === first)).toBe(false);
    expect((await service.readAsset({ kind: "assets", name: first.split("/").pop()! }))!.bytes.byteLength).toBe((await readFile(red)).byteLength);
    state = await apply((await readFile(red)).toString("base64")); expect(state.document!.updatedAt).toBe(revision); expect(state.committedRevision).toBe(revision);
    const base = state.document!;
    state = await service.apply({ documentId: id, action: { type: "save_draft", baseDocument: base, document: { ...base, title: "Draft keeps old poster" } } }); const draftRevision = state.draft!.revision;
    state = await apply((await readFile(blue)).toString("base64")); const second = String(state.document!.nodes[0].metadata.output.posterUrl);
    await service.apply({ action: { type: "gc_library" } }); expect(await service.readAsset({ kind: "assets", name: first.split("/").pop()! })).not.toBeNull();
    await service.apply({ documentId: id, action: { type: "remove_draft", draftRevision } }); await service.apply({ action: { type: "gc_library" } }); expect(await service.readAsset({ kind: "assets", name: first.split("/").pop()! })).toBeNull(); expect(await service.readAsset({ kind: "assets", name: second.split("/").pop()! })).not.toBeNull();
    const changed = await service.apply({ documentId: id, action: { type: "upload", name: "replacement.mp4", kind: "video", base64: (await readFile(video)).toString("base64") } });
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { media: [changed.result] } } } }); expect(state.document!.nodes[0].metadata.output.posterUrl).toBe("");
    await expect(apply((await readFile(red)).toString("base64"))).rejects.toMatchObject({ code: "CONFLICT" });
    await service.apply({ action: { type: "gc_library" } }); expect(await service.readAsset({ kind: "assets", name: second.split("/").pop()! })).toBeNull();
    await expect(apply(Buffer.from("not a JPEG").toString("base64"), (changed.result as DesignMedia).url)).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  } finally { await service.close(); }
}, 30_000);

it("retains recent task outcomes for thirty seconds and renders actual approval/question controls in the canvas panel", () => {
  const now = Date.now();
  const request = { steps: [{ id: "real-step", question: "Choose", selectionMode: 1, options: [{ id: "real-option", label: "One" }], allowOther: true, required: true }] };
  const data: DesignState = { documents: [], templates: [], capabilities: {}, models: [], defaultModelKey: null, library: [], mediaStatus: {}, tasks: [
    { id: "running", nodeId: "active node", status: "running", startedAt: now - 5000, runner: "connector", providerStatus: "submitted", log: ["old-log", "one", "two", "three", "four"], sessionId: "real-session", pendingPermission: { requestId: "real-permission", toolName: "bash", reason: "explicit approval" }, pendingQuestion: { requestId: "real-question", request } },
    { id: "recent", nodeId: "recent node", status: "done", startedAt: now - 6000, finishedAt: now - 1000, elapsedMs: 5000 },
    { id: "expired", nodeId: "expired node", status: "error", finishedAt: now - 30001 },
  ] };
  const html = renderToStaticMarkup(createElement(DesignTaskPanel, { data, onAction: async () => undefined, openSession: () => {} }));
  expect(html).toContain("运行进度"); expect(html).toContain("收起"); expect(html).toContain("已提交，等待生成"); expect(html).toContain("允许一次"); expect(html).toContain("拒绝"); expect(html).toContain("在对话里打开"); expect(html).toContain("跳过"); expect(html).toContain("其他答案"); expect(html).toContain("recent node"); expect(html).not.toContain("expired node"); expect(html).not.toContain("old-log");
  expect(panelTasks(data.tasks, { now: now + 31000 }).map((task) => task.id)).toEqual(["running"]);
  expect(panelClosed({ closed: false, event: "put-away" })).toBe(true); expect(panelClosed({ closed: true, event: "run-started" })).toBe(false);
});

it("preserves questionnaire identities, required/Other validation and explicit skipped replies; unknown schema uses chat fallback", () => {
  const request = { steps: [{ id: "real-step", question: "Choose", options: [{ id: "real-option", label: "One" }], allowOther: true, required: true }] };
  const steps = designQuestionSteps(request)!;
  expect(designQuestionError(steps, {})).toBe("请回答：Choose");
  expect(designQuestionError(steps, { "real-step": { stepId: "real-step", selectedOptionIds: ["real-option"], selectedOther: true, otherText: "" } })).toBe("请输入：Choose 的其他答案");
  expect(designQuestionError(steps, { "real-step": { stepId: "real-step", selectedOther: true, otherText: "Written answer" } })).toBeUndefined();
  expect(designSkippedAnswers(steps)).toEqual([{ stepId: "real-step", selectedOptionIds: [], selectedOther: false, skipped: true }]);
  expect(designQuestionSteps({ steps: [{ question: "No host id" }] })).toBeUndefined();
  const fallback = renderToStaticMarkup(createElement(DesignQuestionnaire, { request: { unexpected: true }, onAnswer: async () => {}, onOpenChat: () => {} }));
  expect(fallback).toContain("在对话中回答"); expect(fallback).not.toContain("提交");
});

it("renders native custom players and a real range-editing clip surface instead of native media controls or numeric-only trim", () => {
  const node: DesignNode = { id: "result", type: "result", title: "Sound", position: { x: 0, y: 0 }, width: 320, height: 150, metadata: { kind: "audio", prompt: "", mode: null, model: null, ratio: null, resolution: null, duration: null, count: 1, voice: null, emotion: null, sessionId: null, segments: [], mentions: [], output: { status: "success", text: "", error: "", media: [{ url: "/design-assets/assets/sample.mp3", kind: "audio" }] } } };
  const audio = renderToStaticMarkup(createElement(DesignMediaView, { node, assetUrl: (url) => `http://loopback.invalid${url}` }));
  expect(audio).toContain('aria-label="音频波形"'); expect(audio).toContain('aria-label="播放音频"'); expect(audio).toContain('aria-label="保存音频到本地"'); expect(audio).not.toContain(" controls=");
  const video = renderToStaticMarkup(createElement(DesignMediaView, { node: { ...node, metadata: { ...node.metadata, kind: "video", output: { ...node.metadata.output, media: [{ url: "/design-assets/assets/sample.mp4", kind: "video" }] } } }, assetUrl: (url) => url }));
  expect(video).toContain('aria-label="播放视频"'); expect(video).toContain('data-design-media-engine="result"'); expect(video).not.toContain(" controls=");
  const clip = renderToStaticMarkup(createElement(DesignClipPanel, { media: { url: "/design-assets/assets/sample.mp4", kind: "video" }, assetUrl: (url) => url, onApply: () => {}, onCancel: () => {} }));
  expect(clip).toContain('aria-label="剪辑视频帧条"'); expect(clip).toContain('aria-label="剪辑起点"'); expect(clip).toContain('aria-label="剪辑终点"'); expect(clip).toContain('role="slider"'); expect(clip).toContain('aria-label="播放头"'); expect(clip).not.toContain('type="number"');
});

it("scrubs and keyboard-seeks the retained playhead within the selected range and releases every drag listener", () => {
  const track = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, width: 112 }) });
  const head = Object.assign(new EventTarget(), { focus: () => {}, contains: () => false });
  const win = new EventTarget(); let current = 5000, presses = 0, releases = 0;
  const dispose = wirePlayhead({ track: track as unknown as HTMLElement, playhead: head as unknown as HTMLElement, win: win as unknown as Window, getRange: () => ({ durationMs: 10000, startMs: 2000, endMs: 8000 }), getDurationMs: () => 10000, getCurrentMs: () => current, seek: (ms) => { current = ms; }, paint: () => {}, onPress: () => { presses++; }, onRelease: () => { releases++; } });
  const pointer = (type: string, clientX: number) => Object.assign(new Event(type, { cancelable: true }), { clientX });
  track.dispatchEvent(pointer("pointerdown", 56)); expect(current).toBe(5000); win.dispatchEvent(pointer("pointermove", 81)); expect(current).toBe(7500); win.dispatchEvent(new Event("pointerup")); expect([presses, releases]).toEqual([1, 1]);
  head.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "ArrowRight" })); expect(current).toBe(7510);
  head.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Home" })); expect(current).toBe(2000);
  head.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "End" })); expect(current).toBe(8000);
  track.dispatchEvent(pointer("pointerdown", 31)); expect(current).toBe(2500); dispose(); win.dispatchEvent(pointer("pointermove", 106)); expect(current).toBe(2500); expect(releases).toBe(2);
  track.dispatchEvent(pointer("pointerdown", 56)); expect(current).toBe(2500);
});

it("loops the actual media engine inside the chosen range, disposes preview effects and derives real strip samples", () => {
  const engine = Object.assign(new EventTarget(), { currentTime: 5, paused: false, ended: false }); const played: number[] = [];
  const dispose = wirePreviewLoop(engine as unknown as HTMLMediaElement, { fromSec: () => 1, toSec: () => 3, isPlaying: () => !engine.paused, playAt: (sec) => { played.push(sec); engine.currentTime = sec; } });
  engine.dispatchEvent(new Event("timeupdate")); expect(engine.currentTime).toBe(1);
  engine.dispatchEvent(new Event("ended")); expect(played).toEqual([1]); dispose(); engine.currentTime = 7; engine.dispatchEvent(new Event("timeupdate")); engine.dispatchEvent(new Event("ended")); expect(engine.currentTime).toBe(7); expect(played).toEqual([1]);
  expect(frameStops(3, 4)).toEqual([0, 2, 4]); expect(waveformPeaks(new Float32Array([0, -0.5, 0.25, 1]), 2)).toEqual([0.5, 1]);
});

it("executes local image, FFmpeg, understanding, Connector and Agent families and persists their products", async () => {
  const scratch = process.env.WEBUI_DESIGN_TEST_ROOT ?? path.join(homedir(), ".cache/minimax-code-test-artifacts/design");
  await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(path.join(scratch, "media-"));
  const run = promisify(execFile);
  const image = path.join(directory, "source.png"); const video = path.join(directory, "source.mp4");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:s=32x32", "-frames:v", "1", "-threads", "1", image]);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=blue:s=32x32:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", video]);
  const uploads: number[] = []; const calls: string[] = [];
  const upload = createServer((request, response) => { let bytes = 0; request.on("data", (chunk: Buffer) => { bytes += chunk.length; }); request.on("end", () => { uploads.push(bytes); response.writeHead(200); response.end(); }); });
  await new Promise<void>((resolve) => upload.listen(0, "127.0.0.1", resolve)); const address = upload.address();
  if (!address || typeof address === "string") throw new Error("Synthetic upload receiver did not bind");
  const service = await createWebuiDesignService(directory); let originalUrl = "";
  const names = ["upload_temp_url", "describe_images", "videos_understand", "remove_image_background", "generate_image"];
  try {
    await service.attachExecution({ agent: { models: async () => ({ models: [], default: { providerId: "minimax", modelId: "M3" } }), run: async () => { throw new Error("Image tool uses its real extracted Connector execution path"); }, reply: async () => ({}), answer: async () => ({ sessionId: "synthetic", status: "finished" }) }, hostConnector: { list: async () => ({ tools: names.map((name) => ({ name, toolRef: name, inputSchema: { type: "object" } })), providerFailures: [], partial: false }), call: async (name) => { calls.push(name); if (name === "upload_temp_url") return { value: { upload_host: `http://127.0.0.1:${address.port}/upload`, temp_url: "https://example.invalid/synthetic-upload", fields: {} } }; if (name === "describe_images" || name === "videos_understand") return { value: { results: [{ success: true, description: "synthetic understood material" }] } }; return { value: { success_items: [{ url: originalUrl }] } }; } }, close: async () => {} });
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image" } }); const sourceNodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "upload", kind: "image", name: "source.png", base64: (await readFile(image)).toString("base64") } });
    const source = state.result as DesignMedia; originalUrl = source.url;
    await service.apply({ documentId: id, action: { type: "update_node", nodeId: sourceNodeId, patch: { metadata: { output: { status: "success", media: [source], text: "", error: "" } } } } });
    for (const [tool, params, count] of [["gridSplit", { rows: 2, cols: 2 }, 4], ["crop", { cropRect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 1]] as const) {
      state = await service.apply({ documentId: id, action: { type: "media_tool", sourceNodeId, tool, params, sources: [source] } });
      const products = (state.result as { artifacts: DesignMedia[] }).artifacts; expect(products).toHaveLength(count);
      const created = (state.result as { createdNodeIds: string[] }).createdNodeIds;
      expect(created).toHaveLength(count); expect(new Set(created).size).toBe(count);
      expect(created.map((id) => state.document!.nodes.find((node) => node.id === id)?.metadata.output.media[0]?.url)).toEqual(products.map((product) => product.url));
      for (const product of products) expect((await service.readAsset({ kind: "assets", name: product.url.split("/").pop()! }))!.bytes.length).toBeGreaterThan(0);
    }
    state = await service.apply({ documentId: id, action: { type: "understand", sourceNodeId, kind: "image", url: source.url } });
    expect((state.result as { createdNodeIds: string[] }).createdNodeIds).toHaveLength(1);
    expect(state.document!.nodes.some((node) => node.metadata.output.text === "synthetic understood material")).toBe(true);
    state = await service.apply({ documentId: id, action: { type: "media_tool", sourceNodeId, tool: "aiCutout", params: {}, sources: [source] } });
    expect((state.result as { media: DesignMedia[] }).media).toHaveLength(1);
    state = await service.apply({ documentId: id, action: { type: "upload", kind: "video", name: "source.mp4", base64: (await readFile(video)).toString("base64") } }); const clip = state.result as DesignMedia;
    state = await service.apply({ documentId: id, action: { type: "media_tool", sourceNodeId, tool: "deconstruct", sources: [clip], params: {} } });
    expect((state.result as { text: string }).text).toContain("understood");
    state = await service.apply({ documentId: id, action: { type: "media_tool", sourceNodeId, tool: "frame", sources: [clip], params: { time: 0 } } });
    expect((state.result as { artifacts: DesignMedia[] }).artifacts).toHaveLength(1);
    state = await service.apply({ documentId: id, action: { type: "media_tool", sourceNodeId, tool: "multiAngle", sources: [source], params: { angles: ["正面", "侧面"] } } });
    expect((state.result as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect((state.result as { createdNodeIds: string[] }).createdNodeIds).toHaveLength(2);
    await expect.poll(async () => (await service.getState({ documentId: id })).tasks.every((task) => task.status === "done"), { timeout: 10000 }).toBe(true);
    expect(calls).toContain("generate_image"); expect(calls).toContain("remove_image_background"); expect(calls).toContain("videos_understand"); expect(calls).toContain("describe_images"); expect(uploads.every((bytes) => bytes > 100)).toBe(true);
    state = await service.getState({ documentId: id });
    expect(state.document!.nodes.filter((node) => node.type === "result").length).toBeGreaterThanOrEqual(9);
    const derived = state.document!.nodes.filter((node) => node.type === "result");
    for (const [index, node] of derived.entries()) for (const other of derived.slice(index + 1)) expect(node.position.x + node.width <= other.position.x || other.position.x + other.width <= node.position.x || node.position.y + node.height <= other.position.y || other.position.y + other.height <= node.position.y).toBe(true);
  } finally { await service.close(); await new Promise<void>((resolve, reject) => upload.close((error) => error ? reject(error) : resolve())); }
}, 30_000);
