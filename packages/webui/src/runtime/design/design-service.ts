import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireWebuiStorageLock, withWebuiStorageTransaction } from "../storage-transaction.js";
import type { NativeDesignExecution, NativeDesignToolAdapter } from "@mavis/local-runtime-v2/process-local";
import type { ApplyDesignActionRequest, DesignAction, DesignAsset, DesignAssetRequest, DesignDocument, DesignMedia, DesignNode, DesignOpenIntent, DesignState, DesignTask, DesignLibraryAsset, GetDesignStateRequest } from "../../shared/contracts/design.js";
import { applyAction, applyTemplate, materializeResults, pendingAncestors, readTemplateFile, runFingerprintFor, runSpecFor, templateFromCanvas, templateFile, validateRunSpec } from "../../shared/design/actions.mjs";
import { CAPABILITIES, NODE_SIZE, PROMPT_TEMPLATES, findTool, palette } from "../../shared/design/capabilities.mjs";
import { createAgentRunner, type DesignExecutionContext } from "./agent-runner.mjs";
import { createMediaRunner } from "./media-runner.mjs";
import { createCanvasStore } from "./store.mjs";
import { replaceFile } from "./atomic-file.mjs";
import { createDesignEvents } from "./events.js";
import { readDesignTemplates, removeDesignTemplate, saveDesignTemplate } from "./templates.js";
import { prepareWebuiDesignPaths } from "../webui-paths.js";
import { applyDesignNodePatch } from "./node-patch.js";
import { appendDesignProducts } from "./products.js";
import { fanOutParams, toolPrompt } from "../../shared/design/tools.mjs";
import { DESIGN_MAX_MEDIA_BYTES, DESIGN_MAX_KEEPALIVE_BYTES, designActionError } from "../../shared/design-input.js";
import { createDesignDraftStore, designDocumentsFromEdits, mergeDesignDraft } from "./drafts.js";
import { designExportPlaces, exportDesignBytes } from "./export.js";
import { readDesignVoices } from "./voices.js";
import { designPosterContent, isDesignPosterName, publishDesignPoster } from "./posters.js";

interface DesignJournal { intents: Record<string, DesignOpenIntent>; tasks: Record<string, { documentId: string; nodeId?: string; executionId?: string; inputFingerprint?: string; task?: DesignTask; settled?: boolean; continuation?: readonly string[]; chainId?: string; cancelled?: boolean }> }
const terminal = (status: string) => !["running", "waiting-question", "queued"].includes(status);
const plainId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const plainAssetName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function assertMediaUrl(url: string): void {
  if (/^\/design-assets\/(?:assets|uploads)\/[A-Za-z0-9][\w.-]*$/.test(url)) return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("INVALID_ARGUMENTS", "Design media must be an HTTP URL or a native Design asset"); }
  if (!["https:", "http:"].includes(parsed.protocol)) fail("INVALID_ARGUMENTS", "Unsupported Design media URL protocol");
}
function assertDocument(document: DesignDocument): void {
  if (!document || !plainId(document.id) || !Array.isArray(document.nodes) || !Array.isArray(document.connections)) fail("INVALID_ARGUMENTS", "Invalid Design document");
  if (document.nodes.length > 300 || document.connections.length > 1000) fail("INVALID_ARGUMENTS", "Design document exceeds the node or connection limit");
  const ids = new Set<string>();
  for (const node of document.nodes) {
    if (!plainId(node.id) || ids.has(node.id)) fail("INVALID_ARGUMENTS", "Design node identifiers must be unique plain identifiers");
    ids.add(node.id);
    for (const media of node.metadata?.output?.media ?? []) assertMediaUrl(media.url);
  }
}

export interface WebuiDesignService {
  readonly tool: NativeDesignToolAdapter;
  readonly events: ReturnType<typeof createDesignEvents>;
  getState(request: GetDesignStateRequest): Promise<DesignState>;
  apply(request: ApplyDesignActionRequest): Promise<DesignState>;
  readAsset(request: DesignAssetRequest): Promise<DesignAsset | null>;
  attachExecution(execution: NativeDesignExecution | undefined): Promise<void>;
  close(): Promise<void>;
}

/** One native authority for the page, right panel and Agent; Plugin storage is never read. */
export async function createWebuiDesignService(dataDir: string): Promise<WebuiDesignService> {
  const paths = await prepareWebuiDesignPaths(dataDir);
  const root = paths.design;
  const controller = new AbortController();
  const events = createDesignEvents();
  let execution: NativeDesignExecution | undefined;
  let closed = false;
  let settling: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taskLeases = new Map<string, () => void>();
  const requireExecution = () => execution ?? fail("DESIGN_EXECUTION_UNAVAILABLE", "This host does not expose native Design execution");
  const context: DesignExecutionContext = {
    dataDir: root, signal: controller.signal,
    agent: {
      models: () => requireExecution().agent.models(),
      run: (input, options) => requireExecution().agent.run(input, options),
      reply: (input) => requireExecution().agent.reply(input),
      answer: (input, options) => requireExecution().agent.answer(input, options),
    },
    hostConnector: {
      list: (input) => requireExecution().hostConnector.list(input),
      call: (reference, input, options) => requireExecution().hostConnector.call(reference, input, options),
    },
    logger: { info() {}, warn() {}, error() {} },
    withPersistenceLock: (work) => withLock("pending-runs", work),
  };
  const store = createCanvasStore(context);
  const runner = createAgentRunner(context);
  const media = createMediaRunner(context);
  const drafts = createDesignDraftStore(root);
  let voiceCatalog: Awaited<ReturnType<typeof readDesignVoices>> = { voices: [], voiceSource: "not-loaded" };
  const journalFile = path.join(root, "state.json");
  const assetReferences = (value: unknown): string[] => {
    const found = new Set<string>();
    const visit = (item: unknown) => {
      if (typeof item === "string" && /^\/design-assets\/(?:assets|uploads)\/[A-Za-z0-9][\w.-]*$/.test(item)) found.add(item);
      else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") Object.values(item).forEach(visit);
    };
    visit(value);
    return [...found].sort();
  };
  async function readJournal(): Promise<DesignJournal> {
    try {
      const info = await lstat(journalFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Design state must be a regular file");
      const value = JSON.parse(await readFile(journalFile, "utf8")) as DesignJournal;
      if (!value || typeof value.intents !== "object" || typeof value.tasks !== "object") throw new Error("Invalid Design state");
      return value;
    } catch (error) { if (isMissing(error)) return { intents: {}, tasks: {} }; throw error; }
  }
  async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (closed) fail("DESIGN_CLOSED", "Native Design is closed");
    return withWebuiStorageTransaction(path.join(root, `${name}.transaction.sqlite`), work);
  }
  async function updateJournal(update: (journal: DesignJournal) => void): Promise<void> {
    await withLock("state", async () => {
      const journal = await readJournal();
      update(journal);
      const temp = path.join(root, `.state-${randomUUID()}.tmp`);
      try { await writeFile(temp, JSON.stringify(journal), { encoding: "utf8", flag: "wx", mode: 0o600 }); await replaceFile(temp, journalFile); }
      finally { await rm(temp, { force: true }); }
    });
  }
  async function withReferencedAssets<T>(value: unknown, work: () => Promise<T>, retainedReferences: ReadonlySet<string> = new Set()): Promise<T> {
    const references = assetReferences(value);
    const lockNames = [...new Set(references.map((reference) => reference.split("/").pop()!))].sort();
    const save = async (index: number): Promise<T> => {
      if (index === lockNames.length) return work();
      const name = lockNames[index];
      return withLock(`asset-${name}`, async () => {
        for (const reference of references.filter((value) => value.split("/").pop() === name)) {
          const kind = reference.slice("/design-assets/".length).split("/")[0];
          const info = await lstat(path.join(root, kind, name)).catch((error: unknown) => {
            if (isMissing(error) && retainedReferences.has(reference)) return undefined;
            if (isMissing(error)) fail("MEDIA_MISSING", "New Design material must name an existing local file");
            throw error;
          });
          if (!info) continue;
          if (!info.isFile() || info.isSymbolicLink()) fail("MEDIA_MISSING", "Design material is not a regular local file");
        }
        return save(index + 1);
      });
    };
    return save(0);
  }
  const saveDocument = async (document: DesignDocument): Promise<DesignDocument> => {
    // Callers hold the document lock. Existing references survive an externally
    // missing file; every new reference still needs real bytes under its asset lock.
    const current = await store.get(document.id);
    return withReferencedAssets(document, () => store.save(document), new Set(assetReferences(current)));
  };
  async function referenceOwners(): Promise<Map<string, { title: string; canvasId: string }>> {
    const owners = new Map<string, { title: string; canvasId: string }>();
    for (const summary of await store.list()) {
      const document = await store.get(summary.id);
      for (const node of document?.nodes ?? []) for (const reference of assetReferences(node)) if (!owners.has(reference)) owners.set(reference, { title: node.title, canvasId: summary.id });
    }
    for (const draft of await drafts.list()) for (const reference of assetReferences(draft)) if (!owners.has(reference)) owners.set(reference, { title: `${draft.document.title} · 草稿`, canvasId: draft.document.id });
    return owners;
  }
  const actionContext = {
    sizes: NODE_SIZE, promptTemplates: PROMPT_TEMPLATES,
    idFor: (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
    modelsByType: Object.fromEntries(Object.entries(CAPABILITIES).map(([kind, caps]) => [kind, Array.isArray(caps.models) ? caps.models.map((model) => typeof model === "object" && model !== null && "id" in model ? String(model.id) : "") : []])),
  };
  async function getState(request: GetDesignStateRequest): Promise<DesignState> {
    if (closed) fail("DESIGN_CLOSED", "Native Design is closed");
    const [documents, templates, journal, catalog, library, mediaStatus, connectorCatalog] = await Promise.all([store.list(), readDesignTemplates(root), readJournal(), runner.modelCatalog(), media.store.listLibrary(), media.status(), runner.connectorTools()]);
    const openIntent = request.sessionId && Object.hasOwn(journal.intents, request.sessionId) ? journal.intents[request.sessionId] : undefined;
    const intendedId = request.documentId ?? openIntent?.documentId;
    const id = intendedId && documents.some((entry) => entry.id === intendedId) ? intendedId : request.documentId ?? documents[0]?.id;
    const document = id ? await store.get(id) : null;
    if (request.documentId && !document) fail("NOT_FOUND", "Design document does not exist");
    const tasks = Object.entries(journal.tasks).filter(([, binding]) => !id || binding.documentId === id).map(([taskId, binding]) => {
      const live = taskLeases.has(taskId) ? runner.get(taskId) : undefined;
      // Terminal state is published with its persisted settlement receipt, never with a moving expiry clock.
      const task = live && !terminal(live.status) ? live : binding.task ?? live;
      return task ? { ...task, chainId: binding.chainId ?? taskId } : undefined;
    }).filter((task): task is DesignTask & { chainId: string } => Boolean(task));
    const owners = await referenceOwners();
    const assets: DesignLibraryAsset[] = library.filter((asset: { name: string }) => !isDesignPosterName(asset.name)).map((asset: DesignMedia & { id: string; name: string }) => ({ ...asset, title: owners.get(asset.url)?.title ?? "", canvasId: owners.get(asset.url)?.canvasId ?? "", inUse: owners.has(asset.url) }));
    const draft = id ? await drafts.read(id) : undefined;
    return { documents, ...(document ? { document } : {}), templates, capabilities: { ...palette(), agentAvailable: execution !== undefined, connectorTools: connectorCatalog.tools, connectorDiscovery: connectorCatalog.discovery }, models: catalog.items ?? [], defaultModelKey: catalog.defaultKey ?? null, tasks, library: assets, mediaStatus, ...voiceCatalog, exportPlaces: designExportPlaces(), ...(draft ? { draft } : {}), ...(openIntent ? { openIntent } : {}) };
  }
  async function chooseDocument(request: GetDesignStateRequest): Promise<DesignDocument | undefined> {
    const journal = await readJournal();
    const implicit = request.sessionId && Object.hasOwn(journal.intents, request.sessionId) ? journal.intents[request.sessionId]?.documentId : undefined;
    const id = request.documentId ?? implicit;
    const chosen = id ? await store.get(id) : undefined;
    if (request.documentId && !chosen) fail("NOT_FOUND", "Design document does not exist");
    if (chosen) return chosen;
    const recent = (await store.list())[0]?.id;
    return recent ? (await store.get(recent) ?? undefined) : undefined;
  }
  async function createDocument(title?: string): Promise<DesignDocument> {
    return store.save({ id: `design_${randomUUID().replaceAll("-", "")}`, title: title?.trim() || "Untitled design", nodes: [], connections: [], backgroundMode: "lines", viewport: { x: 80, y: 60, k: 1 } });
  }
  function notify(documentId?: string, sessionId?: string) { events.publish("design.changed", { ...(documentId ? { documentId } : {}), ...(sessionId ? { sessionId } : {}) }); }
  function scheduleSettle() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      settling = settleTasks().catch((error: unknown) => { events.publish("design.changed", { error: error instanceof Error ? error.message : String(error) }); }).finally(() => { settling = undefined; });
    }, 250);
    timer.unref?.();
  }
  async function settleTasks(): Promise<void> {
    const journal = await readJournal();
    let hasActive = false;
    for (const [taskId, binding] of Object.entries(journal.tasks)) {
      const liveTask = runner.get(taskId);
      if (!liveTask || binding.settled || !taskLeases.has(taskId)) continue;
      let task: DesignTask = { ...liveTask, ...(terminal(liveTask.status) ? { finishedAt: binding.task?.finishedAt ?? Date.now() } : {}) };
      if (!terminal(task.status)) hasActive = true;
      const snapshot = (value: DesignTask | undefined) => JSON.stringify(value ? { ...value, elapsedMs: undefined } : undefined);
      if (!terminal(task.status) && snapshot(task) === snapshot(binding.task)) continue;
      let superseded = false;
      await withLock(`document-${binding.documentId}`, async () => {
        const document = await store.get(binding.documentId);
        const nodeId = binding.nodeId ?? task.nodeId;
        const node = document?.nodes.find((entry) => entry.id === nodeId);
        if (!document || !node) return;
        // The host bound this execution to one node and one execution id. A new
        // run on the same node replaces the id, so a late result from the old run
        // cannot overwrite the node the person is now looking at.
        if (binding.executionId && node.metadata.output.executionId !== binding.executionId) {
          superseded = true;
          task = { ...task, status: "interrupted", error: "这次运行已被同一节点上更新的运行取代，结果没有写入。" };
          return;
        }
        const currentSpec = runSpecFor(document, node, actionContext);
        const inputsChanged =
          binding.inputFingerprint !== undefined &&
          runFingerprintFor(currentSpec) !== binding.inputFingerprint;
        if (binding.cancelled) {
          // A cancelled run keeps the node's previous product and only records
          // that this attempt was interrupted. The live task may have resolved
          // late; the task record is not allowed to revive it as a success.
          task = { ...task, status: "interrupted", error: "" };
          const interrupted: DesignNode = { ...node, metadata: { ...node.metadata, output: { ...node.metadata.output, status: "interrupted", error: "" } } };
          await saveDocument({ ...document, nodes: document.nodes.map((entry) => entry.id === node.id ? interrupted : entry) });
          return;
        }
        if (inputsChanged) {
          // The prompt, a parameter or an upstream product changed while the run
          // was in flight. Stop the agent/provider first: settling the journal
          // without aborting would leave paid work running invisibly and the
          // node's next run would still see a busy identity. The late result is
          // still fenced by this settled task and by execution/fingerprint.
          await runner.cancelRun(taskId).catch(() => undefined);
          task = { ...task, status: "error", error: "输入在生成期间发生了变化，这次结果已丢弃，原运行已停止；请基于当前输入重新运行。" };
          const stale: DesignNode = { ...node, metadata: { ...node.metadata, output: { ...node.metadata.output, status: "error", error: task.error ?? "" } } };
          await saveDocument({ ...document, nodes: document.nodes.map((entry) => entry.id === node.id ? stale : entry) });
          return;
        }
        const status = task.status === "done" ? "success" : task.status === "error" ? "error" : task.status === "aborted" ? "interrupted" : "loading";
        const successful = task.status === "done";
        const nextNode = { ...node, metadata: { ...node.metadata, sessionId: typeof task.sessionId === "string" ? task.sessionId : node.metadata.sessionId, output: { ...node.metadata.output, status, text: successful && typeof task.text === "string" ? task.text : node.metadata.output.text, media: successful && Array.isArray(task.media) ? task.media : node.metadata.output.media, error: typeof task.error === "string" ? task.error : "" } } } as DesignNode;
        let next: DesignDocument = { ...document, nodes: document.nodes.map((entry) => entry.id === node.id ? nextNode : entry) };
        if (task.status === "done") next = materializeResults(next, nextNode, task, actionContext).canvas;
        if (JSON.stringify(next) !== JSON.stringify(document)) await saveDocument(next);
      });
      if (superseded) {
        await updateJournal((current) => { if (current.tasks[taskId]) { current.tasks[taskId].task = JSON.parse(JSON.stringify(task)) as DesignTask; current.tasks[taskId].settled = true; current.tasks[taskId].continuation = []; } });
        taskLeases.get(taskId)?.(); taskLeases.delete(taskId);
        continue;
      }
      await updateJournal((current) => { if (current.tasks[taskId]) { current.tasks[taskId].task = JSON.parse(JSON.stringify(task)) as DesignTask; current.tasks[taskId].settled = terminal(task.status); } });
      if (terminal(task.status)) { taskLeases.get(taskId)?.(); taskLeases.delete(taskId); }
      notify(binding.documentId);
      if (task.status === "done" && binding.continuation?.length) {
        await withLock(`chain-${binding.chainId ?? taskId}`, async () => {
          const latest = (await readJournal()).tasks[taskId];
          if (!latest || latest.cancelled || !latest.continuation?.length) return;
          const [nextNodeId, ...continuation] = latest.continuation;
          await updateJournal((current) => { current.tasks[taskId].continuation = []; });
          await startNodeRun(binding.documentId, nextNodeId, continuation, binding.chainId ?? taskId);
        });
        hasActive = true;
      }
    }
    if (hasActive) scheduleSettle();
  }
  async function startNodeRun(documentId: string, nodeId: string, continuation: readonly string[] = [], chainId?: string, alreadyLocked = false): Promise<DesignTask> {
    const start = async () => {
      const release = await acquireWebuiStorageLock(path.join(root, `task-${documentId}-${nodeId}.transaction.sqlite`), 0);
      let activeTaskId: string | undefined;
      try {
        const document = await store.get(documentId) ?? fail("NOT_FOUND", "Design document does not exist");
        const node = document.nodes.find((entry) => entry.id === nodeId) ?? fail("NOT_FOUND", "Design node does not exist");
        const spec = runSpecFor(document, node, actionContext);
        if (spec.error) fail("INVALID_ARGUMENTS", spec.error);
        // The host owns the target and the inputs it will accept a result for.
        const executionId = `x_${randomUUID().replaceAll("-", "")}`;
        const inputFingerprint = runFingerprintFor(spec);
        const invalid = validateRunSpec(spec);
        if (invalid) fail("MATERIAL_REQUIRED", invalid);
        const task = await runner.startRun({ ...spec, executionId, inputFingerprint }, { defer: true });
        activeTaskId = task.id;
        taskLeases.set(task.id, release);
        await updateJournal((journal) => { journal.tasks[task.id] = { documentId, nodeId, executionId, inputFingerprint, task: JSON.parse(JSON.stringify(task)) as DesignTask, continuation, chainId: chainId ?? task.id }; });
        await saveDocument({ ...document, nodes: document.nodes.map((entry) => entry.id === nodeId ? { ...entry, metadata: { ...entry.metadata, output: { ...entry.metadata.output, status: "loading", error: "", executionId } } } : entry) });
        // The binding and the observable loading state are durable before the
        // first external upload/understanding call can happen.
        runner.dispatchRun(task.id);
        scheduleSettle();
        return { ...task, chainId: chainId ?? task.id };
      } catch (error) { if (activeTaskId) { await runner.cancelRun(activeTaskId); taskLeases.delete(activeTaskId); } release(); throw error; }
    };
    return alreadyLocked ? start() : withLock(`document-${documentId}`, start);
  }
  async function apply(request: ApplyDesignActionRequest): Promise<DesignState> {
    // Collection must not race a local tool between publishing bytes and attaching its product.
    if (["gc_library", "remove_media", "upload", "publish", "set_media_poster", "media_tool", "understand", "transform"].includes(request.action.type)) return withLock("library-resources", () => applyCommand(request));
    return applyCommand(request);
  }
  async function applyCommand(request: ApplyDesignActionRequest): Promise<DesignState> {
    const action = request.action;
    const validationError = designActionError(action);
    if (validationError) fail("INVALID_ARGUMENTS", validationError);
    const resolvedTemplate = action.type !== "apply_template" ? undefined : action.template ? (() => {
      const parsed = readTemplateFile(JSON.stringify(action.template));
      if (!parsed.ok) fail("INVALID_ARGUMENTS", parsed.error);
      return parsed.template;
    })() : (await readDesignTemplates(root)).find((entry) => entry.id === action.templateId) ?? fail("NOT_FOUND", "Design template does not exist");
    let document = await chooseDocument(request);
    let result: unknown;
    let committedRevision: string | undefined;
    const commitDocument = async (next: DesignDocument) => { const saved = await saveDocument(next); committedRevision = saved.updatedAt; return saved; };
    if (action.type === "save_draft_edits") {
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > DESIGN_MAX_KEEPALIVE_BYTES) fail("payload_too_large", "Design close-page draft exceeds the 64 KiB JSON limit");
      if (!document) fail("NOT_FOUND", "Design document does not exist");
      const documentId = document.id;
      result = await withLock(`document-${documentId}`, async () => {
        const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document no longer exists");
        const documents = designDocumentsFromEdits(current, action.edits);
        assertDocument(documents.document); assertDocument(documents.baseDocument);
        return withLock(`draft-${documentId}`, async () => {
          const existing = await drafts.read(documentId);
          return withReferencedAssets([documents.document, documents.baseDocument], () => drafts.save(documents.document, documents.baseDocument, action.draftRevision), new Set([...assetReferences(current), ...assetReferences(existing)]));
        });
      });
    } else if (action.type === "save_draft") {
      if (!document || action.document.id !== document.id || action.baseDocument.id !== document.id || action.document.updatedAt !== action.baseDocument.updatedAt) fail("INVALID_ARGUMENTS", "Design draft and its genuine base must name the current document and origin revision");
      assertDocument(action.document); assertDocument(action.baseDocument);
      const documentId = document.id;
      result = await withLock(`document-${documentId}`, async () => {
        const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document no longer exists");
        return withLock(`draft-${documentId}`, async () => {
          const existing = await drafts.read(documentId);
          return withReferencedAssets([action.document, action.baseDocument], () => drafts.save(action.document, action.baseDocument, action.draftRevision), new Set([...assetReferences(current), ...assetReferences(existing)]));
        });
      });
    } else if (action.type === "remove_draft") {
      if (!document) fail("NOT_FOUND", "Design document does not exist");
      await withLock(`draft-${document.id}`, () => drafts.remove(document!.id, action.draftRevision));
      result = { removed: true };
    } else if (action.type === "set_media_poster") {
      if (!document) fail("NOT_FOUND", "Design document does not exist");
      const documentId = document.id;
      document = await withLock(`document-${documentId}`, async () => {
        const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document no longer exists");
        if (request.expectedRevision !== undefined && request.expectedRevision !== current.updatedAt) fail("CONFLICT", "Design document changed before its poster was saved");
        const node = current.nodes.find((entry) => entry.id === action.nodeId);
        if (!node || node.metadata.output.media[0]?.kind !== "video" || node.metadata.output.media[0]?.url !== action.sourceUrl) fail("CONFLICT", "Design media source changed before its poster was saved");
        const content = designPosterContent(action.base64);
        const posterUrl = await withLock(`asset-${content.name}`, () => publishDesignPoster(root, content));
        if (node.metadata.output.posterUrl === posterUrl) { committedRevision = current.updatedAt; return current; }
        return commitDocument({ ...current, nodes: current.nodes.map((entry) => entry.id === node.id ? { ...entry, metadata: { ...entry.metadata, output: { ...entry.metadata.output, posterUrl } } } : entry) });
      });
    } else if (action.type === "create") document = await createDocument(action.title);
    else if (action.type === "apply_template" && (!document || document.nodes.length > 0)) {
      const template = resolvedTemplate!;
      const fresh = await createDocument(String(template.title ?? "Untitled design"));
      document = await withLock(`document-${fresh.id}`, async () => {
        const applied = applyTemplate(fresh, template, actionContext);
        if (applied.error) fail("INVALID_ARGUMENTS", applied.error);
        assertDocument(applied.canvas);
        return commitDocument(applied.canvas);
      });
    }
    else if (action.type === "open") {
      document ??= await createDocument(action.title);
      if (request.sessionId) {
        const intent: DesignOpenIntent = { id: randomUUID(), sessionId: request.sessionId, documentId: document.id, createdAt: new Date().toISOString() };
        await updateJournal((journal) => { journal.intents[request.sessionId!] = intent; });
        events.publish("design.open", { ...intent, openIntent: intent });
      }
    } else if (["upload", "publish", "media_tool", "understand", "transform", "remove_media", "refresh_media", "export", "export_file", "places", "list_voices", "gc_library", "save_template", "remove_template", "cancel", "answer", "permission"].includes(action.type)) {
      if (["publish", "media_tool", "understand", "transform"].includes(action.type)) document ??= await createDocument();
      result = await applyResource(action, document?.id);
      if (document && ["publish", "media_tool", "understand", "transform"].includes(action.type) && result && typeof result === "object") {
        const payload = result as Record<string, unknown>;
        const produced = Array.isArray(payload.artifacts) ? payload.artifacts : Array.isArray(payload.media) ? payload.media : typeof payload.url === "string" ? [payload] : [];
        const text = typeof payload.text === "string" ? payload.text : "";
        if (produced.length || text) {
          const products: DesignMedia[] = [];
          for (const item of produced) {
            const product = item as DesignMedia;
            assertMediaUrl(product.url);
            const url = product.url.startsWith("/design-assets/") ? product.url : await media.store.publishRemote(product.url, product.kind);
            products.push({ ...product, url });
          }
          const documentId = document.id;
          document = await withLock(`document-${documentId}`, async () => {
            const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document no longer exists");
            const sourceUrl = action.type === "media_tool" ? action.sources[0]?.url : action.type === "transform" || action.type === "understand" ? action.url : undefined;
            const sourceNodeId = "sourceNodeId" in action ? action.sourceNodeId : undefined;
            const title = action.type === "media_tool" ? String(findTool(action.tool)?.label ?? action.tool) : action.type === "understand" ? "Media understanding" : action.type === "transform" ? String(findTool(action.tool)?.label ?? action.tool) : "name" in action ? action.name : "Design result";
            const appended = appendDesignProducts(current, { sourceNodeId, sourceUrl, title, text, media: products });
            const knownIds = new Set(current.nodes.map((node) => node.id));
            const createdNodeIds = appended.nodes.filter((node) => !knownIds.has(node.id)).map((node) => node.id);
            const saved = await commitDocument(appended);
            result = { ...payload, createdNodeIds };
            return saved;
          });
        }
      }
    } else {
      if (!document) fail("NOT_FOUND", "Create a Design document first");
      const documentId = document.id;
      document = await withLock(`document-${documentId}`, async () => {
        const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document does not exist");
        if (request.expectedRevision !== undefined && request.expectedRevision !== current.updatedAt) fail("CONFLICT", "Design changed in another view; reload before saving");
        if (action.type === "restore_draft") {
          if (request.expectedRevision === undefined) fail("INVALID_ARGUMENTS", "Restoring a Design draft requires the current expectedRevision");
          return withLock(`draft-${documentId}`, async () => {
            const draft = await drafts.read(documentId);
            if (!draft || draft.revision !== action.draftRevision) fail("CONFLICT", "Design draft changed; reload before restoring");
            const merged = mergeDesignDraft(draft, current);
            assertDocument(merged);
            const saved = await commitDocument(merged);
            await drafts.remove(documentId, draft.revision);
            return saved;
          });
        }
        if (action.type === "remove") {
          await store.remove(documentId);
          await withLock(`draft-${documentId}`, async () => { const draft = await drafts.read(documentId); if (draft) await drafts.remove(documentId, draft.revision); });
          await updateJournal((journal) => { for (const [sessionId, intent] of Object.entries(journal.intents)) if (intent.documentId === documentId) delete journal.intents[sessionId]; });
          return undefined;
        }
        if (action.type === "save") {
          if (action.document.id !== documentId) fail("INVALID_ARGUMENTS", "Design document identity cannot change");
          assertDocument(action.document);
          return commitDocument({ ...action.document, updatedAt: request.expectedRevision ?? action.document.updatedAt });
        }
        if (action.type === "run") {
          const node = current.nodes.find((entry) => entry.id === action.nodeId);
          if (!node) fail("NOT_FOUND", "Design node does not exist");
          const plan = [...(action.chain === false ? [] : pendingAncestors(current, node)), node];
          result = await startNodeRun(documentId, plan[0].id, plan.slice(1).map((step) => step.id), undefined, true);
          return current;
        }
        let next: DesignDocument;
        if (action.type === "disconnect") next = { ...current, connections: current.connections.filter((connection) => connection.id !== action.connectionId) };
        else if (action.type === "apply_template") {
          const template = resolvedTemplate!;
          const applied = applyTemplate(current, template, actionContext);
          if (applied.error) fail("INVALID_ARGUMENTS", applied.error);
          next = { ...applied.canvas, title: String(template.title ?? "").trim() || current.title };
        } else if (action.type === "update_node") next = applyDesignNodePatch(current, action.nodeId, action.patch, actionContext);
        else {
          const args = action.type === "add_node" ? { ...action, type: action.nodeType } : action.type === "remove_node" ? { id: action.nodeId } : action.type === "connect" ? { from: action.from, to: action.to, role: action.role } : fail("INVALID_ARGUMENTS", `Unknown Design action: ${action.type}`);
          const applied = applyAction(current, { type: action.type, args }, actionContext);
          if (applied.error) fail("INVALID_ARGUMENTS", applied.error);
          next = applied.canvas;
          result = applied.info;
        }
        assertDocument(next);
        return commitDocument(next);
      });
    }
    notify(document?.id, request.sessionId);
    return { ...await getState({ ...request, documentId: document?.id }), ...(committedRevision ? { committedRevision } : {}), ...(result !== undefined ? { result } : {}) };
  }
  async function applyResource(action: DesignAction, documentId?: string): Promise<unknown> {
    if (action.type === "upload" || action.type === "publish") {
      if (typeof action.base64 !== "string" || action.base64.length > 90_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(action.base64)) fail("INVALID_ARGUMENTS", "Design upload must be bounded base64 data");
      const bytes = Buffer.from(action.base64, "base64");
      if (bytes.byteLength > DESIGN_MAX_MEDIA_BYTES) fail("payload_too_large", "Design media exceeds the 64 MiB file limit");
      if (action.type === "upload") return media.store.saveUpload(action.name, bytes, action.kind);
      const extension = path.extname(action.name).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) fail("INVALID_ARGUMENTS", "Only images can be published");
      return media.store.publishBytes(bytes, extension);
    }
    if (action.type === "media_tool") {
      for (const source of action.sources) assertMediaUrl(source.url);
      const definition = findTool(action.tool) ?? fail("INVALID_ARGUMENTS", "Unknown Design media tool");
      if (definition.run === "agent") {
        if (!documentId || !action.sources.length) fail("INVALID_ARGUMENTS", "A Design document and source material are required");
        const generatedIds: string[] = [];
        await withLock(`document-${documentId}`, async () => {
          let current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document does not exist");
          let source = action.sourceNodeId ? current.nodes.find((node) => node.id === action.sourceNodeId) : current.nodes.find((node) => node.metadata.output.media.some((product) => product.url === action.sources[0].url));
          if (!source) {
            const added = applyAction(current, { type: "add_node", args: { type: "input", kind: action.sources[0].kind, title: "Tool source" } }, actionContext);
            if (added.error) fail("INVALID_ARGUMENTS", added.error);
            current = added.canvas;
            const id = String(added.info?.id);
            current = applyDesignNodePatch(current, id, { metadata: { output: { status: "success", text: "", media: action.sources, error: "" } } }, actionContext);
            source = current.nodes.find((node) => node.id === id)!;
          }
          const variations = fanOutParams(definition, action.params);
          if (!variations.length) fail("INVALID_ARGUMENTS", "Select at least one tool variation");
          for (const [index, variation] of variations.entries()) {
            const added = applyAction(current, { type: "add_node", args: { type: "image", title: `${definition.label}${variation.label ? ` · ${variation.label}` : ""}`, prompt: toolPrompt(definition, variation.params), x: source.position.x + source.width + 80 + index * 380, y: source.position.y } }, actionContext);
            if (added.error) fail("INVALID_ARGUMENTS", added.error);
            const id = String(added.info?.id);
            const connected = applyAction(added.canvas, { type: "connect", args: { from: source.id, to: id } }, actionContext);
            if (connected.error) fail("INVALID_ARGUMENTS", connected.error);
            current = connected.canvas;
            generatedIds.push(id);
          }
          await saveDocument(current);
        });
        const tasks = [];
        for (const id of generatedIds) tasks.push(await startNodeRun(documentId, id));
        return { tasks, createdNodeIds: generatedIds };
      }
      if (definition.run === "understand" || definition.run === "connector") {
        const source = action.sources[0] ?? fail("INVALID_ARGUMENTS", "This tool requires source material");
        const url = await media.prepareForProvider({ url: source.url });
        return definition.run === "understand" ? runner.understand({ kind: source.kind, url, prompt: toolPrompt(definition, action.params) }) : runner.transformImage({ tool: action.tool, url });
      }
      if (definition.run === "ffmpeg" || definition.run === "local") return media.run(action);
      fail("INVALID_ARGUMENTS", "Unsupported Design media tool execution family");
    }
    if (action.type === "transform" || action.type === "understand") {
      assertMediaUrl(action.url);
      if (action.type === "transform" && findTool(action.tool)?.run !== "connector") fail("INVALID_ARGUMENTS", "Unknown Design provider transform");
      const url = await media.prepareForProvider({ url: action.url });
      return action.type === "understand" ? runner.understand({ ...action, url }) : runner.transformImage({ ...action, url });
    }
    if (action.type === "remove_media") {
      if (!plainAssetName(action.name)) fail("INVALID_ARGUMENTS", "Invalid media name");
      return withLock(`asset-${action.name}`, async () => {
        if ([...(await referenceOwners()).keys()].some((reference) => reference.split("/").pop() === action.name)) fail("IN_USE", "This material is referenced by a saved Design document or draft");
        return media.store.removeAsset(action.name);
      });
    }
    if (action.type === "gc_library") {
      if (Object.values((await readJournal()).tasks).some((binding) => !binding.settled)) fail("DESIGN_BUSY", "Wait for running Design tasks to settle before cleaning unused material");
      const removed: string[] = [];
      for (const asset of await media.store.listLibrary()) await withLock(`asset-${asset.name}`, async () => {
        if ((await referenceOwners()).has(asset.url)) return;
        if (await media.store.removeAsset(asset.name)) removed.push(asset.name);
      });
      return { removed };
    }
    if (action.type === "list_voices") { voiceCatalog = await readDesignVoices(execution, controller.signal); return voiceCatalog; }
    if (action.type === "places") return designExportPlaces();
    if (action.type === "export_file") {
      let bytes: Uint8Array;
      if (action.source.type === "media") {
        const match = /^\/design-assets\/(assets|uploads)\/([A-Za-z0-9][\w.-]*)$/.exec(action.source.media.url);
        if (!match) fail("INVALID_ARGUMENTS", "Only authority-owned local Design media can be exported");
        bytes = await withLock(`asset-${match[2]}`, async () => {
          const target = path.join(root, match[1], match[2]); const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_ARGUMENTS", "Design export source must be a regular managed asset");
          return readFile(target);
        });
      } else {
        if (!action.path.toLowerCase().endsWith(".json")) fail("INVALID_ARGUMENTS", "Design template export destination must end in .json");
        let template;
        if (action.source.type === "template") { const templateId = action.source.templateId; template = (await readDesignTemplates(root)).find((item) => item.id === templateId) ?? fail("NOT_FOUND", "Design template does not exist"); }
        else {
          if (!documentId) fail("NOT_FOUND", "Create a Design document before exporting its template");
          template = await withLock(`document-${documentId}`, async () => { const current = await store.get(documentId) ?? fail("NOT_FOUND", "Design document does not exist"); return templateFromCanvas(current, { id: `own-${current.id}`, title: `${current.title} 的模板` }); });
        }
        if (!Array.isArray(template.actions) || !template.actions.length) fail("INVALID_ARGUMENTS", "This Design contains no reusable template steps");
        bytes = Buffer.from(JSON.stringify(templateFile(template), null, 2) + "\n");
      }
      return exportDesignBytes(action.path, bytes, action.overwrite);
    }
    if (action.type === "refresh_media") {
      if (action.media.taskId) return media.store.refreshVideoUrl(action.media.taskId, action.media.model);
      fail("INVALID_ARGUMENTS", "This media has no provider task to refresh");
    }
    if (action.type === "export") { assertMediaUrl(action.media.url); if (!action.media.url.startsWith("/design-assets/")) fail("INVALID_ARGUMENTS", "Export requires a local Design asset"); return { url: `${action.media.url}?download=${encodeURIComponent(action.name)}` }; }
    if (action.type === "save_template") { await saveDesignTemplate(root, action.template); return { saved: true }; }
    if (action.type === "remove_template") { await removeDesignTemplate(root, action.templateId); return { removed: true }; }
    if (action.type === "cancel") {
      const journal = await readJournal();
      const binding = journal.tasks[action.taskId] ?? fail("NOT_FOUND", "Design task does not exist");
      const chainId = binding.chainId ?? action.taskId;
      return withLock(`chain-${chainId}`, async () => {
        const latest = await readJournal();
        const group = Object.entries(latest.tasks).filter(([id, value]) => (value.chainId ?? id) === chainId);
        if (group.some(([id, value]) => !value.settled && !taskLeases.has(id))) fail("DESIGN_BUSY", "This Design task is owned by another active client process");
        await updateJournal((current) => { for (const [id] of group) { current.tasks[id].cancelled = true; current.tasks[id].continuation = []; } });
        let result: DesignTask | undefined;
        for (const [id, value] of group) if (!value.settled) {
          result = await runner.cancelRun(id);
        }
        scheduleSettle();
        return result ?? binding.task;
      });
    }
    if (action.type === "answer") { const task = await runner.answer(action.taskId, { requestId: action.requestId, answers: action.answers }); scheduleSettle(); return task; }
    if (action.type === "permission") return runner.replyPermission(action.taskId, { requestId: action.requestId, decision: action.decision });
    fail("INVALID_ARGUMENTS", "Unknown Design resource action");
  }
  return {
    tool: {
      clientId: "webui-design",
      executionWorkspaceDir: path.join(root, "workspace"),
      async execute(context, input) {
        context.signal?.throwIfAborted();
        const type = String(input.action ?? "read");
        const request = { sessionId: context.sessionId, ...(typeof input.documentId === "string" ? { documentId: input.documentId } : {}) };
        if (["list", "read", "list_templates"].includes(type)) return getState(request);
        const { action: _action, documentId: _documentId, expectedRevision, ...fields } = input;
        return apply({ ...request, ...(typeof expectedRevision === "string" ? { expectedRevision } : {}), action: { ...fields, type } as DesignAction });
      },
    },
    events, getState, apply,
    async readAsset(request) {
      if (!plainAssetName(request.name) || !["assets", "uploads"].includes(request.kind)) fail("INVALID_ARGUMENTS", "Invalid Design asset identity");
      const target = path.join(root, request.kind, request.name);
      try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_ARGUMENTS", "Design assets must be regular files"); }
      catch (error) { if (isMissing(error)) return null; throw error; }
      const asset = request.kind === "assets" ? await media.store.readAsset(request.name) : await media.store.readUpload(request.name);
      return asset ? { bytes: asset.data, mimeType: asset.mimeType } : null;
    },
    async attachExecution(next) {
      execution = next;
      voiceCatalog = { voices: [], voiceSource: "not-loaded" };
      if (!execution) return;
      const journal = await readJournal();
      const acquired: string[] = [];
      for (const [id, binding] of Object.entries(journal.tasks)) if (!binding.settled && typeof (binding.nodeId ?? binding.task?.nodeId) === "string") {
        const nodeId = binding.nodeId ?? binding.task!.nodeId!;
        try { taskLeases.set(id, await acquireWebuiStorageLock(path.join(root, `task-${binding.documentId}-${nodeId}.transaction.sqlite`), 0)); acquired.push(id); }
        catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "DESIGN_BUSY")) throw error; }
      }
      await runner.restore(acquired);
      for (const id of acquired) if (!runner.get(id)) {
        const binding = journal.tasks[id];
        await updateJournal((current) => { current.tasks[id] = { ...binding, settled: true, continuation: [], task: { ...binding.task!, status: "interrupted", finishedAt: Date.now(), error: "Design runtime restarted before this execution settled; inspect the result before retrying" } }; });
        await withLock(`document-${binding.documentId}`, async () => {
          const document = await store.get(binding.documentId);
          const nodeId = binding.nodeId ?? binding.task!.nodeId;
          const node = document?.nodes.find((entry) => entry.id === nodeId);
          // A newer run already owns this node; the restarted runtime must not
          // stamp it interrupted.
          if (!document || !node || (binding.executionId && node.metadata.output.executionId !== binding.executionId)) return;
          await saveDocument({ ...document, nodes: document.nodes.map((entry) => entry.id === node.id ? { ...entry, metadata: { ...entry.metadata, output: { ...entry.metadata.output, status: "interrupted", error: "Design runtime restarted before this execution settled" } } } : entry) });
        });
        taskLeases.get(id)?.(); taskLeases.delete(id);
      }
      if (runner.listForPage().length) scheduleSettle();
    },
    async close() {
      if (closed) return;
      if (timer) clearTimeout(timer);
      controller.abort();
      await settling;
      for (const release of taskLeases.values()) release();
      taskLeases.clear();
      media.dispose();
      await execution?.close();
      closed = true;
    },
  };
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
