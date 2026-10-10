// Owns the workspace canvas feature: the canvas document state, the zoom and
// pan state, and the whole `webui-canvas-content` render. A different implementer
// works in this file; the container in `WorkspacePanels.tsx` only mounts it.
//
// The canvas is a real surface, not a readout: nodes are absolutely positioned
// on a pannable stage, and every mutation (move, resize, add, remove) is sent
// through `applyCanvas` and then adopted from the returned document. The
// server document is the only truth — local state is never treated as saved.
//
// Port contract, determined from the runtime rather than guessed:
//   `packages/local-runtime-v2/src/service/canvas/contracts.ts` declares
//   `CanvasOperationV1 { schemaVersion: 1, operationId, mutations }` and
//   `CanvasMutationV1` = add_file | update_layout | remove_node | the three
//   annotation mutations. The webui boundary keeps `operation` as an opaque
//   `Record<string, unknown>` (`src/server/operation/workspace.ts` only checks
//   that it is a non-null, non-array object) and forwards it verbatim to that
//   service, so the payload below is the shape the runtime actually validates.
//   Its rules this file honours: `operationId` must be non-blank and unique per
//   session (a reused id is rejected as OPERATION_ID_REUSED), `mutations` must
//   be non-empty, `add_file` must carry exactly one of `relativePath` /
//   `assetId`, and a layout must be finite with positive width/height and a
//   safe-integer zIndex.

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";

const DESKTOP_COPY = {
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

/** Backing box for the stage; nodes are placed inside it in canvas units. */
const CANVAS_WORLD_SIZE = 4000;
const CANVAS_ADD_GAP_X = 264;
const CANVAS_ADD_GAP_Y = 204;
const CANVAS_ADD_COLUMNS = 5;
const CANVAS_ADD_ORIGIN = 32;
const CANVAS_ADD_WIDTH = 240;
const CANVAS_ADD_HEIGHT = 180;
const CANVAS_PAN_KEY_SCALE = 4;

// Re-exported so the canvas keeps a single import site for everything a
// caller or a test needs, while the definitions themselves live in
// `shared/contracts/canvas.ts` — the wire contract they mirror.
export type { CanvasMutation, CanvasNodeLayout, CanvasOperation } from "../../shared/contracts/canvas.js";
import type { CanvasMutation, CanvasNodeLayout, CanvasOperation } from "../../shared/contracts/canvas.js";

export interface CanvasNodeView {
  readonly id: string;
  readonly label: string;
  readonly layout: CanvasNodeLayout;
}

export interface CanvasPan {
  readonly x: number;
  readonly y: number;
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

export const CANVAS_GESTURE_ATTRIBUTE = "data-canvas-gesture";
export const CANVAS_NODE_ID_ATTRIBUTE = "data-canvas-node-id";

export function resolveCanvasPointerGesture(
  marker: string | null | undefined,
): CanvasPointerGesture {
  if (marker === "move" || marker === "resize") return marker;
  if (marker === "control") return "none";
  return "pan";
}

/** Reads the gesture marker an element (or an ancestor) carries. */
function readCanvasGestureContext(target: EventTarget | null): {
  readonly kind: CanvasPointerGesture;
  readonly nodeId?: string;
} {
  const element = target instanceof Element ? target : null;
  const marker = element?.closest(
    `[${CANVAS_GESTURE_ATTRIBUTE}="move"], [${CANVAS_GESTURE_ATTRIBUTE}="resize"]`,
  ) ?? null;
  const kind = resolveCanvasPointerGesture(marker?.getAttribute(CANVAS_GESTURE_ATTRIBUTE) ?? null);
  const nodeId = marker?.getAttribute(CANVAS_NODE_ID_ATTRIBUTE) ?? undefined;
  // A move/resize marker without a node identity is a wiring bug, not a pan.
  if ((kind === "move" || kind === "resize") && !nodeId) return { kind: "none" };
  return nodeId ? { kind, nodeId } : { kind };
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

function randomCanvasId(prefix: string): string {
  const webCrypto = globalThis.crypto;
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
  document: WebuiCanvasDocument | undefined,
): readonly CanvasNodeView[] {
  const nodes = Array.isArray(document?.nodes) ? document?.nodes : [];
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

interface CanvasGestureState {
  readonly kind: CanvasPointerGesture;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startZoom: number;
  readonly startPan: CanvasPan;
  readonly startLayout?: CanvasNodeLayout;
  readonly nodeId?: string;
}

export function WorkspaceCanvas({ sessionId, readCanvas, applyCanvas }: {
  /** The session whose canvas document is shown; absent means no canvas. */
  readonly sessionId?: string;
  /** Port call that reads the canvas document for a session. */
  readonly readCanvas?: (request: { sessionId: string }) => Promise<WebuiCanvasDocument>;
  /**
   * Port call that applies one operation and returns the document the runtime
   * actually stored. Absent means the canvas is read-only, and the panel says
   * so instead of pretending a change was saved.
   */
  readonly applyCanvas?: (request: {
    readonly sessionId: string;
    readonly operation: CanvasOperation;
  }) => Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
}): ReactElement {
  const [canvas, setCanvas] = useState<WebuiCanvasDocument>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<CanvasPan>({ x: 0, y: 0 });
  const [preview, setPreview] = useState<CanvasLayoutPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [draftPath, setDraftPath] = useState("");
  const gestureRef = useRef<CanvasGestureState>();
  const viewportRef = useRef<HTMLDivElement>(null);
  // Identifies the newest read or apply so a late reply from a session the user
  // has already left cannot overwrite the current document.
  const applySeqRef = useRef(0);

  useEffect(() => {
    if (!sessionId || !readCanvas) { setCanvas(undefined); return undefined; }
    let cancelled = false;
    void readCanvas({ sessionId })
      .then((next) => { if (!cancelled) { setCanvas(next); setError(undefined); } })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCanvas(undefined);
        setError(describeCanvasError(cause));
      });
    return () => { cancelled = true; };
  }, [sessionId, readCanvas]);

  // A different session is a different world: start it at the origin.
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setPreview(undefined);
  }, [sessionId]);

  const confirmedNodes = parseCanvasNodes(canvas);
  const nodes = applyCanvasLayoutPreview(confirmedNodes, preview);
  const readOnly = !applyCanvas || !sessionId;

  const applyMutations = (
    mutations: readonly CanvasMutation[],
    onSuccess?: () => void,
  ): void => {
    const port = applyCanvas;
    const targetSessionId = sessionId;
    if (!port || !targetSessionId) { setError(DESKTOP_COPY.canvasReadOnly); return; }
    let operation: CanvasOperation;
    try {
      operation = buildCanvasOperation(createCanvasOperationId(), mutations);
    } catch (cause: unknown) {
      setError(describeCanvasError(cause));
      return;
    }
    const seq = ++applySeqRef.current;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    void port({ sessionId: targetSessionId, operation })
      .then((result) => {
        if (seq !== applySeqRef.current) return;
        setCanvas(result.document);
        setPreview(undefined);
        onSuccess?.();
      })
      .catch((cause: unknown) => {
        if (seq !== applySeqRef.current) return;
        // The stored document is still the last one this view read, so drop the
        // optimistic preview and report the refusal instead of keeping it.
        setPreview(undefined);
        setError(describeCanvasError(cause));
      })
      .finally(() => { if (seq === applySeqRef.current) setBusy(false); });
  };

  const releaseCapture = (pointerId: number): void => {
    try { viewportRef.current?.releasePointerCapture(pointerId); } catch { /* already released */ }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const context = readCanvasGestureContext(event.target);
    if (context.kind === "none") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (busy) { setNotice(DESKTOP_COPY.canvasBusy); return; }
    const startLayout = context.nodeId
      ? confirmedNodes.find((node) => node.id === context.nodeId)?.layout
      : undefined;
    if ((context.kind === "move" || context.kind === "resize") && !startLayout) return;
    gestureRef.current = {
      kind: context.kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startZoom: zoom,
      startPan: pan,
      ...(startLayout ? { startLayout } : {}),
      ...(context.nodeId ? { nodeId: context.nodeId } : {}),
    };
    // Capture on the viewport for every gesture: the decision is already in the
    // ref, so a pointer that leaves the surface still reports its moves.
    try { viewportRef.current?.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaClientX = event.clientX - gesture.startClientX;
    const deltaClientY = event.clientY - gesture.startClientY;
    if (gesture.kind === "pan") {
      setPan({ x: gesture.startPan.x + deltaClientX, y: gesture.startPan.y + deltaClientY });
      return;
    }
    if (!gesture.startLayout || !gesture.nodeId) return;
    setPreview({
      nodeId: gesture.nodeId,
      layout: gesture.kind === "resize"
        ? canvasPointerResizeLayout(gesture.startLayout, deltaClientX, deltaClientY, gesture.startZoom)
        : canvasPointerMoveLayout(gesture.startLayout, deltaClientX, deltaClientY, gesture.startZoom),
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // Clear before releasing, so the implicit lostpointercapture is a no-op.
    gestureRef.current = undefined;
    releaseCapture(event.pointerId);
    if (!gesture.startLayout || !gesture.nodeId) return;
    const deltaClientX = event.clientX - gesture.startClientX;
    const deltaClientY = event.clientY - gesture.startClientY;
    const layout = gesture.kind === "resize"
      ? canvasPointerResizeLayout(gesture.startLayout, deltaClientX, deltaClientY, gesture.startZoom)
      : canvasPointerMoveLayout(gesture.startLayout, deltaClientX, deltaClientY, gesture.startZoom);
    if (canvasLayoutsEqual(layout, gesture.startLayout)) { setPreview(undefined); return; }
    applyMutations([buildCanvasUpdateLayoutMutation(gesture.nodeId, layout)]);
  };

  const handlePointerCancel = (): void => {
    if (!gestureRef.current) return;
    gestureRef.current = undefined;
    setPreview(undefined);
  };

  const handlePanKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const direction = canvasArrowDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    const step = canvasKeyStep(event.shiftKey) * CANVAS_PAN_KEY_SCALE;
    setPan((current) => ({
      x: current.x + direction.dx * step,
      y: current.y + direction.dy * step,
    }));
  };

  const handleNodeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    node: CanvasNodeView,
  ): void => {
    const direction = canvasArrowDirection(event.key);
    if (!direction) return;
    if (readOnly) { setError(DESKTOP_COPY.canvasReadOnly); return; }
    event.preventDefault();
    const step = canvasKeyStep(event.shiftKey);
    // Drag and resize both have a real keyboard equivalent, so the pointer
    // interaction is never the only way to reach a layout.
    const layout = event.altKey
      ? resizeCanvasLayoutBy(node.layout, direction, step)
      : nudgeCanvasLayout(node.layout, direction, step);
    applyMutations([buildCanvasUpdateLayoutMutation(node.id, layout)]);
  };

  const handleAddSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const relativePath = draftPath.trim();
    if (!relativePath) { setError(DESKTOP_COPY.canvasAddRequired); return; }
    if (readOnly) { setError(DESKTOP_COPY.canvasReadOnly); return; }
    applyMutations(
      [buildCanvasAddFileMutation(createCanvasNodeId(), nextCanvasNodeLayout(confirmedNodes), { relativePath })],
      () => setDraftPath(""),
    );
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setZoom((value) => stepCanvasZoom(value, event.deltaY));
  };

  return <div className="webui-canvas-content" onWheel={handleWheel}>
    {nodes.length === 0 ? <><strong>{DESKTOP_COPY.canvasEmptyTitle}</strong><p>{DESKTOP_COPY.canvasEmptyDescription}</p></> : <div
      ref={viewportRef}
      role="group"
      aria-label={DESKTOP_COPY.canvasStageLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onKeyDown={handlePanKeyDown}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        textAlign: "left",
        touchAction: "none",
        cursor: "grab",
      }}
    >
      <div
        className="webui-canvas-stage"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          display: "block",
          width: CANVAS_WORLD_SIZE,
          height: CANVAS_WORLD_SIZE,
          transformOrigin: "0 0",
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {nodes.map((node) => <div
          key={node.id}
          className="webui-canvas-node"
          role="group"
          tabIndex={0}
          aria-label={`${node.label}。${DESKTOP_COPY.canvasNodeHint}`}
          aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
          // Literal attributes, matching CANVAS_GESTURE_ATTRIBUTE /
          // CANVAS_NODE_ID_ATTRIBUTE, which readCanvasGestureContext queries.
          data-canvas-gesture="move"
          data-canvas-node-id={node.id}
          onKeyDown={(event) => handleNodeKeyDown(event, node)}
          style={{
            position: "absolute",
            left: node.layout.x,
            top: node.layout.y,
            width: node.layout.width,
            height: node.layout.height,
            zIndex: node.layout.zIndex,
            boxSizing: "border-box",
            overflow: "hidden",
            touchAction: "none",
            cursor: "grab",
            userSelect: "none",
          }}
        >
          <span style={{ display: "block", padding: "var(--spacing_8)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
          <button
            type="button"
            data-canvas-gesture="control"
            disabled={readOnly || busy}
            onClick={() => applyMutations([buildCanvasRemoveNodeMutation(node.id)])}
            style={{ position: "absolute", top: "var(--spacing_8)", right: "var(--spacing_8)", border: "1px solid var(--border_default)", borderRadius: "var(--radius_8)", background: "var(--bg_grouped_secondary)", color: "inherit", padding: "2px var(--spacing_8)", fontSize: "var(--size_12)", cursor: "pointer" }}
          >{DESKTOP_COPY.canvasNodeRemove}</button>
          <div
            aria-hidden="true"
            data-canvas-gesture="resize"
            style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", touchAction: "none", background: "var(--border_default)" }}
          />
        </div>)}
      </div>
    </div>}
    <span className="webui-canvas-zoom">{Math.round(zoom * 100)}%</span>
    <form
      onSubmit={handleAddSubmit}
      style={{ position: "absolute", left: "var(--spacing_16)", top: "var(--spacing_16)", display: "flex", gap: "var(--spacing_8)", alignItems: "center" }}
    >
      <input
        aria-label={DESKTOP_COPY.canvasAddLabel}
        placeholder={DESKTOP_COPY.canvasAddPlaceholder}
        value={draftPath}
        disabled={readOnly}
        onChange={(event) => setDraftPath(event.target.value)}
        style={{ border: "1px solid var(--border_default)", borderRadius: "var(--radius_8)", background: "var(--bg_grouped_secondary)", color: "var(--text_default_primary)", padding: "var(--spacing_8)", fontSize: "var(--size_12)", textAlign: "left" }}
      />
      <button
        type="submit"
        disabled={readOnly || busy}
        style={{ border: "1px solid var(--border_default)", borderRadius: "var(--radius_8)", background: "transparent", color: "var(--text_default_primary)", padding: "var(--spacing_8) var(--spacing_12)", fontSize: "var(--size_12)", cursor: "pointer" }}
      >{DESKTOP_COPY.canvasAddSubmit}</button>
    </form>
    {/* Status text is stacked in one column so the read-only note, the
        in-flight state, a notice and a failure can never overlap. */}
    <div style={{ position: "absolute", left: "var(--spacing_16)", bottom: "var(--spacing_8)", display: "flex", flexDirection: "column", gap: "var(--spacing_4)", alignItems: "flex-start", textAlign: "left" }}>
      {readOnly ? <p style={{ margin: 0, color: "var(--text_default_tertiary)", fontSize: "var(--size_12)" }}>{DESKTOP_COPY.canvasReadOnly}</p> : null}
      {busy ? <p role="status" style={{ margin: 0, color: "var(--text_default_tertiary)", fontSize: "var(--size_12)" }}>{DESKTOP_COPY.canvasSaving}</p> : null}
      {notice ? <p role="status" style={{ margin: 0, color: "var(--text_default_tertiary)", fontSize: "var(--size_12)" }}>{notice}</p> : null}
      {error ? <p role="alert" style={{ margin: 0, color: "var(--text_default_primary)", fontSize: "var(--size_12)" }}>{error}</p> : null}
    </div>
  </div>;
}
