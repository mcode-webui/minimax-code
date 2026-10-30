// The client's overlay order (ADR 0028 § Overlay coordination).
//
// Every case here is a fact a browser would otherwise have to prove: which of
// two nested layers answers a key, whether a press inside a popup's own
// descendant counts as inside, what a blocked modal does with an attempt aimed
// past it, and what the decision does when a layer has closed, reopened or lost
// its parent. Nothing in these tests touches a DOM.

import { describe, expect, it } from "vitest";
import {
  decideOverlayAction,
  orderOverlayLayers,
  resolveOverlayDecision,
  type OverlayLayer,
} from "../../src/client/projection/common/overlay-order.js";

const layer = (overrides: Partial<OverlayLayer> & Pick<OverlayLayer, "id">): OverlayLayer => ({
  order: 0,
  active: true,
  dismissal: "dismissible",
  ...overrides,
});

const ids = (layers: readonly OverlayLayer[]) => layers.map((entry) => entry.id);

describe("overlay order", () => {
  it("puts a nested layer in front of its parent whatever the sibling order says", () => {
    const ordered = orderOverlayLayers([
      layer({ id: "dialog", order: 100 }),
      layer({ id: "menu", order: 0, parentId: "dialog" }),
    ]);
    expect(ids(ordered)).toEqual(["menu", "dialog"]);
  });

  it("orders siblings by presentation order, and ties by id rather than by arrival", () => {
    expect(ids(orderOverlayLayers([layer({ id: "a", order: 1 }), layer({ id: "b", order: 2 })]))).toEqual([
      "b",
      "a",
    ]);
    expect(ids(orderOverlayLayers([layer({ id: "b", order: 1 }), layer({ id: "a", order: 1 })]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("treats a layer whose parent is gone as a root instead of losing it", () => {
    const ordered = orderOverlayLayers([
      layer({ id: "orphan", parentId: "removed", order: 0 }),
      layer({ id: "root", order: 1 }),
    ]);
    expect(ids(ordered)).toEqual(["root", "orphan"]);
  });

  it("survives a parent chain that points at itself", () => {
    const ordered = orderOverlayLayers([
      layer({ id: "loop", parentId: "loop" }),
      layer({ id: "other" }),
    ]);
    expect(ids(ordered).sort()).toEqual(["loop", "other"]);
  });
});

describe("Escape", () => {
  it("asks the topmost dismissible layer to close, and only that one", () => {
    const decision = decideOverlayAction(
      [layer({ id: "dialog" }), layer({ id: "menu", parentId: "dialog" })],
      { kind: "escape", insideLayerIds: [] },
    );
    expect(decision).toEqual({ layerId: "menu", route: "request-close" });
  });

  it("lets a blocked modal consume the attempt so it never reaches its parent", () => {
    const decision = decideOverlayAction(
      [
        layer({ id: "confirm", parentId: "dialog", dismissal: "blocked" }),
        layer({ id: "dialog" }),
      ],
      { kind: "escape", insideLayerIds: [] },
    );
    expect(decision).toEqual({ layerId: "confirm", route: "block" });
  });

  it("does not reroute to an ancestor when the topmost layer defers", () => {
    const decision = decideOverlayAction(
      [
        layer({ id: "menu", parentId: "dialog", dismissal: "deferred" }),
        layer({ id: "dialog" }),
      ],
      { kind: "escape", insideLayerIds: [] },
    );
    expect(decision).toEqual({ layerId: "menu", route: "handle" });
  });

  it("claims nothing when no managed layer is active", () => {
    expect(
      decideOverlayAction([layer({ id: "closed", active: false })], {
        kind: "escape",
        insideLayerIds: [],
      }),
    ).toEqual({ layerId: null, route: "ignore" });
  });
});

describe("pointer press", () => {
  it("is the layer's own when it lands on the layer", () => {
    const decision = decideOverlayAction([layer({ id: "popup" })], {
      kind: "pointerdown",
      insideLayerIds: ["popup"],
    });
    expect(decision).toEqual({ layerId: "popup", route: "handle" });
  });

  it("is the layer's own when it lands in a descendant the layer registered", () => {
    const decision = decideOverlayAction(
      [layer({ id: "dialog" }), layer({ id: "nested-popup", parentId: "dialog", active: false })],
      { kind: "pointerdown", insideLayerIds: ["nested-popup"] },
    );
    // The descendant is registered through the parent even while it is not
    // itself active, so the press is still inside the dialog's subtree.
    expect(decision).toEqual({ layerId: "dialog", route: "handle" });
  });

  it("asks a dismissible layer to close when it lands outside", () => {
    const decision = decideOverlayAction(
      [layer({ id: "dialog" }), layer({ id: "menu", parentId: "dialog" })],
      { kind: "pointerdown", insideLayerIds: [] },
    );
    expect(decision).toEqual({ layerId: "menu", route: "request-close" });
  });

  it("is consumed by a blocked modal rather than dismissing an ancestor", () => {
    const decision = decideOverlayAction(
      [layer({ id: "dialog" }), layer({ id: "confirm", parentId: "dialog", dismissal: "blocked" })],
      { kind: "pointerdown", insideLayerIds: [] },
    );
    expect(decision).toEqual({ layerId: "confirm", route: "block" });
  });
});

describe("registration lifetime", () => {
  it("routes to the reopened layer after a close and reopen", () => {
    const closed = decideOverlayAction([layer({ id: "menu", active: false })], {
      kind: "escape",
      insideLayerIds: [],
    });
    expect(closed.route).toBe("ignore");
    const reopened = decideOverlayAction([layer({ id: "menu" })], {
      kind: "escape",
      insideLayerIds: [],
    });
    expect(reopened).toEqual({ layerId: "menu", route: "request-close" });
  });

  it("claims nothing for a layer that has already unregistered", () => {
    const callbacks = new Map<string, (route: string) => void>();
    const decision = decideOverlayAction([layer({ id: "menu" })], {
      kind: "escape",
      insideLayerIds: [],
    });
    // The registry is ephemeral: the decision may name a layer the coordinator
    // no longer holds, and that must be a skipped event rather than an error.
    expect(resolveOverlayDecision(decision, callbacks as never)).toBe(false);
  });

  it("hands the route to exactly one callback", () => {
    const routes: string[] = [];
    const callbacks = new Map<string, (route: never) => void>([
      ["menu", (route) => routes.push(route as unknown as string)],
      ["dialog", (route) => routes.push(`dialog:${route as unknown as string}`)],
    ]);
    const decision = decideOverlayAction(
      [layer({ id: "dialog" }), layer({ id: "menu", parentId: "dialog" })],
      { kind: "escape", insideLayerIds: [] },
    );
    expect(resolveOverlayDecision(decision, callbacks as never)).toBe(true);
    expect(routes).toEqual(["request-close"]);
  });
});
