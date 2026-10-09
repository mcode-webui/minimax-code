// Unit tests for the workspace canvas (`WorkspaceCanvas.tsx`).
//
// Rendered through `renderToStaticMarkup` — the project's SSR test convention
// (see `workspace-panel-state.test.ts`). That runs no effects and dispatches no
// events, so it can only assert what the panel emits before the first read
// lands: the empty state, the zoom readout and the read-only notice.
//
// Everything stateful is therefore exported as a pure function from the
// component and driven directly here — the zoom clamp, the pointer-to-canvas
// coordinate mapping, the pan-vs-drag rule, the preview that a drag renders, and
// the operation payload the panel hands to `applyCanvas`.
//
// The clauses these pin shut:
//   * wheel zoom keeps the shipped 0.4–2.0 clamp and 0.1 step, at both ends,
//     and cannot accumulate float error;
//   * a pointer delta becomes a canvas delta by dividing by the zoom, because
//     the stage is `translate(pan) scale(zoom)` from a `0 0` origin;
//   * a pan is not a drag: the pointerdown marker alone picks the gesture, and
//     an unmarked pointerdown pans while a marked control does neither;
//   * the operation sent to `applyCanvas` is exactly the runtime's
//     `CanvasOperationV1`, carries one and only one file identity on
//     `add_file`, and survives the JSON wire;
//   * a refused operation leaves the confirmed document in place rather than an
//     optimistic value, and a malformed node cannot break the render.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CANVAS_GESTURE_ATTRIBUTE,
  CANVAS_MIN_NODE_SIZE,
  CANVAS_NODE_ID_ATTRIBUTE,
  CANVAS_NUDGE_STEP,
  CANVAS_NUDGE_STEP_LARGE,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_STEP,
  WorkspaceCanvas,
  applyCanvasLayoutPreview,
  buildCanvasAddFileMutation,
  buildCanvasOperation,
  buildCanvasRemoveNodeMutation,
  buildCanvasUpdateLayoutMutation,
  canvasArrowDirection,
  canvasKeyStep,
  canvasLayoutsEqual,
  canvasPointerMoveLayout,
  canvasPointerResizeLayout,
  clampCanvasZoom,
  createCanvasNodeId,
  createCanvasOperationId,
  describeCanvasError,
  nextCanvasNodeLayout,
  nextCanvasZIndex,
  normalizeCanvasLayout,
  nudgeCanvasLayout,
  parseCanvasNodes,
  pointerDeltaToCanvas,
  resizeCanvasLayoutBy,
  resolveCanvasPointerGesture,
  stepCanvasZoom,
  type CanvasNodeLayout,
  type CanvasNodeView,
} from "../../src/client/components/WorkspaceCanvas.js";
import type { WebuiCanvasDocument } from "../../src/shared/contracts/canvas.js";

const LAYOUT: CanvasNodeLayout = { x: 100, y: 200, width: 240, height: 180, zIndex: 3 };

function node(id: string, layout: Partial<CanvasNodeLayout> = {}): CanvasNodeView {
  return { id, label: `${id}.png`, layout: normalizeCanvasLayout({ ...LAYOUT, ...layout }) };
}

/** Casts on purpose: several cases below feed the panel a malformed node. */
function document(nodes: readonly unknown[]): WebuiCanvasDocument {
  return {
    schemaVersion: 1,
    canvasId: "canvas_1",
    sessionId: "session-1",
    changeSeq: 1,
    nodes: nodes as readonly Record<string, unknown>[],
    updatedAtMs: 0,
  };
}

describe("canvas zoom", () => {
  it("clamps at both ends and passes interior values through", () => {
    expect(clampCanvasZoom(0.1)).toBe(CANVAS_ZOOM_MIN);
    expect(clampCanvasZoom(-4)).toBe(CANVAS_ZOOM_MIN);
    expect(clampCanvasZoom(5)).toBe(CANVAS_ZOOM_MAX);
    expect(clampCanvasZoom(1.35)).toBe(1.35);
  });

  it("keeps the clamp boundaries themselves inclusive", () => {
    expect(clampCanvasZoom(CANVAS_ZOOM_MIN)).toBe(CANVAS_ZOOM_MIN);
    expect(clampCanvasZoom(CANVAS_ZOOM_MAX)).toBe(CANVAS_ZOOM_MAX);
  });

  it("falls back to 1 for a value that is not a number, at either infinity", () => {
    expect(clampCanvasZoom(Number.NaN)).toBe(1);
    expect(clampCanvasZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampCanvasZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("zooms out on a downward wheel and in on an upward one, by one step", () => {
    expect(stepCanvasZoom(1, 120)).toBe(1 - CANVAS_ZOOM_STEP);
    expect(stepCanvasZoom(1, -120)).toBe(1 + CANVAS_ZOOM_STEP);
  });

  it("stops at 0.4 and 2.0 however long the wheel turns", () => {
    let zoomedOut = 1;
    for (let step = 0; step < 40; step += 1) zoomedOut = stepCanvasZoom(zoomedOut, 120);
    expect(zoomedOut).toBe(CANVAS_ZOOM_MIN);

    let zoomedIn = 1;
    for (let step = 0; step < 40; step += 1) zoomedIn = stepCanvasZoom(zoomedIn, -120);
    expect(zoomedIn).toBe(CANVAS_ZOOM_MAX);
  });

  it("does not accumulate float error over repeated steps", () => {
    let zoom = CANVAS_ZOOM_MIN;
    for (let step = 0; step < 10; step += 1) zoom = stepCanvasZoom(zoom, -120);
    expect(zoom).toBe(1.4);
    expect(`${zoom}`).toBe("1.4");
  });
});

describe("canvas coordinate mapping under scale", () => {
  it("passes a delta through unchanged at zoom 1", () => {
    expect(pointerDeltaToCanvas(12, -7, 1)).toEqual({ dx: 12, dy: -7 });
  });

  it("divides by the zoom, so half zoom doubles the canvas distance", () => {
    expect(pointerDeltaToCanvas(10, 20, 0.5)).toEqual({ dx: 20, dy: 40 });
    expect(pointerDeltaToCanvas(10, 20, 2)).toEqual({ dx: 5, dy: 10 });
  });

  it("treats a zero or unusable zoom as 1 rather than dividing by zero", () => {
    expect(pointerDeltaToCanvas(10, 20, 0)).toEqual({ dx: 10, dy: 20 });
    expect(pointerDeltaToCanvas(10, 20, Number.NaN)).toEqual({ dx: 10, dy: 20 });
    expect(pointerDeltaToCanvas(10, 20, -1)).toEqual({ dx: 10, dy: 20 });
  });

  it("moves a node by the canvas distance the pointer travelled", () => {
    const moved = canvasPointerMoveLayout(LAYOUT, 50, -25, 0.5);
    expect(moved).toMatchObject({ x: 200, y: 150 });
    // The size is untouched by a move.
    expect(moved).toMatchObject({ width: 240, height: 180, zIndex: 3 });
  });

  it("resizes a node by the same converted distance, keeping its origin", () => {
    const resized = canvasPointerResizeLayout(LAYOUT, 20, 40, 0.5);
    expect(resized).toMatchObject({ x: 100, y: 200, width: 280, height: 260 });
  });

  it("keeps a resized node above the minimum the runtime validates", () => {
    const shrunk = canvasPointerResizeLayout(LAYOUT, -10_000, -10_000, 1);
    expect(shrunk).toMatchObject({ width: CANVAS_MIN_NODE_SIZE, height: CANVAS_MIN_NODE_SIZE });
  });
});

describe("canvas pan-versus-drag rule", () => {
  it("pans for a pointerdown with no marker, including an unknown one", () => {
    expect(resolveCanvasPointerGesture(undefined)).toBe("pan");
    expect(resolveCanvasPointerGesture(null)).toBe("pan");
    expect(resolveCanvasPointerGesture("")).toBe("pan");
    expect(resolveCanvasPointerGesture("something-else")).toBe("pan");
  });

  it("drags the node and resizes it for the two node markers", () => {
    expect(resolveCanvasPointerGesture("move")).toBe("move");
    expect(resolveCanvasPointerGesture("resize")).toBe("resize");
  });

  it("starts no gesture at all for a marked control, so its click is its own", () => {
    expect(resolveCanvasPointerGesture("control")).toBe("none");
  });

  it("decides from the marker alone, so a gesture is never revised mid-drag", () => {
    // The rule is a pure function of the pointerdown target: the same marker
    // always yields the same gesture, and a node drag that wanders off the node
    // (or a pan that crosses one) cannot change what it became.
    const first = resolveCanvasPointerGesture("move");
    const later = resolveCanvasPointerGesture("move");
    expect(first).toBe("move");
    expect(later).toBe(first);
  });

  it("pins the attribute names the component queries and renders", () => {
    expect(CANVAS_GESTURE_ATTRIBUTE).toBe("data-canvas-gesture");
    expect(CANVAS_NODE_ID_ATTRIBUTE).toBe("data-canvas-node-id");
  });
});

describe("canvas keyboard equivalents", () => {
  it("maps the arrow keys and ignores everything else", () => {
    expect(canvasArrowDirection("ArrowLeft")).toEqual({ dx: -1, dy: 0 });
    expect(canvasArrowDirection("ArrowRight")).toEqual({ dx: 1, dy: 0 });
    expect(canvasArrowDirection("ArrowUp")).toEqual({ dx: 0, dy: -1 });
    expect(canvasArrowDirection("ArrowDown")).toEqual({ dx: 0, dy: 1 });
    expect(canvasArrowDirection("Enter")).toBeUndefined();
    expect(canvasArrowDirection("a")).toBeUndefined();
  });

  it("accelerates with Shift", () => {
    expect(canvasKeyStep(false)).toBe(CANVAS_NUDGE_STEP);
    expect(canvasKeyStep(true)).toBe(CANVAS_NUDGE_STEP_LARGE);
  });

  it("nudges a node without resizing it", () => {
    expect(nudgeCanvasLayout(LAYOUT, { dx: 1, dy: 0 }, 8)).toMatchObject({
      x: 108, y: 200, width: 240, height: 180,
    });
    expect(nudgeCanvasLayout(LAYOUT, { dx: 0, dy: -1 }, 32)).toMatchObject({ x: 100, y: 168 });
  });

  it("resizes a node without moving it, and never below the minimum", () => {
    expect(resizeCanvasLayoutBy(LAYOUT, { dx: 1, dy: 1 }, 8)).toMatchObject({
      x: 100, y: 200, width: 248, height: 188,
    });
    expect(resizeCanvasLayoutBy(LAYOUT, { dx: -1, dy: -1 }, 10_000)).toMatchObject({
      width: CANVAS_MIN_NODE_SIZE, height: CANVAS_MIN_NODE_SIZE,
    });
  });
});

describe("canvas layout normalisation", () => {
  it("keeps a layout the runtime will accept", () => {
    expect(normalizeCanvasLayout(LAYOUT)).toEqual(LAYOUT);
  });

  it("raises a non-positive width or height to the minimum", () => {
    expect(normalizeCanvasLayout({ ...LAYOUT, width: 0, height: -40 })).toMatchObject({
      width: CANVAS_MIN_NODE_SIZE, height: CANVAS_MIN_NODE_SIZE,
    });
  });

  it("truncates a fractional zIndex to the safe integer the runtime requires", () => {
    expect(normalizeCanvasLayout({ ...LAYOUT, zIndex: 2.7 }).zIndex).toBe(2);
    expect(normalizeCanvasLayout({ ...LAYOUT, zIndex: -3 }).zIndex).toBe(0);
    expect(normalizeCanvasLayout({ ...LAYOUT, zIndex: Number.NaN }).zIndex).toBe(0);
  });

  it("rounds coordinates and neutralises a value that is not a number", () => {
    expect(normalizeCanvasLayout({ ...LAYOUT, x: 10.6, y: -0.2 })).toMatchObject({ x: 11, y: -0 });
    expect(normalizeCanvasLayout({ ...LAYOUT, x: Number.NaN, y: Number.POSITIVE_INFINITY }))
      .toMatchObject({ x: 0, y: 0 });
  });

  it("knows when a drag actually changed the layout", () => {
    expect(canvasLayoutsEqual(LAYOUT, { ...LAYOUT })).toBe(true);
    expect(canvasLayoutsEqual(LAYOUT, { ...LAYOUT, x: 101 })).toBe(false);
    expect(canvasLayoutsEqual(LAYOUT, { ...LAYOUT, zIndex: 4 })).toBe(false);
    expect(canvasLayoutsEqual(undefined, undefined)).toBe(true);
    expect(canvasLayoutsEqual(LAYOUT, undefined)).toBe(false);
  });
});

describe("canvas drag preview", () => {
  it("replaces only the dragged node's layout", () => {
    const nodes = [node("a"), node("b")];
    const previewed = applyCanvasLayoutPreview(nodes, { nodeId: "b", layout: { ...LAYOUT, x: 5 } });
    expect(previewed[0]).toBe(nodes[0]);
    expect(previewed[1]?.layout).toMatchObject({ x: 5 });
  });

  it("is the confirmed document itself when there is no preview, so a refused operation drops it", () => {
    const nodes = [node("a")];
    expect(applyCanvasLayoutPreview(nodes, undefined)).toBe(nodes);
  });

  it("leaves the document alone for a node id that is not on the canvas", () => {
    const nodes = [node("a")];
    expect(applyCanvasLayoutPreview(nodes, { nodeId: "ghost", layout: LAYOUT })).toEqual(nodes);
  });
});

describe("canvas operation sent to applyCanvas", () => {
  it("is the runtime's CanvasOperationV1 for a layout change", () => {
    const operation = buildCanvasOperation("op-1", [buildCanvasUpdateLayoutMutation("node-1", LAYOUT)]);
    expect(operation).toEqual({
      schemaVersion: 1,
      operationId: "op-1",
      mutations: [{ kind: "update_layout", nodeId: "node-1", layout: LAYOUT }],
    });
  });

  it("carries exactly one file identity on add_file, which the runtime requires", () => {
    const byPath = buildCanvasAddFileMutation("node-2", LAYOUT, { relativePath: "docs/a.png" });
    expect(byPath).toEqual({
      kind: "add_file",
      nodeId: "node-2",
      layout: LAYOUT,
      relativePath: "docs/a.png",
    });
    expect("assetId" in byPath).toBe(false);

    const byAsset = buildCanvasAddFileMutation("node-2", LAYOUT, { assetId: "asset_1" });
    expect(byAsset).toEqual({ kind: "add_file", nodeId: "node-2", layout: LAYOUT, assetId: "asset_1" });
    expect("relativePath" in byAsset).toBe(false);
  });

  it("names the node for a removal", () => {
    expect(buildCanvasRemoveNodeMutation("node-3")).toEqual({ kind: "remove_node", nodeId: "node-3" });
  });

  it("normalises the layout it sends rather than trusting the drag", () => {
    const mutation = buildCanvasUpdateLayoutMutation("node-1", { ...LAYOUT, width: 0, zIndex: 1.9 });
    expect(mutation).toMatchObject({
      kind: "update_layout",
      layout: { width: CANVAS_MIN_NODE_SIZE, zIndex: 1 },
    });
  });

  it("refuses to build what the runtime would refuse, instead of sending it", () => {
    expect(() => buildCanvasOperation("   ", [buildCanvasRemoveNodeMutation("node-1")]))
      .toThrow(/operationId/);
    expect(() => buildCanvasOperation("op-1", [])).toThrow(/at least one mutation/);
  });

  it("survives the JSON wire the transport sends it over", () => {
    const operation = buildCanvasOperation("op-1", [
      buildCanvasAddFileMutation("node-1", LAYOUT, { relativePath: "docs/a.png" }),
      buildCanvasUpdateLayoutMutation("node-2", LAYOUT),
      buildCanvasRemoveNodeMutation("node-3"),
    ]);
    expect(JSON.parse(JSON.stringify(operation))).toEqual(operation);
    expect(operation.mutations).toHaveLength(3);
  });

  it("mints a fresh operation id per call, because the runtime rejects a reuse", () => {
    const ids = new Set([createCanvasOperationId(), createCanvasOperationId(), createCanvasOperationId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.trim().length).toBeGreaterThan(0);
  });

  it("mints a node id that cannot collide with an existing node", () => {
    expect(createCanvasNodeId()).not.toBe(createCanvasNodeId());
  });
});

describe("canvas document parsing", () => {
  it("reads the node layout and the file name the panel displays", () => {
    const nodes = parseCanvasNodes(document([{
      id: "node-1",
      type: "file_ref",
      file: { relativePath: "docs/a.png", fileName: "a.png" },
      layout: { x: 10, y: 20, width: 200, height: 150, zIndex: 2 },
      annotations: [],
    }]));
    expect(nodes).toEqual([
      { id: "node-1", label: "a.png", layout: { x: 10, y: 20, width: 200, height: 150, zIndex: 2 } },
    ]);
  });

  it("falls back through relative path to the node id for the label", () => {
    const nodes = parseCanvasNodes(document([
      { id: "a", file: { relativePath: "docs/a.png" }, layout: LAYOUT },
      { id: "b", file: {}, layout: LAYOUT },
    ]));
    expect(nodes.map((entry) => entry.label)).toEqual(["docs/a.png", "b"]);
  });

  it("drops a node the panel cannot place instead of breaking the render", () => {
    const nodes = parseCanvasNodes(document([
      { file: { fileName: "a.png" }, layout: LAYOUT },
      { id: "no-layout", file: { fileName: "b.png" } },
      { id: "bad-layout", layout: { x: "0", y: 0, width: 10, height: 10 } },
      { id: "nan-layout", layout: { x: Number.NaN, y: 0, width: 10, height: 10 } },
      { id: "good", layout: LAYOUT },
    ]));
    expect(nodes.map((entry) => entry.id)).toEqual(["good"]);
  });

  it("reads a document with no nodes, and no document at all, as an empty canvas", () => {
    expect(parseCanvasNodes(document([]))).toEqual([]);
    expect(parseCanvasNodes(undefined)).toEqual([]);
    expect(parseCanvasNodes({ ...document([]), nodes: "not-an-array" as never })).toEqual([]);
  });
});

describe("canvas node placement for a new node", () => {
  it("places the first node and stacks later ones on top of the highest", () => {
    const empty = nextCanvasNodeLayout([]);
    expect(empty).toMatchObject({ zIndex: 1 });
    expect(empty.width).toBeGreaterThan(0);
    expect(empty.height).toBeGreaterThan(0);

    const existing = [node("a", { zIndex: 4 }), node("b", { zIndex: 9 })];
    expect(nextCanvasZIndex(existing)).toBe(10);
    expect(nextCanvasNodeLayout(existing).zIndex).toBe(10);
  });

  it("cascades instead of stacking every add on one spot", () => {
    const nodes: CanvasNodeView[] = [];
    for (let index = 0; index < 6; index += 1) {
      const placed = nextCanvasNodeLayout(nodes);
      nodes.push(node(`n${index}`, placed));
    }
    const positions = nodes.map((entry) => `${entry.layout.x}:${entry.layout.y}`);
    expect(new Set(positions).size).toBe(6);
  });
});

describe("canvas failure reporting", () => {
  it("surfaces a server refusal instead of showing an optimistic layout", () => {
    expect(describeCanvasError(new Error("Canvas node not found: node-9")))
      .toBe("Canvas node not found: node-9");
    expect(describeCanvasError("Canvas operation is invalid")).toBe("Canvas operation is invalid");
    expect(describeCanvasError(undefined)).toMatch(/没有保存/);
    expect(describeCanvasError(new Error("   "))).toMatch(/没有保存/);
  });
});

describe("canvas markup", () => {
  // No effect runs, so this is the panel before its first read resolves: the
  // empty state the brief says must survive, plus the zoom readout.
  it("keeps the empty state, the class names and the zoom readout", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceCanvas, { sessionId: "session-1" }));
    expect(markup).toContain('class="webui-canvas-content"');
    expect(markup).toContain("把文件放到画布上");
    expect(markup).toContain("添加图片或其他工作区文件，然后自由排列和调整大小。");
    expect(markup).toContain('class="webui-canvas-zoom"');
    expect(markup).toContain("100%");
  });

  it("offers the add path the empty state promises, and says so when it is read-only", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceCanvas, { sessionId: "session-1" }));
    expect(markup).toContain("添加到画布");
    expect(markup).toContain("工作区相对路径");
    expect(markup).toContain("画布当前为只读");
    // Read-only means the controls are disabled, not merely hidden.
    expect(markup).toContain("disabled");
  });
});
