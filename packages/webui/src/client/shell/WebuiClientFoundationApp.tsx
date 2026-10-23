// WebuiClientFoundationApp — the WebUI shell: rail, main column, session
// transcript, composer, workspace panels. This is the React entrypoint
// `main.tsx` mounts, and `webui-transcript-widgets-integration.test.ts` imports
// it from here.

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
import { ConversationSurface } from "./ConversationSurface.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../features/composer/application/composer-history.js";
import { Composer } from "../features/composer/ui/Composer.js";
import { LeftRail } from "../features/sessions/ui/LeftRail.js";
import { Transcript } from "../features/transcript/ui/Transcript.js";
import { UserMenu } from "../features/account/ui/UserMenu.js";
import { MEMORY_HANDOFF_PROMPT, type MemoryHandoff } from "../features/settings/contracts/memory-handoff.js";
import { WebuiWorkspacePanel } from "../features/workspace/ui/WorkspacePanels.js";
import { WebuiProgressOverviewPanel } from "../features/workspace/ui/WorkspaceProgressPanel.js";
import {
  getWorkspacePanelSessionState,
  reduceWorkspacePanelSessionState,
  setWorkspaceSessionProgressPanelOpen,
  type WorkspacePanelSessionStates,
} from "../features/workspace/projection/workspace-panel-state.js";
import {
  initialWebuiShellSurface,
  isPluginManagementSurface,
  reduceWebuiShellSurface,
  webuiPluginManagementArea,
  type WebuiPluginManagementArea,
  type WebuiShellSurfaceCommand,
} from "../features/shell/projection/shell-surface.js";
import { ConversationUsageBanner } from "../features/account/ui/ConversationUsageBanner.js";
import { PluginCatalogue } from "../features/plugins/ui/PluginCatalogue.js";
import { WebuiComposer } from "../features/composer/ui/WebuiComposer.js";
import { WebuiExternalDeletionNotice } from "../features/sessions/ui/ExternalDeletionDraftNotice.public.js";
import { WebuiSessionTranscript } from "../features/transcript/ui/SessionTranscript.js";
import { SessionRailRegion } from "../features/sessions/ui/SessionRailRegion.js";
import { useSessionRailState } from "../features/sessions/bindings/use-session-rail-state.js";
import { selectWebuiSessionAgentName, selectWebuiSessionLookups } from "../features/sessions/projection/session-lookups.js";
import {
  filterWebuiSessionsByQuery,
  sessionLabel,
} from "../features/sessions/projection/rail-groups.js";
import { sessionHash } from "../projection/common/router.js";
import {
  WebuiIconSearch,
  WebuiIconSidebarToggle,
} from "./icons.js";
import type { WebuiClientSession, WebuiClientSessionPage } from "../features/sessions/contracts/session-view.js";
import type {
  WebuiClientMessage,
  WebuiClientMessagePage,
} from "../features/transcript/contracts/message-view.js";
import type { WebuiTodo } from "../features/workspace/projection/panel-projection.js";
import type { WebuiUsageQuotaResult } from "../../shared/contracts/usage-quota.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type {
  WebuiWorkspaceProgressState,
  WebuiWorkspaceSubagent,
} from "../features/workspace/projection/workspace-progress.js";
import type { WebuiProjectGroup } from "../features/sessions/projection/rail-groups.js";
import { selectWebuiCatalogFlatPage, selectWebuiCatalogTreePage } from "../features/sessions/application/session-catalog.public.js";
import { WebuiPortSlicesProvider } from "../bindings/port-slices-context.js";
import { WebuiApplicationProvider } from "../bindings/application-context.js";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import { useWebuiApplicationOptional } from "../bindings/application-context.js";
import {
  WebuiPluginWorkflowsProvider,
  WebuiSessionWorkflowsProvider,
  WebuiModelsWorkflowsProvider,
  WebuiSettingsWorkflowsProvider,
  WebuiWorkspaceQueriesProvider,
} from "../bindings/use-query-state.js";
import { WebuiAccountWorkflowsProvider } from "../features/account/bindings/use-account-workflows.js";
import { WebuiBrowserAuthorizationProvider } from "../features/browser/bindings/use-browser-authorization.public.js";
import { useSessionTeamMode } from "../features/sessions/bindings/use-session-team-mode.js";
import {
  projectWebuiWorkspaceHistory,
  selectWebuiWorkspaceProgress,
} from "../features/workspace/projection/workspace-progress.js";
import {
  initialWebuiWorkspaceProgress,
  webuiWorkspaceSubagentStatus,
} from "../features/workspace/contracts/progress.js";
import type { WebuiWorkspaceGitChangedSignal } from "../features/workspace/projection/workspace-panel-state.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { deriveConversationUsageNotice } from "../features/transcript/projection/message-projection.js";

// The hash plumbing moved to `client/bindings/navigation.ts`. Both
// symbols stay re-exported here: `main.tsx` re-exports `subscribeToSessionHash`
// from this module, and the SSR snapshot reads `readSessionIdFromHash` through it.
import {
  readSessionIdFromHash,
  subscribeToSessionHash,
} from "../bindings/navigation.js";
export { readSessionIdFromHash, subscribeToSessionHash };

// The shell's own responsibilities now have their own modules; the frame keeps
// layout, owner acquisition and public business composition.
import { useSelectedSessionId } from "./use-selected-session.js";
import { useWorkspacePanelSession } from "./use-workspace-panel-session.js";
import { useNewTaskWorkspace } from "./use-new-task-workspace.js";
import { useShellActivityWiring } from "./use-shell-activity-wiring.js";
import { useSessionRailActions } from "./use-session-rail-actions.js";
import { WebuiZoneBoundary } from "./WebuiZoneBoundary.js";

export interface WebuiClientFoundationAppProps {
  // Non-method props only (seed / UI / SSR). The capability methods the shell
  // uses come from the application it is handed, not from props.
  readonly label: string;
  /** The Agent Team badge's tooltip, resolved by the composition root. */
  readonly teamModeLabel?: string;
  readonly version?: WebuiVersionInfo;
  readonly sessionPage?: WebuiClientSessionPage;
  /** Seed for the transcript so SSR / first paint can render messages before
   * the transcript history owner's `loadMessages` resolves; production always
   * re-fetches in the background so the prop only changes the initial paint,
   * not the source of truth. */
  readonly initialMessages?: WebuiClientMessagePage;
  /** Seed for the conversation usage banner so SSR / first paint can render
   * it before the account owner's `getUsageQuota` resolves; production always
   * re-fetches in the background so the prop only changes the initial paint,
   * not the source of truth.
   */
  readonly initialUsageQuota?: WebuiUsageQuotaResult;
  readonly locationHash?: string;
  readonly dataDir?: string;
  /**
   * What the identity row shows under the product name. The signed-in
   * account's plan would go there; the WebUI is loopback-only and has no account, so it reports
   * the scope it actually runs in. `main.tsx` passes the page's host.
   */
  readonly hostLabel?: string;
}

/**
 * The assembled application this shell renders, taken from the value the
 * composition root provides rather than named by an import of the assembly's
 * module: the shell's contract is the instance it is handed, and the binding
 * that hands it is what types it.
 */
type ShellApplication = NonNullable<
  ReturnType<typeof useWebuiApplicationOptional>
>;

/**
 * The assembled application this shell renders, or a named failure.
 *
 * The shell composes what the assembly built; it does not build one. A host
 * that renders it without an application has a wiring defect, and the failure
 * says which wiring: an absent owner is an assembly error, never a silent second
 * composition that behaves differently from production.
 */
function requireApplication(
  application: ShellApplication | undefined,
): ShellApplication {
  if (!application) {
    throw new Error(
      "WebUI assembly error: WebuiClientFoundationApp was rendered without an application. " +
        "Build one with createWebuiApplication and provide it through WebuiApplicationProvider; " +
        "the shell no longer constructs a fallback assembly (plan §4.1).",
    );
  }
  return application;
}

export function WebuiClientFoundationApp(
  props: WebuiClientFoundationAppProps,
): ReactElement {
  const { storage: browserStorage, dom: browserDom } = useWebuiBrowserCapabilities();
  // One application, assembled and owned by the composition root.
  // The shell adopts that instance — its store, its composer owner and its
  // lifetime — and builds nothing of its own; a missing one is an assembly
  // error rather than a second composition with different inputs.
  const application = requireApplication(useWebuiApplicationOptional());
  const {
    label,
    sessionPage,
    initialMessages,
    initialUsageQuota,
    version,
    locationHash,
    dataDir,
    hostLabel,
  } = props;
  // The assembly's slices: cut once by the application, published on it and
  // provided to the screens below. The shell holds no capability to cut its own
  // and no transport to fall back to.
  const portSlices = application.portSlices;
  const workspacePort = portSlices.workspace;
  // The browser Terminal owner, built by the assembly for the same reason as the
  // rest: this component renders the provider that `useWebuiPortSlice` reads (see
  // the provider below), so it cannot read through it itself.
  const terminalOwner = application.terminalOwner;
  const turnPort = portSlices.turn;
  // The one application store, taken from the assembled application. There is no
  // second map: the shell provides this exact object to the subtree through
  // `WebuiApplicationProvider` and reads its own slices off it. A host that needs
  // a seeded catalogue (SSR first paint, a fixture) seeds the store it passes to
  // the assembly; the shell does not build one to seed.
  const sessionStore = application.store;
  // The one per-session effects registry for this mount
  // (`features/turn/application/event-coordinator.ts`). The shell holds it and
  // provides it; the composer registers its session's effect handlers here and
  // `asWebuiEventEffects()` is what the application coordinator consumes over
  // the single process-event channel.
  // A local rebind of the transcript slice's `loadMessages`, read below where the
  // transcript is rendered; the other capabilities are taken off the port slices
  // at the point the JSX consumes them.
  const loadMessages = portSlices.transcript.loadMessages;

  // The one session catalog. The shell subscribes to the store's catalog slice
  // and resolves the flat and tree pages from it; both views share one entity
  // map, so a rename patches one structure and neither view can drift from the
  // other.
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
  // Composer store declared before sessionWorkflows so the delete-success purge
  // can hand the workflows the same instance.
  const composerStore = application.composer;
  // The session workflows: the loads and mutations the shell used to call
  // through `transport` and then patch onto two structures by hand. The shell
  // submits a workflow and holds no transport call for session entities.
  const sessionWorkflows = application.sessionWorkflows;
  // The retained drafts an externally deleted session left behind: the notice below
  // reads them until the user copies, transfers or discards one.
  const retainedDeletionDrafts = useSyncExternalStore(
    sessionWorkflows.subscribeRetainedDrafts,
    sessionWorkflows.retainedDeletionDrafts,
    sessionWorkflows.retainedDeletionDrafts,
  );
  const projectState = useSessionRailState(sessionWorkflows);
  const projectRecords = projectState.projects;
  // The one workspace query owner: it caches the workspace file tree, file
  // contents, the working-tree review and the git environment, and discards a
  // late response from a superseded request. Provided to the two workspace
  // panels, which submit query commands and read its snapshot.
  const workspaceQueries = application.workspaceQueries;
  // The account, settings and plugin owners. One of each per mount, provided to
  // the user menu, the settings dialog and the plugin manager; those components
  // submit commands and read the snapshot instead of holding their own copies of
  // the answers.
  const accountWorkflows = application.accountWorkflows;
  // The account owner's timers (the login poll and the OAuth status poll) end
  // with the application rather than with this component's mount.
  const settingsWorkflows = application.settingsWorkflows;
  // `models` owns the catalogue, the selection and the provider list, so it is
  // its own owner with its own snapshot. The one cross-business call it makes —
  // refreshing `settings`' api-key *status* read — is wired inside the assembly,
  // through that owner's published command, rather than copying the read.
  const modelsWorkflows = application.modelsWorkflows;
  // The runtime handshake fact is a `SettingsPort` method, so it is read through
  // the settings owner like every other settings read rather than invoked here.
  // The `version` seed prop still wins, so a server-rendered first paint is not
  // replaced by a second identical fetch.
  const settingsState = useSyncExternalStore(
    settingsWorkflows.subscribe,
    settingsWorkflows.getSnapshot,
    settingsWorkflows.getSnapshot,
  );
  const runtimeVersion = version ?? settingsState.runtimeVersion.value;
  useEffect(() => {
    if (runtimeVersion || !settingsWorkflows.canReadVersion) return;
    void settingsWorkflows.loadVersion();
  }, [runtimeVersion, settingsWorkflows]);
  const pluginWorkflows = application.pluginWorkflows;
  // The composer's view of what is installed and what the agent can run. It is a
  // separate read model from `pluginWorkflows` on purpose: the `@` menu and the
  // plugin manager are two readers with two identities, so neither overwrites the
  // other when one of them reloads.
  // The usage quota is an `AccountPort` method, so it is read through the
  // account owner that already caches it for the user menu and the settings
  // dialog. The shell used to hold its own copy, fetched independently, with
  // its own `cancelled` flag and its own error handling — so the banner and the
  // menu could disagree about the same answer.
  const accountState = useSyncExternalStore(
    accountWorkflows.subscribe,
    accountWorkflows.getSnapshot,
    accountWorkflows.getSnapshot,
  );
  const usageQuota = accountState.usage.result ?? initialUsageQuota;
  useEffect(() => {
    if (!accountWorkflows.canReadUsage) return;
    void accountWorkflows.loadUsage();
  }, [accountWorkflows]);
  // Which surface the main column renders. Plugin management replaces the
  // conversation rather than floating above it, so the rail stays the only way
  // back out of it — every conversation navigation has to return here.
  const [shellSurface, setShellSurface] = useState(initialWebuiShellSurface);
  const dispatchShellSurface = useCallback((command: WebuiShellSurfaceCommand) => {
    setShellSurface((current) => reduceWebuiShellSurface(current, command));
  }, []);
  const [selectedSessionId, setSelectedSessionId] =
    useSelectedSessionId(locationHash);
  /**
   * Selecting a session is ONE action.
   *
   * The page's route and the application's selection are two records of the
   * same fact, and the second one used to be written by a module that had
   * nothing to do with selection — the activity wiring, which owned the rail's
   * row animations. The model catalogue follows "the session the application has
   * selected", so a selection that did not reach the application left the
   * composer reading a catalogue for a session that was not the one on screen,
   * and the picker came up empty. The route decides here, and the application
   * is told; every path that changes the route passes through here.
   */
  const selectSession = useCallback((sessionId: string | undefined) => {
    setSelectedSessionId(sessionId);
  }, []);
  const transcriptCommandsWithForkNavigation = useMemo(() => {
    const commands = application.transcriptCommands;
    if (!commands.forkSession) return commands;
    return {
      ...commands,
      forkSession: async (request: Parameters<NonNullable<typeof commands.forkSession>>[0]) => {
        const result = await commands.forkSession!(request);
        if (result.session?.sessionId) {
          selectSession(result.session.sessionId);
          if (typeof window !== "undefined")
            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${window.location.search}${sessionHash(result.session.sessionId)}`,
            );
        }
        return result;
      },
    };
  }, [application.transcriptCommands, selectSession]);
  useEffect(() => {
    application.select(selectedSessionId);
  }, [application, selectedSessionId]);
  // The plan-review reply workflow lives with the assembly: it reads the
  // selection and the session's agent name when the reply is submitted, so a card
  // left open across a selection change replies to the session it belongs to
  // instead of to whichever session the shell had selected when it mounted.
  const planReviewWorkflow = application.planReviewWorkflow;
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
  // Composer input history + per-session drafts. The one owner is the application
  // composer store: the shell subscribes to it and submits through it.
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
  // The Agent Team choice belongs to Sessions: the state, the storage read and the
  // write-back live in that feature's binding, and the shell renders what it
  // returns.
  const { teamModeOff, teamModeOffFor, recordSessionTeamMode } =
    useSessionTeamMode(browserStorage);
  const pageError = catalog.flat.error;
  const setPageError = sessionWorkflows.setError;
  const [dismissedUsageNoticeKey, setDismissedUsageNoticeKey] = useState<
    string | undefined
  >();
  // The rail's own state (collapse, search, pins and project names) and its
  // row actions live in `./use-session-rail-actions.js`; it is called below,
  // once the session it acts on is resolved.
  // The selected slot's live stream, read through the application's published
  // reads rather than by importing the assembly's selectors.
  // Which slot "nothing selected" names — the home slot the first turn streams
  // into — is the assembly's own mapping, so the shell asks for the selection
  // and holds no sentinel. The subscription is the application's, which is the
  // same store subscription the shell used to take directly.
  const selectedStream = useSyncExternalStore(
    application.subscribe,
    () => application.reads.stream(selectedSessionId),
    () => application.reads.stream(selectedSessionId),
  );
  // The workspace-progress backfill, derived rather than fetched.
  //
  // The shell used to call `transport.loadMessages` itself and keep the answer
  // in local state, with its own `cancelled` flag — a second reader of an RPC
  // the transcript history owner (`client/conversation/transcript-history.ts`) already
  // owns, fetches and commits into the session store. It now projects the
  // owner's committed page, so the RPC, its request fence and its error state
  // have one owner and one caller. `SessionTranscript` still drives the load
  // when the transcript is mounted; when it is not, there is no history to
  // project and the projection is the initial state.
  const transcriptPage = useSyncExternalStore(
    application.subscribe,
    () => application.reads.transcriptPage(selectedSessionId),
    () => application.reads.transcriptPage(selectedSessionId),
  );
  const historyProgress = useMemo<WebuiWorkspaceProgressState>(
    () =>
      selectedSessionId
        ? projectWebuiWorkspaceHistory(
            (transcriptPage.messages ?? []) as readonly WebuiClientMessage[],
            selectedSessionId,
          )
        : initialWebuiWorkspaceProgress,
    [selectedSessionId, transcriptPage.messages],
  );
  // Sessions visible to lookups: roots from the flat page plus any child
  // sessions surfaced through the tree projection. Without the tree the
  // flat list is the only source, matching the original behaviour.
  const flatSessionsWithChildren = useMemo(
    () => selectWebuiSessionLookups(page, treePage),
    [page, treePage],
  );
  const selectedAgentName = selectWebuiSessionAgentName(flatSessionsWithChildren, selectedSessionId);
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
  // Cloud usage quota for the conversation banner comes from the account owner
  // (`accountState.usage.result` above): it is loaded once there, on mount, and
  // shared with the user menu and the settings dialog instead of being fetched
  // a second time for the banner alone.
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
  // One pure derivation over the three labelled progress inputs. The shell no
  // longer merges by hand — the precedence, including the snapshot-gated todo
  // choice, lives in the domain selector.
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
  const {
    newTaskWorkspaceDir,
    workspaceMenuOpen,
    setWorkspaceMenuOpen,
    recentWorkspaceDirs,
    handleWorkspaceChange,
    handleSessionCreatedViewEffect,
    startNewTask,
  } = useNewTaskWorkspace({
    // The workspace policy is the application's use case now: the shell still
    // owns the picker, the recent list and the navigation effects, and it asks
    // for the decision instead of holding it.
    taskSessions: application.taskSessions,
    selectedSession,
    flatSessionsWithChildren,
    setDraft,
    dispatchShellSurface,
    selectSession,
    recordSessionTeamMode,
  });
  // The navigation claim the creation use case measures its completions against:
  // every selection the shell makes — a rail click, the boot route, 「新建任务」 —
  // is a navigation, and a duplicate notification of the same destination is not.
  // Without this the claim would never advance and a late creation could not tell
  // that the user had already moved.
  useEffect(() => {
    application.taskSessions.noteNavigation(selectedSessionId);
  }, [application.taskSessions, selectedSessionId]);

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
   * slot on the home surface.
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
      selectSession(subagent.sessionId);
      if (typeof window !== "undefined")
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${sessionHash(subagent.sessionId)}`,
        );
    },
    [selectSession],
  );
  const handleSelectComposerSession = useCallback((sessionId: string) => {
    selectSession(sessionId);
    if (typeof window !== "undefined")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${sessionHash(sessionId)}`,
      );
  }, [selectSession]);
  const childSessions = selectedSessionId
    ? page.sessions.filter(
        (session) => session.parentSessionId === selectedSessionId,
      )
    : [];
  const composerTeamModeOff = teamModeOffFor(selectedSessionId);
  const {
    railCollapsed,
    setRailCollapsed,
    railSearchOpen,
    railSearchQuery,
    setRailSearchQuery,
    railSearchInputRef,
    sessionImportInputRef,
    openSessionImportPicker,
    sessionImportBusy,
    openRailSearch,
    closeRailSearch,
    railPage,
    railTreePage,
    pinnedSessions,
    pinnedProjects,
    projectNames,
    onRenameProject: handleRenameProject,
    onToggleProjectPin: handleToggleProjectPin,
    onArchiveProject: handleArchiveProject,
    onRenameSession: handleRenameSession,
    onToggleSessionPin: handleToggleSessionPin,
    onArchiveSession: handleArchiveSession,
    onForkSession: handleForkSession,
    onCopySession: handleCopySession,
    onExportSession: handleExportSession,
    onDeleteSession: handleDeleteSession,
    onSessionImportPicked: handleSessionImportPicked,
  } = useSessionRailActions({
    page,
    treePage,
    storage: browserStorage,
    workflows: sessionWorkflows,
    selectedSessionId,
    selectedSession,
    selectSession,
    setPageError,
  });
  const pluginManagementArea = webuiPluginManagementArea(shellSurface);
  const pluginManagementOpen = isPluginManagementSurface(shellSurface);
  const openPluginManagement = useCallback((area: WebuiPluginManagementArea) => {
    dispatchShellSurface({ type: "open-plugin-management", area });
  }, [dispatchShellSurface]);
  // The panel/tab state belongs to the workspace business: the shell reads the
  // slice for the session it shows and dispatches; it owns neither.
  const workspacePanelOwner = workspaceQueries.panel;
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
  // state. The shell subscribes to the slice; the application activity
  // controller owns its writes.
  // The activity slice, the reconnect nonce and every reaction that keeps them
  // current live in `./use-shell-activity-wiring.js`.
  // The wiring's capabilities are stable for the component's whole life: they
  // read the application through a ref, so the hook's effects run when the
  // session, the rail page or the reconnect nonce changes — not on every render.
  // Stable wiring keeps activity probes from re-running on every render.
  const applicationRef = useRef(application);
  applicationRef.current = application;
  const activityWiring = useMemo(
    () => ({
      onChannelReady: (listener: () => void) =>
        applicationRef.current.onChannelReady(listener),
      seed: (sessions: Parameters<typeof application.sessionActivity.seed>[0]) =>
        applicationRef.current.sessionActivity.seed(sessions),
      // Interest, and the probe per identity the scheduler issues from it. The
      // shared probe already deduplicates a same-session probe, so one request per
      // visible session is one round trip per newly interesting session — and none
      // at all when only the search text changed.
      setActivityInterest: (sessions: readonly { readonly sessionId: string }[]) => {
        const probe = applicationRef.current.activeTurnProbe;
        // No probe, no interest: the assembly builds one only when the host can
        // answer it.
        if (!probe) {
          applicationRef.current.observations.setActivityInterest([]);
          return;
        }
        applicationRef.current.observations.setActivityInterest(
          sessions.map((session) => ({
            identity: `turn:${session.sessionId}`,
            run: (signal) =>
              probe
                .probe(session.sessionId)
                .then((active) => {
                  if (!signal.isCurrent()) return;
                  applicationRef.current.sessionActivity.applyActiveTurn(
                    session.sessionId,
                    active,
                    Date.now(),
                  );
                })
                .catch(() => undefined),
          })),
        );
      },
      reconcileActivity: () => applicationRef.current.observations.invalidateActivity(),
    }),
    [],
  );
  // A hidden page has no reader, so periodic business reads stop; returning
  // re-establishes freshness rather than waking up to stale answers. Accepted Turn
  // execution and delivery are untouched by this — they are not observations.
  useEffect(() => {
    const update = (): void => {
      applicationRef.current.observations.setSuspended(browserDom.isPageHidden());
    };
    update();
    return browserDom.listenForVisibilityChange(update);
  }, [browserDom]);
  const activityPage = useMemo(() => {
    const rows = new Map(page.sessions.map((session) => [session.sessionId, session]));
    for (const node of treePage.sessions) {
      rows.set(node.session.sessionId, node.session);
      for (const child of node.childSessions) rows.set(child.sessionId, child);
    }
    return { sessions: [...rows.values()] };
  }, [page, treePage]);
  const { sessionActivity, activityNow, activityProbeNonce } = useShellActivityWiring({
    sessionStore,
    // Search and disclosure change presentation, not the freshness of known sessions.
    railPage: activityPage,
    selectedSessionId,
    ...activityWiring,
  });

  // The application-wide effects the coordinator runs. It composes the
  // per-session registry the composer registers into with the shell's own
  // reach: the channel-accepted signal re-probes the rail (a reconnect can miss
  // a `session.start`).
  //
  // The workspace-git and turn-review invalidations are *not* here. They are
  // links between businesses — one writes the working tree, the other reads it —
  // so the assembly installs them before event ingress starts rather than the
  // shell installing them for as long as a view happens to be mounted.
  // The shell never disposes the application: its lifetime belongs to the
  // composition root that built it.

  // The manual arm of the stream loop's recovery. Undefined on the home screen
  // (no session to resume) and on hosts without a `resumeSession` transport: no
  // recovery path, no button. It runs through the turn coordinator, which owns
  // the refusal reset, the recorded cursor and one attempt per click.
  const retrySessionStream =
    selectedSessionId && turnPort.resume
      ? () => {
          void application.turns.retry(selectedSessionId);
        }
      : undefined;

  // The application's selection, the activity controller's reactions and the
  // clock tick live in `./use-shell-activity-wiring.js`.

  // The panel's per-session state and its writers live in
  // `./use-workspace-panel-session.js`; the shell passes the owner and the
  // queries it already holds and gets back what the JSX binds.
  const {
    sessionPanelState,
    workspacePanel,
    progressPanelOpen,
    dispatchWorkspacePanel,
    setProgressPanelOpen,
  } = useWorkspacePanelSession({
    owner: workspacePanelOwner,
    queries: workspaceQueries.files,
    selectedSessionId,
  });
  const [workspaceEnvironmentCollapsed, setWorkspaceEnvironmentCollapsed] = useState(false);
  const [workspaceProgressCollapsed, setWorkspaceProgressCollapsed] = useState(false);
  const [workspaceSubagentsCollapsed, setWorkspaceSubagentsCollapsed] = useState(false);
  useEffect(() => {
    // These sections derive from the selected session/workspace. Do
    // not carry a previous session's collapsed state into the next session.
    setWorkspaceEnvironmentCollapsed(false);
    setWorkspaceProgressCollapsed(false);
    setWorkspaceSubagentsCollapsed(false);
  }, [selectedSessionId]);

  const progressPanelContent = <WebuiProgressOverviewPanel open={progressPanelOpen} workspaceDir={selectedSession?.workspaceDir} isDefaultWorkspace={selectedSession?.isDefaultWorkspace} environmentLoading={loading} todos={progressTodos} subagents={progressSubagents} showProgress={!homeMode} environmentCollapsed={workspaceEnvironmentCollapsed} progressCollapsed={workspaceProgressCollapsed} subagentsCollapsed={workspaceSubagentsCollapsed} onToggleEnvironment={() => setWorkspaceEnvironmentCollapsed((value) => !value)} onToggleProgress={() => setWorkspaceProgressCollapsed((value) => !value)} onToggleSubagents={() => setWorkspaceSubagentsCollapsed((value) => !value)} onMemberClick={handleWorkspaceSubagentClick} onOpenChanges={() => selectedSession?.workspaceDir && selectedSessionId ? dispatchWorkspacePanel({ type: "open-workspace-review", sessionId: selectedSessionId, workspaceDir: selectedSession.workspaceDir }) : undefined} onOpenTerminal={() => dispatchWorkspacePanel({ type: "open-tab", kind: "terminal", workspaceDir: selectedSession?.workspaceDir })} />;

  return (
    <>
      {/* The slices are provided, not only read: a consumer below reads its
        * business's slice from this context, which is the reason a child
        * component never has to fall back to the transport. */}
      <WebuiPortSlicesProvider slices={portSlices}>
    {/* The browser family owns its authorization, and the panel in the tool area
        and the settings page in the modal are different trees: only a provider
        above both of them gives them one answer. */}
    <WebuiBrowserAuthorizationProvider>
    <WebuiWorkspaceQueriesProvider queries={workspaceQueries}>
    <WebuiAccountWorkflowsProvider workflows={accountWorkflows}>
    <WebuiModelsWorkflowsProvider workflows={modelsWorkflows}>
    <WebuiSettingsWorkflowsProvider workflows={settingsWorkflows}>
    <WebuiPluginWorkflowsProvider workflows={pluginWorkflows}>
    <WebuiSessionWorkflowsProvider workflows={sessionWorkflows}>
    <WebuiApplicationProvider application={application}>
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
            <LeftRail>
            <SessionRailRegion
              collapsed={railCollapsed}
              homeMode={homeMode}
              pluginManagementOpen={pluginManagementOpen}
              startNewTask={startNewTask}
              importInputRef={sessionImportInputRef}
              openImportPicker={openSessionImportPicker}
              importBusy={sessionImportBusy}
              onImportPicked={handleSessionImportPicked}
              searchOpen={railSearchOpen}
              searchQuery={railSearchQuery}
              searchInputRef={railSearchInputRef}
              setSearchQuery={setRailSearchQuery}
              closeSearch={closeRailSearch}
              openPlugins={() => openPluginManagement("plugins")}
              hasSearchResults={railPage.sessions.length > 0}
              projectList={{
                teamModeLabel: props.teamModeLabel, page: railPage, treePage: railTreePage,
                projectRecords, projectLoadError: projectState.error, query: railSearchQuery,
                loading, onLoadMore: loadMore, selectedSessionId, activity: sessionActivity,
                now: activityNow, onCreateTaskInProject: (project) => startNewTask(project.workspaceDir),
                error: pageError, pinnedSessions, pinnedProjects, projectNames,
                onRenameProject: handleRenameProject, onToggleProjectPin: handleToggleProjectPin,
                onArchiveProject: handleArchiveProject, onRenameSession: handleRenameSession,
                onToggleSessionPin: handleToggleSessionPin,
                onArchiveSession: handleArchiveSession, onForkSession: handleForkSession,
                onCopySession: handleCopySession, onExportSession: handleExportSession,
                onDeleteSession: handleDeleteSession,
              }}
              footer={!railCollapsed ? <div className="relative flex-shrink-0 border-t-[0.5px] border-border_default">
                <UserMenu
                  collapsed={railCollapsed} hostLabel={hostLabel} dataDir={dataDir}
                  version={runtimeVersion} sessionId={selectedSessionId}
                  workspaceDir={selectedSession?.workspaceDir}
                  onOpenFileLine={(path, line) => {
                    if (!selectedSessionId || !selectedSession?.workspaceDir) return;
                    dispatchWorkspacePanel({ type: "open-file", sessionId: selectedSessionId, workspaceDir: selectedSession.workspaceDir, path, lineStart: line, lineEnd: line });
                  }}
                  onCreateMemorySession={createMemorySession}
                />
              </div> : null}
            />
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
            {pluginManagementArea ? <WebuiZoneBoundary zone="plugins"><PluginCatalogue initialArea={pluginManagementArea} onChatWithAgent={async (name) => {
              // Plugin-chat creation is the same completion policy as the composer's
              // and the goal path's: it goes through the task use case, so the
              // admission reservation, the guarded transfer and the catalogue
              // refresh happen once, here, with nothing mounted.
              const outcome = await application.taskSessions.submit({ name });
              if (outcome.kind === "unsupported")
                throw new Error("当前 WebUI 未连接会话创建服务");
              if (outcome.kind === "busy") throw new Error("会话正在创建中，请稍后再试。");
              if (outcome.kind === "creation-failed") throw new Error(outcome.error);
              // The rail's chat action opens what it created only while the claim
              // that started the creation is still current.
              if (outcome.selected) application.select(outcome.sessionId);
              handleSessionCreatedViewEffect(outcome.sessionId, outcome.selected, teamModeOff);
            }} /></WebuiZoneBoundary> : <>
            <ConversationSurface
              home={homeMode}
              title={selectedSession?.title}
              greetingPending={homeGreetingPending}
              railCollapsed={railCollapsed}
              progressOpen={progressPanelOpen}
              onOpenBrowser={() => {
                setProgressPanelOpen(false);
                dispatchWorkspacePanel({ type: "open-panel" });
              }}
              onToggleProgress={() => setProgressPanelOpen((open) => !open)}
              usageBanner={visibleUsageNotice ? <ConversationUsageBanner
                notice={visibleUsageNotice}
                messageText={visibleUsageNotice.kind === "weekly" ? "本周配额接近上限。" : visibleUsageNotice.kind === "five_hour" ? "五小时配额接近上限。" : "本周期视频配额已用尽。"}
                onDismiss={() => setDismissedUsageNoticeKey(usageNoticeKey)}
              /> : null}
              connectionStatus={<ConnectionStatus
                sessionId={selectedSessionId} hideWhenConnected onRetry={retrySessionStream}
                className="w-full max-w-[743px] justify-center rounded-lg border border-border_default bg-bg_default_secondary px-spacing_8 py-spacing_4"
              />}
              composerAndTranscript={<>
                <WebuiExternalDeletionNotice
                  drafts={retainedDeletionDrafts}
                  onCopy={(sessionId) => {
                    const text = sessionWorkflows.copyRetainedDeletionDraft(sessionId);
                    if (text === undefined) return;
                    // Copying is the user's act, so the record retires whether or
                    // not this browser exposes a clipboard to write to.
                    if (typeof navigator !== "undefined" && navigator.clipboard) {
                      void navigator.clipboard.writeText(text).catch(() => undefined);
                    }
                  }}
                  onTransfer={(sessionId) => {
                    sessionWorkflows.transferRetainedDeletionDraft(sessionId);
                  }}
                  onDiscard={(sessionId) => {
                    sessionWorkflows.discardRetainedDeletionDraft(sessionId);
                  }}
                />
                <Composer><WebuiZoneBoundary zone="composer"><WebuiComposer
                  sessionId={selectedSessionId}
                  sessionLayout={!homeMode}
                  usageQuota={usageQuota}
                  agentName={selectedAgentName}
                  createSessionWorkspaceDir={newTaskWorkspaceDir}
                  onWorkspaceChange={handleWorkspaceChange}
                  workspaceMenuOpen={workspaceMenuOpen}
                  setWorkspaceMenuOpen={setWorkspaceMenuOpen}
                  recentWorkspaceDirs={recentWorkspaceDirs}
                  draft={draft}
                  onDraftChange={setDraft}
                  seedAttachment={memoryHandoff}
                  inputHistory={composerState.history[composerKey] ?? []}
                  onInputSubmitted={recordComposerInput}
                  teamModeOff={composerTeamModeOff}
                  workspaceDir={selectedSession?.workspaceDir ?? newTaskWorkspaceDir}
                  onSelectSession={handleSelectComposerSession}
                  onOpenPluginManagement={openPluginManagement}
                  onSessionCreated={handleSessionCreatedViewEffect}
                /></WebuiZoneBoundary></Composer>
                {selectedSessionId && loadMessages ? <Transcript><WebuiZoneBoundary
                  zone="transcript"
                  onReset={() => application.transcriptHistory.refreshPage(selectedSessionId)}
                ><WebuiSessionTranscript
                  sessionId={selectedSessionId}
                  workspaceDir={selectedSession?.workspaceDir}
                  onOpenFile={({ sessionId, workspaceDir, reference }) => dispatchWorkspacePanel({ type: "open-file", sessionId, workspaceDir, path: reference.path, ...(reference.lineStart !== undefined ? { lineStart: reference.lineStart } : {}), ...(reference.lineEnd !== undefined ? { lineEnd: reference.lineEnd } : {}) })}
                  onOpenTurnReview={(command) => dispatchWorkspacePanel(command)}
                  {...(initialMessages ? { initialMessages } : {})}
                  transcriptCommands={transcriptCommandsWithForkNavigation}
                  answerPlanBuild={planReviewWorkflow.answerPlanBuild}
                  onOpenPlanFile={({ sessionId: planSessionId, path, content }) => dispatchWorkspacePanel({ type: "open-plan-file", sessionId: planSessionId, workspaceDir: selectedSession?.workspaceDir ?? "", path, content })}
                /></WebuiZoneBoundary></Transcript> : null}
              </>}
              progressPanel={progressPanelContent}
              workspacePanel={workspacePanel.open ? <WebuiZoneBoundary zone="workspace"><WebuiWorkspacePanel
                state={workspacePanel} dispatch={dispatchWorkspacePanel} sessionId={selectedSessionId}
                workspaceDir={selectedSession?.workspaceDir} workspaceFileUrl={workspacePort.workspaceFileUrl}
                terminal={terminalOwner} onClose={() => dispatchWorkspacePanel({ type: "close-panel" })}
              /></WebuiZoneBoundary> : undefined}
            />
            </>}
          </main>
        </div>
      </div>
    </div>
    </ArchonShell>
    </WebuiApplicationProvider>
    </WebuiSessionWorkflowsProvider>
    </WebuiPluginWorkflowsProvider>
    </WebuiSettingsWorkflowsProvider>
    </WebuiModelsWorkflowsProvider>
    </WebuiAccountWorkflowsProvider>
    </WebuiWorkspaceQueriesProvider>
    </WebuiBrowserAuthorizationProvider>
      </WebuiPortSlicesProvider>
    </>
  );
}

export default WebuiClientFoundationApp;
