/**
 * The document listeners that make the coordinator's order real (#289).
 *
 * `overlay-order.ts` decides; the registry routes; this module is the only place
 * that listens. One Escape handler and one pointerdown handler for the whole
 * document, both in the capture phase, so a layer's own handler cannot pre-empt
 * the order — and so the client never grows a second listener per overlay.
 *
 * What it does not do: focus. A layer that moves focus into itself and returns it
 * on unmount keeps doing that itself, because focus is a rendering concern and
 * the coordinator only decides who answers an event.
 */

import { createContext, useContext, useEffect, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import { useOverlayCoordinator } from "./overlay-coordinator.js";

/** The layer a managed surface is nested inside. */
const ParentLayerContext = createContext<string | null>(null);

/**
 * Every layer element on the document, marked with its layer id.
 *
 * The listener needs to know which layers a press landed inside; reading that
 * from the DOM keeps the registration free of React refs and lets a portal — a
 * popup rendered outside its parent's subtree — still count as inside the layer
 * it belongs to, as long as it carries the attribute.
 */
const LAYER_ATTRIBUTE = "data-overlay-layer";

/** The managed layers containing a node, innermost first. */
export function layersAt(node: Element | null): string[] {
  const found: string[] = [];
  let current: Element | null = node;
  while (current) {
    // An element can belong to more than one layer: the composer's region holds
    // the mention menu and the command menu, and a press in the editor is inside
    // both of them.
    const ids = current.getAttribute?.(LAYER_ATTRIBUTE);
    if (ids) found.push(...ids.split(/\s+/u).filter(Boolean));
    current = current.parentElement;
  }
  return found;
}

/**
 * Mount once, above the surfaces. It renders nothing.
 *
 * Escape dispatches one event; pointerdown dispatches one event. Neither falls
 * back to closing everything, and neither re-dispatches to an ancestor: an event
 * selects at most one layer, which is the invariant the pure decision states.
 */
export function OverlayListenerHost(): ReactElement | null {
  const coordinator = useOverlayCoordinator();
  const { dom } = useWebuiBrowserCapabilities();
  useEffect(() => {
    if (!coordinator) return undefined;
    const stopKeyDown = dom.listenForKeyDown((event) => {
      if (event.key !== "Escape") return;
      const decision = coordinator.dispatch({
        kind: "escape",
        insideLayerIds: layersAt(dom.getActiveElement()),
      });
      // The coordinator consumed the key for some layer; nothing else may.
      if (decision.route !== "ignore") event.stopPropagation();
    });
    const stopPointerDown = dom.listenForPointerDown((event) => {
      const decision = coordinator.dispatch({
        kind: "pointerdown",
        insideLayerIds: layersAt(event.target as Element | null),
      });
      if (decision.route === "block") {
        // A blocked modal keeps its background protected: the press is consumed
        // before it can reach anything underneath.
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    return () => {
      stopKeyDown();
      stopPointerDown();
    };
  }, [coordinator, dom]);
  return null;
}

/**
 * Declare that everything rendered below is nested inside one managed layer.
 *
 * A popup opened from inside a dialog, and a confirmation opened from that
 * popup, each register with the layer they were opened from, so the order is a
 * fact of the composition rather than a number someone guessed.
 */
export function ManagedOverlayBoundary({
  layerId,
  children,
}: {
  readonly layerId: string;
  readonly children: ReactNode;
}): ReactElement {
  return <ParentLayerContext.Provider value={layerId}>{children}</ParentLayerContext.Provider>;
}

/** The layer this surface is nested inside, or null at the root. */
export function useParentLayerId(): string | null {
  return useContext(ParentLayerContext);
}

/** The attribute that lets the listener find a layer from an event target. */
export const OVERLAY_LAYER_ATTRIBUTE = LAYER_ATTRIBUTE;

/** A ref that marks its element as a managed layer of the given id. */
export function useLayerAttribute<T extends HTMLElement>(): {
  readonly ref: RefObject<T | null>;
} {
  return { ref: useRef<T | null>(null) };
}
