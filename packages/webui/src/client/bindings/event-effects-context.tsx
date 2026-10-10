// The per-session effects registration surface (ticket #45, pre-flip bridge).
//
// The composition root holds one `WebuiEventEffectsRegistry` for the mount and
// provides it here; a component that owns a session's effect handlers reads the
// registry from this context and registers them against the session id, and it
// never holds the channel. This is the React half of
// `application/event-effects-registry.ts` (plan §7.2 `client/bindings/`): it
// contains no business rule of its own and never subscribes to the
// process-event stream.
//
// The registry is optional on purpose. SSR and unit tests may render a subtree
// (the composer included) without the provider, and a missing provider must
// register nothing, not throw — production always provides one.

import { createContext, useContext, type ReactNode } from "react";

import type { WebuiEventEffectsRegistry } from "../application/event-effects-registry.js";

const WebuiEventEffectsRegistryContext = createContext<
  WebuiEventEffectsRegistry | undefined
>(undefined);

export function WebuiEventEffectsRegistryProvider({
  registry,
  children,
}: {
  readonly registry: WebuiEventEffectsRegistry;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiEventEffectsRegistryContext.Provider value={registry}>
      {children}
    </WebuiEventEffectsRegistryContext.Provider>
  );
}

/** The registry, or `undefined` when no provider is mounted (SSR, tests). */
export function useWebuiEventEffectsRegistry():
  | WebuiEventEffectsRegistry
  | undefined {
  return useContext(WebuiEventEffectsRegistryContext);
}
