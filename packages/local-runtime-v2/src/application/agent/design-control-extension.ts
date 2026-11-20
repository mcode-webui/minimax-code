import { defineRuntimeTool, type AgentExtension } from "@mavis/agent-runtime";
import { Type } from "@sinclair/typebox";
import type { NativeDesignToolAdapter } from "../../local/design-host-contract.js";
import { createLocalTurnToolCatalogInput } from "../../service/turn-system/agent-host/assembly/local-turn-tool-catalog-source.js";
import { filterLocalTurnCapabilityInventory } from "../../service/turn-system/agent-host/assembly/local-turn-tool-catalog.js";

const actions = ["open", "list", "read", "create", "save", "remove", "add_node", "update_node", "remove_node", "connect", "disconnect", "list_templates", "apply_template", "save_template", "remove_template", "run", "cancel", "media_tool", "understand", "transform", "upload", "publish", "set_media_poster", "export", "refresh_media", "remove_media", "permission", "answer", "gc_library", "list_voices", "places", "export_file", "save_draft", "save_draft_edits", "restore_draft", "remove_draft"] as const;

/** Registered only by a host that provides a real native Design authority. */
export function createNativeDesignControlExtension(adapter: NativeDesignToolAdapter): AgentExtension {
  const readActions = ["list", "read", "list_templates"];
  const buildTool = (readOnly: boolean) => defineRuntimeTool({
    name: "design",
    description: readOnly ? "Read native Design documents, node input/output ports, model parameters, task progress and templates. This delegated or read-only Agent can only list/read/list_templates. It cannot open UI, change documents or execute generation." : "Open and operate the native Design node canvas through this client's Design surface. Inspect nodes, mode/model-specific input ports, generation parameters, tasks, media and templates. Construct connected text/image/video/audio workflows using add_node (nodeType=input/text/image/video/audio/group), update_node (nodeId and patch), connect (from/to/role), apply_template (templateId), and run (nodeId). Run fills unfinished upstream generation steps in dependency order, reuses finished products and stops on upstream errors or cancellation. Generation can incur provider charges. Read/list never opens or steals focus. Input is {action,documentId?,...action fields}; open requests the current client's session-scoped Design surface. The tool returns authoritative persisted state; use document.updatedAt as expectedRevision when editing.",
    schema: Type.Object({
      action: Type.String({ enum: readOnly ? readActions : [...actions] }),
      documentId: Type.Optional(Type.String({ description: "Document id returned by list/read/create." })),
      expectedRevision: Type.Optional(Type.String({ description: "The document.updatedAt revision read before an edit." })),
      nodeType: Type.Optional(Type.String({ enum: ["input", "text", "image", "video", "audio", "group"], description: "add_node: node form. Inputs hold material; text/image/video/audio generate results." })),
      nodeId: Type.Optional(Type.String({ description: "update_node/remove_node/run: target node id." })),
      sourceNodeId: Type.Optional(Type.String({ description: "publish/media_tool/understand/transform: the source node to connect persisted products to." })),
      sourceUrl: Type.Optional(Type.String({ description: "set_media_poster: the current video source URL; changed sources reject stale thumbnails." })),
      chain: Type.Optional(Type.Boolean({ description: "run: defaults to true; fill unfinished upstream dependencies in order." })),
      title: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String({ enum: ["text", "image", "video", "audio"] })),
      mode: Type.Optional(Type.String({ description: "Mode id from read.capabilities.nodeForms. It determines input ports." })),
      x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()),
      patch: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "update_node: title,prompt,model,ratio,resolution,duration,count,voice,emotion,mode,templateId,templateText. Read capabilities before selecting model parameters." })),
      from: Type.Optional(Type.String({ description: "connect: upstream node id." })), to: Type.Optional(Type.String({ description: "connect: downstream node id." })), role: Type.Optional(Type.String({ description: "connect: optional first/last port role." })), connectionId: Type.Optional(Type.String()),
      templateId: Type.Optional(Type.String()), templateText: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()), tool: Type.Optional(Type.String({ description: "Media tool key from read.capabilities.tools." })),
      sources: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      url: Type.Optional(Type.String()), name: Type.Optional(Type.String()), base64: Type.Optional(Type.String()),
      media: Type.Optional(Type.Record(Type.String(), Type.Unknown())), document: Type.Optional(Type.Record(Type.String(), Type.Unknown())), template: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      path: Type.Optional(Type.String({ description: "export_file: explicit absolute destination, with an existing parent; only Design-owned content can be exported." })),
      source: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "export_file: {type:document_template}, {type:template,templateId}, or {type:media,media}. No arbitrary source filename." })),
      overwrite: Type.Optional(Type.Boolean({ description: "export_file: explicitly replace an existing regular destination file; defaults false." })),
      baseDocument: Type.Optional(Type.Record(Type.String(), Type.Unknown())), draftRevision: Type.Optional(Type.String()),
      edits: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "save_draft_edits: bounded close-page editable patches with their genuine baseNode; title/prompt/segments/mentions/template fields only." })),
      requestId: Type.Optional(Type.String()), decision: Type.Optional(Type.String({ enum: ["allowOnce", "deny"] })), answers: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    }, { additionalProperties: false }),
    source: "builtin",
    operationClassifier: { allowedValues: actions, classify: (input) => typeof input === "object" && input !== null && "action" in input ? String(input.action) : undefined },
    execute: async (context, input, signal) => {
      try {
        signal?.throwIfAborted();
        if (readOnly && !readActions.includes(input.action)) throw Object.assign(new Error("This Agent has read-only Design access; opening UI, mutations and generation are unavailable"), { code: "DESIGN_READ_ONLY" });
        const result = await adapter.execute({ sessionId: context.sessionId, turnId: context.turnId, ...(signal ? { signal } : {}) }, input);
        const text = JSON.stringify(result);
        return { tool_name: "design", text, content: [{ type: "text" as const, text }], details: { result } };
      } catch (error) {
        const result = { ok: false, error: { code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "DESIGN_ERROR", message: error instanceof Error ? error.message : String(error) } };
        const text = JSON.stringify(result);
        return { tool_name: "design", text, content: [{ type: "text" as const, text }], details: result, isError: true };
      }
    },
  });
  const tool = buildTool(false);
  const readOnlyTool = buildTool(true);
  return { id: "native-design", description: "Native client-owned Design workspace and workflow control.", init(api) {
    api.registerTool((context) => {
      const facts = createLocalTurnToolCatalogInput(context);
      const admitted = filterLocalTurnCapabilityInventory({ sources: { nativeTools: [tool], mcpEntries: [], threadGoalTools: [], cuRuntimeAvailable: false }, modelCapabilities: facts.modelCapabilities, agentProfile: facts.agentProfile }).nativeTools;
      if (admitted.length === 0) return null;
      const profile = facts.agentProfile;
      return profile?.surface === "task-child" || (profile?.trustedBuiltin && ["explore", "verifier"].includes(profile.canonicalRole ?? "")) ? readOnlyTool : tool;
    });
  } };
}
