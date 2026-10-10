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
import {
  initialWebuiAccountWorkflowsState,
  type WebuiAccountWorkflows,
  type WebuiAccountWorkflowsState,
} from "../application/account-workflows.js";
import {
  initialWebuiSettingsWorkflowsState,
  type WebuiSettingsWorkflows,
  type WebuiSettingsWorkflowsState,
} from "../application/settings-workflows.js";
import {
  initialWebuiPluginWorkflowsState,
  type WebuiPluginWorkflows,
  type WebuiPluginWorkflowsState,
} from "../application/plugin-workflows.js";
import {
  initialWebuiArchivedSessionsState,
  type WebuiArchivedSessionsState,
  type WebuiSessionWorkflows,
} from "../application/session-workflows.js";

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

// ---------------------------------------------------------------------------
// Account, settings and plugin owners (ticket #52)
//
// Same shape as the workspace queries above: one provider, one imperative hook
// for commands, one subscription hook for the snapshot. A component with no
// provider reads the initial snapshot and submits no-ops, which is what an SSR
// render or a unit test that mounts a panel without the runtime should get.
// ---------------------------------------------------------------------------

const WebuiAccountWorkflowsContext = createContext<WebuiAccountWorkflows | undefined>(
  undefined,
);

export function WebuiAccountWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiAccountWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiAccountWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiAccountWorkflowsContext.Provider>
  );
}

export function useWebuiAccountWorkflows(): WebuiAccountWorkflows | undefined {
  return useContext(WebuiAccountWorkflowsContext);
}

export function useWebuiAccountWorkflowsState(): WebuiAccountWorkflowsState {
  const workflows = useContext(WebuiAccountWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : accountInitialSnapshot,
    workflows ? workflows.getSnapshot : accountInitialSnapshot,
  );
}

function accountInitialSnapshot(): WebuiAccountWorkflowsState {
  return initialWebuiAccountWorkflowsState;
}

const WebuiSettingsWorkflowsContext = createContext<WebuiSettingsWorkflows | undefined>(
  undefined,
);

export function WebuiSettingsWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiSettingsWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiSettingsWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiSettingsWorkflowsContext.Provider>
  );
}

export function useWebuiSettingsWorkflows(): WebuiSettingsWorkflows | undefined {
  return useContext(WebuiSettingsWorkflowsContext);
}

export function useWebuiSettingsWorkflowsState(): WebuiSettingsWorkflowsState {
  const workflows = useContext(WebuiSettingsWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : settingsInitialSnapshot,
    workflows ? workflows.getSnapshot : settingsInitialSnapshot,
  );
}

function settingsInitialSnapshot(): WebuiSettingsWorkflowsState {
  return initialWebuiSettingsWorkflowsState;
}

const WebuiPluginWorkflowsContext = createContext<WebuiPluginWorkflows | undefined>(
  undefined,
);

export function WebuiPluginWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiPluginWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiPluginWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiPluginWorkflowsContext.Provider>
  );
}

export function useWebuiPluginWorkflows(): WebuiPluginWorkflows | undefined {
  return useContext(WebuiPluginWorkflowsContext);
}

export function useWebuiPluginWorkflowsState(): WebuiPluginWorkflowsState {
  const workflows = useContext(WebuiPluginWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : pluginInitialSnapshot,
    workflows ? workflows.getSnapshot : pluginInitialSnapshot,
  );
}

function pluginInitialSnapshot(): WebuiPluginWorkflowsState {
  return initialWebuiPluginWorkflowsState;
}

// ---------------------------------------------------------------------------
// The session workflows (ticket #52)
//
// Provided so the settings dialog can read the archived-sessions query — a
// session query that lives inside a settings surface — without holding a
// transport call of its own.
// ---------------------------------------------------------------------------

const WebuiSessionWorkflowsContext = createContext<WebuiSessionWorkflows | undefined>(
  undefined,
);

export function WebuiSessionWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiSessionWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiSessionWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiSessionWorkflowsContext.Provider>
  );
}

export function useWebuiSessionWorkflows(): WebuiSessionWorkflows | undefined {
  return useContext(WebuiSessionWorkflowsContext);
}

export function useWebuiArchivedSessionsState(): WebuiArchivedSessionsState {
  const workflows = useContext(WebuiSessionWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribeArchived : noopSubscribe,
    workflows ? workflows.getArchivedSnapshot : archivedInitialSnapshot,
    workflows ? workflows.getArchivedSnapshot : archivedInitialSnapshot,
  );
}

function archivedInitialSnapshot(): WebuiArchivedSessionsState {
  return initialWebuiArchivedSessionsState;
}
