// WebuiClientFoundationApp — the WebUI shell: rail, main column, session
// transcript, composer, workspace panels. This is the React entrypoint
// `main.tsx` mounts.
//
// W3 tier 5 lift: this component (plus `useSelectedSessionId`,
// `subscribeToSessionHash`, `WebuiClientFoundationAppProps`) was moved
// verbatim out of `app.tsx`. The body is byte-identical to what used to
// live there; the lift is move-only. `app.tsx` keeps a thin re-export
// block so existing consumers (`webui-transcript-widgets-integration.test.ts`,
// `main.tsx`'s default-import) keep their current import path during the
// W3 wave.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { ArchonShell } from "./ArchonShell.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../projection/composer-history.js";
import { Composer } from "./Composer.js";
import { GreetingSkeleton } from "./TranscriptSkeletons.js";
import {
  LeftRail,
  readProjectNames,
  readProjectPins,
  readSessionOverlay,
  toggleProjectPin,
  toggleSessionOverlay,
  writeProjectName,
} from "./LeftRail.js";
import { Transcript } from "./Transcript.js";
import { UserMenu } from "./UserMenu.js";
import { MEMORY_HANDOFF_PROMPT, type MemoryHandoff } from "./settings/PersonalizationSettings.js";
import {
  WebuiWorkspacePanel,
  WebuiProgressOverviewPanel,
  WebuiWorkspacePanelControls,
} from "./WorkspacePanels.js";
import {
  getWorkspacePanelSessionState,
  initialWorkspacePanelSessionState,
  reduceWorkspacePanelSessionState,
  setWorkspaceSessionProgressPanelOpen,
  type WorkspacePanelCommand,
  type WorkspacePanelSessionStates,
} from "../projection/workspace-panel-state.js";
import {
  initialWebuiShellSurface,
  isPluginManagementSurface,
  reduceWebuiShellSurface,
  webuiPluginManagementArea,
  type WebuiPluginManagementArea,
  type WebuiShellSurfaceCommand,
} from "../projection/shell-surface.js";
import { ConversationUsageBanner } from "./ConversationUsageBanner.js";
import { PluginManagement } from "./PluginManagement.js";
import { WebuiComposer } from "./SessionComposer.js";
import { WebuiSessionTranscript } from "./SessionTranscript.js";
import {
  WebuiProjectList,
  filterWebuiSessionsByQuery,
  sessionHash,
  sessionLabel,
} from "./SessionRail.js";
import { RailRow } from "./RailRow.js";
import {
  WebuiIconBrand,
  WebuiIconContextExport,
  WebuiIconNewTask,
  WebuiIconPlugins,
  WebuiIconRemote,
  WebuiIconSearch,
  WebuiIconSidebarToggle,
  WebuiIconSites,
} from "../icons.js";
import type { WebuiClientSession, WebuiClientSessionPage, WebuiClientProject } from "../contracts/session-view.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type { WebuiTodo } from "./WorkspacePanels.js";
import type { WebuiUsageQuotaResult } from "../../shared/contracts/usage-quota.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type {
  WebuiWorkspaceProgressState,
  WebuiWorkspaceSubagent,
} from "../projection/workspace-progress.js";
import type { WebuiProjectGroup } from "./SessionRail.js";
import { createWebuiCommandWorkflows } from "../application/command-workflows.js";
import { createWebuiComposerStore } from "../application/composer-store.js";
import {
  createWebuiSessionStore,
  type WebuiSessionStore,
} from "../application/session-store.js";
import {
  createWebuiSessionCatalogFromPage,
  selectWebuiCatalogFlatPage,
  selectWebuiCatalogTreePage,
} from "../application/session-catalog.js";
import { createWebuiSessionWorkflows } from "../application/session-workflows.js";
import { selectWebuiSessionStream } from "../application/selectors.js";
import { WEBUI_HOME_SESSION_KEY } from "../application/state.js";
import { createWebuiEventEffectsRegistry } from "../application/event-effects-registry.js";
import { WebuiSessionStoreProvider } from "../bindings/application-context.js";
import { WebuiEventEffectsRegistryProvider } from "../bindings/event-effects-context.js";
import {
  WebuiAccountWorkflowsProvider,
  WebuiPluginWorkflowsProvider,
  WebuiSessionWorkflowsProvider,
  WebuiSettingsWorkflowsProvider,
  WebuiWorkspaceQueriesProvider,
} from "../bindings/use-query-state.js";
import { createWebuiWorkspaceQueries } from "../application/workspace-queries.js";
import { createWebuiAccountWorkflows } from "../application/account-workflows.js";
import { createWebuiSettingsWorkflows } from "../application/settings-workflows.js";
import { createWebuiPluginWorkflows } from "../application/plugin-workflows.js";
import { webuiActiveTurnProbeFor } from "../application/active-turn-probe.js";
import {
  readWebuiUnreadCounts,
  writeWebuiUnreadCounts,
  createWebuiBrowserStorage,
} from "../infrastructure/storage.js";
import { startWebuiSessionTransferDownload } from "../infrastructure/session-transfer-download.js";
import { importWebuiSessionFile } from "../infrastructure/session-import.js";
import type { TeamModeSessionChoices } from "../team-mode.js";
import {
  initialWebuiWorkspaceProgress,
  projectWebuiWorkspaceHistory,
  selectWebuiWorkspaceProgress,
  webuiWorkspaceSubagentStatus,
} from "../projection/workspace-progress.js";
import { createWebuiApplication, type WebuiApplication } from "../application/create-application.js";
import type { WebuiEventEffects } from "../application/event-coordinator.js";
import { createWebuiOpenEventChannel } from "../bindings/event-channel-adapter.js";
import type { WebuiWorkspaceGitChangedSignal } from "../projection/workspace-panel-state.js";
import { ConnectionStatus } from "../ConnectionStatus.js";
import { deriveConversationUsageNotice } from "../projection/message-projection.js";
import { deriveRecentWorkspaceDirs } from "../projection/composer-state.js";
import { normalizeFavoriteModelIds } from "../projection/model-favorites.js";

// The hash plumbing moved to `client/bindings/navigation.ts` (plan §7.2). Both
// symbols stay re-exported here: `main.tsx` re-exports `subscribeToSessionHash`
// from this module, and the SSR snapshot reads `readSessionIdFromHash` through it.
import {
  readSessionIdFromHash,
  subscribeToSessionHash,
} from "../bindings/navigation.js";
export { readSessionIdFromHash, subscribeToSessionHash };

export interface WebuiClientFoundationAppProps {
  // Non-method props (seed / UI / SSR). The 78 method props that used to
  // live here are now bundled into `transport` (see contracts.ts →
  // `WebuiTransport`). Optional semantics preserved: `transport.X` is
  // `undefined` exactly when the underlying operation is not wired.
  readonly label: string;
  readonly version?: WebuiVersionInfo;
  readonly sessionPage?: WebuiClientSessionPage;
  /** Seed for the transcript so SSR / first paint can render messages before
   * `loadMessages` resolves; production always re-fetches in the background
   * so the prop only changes the initial paint, not the source of truth. */
  readonly initialMessages?: import("../contracts/message-view.js").WebuiClientMessagePage;
  /** Seed for the conversation usage banner so SSR / first paint can render
   * it before `getUsageQuota` resolves; production always re-fetches in the
   * background so the prop only changes the initial paint, not the source
   * of truth.
   */
  readonly initialUsageQuota?: WebuiUsageQuotaResult;
  readonly locationHash?: string;
  readonly dataDir?: string;
  /**
   * What the identity row shows under the product name. The desktop puts the signed-in
   * account's plan there; the WebUI is loopback-only and has no account, so it reports
   * the scope it actually runs in. `main.tsx` passes the page's host.
   */
  readonly hostLabel?: string;
  /**
   * W2.5 transport object — the single bag of methods the foundation app
   * consumes. `main.tsx` constructs it ONCE at module scope so the React
   * effect dependency identity is stable across renders. Passing a fresh
   * object every render would re-subscribe the watcher / fetcher effects
   * on every keystroke. Optional fields stay optional: `transport.X`
   * is `undefined` iff the operation is not wired.
   */
  readonly transport?: WebuiTransport;
  /**
   * The one application session store. Optional so tests and SSR can inject a
   * pre-seeded instance; production (`main.tsx`) omits it and the shell creates
   * and provides exactly one per mount. It is never a second map — the shell
   * provides this exact object through `WebuiSessionStoreProvider`, and every
   * consumer reads it through the bindings (plan §7.6; ticket #45).
   */
  readonly sessionStore?: WebuiSessionStore;
}

function useSelectedSessionId(
  locationHash?: string,
): [string | undefined, (id: string | undefined) => void] {
  const read = () =>
    readSessionIdFromHash(
      locationHash ??
        (typeof window === "undefined" ? "" : window.location.hash),
    );
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    if (locationHash !== undefined || typeof window === "undefined") return;
    return subscribeToSessionHash((id) => setSelected(id));
  }, [locationHash]);
  return [selected, setSelected];
}

export function WebuiClientFoundationApp(
  props: WebuiClientFoundationAppProps,
): ReactElement {
  const {
    label,
    sessionPage,
    initialMessages,
    initialUsageQuota,
    version,
    locationHash,
    dataDir,
    hostLabel,
    transport,
    sessionStore: providedSessionStore,
  } = props;
  // The one application session store for this mount (plan §7.6; ticket #45).
  // A caller (tests, SSR) may inject one; production omits the prop and the
  // shell creates exactly one. The shell provides this exact object through
  // `WebuiSessionStoreProvider` and reads its own slices off it — never a
  // second, module-level map.
  // The seed page is read once (it never changes for a mount): seeding the
  // catalog from it is how SSR/first paint and the tests start with entities
  // already present, without a second map.
  const seedSessionPageRef = useRef(sessionPage);
  const sessionStore = useMemo(
    () =>
      providedSessionStore ??
      createWebuiSessionStore(
        seedSessionPageRef.current
          ? { catalog: createWebuiSessionCatalogFromPage(seedSessionPageRef.current) }
          : undefined,
      ),
    [providedSessionStore],
  );
  // The one per-session effects registry for this mount (plan §7.1
  // `application/event-coordinator.ts`; ticket #45). The shell holds it and
  // provides it; the composer registers its session's effect handlers here and
  // `asWebuiEventEffects()` is what the application coordinator consumes over
  // the single process-event channel.
  const eventEffectsRegistry = useMemo(
    () => createWebuiEventEffectsRegistry(),
    [],
  );
  // Each method comes from `transport`. Re-binding to the same local
  // name as before keeps the rest of the function body identical.
  // Local rebinds: each name below is consumed by a shell-side effect or
  // handler below this declaration, so it is a real local capability, not
  // a pure conduit. Everything else that used to be rebound here is now
  // read directly off `transport` at the JSX consumption point — see the
  // 67-rebind classification table in the revision report.
  const loadMessages = transport?.loadMessages;
  const getUsageQuota = transport?.getUsageQuota;
  const getVersion = transport?.version;
  const getSessionForkOptions = transport?.getSessionForkOptions;
  const forkSession = transport?.forkSession;

  const [runtimeVersion, setRuntimeVersion] = useState(version);
  useEffect(() => { if (!runtimeVersion && getVersion) void getVersion().then(setRuntimeVersion); }, [getVersion, runtimeVersion]);
  // The one session catalog (plan §7.6 "Flat/tree queries"; ticket #49). The
  // shell subscribes to the store's catalog slice and resolves the flat and
  // tree pages from it; both views share one entity map, so a rename patches
  // one structure and neither view can drift from the other.
  const catalog = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getSnapshot().catalog,
    () => sessionStore.getSnapshot().catalog,
  );
  const page = useMemo(() => selectWebuiCatalogFlatPage(catalog), [catalog]);
  const treePage = useMemo(
    () => selectWebuiCatalogTreePage(catalog),
    [catalog],
  );
  const loading = catalog.flat.loading;
  // The session workflows: the loads and mutations the shell used to call
  // through `transport` and then patch onto two structures by hand. The shell
  // submits a workflow and holds no transport call for session entities.
  const sessionWorkflows = useMemo(
    () =>
      createWebuiSessionWorkflows({
        store: sessionStore,
        port: transport ?? {},
        importSession: importWebuiSessionFile,
      }),
    [sessionStore, transport],
  );
  const [projectRecords, setProjectRecords] = useState<readonly WebuiClientProject[] | undefined>();
  useEffect(() => {
    // The project list is a session business request, so it goes through the
    // workflow rather than the transport from the shell.
    if (!sessionWorkflows.canLoadProjects) return;
    let cancelled = false;
    void sessionWorkflows.loadProjects().then((projects) => {
      if (!cancelled) setProjectRecords(projects);
    }).catch(() => {
      // Keep the session-derived view available when a runtime predates the
      // project-list operation.
    });
    return () => { cancelled = true; };
  }, [sessionWorkflows]);
  // The slash-command runner the composer submits through (ticket #49
  // criterion 8): the component holds no transport call, it calls the workflow.
  const commandWorkflows = useMemo(
    () => createWebuiCommandWorkflows({ port: transport ?? {} }),
    [transport],
  );
  // The one workspace query owner (ticket #51): it caches the workspace file
  // tree, file contents, the working-tree review and the git environment, and
  // discards a late response from a superseded request. Provided to the two
  // workspace panels, which submit query commands and read its snapshot.
  const workspaceQueries = useMemo(
    () => createWebuiWorkspaceQueries({ port: transport ?? {} }),
    [transport],
  );
  // The account, settings and plugin owners (ticket #52). One of each per
  // mount, provided to the user menu, the settings dialog and the plugin
  // manager; those components submit commands and read the snapshot instead of
  // holding their own copies of the answers.
  const accountWorkflows = useMemo(
    () => createWebuiAccountWorkflows({ port: transport ?? {} }),
    [transport],
  );
  const settingsWorkflows = useMemo(
    () => createWebuiSettingsWorkflows({ port: transport ?? {} }),
    [transport],
  );
  const pluginWorkflows = useMemo(
    () => createWebuiPluginWorkflows({ port: transport ?? {} }),
    [transport],
  );
  // Which surface the main column renders. Plugin management replaces the
  // conversation rather than floating above it, so the rail stays the only way
  // back out of it — every conversation navigation has to return here.
  const [shellSurface, setShellSurface] = useState(initialWebuiShellSurface);
  const dispatchShellSurface = useCallback((command: WebuiShellSurfaceCommand) => {
    setShellSurface((current) => reduceWebuiShellSurface(current, command));
  }, []);
  const browserStorage = useMemo(() => createWebuiBrowserStorage(), []);
  const favoriteStorage = useMemo(
    () => ({
      read: () => browserStorage.readFavoriteModels(normalizeFavoriteModelIds),
      write: (ids: readonly string[]) => browserStorage.writeFavoriteModels(ids, normalizeFavoriteModelIds),
    }),
    [browserStorage],
  );
  const [selectedSessionId, setSelectedSessionId] =
    useSelectedSessionId(locationHash);
  // Rail session links are plain `#session=<id>` anchors, so the navigation runs
  // through the hash subscription inside `useSelectedSessionId` rather than
  // through the setter this shell holds. Watching the resolved id is the one
  // place both paths pass through, which is what makes the rail click actually
  // leave the marketplace instead of changing the selection behind it. The
  // reducer returns the same object when the conversation is already showing,
  // so this costs no re-render on the way in.
  useEffect(() => {
    dispatchShellSurface({ type: "show-conversation" });
  }, [dispatchShellSurface, selectedSessionId]);
  // Composer input history + per-session drafts (roadmap Module B:
  // 输入历史/草稿). The one owner is the application composer store, created
  // once here and handed to the application; the shell subscribes and submits
  // named changes (ticket #49 criterion 5). One persisted store keyed by
  // session (home has its own slot), so a draft survives both a session switch
  // and a reload, and ↑ recalls that session's submitted inputs.
  const composerStore = useMemo(
    () => createWebuiComposerStore({ storage: browserStorage }),
    [browserStorage],
  );
  const composerState = useSyncExternalStore(
    composerStore.subscribe,
    composerStore.getSnapshot,
    composerStore.getSnapshot,
  );
  const composerKey = selectedSessionId ?? WEBUI_COMPOSER_HOME_KEY;
  const composerKeyRef = useRef(composerKey);
  composerKeyRef.current = composerKey;
  const draft = composerState.drafts[composerKey] ?? "";
  const setDraft = useCallback(
    (next: string) => {
      composerStore.setDraft(composerKeyRef.current, next);
    },
    [composerStore],
  );
  // Recording rides the same store: a committed submission lands in the
  // current slot's history (home while no session exists yet; adoption moves it
  // onto the created session in one transition below).
  const recordComposerInput = useCallback(
    (text: string) => {
      composerStore.recordInput(composerKeyRef.current, text);
    },
    [composerStore],
  );
  const [teamModeOff, setTeamModeOff] = useState(browserStorage.readTeamModeOff);
  const [teamModeChoices, setTeamModeChoices] =
    useState<TeamModeSessionChoices>(browserStorage.readTeamModeSessionChoices);
  const pageError = catalog.flat.error;
  const setPageError = sessionWorkflows.setError;
  const [usageQuota, setUsageQuota] = useState<WebuiUsageQuotaResult | undefined>(
    () => initialUsageQuota,
  );
  const [dismissedUsageNoticeKey, setDismissedUsageNoticeKey] = useState<
    string | undefined
  >();
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, boolean>>(
    readSessionOverlay("pins"),
  );
  const [starredSessions, setStarredSessions] = useState<Record<string, boolean>>(
    readSessionOverlay("stars"),
  );
  const [pinnedProjects, setPinnedProjects] = useState<Record<string, boolean>>(
    readProjectPins,
  );
  const [projectNames, setProjectNames] = useState<Record<string, string>>(
    readProjectNames,
  );
  // The selected session's live stream slice, read off the application store
  // through the selector (plan §7.6; ticket #45 prerequisite 5). Subscribing to
  // the store's snapshot keeps the shell reactive exactly as the old module
  // hook did, with no second map.
  const selectedStream = useSyncExternalStore(
    sessionStore.subscribe,
    () =>
      selectWebuiSessionStream(
        sessionStore.getSnapshot(),
        selectedSessionId ?? WEBUI_HOME_SESSION_KEY,
      ),
    () =>
      selectWebuiSessionStream(
        sessionStore.getSnapshot(),
        selectedSessionId ?? WEBUI_HOME_SESSION_KEY,
      ),
  );
  const [historyProgress, setHistoryProgress] =
    useState<WebuiWorkspaceProgressState>(initialWebuiWorkspaceProgress);
  // Sessions visible to lookups: roots from the flat page plus any child
  // sessions surfaced through the tree projection. Without the tree the
  // flat list is the only source, matching the original behaviour.
  const flatSessionsWithChildren = useMemo(() => {
    if (treePage.sessions.length === 0) return page.sessions;
    const seen = new Set(page.sessions.map((session) => session.sessionId));
    const extras: WebuiClientSession[] = [];
    for (const node of treePage.sessions) {
      for (const child of node.childSessions) {
        if (!seen.has(child.sessionId)) {
          seen.add(child.sessionId);
          extras.push(child);
        }
      }
    }
    return [...page.sessions, ...extras];
  }, [page.sessions, treePage.sessions]);
  const selectedAgentName =
    flatSessionsWithChildren.find((session) => session.sessionId === selectedSessionId)
      ?.agentName ?? "main";
  useEffect(() => {
    if (!selectedSessionId || !loadMessages) {
      setHistoryProgress(initialWebuiWorkspaceProgress);
      return;
    }
    let cancelled = false;
    void loadMessages({ id: selectedSessionId }).then((result) => {
      if (!cancelled)
        setHistoryProgress(
          projectWebuiWorkspaceHistory(
            (result.messages ?? []) as unknown as readonly import("../contracts/message-view.js").WebuiClientMessage[],
            selectedSessionId,
          ),
        );
    }).catch(() => { if (!cancelled) setHistoryProgress(initialWebuiWorkspaceProgress); });
    return () => { cancelled = true; };
  }, [loadMessages, selectedSessionId]);
  useEffect(() => {
    browserStorage.writeTeamModeOff(teamModeOff);
  }, [browserStorage, teamModeOff]);
  useEffect(() => {
    if (!sessionWorkflows.canLoadFlat || sessionPage) return;
    void sessionWorkflows.loadFlat();
  }, [sessionWorkflows, sessionPage]);
  // Tree projection (root + children) for the rail. Loaded in parallel with
  // the flat session list — the flat list still drives selected-session
  // lookups so the home workspace auto-fill keeps working, but the rail
  // prefers this shape so sub-agent sessions under a root are visible.
  useEffect(() => {
    if (!sessionWorkflows.canLoadTree || sessionPage) return;
    void sessionWorkflows.loadTree();
  }, [sessionWorkflows, sessionPage]);
  // Cloud usage quota for the conversation banner. The runtime exposes
  // getUsageQuota when a bearer lease is available; we only fetch once per
  // session switch so the banner reflects the user's current state without
  // re-fetching on every render.
  useEffect(() => {
    if (!getUsageQuota) {
      setUsageQuota(undefined);
      return undefined;
    }
    let cancelled = false;
    void getUsageQuota()
      .then((next) => {
        if (!cancelled) setUsageQuota(next);
      })
      .catch(() => {
        if (!cancelled) setUsageQuota(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [getUsageQuota]);
  const treeSubagents = useMemo<readonly WebuiWorkspaceSubagent[]>(() => {
    const node = treePage.sessions.find(
      (candidate) => candidate.session.sessionId === selectedSessionId,
    );
    return (node?.childSessions ?? []).map((child) => ({
      sessionId: child.sessionId,
      agentName: child.agentName,
      ...(child.title ? { title: child.title } : {}),
      status: webuiWorkspaceSubagentStatus(child.status),
      ...(child.createdAt ? { createdAt: child.createdAt } : {}),
      ...(child.updatedAt ? { updatedAt: child.updatedAt } : {}),
      parentSessionId: selectedSessionId,
    }));
  }, [selectedSessionId, treePage.sessions]);
  // One pure derivation over the three labelled progress inputs (plan §7.6
  // "Progress"; ticket #49 correction 3). The shell no longer merges by hand —
  // the precedence, including the snapshot-gated todo choice, lives in the
  // domain selector.
  const progress = useMemo(
    () =>
      selectWebuiWorkspaceProgress({
        history: historyProgress,
        treeSubagents,
        live: selectedStream.workspaceProgress,
      }),
    [historyProgress, treeSubagents, selectedStream.workspaceProgress],
  );
  const progressTodos: readonly WebuiTodo[] = progress.todos;
  const progressSubagents: readonly WebuiWorkspaceSubagent[] = progress.subagents;
  const loadMore =
    sessionWorkflows.canLoadFlat && page.hasMore
      ? () => {
          void sessionWorkflows.loadMore(page.nextCursor);
        }
      : undefined;
  const refreshRail = async () => {
    await sessionWorkflows.refresh();
  };
  const handleRenameProject = (project: WebuiProjectGroup) => {
    if (typeof window === "undefined") return;
    const next = window.prompt("重命名项目", projectNames[project.key] ?? project.name)?.trim();
    if (next) setProjectNames(writeProjectName(project.key, next));
  };
  const handleToggleProjectPin = (project: WebuiProjectGroup) => {
    setPinnedProjects(toggleProjectPin(project.key));
  };
  const handleRenameSession = (session: WebuiClientSession) => {
    if (!sessionWorkflows.canMutate || typeof window === "undefined") return;
    const next = window.prompt("重命名", sessionLabel(session))?.trim();
    if (!next || next === sessionLabel(session)) return;
    void sessionWorkflows
      .rename(session.sessionId, next)
      .then(() => refreshRail())
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleToggleSessionPin = (session: WebuiClientSession) => {
    setPinnedSessions(toggleSessionOverlay("pins", session.sessionId));
  };
  const handleToggleSessionStar = (session: WebuiClientSession) => {
    setStarredSessions(toggleSessionOverlay("stars", session.sessionId));
  };
  const handleArchiveSession = (session: WebuiClientSession) => {
    void sessionWorkflows
      .archive(session.sessionId)
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleArchiveProject = (project: WebuiProjectGroup) => {
    const ids = new Set(project.sessionIds);
    for (const node of treePage.sessions) {
      if (!project.sessionIds.includes(node.session.sessionId)) continue;
      for (const child of node.childSessions) ids.add(child.sessionId);
    }
    void sessionWorkflows
      .archiveMany([...ids])
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleForkSession = (session: WebuiClientSession, createIsolatedWorktree: boolean) => {
    if (!sessionWorkflows.canFork) return;
    void sessionWorkflows
      .fork(session.sessionId, createIsolatedWorktree)
      .then((forked) => {
        const id = forked?.sessionId;
        if (id) {
          setSelectedSessionId(id);
          if (typeof window !== "undefined")
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${sessionHash(id)}`);
        }
      })
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleCopySession = (session: WebuiClientSession, value: "workspaceDir" | "sessionId") => {
    const text = value === "workspaceDir" ? session.workspaceDir : session.sessionId;
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text);
  };
  const handleExportSession = (session: WebuiClientSession) => {
    // The file comes from `GET /session-transfer`, not from walking the
    // message pages here: that route is the one `POST /session-import` accepts,
    // and a browser-assembled file carries the display layer only. See
    // `session-transfer-download.ts` for why this is a navigation.
    try {
      startWebuiSessionTransferDownload(session.sessionId);
    } catch (reason: unknown) {
      setPageError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const handleSessionImportPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset first: picking the same file twice has to fire `change` again, and
    // the element keeps its value otherwise.
    event.target.value = "";
    if (!file) return;
    setSessionImportBusy(true);
    void (async () => {
      try {
        const result = await sessionWorkflows.importSession(file, {
          // The caller's context, never the file's session block: a downloaded
          // file must not be able to name the working directory.
          agentName: "main",
          workspaceDir: selectedSession?.workspaceDir,
        });
        await refreshRail();
        setSelectedSessionId(result.sessionId);
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}${sessionHash(result.sessionId)}`,
          );
        }
      } catch (reason: unknown) {
        setPageError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSessionImportBusy(false);
      }
    })();
  };
  const handleDeleteSession = (session: WebuiClientSession) => {
    void sessionWorkflows
      .remove(session.sessionId)
      .then(() => {
        if (selectedSessionId === session.sessionId) {
          setSelectedSessionId(undefined);
          if (typeof window !== "undefined") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
      })
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const homeMode = !selectedSessionId;
  const usageNotice = useMemo(
    () => deriveConversationUsageNotice(usageQuota),
    [usageQuota],
  );
  const usageNoticeKey = usageNotice
    ? `${usageNotice.kind}:${usageNotice.messageKey}:${usageNotice.resetAtMs ?? ""}`
    : undefined;
  const visibleUsageNotice =
    usageNoticeKey && usageNoticeKey === dismissedUsageNoticeKey
      ? null
      : usageNotice;
  // First-paint of the home page: the rail reads from the sessions list,
  // but the welcome hero appears regardless. Show the greeting skeleton
  // while the initial session page is still being fetched so the layout
  // doesn't flash an empty hero before the rail populates.
  const homeGreetingPending =
    homeMode && sessionWorkflows.canLoadFlat && page.sessions.length === 0 && loading;
  const selectedSession = flatSessionsWithChildren.find(
    (session) => session.sessionId === selectedSessionId,
  );
  const [newTaskWorkspaceDir, setNewTaskWorkspaceDir] = useState<string | undefined>(
    () => {
      // Honour an explicit "no project" choice from localStorage so the
      // auto-fill below doesn't immediately pull a workspace back.
      if (browserStorage.readNoProjectFlag()) return undefined;
      return (
        selectedSession?.workspaceDir ??
        flatSessionsWithChildren.find((session) => session.workspaceDir)?.workspaceDir
      );
    },
  );
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  // The `最近` group in the workspace picker. Derived from the sessions the
  // client already holds rather than a new operation — see
  // `deriveRecentWorkspaceDirs` for why there is nothing to call instead.
  const recentWorkspaceDirs = useMemo(
    () => deriveRecentWorkspaceDirs(flatSessionsWithChildren),
    [flatSessionsWithChildren],
  );
  // Tracks whether the user has explicitly cleared the workspace in *this*
  // session; the effect below checks both this and the persisted flag.
  const userClearedWorkspaceRef = useRef(browserStorage.readNoProjectFlag());
  useEffect(() => {
    if (userClearedWorkspaceRef.current) return;
    if (selectedSession?.workspaceDir) {
      setNewTaskWorkspaceDir(selectedSession.workspaceDir);
    } else if (!newTaskWorkspaceDir) {
      const workspaceDir = flatSessionsWithChildren.find(
        (session) => session.workspaceDir,
      )?.workspaceDir;
      if (workspaceDir) setNewTaskWorkspaceDir(workspaceDir);
    }
  }, [newTaskWorkspaceDir, flatSessionsWithChildren, selectedSession?.workspaceDir]);
  // Single workspace-change entry point the composer calls. It records the
  // user's intent (cleared vs picked) so the auto-fill effect above stops
  // fighting us, and folds the no-project flag into localStorage.
  const handleWorkspaceChange = useCallback(
    (workspaceDir?: string) => {
      if (workspaceDir === undefined) {
        userClearedWorkspaceRef.current = true;
        browserStorage.writeNoProjectFlag(true);
      } else {
        userClearedWorkspaceRef.current = false;
        browserStorage.writeNoProjectFlag(false);
      }
      setNewTaskWorkspaceDir(workspaceDir);
      setWorkspaceMenuOpen(false);
    },
    [],
  );
  const handleSessionCreated = (id: string) => {
    // Home→session adoption is one committed transition (ticket #49 criterion
    // 5): the application carries the home turn's live record onto the created
    // session, moves the composer's home slot onto it and selects it — no
    // separate migration + composer migration + selection.
    application.adoptHomeSession(id);
    setSelectedSessionId(id);
    browserStorage.writeTeamModeSessionChoice(id, teamModeOff);
    setTeamModeChoices((current) => ({ ...current, [id]: teamModeOff }));
    // Refresh the rail projection after the first message creates a session —
    // the flat list (its failure is reported) and the tree (best effort),
    // matching the shell's original two independent loads.
    if (sessionWorkflows.canLoadFlat) void sessionWorkflows.loadFlat();
    if (sessionWorkflows.canLoadTree) void sessionWorkflows.loadTree();
    if (typeof window !== "undefined")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${sessionHash(id)}`,
      );
  };
  const startNewTask = (workspaceDir?: string) => {
    // A project row's plus action opens a fresh home composer preselected to
    // that workspace; the global new-task action still clears the workspace.
    const clearedWorkspace = workspaceDir === undefined;
    userClearedWorkspaceRef.current = clearedWorkspace;
    browserStorage.writeNoProjectFlag(clearedWorkspace);
    setNewTaskWorkspaceDir(workspaceDir);
    setWorkspaceMenuOpen(false);
    setDraft("");
    // 「新建任务」 is the one navigation that does not change the selected
    // session when the shell is already on the home surface, so the effect that
    // watches the session id cannot see it. Close the marketplace here too, or
    // the row looks dead exactly as it did before.
    dispatchShellSurface({ type: "show-conversation" });
    setSelectedSessionId(undefined);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  };

  /**
   * 「在会话中创建」 on 记忆摘要: land on the home composer with the memory
   * file attached and one line already typed.
   *
   * The line is written from an effect rather than here, and the wait is not
   * ceremony. Drafts are stored per session, and `startNewTask` clears the
   * *old* session's slot before `selectedSessionId` changes — writing the
   * prompt inline would put it in whichever slot the shell still considered
   * current, so starting from a session would type it somewhere the user never
   * sees. Once no session is selected the key is the home slot, which is the
   * slot the desktop's screenshot is showing.
   */
  const [memoryHandoff, setMemoryHandoff] = useState<MemoryHandoff>();
  const createMemorySession = useCallback((input: MemoryHandoff) => {
    setMemoryHandoff(input);
    startNewTask();
  }, []);
  useEffect(() => {
    if (!memoryHandoff || selectedSessionId) return;
    setDraft(MEMORY_HANDOFF_PROMPT);
  }, [memoryHandoff, selectedSessionId, setDraft]);

  const handleWorkspaceSubagentClick = useCallback(
    (subagent: WebuiWorkspaceSubagent) => {
      setSelectedSessionId(subagent.sessionId);
      if (typeof window !== "undefined")
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${sessionHash(subagent.sessionId)}`,
        );
    },
    [],
  );
  const handleSelectComposerSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    if (typeof window !== "undefined")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${sessionHash(sessionId)}`,
      );
  }, []);
  const childSessions = selectedSessionId
    ? page.sessions.filter(
        (session) => session.parentSessionId === selectedSessionId,
      )
    : [];
  const composerTeamModeOff = selectedSessionId
    ? teamModeChoices[selectedSessionId] ?? teamModeOff
    : teamModeOff;
  const [railCollapsed, setRailCollapsed] = useState(false);
  // Rail session search. `railSearchOpen` mirrors whether the input is
  // showing; `railSearchQuery` is the live filter. The query filters only the
  // rail's rendered list — lookups such as the selected-session resolution and
  // the composer's session switcher keep reading the unfiltered page, so a
  // session selected before the search can still be resolved and reopened.
  const [railSearchOpen, setRailSearchOpen] = useState(false);
  const [railSearchQuery, setRailSearchQuery] = useState("");
  const railSearchInputRef = useRef<HTMLInputElement | null>(null);
  const sessionImportInputRef = useRef<HTMLInputElement | null>(null);
  const [sessionImportBusy, setSessionImportBusy] = useState(false);
  const openRailSearch = useCallback(() => {
    setRailSearchOpen(true);
    // The input mounts in the same commit as the state flip, so focus has to
    // wait a frame for the ref to resolve.
    requestAnimationFrame(() => railSearchInputRef.current?.focus());
  }, []);
  const closeRailSearch = useCallback(() => {
    setRailSearchOpen(false);
    setRailSearchQuery("");
  }, []);
  const railPage = useMemo(
    () =>
      railSearchQuery.trim()
        ? { ...page, sessions: filterWebuiSessionsByQuery(page.sessions, railSearchQuery) }
        : page,
    [page, railSearchQuery],
  );
  // Child sessions live on the tree page rather than the flat page, so the
  // query has to be applied there too or a match on a child would not show.
  // A node whose children are all filtered out is dropped, and a tree that
  // loses every node falls back to the flat list rather than rendering empty.
  const railTreePage = useMemo(() => {
    if (treePage.sessions.length === 0) return undefined;
    if (!railSearchQuery.trim()) return treePage;
    const nodes = treePage.sessions
      .map((node) => ({
        ...node,
        childSessions: filterWebuiSessionsByQuery(node.childSessions, railSearchQuery),
      }))
      .filter((node) => node.childSessions.length > 0);
    return nodes.length > 0 ? { ...treePage, sessions: nodes } : undefined;
  }, [treePage, railSearchQuery]);
  const pluginManagementArea = webuiPluginManagementArea(shellSurface);
  const pluginManagementOpen = isPluginManagementSurface(shellSurface);
  const openPluginManagement = useCallback((area: WebuiPluginManagementArea) => {
    dispatchShellSurface({ type: "open-plugin-management", area });
  }, [dispatchShellSurface]);
  const [workspacePanelStates, setWorkspacePanelStates] = useState<WorkspacePanelSessionStates>(() => new Map());
  // ---- Rail activity: which sessions are running, and when each last moved.
  //
  // The runtime runs sessions in parallel -- `queue.dispatcher.ts` keeps one
  // drain loop per session id, and a submitted turn is not tied to the socket
  // that submitted it -- so work keeps going after the user switches away.
  // Nothing showed that: every row looked the same whether its turn finished a
  // minute ago or never started.
  //
  // Three inputs, none sufficient alone. The list seeds first-paint times; the
  // global event stream keeps them current (it carries no session id, so one
  // subscription covers every row); and `getActiveTurn` repairs what the stream
  // never delivered.
  // The activity slice lives on a single application store, not in component
  // state (plan §7.6 "Unread"; ticket #45 prerequisite 3). The shell subscribes
  // to the slice; the application unread controller owns the writes and the
  // hydration ordering (ticket #49 criterion 4).
  const sessionActivity = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getSnapshot().activity,
    () => sessionStore.getSnapshot().activity,
  );
  const [activityNow, setActivityNow] = useState(() => Date.now());
  // Bumped on reconnect to re-probe: the events that would have told us a turn
  // started were missed while the stream was down, and the stream cannot
  // replay them. `SessionComposer` closes the same gap the same way.
  const [activityProbeNonce, setActivityProbeNonce] = useState(0);
  const watchEvents = transport?.watchEvents;
  const getActiveTurn = transport?.getActiveTurn;
  // One shared, deduplicated probe for the transport (plan §7.1 slice): the
  // rail and the composer ask the same `getActiveTurn`, so a same-session probe
  // racing between them collapses to one round trip.
  const activeTurnProbe = useMemo(
    () => webuiActiveTurnProbeFor(getActiveTurn),
    [getActiveTurn],
  );

  // The application instance is built from the live process-event ingress
  // (ticket #45, the atomic ingress flip). One call opens exactly one
  // `watchEvents` channel; the event coordinator is its sole consumer,
  // reducing each event into the retained activity slice and running the
  // session effects the composer registered. Components subscribe to
  // application snapshots and never open a channel of their own — the shell's
  // own subscription, the composer's and the two panels' are all gone.
  //
  // The open session is read through a ref rather than closing over it, so the
  // single subscription never tears down on a session switch: the events
  // arriving during a switch would otherwise belong to neither the old nor the
  // new closure, and a turn finishing while the user clicks through the rail
  // would be lost.
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;

  // The application-wide effects the coordinator runs. It composes the
  // per-session registry the composer registers into with the shell's own
  // reach: the channel-accepted signal re-probes the rail (a reconnect can miss
  // a `session.start`), and a workspace-git event invalidates the panel
  // git/review queries through the same coordinator.
  const [workspaceGitChanged, setWorkspaceGitChanged] =
    useState<WebuiWorkspaceGitChangedSignal>();
  const applicationEffects = useMemo<WebuiEventEffects>(
    () => ({
      ...eventEffectsRegistry.asWebuiEventEffects(),
      workspaceGitChanged: (payload) =>
        setWorkspaceGitChanged((previous) => ({
          revision: (previous?.revision ?? 0) + 1,
          ...payload,
        })),
      channelReady: () => {
        eventEffectsRegistry.asWebuiEventEffects().channelReady?.();
        setActivityNow(Date.now());
        setActivityProbeNonce((nonce) => nonce + 1);
      },
    }),
    [eventEffectsRegistry],
  );

  // Exactly one application per mount. It owns the one session store (the same
  // map the shell reads its slices off) and the one channel; disposing it
  // detaches the coordinator and closes the channel.
  const application: WebuiApplication = useMemo(
    () =>
      createWebuiApplication({
        // The live ingress: the transport's `watchEvents` watcher, adapted to
        // the application channel shape. With no transport wired (SSR, tests)
        // the application still exists but opens nothing.
        openEventChannel: watchEvents
          ? createWebuiOpenEventChannel(watchEvents)
          : () => ({ subscribe: () => () => undefined }),
        store: sessionStore,
        readActiveSessionId: () => selectedSessionIdRef.current,
        effects: applicationEffects,
        // The unread controller hydrates from the same storage adapter the
        // shell used (same key, same validation, same format) — injected
        // because the application layer may not import infrastructure.
        unreadStorage: {
          read: readWebuiUnreadCounts,
          write: writeWebuiUnreadCounts,
        },
        composer: composerStore,
        turns: {
          resumeSession: transport?.resumeSession ?? (async () => {}),
          ...(transport?.loadMessages
            ? { loadMessages: transport.loadMessages }
            : {}),
        },
      }),
    [
      applicationEffects,
      sessionStore,
      composerStore,
      transport?.loadMessages,
      transport?.resumeSession,
      watchEvents,
    ],
  );
  useEffect(() => () => application.dispose(), [application]);

  // A `workspace.git.changed` signal invalidates exactly the views it affects:
  // the owner matches the signal against the review and environment views it
  // currently holds and refreshes only those (ticket #51). No panel owns a
  // refresh token for this any more.
  useEffect(() => {
    if (!workspaceGitChanged) return;
    workspaceQueries.invalidateWorkspaceGit(workspaceGitChanged);
  }, [workspaceGitChanged, workspaceQueries]);

  // The manual arm of the stream loop's recovery. Undefined on the home screen
  // (no session to resume) and on hosts without a `resumeSession` transport: no
  // recovery path, no button. It runs through the turn coordinator, which owns
  // the refusal reset, the recorded cursor and one attempt per click.
  const retrySessionStream =
    selectedSessionId && transport?.resumeSession
      ? () => {
          void application.turns.retry(selectedSessionId);
        }
      : undefined;

  // Persistence is the unread controller's job now (ticket #49 criterion 4):
  // it subscribes to the activity slice and writes the positive counts after
  // hydration, so the shell holds no `ready` flag and no persist effect. The
  // ordering guarantee — restore before the first write — lives in one place.

  // Opening a session is what marks it read. Keyed on the id rather than run on
  // mount, so arriving *at* a session from a link does not clear the badge the
  // user was about to see on the row they came from.
  useEffect(() => {
    if (!selectedSessionId) return;
    application.unread.markRead(selectedSessionId);
  }, [application, selectedSessionId]);

  // The age labels are a function of the clock, not of the data. Without a tick
  // they would freeze at whatever they read when the last event arrived, and
  // every row would agree on how long ago "now" was.
  useEffect(() => {
    const timer = setInterval(() => setActivityNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Seeding needs the page; the restore does not, which is why they are two
  // effects. `railPage` is a fresh object on every refresh and on every search
  // keystroke, so folding the restore into this one would re-read storage and
  // re-apply it over the live counts on every keystroke.
  useEffect(() => {
    application.unread.seed(railPage.sessions);
  }, [application, railPage]);

  // Re-hydrate when the open session changes: the active session is excluded
  // from the restore, so arriving at a different one must not inherit the badge
  // the previous one cleared. The controller marks itself hydrated on the first
  // call (the composition root hydrates before the channel opens), and this
  // later call only re-applies the floor.
  useEffect(() => {
    application.unread.hydrate(selectedSessionId);
  }, [application, selectedSessionId]);

  useEffect(() => {
    if (!activeTurnProbe) return;
    // Once per list change, for every visible row. Not once per event: the
    // stream already answers for turns it saw, and the reconnect nonce is the
    // only other moment a re-probe is warranted.
    return application.unread.probeActiveTurns({
      sessions: railPage.sessions,
      probe: activeTurnProbe,
      now: () => Date.now(),
    });
  }, [application, activeTurnProbe, railPage, activityProbeNonce]);

  const sessionPanelState = selectedSessionId
    ? getWorkspacePanelSessionState(workspacePanelStates, selectedSessionId)
    : initialWorkspacePanelSessionState;
  const workspacePanel = sessionPanelState.workspacePanel;
  const progressPanelOpen = Boolean(selectedSessionId) && sessionPanelState.progressPanelOpen;
  const dispatchWorkspacePanel = useCallback((command: WorkspacePanelCommand) => {
    if (!selectedSessionId) return;
    setWorkspacePanelStates((states) => reduceWorkspacePanelSessionState(states, selectedSessionId, command));
  }, [selectedSessionId]);
  const setProgressPanelOpen = (update: boolean | ((open: boolean) => boolean)) => {
    if (!selectedSessionId) return;
    setWorkspacePanelStates((states) => {
      const current = getWorkspacePanelSessionState(states, selectedSessionId);
      const open = typeof update === "function" ? update(current.progressPanelOpen) : update;
      return setWorkspaceSessionProgressPanelOpen(states, selectedSessionId, open);
    });
  };
  const [workspaceEnvironmentCollapsed, setWorkspaceEnvironmentCollapsed] = useState(false);
  const [workspaceProgressCollapsed, setWorkspaceProgressCollapsed] = useState(false);
  const [workspaceSubagentsCollapsed, setWorkspaceSubagentsCollapsed] = useState(false);
  useEffect(() => {
    // Desktop derives these sections from the selected session/workspace. Do
    // not carry a previous session's collapsed state into the next session.
    setWorkspaceEnvironmentCollapsed(false);
    setWorkspaceProgressCollapsed(false);
    setWorkspaceSubagentsCollapsed(false);
  }, [selectedSessionId]);

  const progressPanelContent = <WebuiProgressOverviewPanel workspaceDir={selectedSession?.workspaceDir} isDefaultWorkspace={selectedSession?.isDefaultWorkspace} todos={progressTodos} subagents={progressSubagents} showProgress={!homeMode} showEmptyProgress={true} environmentCollapsed={workspaceEnvironmentCollapsed} progressCollapsed={workspaceProgressCollapsed} subagentsCollapsed={workspaceSubagentsCollapsed} onToggleEnvironment={() => setWorkspaceEnvironmentCollapsed((value) => !value)} onToggleProgress={() => setWorkspaceProgressCollapsed((value) => !value)} onToggleSubagents={() => setWorkspaceSubagentsCollapsed((value) => !value)} onMemberClick={handleWorkspaceSubagentClick} onOpenChanges={() => selectedSession?.workspaceDir && selectedSessionId ? dispatchWorkspacePanel({ type: "open-workspace-review", sessionId: selectedSessionId, workspaceDir: selectedSession.workspaceDir }) : undefined} onOpenTerminal={() => dispatchWorkspacePanel({ type: "open-tab", kind: "terminal", workspaceDir: selectedSession?.workspaceDir })} />;

  return (
    <WebuiEventEffectsRegistryProvider registry={eventEffectsRegistry}>
    <WebuiWorkspaceQueriesProvider queries={workspaceQueries}>
    <WebuiAccountWorkflowsProvider workflows={accountWorkflows}>
    <WebuiSettingsWorkflowsProvider workflows={settingsWorkflows}>
    <WebuiPluginWorkflowsProvider workflows={pluginWorkflows}>
    <WebuiSessionWorkflowsProvider workflows={sessionWorkflows}>
    <WebuiSessionStoreProvider store={sessionStore}>
    <ArchonShell>
    <div data-webui-shell="two-column" className="w-full h-screen relative">
      <div className="relative flex h-screen overflow-hidden bg-bg_grouped_secondary">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[50] h-[46px]" />
        <div className="pointer-events-none absolute left-[126px] top-0 z-[60] flex h-[38px] items-center gap-1">
          <button
            type="button"
            data-webui-sidebar-toggle="true"
            aria-label={railCollapsed ? "展开导航栏" : "收起导航栏"}
            aria-expanded={!railCollapsed}
            onClick={() => setRailCollapsed((collapsed) => !collapsed)}
            className="pointer-events-auto flex size-8 items-center justify-center rounded-[8px] text-text_default_tertiary hover:bg-bg_interaction_tertiary_hover"
          >
            <WebuiIconSidebarToggle />
          </button>
          <button
            type="button"
            data-webui-search="true"
            aria-expanded={railSearchOpen}
            aria-controls="webui-rail-search"
            aria-label="搜索"
            onClick={() => (railSearchOpen ? closeRailSearch() : openRailSearch())}
            className={`pointer-events-auto flex size-[30px] items-center justify-center rounded-lg text-text_default_tertiary ${
              railSearchOpen
                ? "bg-bg_interaction_tertiary_hover text-text_default_secondary"
                : "hover:bg-bg_interaction_tertiary_hover"
            }`}
          >
            <WebuiIconSearch />
          </button>
        </div>

        <div className="contents">
          {/* -------------------------------------------------------------- rail */}
          <div className="relative h-full min-h-0 flex-shrink-0">
            <LeftRail
              sessions={page.sessions}
              activeSessionId={selectedSessionId}
              onNew={startNewTask}
            >
            <aside
              aria-label="Primary navigation"
              data-webui-shell-region="rail"
              data-webui-rail-width={railCollapsed ? "64" : "240"}
              className={`webui-rail relative z-50 flex h-full select-none flex-col overflow-visible ${railCollapsed ? "w-[64px] bg-transparent" : "w-[240px] bg-bg_default_scrim"}`}
            >
              <div className="h-[50px] flex-shrink-0" aria-hidden="true" />
              {!railCollapsed ? (
                <>
                  <div
                    className="flex-shrink-0 px-4 pb-px"
                    data-webui-rail-fixed-row="true"
                  >
                    <RailRow
                      label="新建任务"
                      icon={<WebuiIconNewTask className="flex-shrink-0" />}
                      active={homeMode && !pluginManagementOpen}
                      onSelect={startNewTask}
                    />
                    {/*
                      Import is a rail-level action, not a per-session one: it
                      reads a file and creates the session from it, so there is
                      no session to hang the menu off yet. The picker is a
                      hidden input driven from here so the row stays a button.
                    */}
                    <input
                      ref={sessionImportInputRef}
                      type="file"
                      accept=".json,application/json"
                      data-webui-session-import-input="true"
                      aria-label="导入会话文件"
                      // The same visually-hidden treatment the composer's
                      // attachment inputs use. `hidden` would remove the
                      // element from the accessibility tree and make the
                      // picker unreachable to anything driving the DOM.
                      className="webui-composer-hidden-file-input"
                      onChange={handleSessionImportPicked}
                    />
                    <RailRow
                      label="导入会话"
                      icon={<WebuiIconContextExport className="flex-shrink-0" />}
                      active={false}
                      inert={sessionImportBusy}
                      onSelect={() => {
                        sessionImportInputRef.current?.click();
                      }}
                    />
                  </div>

                  {railSearchOpen ? (
                    <div
                      className="flex-shrink-0 px-4 pb-px pt-1"
                      data-webui-rail-fixed-row="true"
                    >
                      <input
                        id="webui-rail-search"
                        ref={railSearchInputRef}
                        type="text"
                        role="searchbox"
                        data-webui-rail-search-input="true"
                        aria-label="搜索会话"
                        placeholder="搜索会话"
                        value={railSearchQuery}
                        onChange={(event) => setRailSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          closeRailSearch();
                        }}
                        className="w-full rounded-[8px] border border-stroke_default bg-bg_default_primary px-2 py-1 text-sm text-text_default_primary outline-none placeholder:text-text_default_tertiary focus:border-stroke_strong"
                      />
                    </div>
                  ) : null}

                  <div className="relative min-h-0 flex-1">
                    <div className="webui-rail-scroll h-full overflow-x-hidden overflow-y-auto px-4">
                      <div className="space-y-px pb-2">
                        <RailRow label="插件" icon={<WebuiIconPlugins />} active={pluginManagementOpen} onSelect={() => openPluginManagement("plugins")} />
                        <RailRow label="网站" icon={<WebuiIconSites />} inert />
                        <RailRow label="远程" icon={<WebuiIconRemote />} inert />
                      </div>

                      <WebuiProjectList
                        page={railPage}
                        treePage={railTreePage}
                        projectRecords={projectRecords}
                        query={railSearchQuery}
                        loading={loading}
                        onLoadMore={loadMore}
                        selectedSessionId={selectedSessionId}
                        activity={sessionActivity}
                        now={activityNow}
                        onProjectSelect={setNewTaskWorkspaceDir}
                        onCreateTaskInProject={(project) => startNewTask(project.workspaceDir)}
                        error={pageError}
                        pinnedSessions={pinnedSessions}
                        starredSessions={starredSessions}
                        pinnedProjects={pinnedProjects}
                        projectNames={projectNames}
                        onRenameProject={handleRenameProject}
                        onToggleProjectPin={handleToggleProjectPin}
                        onArchiveProject={handleArchiveProject}
                        onRenameSession={handleRenameSession}
                        onToggleSessionPin={handleToggleSessionPin}
                        onToggleSessionStar={handleToggleSessionStar}
                        onArchiveSession={handleArchiveSession}
                        onForkSession={handleForkSession}
                        onCopySession={handleCopySession}
                        onExportSession={handleExportSession}
                        onDeleteSession={handleDeleteSession}
                      />

                      {railSearchQuery.trim() && railPage.sessions.length === 0 ? (
                        <p
                          data-webui-rail-search-empty="true"
                          className="px-2 py-3 text-sm text-text_default_tertiary"
                        >
                          没有匹配的会话
                        </p>
                      ) : null}
                    </div>
                    <div
                      className="webui-scroll-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6"
                      aria-hidden="true"
                      data-webui-scroll-fade="true"
                    />
                  </div>

                </>
              ) : null}
              {!railCollapsed ? <div className="relative flex-shrink-0 border-t-[0.5px] border-border_default">
                <UserMenu
                  collapsed={railCollapsed}
                  hostLabel={hostLabel}
                  dataDir={dataDir}
                  version={runtimeVersion}
                  sessionId={selectedSessionId}
                  workspaceDir={selectedSession?.workspaceDir}
                  onOpenFileLine={(path, line) => {
                    // The open-file command needs a concrete session and
                    // workspace; the review page is only reachable from a
                    // selected session, so both are present in practice, but
                    // a jump must never fire a command with holes in it.
                    if (!selectedSessionId || !selectedSession?.workspaceDir) return;
                    dispatchWorkspacePanel({ type: "open-file", sessionId: selectedSessionId, workspaceDir: selectedSession.workspaceDir, path, lineStart: line, lineEnd: line });
                  }}
                  onCreateMemorySession={createMemorySession}
                />
              </div> : null}
            </aside>
            </LeftRail>
          </div>

          <div
            className="group absolute top-0 bottom-0 z-[60] cursor-col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize navigation"
          >
            <div className="webui-rail-grip absolute left-1/2 top-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-text_default_tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-50" />
          </div>

          {/* -------------------------------------------------------------- main */}
          <main
            data-webui-shell-region="surface"
            className="relative flex min-h-0 min-w-0 flex-1 flex-row"
          >
            {pluginManagementArea ? <PluginManagement initialArea={pluginManagementArea} onChatWithAgent={async (name) => {
              const creator = sessionWorkflows.createSession;
              if (!creator) throw new Error("当前 WebUI 未连接会话创建服务");
              const created = await creator({ name });
              const sessionId = created.sessionId ?? created.session?.sessionId;
              if (!sessionId) throw new Error("创建 Agent 会话失败");
              handleSessionCreated(sessionId);
            }} /> : <>
            {!homeMode && !workspacePanel.open ? <WebuiWorkspacePanelControls filePanelOpen={false} progressPanelOpen={progressPanelOpen} onOpenFiles={() => { setProgressPanelOpen(false); dispatchWorkspacePanel({ type: "open-primary-view", kind: "files", sessionId: selectedSessionId, workspaceDir: selectedSession?.workspaceDir }); }} onToggleProgressPanel={() => setProgressPanelOpen((open) => !open)} /> : null}
            <div className="relative flex h-full min-w-0 flex-1 flex-col">
              <div
                className="pointer-events-none absolute inset-x-0 top-6 z-[60] flex justify-center"
                data-webui-busy-banner-slot="true"
              />
              <div
                className={
                  homeMode
                    ? "flex h-full min-h-0 w-full flex-col items-center relative overflow-hidden"
                    : `flex h-full min-h-0 w-full flex-col items-center relative overflow-hidden pt-spacing_24 ${progressPanelOpen ? "webui-session-has-progress-panel" : ""}`
                }
                data-webui-home-content={homeMode ? "true" : "false"}
                data-webui-session-layout={!homeMode ? "true" : undefined}
              >
                {homeMode ? <div aria-hidden="true" className="h-[clamp(96px,24vh,240px)] w-full shrink" /> : null}
                <div
                  className={homeMode
                    ? "flex w-full max-w-[743px] shrink-0 flex-col items-center gap-2 px-4"
                    : "webui-session-layout relative flex h-full min-h-0 w-full flex-col items-center gap-2"}
                >
                  {homeMode ? (
                    homeGreetingPending ? (
                      <GreetingSkeleton />
                    ) : (
                    <div className="flex flex-col items-center gap-2 text-center [@media(max-height:300px)]:hidden">
                      <div className="group/avatar relative size-16 flex-shrink-0">
                        <div className="webui-hero-avatar relative h-full w-full overflow-visible rounded-full bg-bg_grouped_tertiary">
                          <span className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-full">
                            <WebuiIconBrand className="h-full w-full" />
                          </span>
                        </div>
                      </div>
                      <h1 className="text-[28px] font-medium leading-tight text-text_default_primary">
                        MiniMax Code，让工作更简单。
                      </h1>
                    </div>
                    )
                  ) : (
                    <div
                      className="webui-session-title-row flex w-full items-center gap-2"
                      data-webui-rail-collapsed={railCollapsed || undefined}
                    >
                      <span className="webui-session-title" data-webui-session-title="true">
                        {selectedSession?.title ?? ""}
                      </span>
                    </div>
                  )}
                  {visibleUsageNotice ? (
                    <ConversationUsageBanner
                      notice={visibleUsageNotice}
                      messageText={
                        visibleUsageNotice.kind === "weekly"
                          ? "本周配额接近上限。"
                          : visibleUsageNotice.kind === "five_hour"
                            ? "五小时配额接近上限。"
                            : "本周期视频配额已用尽。"
                      }
                      onDismiss={() => setDismissedUsageNoticeKey(usageNoticeKey)}
                    />
                  ) : null}
                  {/* The connection region earns its pixels only when
                   * something needs the reader: `hideWhenConnected` keeps
                   * 已连接 off the page, so the banner appears for
                   * 正在重连 and 连接失败 only. Same slot as the usage
                   * banner so the two never stack surprises in different
                   * places. */}
                  <ConnectionStatus
                    sessionId={selectedSessionId}
                    hideWhenConnected
                    onRetry={retrySessionStream}
                    className="w-full max-w-[743px] justify-center rounded-lg border border-border_default bg-bg_default_secondary px-spacing_8 py-spacing_4"
                  />

                  <div
                    className={
                      homeMode
                        ? "contents"
                        : "webui-session-scroll-viewport flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden"
                    }
                    data-webui-session-scroll={homeMode ? undefined : "true"}
                  >
                    <Composer>
                    <WebuiComposer
                    sessionId={selectedSessionId}
                    sessionStatus={selectedSession?.status}
                    sessionLayout={!homeMode}
                    usageQuota={usageQuota}
                    agentName={selectedAgentName}
                    createSession={sessionWorkflows.createSession}
                    createSessionWorkspaceDir={newTaskWorkspaceDir}
                    onWorkspaceChange={handleWorkspaceChange}
                    workspaceMenuOpen={workspaceMenuOpen}
                    setWorkspaceMenuOpen={setWorkspaceMenuOpen}
                    recentWorkspaceDirs={recentWorkspaceDirs}
                    runCommand={commandWorkflows.canRunCommand ? commandWorkflows.runCommand : undefined}
                    sendMessage={transport?.sendMessage}
                    enqueueMessage={transport?.enqueueMessage}
                    resumeSession={transport?.resumeSession}
                    loadMessages={loadMessages}
                    getTurnDiff={transport?.getTurnDiff}
                    revertTurnDiff={transport?.revertTurnDiff}
                    reapplyTurnDiff={transport?.reapplyTurnDiff}
                    getSessionForkOptions={getSessionForkOptions}
                    forkSession={forkSession}
                    getSessionRewindPreview={transport?.getSessionRewindPreview}
                    rewindSession={transport?.rewindSession}
                    editSessionMessage={transport?.editSessionMessage}
                    getGoal={transport?.getGoal}
                    getActiveTurn={transport?.getActiveTurn}
                    createGoal={transport?.createGoal}
                    patchGoal={transport?.patchGoal}
                    clearGoal={transport?.clearGoal}
                    isGoalEnabled={transport?.isGoalEnabled}
                    listPendingPermissions={transport?.listPendingPermissions}
                    getPendingQuestionnaire={transport?.getPendingQuestionnaire}
                    replyPermission={transport?.replyPermission}
                    replyQuestionnaire={transport?.replyQuestionnaire}
                    dismissQuestionnaire={transport?.dismissQuestionnaire}
                    abortSession={transport?.abortSession}
                    listQueueMessages={transport?.listQueueMessages}
                    deleteQueueItem={transport?.deleteQueueItem}
                    listModels={transport?.listModels}
                    listSkills={transport?.listSkills}
                    listWorkspaceFileTree={transport?.listWorkspaceFileTree}
                    browseWorkspaceDirs={transport?.browseWorkspaceDirs}
                    pluginManagement={transport?.pluginManagement}
                    getPermissionMode={transport?.getPermissionMode}
                    setPermissionMode={transport?.setPermissionMode}
                    selectModel={transport?.selectModel}
                    getAccountStatus={transport?.getAccountStatus}
                    draft={draft}
                    onDraftChange={setDraft}
                    seedAttachment={memoryHandoff}
                    inputHistory={composerState.history[composerKey] ?? []}
                    onInputSubmitted={recordComposerInput}
                    teamModeOff={composerTeamModeOff}
                    favoritesStorage={favoriteStorage}
                    sessions={page.sessions}
                    workspaceDir={selectedSession?.workspaceDir ?? newTaskWorkspaceDir}
                    onSelectSession={handleSelectComposerSession}
                    onOpenPluginManagement={openPluginManagement}
                    onSessionCreated={handleSessionCreated}
                    />
                    </Composer>

                    {selectedSessionId && loadMessages ? (
                      <Transcript>
                      <WebuiSessionTranscript
                        sessionId={selectedSessionId}
                        workspaceDir={selectedSession?.workspaceDir}
                        onOpenFile={({ sessionId, workspaceDir, reference }) => dispatchWorkspacePanel({ type: "open-file", sessionId, workspaceDir, path: reference.path, ...(reference.lineStart !== undefined ? { lineStart: reference.lineStart } : {}), ...(reference.lineEnd !== undefined ? { lineEnd: reference.lineEnd } : {}) })}
                        onOpenTurnReview={(command) => dispatchWorkspacePanel(command)}
                        loadMessages={loadMessages}
                        {...(initialMessages ? { initialMessages } : {})}
                        getTurnDiff={transport?.getTurnDiff}
                        revertTurnDiff={transport?.revertTurnDiff}
                        reapplyTurnDiff={transport?.reapplyTurnDiff}
                        getSessionForkOptions={getSessionForkOptions}
                        forkSession={forkSession}
                        getSessionRewindPreview={transport?.getSessionRewindPreview}
                        rewindSession={transport?.rewindSession}
                        editSessionMessage={transport?.editSessionMessage}
                        getPendingQuestionnaire={transport?.getPendingQuestionnaire}
                        replyQuestionnaire={transport?.replyQuestionnaire}
                        onOpenPlanFile={({ sessionId: planSessionId, path, content }) => dispatchWorkspacePanel({ type: "open-plan-file", sessionId: planSessionId, workspaceDir: selectedSession?.workspaceDir ?? "", path, content })}
                      />
                      </Transcript>
                    ) : null}
                    {!homeMode ? (
                      <div
                        className="webui-session-bottom-padding w-full shrink-0"
                        data-testid="message-bottom-padding"
                        data-webui-session-bottom-padding="true"
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            {!homeMode ? (
              <div
                className={`webui-progress-panel-motion${progressPanelOpen ? " is-open" : ""}`}
                aria-hidden={!progressPanelOpen}
                ref={(element) => element?.toggleAttribute("inert", !progressPanelOpen)}
              >
                <aside className="webui-progress-overview-panel" data-testid="progress-overview-panel" aria-label="环境信息与进度">
                  {progressPanelContent}
                </aside>
              </div>
            ) : null}
            {!homeMode && workspacePanel.open ? <WebuiWorkspacePanel state={workspacePanel} dispatch={dispatchWorkspacePanel} sessionId={selectedSessionId} workspaceDir={selectedSession?.workspaceDir} workspaceFileUrl={transport?.workspaceFileUrl} readWorkspaceArchive={transport?.readWorkspaceArchive} extractWorkspaceArchive={transport?.extractWorkspaceArchive} readCanvas={transport?.readCanvas} applyCanvas={transport?.applyCanvas} createTerminal={transport?.createTerminal} listTerminals={transport?.listTerminals} writeTerminal={transport?.writeTerminal} disposeTerminal={transport?.disposeTerminal} watchTerminal={transport?.watchTerminal} onClose={() => dispatchWorkspacePanel({ type: "close-panel" })} /> : null}
            </>}
          </main>
        </div>
      </div>
    </div>
    </ArchonShell>
    </WebuiSessionStoreProvider>
    </WebuiSessionWorkflowsProvider>
    </WebuiPluginWorkflowsProvider>
    </WebuiSettingsWorkflowsProvider>
    </WebuiAccountWorkflowsProvider>
    </WebuiWorkspaceQueriesProvider>
    </WebuiEventEffectsRegistryProvider>
  );
}

export default WebuiClientFoundationApp;
