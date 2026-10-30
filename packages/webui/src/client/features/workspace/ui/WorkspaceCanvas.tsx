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
import type { WebuiCanvasDocument } from "../../../../shared/contracts/canvas.js";

/** Backing box for the stage; nodes are placed inside it in canvas units. */
const CANVAS_WORLD_SIZE = 4000;
const CANVAS_PAN_KEY_SCALE = 4;

// Re-exported so the canvas keeps a single import site for everything a
// caller or a test needs, while the definitions themselves live in
// `shared/contracts/canvas.ts` — the wire contract they mirror.
export type { CanvasMutation, CanvasNodeLayout, CanvasOperation } from "../../../../shared/contracts/canvas.js";
import type { CanvasMutation, CanvasNodeLayout, CanvasOperation } from "../../../../shared/contracts/canvas.js";
import {
  useWebuiWorkspaceCanvas,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import { DESKTOP_COPY, resolveCanvasPointerGesture, stepCanvasZoom, canvasPointerMoveLayout, canvasPointerResizeLayout, canvasArrowDirection, canvasKeyStep, nudgeCanvasLayout, resizeCanvasLayoutBy, canvasLayoutsEqual, buildCanvasUpdateLayoutMutation, buildCanvasAddFileMutation, buildCanvasRemoveNodeMutation, createCanvasOperationId, createCanvasNodeId, buildCanvasOperation, nextCanvasNodeLayout, describeCanvasError, parseCanvasNodes, applyCanvasLayoutPreview } from "../projection/canvas-projection.js";
import type { CanvasNodeView, CanvasPointerGesture, CanvasLayoutPreview } from "../projection/canvas-projection.js";
import { FeedbackError } from "../../../ui/feedback.js";

export interface CanvasPan {
  readonly x: number;
  readonly y: number;
}

export const CANVAS_GESTURE_ATTRIBUTE = "data-canvas-gesture";
export const CANVAS_NODE_ID_ATTRIBUTE = "data-canvas-node-id";

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

export function WorkspaceCanvas({ sessionId }: {
  /** The session whose canvas document is shown; absent means no canvas. */
  readonly sessionId?: string;
}): ReactElement {
  // The document, its freshness and the operation outcomes belong to the canvas
  // owner; what stays here is geometry and gesture (pan, zoom, preview).
  const queries = useWebuiWorkspaceCanvas();
  const canvasState = useWebuiWorkspaceQueriesState().canvas;
  const canvas = canvasState.document;
  const [localError, setLocalError] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<CanvasPan>({ x: 0, y: 0 });
  const [preview, setPreview] = useState<CanvasLayoutPreview>();
  // The operation's own outcome is the owner's; this is view-side validation.
  const error = localError ?? canvasState.error;
  const busy = canvasState.busy;
    const [notice, setNotice] = useState<string>();
  const [draftPath, setDraftPath] = useState("");
  const gestureRef = useRef<CanvasGestureState>();
  const viewportRef = useRef<HTMLDivElement>(null);
  // Identifies the newest read or apply so a late reply from a session the user
  // has already left cannot overwrite the current document.
  const applySeqRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    queries?.readCanvas(sessionId);
  }, [queries, sessionId]);

  // A different session is a different world: start it at the origin.
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setPreview(undefined);
  }, [sessionId]);

  const confirmedNodes = parseCanvasNodes(canvas);
  const nodes = applyCanvasLayoutPreview(confirmedNodes, preview);
  const readOnly = !queries?.canApplyCanvas || !sessionId;

  const applyMutations = (
    mutations: readonly CanvasMutation[],
    onSuccess?: () => void,
  ): void => {
    const targetSessionId = sessionId;
    if (!queries?.canApplyCanvas || !targetSessionId) {
      setLocalError(DESKTOP_COPY.canvasReadOnly);
      return;
    }
    let operation: CanvasOperation;
    try {
      operation = buildCanvasOperation(createCanvasOperationId(), mutations);
    } catch (cause: unknown) {
      setLocalError(describeCanvasError(cause));
      return;
    }
    setLocalError(undefined);
    setNotice(undefined);
    void queries.applyCanvas(targetSessionId, operation).then((landed: boolean) => {
      // The owner dropped the answer if the session moved on; only a landed
      // operation clears the optimistic preview.
      if (!landed) { setPreview(undefined); return; }
      setPreview(undefined);
      onSuccess?.();
    });
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
    if (readOnly) { setLocalError(DESKTOP_COPY.canvasReadOnly); return; }
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
    if (!relativePath) { setLocalError(DESKTOP_COPY.canvasAddRequired); return; }
    if (readOnly) { setLocalError(DESKTOP_COPY.canvasReadOnly); return; }
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
      {error ? <FeedbackError message={error} /> : null}
    </div>
  </div>;
}
