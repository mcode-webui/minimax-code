import { lstat, readFile, rm, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file.mjs";
import type { DesignDocument, DesignDraft, DesignDraftEdit, DesignNode } from "../../shared/contracts/design.js";

/** Reconstruct only declared editor fields; runtime outputs never become an unsaved edit. */
export function designDocumentsFromEdits(current: DesignDocument, edits: readonly DesignDraftEdit[]): { document: DesignDocument; baseDocument: DesignDocument } {
  const bases = new Map<string, DesignNode>(), wanted = new Map<string, DesignNode>();
  for (const edit of edits) {
    if (bases.has(edit.nodeId)) throw Object.assign(new Error("Design draft edits must name each node once"), { code: "INVALID_ARGUMENTS" });
    const latest = current.nodes.find((node) => node.id === edit.nodeId) ?? edit.baseNode;
    const metadata = { ...latest.metadata };
    for (const key of Object.keys(edit.patch.metadata ?? {})) metadata[key] = edit.baseNode.metadata[key];
    const base = { ...latest, ...(edit.patch.title !== undefined ? { title: edit.baseNode.title } : {}), metadata };
    bases.set(edit.nodeId, base);
    wanted.set(edit.nodeId, { ...base, ...(edit.patch.title !== undefined ? { title: edit.patch.title } : {}), metadata: { ...base.metadata, ...edit.patch.metadata } });
  }
  const withNodes = (replacements: Map<string, DesignNode>) => ({ ...current, nodes: [...current.nodes.map((node) => replacements.get(node.id) ?? node), ...[...replacements.values()].filter((node) => !current.nodes.some((entry) => entry.id === node.id))] });
  return { document: withNodes(wanted), baseDocument: withNodes(bases) };
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function conflict(field: string): never { throw Object.assign(new Error(`Draft conflicts with a newer Design edit at ${field}; the draft is retained`), { code: "CONFLICT" }); }
function mergeValue(base: unknown, draft: unknown, current: unknown, field: string): unknown {
  if (equal(base, draft)) return current;
  if (equal(base, current) || equal(draft, current)) return draft;
  if (base && draft && current && !Array.isArray(base) && !Array.isArray(draft) && !Array.isArray(current) && typeof base === "object" && typeof draft === "object" && typeof current === "object") {
    const before = base as Record<string, unknown>, wanted = draft as Record<string, unknown>, latest = current as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(wanted), ...Object.keys(latest)])].map((key) => [key, mergeValue(before[key], wanted[key], latest[key], `${field}.${key}`)]).filter(([, value]) => value !== undefined));
  }
  return conflict(field);
}
function mergeItems<T extends { readonly id: string }>(base: readonly T[], draft: readonly T[], current: readonly T[], field: string): readonly T[] {
  const before = new Map(base.map((item) => [item.id, item])), wanted = new Map(draft.map((item) => [item.id, item]));
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const id of new Set([...before.keys(), ...wanted.keys()])) {
    const result = mergeValue(before.get(id), wanted.get(id), merged.get(id), `${field}.${id}`) as T | undefined;
    if (result) merged.set(id, result); else merged.delete(id);
  }
  return [...merged.values()];
}
/** Replay only unsaved edits; independent runtime products and other-view edits remain authoritative. */
export function mergeDesignDraft(draft: DesignDraft, current: DesignDocument): DesignDocument {
  const base = draft.baseDocument, wanted = draft.document;
  if (base.id !== current.id || wanted.id !== current.id) conflict("documentId");
  return { ...current,
    title: mergeValue(base.title, wanted.title, current.title, "title") as string,
    backgroundMode: mergeValue(base.backgroundMode, wanted.backgroundMode, current.backgroundMode, "backgroundMode") as DesignDocument["backgroundMode"],
    viewport: mergeValue(base.viewport, wanted.viewport, current.viewport, "viewport") as DesignDocument["viewport"],
    nodes: mergeItems(base.nodes, wanted.nodes, current.nodes, "nodes"),
    connections: mergeItems(base.connections, wanted.connections, current.connections, "connections"),
  };
}
export function createDesignDraftStore(root: string) {
  const file = (id: string) => { if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(id)) throw new Error("Invalid Design draft document id"); return path.join(root, "drafts", `${id}.json`); };
  const read = async (id: string): Promise<DesignDraft | undefined> => {
    try {
      const target = file(id), info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Design draft must be a regular file");
      const value = JSON.parse(await readFile(target, "utf8")) as DesignDraft;
      if (!value || value.document?.id !== id || value.baseDocument?.id !== id || typeof value.revision !== "string" || typeof value.savedAt !== "string" || !Array.isArray(value.document.nodes) || !Array.isArray(value.baseDocument.nodes)) throw new Error("Invalid stored Design draft");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  return {
    read,
    async list() { const out: DesignDraft[] = []; for (const name of await readdir(path.join(root, "drafts"))) if (name.endsWith(".json")) { const draft = await read(name.slice(0, -5)); if (draft) out.push(draft); } return out; },
    async save(document: DesignDocument, baseDocument: DesignDocument, expected?: string): Promise<DesignDraft> {
      const current = await read(document.id);
      if (current && expected !== current.revision) conflict("draftRevision");
      if (!current && expected !== undefined) conflict("draftRevision");
      const draft: DesignDraft = { document, baseDocument, revision: randomUUID(), savedAt: new Date().toISOString() };
      await writeFileAtomically(file(document.id), JSON.stringify(draft));
      return draft;
    },
    async remove(id: string, revision: string) { const draft = await read(id); if (!draft || draft.revision !== revision) conflict("draftRevision"); await rm(file(id)); },
  };
}
