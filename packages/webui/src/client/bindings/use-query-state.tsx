// React subscription to the application query owners (plan §7.2
// `client/bindings/use-query-state.ts`; ticket #51).
//
// The workspace query owner lives in `application/workspace-queries.ts` and is
// created once by the composition root. This binding is the only React edge to
// it: components read its snapshot and submit query commands, and they never
// receive a transport method or a store writer for these queries (plan §7.6).
//
// The context is deliberately non-throwing: an SSR render or a unit test that
// mounts a panel without the provider reads the initial snapshot and submits
// no-ops, which is the correct behaviour with no runtime attached.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  initialWebuiWorkspaceQueriesState,
  type WebuiWorkspaceQueries,
  type WebuiWorkspaceQueriesState,
} from "../application/workspace-queries.js";

const WebuiWorkspaceQueriesContext = createContext<WebuiWorkspaceQueries | undefined>(
  undefined,
);

export function WebuiWorkspaceQueriesProvider({
  queries,
  children,
}: {
  readonly queries: WebuiWorkspaceQueries;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiWorkspaceQueriesContext.Provider value={queries}>
      {children}
    </WebuiWorkspaceQueriesContext.Provider>
  );
}

/** The owner for imperative query commands, or `undefined` with no provider. */
export function useWebuiWorkspaceQueries(): WebuiWorkspaceQueries | undefined {
  return useContext(WebuiWorkspaceQueriesContext);
}

/**
 * Subscribe to the workspace query snapshot. With no provider the initial
 * snapshot is returned — a stable reference, so an unprovided tree does not
 * re-render.
 */
export function useWebuiWorkspaceQueriesState(): WebuiWorkspaceQueriesState {
  const queries = useContext(WebuiWorkspaceQueriesContext);
  return useSyncExternalStore(
    queries ? queries.subscribe : noopSubscribe,
    queries ? queries.getSnapshot : initialSnapshot,
    queries ? queries.getSnapshot : initialSnapshot,
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function initialSnapshot(): WebuiWorkspaceQueriesState {
  return initialWebuiWorkspaceQueriesState;
}
