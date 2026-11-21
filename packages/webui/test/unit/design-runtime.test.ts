import { mkdir, mkdtemp, readFile, writeFile, symlink, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebuiDesignService, type WebuiDesignService } from "../../src/runtime/design/design-service.js";
import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";

const scratch = process.env.WEBUI_DESIGN_TEST_ROOT ?? path.join(homedir(), ".cache/minimax-code-test-artifacts/design");
const services: WebuiDesignService[] = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
async function create() { await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(path.join(scratch, "runtime-")); const service = await createWebuiDesignService(directory); services.push(service); return { service, directory }; }
type Inventory = Awaited<ReturnType<NativeDesignExecution["hostConnector"]["list"]>>;
const emptyInventory = (): Inventory => ({ tools: [], providerFailures: [], partial: false });
function execution(run: NativeDesignExecution["agent"]["run"]): NativeDesignExecution { return { agent: { models: async () => ({ models: [], default: { providerId: "minimax", modelId: "M3" } }), run, reply: async () => ({}), answer: async () => ({ sessionId: "synthetic", status: "finished" }) }, hostConnector: { list: async () => emptyInventory(), call: async () => { throw new Error("No provider configured in synthetic execution test"); } }, close: async () => {} }; }
async function eventually(check: () => Promise<void>) { let error: unknown; for (let count = 0; count < 100; count++) { try { await check(); return; } catch (failure) { error = failure; await new Promise((resolve) => setTimeout(resolve, 25)); } } throw error; }
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });

describe("native Design persistence and execution", () => {
  it("persists bounded close-page editor patches against their genuine fields without adopting old output or erasing newer products", async () => {
    const { service } = await create();
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "original prompt" } });
    const baseNode = state.document!.nodes[0];
    state = await service.apply({ documentId: id, action: { type: "publish", sourceNodeId: baseNode.id, name: "new-product.png", base64: png } });
    expect((state.result as { createdNodeIds: string[] }).createdNodeIds).toEqual([state.document!.nodes[1].id]);
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId: baseNode.id, patch: { output: { text: "new authoritative result", status: "success" } } } });
    const current = state.document!, product = current.nodes[1];
    state = await service.apply({ documentId: id, action: { type: "save_draft_edits", edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { prompt: "last 350 ms unsaved input" } } }] } });
    expect(state.document).toEqual(current);
    expect(state.draft!.document.nodes[0].metadata.output.text).toBe("new authoritative result");
    expect(state.draft!.baseDocument.nodes[0].metadata.prompt).toBe("original prompt");
    state = await service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "restore_draft", draftRevision: state.draft!.revision } });
    expect(state.document!.nodes[0].metadata.prompt).toBe("last 350 ms unsaved input");
    expect(state.document!.nodes[0].metadata.output.text).toBe("new authoritative result"); expect(state.document!.nodes[1]).toEqual(product);
    state = await service.apply({ documentId: id, action: { type: "save_draft_edits", edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { prompt: "conflicting stale text" } } }] } });
    await expect(service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "restore_draft", draftRevision: state.draft!.revision } })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("prompt") });
    await expect(service.apply({ documentId: id, action: { type: "save_draft_edits", edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { prompt: "汉".repeat(24000) } } }] } })).rejects.toMatchObject({ code: "payload_too_large", message: "Design close-page draft exceeds the 64 KiB JSON limit" });
    await expect(service.apply({ documentId: id, action: { type: "save_draft_edits", edits: [{ nodeId: baseNode.id, baseNode, patch: { metadata: { output: { text: "cannot forge output" } } } }] } } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENTS", message: "Design draft metadata may contain only prompt, segments, mentions and template fields" });
  });
  it("keeps existing missing references editable and recoverable while refusing new missing or symbolic references", async () => {
    const { service, directory } = await create();
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image" } }); const nodeId = state.document!.nodes[0].id;
    const uploaded = await service.apply({ documentId: id, action: { type: "upload", name: "retained.png", kind: "image", base64: png } }); const media = uploaded.result as { url: string; name: string };
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { media: [{ url: media.url, kind: "image" }], status: "success" } } } });
    const asset = path.join(directory, "webui/design/uploads", media.name), held = `${asset}.held`;
    await rename(asset, held);
    try {
      state = await service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "update_node", nodeId, patch: { title: "Missing but editable", output: { missing: true } } } });
      expect(state.document!.nodes[0].metadata.output).toMatchObject({ missing: true, media: [{ url: media.url }] });
      state = await service.apply({ documentId: id, action: { type: "save", document: { ...state.document!, viewport: { x: 100, y: 125, k: 1.2 } } } });
      const base = state.document!;
      state = await service.apply({ documentId: id, action: { type: "save_draft", baseDocument: base, document: { ...base, title: "Recovered missing material draft" } } });
      state = await service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "restore_draft", draftRevision: state.draft!.revision } });
      expect(state.document!.title).toBe("Recovered missing material draft");
      await expect(service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { media: [{ url: "/design-assets/uploads/not-real.png", kind: "image" }] } } } })).rejects.toMatchObject({ code: "MEDIA_MISSING" });
      if (process.platform !== "win32") {
        await symlink(held, asset);
        try { await expect(service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { title: "Symbolic reference is still invalid" } } })).rejects.toMatchObject({ code: "MEDIA_MISSING" }); }
        finally { await unlink(asset); }
      }
    } finally { await rename(held, asset); }
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { missing: false } } } });
    expect(state.document!.nodes[0].metadata.output).toMatchObject({ missing: false, media: [{ url: media.url }] });
  });

  it("projects real library size/reference metadata and only collects unreferenced files across documents and drafts", async () => {
    const { service } = await create();
    let state = await service.apply({ action: { type: "create", title: "reference board" } }); const id = state.document!.id;
    expect(state.document!.backgroundMode).toBe("lines");
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image", title: "kept input" } });
    const first = await service.apply({ documentId: id, action: { type: "upload", name: "kept.png", kind: "image", base64: png } }); const kept = first.result as { url: string; name: string };
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId: state.document!.nodes[0].id, patch: { output: { status: "success", text: "", media: [{ url: kept.url, kind: "image" }], error: "" } } } });
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId: state.document!.nodes[0].id, patch: { output: { width: 1, height: 1 } } } });
    expect(state.document!.nodes[0].metadata.output).toMatchObject({ status: "success", width: 1, height: 1, media: [{ url: kept.url, kind: "image" }] });
    const base = state.document!;
    const second = await service.apply({ documentId: id, action: { type: "upload", name: "draft.png", kind: "image", base64: png } }); const draftMedia = second.result as { url: string; name: string };
    const draft = { ...base, nodes: base.nodes.map((node) => ({ ...node, metadata: { ...node.metadata, output: { ...node.metadata.output, media: [{ url: draftMedia.url, kind: "image" as const }] } } })) };
    state = await service.apply({ documentId: id, action: { type: "save_draft", document: draft, baseDocument: base } });
    const third = await service.apply({ documentId: id, action: { type: "upload", name: "unused.png", kind: "image", base64: png } }); const unused = third.result as { url: string; name: string };
    await service.apply({ action: { type: "create", title: "other board" } });
    state = await service.getState({ documentId: id });
    expect(state.library.find((asset) => asset.url === kept.url)).toMatchObject({ title: "kept input", canvasId: id, inUse: true, bytes: Buffer.from(png, "base64").length });
    expect(state.library.find((asset) => asset.url === draftMedia.url)?.inUse).toBe(true);
    const collected = await service.apply({ action: { type: "gc_library" } });
    expect(collected.result).toEqual({ removed: [unused.name] });
    expect(collected.library.map((asset) => asset.url).sort()).toEqual([kept.url, draftMedia.url].sort());
    await expect(service.apply({ action: { type: "remove_media", name: draftMedia.name } })).rejects.toMatchObject({ code: "IN_USE" });
  });

  it("persists genuine unsaved drafts, merges geometry over new runtime products and fences conflicting restore", async () => {
    const { service, directory } = await create();
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "base" } });
    const base = state.document!, source = base.nodes[0];
    const document = { ...base, nodes: [{ ...source, position: { x: 725, y: 150 } }] };
    state = await service.apply({ documentId: id, expectedRevision: "stale-but-saving-draft-does-not-edit-authority", action: { type: "save_draft", document, baseDocument: base } });
    const draftRevision = state.draft!.revision;
    expect(JSON.parse(await readFile(path.join(directory, "webui/design/drafts", `${id}.json`), "utf8")).document.nodes[0].position.x).toBe(725);
    state = await service.apply({ documentId: id, action: { type: "publish", name: "new-runtime-product.png", sourceNodeId: source.id, base64: png } });
    const product = state.document!.nodes[1];
    await expect(service.apply({ documentId: id, expectedRevision: base.updatedAt, action: { type: "restore_draft", draftRevision } })).rejects.toMatchObject({ code: "CONFLICT" });
    state = await service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "restore_draft", draftRevision } });
    expect(state.document!.nodes[0].position.x).toBe(725); expect(state.document!.nodes[1]).toEqual(product); expect(state.draft).toBeUndefined(); expect(state.committedRevision).toBe(state.document!.updatedAt);
    const latest = state.document!;
    state = await service.apply({ documentId: id, action: { type: "save_draft", document: { ...latest, title: "unsaved title" }, baseDocument: latest } });
    const conflictingDraft = state.draft!.revision;
    state = await service.apply({ documentId: id, action: { type: "save", document: { ...latest, title: "new external title" } } });
    await expect(service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "restore_draft", draftRevision: conflictingDraft } })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("title") });
    state = await service.getState({ documentId: id }); expect(state.document!.title).toBe("new external title"); expect(state.draft!.revision).toBe(conflictingDraft);
  });

  it("reads live voice inventory through the execution port and exposes unavailable state without synthetic voices", async () => {
    const { service } = await create();
    let state = await service.apply({ action: { type: "list_voices" } });
    expect(state.voices).toEqual([]); expect(state.voiceSource).toBe("no-connector"); expect(state.voiceError).toContain("未授予");
    const native = execution(async () => ({ sessionId: "voice-test", status: "finished" })); let calls = 0;
    await service.attachExecution({ ...native, hostConnector: { list: async () => ({ tools: [{ toolRef: "owned-ref", name: "connector__matrix__get_voice_list", inputSchema: {} }], providerFailures: [], partial: false }), call: async (reference) => { expect(reference).toBe("owned-ref"); calls++; return { value: [{ type: "text", text: JSON.stringify({ available_voices: [{ voice_id: "actual-id", voice_name: "Actual catalogue name" }] }) }] }; } } });
    state = await service.apply({ action: { type: "list_voices" } }); expect(state.voices).toEqual([{ value: "actual-id", label: "Actual catalogue name" }]); expect(state.voiceError).toBeUndefined();
    await service.getState({}); await service.getState({}); expect(calls).toBe(1);
  });

  it("exports only Design-owned templates/media to explicit existing destinations and requires replacement confirmation", async () => {
    const { service, directory } = await create(); const targetDir = path.join(directory, "explicit-exports"); await mkdir(targetDir);
    let state = await service.apply({ action: { type: "create", title: "Template board" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "template steps" } });
    const target = path.join(targetDir, "saved.json");
    state = await service.apply({ documentId: id, action: { type: "export_file", path: target, source: { type: "document_template" } } });
    expect(state.result).toMatchObject({ path: target, name: "saved.json" }); expect(JSON.parse(await readFile(target, "utf8")).actions).toHaveLength(1);
    await expect(service.apply({ documentId: id, action: { type: "export_file", path: target, source: { type: "document_template" } } })).rejects.toMatchObject({ code: "EXISTS" });
    await service.apply({ documentId: id, action: { type: "export_file", path: target, source: { type: "document_template" }, overwrite: true } });
    const uploaded = await service.apply({ documentId: id, action: { type: "upload", name: "source.png", kind: "image", base64: png } }); const media = uploaded.result as { url: string; kind: "image" };
    const image = path.join(targetDir, "saved.png"); await service.apply({ action: { type: "export_file", path: image, source: { type: "media", media } } }); expect(await readFile(image)).toEqual(Buffer.from(png, "base64"));
    await expect(service.apply({ action: { type: "export_file", path: path.join(targetDir, "not-readable.png"), source: { type: "media", media: { url: "file:///etc/passwd", kind: "image" } } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    if (process.platform !== "win32") { const link = path.join(targetDir, "link.png"); await symlink(image, link); await expect(service.apply({ action: { type: "export_file", path: link, overwrite: true, source: { type: "media", media } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" }); }
  });
  it("persists metadata, supports undo CAS, rejects stale saves, survives reconstruction and cleans deleted intents", async () => {
    const { service, directory } = await create();
    let state = await service.apply({ sessionId: "session", action: { type: "open" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "original" } });
    const old = state.document!;
    const nodeId = old.nodes[0].id;
    state = await service.apply({ documentId: id, expectedRevision: old.updatedAt, action: { type: "update_node", nodeId, patch: { metadata: { ...old.nodes[0].metadata, prompt: "edited", mode: "prompt" } } } });
    expect(state.document!.nodes[0].metadata.prompt).toBe("edited");
    await expect(service.apply({ documentId: id, expectedRevision: old.updatedAt, action: { type: "save", document: old } })).rejects.toMatchObject({ code: "CONFLICT" });
    state = await service.apply({ documentId: id, expectedRevision: state.document!.updatedAt, action: { type: "save", document: old } });
    expect(state.document!.nodes[0].metadata.prompt).toBe("original");
    expect(state.document!.updatedAt).not.toBe(old.updatedAt);
    await service.close(); services.splice(services.indexOf(service), 1);
    const reconstructed = await createWebuiDesignService(directory); services.push(reconstructed);
    expect((await reconstructed.getState({ sessionId: "session" })).document!.id).toBe(id);
    await reconstructed.apply({ sessionId: "session", documentId: id, action: { type: "remove" } });
    const reopened = await reconstructed.apply({ sessionId: "session", action: { type: "open" } });
    expect(reopened.document!.id).not.toBe(id);
    await expect(reconstructed.getState({ documentId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await readFile(path.join(directory, "webui/design/state.json"), "utf8")).not.toContain(id);
  });

  it("protects referenced uploads and materializes browser-published images as independent products", async () => {
    const { service } = await create();
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image" } }); const sourceNodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "publish", sourceNodeId, name: "crop.png", base64: png } });
    const result = state.result as { url: string; name?: string };
    const name = result.url.split("/").pop()!;
    expect(state.document!.nodes).toHaveLength(2);
    expect(state.document!.nodes[1].metadata.sourceNodeId).toBe(sourceNodeId);
    expect(state.document!.nodes[1].metadata.output.media[0].url).toBe(result.url);
    await expect(service.apply({ documentId: id, action: { type: "remove_media", name } })).rejects.toMatchObject({ code: "IN_USE" });
    expect((await service.readAsset({ kind: "assets", name }))!.bytes.length).toBeGreaterThan(0);
    await service.apply({ documentId: id, action: { type: "remove" } });
    await service.apply({ action: { type: "remove_media", name } });
    expect(await service.readAsset({ kind: "assets", name })).toBeNull();
  });

  it("keeps previous products on errors, stops dependent work and does not churn idle revisions", async () => {
    const { service } = await create(); const calls: string[] = [];
    await service.attachExecution(execution(async (input) => { calls.push(input.text); return { sessionId: "synthetic", status: "error", error: { code: "SYNTHETIC_REFUSAL", message: "synthetic refusal" } }; }));
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "upstream" } }); const first = state.document!.nodes[0];
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "downstream" } }); const second = state.document!.nodes[1];
    state = await service.apply({ documentId: id, action: { type: "connect", from: first.id, to: second.id } });
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId: first.id, patch: { metadata: { output: { status: "idle", text: "previous product", media: [], error: "" } } } } });
    const run = await service.apply({ documentId: id, action: { type: "run", nodeId: first.id } });
    const taskId = (run.result as { id: string }).id;
    await eventually(async () => {
      const settled = await service.getState({ documentId: id });
      expect(settled.document!.nodes[0].metadata.output.status).toBe("error");
      // The node product is saved before the task journal records settlement.
      expect(settled.tasks.find((task) => task.id === taskId)).toMatchObject({
        status: "error", startedAt: expect.any(Number), finishedAt: expect.any(Number),
      });
      state = settled;
    });
    expect(state.document!.nodes[0].metadata.output.text).toBe("previous product"); expect(calls).toHaveLength(1);
    const finishedAt = state.tasks.find((task) => task.id === taskId)!.finishedAt;
    const revision = state.document!.updatedAt; await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await service.getState({ documentId: id }); expect(after.document!.updatedAt).toBe(revision); expect(after.tasks.find((task) => task.id === taskId)?.finishedAt).toBe(finishedAt);
  });

  it("executes upstream chains in order and preserves populated boards when applying templates", async () => {
    const { service } = await create(); const calls: string[] = [];
    await service.attachExecution(execution(async (input) => { calls.push(input.text); return { sessionId: "synthetic", status: "finished", text: `product ${calls.length}` }; }));
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "upstream" } }); const first = state.document!.nodes[0];
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "downstream" } }); const second = state.document!.nodes[1];
    await service.apply({ documentId: id, action: { type: "connect", from: first.id, to: second.id } });
    await service.apply({ documentId: id, action: { type: "run", nodeId: second.id } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes.find((node) => node.id === second.id)!.metadata.output.status).toBe("success"));
    expect(calls).toHaveLength(2); expect(calls[1]).toContain("product 1");
    const templateId = (await service.getState({ documentId: id })).templates[0].id;
    const applied = await service.apply({ documentId: id, action: { type: "apply_template", templateId } });
    expect(applied.document!.id).not.toBe(id); expect(applied.document!.nodes.length).toBeGreaterThan(0);
    expect((await service.getState({ documentId: id })).document!.nodes.find((node) => node.id === first.id)).toBeDefined();
    const imported = { id: "local-only", title: "Imported file", actions: [{ type: "add_node", args: { type: "text", prompt: "imported steps" } }] };
    const opened = await service.apply({ documentId: id, action: { type: "apply_template", template: imported } });
    expect(opened.document!.id).not.toBe(id); expect(opened.document!.title).toBe("Imported file"); expect(opened.document!.nodes[0].metadata.prompt).toBe("imported steps");
    expect(opened.templates.some((template) => template.id === "local-only")).toBe(false);
    const empty = await service.apply({ action: { type: "create" } });
    const reused = await service.apply({ documentId: empty.document!.id, action: { type: "apply_template", template: imported } });
    expect(reused.document!.id).toBe(empty.document!.id); expect(reused.document!.title).toBe("Imported file");
    await expect(service.apply({ documentId: id, action: { type: "apply_template", template: { ...imported, actions: [] } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(service.apply({ documentId: id, action: { type: "apply_template", templateId, template: imported } as never })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("refuses a mode that requires an image before any model request when no material is connected", async () => {
    const { service } = await create();
    let calls = 0;
    await service.attachExecution(execution(async () => { calls++; return { sessionId: "synthetic", status: "finished", text: "should not run" }; }));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "写出一段能复刻这张图的提示词" } });
    const nodeId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { metadata: { mode: "describe" } } } });
    await expect(service.apply({ documentId: id, action: { type: "run", nodeId } })).rejects.toMatchObject({ code: "MATERIAL_REQUIRED" });
    expect(calls).toBe(0);
  });

  it("sends the host-bound document, node and execution facts with a no-tool profile", async () => {
    const { service } = await create();
    let seen: { text?: string; capabilitySelection?: unknown } = {};
    await service.attachExecution(execution(async (input) => {
      seen = input as { text?: string; capabilitySelection?: unknown };
      return { sessionId: "synthetic", status: "finished", text: "a quiet result" };
    }));
    let state = await service.apply({ action: { type: "create", title: "Bound board" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "写一首关于秋天的短诗" } });
    const nodeId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("success"));
    expect(seen.text).toContain(`文档：${id}`);
    expect(seen.text).toContain("Bound board");
    expect(seen.text).toContain(`目标节点：${nodeId}`);
    expect(seen.text).toContain("执行 ID：x_");
    expect(seen.text).toContain("你没有工具");
    expect(seen.capabilitySelection).toEqual({ tools: [] });
  });

  it("rejects a late result after the node's relevant input changed, while a viewport move keeps it valid", async () => {
    const { service } = await create();
    let finish!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    const running = new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => { finish = resolve; });
    await service.attachExecution(execution(async () => running));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "original prompt" } });
    const nodeId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    const before = (await service.getState({ documentId: id })).document!;
    await service.apply({ documentId: id, expectedRevision: before.updatedAt, action: { type: "save", document: { ...before, viewport: { x: 900, y: 700, k: 2 } } } });
    await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { metadata: { prompt: "changed while running" } } } });
    finish({ sessionId: "synthetic", status: "finished", text: "late old result" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("error"));
    const after = (await service.getState({ documentId: id })).document!;
    expect(after.nodes[0].metadata.output.text).not.toBe("late old result");
    expect(after.nodes[0].metadata.output.error).toContain("输入在生成期间发生了变化");
    expect(after.viewport).toEqual({ x: 900, y: 700, k: 2 });
  });

  it("writes a result after only the viewport moved", async () => {
    const { service } = await create();
    let finish!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    const running = new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => { finish = resolve; });
    await service.attachExecution(execution(async () => running));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "stable prompt" } });
    const nodeId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    const before = (await service.getState({ documentId: id })).document!;
    await service.apply({ documentId: id, expectedRevision: before.updatedAt, action: { type: "save", document: { ...before, viewport: { x: 12, y: 34, k: 0.5 } } } });
    finish({ sessionId: "synthetic", status: "finished", text: "valid result" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("success"));
    expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.text).toBe("valid result");
  });

  it("writes the native error DTO message and keeps the previous product", async () => {
    const { service } = await create();
    await service.attachExecution(execution(async () => ({
      sessionId: "synthetic",
      status: "error" as const,
      error: { code: "MODEL_UNAVAILABLE", message: "Synthetic provider is offline" },
    })));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "write something" } });
    const nodeId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { status: "success", text: "previous product", media: [], error: "" } } } });
    await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("error"));
    const output = (await service.getState({ documentId: id })).document!.nodes[0].metadata.output;
    expect(output.text).toBe("previous product");
    expect(output.error).toContain("Synthetic provider is offline");
    expect((await service.getState({ documentId: id })).tasks[0]?.errorCode).toBe("MODEL_UNAVAILABLE");
  });

  it("rejects a blank text result and keeps the previous product", async () => {
    const { service } = await create();
    await service.attachExecution(execution(async () => ({ sessionId: "synthetic", status: "finished", text: "   " })));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "write something" } });
    const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { output: { status: "success", text: "previous product", media: [], error: "" } } } });
    await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("error"));
    const output = (await service.getState({ documentId: id })).document!.nodes[0].metadata.output;
    expect(output.text).toBe("previous product");
    expect(output.error).toContain("没有返回可用的文本结果");
  });

  it("does not let a late response after cancel revive the node or its task", async () => {
    const { service } = await create();
    let finish!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    const running = new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => { finish = resolve; });
    await service.attachExecution(execution(async () => running));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "cancel me" } });
    const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const taskId = (state.result as { id: string }).id;
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    await service.apply({ documentId: id, action: { type: "cancel", taskId } });
    finish({ sessionId: "synthetic", status: "finished", text: "late cancelled result" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("interrupted"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await service.getState({ documentId: id });
    expect(after.document!.nodes[0].metadata.output.text).not.toBe("late cancelled result");
    expect(after.document!.nodes[0].metadata.output.status).toBe("interrupted");
    expect(after.tasks.find((task) => task.id === taskId)?.status).toBe("interrupted");
  });

  it("accepts a result when only the node prompt's trailing whitespace changed", async () => {
    const { service } = await create();
    let finish!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    await service.attachExecution(execution(async () => new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => { finish = resolve; })));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "original prompt" } });
    const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { metadata: { prompt: "original prompt " } } } });
    finish({ sessionId: "synthetic", status: "finished", text: "accepted trailing-space result" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("success"));
    expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.text).toBe("accepted trailing-space result");
  });

  it("aborts a stale run when its inputs change and lets the same node retry without BUSY", async () => {
    const { service } = await create();
    let calls = 0;
    const signals: (AbortSignal | undefined)[] = [];
    let finishFirst!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    let finishSecond!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    await service.attachExecution(execution(async (_input, options) => {
      calls += 1;
      signals.push(options?.signal);
      return new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => {
        if (calls === 1) finishFirst = resolve;
        else finishSecond = resolve;
      });
    }));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "original input" } });
    const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const firstTaskId = (state.result as { id: string }).id;
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    await service.apply({ documentId: id, action: { type: "update_node", nodeId, patch: { metadata: { prompt: "changed while running" } } } });
    await eventually(async () => {
      const after = await service.getState({ documentId: id });
      expect(after.document!.nodes[0].metadata.output.status).toBe("error");
      expect(after.tasks.find((task) => task.id === firstTaskId)?.status).toBe("error");
    });
    expect(signals[0]?.aborted).toBe(true);
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const secondTaskId = (state.result as { id: string }).id;
    expect(secondTaskId).not.toBe(firstTaskId);
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    finishFirst({ sessionId: "synthetic", status: "finished", text: "late stale result" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.text).not.toBe("late stale result");
    finishSecond({ sessionId: "synthetic", status: "finished", text: "retry accepted" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("success"));
    expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.text).toBe("retry accepted");
    expect(signals[1]?.aborted).toBe(false);
  });

  it("lets a new run replace a cancelled one and rejects the old run's late result", async () => {
    const { service } = await create();
    let calls = 0;
    let finishFirst!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    let finishSecond!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    await service.attachExecution(execution(async () => {
      calls += 1;
      return new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => {
        if (calls === 1) finishFirst = resolve;
        else finishSecond = resolve;
      });
    }));
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "replace me" } });
    const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const firstTaskId = (state.result as { id: string }).id;
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    await service.apply({ documentId: id, action: { type: "cancel", taskId: firstTaskId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("interrupted"));
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const secondTaskId = (state.result as { id: string }).id;
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.status).toBe("loading"));
    finishSecond({ sessionId: "synthetic", status: "finished", text: "second result" });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes[0].metadata.output.text).toBe("second result"));
    finishFirst({ sessionId: "synthetic", status: "finished", text: "first late result" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await service.getState({ documentId: id });
    expect(after.document!.nodes[0].metadata.output.text).toBe("second result");
    expect(after.document!.nodes[0].metadata.output.status).toBe("success");
    expect(after.tasks.find((task) => task.id === firstTaskId)?.status).toBe("interrupted");
    expect(after.tasks.find((task) => task.id === secondTaskId)?.status).toBe("done");
  });

  it("shows a task and loading state before deferred understanding, and cancel aborts its signal without a model call", async () => {
    const { service } = await create();
    let understandingSignal: AbortSignal | undefined;
    let resolveUnderstanding!: (value: unknown) => void;
    const understanding = new Promise<unknown>((resolve) => { resolveUnderstanding = resolve; });
    let connectorCalls = 0;
    const agentRun = vi.fn(async () => ({ sessionId: "synthetic", status: "finished" as const, text: "model result" }));
    await service.attachExecution({
      agent: {
        models: async () => ({ models: [], default: { providerId: "minimax", modelId: "M3" } }),
        run: agentRun,
        reply: async () => ({}),
        answer: async () => ({ sessionId: "synthetic", status: "finished" as const }),
      },
      hostConnector: {
        list: async () => ({ tools: [{ toolRef: "describe", name: "matrix_describe_images", inputSchema: {} }], providerFailures: [], partial: false }),
        call: async (_reference: string, _input: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }) => {
          connectorCalls += 1;
          understandingSignal = options?.signal;
          return understanding;
        },
      },
      close: async () => undefined,
    });
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image", title: "参考图" } });
    const imageId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "update_node", nodeId: imageId, patch: { output: { status: "success", text: "", media: [{ url: "https://example.invalid/reference.png", kind: "image" }], error: "" } } } });
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", title: "反推提示词", prompt: "写出一段能复刻这张图的提示词" } });
    const textId = state.document!.nodes.find((node) => node.id !== imageId)!.id;
    await service.apply({ documentId: id, action: { type: "connect", from: imageId, to: textId } });
    const running = service.apply({ documentId: id, action: { type: "run", nodeId: textId } });
    await eventually(async () => {
      const current = await service.getState({ documentId: id });
      const task = current.tasks.find((entry) => entry.nodeId === textId);
      expect(task).toBeDefined();
      expect(task!.status).toBe("running");
      expect(current.document!.nodes.find((node) => node.id === textId)!.metadata.output.status).toBe("loading");
    });
    await eventually(async () => expect(connectorCalls).toBeGreaterThan(0));
    expect(understandingSignal?.aborted).toBe(false);
    const current = await service.getState({ documentId: id });
    const taskId = current.tasks.find((entry) => entry.nodeId === textId)!.id;
    await service.apply({ documentId: id, action: { type: "cancel", taskId } });
    expect(understandingSignal?.aborted).toBe(true);
    resolveUnderstanding({ value: { results: [{ success: true, description: "late understanding" }] } });
    await running;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await service.getState({ documentId: id });
    expect(agentRun).not.toHaveBeenCalled();
    const node = after.document!.nodes.find((entry) => entry.id === textId)!;
    expect(node.metadata.output.status).toBe("interrupted");
    expect(node.metadata.output.text).not.toBe("model result");
    expect(after.tasks.find((entry) => entry.id === taskId)?.status).toBe("interrupted");
  });

  it("restores a run interrupted during deferred preparation as interrupted", async () => {
    const { service, directory } = await create();
    let resolveUnderstanding!: (value: unknown) => void;
    const understanding = new Promise<unknown>((resolve) => { resolveUnderstanding = resolve; });
    await service.attachExecution({
      agent: {
        models: async () => ({ models: [], default: { providerId: "minimax", modelId: "M3" } }),
        run: async () => ({ sessionId: "synthetic", status: "finished" as const, text: "unused" }),
        reply: async () => ({}),
        answer: async () => ({ sessionId: "synthetic", status: "finished" as const }),
      },
      hostConnector: {
        list: async () => ({ tools: [{ toolRef: "describe", name: "matrix_describe_images", inputSchema: {} }], providerFailures: [], partial: false }),
        call: async () => understanding,
      },
      close: async () => undefined,
    });
    let state = await service.apply({ action: { type: "create" } });
    const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "input", kind: "image", title: "参考图" } });
    const imageId = state.document!.nodes[0].id;
    await service.apply({ documentId: id, action: { type: "update_node", nodeId: imageId, patch: { output: { status: "success", text: "", media: [{ url: "https://example.invalid/reference.png", kind: "image" }], error: "" } } } });
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", title: "反推提示词", prompt: "写出一段能复刻这张图的提示词" } });
    const textId = state.document!.nodes.find((node) => node.id !== imageId)!.id;
    await service.apply({ documentId: id, action: { type: "connect", from: imageId, to: textId } });
    await service.apply({ documentId: id, action: { type: "run", nodeId: textId } });
    await eventually(async () => {
      const current = await service.getState({ documentId: id });
      expect(current.tasks.find((entry) => entry.nodeId === textId)?.status).toBe("running");
      expect(current.document!.nodes.find((node) => node.id === textId)!.metadata.output.status).toBe("loading");
    });
    await service.close();
    resolveUnderstanding({ value: { results: [{ success: true, description: "late understanding" }] } });
    const reopened = await createWebuiDesignService(directory);
    services.push(reopened);
    await reopened.attachExecution(execution(async () => ({ sessionId: "synthetic", status: "finished", text: "unused" })));
    const restored = await reopened.getState({ documentId: id });
    const task = restored.tasks.find((entry) => entry.nodeId === textId);
    expect(task?.status).toBe("interrupted");
    expect(restored.document!.nodes.find((node) => node.id === textId)!.metadata.output.status).toBe("interrupted");
  });

  it("fails closed on corrupted document persistence", async () => {
    const { service, directory } = await create(); const state = await service.apply({ action: { type: "create" } });
    await writeFile(path.join(directory, "webui/design/canvases", `${state.document!.id}.json`), "{broken");
    await expect(service.getState({})).rejects.toThrow();
  });

  it("cancels an active dependency chain and keeps its stable loading revision", async () => {
    const { service } = await create(); let calls = 0;
    await service.attachExecution(execution(async (_input, options) => { calls++; return new Promise((resolve) => { options!.signal!.addEventListener("abort", () => resolve({ sessionId: "synthetic", status: "aborted" }), { once: true }); }); }));
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "upstream" } }); const first = state.document!.nodes[0];
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "downstream" } }); const second = state.document!.nodes[1];
    await service.apply({ documentId: id, action: { type: "connect", from: first.id, to: second.id } });
    state = await service.apply({ documentId: id, action: { type: "run", nodeId: second.id } }); const taskId = (state.result as { id: string }).id;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const revision = (await service.getState({ documentId: id })).document!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect((await service.getState({ documentId: id })).document!.updatedAt).toBe(revision);
    await service.apply({ documentId: id, action: { type: "cancel", taskId } });
    await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes.find((node) => node.id === first.id)!.metadata.output.status).toBe("interrupted"));
    expect(calls).toBe(1); expect((await service.getState({ documentId: id })).document!.nodes.find((node) => node.id === second.id)!.metadata.output.status).not.toBe("success");
  });

  it("identifies its committed revision when a runtime settlement enters the fresh mutation response", async () => {
    const { service } = await create();
    let finish!: (value: { sessionId: string; status: "finished"; text: string }) => void;
    const running = new Promise<{ sessionId: string; status: "finished"; text: string }>((resolve) => { finish = resolve; });
    let release!: (value: Inventory) => void; let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const inventory = new Promise<Inventory>((resolve) => { release = resolve; });
    let hold = false;
    const native = execution(async () => running);
    await service.attachExecution({ ...native, hostConnector: { ...native.hostConnector, list: async () => { if (hold) { hold = false; enter(); return inventory; } return emptyInventory(); } } });
    let state = await service.apply({ action: { type: "create" } }); const id = state.document!.id;
    state = await service.apply({ documentId: id, action: { type: "add_node", nodeType: "text", prompt: "request" } }); const nodeId = state.document!.nodes[0].id;
    state = await service.apply({ documentId: id, action: { type: "run", nodeId } });
    const before = state.document!; const originalNow = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(originalNow + 61000); hold = true;
    try {
      const saving = service.apply({ documentId: id, expectedRevision: before.updatedAt, action: { type: "save", document: { ...before, nodes: before.nodes.map((node) => ({ ...node, position: { x: 480, y: 240 } })) } } });
      await entered;
      finish({ sessionId: "synthetic", status: "finished", text: "runtime product while assembling response" });
      await eventually(async () => expect((await service.getState({ documentId: id })).document!.nodes.find((node) => node.id === nodeId)!.metadata.output.status).toBe("success"));
      release(emptyInventory());
      const response = await saving;
      expect(response.committedRevision).toBeTypeOf("string"); expect(response.committedRevision).not.toBe(response.document!.updatedAt);
      expect(response.document!.nodes[0].metadata.output.text).toBe("runtime product while assembling response"); expect(response.document!.nodes[0].position).toEqual({ x: 480, y: 240 });
    } finally { clock.mockRestore(); release(emptyInventory()); finish({ sessionId: "synthetic", status: "finished", text: "cleanup" }); }
  });
});
