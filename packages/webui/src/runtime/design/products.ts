import { randomUUID } from "node:crypto";
import type { DesignDocument, DesignKind, DesignMedia } from "../../shared/contracts/design.js";
import { normalizeCanvas } from "./store.mjs";

/** Tool outputs are new reusable graph products; they never replace an earlier tool result. */
export function appendDesignProducts(document: DesignDocument, input: { readonly sourceNodeId?: string; readonly sourceUrl?: string; readonly title: string; readonly text?: string; readonly media?: readonly DesignMedia[] }): DesignDocument {
  const source = input.sourceNodeId ? document.nodes.find((node) => node.id === input.sourceNodeId) : document.nodes.find((node) => node.metadata.output.media.some((media) => media.url === input.sourceUrl));
  if (input.sourceNodeId && !source) throw Object.assign(new Error("The source Design node no longer exists"), { code: "NOT_FOUND" });
  const products = input.media?.length ? input.media.map((media) => ({ media: [media], kind: media.kind, text: "" })) : [{ media: [], kind: "text" as DesignKind, text: input.text ?? "" }];
  if (document.nodes.length + products.length > 300) throw Object.assign(new Error("Design document exceeds its node limit"), { code: "INVALID_ARGUMENTS" });
  const originX = source ? source.position.x + source.width + 80 : document.nodes.reduce((right, node) => Math.max(right, node.position.x + node.width + 80), 40);
  const originY = source?.position.y ?? 60;
  const occupied = document.nodes.map((node) => ({ ...node.position, width: node.width, height: node.height }));
  const nodes = products.map((product, index) => {
    const height = product.kind === "text" ? 260 : 320;
    let y = originY;
    while (occupied.some((box) => originX < box.x + box.width + 40 && originX + 340 > box.x && y < box.y + box.height + 40 && y + height + 40 > box.y)) {
      y = Math.max(...occupied.filter((box) => originX < box.x + box.width + 40 && originX + 340 > box.x && y < box.y + box.height + 40 && y + height + 40 > box.y).map((box) => box.y + box.height + 80));
    }
    occupied.push({ x: originX, y, width: 300, height });
    return { id: `n_${randomUUID().replaceAll("-", "")}`, type: "result", title: products.length > 1 ? `${input.title} ${index + 1}` : input.title, position: { x: originX, y }, width: 300, height, metadata: { kind: product.kind, sourceNodeId: source?.id ?? "", output: { status: "success", text: product.text, media: product.media, error: "", updatedAt: new Date().toISOString() } } };
  });
  const connections = source ? nodes.map((node) => ({ id: `c_${randomUUID().replaceAll("-", "")}`, fromNodeId: source.id, toNodeId: node.id, kind: source.metadata.kind })) : [];
  return normalizeCanvas({ ...document, nodes: [...document.nodes, ...nodes], connections: [...document.connections, ...connections] }, document);
}
