// The overlay coordinator's registry (ADR 0028 § Overlay coordination).
//
// The decision is tested next door in `overlay-order.test.ts`. What is left is
// the part React can break: registration that duplicates itself, a cleanup that
// unregisters somebody else's registration, a layer that disappears between the
// decision and its callback, and the claim that the provider is presentation
// only — it must add no element of its own to the document.
//
// The provider is asserted through `renderToStaticMarkup`, which is the shape
// this package uses where a DOM framework is not allowed. The hook's effect
// timing (mount, remount, unmount) is replaced by calling the registry directly,
// which is the same code the effect calls; the effect itself is the untested
// boundary and is named as such in the report.

import { assert, describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  createOverlayRegistry,
  OverlayCoordinatorProvider,
  type OverlayRegistration,
} from "../../src/client/ui/overlay-coordinator.js";

const registration = (
  overrides: Partial<OverlayRegistration> & Pick<OverlayRegistration, "id">,
): OverlayRegistration => ({
  order: 0,
  active: true,
  dismissal: "dismissible",
  onRoute: () => undefined,
  ...overrides,
});

describe("registration", () => {
  it("holds one entry per id, so a remount cannot duplicate a layer", () => {
    const registry = createOverlayRegistry();
    const routes: string[] = [];
    registry.register(registration({ id: "menu", onRoute: (route) => routes.push(`first:${route}`) }));
    registry.register(registration({ id: "menu", onRoute: (route) => routes.push(`second:${route}`) }));

    assert.equal(registry.size(), 1);
    registry.dispatch({ kind: "escape", insideLayerIds: [] });
    assert.deepEqual(routes, ["second:request-close"]);
  });

  it("does not let a replaced registration's cleanup remove its replacement", () => {
    const registry = createOverlayRegistry();
    const first = registry.register(registration({ id: "menu" }));
    registry.register(registration({ id: "menu" }));
    // The remount order React actually produces: the new registration is
    // recorded before the previous effect's cleanup runs.
    first();

    assert.equal(registry.size(), 1);
    assert.deepEqual(registry.layers().map((layer) => layer.id), ["menu"]);
  });

  it("unregisters on its own cleanup and casts no vote afterwards", () => {
    const registry = createOverlayRegistry();
    const unregister = registry.register(registration({ id: "menu" }));
    unregister();

    assert.equal(registry.size(), 0);
    assert.deepEqual(registry.dispatch({ kind: "escape", insideLayerIds: [] }), {
      layerId: null,
      route: "ignore",
    });
  });

  it("treats an unknown id's unregistration as a no-op", () => {
    const registry = createOverlayRegistry();
    registry.unregister("never-registered");
    assert.equal(registry.size(), 0);
  });
});

describe("routing", () => {
  it("hands one route to exactly one layer, and never a second event", () => {
    const registry = createOverlayRegistry();
    const routes: string[] = [];
    registry.register(
      registration({ id: "dialog", onRoute: (route) => routes.push(`dialog:${route}`) }),
    );
    registry.register(
      registration({ id: "menu", parentId: "dialog", onRoute: (route) => routes.push(`menu:${route}`) }),
    );

    const decision = registry.dispatch({ kind: "escape", insideLayerIds: [] });
    assert.deepEqual(decision, { layerId: "menu", route: "request-close" });
    assert.deepEqual(routes, ["menu:request-close"]);
  });

  it("skips a layer that unregistered after the layer list was read", () => {
    const registry = createOverlayRegistry();
    let routed = 0;
    const unregister = registry.register(
      registration({
        id: "menu",
        onRoute: () => {
          routed += 1;
        },
      }),
    );
    unregister();

    const decision = registry.dispatch({ kind: "pointerdown", insideLayerIds: [] });
    assert.equal(decision.route, "ignore");
    assert.equal(routed, 0);
  });

  it("keeps a press inside a registered descendant with its parent", () => {
    const registry = createOverlayRegistry();
    const routes: string[] = [];
    registry.register(
      registration({ id: "dialog", onRoute: (route) => routes.push(`dialog:${route}`) }),
    );
    registry.register(
      registration({
        id: "portal-region",
        parentId: "dialog",
        active: false,
        dismissal: "deferred",
        onRoute: (route) => routes.push(`portal:${route}`),
      }),
    );

    registry.dispatch({ kind: "pointerdown", insideLayerIds: ["portal-region"] });
    assert.deepEqual(routes, ["dialog:handle"]);
  });
});

describe("the provider", () => {
  it("renders its children and no element of its own", () => {
    const markup = renderToStaticMarkup(
      createElement(
        OverlayCoordinatorProvider,
        null,
        createElement("span", { "data-synthetic": "child" }, "synthetic"),
      ),
    );
    assert.equal(markup, '<span data-synthetic="child">synthetic</span>');
  });
});
