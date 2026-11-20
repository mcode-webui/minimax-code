import type { DesignAction } from "./contracts/design.js";
export const DESIGN_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const DESIGN_MAX_HTTP_ACTION_BYTES = 96 * 1024 * 1024;
export const DESIGN_MAX_KEEPALIVE_BYTES = 64 * 1024;

const actions = new Set(["open", "create", "save", "remove", "add_node", "update_node", "remove_node", "connect", "disconnect", "apply_template", "save_template", "remove_template", "run", "cancel", "answer", "permission", "upload", "publish", "set_media_poster", "transform", "understand", "media_tool", "remove_media", "refresh_media", "export", "gc_library", "list_voices", "places", "export_file", "save_draft", "save_draft_edits", "restore_draft", "remove_draft"]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
/** Shared structural admission; runtime authorities retain semantic and ownership checks. */
export function designActionError(value: unknown): string | undefined {
  if (!object(value) || typeof value.type !== "string" || !actions.has(value.type)) return "action.type must name a supported Design action";
  const stringFields: Record<string, readonly string[]> = { add_node: ["nodeType"], update_node: ["nodeId"], remove_node: ["nodeId"], connect: ["from", "to"], disconnect: ["connectionId"], remove_template: ["templateId"], run: ["nodeId"], cancel: ["taskId"], answer: ["taskId"], permission: ["taskId", "requestId", "decision"], upload: ["name", "kind", "base64"], publish: ["name", "base64"], transform: ["tool", "url"], understand: ["kind", "url"], media_tool: ["tool"], remove_media: ["name"], export: ["name"] };
  for (const field of stringFields[value.type] ?? []) if (typeof value[field] !== "string" || !value[field]) return `Design ${value.type}.${field} must be a non-empty string`;
  if (value.type === "set_media_poster" && ["nodeId", "sourceUrl", "base64"].some((field) => typeof value[field] !== "string" || !value[field])) return "Design set_media_poster requires nodeId, sourceUrl and base64";
  if (value.type === "apply_template" && !((typeof value.templateId === "string" && Boolean(value.templateId) && value.template === undefined) || (object(value.template) && value.templateId === undefined))) return "Design apply_template requires exactly one of templateId or template";
  for (const [type, field] of [["save", "document"], ["update_node", "patch"], ["save_template", "template"], ["media_tool", "params"], ["refresh_media", "media"], ["export", "media"]]) if (value.type === type && !object(value[field])) return `Design ${type}.${field} must be an object`;
  if (value.type === "media_tool" && (!Array.isArray(value.sources) || value.sources.length === 0 || !value.sources.every((source) => object(source) && typeof source.url === "string" && ["text", "image", "video", "audio"].includes(String(source.kind))))) return "Design media_tool.sources must contain material URLs and kinds";
  if (value.type === "answer" && (!Array.isArray(value.answers) || !value.answers.every((answer) => object(answer) && typeof answer.stepId === "string" && Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.every((id) => typeof id === "string") && typeof answer.selectedOther === "boolean"))) return "Design answer.answers must contain structured questionnaire replies";
  if (value.type === "permission" && !["allowOnce", "deny"].includes(String(value.decision))) return "Design permission.decision must be allowOnce or deny";
  if (value.type === "add_node" && !["input", "text", "image", "video", "audio", "group"].includes(String(value.nodeType))) return "Design add_node.nodeType must be a creatable node form";
  if (["upload", "understand"].includes(value.type) && !["text", "image", "video", "audio"].includes(String(value.kind))) return `Design ${value.type}.kind must be a material kind`;
  for (const field of ["x", "y"]) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) return `Design ${field} must be finite`;
  if (value.chain !== undefined && typeof value.chain !== "boolean") return "Design run.chain must be boolean";
  if (value.type === "export_file") {
    if (typeof value.path !== "string" || !value.path) return "Design export_file.path must be a non-empty string";
    if (!object(value.source) || !["document_template", "template", "media"].includes(String(value.source.type))) return "Design export_file.source must name authority-owned template or media content";
    if (value.source.type === "template" && (typeof value.source.templateId !== "string" || !value.source.templateId)) return "Design export_file.source.templateId must be a non-empty string";
    if (value.source.type === "media" && (!object(value.source.media) || typeof value.source.media.url !== "string")) return "Design export_file.source.media must contain a media URL";
    if (value.overwrite !== undefined && typeof value.overwrite !== "boolean") return "Design export_file.overwrite must be boolean";
  }
  if (value.type === "save_draft" && (!object(value.document) || !object(value.baseDocument))) return "Design save_draft must contain document and baseDocument objects";
  if (value.type === "save_draft_edits") {
    if (!Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 300) return "Design save_draft_edits.edits must contain 1 to 300 edits";
    for (const edit of value.edits) {
      if (!object(edit) || typeof edit.nodeId !== "string" || !object(edit.baseNode) || edit.baseNode.id !== edit.nodeId || !object(edit.baseNode.metadata) || !object(edit.patch)) return "Design draft edits require nodeId, its genuine baseNode and an editable patch";
      if (Object.keys(edit.patch).some((key) => !["title", "metadata"].includes(key)) || (edit.patch.title !== undefined && typeof edit.patch.title !== "string")) return "Design draft patches may contain only title and editable metadata";
      const metadata = edit.patch.metadata;
      if (metadata !== undefined && (!object(metadata) || Object.keys(metadata).some((key) => !["prompt", "segments", "mentions", "templateId", "templateText", "templateVars"].includes(key)))) return "Design draft metadata may contain only prompt, segments, mentions and template fields";
      if (object(metadata)) {
        for (const field of ["prompt", "templateId", "templateText"]) if (metadata[field] !== undefined && typeof metadata[field] !== "string") return `Design draft metadata.${field} must be a string`;
        if (metadata.segments !== undefined && (!Array.isArray(metadata.segments) || !metadata.segments.every((segment) => object(segment) && ((segment.type === "text" && typeof segment.text === "string") || (segment.type === "mention" && typeof segment.nodeId === "string" && ["text", "image", "video", "audio"].includes(String(segment.kind))))))) return "Design draft metadata.segments must contain text or material mentions";
        if (metadata.mentions !== undefined && (!Array.isArray(metadata.mentions) || !metadata.mentions.every((mention) => object(mention) && typeof mention.nodeId === "string" && ["text", "image", "video", "audio"].includes(String(mention.kind))))) return "Design draft metadata.mentions must contain material mentions";
        if (metadata.templateVars !== undefined && (!object(metadata.templateVars) || !Object.values(metadata.templateVars).every((entry) => typeof entry === "string"))) return "Design draft metadata.templateVars must contain string values";
      }
    }
  }
  if (["restore_draft", "remove_draft"].includes(value.type) && (typeof value.draftRevision !== "string" || !value.draftRevision)) return `Design ${value.type}.draftRevision must be a non-empty string`;
  return undefined;
}
export function isDesignAction(value: unknown): value is DesignAction { return designActionError(value) === undefined; }
