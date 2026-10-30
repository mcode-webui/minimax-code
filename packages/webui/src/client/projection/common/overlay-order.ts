/**
 * The client's overlay order, as one pure decision (ADR 0028 § Overlay
 * coordination).
 *
 * This module answers one question: given the managed floating layers and the
 * facts of one event, which single layer answers it, and with which route? It
 * never sees a DOM node, so nested order, a blocked modal, a press inside a
 * descendant and a stale registration can all be tested without a browser.
 *
 * The route vocabulary is the coordinator's: `handle` means the layer consumed
 * the event itself (a popup stepping from its list to its panel), `request-close`
 * means the layer is asked to dismiss, `block` means the attempt is consumed and
 * must not reach an ancestor, and `ignore` means nothing claims it. One event
 * selects at most one layer: an `ignore` does not reroute the event to an
 * ancestor, and the caller must not dispatch the same event twice.
 */

/** What a managed layer tells the coordinator about itself. */
export interface OverlayLayer {
  readonly id: string;
  /** The layer this one is nested inside, when it is nested. */
  readonly parentId?: string | null;
  /** Presentation order among siblings. Higher is nearer the front. */
  readonly order: number;
  /** An inactive layer casts no vote and is never selected. */
  readonly active: boolean;
  /**
   * How the layer answers a dismissal attempt aimed at it.
   *
   * `dismissible` asks to close, `blocked` consumes the attempt so it cannot
   * reach an ancestor, `deferred` leaves the attempt unanswered — which is how
   * a layer says its own content owns the key rather than another overlay.
   */
  readonly dismissal: "dismissible" | "blocked" | "deferred";
}

/** The facts of one event, never a DOM node. */
export interface OverlayEvent {
  readonly kind: "escape" | "pointerdown";
  /** The layers the press landed inside, innermost first; empty when outside. */
  readonly insideLayerIds: readonly string[];
}

/** One layer and one route; `layerId` is null when nothing claims the event. */
export interface OverlayDecision {
  readonly layerId: string | null;
  readonly route: "handle" | "request-close" | "block" | "ignore";
}

const NOTHING_CLAIMED: OverlayDecision = { layerId: null, route: "ignore" };

/**
 * The depth of a layer in the nesting chain.
 *
 * A layer whose parent is missing is treated as a root: a stale `parentId` must
 * not make a layer unreachable, and a cycle must not hang the decision, so the
 * walk stops the moment it revisits a layer.
 */
function depthOf(layer: OverlayLayer, byId: ReadonlyMap<string, OverlayLayer>): number {
  let depth = 0;
  let current: OverlayLayer | undefined = layer;
  const seen = new Set<string>([layer.id]);
  while (current?.parentId) {
    const parent: OverlayLayer | undefined = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * The layers in front-to-back order: deeper nesting first, then higher sibling
 * order, then id, so the answer never depends on the order the coordinator
 * happened to learn about them.
 */
export function orderOverlayLayers(
  layers: readonly OverlayLayer[],
): readonly OverlayLayer[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  return [...layers].sort((left, right) => {
    const depthDifference = depthOf(right, byId) - depthOf(left, byId);
    if (depthDifference !== 0) return depthDifference;
    if (left.order !== right.order) return right.order - left.order;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Is `candidateId` the layer `layerId` or one of its registered ancestors? */
function isWithin(
  layerId: string,
  candidateId: string,
  byId: ReadonlyMap<string, OverlayLayer>,
): boolean {
  let current: OverlayLayer | undefined = byId.get(layerId);
  const seen = new Set<string>();
  while (current) {
    if (current.id === candidateId) return true;
    if (seen.has(current.id) || !current.parentId) return false;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

/**
 * Decide which single layer answers an event.
 *
 * The topmost active layer is the one that answers. A press inside it or inside
 * one of its registered descendants is its own (`handle`); a press outside
 * reaches it only when it is dismissible, and a blocked layer consumes the
 * attempt instead of letting it fall through to an ancestor.
 */
export function decideOverlayAction(
  layers: readonly OverlayLayer[],
  event: OverlayEvent,
): OverlayDecision {
  const active = layers.filter((layer) => layer.active);
  if (active.length === 0) return NOTHING_CLAIMED;

  // Selection is over the active layers, but the inside test is over every
  // registered layer: a press can land in a descendant region that is registered
  // through the topmost layer while not being active itself (a closed nested
  // popup's portal, a region the parent owns), and that press is still the
  // parent's.
  const byId = new Map(layers.map((entry) => [entry.id, entry]));
  const topmost = orderOverlayLayers(active)[0];
  if (!topmost) return NOTHING_CLAIMED;

  if (event.kind === "escape") {
    switch (topmost.dismissal) {
      case "dismissible":
        return { layerId: topmost.id, route: "request-close" };
      case "blocked":
        return { layerId: topmost.id, route: "block" };
      case "deferred":
        return { layerId: topmost.id, route: "handle" };
    }
  }

  // A pointer press: the topmost layer answers for where the press landed,
  // including the descendant layers it registered.
  const landedInsideTopmost = event.insideLayerIds.some((id) =>
    isWithin(id, topmost.id, byId),
  );
  if (landedInsideTopmost) return { layerId: topmost.id, route: "handle" };
  switch (topmost.dismissal) {
    case "dismissible":
      return { layerId: topmost.id, route: "request-close" };
    case "blocked":
      return { layerId: topmost.id, route: "block" };
    case "deferred":
      return { layerId: topmost.id, route: "handle" };
  }
}

/**
 * Resolve a decision against the layer that answered it.
 *
 * The coordinator's registry is ephemeral: a layer can be gone by the time the
 * decision is applied, so an unknown id yields no callback rather than an
 * error, and the caller skips the event.
 */
export function resolveOverlayDecision(
  decision: OverlayDecision,
  callbacks: ReadonlyMap<string, (route: OverlayDecision["route"], event?: OverlayEvent) => void>,
  event?: OverlayEvent,
): boolean {
  if (decision.layerId === null) return false;
  const callback = callbacks.get(decision.layerId);
  if (!callback) return false;
  // The event travels with the route: a layer that asks to `handle` a key and a
  // press answers them differently, and the decision alone cannot say which one
  // it is looking at.
  callback(decision.route, event);
  return true;
}
