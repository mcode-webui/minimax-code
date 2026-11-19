import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignNodeCard } from "../../src/client/features/design/ui/DesignNodeCard.js";
import type { ApplyDesignActionRequest, DesignDocument, DesignNode, DesignState } from "../../src/shared/contracts/design.js";
import { createDesignOwner } from "../../src/client/features/design/application/design-owner.js";
import { designPlaceProducts, designLibraryPosition, designFailureReport } from "../../src/client/features/design/projection/design-view.js";
import { cloneDesignSelection, designAddedNodeId, designCenterView, designDownstreamTypes, designEdgePath, designMinimap, designNewNodePosition, designPromptSegments, designQuestionAnswered, designQuestionChoice, designQuestionOther, designWorldPoint, designZoom, mergeDesignGesture } from "../../src/client/features/design/projection/design-view.js";
import { readTemplateFile, templateFile, templateFromCanvas } from "../../src/shared/design/actions.mjs";
import { NODE_KINDS } from "../../src/shared/design/forms.mjs";
import { cardLayers, chipPress, groupMembers, nodeMenuEntries, panelFields, paramFields, paramSummary } from "../../src/shared/design/node-ui.mjs";
import { designFitView, designGroupSelection, designNextTitle, designRemoveSelection } from "../../src/client/features/design/projection/design-commands.js";

const document = (id: string, revision = "1"): DesignDocument => ({ id, title: id, nodes: [], connections: [], backgroundMode: "dots", viewport: { x: 80, y: 60, k: 1 }, createdAt: "1", updatedAt: revision });
const state = (doc: DesignDocument): DesignState => ({ document: doc, documents: [{ ...doc, nodeCount: doc.nodes.length }], templates: [], capabilities: {}, models: [], defaultModelKey: null, tasks: [], library: [], mediaStatus: {} });
const node = (id: string): DesignNode => ({ id, type: "input", title: id, position: { x: 0, y: 0 }, width: 320, height: 400, metadata: { kind: "image", prompt: "", mode: null, model: null, ratio: null, resolution: null, duration: null, count: 1, voice: null, emotion: null, sessionId: null, segments: [], mentions: [], output: { status: "idle", text: "", media: [], error: "" } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe("native Design owner", () => {
  it("renders a failed generator's full error and four original recovery actions, and reports its stable identity", () => {
    const failed: DesignNode = { ...node("failure-id"), type: "text", title: "创作节点", metadata: { ...node("failure-id").metadata, kind: "text", output: { status: "error", text: "", media: [], error: "实际处理失败" } } };
    const doc = { ...document("A"), nodes: [failed] };
    const html = renderToStaticMarkup(createElement(DesignNodeCard, { node: failed, document: doc, data: state(doc), selected: false, busy: false, getDocument: () => doc, onRenameEnd: () => {}, onSelect: () => {}, onGesture: () => {}, onConnect: () => {}, onPortStart: () => {}, onAction: async () => undefined, onProducts: async () => {}, onFitMedia: async () => undefined, onTool: () => {}, onMenu: () => {}, assetUrl: (url) => url }));
    expect(html).toContain("实际处理失败");
    for (const action of ["重试", "取消", "删除", "上报"]) expect(html).toContain(`>${action}</button>`);
    expect(designFailureReport(failed)).toBe("节点：创作节点\nID：failure-id\n错误：实际处理失败");
  });
  it("inserts a library input at the original center-minus-150/90 position in the current pane", () => {
    expect(designLibraryPosition({ x: 80, y: 60, k: 1 }, { width: 800, height: 600 })).toEqual({ x: 170, y: 150 });
    expect(designLibraryPosition({ x: -240, y: 90, k: 0.5 }, { width: 420, height: 720 })).toEqual({ x: 750, y: 450 });
  });
  it("pastes into the panned and zoomed visible viewport while retaining graph and reference remapping", () => {
    const source = { ...node("source"), position: { x: 1200, y: 800 } }, target = { ...node("target"), position: { x: 1700, y: 800 }, metadata: { ...node("target").metadata, prompt: "[[cw:image:source]]", mentions: [{ nodeId: "source", kind: "image" as const }] } };
    const selection = { nodes: [source, target], connections: [{ id: "line", fromNodeId: "source", toNodeId: "target", kind: "image" }] };
    let sequence = 0;
    const pasted = cloneDesignSelection(selection, () => `copy-${++sequence}`, { viewport: { x: -600, y: -300, k: 0.5 }, viewportSize: { width: 800, height: 600 } });
    expect(pasted.nodes[0]?.position).toEqual({ x: 1840, y: 1000 });
    expect(pasted.nodes[1]?.position).toEqual({ x: 2340, y: 1000 });
    expect(pasted.connections[0]).toMatchObject({ fromNodeId: pasted.nodes[0]!.id, toNodeId: pasted.nodes[1]!.id });
    expect(pasted.nodes[1]!.metadata.mentions[0]?.nodeId).toBe(pasted.nodes[0]!.id);
    expect(pasted.nodes[1]!.metadata.prompt).toBe(`[[cw:image:${pasted.nodes[0]!.id}]]`);
    expect(source.position).toEqual({ x: 1200, y: 800 });
  });
  it("fits a late media decode using the tile width committed ahead of it in the owner queue", async () => {
    const source = node("source"), tile = { ...node("tile"), metadata: { ...node("tile").metadata, output: { ...node("tile").metadata.output, text: "accepted runtime product", media: [{ kind: "image" as const, url: "/design-assets/assets/tile.png" }] } } };
    const before = { ...document("A"), nodes: [source, tile] }, writing = deferred<DesignState>(), requests: ApplyDesignActionRequest[] = [];
    let latest: DesignDocument = before;
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); if (request.action.type === "save") { latest = { ...request.action.document, updatedAt: "2" }; return writing.promise; } if (request.action.type !== "update_node") throw new Error("Unexpected action"); const patch = request.action.patch; latest = { ...latest, updatedAt: "3", nodes: latest.nodes.map((item) => item.id === "tile" ? { ...item, ...patch } as DesignNode : item) }; return { ...state(latest), committedRevision: "3" }; } } });
    await owner.load({ documentId: "A" });
    const layout = owner.placeProducts({ ids: ["tile"], sourceNodeId: "source", tile: true });
    const fit = owner.fitMedia({ nodeId: "tile", sourceUrl: "/design-assets/assets/tile.png", width: 160, height: 120 });
    await Promise.resolve(); await Promise.resolve();
    writing.resolve({ ...state(latest), committedRevision: "2" }); await layout; await fit;
    expect(requests[1]).toMatchObject({ expectedRevision: "2", action: { type: "update_node", patch: { width: 240, height: 200 } } });
    expect(owner.getSnapshot().data?.document?.nodes.find((item) => item.id === "tile")?.metadata.output.text).toBe("accepted runtime product");
    await owner.fitMedia({ nodeId: "tile", sourceUrl: "/design-assets/assets/old.png", width: 160, height: 120 });
    expect(requests).toHaveLength(2); owner.dispose();
  });
  it("saves the camera against the revision the owner queue reaches it with", async () => {
    // The camera can move while a media tool is still running, so the save
    // that carries it reaches the runtime after that tool committed. A save
    // carries the revision its content came from, and the runtime refuses a
    // stale one as "another view changed this" — so the camera save has to
    // carry the revision the queue reaches it with, not the one it captured.
    const before = { ...document("A"), nodes: [node("source"), node("tile")] }, writing = deferred<DesignState>(), requests: ApplyDesignActionRequest[] = [];
    let latest: DesignDocument = before;
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); if (request.action.type === "save") { if (request.expectedRevision !== latest.updatedAt) throw new Error("CONFLICT: Design changed in another view; reload before saving"); latest = { ...request.action.document, updatedAt: "2" }; return writing.promise; } latest = { ...latest, updatedAt: "3" }; return { ...state(latest), committedRevision: "3" }; } } });
    await owner.load({ documentId: "A" });
    const layout = owner.placeProducts({ ids: ["tile"], sourceNodeId: "source", tile: true });
    const camera = owner.setViewport({ x: 10, y: 20, k: 2 });
    await Promise.resolve(); await Promise.resolve();
    writing.resolve({ ...state({ ...latest, updatedAt: "2" }), committedRevision: "2" });
    await layout; await camera;
    const saves = requests.filter((request) => request.action.type === "save");
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ expectedRevision: "2", action: { type: "save", document: { viewport: { x: 10, y: 20, k: 2 } } } });
    expect(owner.getSnapshot().error).toBeUndefined();
    owner.dispose();
  });
  it("combines same-card editor patches while retaining each declared field's genuine dirty base", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [], acknowledgements: string[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return { ...state(before), draft: { document: before, baseDocument: before, revision: "d1", savedAt: "now" } }; } } });
    await owner.load({ documentId: "A" });
    const firstBase = { ...before.nodes[0]!, metadata: { ...before.nodes[0]!.metadata, templateVars: { market: "old" } } };
    const secondBase = { ...before.nodes[0]!, metadata: { ...before.nodes[0]!.metadata, prompt: "base prompt" } };
    const first = owner.registerPendingEdit(async () => undefined, () => ({ nodeId: "source", baseNode: firstBase, patch: { metadata: { templateVars: { market: "new" } } } }), () => acknowledgements.push("category"));
    const second = owner.registerPendingEdit(async () => undefined, () => ({ nodeId: "source", baseNode: secondBase, patch: { metadata: { prompt: "typed" } } }), () => acknowledgements.push("prompt"));
    expect(await owner.preserveEdits()).toBe(true);
    const action = requests[0]!.action;
    expect(action.type).toBe("save_draft_edits");
    if (action.type !== "save_draft_edits") throw new Error("Expected compact draft");
    expect(action.edits).toHaveLength(1);
    expect(action.edits[0]?.baseNode.metadata).toMatchObject({ templateVars: { market: "old" }, prompt: "base prompt" });
    expect(action.edits[0]?.patch.metadata).toEqual({ templateVars: { market: "new" }, prompt: "typed" });
    expect(acknowledgements).toEqual(["category", "prompt"]); first(); second(); owner.dispose();
  });
  it("coalesces page lifecycle preservation, acknowledges only a real native draft, and retains the genuine base", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, writing = deferred<DesignState>();
    const requests: ApplyDesignActionRequest[] = [], accepted: unknown[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return writing.promise; } } });
    await owner.load({ documentId: "A" });
    const edit = { nodeId: "source", baseNode: before.nodes[0]!, patch: { metadata: { prompt: "尚未提交" } } };
    const unregister = owner.registerPendingEdit(async () => undefined, () => edit, (saved) => accepted.push(saved));
    const first = owner.preserveEdits(), second = owner.preserveEdits();
    expect(first).toBe(second); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ documentId: "A", action: { type: "save_draft_edits", edits: [edit] } });
    writing.resolve({ ...state(before), draft: { document: before, baseDocument: before, revision: "draft-1", savedAt: "now" } });
    expect(await first).toBe(true); expect(accepted).toEqual([edit]);
    expect(owner.getSnapshot().data?.draft?.revision).toBe("draft-1");
    unregister(); owner.dispose();
  });
  it("keeps the old board when neither the live edit nor compact draft is confirmed", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async ({ documentId }) => state(documentId === "A" ? before : document("B")), applyDesignAction: async (request) => { requests.push(request); throw new Error("draft_too_large: keep this page open"); } } });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => undefined, () => ({ nodeId: "source", baseNode: before.nodes[0]!, patch: { metadata: { prompt: "x" } } }));
    await owner.load({ documentId: "B" });
    expect(owner.getSnapshot().documentId).toBe("A"); expect(owner.getSnapshot().error).toContain("尚未保存");
    expect(requests).toHaveLength(1); unregister(); owner.dispose();
  });
  for (const columns of [2, 3]) it(`uses the original ${columns}x${columns} tile layout without mutating authority products`, () => {
    const source = { ...node("source"), position: { x: 20, y: 40 } }, ids = Array.from({ length: columns ** 2 }, (_, index) => `tile-${index}`);
    const products = ids.map((id) => ({ ...node(id), metadata: { ...node(id).metadata, sourceNodeId: source.id, output: { ...node(id).metadata.output, status: "success" as const, text: "runtime content", media: [{ kind: "image" as const, url: `/design-assets/assets/${id}.png` }] } } }));
    const before = { ...document("A"), nodes: [source, ...products, { ...node("obstacle"), position: { x: 400, y: 80 } }] };
    const frozen = structuredClone(before), placed = designPlaceProducts(before, { ids, sourceNodeId: source.id, columns, tile: true });
    expect(before).toEqual(frozen);
    const tiles = ids.map((id) => placed.nodes.find((node) => node.id === id)!);
    expect(new Set(tiles.map((node) => node.position.x)).size).toBe(columns);
    expect(new Set(tiles.map((node) => node.position.y)).size).toBe(columns);
    expect(tiles.every((node) => node.width === 240 && node.height === 300 && node.metadata.output.text === "runtime content")).toBe(true);
    expect(placed.nodes.find((node) => node.id === "obstacle")!.position.x).toBeGreaterThan(400);
    const measured = designPlaceProducts({ ...placed, nodes: placed.nodes.map((node) => node.id === ids[0] ? { ...node, height: 500 } : node) }, { ids, sourceNodeId: source.id, columns, tile: true, measured: true });
    expect(measured.nodes.find((node) => node.id === ids[columns])!.position.y).toBe(80 + 500 + 80);
  });
  it("resolves a queued batch placement against the newest product snapshot", async () => {
    let current = { ...document("A"), nodes: [node("source"), node("tile")] };
    const writing = deferred<DesignState>(), requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(current), applyDesignAction: async (request) => { requests.push(request); if (request.action.type === "update_node") return writing.promise; if (request.action.type !== "save") throw new Error("Unexpected action"); return { ...state(request.action.document), committedRevision: request.action.document.updatedAt }; } } });
    await owner.load({ documentId: "A" });
    const update = owner.act({ type: "update_node", nodeId: "tile", patch: { metadata: { prompt: "new" } } });
    const layout = owner.placeProducts({ ids: ["tile"], sourceNodeId: "source", tile: true });
    current = { ...current, updatedAt: "2", nodes: current.nodes.map((item) => item.id === "tile" ? { ...item, metadata: { ...item.metadata, prompt: "new", output: { ...item.metadata.output, text: "settled product" } } } : item) };
    writing.resolve({ ...state(current), committedRevision: "2" }); await update; await layout;
    const save = requests.find((request) => request.action.type === "save")!;
    expect(save.action.type === "save" && save.action.document.nodes.find((item) => item.id === "tile")!.metadata.output.text).toBe("settled product");
    expect(save.expectedRevision).toBe("2"); owner.dispose();
  });
  it("flushes the old document editor before a board navigation changes the owner scope", async () => {
    const writing = deferred<DesignState>(), requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async ({ documentId }) => state(document(documentId!)), applyDesignAction: async (request) => { requests.push(request); return writing.promise; } } });
    await owner.load({ documentId: "A", sessionId: "session-A" });
    let dirty = true;
    const unregister = owner.registerPendingEdit(async () => { if (!dirty) return; dirty = false; await owner.act({ type: "update_node", nodeId: "input", patch: { metadata: { prompt: "last keystroke" } } }); });
    const navigation = owner.load({ documentId: "B", sessionId: "session-B" }); await Promise.resolve();
    expect(owner.getSnapshot().documentId).toBe("A");
    expect(requests[0]).toMatchObject({ documentId: "A", sessionId: "session-A", action: { type: "update_node", patch: { metadata: { prompt: "last keystroke" } } } });
    writing.resolve(state(document("A", "2"))); await navigation;
    expect(owner.getSnapshot()).toMatchObject({ documentId: "B", sessionId: "session-B" }); unregister(); owner.dispose();
  });
  it("keeps a refused typed edit as a real base-relative draft without retrying the live mutation", async () => {
    const before = { ...document("A"), nodes: [node("source")] };
    const requests: ApplyDesignActionRequest[] = [];
    let saved: DesignState["draft"];
    const owner = createDesignOwner({ port: { getDesignState: async () => ({ ...state(before), draft: saved }), applyDesignAction: async (request) => {
      requests.push(request);
      if (request.action.type !== "save_draft") throw new Error("CONFLICT: concurrent update");
      saved = { document: request.action.document, baseDocument: request.action.baseDocument, revision: "d1", savedAt: "now" };
      return { ...state(before), draft: saved };
    } } });
    await owner.load({ documentId: "A" });
    await owner.act({ type: "update_node", nodeId: "source", patch: { metadata: { prompt: "未提交的想法" } } });
    expect(requests.map((request) => request.action.type)).toEqual(["update_node", "save_draft"]);
    expect(requests[1]?.expectedRevision).toBeUndefined();
    expect(owner.getSnapshot().data?.draft?.document.nodes[0]?.metadata.prompt).toBe("未提交的想法");
    expect(owner.getSnapshot().data?.draft?.baseDocument.nodes[0]?.metadata.prompt).toBe("");
    expect(owner.getSnapshot().data?.document?.nodes[0]?.metadata.prompt).toBe("");
    expect(owner.getSnapshot().error).toContain("CONFLICT"); owner.dispose();
  });

  it("uses the retained action info id and only offers supported downstream kinds", () => {
    expect(designAddedNodeId({ ...state(document("A")), result: { id: "new", added: true } })).toBe("new");
    expect(designAddedNodeId({ ...state(document("A")), result: { unrelated: true } })).toBeUndefined();
    expect(designDownstreamTypes("image", { upstreamAccepts: { image: ["image", "video", "music", "retired"] }, modes: { image: {}, video: {}, music: {} } })).toEqual(["image", "video", "audio"]);
  });

  for (const mixed of [false, true]) it(`keeps derived poster writes out of undo while respecting a foreign receipt (${mixed})`, async () => {
    const owner = createDesignOwner({ port: { getDesignState: async () => state(document("A")), applyDesignAction: async (request) => request.action.type === "set_media_poster" ? { ...state(document("A", mixed ? "foreign-4" : "3")), committedRevision: "3" } : { ...state(document("A", "2")), committedRevision: "2" } } });
    await owner.load({ documentId: "A" }); await owner.act({ type: "save", document: { ...document("A"), title: "Edited" } });
    expect(owner.getSnapshot().canUndo).toBe(true);
    await owner.act({ type: "set_media_poster", nodeId: "video", sourceUrl: "/design-assets/uploads/video.mp4", base64: "AA==" });
    expect(owner.getSnapshot().canUndo).toBe(!mixed); expect(owner.getSnapshot().canRedo).toBe(false); owner.dispose();
  });

  it("includes the visible world in the minimap and centers an arbitrary map point without changing scale", () => {
    const viewport = { x: -1000, y: -500, k: .5 }, size = { width: 480, height: 600 };
    const map = designMinimap([node("a")], viewport, size);
    expect(map.view).toEqual({ x: 2000, y: 1000, width: 960, height: 1200 });
    expect(map.x).toBeLessThan(0); expect(map.x + map.width).toBeGreaterThan(2960);
    const centered = designCenterView({ x: 2500, y: 1500 }, viewport, size);
    expect(centered.k).toBe(.5); expect(2500 * centered.k + centered.x).toBe(240); expect(1500 * centered.k + centered.y).toBe(300);
    expect(designEdgePath(node("from"), { ...node("to"), position: { x: 500, y: 100 } }, 1, 3)).toContain("500 300");
  });
  it("does not let an old read replace the selected document", async () => {
    const first = deferred<DesignState>();
    const owner = createDesignOwner({ port: { getDesignState: ({ documentId }) => documentId === "A" ? first.promise : Promise.resolve(state(document("B"))) } });
    const pending = owner.load({ documentId: "A", sessionId: "session-A" });
    await owner.load({ documentId: "B", sessionId: "session-B" });
    first.resolve(state(document("A"))); await pending;
    expect(owner.getSnapshot().documentId).toBe("B");
    expect(owner.getSnapshot().data?.document?.id).toBe("B");
    owner.dispose();
  });

  it("R01 an A refusal cannot publish an error onto B", async () => {
    const mutation = deferred<DesignState>();
    const owner = createDesignOwner({ port: { getDesignState: async ({ documentId }) => state(document(documentId!)), applyDesignAction: () => mutation.promise } });
    await owner.load({ documentId: "A", sessionId: "session-A" });
    const pending = owner.act({ type: "add_node", nodeType: "image" });
    await Promise.resolve();
    await owner.load({ documentId: "B", sessionId: "session-B" });
    mutation.reject(new Error("A refused")); await pending;
    expect(owner.getSnapshot()).toMatchObject({ documentId: "B", sessionId: "session-B", error: undefined, busy: false });
    owner.dispose();
  });

  it("R02 an undo settling after navigation keeps B visible", async () => {
    const undo = deferred<DesignState>();
    let applyCount = 0;
    const owner = createDesignOwner({ port: {
      getDesignState: async ({ documentId }) => state(document(documentId!)),
      applyDesignAction: async () => ++applyCount === 1 ? state(document("A", "2")) : undo.promise,
    } });
    await owner.load({ documentId: "A", sessionId: "session-A" });
    await owner.act({ type: "save", document: { ...document("A"), title: "Edited" } });
    expect(owner.getSnapshot().canUndo).toBe(true);
    const pending = owner.undo(); await Promise.resolve();
    await owner.load({ documentId: "B", sessionId: "session-B" });
    undo.resolve(state(document("A", "3"))); await pending;
    expect(owner.getSnapshot()).toMatchObject({ documentId: "B", sessionId: "session-B" });
    expect(owner.getSnapshot().data?.document?.id).toBe("B");
    owner.dispose();
  });

  for (const direction of ["undo", "redo"] as const) it(`R02 a late ${direction} cannot replace a fresh A after A -> B -> A navigation`, async () => {
    const response = deferred<DesignState>();
    let pendingTravel = false;
    let readRevision = "1";
    let writeRevision = 1;
    const owner = createDesignOwner({ port: {
      getDesignState: async ({ documentId }) => state(document(documentId!, readRevision)),
      applyDesignAction: async () => pendingTravel ? response.promise : state(document("A", String(++writeRevision))),
    } });
    await owner.load({ documentId: "A", sessionId: "session-A" });
    await owner.act({ type: "save", document: document("A") });
    if (direction === "redo") await owner.undo();
    pendingTravel = true;
    const travel = owner[direction](); await Promise.resolve();
    await owner.load({ documentId: "B", sessionId: "session-B" });
    readRevision = "fresh-4";
    await owner.load({ documentId: "A", sessionId: "session-A" });
    response.resolve(state(document("A", "stale-3"))); await travel;
    expect(owner.getSnapshot().data?.document?.updatedAt).toBe("fresh-4");
    expect(owner.getSnapshot().sessionId).toBe("session-A");
    owner.dispose();
  });

  it("serializes mutations and reads the next CAS revision after the previous write", async () => {
    const first = deferred<DesignState>();
    const requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(document("A")), applyDesignAction: async (request) => { requests.push(request); return requests.length === 1 ? first.promise : state(document("A", "3")); } } });
    await owner.load({ documentId: "A" });
    const one = owner.act({ type: "add_node", nodeType: "input" });
    const two = owner.act({ type: "add_node", nodeType: "image" });
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    first.resolve(state(document("A", "2"))); await one; await two;
    expect(requests.map((request) => request.expectedRevision)).toEqual(["1", "2"]);
    expect(owner.getSnapshot().busy).toBe(false);
    owner.dispose();
  });

  it("does not retry a conflicting mutation and keeps the refusal after rereading", async () => {
    let writes = 0;
    let reads = 0;
    const owner = createDesignOwner({ port: { getDesignState: async () => state(document("A", String(++reads))), applyDesignAction: async () => { writes += 1; throw new Error("CONFLICT: changed in another view; reload before saving"); } } });
    await owner.load({ documentId: "A" });
    await owner.act({ type: "remove_node", nodeId: "n" });
    expect(writes).toBe(1); expect(reads).toBe(2);
    expect(owner.getSnapshot().error).toContain("CONFLICT");
    owner.dispose();
  });

  it("does not stamp a queued stale whole-document save with a newer CAS revision", async () => {
    const first = deferred<DesignState>();
    const requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: {
      getDesignState: async () => state(document("A", requests.length ? "fresh-3" : "1")),
      applyDesignAction: async (request) => {
        requests.push(request);
        if (requests.length === 1) return first.promise;
        if (request.action.type === "save_draft") return { ...state(document("A", "fresh-3")), draft: { ...request.action, revision: "draft-1", savedAt: "now" } };
        expect(request.expectedRevision).toBe("1");
        throw new Error("CONFLICT: stale document content");
      },
    } });
    await owner.load({ documentId: "A" });
    const adding = owner.act({ type: "add_node", nodeType: "input" });
    const stale = owner.act({ type: "save", document: document("A", "1") });
    first.resolve(state(document("A", "2"))); await adding; await stale;
    expect(owner.getSnapshot().data?.document?.updatedAt).toBe("fresh-3");
    expect(owner.getSnapshot().error).toContain("stale document content");
    expect(requests.filter((request) => request.action.type !== "save_draft")).toHaveLength(2);
    const draft = requests.find((request) => request.action.type === "save_draft");
    expect(draft?.expectedRevision).toBeUndefined();
    expect(draft?.action).toMatchObject({ baseDocument: { updatedAt: "1" }, document: { updatedAt: "1" } });
    owner.dispose();
  });

  it("R16 resets undo and redo across an externally observed revision instead of restoring old fields", async () => {
    let authoritative = document("A");
    let writes = 0;
    const owner = createDesignOwner({ port: {
      getDesignState: async () => state(authoritative),
      applyDesignAction: async (request) => {
        writes += 1;
        if (request.action.type === "save") authoritative = { ...request.action.document, updatedAt: `local-${writes}` };
        return state(authoritative);
      },
    } });
    await owner.load({ documentId: "A" });
    await owner.act({ type: "save", document: { ...authoritative, title: "Moved locally" } });
    expect(owner.getSnapshot().canUndo).toBe(true);
    authoritative = { ...authoritative, title: "Runtime or other view accepted work", updatedAt: "external-1" };
    await owner.load();
    expect(owner.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, historyResetReason: expect.stringContaining("历史已重置") });
    await owner.undo();
    expect(writes).toBe(1);
    expect(owner.getSnapshot().data?.document?.title).toBe("Runtime or other view accepted work");
    await owner.act({ type: "save", document: { ...authoritative, backgroundMode: "lines" } });
    expect(owner.getSnapshot().canUndo).toBe(true);
    await owner.undo();
    expect(owner.getSnapshot().canRedo).toBe(true);
    authoritative = { ...authoritative, title: "Another accepted update", updatedAt: "external-2" };
    await owner.load();
    const settledWrites = writes;
    await owner.redo();
    expect(writes).toBe(settledWrites);
    expect(owner.getSnapshot().data?.document?.title).toBe("Another accepted update");
    owner.dispose();
  });

  for (const operation of ["edit", "undo", "redo"] as const) it(`R16 a ${operation} response observing a newer runtime commit cannot retain stale history`, async () => {
    let authoritative = document("A");
    let writes = 0;
    let mixRuntimeCommit = false;
    const owner = createDesignOwner({ port: {
      getDesignState: async () => state(authoritative),
      applyDesignAction: async (request) => {
        writes += 1;
        if (request.action.type !== "save") throw new Error("Expected a document save");
        const committedRevision = `local-${writes}`;
        authoritative = { ...request.action.document, updatedAt: committedRevision };
        if (mixRuntimeCommit) authoritative = {
          ...authoritative, title: "Runtime accepted a different field", updatedAt: "runtime-after-commit",
          nodes: [{ id: "product", type: "result", title: "Runtime product", position: { x: 500, y: 80 }, width: 320, height: 400, metadata: { kind: "image", prompt: "", mode: null, model: null, ratio: null, resolution: null, duration: null, count: 1, voice: null, emotion: null, sessionId: null, segments: [], mentions: [], output: { status: "success", text: "", media: [{ kind: "image", url: "/design-assets/assets/new.png" }], error: "" } } }],
        };
        return { ...state(authoritative), committedRevision };
      },
    } });
    await owner.load({ documentId: "A" });
    await owner.act({ type: "save", document: { ...authoritative, title: "Local edit" } });
    if (operation === "redo") await owner.undo();
    mixRuntimeCommit = true;
    if (operation === "edit") await owner.act({ type: "save", document: { ...authoritative, backgroundMode: "lines" } });
    else await owner[operation]();
    expect(owner.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, historyResetReason: expect.stringContaining("历史已重置") });
    expect(owner.getSnapshot().data?.document).toEqual(authoritative);
    const acceptedWrites = writes;
    await owner.undo(); await owner.redo();
    expect(writes).toBe(acceptedWrites);
    expect(owner.getSnapshot().data?.document?.nodes[0]?.metadata.output.status).toBe("success");
    expect(owner.getSnapshot().data?.document?.title).toBe("Runtime accepted a different field");
    owner.dispose();
  });

  it("deduplicates explicit presentation intents and fences settlement after disposal", async () => {
    const response = deferred<DesignState>();
    const owner = createDesignOwner({ port: { getDesignState: () => response.promise } });
    const intent = { id: "open-1", sessionId: "session-A", documentId: "A", createdAt: "1" };
    owner.present(intent); const snapshot = owner.getSnapshot(); owner.present(intent);
    expect(owner.getSnapshot()).toBe(snapshot);
    const pending = owner.load({ documentId: "A" });
    owner.dispose(); const disposed = owner.getSnapshot();
    response.resolve(state(document("A"))); await pending;
    expect(owner.getSnapshot()).toBe(disposed);
  });

  it("persists view changes at their origin revision without adding an undo step", async () => {
    let current = document("A");
    const requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(current), applyDesignAction: async (request) => {
      requests.push(request);
      if (request.action.type === "save") current = { ...request.action.document, updatedAt: String(requests.length + 1) };
      return { ...state(current), committedRevision: current.updatedAt };
    } } });
    await owner.load({ documentId: "A" });
    await owner.act({ type: "save", document: { ...current, title: "Edited" } });
    await owner.setViewport({ x: -400, y: 90, k: 0.5 });
    expect(requests[1].expectedRevision).toBe("2");
    await owner.undo();
    expect(owner.getSnapshot().data?.document?.title).toBe("A");
    expect(owner.getSnapshot().canUndo).toBe(false);
    owner.dispose();
  });
});

describe("native Design projections", () => {
  it("keeps the pointed world coordinate fixed while zooming", () => {
    const before = { x: 80, y: 60, k: 1 };
    const point = { x: 420, y: 300 };
    const after = designZoom(before, -400, point);
    expect(designWorldPoint(point.x, point.y, before)).toEqual(designWorldPoint(point.x, point.y, after));
    expect(after.k).toBeGreaterThan(before.k);
  });
  it("preserves ordered text and immutable mention identities", () => {
    expect(designPromptSegments("看 [[cw:image:n1]] 的主体")).toEqual([{ type: "text", text: "看 " }, { type: "mention", kind: "image", nodeId: "n1" }, { type: "text", text: " 的主体" }]);
  });
  it("R12 remaps a copied graph's prompt references and removes running identities", () => {
    const source = node("source");
    const target = { ...node("target"), metadata: { ...node("target").metadata, prompt: "看 [[cw:image:source]] 和 [[cw:image:external]]", segments: [{ type: "mention" as const, kind: "image" as const, nodeId: "source" }], mentions: [{ kind: "image" as const, nodeId: "source" }], sessionId: "paid-run", sourceTaskId: "task-1", sourceNodeId: "source", output: { status: "loading" as const, text: "", error: "", taskId: "task-1", runId: "run-1", sessionId: "paid-run", media: [{ kind: "image" as const, url: "/design-assets/assets/product.png", nodeId: "source", taskId: "task-1" }] } } };
    let sequence = 0;
    const copied = cloneDesignSelection({ nodes: [source, target], connections: [{ id: "old-line", fromNodeId: "source", toNodeId: "target", kind: "image" }] }, (kind) => `${kind}-${++sequence}`);
    expect(copied.connections).toEqual([{ id: "connection-3", fromNodeId: "node-1", toNodeId: "node-2", kind: "image" }]);
    expect(copied.nodes[1]!.metadata).toMatchObject({ prompt: "看 [[cw:image:node-1]] 和 [[cw:image:external]]", segments: [{ nodeId: "node-1" }], mentions: [{ nodeId: "node-1" }], sessionId: null, sourceTaskId: "", sourceNodeId: "node-1", output: { status: "idle", media: [{ nodeId: "node-1", url: "/design-assets/assets/product.png" }] } });
    expect(copied.nodes[1]!.metadata.output).not.toHaveProperty("taskId");
    expect(copied.nodes[1]!.metadata.output).not.toHaveProperty("sessionId");
    expect(copied.nodes[1]!.metadata.output.media[0]).not.toHaveProperty("taskId");
    expect(target.metadata.sessionId).toBe("paid-run");
  });
  it("R13 treats Other as exclusive for single choice and additive for multiple choice", () => {
    const choice = { stepId: "question", selectedOptionIds: ["one"], selectedOther: false };
    const single = designQuestionOther(choice, false, true, "custom");
    expect(single.selectedOptionIds).toEqual([]);
    expect(designQuestionChoice(single, "two", false)).toMatchObject({ selectedOptionIds: ["two"], selectedOther: false });
    const multi = designQuestionOther(choice, true, true, "custom");
    expect(designQuestionChoice(multi, "two", true)).toMatchObject({ selectedOptionIds: ["one", "two"], selectedOther: true });
    expect(designQuestionAnswered(designQuestionOther(single, false, false))).toBe(false);
    expect(designQuestionAnswered({ ...single, otherText: "   " })).toBe(false);
    expect(designQuestionAnswered(multi)).toBe(true);
  });
  it("places a new card clear of the occupied origin", () => {
    const doc = { ...document("A"), nodes: [node("occupied")] };
    const point = designNewNodePosition(doc);
    expect(point.x >= 352 || point.y >= 432).toBe(true);
  });
  it("commits gesture geometry without replacing a newer runtime product or resurrecting removed nodes", () => {
    const starting = node("moving");
    const preview = [{ ...starting, position: { x: 240, y: 120 }, width: 480 }, node("removed")];
    const completed = { ...starting, title: "Renamed by another view", metadata: { ...starting.metadata, output: { status: "success" as const, text: "Completed while dragging", media: [], error: "" } } };
    const latest = { ...document("A", "fresh"), nodes: [completed, node("new-result")] };
    const moved = mergeDesignGesture(latest, preview, ["moving", "removed"]);
    expect(moved.updatedAt).toBe("fresh");
    expect(moved.nodes.map((entry) => entry.id)).toEqual(["moving", "new-result"]);
    expect(moved.nodes[0]).toMatchObject({ title: "Renamed by another view", position: { x: 240, y: 120 }, width: 320, metadata: { output: { text: "Completed while dragging", status: "success" } } });
    const resized = mergeDesignGesture(latest, preview, ["moving"], "moving");
    expect(resized.nodes[0]).toMatchObject({ width: 480, position: { x: 0, y: 0 }, metadata: { userSized: true, output: { text: "Completed while dragging" } } });
  });
  it("round trips the original portable workflow format and refuses non-template actions", () => {
    const exported = templateFile(templateFromCanvas({ ...document("A"), nodes: [node("input")] }, { title: "可复用步骤" }));
    expect(readTemplateFile(JSON.stringify(exported))).toMatchObject({ ok: true, template: { title: "可复用步骤", actions: [{ type: "add_node" }] } });
    expect(readTemplateFile(JSON.stringify({ actions: [{ type: "run", args: {} }] }))).toMatchObject({ ok: false });
  });

  it("offers every original input kind and never manually adds result cards", () => {
    expect(NODE_KINDS.map((entry) => `${entry.type}:${entry.kind ?? ""}`)).toEqual(["input:text", "input:image", "input:video", "input:audio", "text:text", "image:image", "video:video", "audio:audio", "group:"]);
    expect(designNextTitle([{ title: "未命名画布" }, { title: "未命名画布 2" }])).toBe("未命名画布 3");
  });

  it("preserves original conditional menu sections and selected-only card layers", () => {
    const empty = node("input");
    const actions = (value: DesignNode, selectedCount = 1) => nodeMenuEntries(value, { selectedCount, canPaste: false, isGroup: value.type === "group" }).filter((entry) => entry !== "-");
    expect(actions(empty).map((entry) => entry.action)).toEqual(["rename", "cut", "copy", "duplicate", "paste", "focus", "delete"]);
    expect(actions(empty).find((entry) => entry.action === "paste")?.disabled).toBe(true);
    const populated = { ...empty, metadata: { ...empty.metadata, output: { ...empty.metadata.output, text: "Result", media: [{ kind: "image" as const, url: "/design-assets/assets/a.png" }] } } };
    expect(actions(populated, 2).map((entry) => entry.action)).toEqual(["copy-media", "copy-text", "save-local", "rename", "cut", "copy", "duplicate", "paste", "group", "focus", "clear", "delete"]);
    expect(cardLayers({ ...empty, metadata: { ...empty.metadata, kind: "text" } })).toMatchObject({ material: ["text"], ops: ["style", "composer"], above: [] });
    expect(cardLayers(empty)).toMatchObject({ material: ["frame"], ops: [], above: ["upload"] });
    expect(cardLayers({ ...empty, type: "image", metadata: { ...empty.metadata, kind: "image" } })).toMatchObject({ material: ["frame"], ops: ["composer", "params"] });
    expect(cardLayers({ ...populated, type: "result" })).toMatchObject({ material: ["output"], ops: [] });
  });

  it("groups the selection behind its cards without altering accepted products or other nodes", () => {
    const first = node("one");
    const second = { ...node("two"), position: { x: 500, y: 240 } };
    const outside = { ...node("outside"), position: { x: 5000, y: 5000 } };
    const source = { ...document("A", "fresh"), nodes: [first, second, outside] };
    const grouped = designGroupSelection(source, [first.id, second.id], "group");
    expect(grouped.nodes[0]).toMatchObject({ id: "group", position: { x: -28, y: -28 }, width: 876, height: 696 });
    expect(groupMembers(grouped.nodes[0], grouped.nodes)).toEqual(["one", "two"]);
    expect(grouped.nodes.slice(1)).toEqual(source.nodes);
    const ungrouped = designRemoveSelection(grouped, ["group"]);
    expect(ungrouped.nodes).toEqual(source.nodes);
    expect(ungrouped.updatedAt).toBe("fresh");
  });

  it("fits distant content into the actual pane and keeps focus selection at its current zoom", () => {
    const nodes = [node("near"), { ...node("far"), position: { x: 2500, y: 1800 } }];
    const fit = designFitView(nodes, { width: 800, height: 600 });
    for (const entry of nodes) {
      expect(entry.position.x * fit.k + fit.x).toBeGreaterThanOrEqual(48);
      expect(entry.position.y * fit.k + fit.y).toBeGreaterThanOrEqual(48);
      expect((entry.position.x + entry.width) * fit.k + fit.x).toBeLessThanOrEqual(752);
      expect((entry.position.y + entry.height) * fit.k + fit.y).toBeLessThanOrEqual(552);
    }
    expect(designFitView(nodes, { width: 800, height: 600 }, 1.5).k).toBe(1.5);
    expect(designFitView([], { width: 300, height: 600 })).toEqual({ x: 80, y: 60, k: 1 });
  });

  it("keeps model and count out of the shape panel and gives each chip its own toggle", () => {
    const image: DesignNode = { ...node("generator"), type: "image", metadata: { ...node("generator").metadata, kind: "image", mode: "text2img", model: "model" } };
    const fields = paramFields(image, { ratios: ["1:1", "16:9"], resolutions: ["1K", "2K"] }, { models: [{ value: "model", label: "Model" }], counts: [{ value: "1", label: "× 1" }, { value: "2", label: "× 2" }] });
    expect(panelFields(fields, "params").map((field) => field.key)).toEqual(["ratio", "resolution"]);
    expect(panelFields(fields, "count").map((field) => field.key)).toEqual(["count"]);
    expect(paramSummary(fields)).toBe("1:1 · 1K");
    expect(chipPress({ type: "params", nodeId: image.id }, image.id, "params")).toBe("close");
    expect(chipPress({ type: "params", nodeId: image.id }, image.id, "count")).toBe("open");
  });

  it("flushes the real pending editor before a run and never dispatches on an unconfirmed edit", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    let flushCalls = 0;
    const port = {
      getDesignState: async () => state(before),
      applyDesignAction: async (request: ApplyDesignActionRequest) => {
        requests.push(request);
        return state(before);
      },
    };
    const owner = createDesignOwner({ port });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => {
      flushCalls += 1;
      await port.applyDesignAction({ documentId: "A", action: { type: "update_node", nodeId: "source", patch: { metadata: { prompt: "just typed" } } } });
    });
    await owner.act({ type: "run", nodeId: "source" });
    expect(flushCalls).toBe(1);
    expect(requests.map((request) => request.action.type)).toEqual(["update_node", "run"]);
    unregister();
    owner.dispose();
  });

  it("does not run on old authority when the live edit was refused but a draft was preserved", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    const edit = { nodeId: "source", baseNode: before.nodes[0]!, patch: { metadata: { prompt: "unconfirmed live edit" } } };
    const owner = createDesignOwner({ port: {
      getDesignState: async () => state(before),
      applyDesignAction: async (request) => {
        requests.push(request);
        if (request.action.type === "save_draft_edits") return { ...state(before), draft: { document: before, baseDocument: before, revision: "d1", savedAt: "now" } };
        return state(before);
      },
    } });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => undefined, () => edit, () => undefined);
    const result = await owner.act({ type: "run", nodeId: "source" });
    expect(result).toBeUndefined();
    expect(requests.map((request) => request.action.type)).toEqual(["save_draft_edits"]);
    expect(owner.getSnapshot().error).toBeTruthy();
    unregister(); owner.dispose();
  });

  it("does not let a run inherit a failed in-flight normal flush", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return state(before); } } });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => gate);
    const normal = owner.flushEdits();
    const running = owner.act({ type: "run", nodeId: "source" });
    release(false);
    await normal;
    expect(await running).toBeUndefined();
    expect(requests).toEqual([]);
    unregister(); owner.dispose();
  });

  it("refuses a run when an editor reports that its live save did not land", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return state(before); } } });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => false);
    const result = await owner.act({ type: "run", nodeId: "source" });
    expect(result).toBeUndefined();
    expect(requests).toEqual([]);
    expect(owner.getSnapshot().error).toContain("当前画布");
    unregister(); owner.dispose();
  });

  it("waits for an in-flight flush and includes a connected upstream editor before a run", async () => {
    const before = { ...document("A"), nodes: [node("source"), node("upstream")] }, requests: ApplyDesignActionRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const flushed: string[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return state(before); } } });
    await owner.load({ documentId: "A" });
    const unregisterSource = owner.registerPendingEdit(async () => { flushed.push("source"); await gate; });
    const unregisterUpstream = owner.registerPendingEdit(async () => { flushed.push("upstream"); });
    const running = owner.act({ type: "run", nodeId: "source" });
    await Promise.resolve();
    expect(flushed).toEqual(["source", "upstream"]);
    expect(requests).toEqual([]);
    release();
    await running;
    expect(requests.map((request) => request.action.type)).toEqual(["run"]);
    unregisterSource(); unregisterUpstream(); owner.dispose();
  });

  it("refuses a run when the pending editor cannot confirm its save", async () => {
    const before = { ...document("A"), nodes: [node("source")] }, requests: ApplyDesignActionRequest[] = [];
    const owner = createDesignOwner({ port: { getDesignState: async () => state(before), applyDesignAction: async (request) => { requests.push(request); return state(before); } } });
    await owner.load({ documentId: "A" });
    const unregister = owner.registerPendingEdit(async () => {
      throw new Error("save refused");
    });
    const result = await owner.act({ type: "run", nodeId: "source" });
    expect(result).toBeUndefined();
    expect(requests).toEqual([]);
    expect(owner.getSnapshot().error).toContain("save refused");
    unregister();
    owner.dispose();
  });
});
