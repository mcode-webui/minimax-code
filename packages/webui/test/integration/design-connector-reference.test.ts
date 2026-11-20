import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeDesignExecution } from "../../../local-runtime-v2/src/application/agent/native-design-execution.js";
import { HostConnectorGateway } from "../../../local-runtime-v2/src/service/host-connector-system/gateway.js";
import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";
import { createWebuiDesignService, type WebuiDesignService } from "../../src/runtime/design/design-service.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const services: WebuiDesignService[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function eventually(check: () => Promise<void>) {
  let error: unknown;
  for (let count = 0; count < 160; count += 1) {
    try { await check(); return; } catch (failure) { error = failure; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw error;
}

describe("native Design connector reference lifecycle", () => {
  it("keeps uploader and connector references usable across refreshes, account fences and downstream generation", async () => {
    const uploads: { mime: string; bytes: number }[] = [];
    let generated = false;
    let generateStarted!: () => void;
    const started = new Promise<void>((resolve) => { generateStarted = resolve; });
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGenerate = resolve; });
    const server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/upload") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        try {
          const form = await new Request("http://127.0.0.1/upload", {
            method: "POST",
            headers: { "content-type": String(request.headers["content-type"] ?? "") },
            body,
          }).formData();
          const file = form.get("file");
          if (file && typeof file !== "string") uploads.push({ mime: file.type, bytes: (await file.arrayBuffer()).byteLength });
        } catch {
          uploads.push({ mime: "", bytes: body.length });
        }
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/generated.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from(png, "base64"));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("synthetic provider did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    let credentials = { accessToken: "synthetic", realUserID: "synthetic-user", authState: "authenticated" as const };
    const tools = [
      { provider: "matrix", providerToolName: "upload_temp_url", runtimeToolName: "matrix_upload_temp_url", inputSchemaJson: '{"type":"object"}' },
      { provider: "matrix", providerToolName: "describe_images", runtimeToolName: "matrix_describe_images", inputSchemaJson: '{"type":"object"}' },
      { provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' },
    ];
    let listCalls = 0;
    let uploadCalls = 0;
    let describeCalls = 0;
    let generateCalls = 0;
    const gateway = new HostConnectorGateway({
      credentialGetter: () => credentials,
      client: {
        listConnectedTools: async () => {
          listCalls += 1;
          return { tools, providerFailures: [], partial: false };
        },
        callTool: async ({ providerToolName, onDispatch }) => {
          onDispatch();
          if (providerToolName === "upload_temp_url") {
            uploadCalls += 1;
            return { resultJson: JSON.stringify({ upload_host: `${base}/upload`, temp_url: "https://example.invalid/uploaded.png", fields: {} }) };
          }
          if (providerToolName === "describe_images") {
            describeCalls += 1;
            return { resultJson: JSON.stringify({ results: [{ success: true, description: "synthetic understood picture" }] }) };
          }
          if (providerToolName === "generate_image") {
            generateCalls += 1;
            generateStarted();
            await gate;
            generated = true;
            return { resultJson: JSON.stringify({ success_items: [{ url: `${base}/generated.png` }] }) };
          }
          throw new Error(`unexpected synthetic tool ${providerToolName}`);
        },
      },
    });
    const agent: NativeDesignExecution["agent"] = {
      models: async () => ({ models: [], default: { providerId: "synthetic", modelId: "text" } }),
      run: async () => ({ sessionId: "synthetic", status: "finished", text: "synthetic reverse prompt" }),
      reply: async () => ({}),
      answer: async () => ({ sessionId: "synthetic", status: "finished" }),
    };
    const native = createNativeDesignExecution(agent, gateway, "synthetic-design");
    const refs = { upload: [] as string[], describe: [] as string[], generate: [] as string[] };
    const originalCall = native.hostConnector.call.bind(native.hostConnector);
    (native.hostConnector as { call: typeof native.hostConnector.call }).call = (reference, input, options) => {
      const kind = "filename" in input ? "upload" : "image_info" in input ? "describe" : "generate";
      refs[kind].push(reference);
      return originalCall(reference, input, options);
    };
    const scratch = process.env.WEBUI_DESIGN_TEST_ROOT ?? path.join(homedir(), ".cache/minimax-code-test-artifacts/design");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, "connector-reference-"));
    const service = await createWebuiDesignService(directory);
    services.push(service);
    await service.attachExecution(native);
    try {
      let state = await service.apply({ action: { type: "create", title: "connector reference lifecycle" } });
      const id = state.document!.id;
      state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image", title: "reference" } });
      const imageInputId = state.document!.nodes[0].id;
      const uploaded = await service.apply({ documentId: id, action: { type: "upload", name: "source.png", kind: "image", base64: png } });
      const source = uploaded.result as { url: string; name: string };
      state = await service.apply({ documentId: id, action: { type: "update_node", nodeId: imageInputId, patch: { output: { status: "success", text: "", media: [{ url: source.url, kind: "image" }], error: "" } } } });
      state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", title: "reverse", prompt: "write a prompt", mode: "describe" } });
      const textId = state.document!.nodes.find((node) => node.id !== imageInputId)!.id;
      await service.apply({ documentId: id, action: { type: "connect", from: imageInputId, to: textId } });
      state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "image", title: "render", prompt: "", mode: "text2image" } });
      const imageOutputId = state.document!.nodes.find((node) => node.type === "image" && node.id !== imageInputId)!.id;
      await service.apply({ documentId: id, action: { type: "update_node", nodeId: imageOutputId, patch: { metadata: { model: "matrix-image", ratio: "1:1", resolution: "1K" } } } });
      await service.apply({ documentId: id, action: { type: "connect", from: textId, to: imageOutputId } });

      // First text run populates the uploader and connector-runner caches.
      state = await service.apply({ documentId: id, action: { type: "run", nodeId: textId } });
      const firstTask = (state.result as { id: string }).id;
      await eventually(async () => {
        const current = await service.getState({ documentId: id });
        const output = current.document!.nodes.find((node) => node.id === textId)!.metadata.output;
        if (output.status === "error") throw new Error(`text run failed: ${JSON.stringify(output.error)}`);
        expect(current.tasks.find((task) => task.id === firstTask)?.status).toBe("done");
        expect(output.text).toBe("synthetic reverse prompt");
      });
      const listAfterFirst = listCalls;
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ mime: "image/png" });
      expect(uploads[0]!.bytes).toBeGreaterThan(0);

      // Ordinary capability/adjacent-consumer refreshes must not invalidate
      // either cached reference.
      await native.hostConnector.list();
      await Promise.all([native.hostConnector.list(), native.hostConnector.list()]);
      state = await service.apply({ documentId: id, action: { type: "run", nodeId: textId } });
      const secondTask = (state.result as { id: string }).id;
      await eventually(async () => {
        const current = await service.getState({ documentId: id });
        expect(current.tasks.find((task) => task.id === secondTask)?.status).toBe("done");
      });
      expect(uploadCalls).toBe(2);
      expect(describeCalls).toBe(2);
      expect(refs.upload).toHaveLength(2);
      expect(refs.describe).toHaveLength(2);
      expect(refs.upload[1]).toBe(refs.upload[0]);
      expect(refs.describe[1]).toBe(refs.describe[0]);
      expect(listCalls).toBeGreaterThan(listAfterFirst);

      // An account fence invalidates the old handles, but the uploader may
      // rediscover once because the stale call was not dispatched.
      credentials = { ...credentials };
      gateway.authContextChanged();
      state = await service.apply({ documentId: id, action: { type: "run", nodeId: textId } });
      const thirdTask = (state.result as { id: string }).id;
      await eventually(async () => {
        const current = await service.getState({ documentId: id });
        expect(current.tasks.find((task) => task.id === thirdTask)?.status).toBe("done");
      });
      expect(uploadCalls).toBe(3);

      // The downstream image node uses the same reference lifecycle for the
      // real text2image connector submit. Refresh inventories while the call
      // is in flight; the resolved handle must remain valid.
      state = await service.apply({ documentId: id, action: { type: "run", nodeId: imageOutputId } });
      const renderTask = (state.result as { id: string }).id;
      await started;
      await native.hostConnector.list();
      await native.hostConnector.list();
      releaseGenerate();
      await eventually(async () => {
        const current = await service.getState({ documentId: id });
        expect(current.tasks.find((task) => task.id === renderTask)?.status).toBe("done");
        expect(current.document!.nodes.find((node) => node.id === imageOutputId)!.metadata.output.status).toBe("success");
      });
      const final = await service.getState({ documentId: id });
      const output = final.document!.nodes.find((node) => node.id === imageOutputId)!.metadata.output;
      expect(output.media).toHaveLength(1);
      expect(output.media[0]!.kind).toBe("image");
      expect(output.media[0]!.url).toBe(`${base}/generated.png`);
      const imageResponse = await fetch(output.media[0]!.url);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await imageResponse.arrayBuffer()).subarray(0, 8).toString("hex").startsWith("89504e47")).toBe(true);
      expect(generateCalls).toBe(1);
      expect(generated).toBe(true);
      expect(refs.generate).toHaveLength(1);
      expect(describeCalls).toBe(3);
    } finally {
      await native.close();
      await gateway.close();
    }
  }, 30_000);
});
