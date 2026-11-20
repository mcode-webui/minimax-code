import type { DesignDocument, DesignNodeMetadata } from "../../shared/contracts/design.js";
import { applyAction, type DesignActionContext } from "../../shared/design/actions.mjs";

const businessFields = new Set(["prompt", "model", "mode", "ratio", "resolution", "duration", "count", "voice", "emotion", "templateId", "templateText"]);
const directFields = new Set(["segments", "mentions", "kind", "output", "sessionId", "userSized", "templateVars"]);
function invalid(message: string): never { throw Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" }); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Design node patch must contain object records"); return value as Record<string, unknown>; }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Native edits use explicit writable fields; generation rules remain the extracted authority. */
export function applyDesignNodePatch(document: DesignDocument, nodeId: string, patch: Readonly<Record<string, unknown>>, context: DesignActionContext): DesignDocument {
  const node = document.nodes.find((entry) => entry.id === nodeId) ?? invalid("Design node does not exist");
  const input = record(patch);
  const metadata = input.metadata === undefined ? {} : record(input.metadata);
  for (const [key, value] of Object.entries(input)) {
    if (["title", "position", "width", "height", "metadata"].includes(key)) continue;
    if (!businessFields.has(key) && !directFields.has(key)) invalid(`Unknown writable Design node field: ${key}`);
    if (Object.hasOwn(metadata, key) && !same(metadata[key], value)) invalid(`Conflicting Design node patch field: ${key}`);
    metadata[key] = value;
  }
  const args: Record<string, unknown> = { id: nodeId };
  if (input.title !== undefined) { if (typeof input.title !== "string") invalid("Design node title must be text"); args.title = input.title; }
  const direct: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (same(value, node.metadata[key])) continue;
    if (businessFields.has(key)) { args[key] = value; continue; }
    if (!directFields.has(key)) invalid(`Design node metadata field is read-only: ${key}`);
    if (key === "sessionId" && value !== null) invalid("Design execution session can only be reset");
    if (key === "kind" && (node.type !== "input" || !["text", "image", "video", "audio"].includes(String(value)))) invalid("Only an input node can change its material kind");
    if (["segments", "mentions"].includes(key) && !Array.isArray(value)) invalid(`Design ${key} must be an array`);
    if (["output", "templateVars"].includes(key)) record(value);
    if (key === "userSized" && typeof value !== "boolean") invalid("Design userSized must be boolean");
    direct[key] = key === "output" ? { ...node.metadata.output, ...record(value) } : value;
    if (key === "output" && Array.isArray(record(value).media) && (record(value).media as { url?: string }[])[0]?.url !== node.metadata.output.media[0]?.url) direct.output = { ...record(direct.output), posterUrl: "" };
  }
  const applied = applyAction(document, { type: "update_node", args }, context);
  if (applied.error) invalid(applied.error);
  const updated = applied.canvas.nodes.find((entry) => entry.id === nodeId)!;
  const geometry: Record<string, unknown> = {};
  if (input.position !== undefined) {
    const position = record(input.position);
    if (typeof position.x !== "number" || !Number.isFinite(position.x) || typeof position.y !== "number" || !Number.isFinite(position.y)) invalid("Design node position must have finite x and y");
    geometry.position = { x: position.x, y: position.y };
  }
  for (const key of ["width", "height"] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] <= 0) invalid(`Design node ${key} must be positive and finite`);
    geometry[key] = input[key];
  }
  const next = { ...updated, ...geometry, metadata: { ...updated.metadata, ...direct } as DesignNodeMetadata };
  return { ...applied.canvas, nodes: applied.canvas.nodes.map((entry) => entry.id === nodeId ? next : entry), connections: direct.kind ? applied.canvas.connections.map((connection) => connection.fromNodeId === nodeId ? { ...connection, kind: String(direct.kind) } : connection) : applied.canvas.connections };
}
