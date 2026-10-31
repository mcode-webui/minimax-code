// React subscription to the application query owners.
//
// The workspace query owner lives in `features/workspace/application/workspace-queries.ts`
// and is created once by the composition root. This binding is the only React
// edge to it: components read its snapshot and submit query commands, and they
// never receive a transport method or a store writer for these queries.
//
// The context is deliberately non-throwing: an SSR render or a unit test that
// mounts a panel without the provider reads the initial snapshot and submits
// no-ops, which is the correct behaviour with no runtime attached.

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  initialWebuiWorkspaceQueriesState,
  type WebuiWorkspaceComposedPanel,
  type WebuiWorkspaceQueries,
  type WebuiWorkspaceArchiveCommands,
  type WebuiWorkspaceCanvasCommands,
  type WebuiWorkspaceEnvironmentCommands,
  type WebuiWorkspaceFilesCommands,
  type WebuiWorkspaceReviewCommands,
  type WebuiWorkspaceQueriesState,
} from "../features/workspace/application/workspace-queries.js";
import {
  initialWebuiSettingsWorkflowsState,
  type WebuiSettingsWorkflows,
  type WebuiSettingsWorkflowsState,
} from "../features/settings/application/settings-workflows.js";
import {
  initialWebuiModelsWorkflowsState,
  type WebuiModelsWorkflows,
  type WebuiModelsWorkflowsState,
} from "../features/models/application/models-workflows.js";
import {
  initialWebuiPluginWorkflowsState,
  type WebuiPluginWorkflows,
  type WebuiPluginWorkflowsState,
} from "../features/plugins/application/plugin-workflows.js";
import {
  initialWebuiArchivedSessionsState,
  type WebuiArchivedSessionsState,
  type WebuiSessionWorkflows,
} from "../features/sessions/application/session-workflows.js";

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

/**
 * One resource's commands, or `undefined` with no provider.
 *
 * The selector is the point: a consumer asks for the resource it renders and
 * gets a contract that cannot name another resource's capabilities. The
 * composition root is still provided — the panel needs all five, and the tree
 * needs one snapshot — but nothing reaches for the whole thing by accident.
 */
function useWebuiWorkspaceResource<
  K extends "files" | "environment" | "review" | "archive" | "canvas",
>(
  key: K,
): WebuiWorkspaceQueries[K] | undefined {
  const queries = useContext(WebuiWorkspaceQueriesContext);
  return queries?.[key];
}

/** The file tree and the file slots opened from it. */
export function useWebuiWorkspaceFiles():
  | WebuiWorkspaceFilesCommands
  | undefined {
  return useWebuiWorkspaceResource("files");
}

/** The git working tree. */
export function useWebuiWorkspaceEnvironment():
  | WebuiWorkspaceEnvironmentCommands
  | undefined {
  return useWebuiWorkspaceResource("environment");
}

/** The diff surface. */
export function useWebuiWorkspaceReview():
  | WebuiWorkspaceReviewCommands
  | undefined {
  return useWebuiWorkspaceResource("review");
}

/** Reading and extracting an archive. */
export function useWebuiWorkspaceArchive():
  | WebuiWorkspaceArchiveCommands
  | undefined {
  return useWebuiWorkspaceResource("archive");
}

/** The session's canvas document. */
export function useWebuiWorkspaceCanvas():
  | WebuiWorkspaceCanvasCommands
  | undefined {
  return useWebuiWorkspaceResource("canvas");
}

/**
 * The panel's composed surface: every resource, because the panel combines them.
 *
 * Merging is memoized on the context value, and that is load-bearing rather than
 * an optimisation. The panel puts this object in effect dependency lists — the
 * environment read re-runs when `queries` changes — and a merge that rebuilt a
 * fresh object on every render would make that effect depend on itself: the
 * effect calls `loadEnvironment`, the owner publishes, the snapshot subscriber
 * re-renders, the merge produces a new object, and the effect runs again until
 * React gives up with `Maximum update depth exceeded`. The failure is not
 * confined to the panel: the root error boundary catches it and the whole
 * application is replaced by the recovery copy, so every screen goes blank.
 *
 * The sibling hooks above avoid this without memoizing, because each returns an
 * object the context already owns and can therefore hand out with a stable
 * identity. Only this one merges, so only this one has to hold the identity.
 */
export function useWebuiWorkspacePanelSurface(): WebuiWorkspaceComposedPanel | undefined {
  const queries = useContext(WebuiWorkspaceQueriesContext);
  return useMemo(() => {
    if (!queries) return undefined;
    return {
      ...queries.files,
      ...queries.environment,
      ...queries.review,
      ...queries.archive,
      ...queries.canvas,
      panel: queries.panel,
    };
  }, [queries]);
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
// Account, settings and plugin owners
//
// Same shape as the workspace queries above: one provider, one imperative hook
// for commands, one subscription hook for the snapshot. A component with no
// provider reads the initial snapshot and submits no-ops, which is what an SSR
// render or a unit test that mounts a panel without the runtime should get.
// ---------------------------------------------------------------------------

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

// `models` is its own owner: the catalogue, the selection and the
// provider list have their own snapshot and their own commands, so a surface
// that only needs models does not subscribe to the settings snapshot.
type WebuiModelsWorkflowsConsumer = Omit<WebuiModelsWorkflows, "dispose" | "releaseSession">;
const WebuiModelsWorkflowsContext = createContext<WebuiModelsWorkflowsConsumer | undefined>(
  undefined,
);

export function WebuiModelsWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiModelsWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiModelsWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiModelsWorkflowsContext.Provider>
  );
}

export function useWebuiModelsWorkflows(): WebuiModelsWorkflowsConsumer | undefined {
  return useContext(WebuiModelsWorkflowsContext);
}

export function useWebuiModelsWorkflowsState(): WebuiModelsWorkflowsState {
  const workflows = useContext(WebuiModelsWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : modelsInitialSnapshot,
    workflows ? workflows.getSnapshot : modelsInitialSnapshot,
  );
}

function modelsInitialSnapshot(): WebuiModelsWorkflowsState {
  return initialWebuiModelsWorkflowsState;
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
// The session workflows
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
