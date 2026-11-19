import { execFileSync, fork } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import { test, attachJsonEvidence } from "./harness.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
let host, ready;
let logs = "";
test.beforeAll(async () => {
  host = fork(path.join(root, "packages/webui/test/browser/support/native-design-browser-host.ts"), [], {
    execArgv: ["--import", pathToFileURL(path.join(root, "packages/webui/node_modules/tsx/dist/loader.mjs")).href],
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"), WEBUI_DESIGN_BROWSER_DATA_DIR: process.env.WEBUI_DESIGN_BROWSER_DATA_DIR ?? path.join(test.info().project.outputDir, "native-design-task-host") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  host.stdout.on("data", (data) => { logs += data; }); host.stderr.on("data", (data) => { logs += data; });
  ready = await Promise.race([once(host, "message").then(([message]) => message), once(host, "exit").then(([code]) => { throw new Error(`Native Design task host exited ${code}: ${logs}`); })]);
});
test.afterAll(async () => {
  if (!host?.connected || host.exitCode !== null) return;
  const stopped = once(host, "message"); host.send("close"); expect((await stopped)[0], logs).toEqual({ closed: true });
});
async function ipc(input) {
  const requestId = crypto.randomUUID();
  const response = new Promise((resolve, reject) => {
    const listener = (message) => { if (message?.requestId !== requestId) return; host.off("message", listener); if (message.error) reject(new Error(message.error)); else resolve(message.result); };
    host.on("message", listener);
  });
  host.send({ requestId, ...input }); return response;
}
/**
 * Wait for a node run to finish, and say where it stopped when it does not.
 *
 * The provider's media understanding runs in the runtime, behind the connector:
 * the upload, the description and the run that consumes it are three steps
 * that report separately. A run that never finishes is therefore reported
 * with the evidence of the steps behind it, so the failure says which step
 * stopped instead of only that the node stayed idle.
 */
async function expectNodeRunSucceeds(read, nodeId, label) {
  try {
    await expect
      .poll(async () => {
        const output = (await read()).document.nodes.find((node) => node.id === nodeId).metadata.output;
        if (output.status === "error") throw new Error(`node run failed: ${JSON.stringify(output.error)}`);
        return output.status;
      }, { timeout: 60_000 })
      .toBe("success");
  } catch (error) {
    const uploads = await ipc({ readUploadEvidence: true }).catch(() => undefined);
    const understanding = await ipc({ readUnderstandingState: true }).catch(() => undefined);
    throw new Error(
      `${label} never finished: ${error instanceof Error ? error.message : String(error)}\n` +
        `upload evidence: ${JSON.stringify(uploads)}\n` +
        `understanding: ${JSON.stringify(understanding)}\n` +
        // The host's own log is the runtime's account of the run: which
        // stage it reached and what it was waiting for. A run that never
        // finishes is reported with that account, so the failure says where
        // the run stopped and not only that the node stayed idle.
        `host log:\n${logs.slice(-4000)}`,
    );
  }
}

async function rpc(page, operation, body) {
  return page.evaluate(({ operation, body }) => new Promise((resolve, reject) => {
    const config = window.__WEBUI_CONFIG__, url = new URL(config.websocketUrl); url.searchParams.set("token", config.token);
    const socket = new WebSocket(url), requestId = crypto.randomUUID();
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timeout: ${operation}`)); }, 15_000);
    socket.onerror = () => { clearTimeout(timer); reject(new Error(`Socket error: ${operation}`)); };
    socket.onopen = () => socket.send(JSON.stringify({ protocolVersion: 1, kind: "request", requestId, operation, body }));
    socket.onmessage = ({ data }) => { const frame = JSON.parse(data); if (frame.requestId !== requestId) return; clearTimeout(timer); socket.close(); if (frame.kind === "error") reject(new Error(`${frame.code}: ${frame.message}`)); else resolve(frame.body); };
  }), { operation, body });
}

test("native Design task panel cancels a real in-flight node run", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "原生任务取消验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url); url.pathname = "/design"; url.searchParams.set("session", ready.sessionId); url.searchParams.set("document", documentId); url.hash = "";
  await page.goto(url.href); await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  const state = await action({ type: "add_node", nodeType: "text", title: "任务取消文本节点", prompt: "DESIGN_ACCEPTANCE_HANG:cancel" });
  const nodeId = state.document.nodes[0].id;
  const card = page.locator(`[data-design-node="${nodeId}"]`), panel = page.getByRole("complementary", { name: "运行进度" });
  await expect(card).toBeVisible(); await card.click({ position: { x: 80, y: 80 } });
  await expect(card.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "生成", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("native-task-cancel.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(async () => (await read()).document.nodes[0].metadata.output.status, { timeout: 15_000 }).toBe("interrupted");
  await attachJsonEvidence("native-design-task-cancel-evidence.json", { nodeId, status: "interrupted", errors });
  expect(errors, logs).toEqual([]);
});

test("native Design text-node execution sends no tools and binds the result to its own node", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "无工具节点执行验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  const state = await action({ type: "add_node", nodeType: "text", title: "短诗节点", prompt: "写一首关于秋天的短诗 NODE_TOOLS_PROBE:text-node" });
  const nodeId = state.document.nodes[0].id;
  const card = page.locator(`[data-design-node="${nodeId}"]`);
  await card.click({ position: { x: 80, y: 80 } });
  await expect(card.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "生成", exact: true }).click();
  await expect
    .poll(async () => {
      const output = (await read()).document.nodes[0].metadata.output;
      if (output.status === "error") {
        throw new Error(`node run failed: ${JSON.stringify(output.error)}`);
      }
      return output.status;
    }, { timeout: 15_000 })
    .toBe("success");
  const toolTables = await ipc({ readNodeRunTools: "text-node" });
  expect(Array.isArray(toolTables)).toBe(true);
  expect(toolTables[0]).toEqual([]);
  const final = await read();
  expect(final.document.nodes[0].metadata.output.text).toBe("Design operation completed.");
  expect(final.document.nodes[0].metadata.output.executionId).toMatch(/^x_/);
  await page.screenshot({ path: test.info().outputPath("native-text-node-result.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("native Design flushes an immediate prompt edit before generating on the same click", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "立即生成保存验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  const state = await action({ type: "add_node", nodeType: "text", title: "立即编辑", prompt: "old prompt" });
  const nodeId = state.document.nodes[0].id;
  const card = page.locator(`[data-design-node="${nodeId}"]`);
  await card.click({ position: { x: 80, y: 80 } });
  const editor = card.getByRole("textbox", { name: "提示词" });
  await expect(editor).toBeVisible();
  const marker = "IMMEDIATE_EDIT_MARKER_7c1";
  await editor.evaluate((element, text) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.textContent = text;
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }, `new prompt ${marker}`);
  await card.getByRole("button", { name: "生成", exact: true }).click();
  await expect
    .poll(async () => {
      const output = (await read()).document.nodes[0].metadata.output;
      if (output.status === "error") throw new Error(`node run failed: ${JSON.stringify(output.error)}`);
      return output.status;
    }, { timeout: 15_000 })
    .toBe("success");
  const prompt = await ipc({ readModelPrompt: true });
  expect(prompt).toContain(marker);
  expect((await read()).document.nodes[0].metadata.prompt).toContain(marker);
  await page.screenshot({ path: test.info().outputPath("native-immediate-edit-generate.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("native Design sends an uploaded image's understood content to a connected text node", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ipc({ enableSyntheticUnderstanding: true });
  const created = await ipc({ input: { action: "create", title: "图片上下文验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  let state = await action({ type: "add_node", nodeType: "input", kind: "image" });
  const imageId = state.document.nodes[0].id;
  const imageCard = page.locator(`[data-design-node="${imageId}"]`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#d9c7a1";
    paint.fillRect(0, 0, 120, 90);
    paint.fillStyle = "#7a5230";
    paint.fillRect(30, 20, 60, 50);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await imageCard.locator('input[type="file"]').setInputFiles({
    name: "context-image.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect
    .poll(async () => (await read()).document.nodes[0].metadata.output.media.length, { timeout: 10_000 })
    .toBe(1);
  state = await read();
  state = await action({
    type: "add_node",
    nodeType: "text",
    title: "反推提示词",
    prompt: "写出一段能复刻这张图的提示词",
  });
  const textId = state.document.nodes.find((node) => node.id !== imageId).id;
  await action({ type: "connect", from: imageId, to: textId });
  const card = page.locator(`[data-design-node="${textId}"]`);
  await card.click({ position: { x: 80, y: 80 } });
  await expect(card.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "生成", exact: true }).click();
  await expectNodeRunSucceeds(read, textId, "the connected text node's run");
  const prompt = await ipc({ readModelPrompt: true });
  expect(prompt).toContain("合成理解：一只橘猫坐在窗台上");
  expect(prompt).toContain(`节点 ${imageId}`);
  const uploadEvidence = await ipc({ readUploadEvidence: true });
  expect(uploadEvidence.error).toBe("");
  expect(uploadEvidence.uploads).toHaveLength(1);
  expect(uploadEvidence.uploads[0].mime).toBe("image/png");
  expect(uploadEvidence.uploads[0].filename.endsWith(".png")).toBe(true);
  expect(uploadEvidence.uploads[0].magic.startsWith("89504e47")).toBe(true);
  expect(uploadEvidence.uploads.some((item) => item.mime.includes("mp4"))).toBe(false);
  await page.screenshot({ path: test.info().outputPath("native-image-context-result.png"), animations: "disabled" });
  expect(errors, logs).toEqual([]);
});

test("native Design image-mimic template keeps describe mode and sends the image to the model", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ipc({ enableSyntheticUnderstanding: true });
  const created = await ipc({ input: { action: "create", title: "图片复刻模板验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await page.getByRole("button", { name: "图片复刻", exact: false }).click();
  await expect
    .poll(async () => {
      const state = await read();
      return [state.document?.nodes.length, state.document?.connections.length];
    }, { timeout: 15_000 })
    .toEqual([3, 2]);
  let state = await read();
  const imageNode = state.document.nodes.find((node) => node.title === "参考图");
  const reverseNode = state.document.nodes.find((node) => node.title === "反推提示词");
  expect(imageNode).toBeDefined();
  expect(reverseNode).toBeDefined();
  expect(reverseNode.metadata.mode).toBe("describe");
  expect(state.document.connections).toHaveLength(2);
  const imageCard = page.locator(`[data-design-node="${imageNode.id}"]`);
  const reverseCard = page.locator(`[data-design-node="${reverseNode.id}"]`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#d7c3a0";
    paint.fillRect(0, 0, 160, 120);
    paint.fillStyle = "#7a5230";
    paint.fillRect(40, 25, 80, 70);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await imageCard.locator('input[type="file"]').setInputFiles({
    name: "template-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect
    .poll(async () => (await read()).document.nodes.find((node) => node.id === imageNode.id).metadata.output.media.length, { timeout: 10_000 })
    .toBe(1);
  await reverseCard.click({ position: { x: 80, y: 80 } });
  const modeSelect = reverseCard.getByRole("combobox", { name: "模式" });
  await expect(modeSelect).toContainText("图生文");
  await modeSelect.click();
  await expect(page.getByRole("option", { name: "图生文", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "视频生文", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("native-template-mode-options.png"), animations: "disabled" });
  await page.getByRole("option", { name: "图生文", exact: true }).click();
  const modelChip = reverseCard.locator('button[title="选择在线模型"]');
  await modelChip.click();
  const firstModel = page.locator(".webui-design-model-option").first();
  await expect(firstModel).toBeVisible();
  const modelLabel = await firstModel.innerText();
  await firstModel.click();
  await expect
    .poll(async () => {
      const current = await read();
      const node = current.document.nodes.find((entry) => entry.id === reverseNode.id);
      return Boolean(node?.metadata.model);
    }, { timeout: 10_000 })
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId("design-surface")).toBeVisible();
  state = await read();
  const reloadedReverse = state.document.nodes.find((node) => node.id === reverseNode.id);
  expect(reloadedReverse.metadata.mode).toBe("describe");
  expect(state.document.connections).toHaveLength(2);
  expect(state.document.nodes.find((node) => node.id === imageNode.id).metadata.output.media).toHaveLength(1);
  const reloadedCard = page.locator(`[data-design-node="${reverseNode.id}"]`);
  await reloadedCard.click({ position: { x: 80, y: 80 } });
  await expect(reloadedCard.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await reloadedCard.getByRole("button", { name: "生成", exact: true }).click();
  await expectNodeRunSucceeds(read, reverseNode.id, "the template's reverse-prompt node run");
  const prompt = await ipc({ readModelPrompt: true });
  expect(prompt).toContain("合成理解：一只橘猫坐在窗台上");
  expect(prompt).toContain(`节点 ${imageNode.id}`);
  expect(await ipc({ readModelTools: true })).toEqual([]);
  const final = await read();
  expect(final.document.nodes.find((node) => node.id === reverseNode.id).metadata.output.text).toBe("Design operation completed.");
  const renderNode = final.document.nodes.find((node) => node.title === "复刻");
  expect(renderNode).toBeDefined();
  const renderCard = page.locator(`[data-design-node="${renderNode.id}"]`);
  await renderCard.click({ position: { x: 80, y: 80 } });
  await renderCard.getByRole("button", { name: "生成", exact: true }).click();
  await expectNodeRunSucceeds(read, renderNode.id, "the template's render node run");
  const rendered = (await read()).document.nodes.find((node) => node.id === renderNode.id).metadata.output;
  expect(rendered.media).toHaveLength(1);
  expect(rendered.media[0].kind).toBe("image");
  expect(rendered.media[0].url).toContain("/generated.png");
  const generatedResponse = await page.request.get(rendered.media[0].url);
  expect(generatedResponse.status()).toBe(200);
  expect(generatedResponse.headers()["content-type"]).toBe("image/png");
  await page.screenshot({ path: test.info().outputPath("native-template-image-mimic-render.png"), animations: "disabled" });
  expect(errors, logs).toEqual([]);
  expect(modelLabel.length).toBeGreaterThan(0);
});

test("native Design shows and cancels a task while slow material understanding is in flight", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ipc({ enableSyntheticUnderstanding: true });
  await ipc({ enableSlowUnderstanding: true });
  const created = await ipc({ input: { action: "create", title: "慢素材取消验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  let state = await action({ type: "add_node", nodeType: "input", kind: "image", title: "慢参考图" });
  const imageId = state.document.nodes[0].id;
  const imageCard = page.locator(`[data-design-node="${imageId}"]`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#b8d8c0";
    paint.fillRect(0, 0, 80, 60);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await imageCard.locator('input[type="file"]').setInputFiles({
    name: "slow-context.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect
    .poll(async () => (await read()).document.nodes[0].metadata.output.media.length, { timeout: 10_000 })
    .toBe(1);
  state = await action({ type: "add_node", nodeType: "text", title: "慢素材文本", prompt: "写出一段能复刻这张图的提示词" });
  const textId = state.document.nodes.find((node) => node.id !== imageId).id;
  await action({ type: "connect", from: imageId, to: textId });
  const card = page.locator(`[data-design-node="${textId}"]`);
  await card.click({ position: { x: 80, y: 80 } });
  await expect(card.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "生成", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "运行进度" });
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => (await read()).document.nodes.find((node) => node.id === textId).metadata.output.status, { timeout: 10_000 })
    .toBe("loading");
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("native-slow-understanding-running.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .poll(async () => (await read()).document.nodes.find((node) => node.id === textId).metadata.output.status, { timeout: 15_000 })
    .toBe("interrupted");
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  const understanding = await ipc({ readUnderstandingState: true });
  expect(understanding.aborted).toBe(true);
  expect(understanding.designModelCalls).toBe(0);
  await page.screenshot({ path: test.info().outputPath("native-slow-understanding-cancelled.png"), animations: "disabled" });
  expect(errors, logs).toEqual([]);
});

test("native Design refuses unlisted model tool calls and leaves no shell or Design side effect", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "无工具对抗验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  const read = () => rpc(page, "getDesignState", { sessionId: ready.sessionId, documentId });
  const action = (value) => rpc(page, "applyDesignAction", { sessionId: ready.sessionId, documentId, action: value });
  const state = await action({
    type: "add_node",
    nodeType: "text",
    title: "对抗文本节点",
    prompt: "DESIGN_ACCEPTANCE_FORBIDDEN_TOOL:adversarial",
  });
  const nodeId = state.document.nodes[0].id;
  const card = page.locator(`[data-design-node="${nodeId}"]`);
  await card.click({ position: { x: 80, y: 80 } });
  await expect(card.getByRole("button", { name: "生成", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "生成", exact: true }).click();
  await expect
    .poll(async () => {
      const tasks = (await read()).tasks;
      const task = tasks.at(-1);
      return task && !["running", "waiting-question", "queued"].includes(task.status)
        ? task.status
        : undefined;
    }, { timeout: 15_000 })
    .toMatch(/done|error|interrupted/);
  const after = await read();
  expect(after.document.nodes).toHaveLength(1);
  expect(after.document.nodes.some((node) => node.title === "forbidden-design-write")).toBe(false);
  expect(existsSync(path.join(ready.directory, "forbidden-tool-ran"))).toBe(false);
  const forbiddenResult = await ipc({ readForbiddenToolResult: true });
  expect(forbiddenResult.seen).toBe(true);
  expect(forbiddenResult.content).not.toMatch(/forbidden-tool-ran|forbidden-design-write/u);
  expect(forbiddenResult.content).toMatch(/error|not found|unknown|unavailable|失败|不允许|no such tool/i);
  await page.screenshot({ path: test.info().outputPath("native-forbidden-tool-result.png"), animations: "disabled" });
  expect(errors, logs).toEqual([]);
});

test("native Design releases media engines and heals restored sources without changing their URLs", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [], requests = [], mutations = [], mutationIds = new Set(); page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.operation === "applyDesignAction") { mutationIds.add(frame.requestId); mutations.push(frame); } });
    socket.on("framereceived", ({ payload }) => { const frame = JSON.parse(String(payload)); if (mutationIds.has(frame.requestId)) mutations.push(frame); });
  });
  page.on("response", (response) => { if (response.url().includes("/design-assets/")) requests.push({ status: response.status(), url: response.url() }); });
  const created = await ipc({ input: { action: "create", title: "媒体生命周期验收" } });
  const documentId = created.document.id;
  const url = new URL(ready.url); url.pathname = "/design"; url.searchParams.set("session", ready.sessionId); url.searchParams.set("document", documentId); url.hash = "";
  await page.goto(url.href); await expect(page.getByTestId("design-surface")).toBeVisible();
  const body = { sessionId: ready.sessionId, documentId };
  const read = () => rpc(page, "getDesignState", body);
  const state = await rpc(page, "applyDesignAction", { ...body, action: { type: "add_node", nodeType: "input", kind: "video", title: "实际视频素材" } });
  const nodeId = state.document.nodes[0].id, card = page.locator(`[data-design-node="${nodeId}"]`);
  const source = path.join(ready.directory, "workspace", "media-lifecycle.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=blue:s=64x48:d=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", source], { stdio: "pipe" });
  await expect(card).toBeVisible(); await card.click({ position: { x: 80, y: 80 } });
  await card.getByLabel("上传视频", { exact: true }).setInputFiles(source);
  const video = card.locator("video"); await expect.poll(() => video.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  await card.getByRole("button", { name: "播放视频", exact: true }).click();
  await expect.poll(() => video.evaluate((engine) => engine.paused)).toBe(false);
  await video.evaluate((engine) => { window.__designAcceptanceEngine = engine; });
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.__designAcceptanceEngine.paused)).toBe(true);
  await page.getByRole("textbox", { name: "画布名称", exact: true }).press("Escape");
  await page.getByRole("combobox", { name: "选择画布", exact: true }).click();
  await page.getByRole("option", { name: "媒体生命周期验收（1 节点）", exact: true }).click();
  await expect(video).toBeVisible(); await expect.poll(() => video.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  const selected = (await read()).document.nodes.find((node) => node.id === nodeId);
  const assetUrl = selected.metadata.output.media[0].url;
  const [, , kind, name] = assetUrl.split("/");
  const assetPath = path.join(ready.directory, "webui/design", kind, name), heldPath = `${assetPath}.acceptance-held`;
  renameSync(assetPath, heldPath);
  try {
    // The decoded browser buffer survives engine.load(); start the missing-source
    // observation with a real navigation, then restore without navigating again.
    await page.reload();
    await expect(card.getByText("素材已不在，请重新生成或从资产库插入", { exact: true })).toBeVisible();
    await attachJsonEvidence("native-media-missing-debug.json", { state: await read(), mutations, requests });
    await expect.poll(async () => (await read()).document.nodes.find((node) => node.id === nodeId).metadata.output.missing).toBe(true);
  } finally { renameSync(heldPath, assetPath); }
  await expect(card.getByText("素材已不在，请重新生成或从资产库插入", { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await read()).document.nodes.find((node) => node.id === nodeId).metadata.output.missing).toBe(false);
  expect((await read()).document.nodes.find((node) => node.id === nodeId).metadata.output.media[0].url).toBe(assetUrl);
  const bytes = readFileSync(assetPath); writeFileSync(assetPath, "This is an invalid synthetic video, not a media container.");
  try {
    await page.reload();
    await expect(card.locator("[data-media-missing=true]")).toBeVisible();
    // The missing notice covers the player. Dispatch its transport handler to
    // verify a real decode rejection, rather than replacing engine.play with a stub.
    await card.getByRole("button", { name: "播放视频", exact: true }).dispatchEvent("click");
    await expect(page.getByText(/无法播放素材：/)).toBeVisible();
  } finally { writeFileSync(assetPath, bytes); }
  await expect(card.locator("[data-media-missing=true]")).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: test.info().outputPath("native-media-restored.png"), animations: "disabled" });
  expect(requests.some((request) => request.status === 404)).toBe(true);
  expect(requests.some((request) => request.status === 200 || request.status === 206)).toBe(true);
  expect(errors).toEqual([]);
  await attachJsonEvidence("native-design-media-lifecycle-evidence.json", { requests, errors, assetUrl, priorEnginePaused: true, unchangedUrl: true, restored: true });
});

test("native Design clips on real filmstrips with handles, keyboard playhead and FFmpeg products", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "帧条剪辑验收" } }), documentId = created.document.id;
  const url = new URL(ready.url); url.pathname = "/design"; url.searchParams.set("session", ready.sessionId); url.searchParams.set("document", documentId); url.hash = "";
  await page.goto(url.href); await expect(page.getByTestId("design-surface")).toBeVisible();
  const scope = { sessionId: ready.sessionId, documentId }, read = () => rpc(page, "getDesignState", scope);
  const state = await rpc(page, "applyDesignAction", { ...scope, action: { type: "add_node", nodeType: "input", kind: "video", title: "帧条源素材" } });
  const nodeId = state.document.nodes[0].id, card = page.locator(`[data-design-node="${nodeId}"]`);
  const source = path.join(ready.directory, "workspace", "filmstrip.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=blue:s=64x48:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", source], { stdio: "pipe" });
  await expect(card).toBeVisible(); await card.click({ position: { x: 80, y: 80 } });
  await card.getByLabel("上传视频", { exact: true }).setInputFiles(source);
  await expect.poll(() => card.locator("video").evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  await card.locator('[data-design-tool="trim"]').click();
  const clip = page.getByRole("dialog", { name: "剪辑", exact: true }), playhead = clip.getByRole("slider", { name: "播放头", exact: true });
  await expect(clip).toBeVisible(); await expect(playhead).toHaveAttribute("aria-valuemax", "4000");
  await expect.poll(() => clip.getByLabel("剪辑视频帧条", { exact: true }).evaluate((canvas) => {
    const pixel = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return pixel[2] > pixel[0] + 100;
  })).toBe(true);
  if (await clip.getByRole("button", { name: "暂停预览", exact: true }).isVisible()) await clip.getByRole("button", { name: "暂停预览", exact: true }).click();
  const bounds = await clip.getByLabel("剪辑素材时间条", { exact: true }).boundingBox();
  for (const [name, fraction] of [["剪辑起点", .25], ["剪辑终点", .75]]) {
    const handle = await clip.getByRole("button", { name, exact: true }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + 6 + (bounds.width - 12) * fraction, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up();
  }
  const start = Number(await playhead.getAttribute("aria-valuemin")), end = Number(await playhead.getAttribute("aria-valuemax"));
  expect(start).toBeGreaterThan(900); expect(start).toBeLessThan(1100); expect(end).toBeGreaterThan(2900); expect(end).toBeLessThan(3100);
  await playhead.focus(); await playhead.press("Home"); await expect(playhead).toHaveAttribute("aria-valuenow", String(start));
  await playhead.press("ArrowRight"); await expect(playhead).toHaveAttribute("aria-valuenow", String(start + 10));
  await playhead.press("End"); await expect(playhead).toHaveAttribute("aria-valuenow", String(end));
  await page.screenshot({ path: test.info().outputPath("native-video-clip-strip.png"), animations: "disabled" });
  await clip.getByRole("button", { name: "确认", exact: true }).click(); await expect(clip).toHaveCount(0);
  await expect.poll(async () => (await read()).document.nodes.length).toBe(2);
  const product = (await read()).document.nodes.find((node) => node.id !== nodeId), output = product.metadata.output.media[0];
  expect(product.metadata.sourceNodeId).toBe(nodeId); expect(output.kind).toBe("video");
  const result = page.locator(`[data-design-node="${product.id}"] video`); await expect.poll(() => result.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  const duration = await result.evaluate((engine) => engine.duration); expect(Math.abs(duration - (end - start) / 1000)).toBeLessThan(.15);
  await attachJsonEvidence("native-design-clip-evidence.json", { start, end, duration, product, errors }); expect(errors).toEqual([]);
});

test("native Design draws real audio waveforms, plays and downloads authenticated media and trims audio", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "音频波形验收" } }), documentId = created.document.id;
  const url = new URL(ready.url); url.pathname = "/design"; url.searchParams.set("session", ready.sessionId); url.searchParams.set("document", documentId); url.hash = "";
  await page.goto(url.href); await expect(page.getByTestId("design-surface")).toBeVisible();
  const scope = { sessionId: ready.sessionId, documentId }, read = () => rpc(page, "getDesignState", scope);
  const state = await rpc(page, "applyDesignAction", { ...scope, action: { type: "add_node", nodeType: "input", kind: "audio", title: "实际正弦音频" } });
  const nodeId = state.document.nodes[0].id, card = page.locator(`[data-design-node="${nodeId}"]`);
  const source = path.join(ready.directory, "workspace", "waveform.wav");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "pcm_s16le", source], { stdio: "pipe" });
  await expect(card).toBeVisible(); await card.click({ position: { x: 80, y: 80 } });
  await card.getByLabel("上传音频", { exact: true }).setInputFiles(source);
  const audio = card.locator("audio"); await expect.poll(() => audio.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  const waveform = card.getByLabel("音频波形", { exact: true });
  const painted = (canvas) => { const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; const colors = new Set(); for (let index = 0; index < pixels.length; index += 4) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]},${pixels[index + 3]}`); return colors.size; };
  await expect.poll(() => waveform.evaluate(painted)).toBeGreaterThan(2);
  await card.getByRole("button", { name: "播放音频", exact: true }).click();
  await expect.poll(() => audio.evaluate((engine) => engine.currentTime)).toBeGreaterThan(.2);
  await card.getByRole("button", { name: "暂停音频", exact: true }).click(); await expect.poll(() => audio.evaluate((engine) => engine.paused)).toBe(true);
  const downloadEvent = page.waitForEvent("download"); await card.getByRole("link", { name: "保存音频到本地", exact: true }).click();
  const download = await downloadEvent, downloadedFile = test.info().outputPath("downloaded-waveform.wav");
  await download.saveAs(downloadedFile); expect(download.suggestedFilename()).toMatch(/\.wav$/); expect(readFileSync(downloadedFile).byteLength).toBe(readFileSync(source).byteLength);
  await card.locator('[data-design-tool="trimAudio"]').click();
  const clip = page.getByRole("dialog", { name: "剪辑", exact: true }); await expect(clip).toBeVisible();
  await expect.poll(() => clip.getByLabel("剪辑音频波形", { exact: true }).evaluate(painted)).toBeGreaterThan(2);
  for (let count = 0; count < 10; count++) await clip.getByRole("button", { name: "剪辑起点", exact: true }).press("ArrowRight");
  for (let count = 0; count < 10; count++) await clip.getByRole("button", { name: "剪辑终点", exact: true }).press("ArrowLeft");
  await expect(clip.getByRole("slider", { name: "播放头", exact: true })).toHaveAttribute("aria-valuemin", "1000");
  await expect(clip.getByRole("slider", { name: "播放头", exact: true })).toHaveAttribute("aria-valuemax", "3000");
  await page.screenshot({ path: test.info().outputPath("native-audio-waveform-clip.png"), animations: "disabled" });
  await clip.getByRole("button", { name: "确认", exact: true }).click(); await expect(clip).toHaveCount(0);
  await expect.poll(async () => (await read()).document.nodes.length).toBe(2);
  const product = (await read()).document.nodes.find((node) => node.id !== nodeId); expect(product.metadata.output.media[0].kind).toBe("audio");
  const result = page.locator(`[data-design-node="${product.id}"] audio`); await expect.poll(() => result.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  const duration = await result.evaluate((engine) => engine.duration); expect(Math.abs(duration - 2)).toBeLessThan(.15);
  await attachJsonEvidence("native-design-audio-evidence.json", { duration, product, errors, sourceBytes: readFileSync(source).byteLength, downloadedName: download.suggestedFilename() }); expect(errors).toEqual([]);
});

test("native Design persists authenticated bounded seek posters and fences delayed sampling after source and document changes", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const created = await ipc({ input: { action: "create", title: "视频封面持久化验收" } }), documentId = created.document.id;
  const url = new URL(ready.url); url.pathname = "/design"; url.searchParams.set("session", ready.sessionId); url.searchParams.set("document", documentId); url.hash = "";
  const scope = { sessionId: ready.sessionId, documentId }, read = () => rpc(page, "getDesignState", scope);
  await page.goto(url.href); await expect(page.getByTestId("design-surface")).toBeVisible();
  const state = await rpc(page, "applyDesignAction", { ...scope, action: { type: "add_node", nodeType: "input", kind: "video", title: "真实采样视频" } }), nodeId = state.document.nodes[0].id;
  const source = path.join(ready.directory, "workspace", "poster-source.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=96x64:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", source], { stdio: "pipe" });
  const card = page.locator(`[data-design-node="${nodeId}"]`); await expect(card).toBeVisible(); await card.click({ position: { x: 80, y: 80 } });
  await card.getByLabel("上传视频", { exact: true }).setInputFiles(source);
  const video = card.locator("video"); await expect.poll(() => video.evaluate((engine) => engine.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate((engine) => { engine.currentTime = .5; });
  await expect.poll(async () => (await read()).document.nodes[0].metadata.output.posterUrl).toMatch(/^\/design-assets\/assets\/thumb_[a-f0-9]{64}\.jpg$/);
  const poster = (await read()).document.nodes[0].metadata.output.posterUrl;
  const sampled = await page.evaluate(async (raw) => {
    const image = new Image(), url = new URL(raw, location.href); url.searchParams.set("token", window.__WEBUI_CONFIG__.token);
    image.src = url.href; await image.decode(); const response = await fetch(url.href);
    return { width: image.naturalWidth, height: image.naturalHeight, bytes: (await response.arrayBuffer()).byteLength };
  }, poster);
  expect(sampled).toMatchObject({ width: 96, height: 64 }); expect(sampled.bytes).toBeLessThan(128 * 1024);
  expect((await read()).library.some((asset) => asset.url === poster)).toBe(false);
  await page.reload(); await expect(video).toBeVisible(); await expect.poll(() => video.evaluate((engine) => engine.poster)).toContain(poster);
  expect(await video.evaluate((engine) => new URL(engine.poster).searchParams.has("token"))).toBe(true);
  await page.screenshot({ path: test.info().outputPath("native-video-persisted-poster.png"), animations: "disabled" });
  // Delay the real browser encoder callback; no fabricated image or transport response.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { return original.call(this, (blob) => { window.__designPosterSampling = true; setTimeout(() => callback(blob), 600); }, ...args); };
  });
  await video.evaluate((engine) => { engine.currentTime = 2; }); await expect.poll(() => page.evaluate(() => window.__designPosterSampling)).toBe(true);
  const next = await rpc(page, "applyDesignAction", { ...scope, action: { type: "upload", name: "replacement.mp4", kind: "video", base64: readFileSync(source).toString("base64") } });
  await rpc(page, "applyDesignAction", { ...scope, action: { type: "update_node", nodeId, patch: { output: { media: [next.result] } } } });
  await expect.poll(() => video.evaluate((engine) => engine.currentSrc)).toContain(next.result.url);
  await page.waitForTimeout(700); expect((await read()).document.nodes[0].metadata.output.posterUrl).toBe("");
  await page.evaluate(() => { window.__designPosterSampling = false; }); await video.evaluate((engine) => { engine.currentTime = 1; });
  await expect.poll(() => page.evaluate(() => window.__designPosterSampling)).toBe(true);
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.waitForTimeout(700); expect((await read()).document.nodes[0].metadata.output.posterUrl).toBe("");
  await attachJsonEvidence("native-design-poster-evidence.json", { poster, sampled, replacement: next.result.url, delayedRealEncoder: true, errors }); expect(errors).toEqual([]);
});
