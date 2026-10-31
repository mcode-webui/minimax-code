// The port-slice provider and its read hooks.
//
// This is the delivery half of `application/port-slices.ts`: the composition root
// builds the slices once and provides them here, and a business reads *its own*
// slice through `useWebuiPortSlice`.
//
// **Absent provider means "not wired", not "throw".** The hook returns
// `undefined` when no provider is mounted (SSR, unit tests) and when the
// slice's members are unwired, which is the state the components already handle:
// they gate on `transport?.X` today and gate on `slice?.X` after their carve.
// A hook that threw would force every consumer to invent a fallback for a case
// the "not wired" mode already covers.

import { createContext, useContext, type ReactNode } from "react";

import type {
  WebuiPortSliceBusiness,
  WebuiPortSlices,
} from "../application/port-slices.js";

const WebuiPortSlicesContext = createContext<WebuiPortSlices | undefined>(
  undefined,
);

export function WebuiPortSlicesProvider({
  slices,
  children,
}: {
  readonly slices: WebuiPortSlices;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiPortSlicesContext.Provider value={slices}>
      {children}
    </WebuiPortSlicesContext.Provider>
  );
}

/** Every slice, for a composition root or a test that needs more than one. */
export function useWebuiPortSlicesOptional(): WebuiPortSlices | undefined {
  return useContext(WebuiPortSlicesContext);
}

/**
 * One business's slice. The parameter is the business name, not a key or an
 * owner argument, so a caller cannot ask for another business's capabilities:
 * the set of things this returns is decided by the provider, not by the call
 * site, and the return type is the slice's own `Pick`.
 */
export function useWebuiPortSlice<K extends WebuiPortSliceBusiness>(
  business: K,
): WebuiPortSlices[K] | undefined {
  return useContext(WebuiPortSlicesContext)?.[business];
}
