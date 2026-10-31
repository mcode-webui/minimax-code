// The browser authorization binding: one owner, read by whichever surface needs it.
//
// The switches live in the Settings page and the panel still needs to know
// whether the surface it is showing is authorized. Two surfaces reading one
// answer is the point: a provider mounted once gives the panel and the settings
// page the same owner, so a switch moved in the settings page reaches the panel
// without the panel re-reading the host.
//
// `undefined` means the browser family is not wired at all — no host, no
// switches, and nothing the person could usefully turn on.

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { useWebuiPortSlice } from "../../../bindings/port-slices-context.js";
import {
  createWebuiBrowserAuthorizationOwner,
  type WebuiBrowserAuthorizationOwner,
  type WebuiBrowserAuthorizationState,
} from "../application/browser-authorization.js";

/** A no-op subscription, for a surface mounted outside the browser family. */
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** Nothing is authorized when there is no owner to ask. */
const NO_STATE = (): WebuiBrowserAuthorizationState | undefined => undefined;

const WebuiBrowserAuthorizationContext = createContext<WebuiBrowserAuthorizationOwner | undefined>(
  undefined,
);

/**
 * Provides the browser authorization owner.
 *
 * Mounted once, above every surface that reads the switches: the panel in the
 * tool area and the settings page in the modal are different trees, and only a
 * provider above both of them can give them one answer.
 */
export function WebuiBrowserAuthorizationProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const port = useWebuiPortSlice("browser");
  const owner = useMemo(
    () => (port ? createWebuiBrowserAuthorizationOwner({ port }) : undefined),
    [port],
  );
  return (
    <WebuiBrowserAuthorizationContext.Provider value={owner}>
      {children}
    </WebuiBrowserAuthorizationContext.Provider>
  );
}

/** The owner, for a surface that submits a command to it. */
export function useWebuiBrowserAuthorization(): WebuiBrowserAuthorizationOwner | undefined {
  return useContext(WebuiBrowserAuthorizationContext);
}

/**
 * The published authorization, or `undefined` when the browser family is absent.
 *
 * The snapshot is the owner's own object, so an unchanged authorization costs
 * no render: the owner replaces the snapshot only when the answer changes.
 */
export function useWebuiBrowserAuthorizationState(): WebuiBrowserAuthorizationState | undefined {
  const owner = useWebuiBrowserAuthorization();
  const subscribe = owner?.subscribe ?? NO_SUBSCRIPTION;
  const read = owner ? owner.getSnapshot : NO_STATE;
  return useSyncExternalStore(subscribe, read, read);
}
