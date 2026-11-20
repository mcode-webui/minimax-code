import type { DesignKind } from "../../../../shared/contracts/design.js";

export interface DesignPortHit {
  readonly nodeId: string;
  readonly input: boolean;
  readonly kind: DesignKind;
  readonly role?: string;
  readonly x: number;
  readonly y: number;
}
export function designHitPort(
  root: HTMLElement,
  x: number,
  y: number,
  input: boolean,
  exclude: string,
): DesignPortHit | undefined {
  const candidates = [
    ...root.querySelectorAll<HTMLElement>(
      `[data-design-port='${input ? "input" : "output"}']`,
    ),
  ];
  let found: DesignPortHit | undefined,
    distance = 28;
  for (const port of candidates) {
    const nodeId =
      port.closest<HTMLElement>("[data-design-node]")?.dataset.designNode;
    if (!nodeId || nodeId === exclude || port.dataset.portState === "blocked")
      continue;
    const rect = port.getBoundingClientRect(),
      px = rect.left + rect.width / 2,
      py = rect.top + rect.height / 2,
      next = Math.hypot(px - x, py - y);
    if (next > distance) continue;
    distance = next;
    found = {
      nodeId,
      input,
      kind: port.dataset.portKind as DesignKind,
      role: port.dataset.portRole || undefined,
      x: px,
      y: py,
    };
  }
  return found;
}
export function designHitNode(
  root: HTMLElement,
  x: number,
  y: number,
): string | undefined {
  return root.ownerDocument
    .elementsFromPoint(x, y)
    .find(
      (element) =>
        root.contains(element) && element.closest("[data-design-node]"),
    )
    ?.closest<HTMLElement>("[data-design-node]")?.dataset.designNode;
}
export function designSvgPoint(
  root: SVGSVGElement,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } | undefined {
  const matrix = root.getScreenCTM();
  if (!matrix) return;
  const point = root.createSVGPoint();
  point.x = x;
  point.y = y;
  const world = point.matrixTransform(matrix.inverse());
  return { x: world.x, y: world.y };
}
