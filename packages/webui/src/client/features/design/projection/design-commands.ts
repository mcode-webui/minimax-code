import type {
  DesignDocument,
  DesignNode,
} from "../../../../shared/contracts/design.js";

export function designSelectionBounds(nodes: readonly DesignNode[]) {
  if (!nodes.length) return undefined;
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + node.width));
  const bottom = Math.max(
    ...nodes.map((node) => node.position.y + node.height),
  );
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function designFitView(
  nodes: readonly DesignNode[],
  size: { readonly width: number; readonly height: number },
  zoom?: number,
): DesignDocument["viewport"] {
  const box = designSelectionBounds(nodes);
  if (!box) return { x: 80, y: 60, k: 1 };
  const k =
    zoom ??
    Math.max(
      0.05,
      Math.min(
        5,
        (size.width - 96) / Math.max(1, box.width),
        (size.height - 96) / Math.max(1, box.height),
      ),
    );
  return {
    x: size.width / 2 - ((box.left + box.right) / 2) * k,
    y: size.height / 2 - ((box.top + box.bottom) / 2) * k,
    k,
  };
}

export function designRemoveSelection(
  document: DesignDocument,
  selected: readonly string[],
): DesignDocument {
  return {
    ...document,
    nodes: document.nodes.filter((node) => !selected.includes(node.id)),
    connections: document.connections.filter(
      (line) =>
        !selected.includes(line.fromNodeId) &&
        !selected.includes(line.toNodeId),
    ),
  };
}

export function designGroupSelection(
  document: DesignDocument,
  selected: readonly string[],
  id: string,
): DesignDocument {
  const members = document.nodes.filter((node) => selected.includes(node.id));
  const box = designSelectionBounds(members);
  if (!box || members.length < 2) throw new Error("至少选两个节点才能编组");
  const group: DesignNode = {
    id,
    type: "group",
    title: "分组",
    position: { x: box.left - 28, y: box.top - 28 },
    width: box.width + 56,
    height: box.height + 56,
    metadata: {
      kind: "text",
      prompt: "",
      mode: null,
      model: null,
      ratio: null,
      resolution: null,
      duration: null,
      count: 1,
      voice: null,
      emotion: null,
      sessionId: null,
      segments: [],
      mentions: [],
      output: { status: "idle", text: "", media: [], error: "" },
    },
  };
  return { ...document, nodes: [group, ...document.nodes] };
}

export function designNextTitle(
  documents: readonly { readonly title: string }[],
): string {
  const used = new Set(documents.map((document) => document.title));
  if (!used.has("未命名画布")) return "未命名画布";
  let index = 2;
  while (used.has(`未命名画布 ${index}`)) index += 1;
  return `未命名画布 ${index}`;
}
