import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWebuiDesignService } from "../../src/runtime/design/design-service.js";
import { acquireWebuiStorageLock } from "../../src/runtime/storage-transaction.js";
import { DESIGN_MAX_HTTP_ACTION_BYTES } from "../../src/shared/design-input.js";

const root = process.cwd();
const scratch = process.env.WEBUI_DESIGN_TEST_ROOT ?? path.join(homedir(), ".cache/minimax-code-test-artifacts/design");
const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } });
async function directory() { await mkdir(scratch, { recursive: true }); return mkdtemp(path.join(scratch, "integration-")); }
async function worker(dataDir: string) {
  const script = path.join(dataDir, `worker-${Math.random()}.mjs`);
  await writeFile(script, `import { createWebuiDesignService } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/webui/src/runtime/design/design-service.ts")).href)};
import { acquireWebuiStorageLock } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/webui/src/runtime/storage-transaction.ts")).href)};
const service = await createWebuiDesignService(process.env.DESIGN_WORKER_DIR); let release;
process.on('message', async ({id,operation,input}) => { try { const result = operation === 'lock' ? (release = await acquireWebuiStorageLock(input), true) : operation === 'unlock' ? (release(), true) : await service.apply(input); process.send({id,result}); } catch(error) {process.send({id,error:{code:error.code,message:error.message}});} });
process.send({ready:true});`);
  const child = fork(script, [], { execArgv: ["--import", pathToFileURL(path.join(root, "packages/webui/node_modules/tsx/dist/loader.mjs")).href], env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"), DESIGN_WORKER_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  const [ready] = await once(child, "message"); expect(ready).toEqual({ ready: true });
  return { child, request(operation: string, input: unknown): Promise<{ result?: unknown; error?: { code: string } }> { const id = Math.random(); return new Promise((resolve) => { const listener = (message: { id: number; result?: unknown; error?: { code: string } }) => { if (message.id === id) { child.off("message", listener); resolve(message); } }; child.on("message", listener); child.send({ id, operation, input }); }); } };
}
describe("native Design real boundaries", () => {
  it("executes the registered Design tool in a real production turn with only a local model endpoint substituted", async () => {
    const dataDir = await directory();
    const child = fork(path.join(root, "packages/webui/test/browser/support/native-design-browser-host.ts"), [], { execArgv: ["--import", pathToFileURL(path.join(root, "packages/webui/node_modules/tsx/dist/loader.mjs")).href], env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"), WEBUI_DESIGN_BROWSER_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child); let logs = ""; child.stderr!.on("data", (bytes) => { logs += String(bytes); });
    const ready = await Promise.race([once(child, "message").then(([value]) => value as { sessionId: string }), once(child, "exit").then(() => { throw new Error(logs); })]);
    const response = once(child, "message"); child.send({ requestId: "registered-open", input: { action: "open" } });
    const [message] = await response;
    expect(message).not.toHaveProperty("error");
    expect(message.result.acceptance).toEqual({ registeredTool: true, productionTurn: true });
    expect(message.result.openIntent.sessionId).toBe(ready.sessionId);
    expect(message.result.document.id).toBe(message.result.openIntent.documentId);
    const createResponse = once(child, "message"); child.send({ requestId: "registered-create", input: { action: "create", title: "Production-created board" } });
    const [created] = await createResponse; expect(created).not.toHaveProperty("error"); expect(created.result.document.title).toBe("Production-created board");
    const addResponse = once(child, "message"); child.send({ requestId: "registered-add", input: { action: "add_node", documentId: created.result.document.id, nodeType: "text", prompt: "Production-created node" } });
    const [added] = await addResponse; expect(added).not.toHaveProperty("error"); expect(added.result.document.nodes[0].metadata.prompt).toBe("Production-created node");
    const badResponse = once(child, "message"); child.send({ requestId: "registered-bad", input: { action: "update_node", documentId: created.result.document.id, nodeId: "missing", patch: { prompt: "refused" } } });
    const [bad] = await badResponse; expect(bad).toHaveProperty("error");
    const closing = once(child, "message"); child.send("close"); expect((await closing)[0]).toEqual({ closed: true }); await once(child, "exit");
  }, 60_000);
  it("serializes cross-process document CAS without lost updates", async () => {
    const dataDir = await directory(); const service = await createWebuiDesignService(dataDir);
    try {
      const initial = await service.apply({ action: { type: "create" } }); const document = initial.document!;
      const [first, second] = await Promise.all([worker(dataDir), worker(dataDir)]);
      const responses = await Promise.all([first.request("apply", { documentId: document.id, expectedRevision: document.updatedAt, action: { type: "save", document: { ...document, title: "first" } } }), second.request("apply", { documentId: document.id, expectedRevision: document.updatedAt, action: { type: "save", document: { ...document, title: "second" } } })]);
      expect(responses.filter((response) => response.result)).toHaveLength(1);
      expect(responses.filter((response) => response.error?.code === "CONFLICT")).toHaveLength(1);
      expect(["first", "second"]).toContain((await service.getState({ documentId: document.id })).document!.title);
    } finally { await service.close(); }
  }, 30_000);

  it.skipIf(process.platform === "win32")("retains the OS lock while a writer is SIGSTOPed and recovers after SIGKILL", async () => {
    const dataDir = await directory(); const peer = await worker(dataDir); const lock = path.join(dataDir, "paused.sqlite");
    expect(await peer.request("lock", lock)).toEqual(expect.objectContaining({ result: true }));
    peer.child.kill("SIGSTOP");
    await expect(acquireWebuiStorageLock(lock, 150)).rejects.toMatchObject({ code: "DESIGN_BUSY" });
    peer.child.kill("SIGCONT"); expect(await peer.request("unlock", null)).toEqual(expect.objectContaining({ result: true }));
    const release = await acquireWebuiStorageLock(lock, 150); release();
    await peer.request("lock", lock); const exited = once(peer.child, "exit"); peer.child.kill("SIGKILL"); await exited;
    const recovered = await acquireWebuiStorageLock(lock, 1000); recovered();
  }, 30_000);

  it("serves authenticated native operations and assets through a reconstructed production host port", async () => {
    const dataDir = await directory(); const previous = process.env.MINIMAX_DATA_DIR;
    await writeFile(path.join(dataDir, "config.yaml"), "# Native Design isolated loopback test\n");
    process.env.MINIMAX_DATA_DIR = dataDir; (await import("@mavis/config")).resetConfig();
    const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
    const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
    const { WebuiService, createOperationRegistry } = await import("../../src/server/index.js");
    const { WebuiTerminalManager } = await import("../../src/runtime/terminal.js");
    const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: "design-loopback", mcodeTools: { prepare: async () => ({ requested: false, ready: false, category: "disabled", ensureCommandPath: () => undefined, dispose: async () => undefined }) } });
    const port = createHarnessPortFromHost(assembled.host); const terminal = new WebuiTerminalManager();
    const service = new WebuiService({ port, terminal, operations: createOperationRegistry(port, terminal), tcpPort: 0, credential: { token: "synthetic-design-token" }, dev: false });
    try {
      const info = await service.start(); const base = `http://127.0.0.1:${info.tcpPort}`;
      const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws?token=synthetic-design-token`); await once(socket, "open");
      socket.send(JSON.stringify({ protocolVersion: 1, kind: "request", requestId: "create", operation: "applyDesignAction", body: { sessionId: "synthetic-session", action: { type: "open" } } }));
      let frame: { requestId?: string; kind: string; body?: { document?: { id: string } } };
      do { const [bytes] = await once(socket, "message"); frame = JSON.parse(String(bytes)); } while (frame.requestId !== "create");
      expect(frame.kind).toBe("response"); expect(frame.body!.document!.id).toMatch(/^design_/); socket.close();
      const rebuilt = createHarnessPortFromHost(assembled.host); expect((await rebuilt.getDesignState({ sessionId: "synthetic-session" })).document!.id).toBe(frame.body!.document!.id);
      const published = await rebuilt.applyDesignAction({ documentId: frame.body!.document!.id, action: { type: "publish", name: "image.png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" } });
      const assetUrl = (published.result as { url: string }).url;
      expect((await fetch(base + assetUrl)).status).toBe(401);
      const bytes = await fetch(`${base}${assetUrl}?token=synthetic-design-token`, { headers: { range: "bytes=0-7" } });
      expect(bytes.status).toBe(206); expect((await bytes.arrayBuffer()).byteLength).toBe(8);
      const wav = path.join(dataDir, "large-real-audio.wav");
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "pcm_s16le", wav], { stdio: "pipe" });
      const wavBytes = await readFile(wav);
      const mediaBody = JSON.stringify({ documentId: frame.body!.document!.id, action: { type: "upload", name: "large-real-audio.wav", kind: "audio", base64: wavBytes.toString("base64") } });
      expect(Buffer.byteLength(mediaBody)).toBeGreaterThan(256 * 1024);
      const headers = { authorization: "Bearer synthetic-design-token", "content-type": "application/json" };
      const large = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: mediaBody });
      expect(large.status).toBe(200);
      const uploaded = await large.json() as { result: { url: string } };
      const stored = await fetch(`${base}${uploaded.result.url}?token=synthetic-design-token`); expect(Buffer.from(await stored.arrayBuffer())).toEqual(wavBytes);
      const editable = await rebuilt.applyDesignAction({ documentId: frame.body!.document!.id, action: { type: "add_node", nodeType: "text", prompt: "genuine base" } });
      const baseNode = editable.document!.nodes.find((node) => node.type === "text")!;
      const draftRequest = { documentId: frame.body!.document!.id, action: { type: "save_draft_edits", edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { prompt: "last pagehide edit" } } }] } };
      const compact = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: JSON.stringify(draftRequest), keepalive: true }); expect(compact.status).toBe(200);
      expect(await compact.json()).toMatchObject({ draft: { document: { nodes: expect.arrayContaining([expect.objectContaining({ id: baseNode.id, metadata: expect.objectContaining({ prompt: "last pagehide edit" }) })]) } } });
      const tooLargeDraft = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: JSON.stringify({ ...draftRequest, action: { ...draftRequest.action, edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { prompt: "汉".repeat(24000) } } }] } }) });
      expect(tooLargeDraft.status).toBe(413); expect(await tooLargeDraft.json()).toMatchObject({ code: "payload_too_large", message: "Design close-page draft exceeds the 64 KiB JSON limit" });
      expect((await fetch(`${base}/design-assets/actions`, { method: "POST", body: mediaBody })).status).toBe(401);
      const illegal = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: JSON.stringify({ action: { type: "remove" } }) }); expect(illegal.status).toBe(400); expect(await illegal.json()).toMatchObject({ code: "invalid_body" });
      const malformed = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: "{" }); expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ code: "invalid_body" });
      const invalid = await fetch(`${base}/design-assets/actions`, { method: "POST", headers, body: JSON.stringify({ action: { type: "upload", name: "bad.wav", kind: "audio", base64: "not base64!" } }) }); expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "INVALID_ARGUMENTS" });
      const foreign = await fetch(`${base}/design-assets/actions`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body: mediaBody }); expect(foreign.status).toBe(403);
      const oversized = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = httpRequest(`${base}/design-assets/actions`, { method: "POST", headers: { ...headers, "content-length": DESIGN_MAX_HTTP_ACTION_BYTES + 1 } }, (response) => { let content = ""; response.on("data", (chunk) => { content += String(chunk); }); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(content) })); });
        request.on("error", reject); request.end("{}");
      });
      expect(oversized).toMatchObject({ status: 413, body: { code: "payload_too_large" } });
    } finally { await service.close(); await assembled.host.apiHost.close(); if (previous === undefined) delete process.env.MINIMAX_DATA_DIR; else process.env.MINIMAX_DATA_DIR = previous; }
  }, 60_000);
});
