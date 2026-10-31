// The canvas geometry: pointer gestures, zoom, nudges and the mutations they build.
//
// Carved out of `components/workspace/WorkspaceCanvas.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **46 declarations**, 28 functions, 18 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

import type { CanvasMutation, CanvasNodeLayout, CanvasOperation } from "../../../../shared/contracts/canvas.js";
import type { WebuiCanvasDocument } from "../../../../shared/contracts/canvas.js";

export const DESKTOP_COPY = {
  canvasEmptyTitle: "把文件放到画布上",
  canvasEmptyDescription: "添加图片或其他工作区文件，然后自由排列和调整大小。",
  canvasAddLabel: "工作区相对路径",
  canvasAddPlaceholder: "docs/diagram.png",
  canvasAddSubmit: "添加到画布",
  canvasNodeRemove: "移除",
  canvasNodeHint: "方向键移动，Alt+方向键缩放，Shift 加速。",
  canvasStageLabel: "画布：空白处拖动平移，滚轮缩放，方向键平移。",
  canvasReadOnly: "画布当前为只读：保存操作没有接入。",
  canvasSaving: "正在保存画布改动…",
  canvasBusy: "上一个画布改动还在保存，请稍候。",
  canvasAddRequired: "请先输入工作区相对路径。",
  canvasFailed: "画布改动没有保存。",
} as const;

/** Wheel zoom keeps the clamp and step the panel shipped with. */
export const CANVAS_ZOOM_MIN = 0.4;

export const CANVAS_ZOOM_MAX = 2;

export const CANVAS_ZOOM_STEP = 0.1;

/** Canvas units per arrow key press, and the Shift multiplier. */
export const CANVAS_NUDGE_STEP = 8;

export const CANVAS_NUDGE_STEP_LARGE = 32;

/** The runtime rejects a non-positive width or height, so clamp before sending. */
export const CANVAS_MIN_NODE_SIZE = 24;

const CANVAS_ADD_GAP_X = 264;

const CANVAS_ADD_GAP_Y = 204;

const CANVAS_ADD_COLUMNS = 5;

const CANVAS_ADD_ORIGIN = 32;

const CANVAS_ADD_WIDTH = 240;

const CANVAS_ADD_HEIGHT = 180;

export interface CanvasNodeView {
  readonly id: string;
  readonly label: string;
  readonly layout: CanvasNodeLayout;
}

/**
 * A node drag, a node resize and a canvas pan all start from one pointer and
 * one gesture, so the marker on the pointerdown target picks the winner once.
 * `CanvasMutation` itself is declared in `contracts.ts` and re-exported above.
 */

export type CanvasFileIdentity =
  | { readonly relativePath: string }
  | { readonly assetId: string };

/**
 * Pan-vs-drag rule: the pointerdown target decides, once, and the decision is
 * never revised for the rest of the gesture.
 *
 *  * no marker, or a marker the canvas does not own → pan the stage;
 *  * a node marked `move` → drag that node;
 *  * a node's corner marked `resize` → resize that node;
 *  * a marked `control` (the remove button) → no gesture at all, the click
 *    belongs to the control.
 *
 * Because the choice is frozen at pointerdown, a node drag that wanders off the
 * node stays a node drag and a pan that crosses a node stays a pan: neither
 * needs a movement threshold to disambiguate, and the pointer can be captured
 * on the viewport so a drag that leaves the surface still delivers its moves.
 */
export type CanvasPointerGesture = "pan" | "move" | "resize" | "none";

export function resolveCanvasPointerGesture(
  marker: string | null | undefined,
): CanvasPointerGesture {
  if (marker === "move" || marker === "resize") return marker;
  if (marker === "control") return "none";
  return "pan";
}

function roundCanvasNumber(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function normalizeCanvasZIndex(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Brings a layout inside the bounds the runtime validates before storing it. */
export function normalizeCanvasLayout(layout: CanvasNodeLayout): CanvasNodeLayout {
  return {
    x: roundCanvasNumber(layout.x),
    y: roundCanvasNumber(layout.y),
    width: Math.max(CANVAS_MIN_NODE_SIZE, roundCanvasNumber(layout.width)),
    height: Math.max(CANVAS_MIN_NODE_SIZE, roundCanvasNumber(layout.height)),
    zIndex: normalizeCanvasZIndex(layout.zIndex),
  };
}

export function clampCanvasZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  // Rounded to two decimals so repeated 0.1 steps cannot accumulate float
  // error, while keeping the step and the clamp ends exactly as shipped.
  return Math.round(Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, value)) * 100) / 100;
}

/** `deltaY > 0` scrolls down and zooms out, as the panel has always done. */
export function stepCanvasZoom(current: number, deltaY: number): number {
  const base = Number.isFinite(current) ? current : 1;
  return clampCanvasZoom(base + (deltaY > 0 ? -CANVAS_ZOOM_STEP : CANVAS_ZOOM_STEP));
}

/**
 * The stage transforms as `translate(pan) scale(zoom)` from a `0 0` origin, so
 * the translation is already in screen pixels while a node's layout is in
 * canvas units: a pointer delta has to be divided by the zoom to move a node by
 * the amount the pointer travelled.
 */
export function pointerDeltaToCanvas(
  deltaX: number,
  deltaY: number,
  zoom: number,
): { readonly dx: number; readonly dy: number } {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { dx: roundCanvasNumber(deltaX / scale), dy: roundCanvasNumber(deltaY / scale) };
}

export function canvasPointerMoveLayout(
  start: CanvasNodeLayout,
  deltaClientX: number,
  deltaClientY: number,
  zoom: number,
): CanvasNodeLayout {
  const delta = pointerDeltaToCanvas(deltaClientX, deltaClientY, zoom);
  return normalizeCanvasLayout({ ...start, x: start.x + delta.dx, y: start.y + delta.dy });
}

export function canvasPointerResizeLayout(
  start: CanvasNodeLayout,
  deltaClientX: number,
  deltaClientY: number,
  zoom: number,
): CanvasNodeLayout {
  const delta = pointerDeltaToCanvas(deltaClientX, deltaClientY, zoom);
  return normalizeCanvasLayout({
    ...start,
    width: start.width + delta.dx,
    height: start.height + delta.dy,
  });
}

export interface CanvasDirection {
  readonly dx: number;
  readonly dy: number;
}

export function canvasArrowDirection(key: string): CanvasDirection | undefined {
  switch (key) {
    case "ArrowLeft": return { dx: -1, dy: 0 };
    case "ArrowRight": return { dx: 1, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: -1 };
    case "ArrowDown": return { dx: 0, dy: 1 };
    default: return undefined;
  }
}

export function canvasKeyStep(shiftKey: boolean): number {
  return shiftKey ? CANVAS_NUDGE_STEP_LARGE : CANVAS_NUDGE_STEP;
}

/** Keyboard equivalent of dragging a node. */
export function nudgeCanvasLayout(
  layout: CanvasNodeLayout,
  direction: CanvasDirection,
  step: number,
): CanvasNodeLayout {
  return normalizeCanvasLayout({
    ...layout,
    x: layout.x + direction.dx * step,
    y: layout.y + direction.dy * step,
  });
}

/** Keyboard equivalent of dragging the resize corner. */
export function resizeCanvasLayoutBy(
  layout: CanvasNodeLayout,
  direction: CanvasDirection,
  step: number,
): CanvasNodeLayout {
  return normalizeCanvasLayout({
    ...layout,
    width: layout.width + direction.dx * step,
    height: layout.height + direction.dy * step,
  });
}

export function canvasLayoutsEqual(
  left: CanvasNodeLayout | undefined,
  right: CanvasNodeLayout | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.zIndex === right.zIndex;
}

export function buildCanvasUpdateLayoutMutation(
  nodeId: string,
  layout: CanvasNodeLayout,
): CanvasMutation {
  return { kind: "update_layout", nodeId, layout: normalizeCanvasLayout(layout) };
}

/** Emits exactly one file identity key, never both and never neither. */
export function buildCanvasAddFileMutation(
  nodeId: string,
  layout: CanvasNodeLayout,
  target: CanvasFileIdentity,
): CanvasMutation {
  const base = { kind: "add_file" as const, nodeId, layout: normalizeCanvasLayout(layout) };
  return "assetId" in target
    ? { ...base, assetId: target.assetId }
    : { ...base, relativePath: target.relativePath };
}

export function buildCanvasRemoveNodeMutation(nodeId: string): CanvasMutation {
  return { kind: "remove_node", nodeId };
}

/**
 * The runtime keys applied operations by `(sessionId, operationId)` and
 * rejects a reuse whose payload differs, so every operation needs a fresh id
 * rather than a stable one derived from the node.
 */
export function createCanvasOperationId(): string {
  return randomCanvasId("canvas-op");
}

export function createCanvasNodeId(): string {
  return randomCanvasId("canvas-node");
}

// `view` must not read the ambient `globalThis` surface; WebCrypto is the same
// object under either name, and the fallback keeps a context that ships without
// it working. Same shape as `webuiClientRequestId` in
// `client/features/sessions/projection/action-requests.public.ts`.
function randomCanvasId(prefix: string): string {
  const webCrypto = typeof crypto !== "undefined" ? crypto : undefined;
  const unique = typeof webCrypto?.randomUUID === "function"
    ? webCrypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${unique}`;
}

/**
 * Fails here for exactly the two reasons the runtime rejects an operation, so
 * the panel never sends a payload that is guaranteed to be refused.
 */
export function buildCanvasOperation(
  operationId: string,
  mutations: readonly CanvasMutation[],
): CanvasOperation {
  const id = operationId.trim();
  if (!id) throw new Error("canvas operationId is required");
  if (mutations.length === 0) throw new Error("canvas operation needs at least one mutation");
  return { schemaVersion: 1, operationId: id, mutations: [...mutations] };
}

export function nextCanvasZIndex(nodes: readonly CanvasNodeView[]): number {
  return nodes.reduce((highest, node) => Math.max(highest, node.layout.zIndex), 0) + 1;
}

/** Cascades a new node so consecutive adds do not stack on one spot. */
export function nextCanvasNodeLayout(nodes: readonly CanvasNodeView[]): CanvasNodeLayout {
  const index = Math.max(0, nodes.length);
  const column = index % CANVAS_ADD_COLUMNS;
  const row = Math.floor(index / CANVAS_ADD_COLUMNS);
  return normalizeCanvasLayout({
    x: CANVAS_ADD_ORIGIN + column * CANVAS_ADD_GAP_X,
    y: CANVAS_ADD_ORIGIN + row * CANVAS_ADD_GAP_Y,
    width: CANVAS_ADD_WIDTH,
    height: CANVAS_ADD_HEIGHT,
    zIndex: nextCanvasZIndex(nodes),
  });
}

export function describeCanvasError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  return DESKTOP_COPY.canvasFailed;
}

function readCanvasRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCanvasLayout(value: unknown): CanvasNodeLayout | undefined {
  const record = readCanvasRecord(value);
  if (!record) return undefined;
  const { x, y, width, height, zIndex } = record;
  if (
    typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)
    || typeof width !== "number" || !Number.isFinite(width)
    || typeof height !== "number" || !Number.isFinite(height)
  ) return undefined;
  return normalizeCanvasLayout({
    x,
    y,
    width,
    height,
    zIndex: typeof zIndex === "number" ? zIndex : 0,
  });
}

/**
 * `WebuiCanvasDocument.nodes` is `Record<string, unknown>[]` at the webui
 * boundary, so a node missing its id or its layout is dropped rather than
 * allowed to break the render.
 */
export function parseCanvasNodes(
  canvasDocument: WebuiCanvasDocument | undefined,
): readonly CanvasNodeView[] {
  const nodes = Array.isArray(canvasDocument?.nodes) ? canvasDocument?.nodes : [];
  const parsed: CanvasNodeView[] = [];
  for (const raw of nodes ?? []) {
    const record = readCanvasRecord(raw);
    const id = typeof record?.id === "string" ? record.id : "";
    const layout = readCanvasLayout(record?.layout);
    if (!id || !layout) continue;
    const file = readCanvasRecord(record?.file);
    const fileName = typeof file?.fileName === "string" ? file.fileName : "";
    const relativePath = typeof file?.relativePath === "string" ? file.relativePath : "";
    parsed.push({ id, label: fileName || relativePath || id, layout });
  }
  return parsed;
}

export interface CanvasLayoutPreview {
  readonly nodeId: string;
  readonly layout: CanvasNodeLayout;
}

/**
 * The in-flight drag preview. It is deliberately separate from the canvas
 * document: the document stays the last server-confirmed truth, and a refused
 * operation drops the preview rather than leaving an optimistic value on screen.
 */
export function applyCanvasLayoutPreview(
  nodes: readonly CanvasNodeView[],
  preview: CanvasLayoutPreview | undefined,
): readonly CanvasNodeView[] {
  if (!preview) return nodes;
  return nodes.map((node) =>
    node.id === preview.nodeId ? { ...node, layout: preview.layout } : node,
  );
}
