// The presentation-scoped overlay coordinator (ADR 0028 § Overlay coordination).
//
// One coordinator per client document owns registration, lifetime and routing.
// It owns nothing else: no business state, no form data, no commands, no
// navigation, no lifetimes. A surface registers presentation facts — its id, its
// logical parent, its order, whether it is active, how it answers a dismissal —
// and a callback that resolves the route it is given.
//
// The decision itself is pure and lives in
// `client/projection/common/overlay-order.ts`. This module is the registry and
// the wiring: it keeps the registrations, asks the decision which single layer
// answers an event, and hands that one layer its route. It never routes the same
// event twice and never turns an `ignore` into a reroute to an ancestor.
//
// Registration is ephemeral and the caller stays authoritative — a layer that
// unmounts is unregistered, and a decision that names a layer which has gone
// since is skipped rather than thrown.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  decideOverlayAction,
  resolveOverlayDecision,
  type OverlayDecision,
  type OverlayEvent,
  type OverlayLayer,
} from "../projection/common/overlay-order.js";

/** What a layer hands the coordinator when it registers. */
export interface OverlayRegistration extends OverlayLayer {
  /** Resolve the route the coordinator decided on for this layer. */
  readonly onRoute: (route: OverlayDecision["route"], event?: OverlayEvent) => void;
}

/**
 * The registry itself, kept free of React so the invariants that matter —
 * idempotent registration, an unregistered layer casting no vote, one route per
 * event — are testable without a renderer.
 */
export interface OverlayRegistry {
  register(registration: OverlayRegistration): () => void;
  unregister(id: string): void;
  layers(): readonly OverlayLayer[];
  /** Route one event. Returns the decision that was applied. */
  dispatch(event: OverlayEvent): OverlayDecision;
  size(): number;
}

export function createOverlayRegistry(): OverlayRegistry {
  const registrations = new Map<string, OverlayRegistration>();

  const unregister = (id: string) => {
    registrations.delete(id);
  };

  const register = (registration: OverlayRegistration) => {
    // Registering an id that is already held replaces it instead of adding a
    // second entry: a React remount registers before the previous effect's
    // cleanup runs, and two entries for one layer would let the same event
    // reach two callbacks.
    registrations.set(registration.id, registration);
    return () => {
      if (registrations.get(registration.id) === registration) unregister(registration.id);
    };
  };

  const layers = () =>
    [...registrations.values()].map(({ onRoute: _onRoute, ...layer }) => layer);

  const dispatch = (event: OverlayEvent) => {
    const decision = decideOverlayAction(layers(), event);
    const callbacks = new Map(
      [...registrations.values()].map((registration) => [
        registration.id,
        registration.onRoute,
      ]),
    );
    resolveOverlayDecision(decision, callbacks, event);
    return decision;
  };

  return { register, unregister, layers, dispatch, size: () => registrations.size };
}

interface OverlayCoordinatorValue {
  readonly registry: OverlayRegistry;
}

const OverlayCoordinatorContext = createContext<OverlayCoordinatorValue | null>(null);

/**
 * Provide the coordinator once per client document.
 *
 * Shell composition mounts this above the surfaces; a document-level Escape
 * listener and the capture-phase pointer dispatcher that call `dispatch` belong
 * to the platform layer, so this component holds no listener of its own and no
 * business state.
 */
export function OverlayCoordinatorProvider({ children }: { children: ReactNode }): ReactElement {
  const registryRef = useRef<OverlayRegistry | null>(null);
  registryRef.current ??= createOverlayRegistry();
  const value = useMemo(() => ({ registry: registryRef.current as OverlayRegistry }), []);
  return (
    <OverlayCoordinatorContext.Provider value={value}>{children}</OverlayCoordinatorContext.Provider>
  );
}

/** The coordinator, or null when a surface is rendered outside the shell. */
export function useOverlayCoordinator(): OverlayRegistry | null {
  return useContext(OverlayCoordinatorContext)?.registry ?? null;
}

/**
 * Register one managed layer for as long as the calling component is mounted.
 *
 * The registration follows the descriptor it is given, so a layer that opens,
 * closes, is nested or changes its dismissal policy re-registers instead of
 * leaving a stale fact behind. Under a React remount the previous registration
 * is replaced, not duplicated, and its cleanup cannot unregister the new one.
 */
export function useOverlayLayer(
  descriptor: OverlayRegistration,
  options: { readonly enabled?: boolean } = {},
): void {
  const coordinator = useOverlayCoordinator();
  const enabled = options.enabled ?? true;
  const { id, parentId, order, active, dismissal, onRoute } = descriptor;
  const onRouteRef = useRef(onRoute);
  onRouteRef.current = onRoute;
  const stableOnRoute = useCallback(
    (route: OverlayDecision["route"], event?: OverlayEvent) => onRouteRef.current(route, event),
    [],
  );

  useEffect(() => {
    if (!coordinator || !enabled) return undefined;
    const unregister = coordinator.register({
      id,
      parentId: parentId ?? null,
      order,
      active,
      dismissal,
      onRoute: stableOnRoute,
    });
    return unregister;
  }, [coordinator, enabled, id, parentId, order, active, dismissal, stableOnRoute]);
}
