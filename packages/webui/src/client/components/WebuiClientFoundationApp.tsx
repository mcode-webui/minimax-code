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
  type ReactElement,
} from "react";
import { ArchonShell } from "./ArchonShell.js";
import {
  loadWebuiComposerPersisted,
  migrateWebuiHomeComposerState,
  recordWebuiInputHistory,
  saveWebuiComposerPersisted,
  WEBUI_COMPOSER_HOME_KEY,
  type WebuiComposerPersisted,
} from "../projection/composer-history.js";
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
  sessionHash,
  sessionLabel,
} from "./SessionRail.js";
import { RailRow } from "./RailRow.js";
import {
  WebuiIconBrand,
  WebuiIconNewTask,
  WebuiIconPlugins,
  WebuiIconRemote,
  WebuiIconSchedule,
  WebuiIconSearch,
  WebuiIconSidebarToggle,
  WebuiIconSites,
} from "../icons.js";
import type {
  WebuiClientSession,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
  WebuiClientProject,
  WebuiTransport,
} from "../contracts.js";
import type { WebuiTodo } from "./WorkspacePanels.js";
import type { WebuiUsageQuotaResult, WebuiVersionInfo } from "../../server/port.js";
import type {
  WebuiWorkspaceProgressState,
  WebuiWorkspaceSubagent,
} from "../projection/workspace-progress.js";
import type { WebuiProjectGroup } from "./SessionRail.js";
import { readNoProjectFlag, writeNoProjectFlag } from "../no-project.js";
import {
  readTeamModeOff,
  readTeamModeSessionChoices,
  writeTeamModeOff,
  writeTeamModeSessionChoice,
  type TeamModeSessionChoices,
} from "../team-mode.js";
import {
  initialWebuiWorkspaceProgress,
  projectWebuiWorkspaceHistory,
  webuiWorkspaceSubagentStatus,
} from "../projection/workspace-progress.js";
import {
  HOME_SESSION_RUNTIME_KEY,
  migrateSessionRuntimeState,
  useSessionRuntimeState,
} from "../session-runtime-store.js";
import { deriveConversationUsageNotice } from "../projection/message-projection.js";
import { deriveRecentWorkspaceDirs } from "../projection/composer-state.js";

/**
 * Hash helpers used by the shell. `main.tsx` also calls
 * `readSessionIdFromHash` for the SSR snapshot, so the symbol is re-exported
 * from `app.tsx` for back-compat (W2 moved it here from the original
 * `url.ts`; the Tier 5 move keeps it co-located with `WebuiClientFoundationApp`).
 */
export function readSessionIdFromHash(hash: string): string | undefined {
  const params = new URLSearchParams(
    hash.startsWith("#") ? hash.slice(1) : hash,
  );
  const id = params.get("session");
  return id?.trim() || undefined;
}

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
  readonly initialMessages?: import("../contracts.js").WebuiClientMessagePage;
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

export function subscribeToSessionHash(
  onChange: (sessionId: string | undefined) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onHashChange = () =>
    onChange(readSessionIdFromHash(window.location.hash));
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
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
  } = props;
  // Each method comes from `transport`. Re-binding to the same local
  // name as before keeps the rest of the function body identical.
  // Local rebinds: each name below is consumed by a shell-side effect or
  // handler below this declaration, so it is a real local capability, not
  // a pure conduit. Everything else that used to be rebound here is now
  // read directly off `transport` at the JSX consumption point — see the
  // 67-rebind classification table in the revision report.
  const loadSessions = transport?.loadSessions;
  const loadSessionTree = transport?.loadSessionTree;
  const loadMessages = transport?.loadMessages;
  const getUsageQuota = transport?.getUsageQuota;
  const getVersion = transport?.version;
  const archiveSession = transport?.archiveSession;
  const deleteSession = transport?.deleteSession;
  const updateSession = transport?.updateSession;
  const getSessionForkOptions = transport?.getSessionForkOptions;
  const forkSession = transport?.forkSession;
  const loadProjects = transport?.loadProjects;

  const [runtimeVersion, setRuntimeVersion] = useState(version);
  useEffect(() => { if (!runtimeVersion && getVersion) void getVersion().then(setRuntimeVersion); }, [getVersion, runtimeVersion]);
  const [page, setPage] = useState<WebuiClientSessionPage>(
    sessionPage ?? { sessions: [], hasMore: false },
  );
  const [projectRecords, setProjectRecords] = useState<readonly WebuiClientProject[] | undefined>();
  const [treePage, setTreePage] = useState<WebuiClientSessionTreePage>(
    () => ({ sessions: [], hasMore: false }),
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!loadProjects) return;
    let cancelled = false;
    void loadProjects().then((projects) => {
      if (!cancelled) setProjectRecords(projects);
    }).catch(() => {
      // Keep the session-derived view available when a runtime predates the
      // project-list operation.
    });
    return () => { cancelled = true; };
  }, [loadProjects]);
  // Which surface the main column renders. Plugin management replaces the
  // conversation rather than floating above it, so the rail stays the only way
  // back out of it — every conversation navigation has to return here.
  const [shellSurface, setShellSurface] = useState(initialWebuiShellSurface);
  const dispatchShellSurface = useCallback((command: WebuiShellSurfaceCommand) => {
    setShellSurface((current) => reduceWebuiShellSurface(current, command));
  }, []);
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
  // 输入历史/草稿). One persisted store keyed by session (home has its own
  // slot), so a draft survives both a session switch and a reload, and ↑ in
  // the composer recalls that session's submitted inputs. The store is
  // best-effort: `localStorage` unavailability degrades to memory.
  const [composerStore, setComposerStore] = useState<WebuiComposerPersisted>(
    () => loadWebuiComposerPersisted(),
  );
  const composerKey = selectedSessionId ?? WEBUI_COMPOSER_HOME_KEY;
  const composerKeyRef = useRef(composerKey);
  composerKeyRef.current = composerKey;
  const draft = composerStore.drafts[composerKey] ?? "";
  // One updater for every composer-store write: apply the change, persist,
  // and keep the named slot alive through the prune. `keepKeys` matters
  // because the store's prune keeps the newest-inserted slots, and an
  // active session's slot does not re-insert merely by being written to.
  const applyComposerStore = useCallback(
    (
      update: (current: WebuiComposerPersisted) => WebuiComposerPersisted,
      keepKey: string,
    ) => {
      setComposerStore((current) => {
        const state = update(current);
        if (state === current) return current;
        saveWebuiComposerPersisted(state, undefined, [keepKey]);
        return state;
      });
    },
    [],
  );
  const setDraft = useCallback(
    (next: string) => {
      applyComposerStore((current) => {
        const drafts = { ...current.drafts };
        if (next) drafts[composerKeyRef.current] = next;
        else delete drafts[composerKeyRef.current];
        return { ...current, drafts };
      }, composerKeyRef.current);
    },
    [applyComposerStore],
  );
  // Recording rides the same store: a committed submission lands in the
  // current slot's history (home while no session exists yet; the created
  // session inherits the entry below in `handleSessionCreated`).
  const recordComposerInput = useCallback(
    (text: string) => {
      applyComposerStore((current) => {
        const key = composerKeyRef.current;
        const history = {
          ...current.history,
          [key]: recordWebuiInputHistory(current.history[key] ?? [], text),
        };
        return { ...current, history };
      }, composerKeyRef.current);
    },
    [applyComposerStore],
  );
  const [teamModeOff, setTeamModeOff] = useState(readTeamModeOff);
  const [teamModeChoices, setTeamModeChoices] =
    useState<TeamModeSessionChoices>(readTeamModeSessionChoices);
  const [pageError, setPageError] = useState<string | undefined>();
  const [usageQuota, setUsageQuota] = useState<WebuiUsageQuotaResult | undefined>(
    () => initialUsageQuota,
  );
  const [dismissedUsageNoticeKey, setDismissedUsageNoticeKey] = useState<
    string | undefined
  >();
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, boolean>>(
    readSessionOverlay("pins"),
  );
  const [pinnedProjects, setPinnedProjects] = useState<Record<string, boolean>>(
    readProjectPins,
  );
  const [projectNames, setProjectNames] = useState<Record<string, string>>(
    readProjectNames,
  );
  const selectedRuntimeState = useSessionRuntimeState(selectedSessionId).state;
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
            (result.messages ?? []) as unknown as readonly import("../contracts.js").WebuiClientMessage[],
            selectedSessionId,
          ),
        );
    }).catch(() => { if (!cancelled) setHistoryProgress(initialWebuiWorkspaceProgress); });
    return () => { cancelled = true; };
  }, [loadMessages, selectedSessionId]);
  useEffect(() => {
    writeTeamModeOff(teamModeOff);
  }, [teamModeOff]);
  useEffect(() => {
    if (!loadSessions || sessionPage) return;
    let cancelled = false;
    setLoading(true);
    void loadSessions()
      .then((nextPage) => {
        if (!cancelled) {
          setPage(nextPage);
          setPageError(undefined);
        }
      })
      .catch((reason: unknown) => {
        // Without this the rail renders "No sessions yet." for a list that never
        // loaded, which reads as "you have no sessions" rather than as a failure.
        if (!cancelled)
          setPageError(
            reason instanceof Error ? reason.message : String(reason),
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions, sessionPage]);
  // Tree projection (root + children) for the rail. Loaded in parallel with
  // the flat session list — the flat list still drives selected-session
  // lookups so the home workspace auto-fill keeps working, but the rail
  // prefers this shape so sub-agent sessions under a root are visible.
  useEffect(() => {
    if (!loadSessionTree || sessionPage) return;
    let cancelled = false;
    void loadSessionTree()
      .then((next) => {
        if (!cancelled) setTreePage(next);
      })
      .catch(() => {
        // Tree projection is optional; ignore failures so a runtime without
        // child-session support does not break the flat-list rail.
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessionTree, sessionPage]);
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
  const progressTodos: readonly WebuiTodo[] =
    selectedRuntimeState.stream.workspaceProgress.hasTodoSnapshot
      ? selectedRuntimeState.stream.workspaceProgress.todos
      : historyProgress.todos;
  const progressSubagents = useMemo<readonly WebuiWorkspaceSubagent[]>(() => {
    const merged = new Map<string, WebuiWorkspaceSubagent>();
    for (const subagent of historyProgress.subagents) merged.set(subagent.sessionId, subagent);
    for (const subagent of treeSubagents) merged.set(subagent.sessionId, subagent);
    for (const subagent of selectedRuntimeState.stream.workspaceProgress.subagents)
      merged.set(subagent.sessionId, { ...merged.get(subagent.sessionId), ...subagent });
    return [...merged.values()].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  }, [historyProgress.subagents, selectedRuntimeState.stream.workspaceProgress.subagents, treeSubagents]);
  const loadMore =
    loadSessions && page.hasMore
      ? () => {
          setLoading(true);
          void loadSessions(page.nextCursor)
            .then((nextPage) => {
              setPage((current) => ({
                sessions: [...current.sessions, ...nextPage.sessions],
                hasMore: nextPage.hasMore,
                nextCursor: nextPage.nextCursor,
              }));
            })
        .finally(() => setLoading(false));
        }
      : undefined;
  const refreshRail = async () => {
    const [nextPage, nextTree] = await Promise.all([
      loadSessions?.(),
      loadSessionTree?.(),
    ]);
    if (nextPage) {
      setPage(nextPage);
      setPageError(undefined);
    }
    if (nextTree) setTreePage(nextTree);
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
    if (!updateSession || typeof window === "undefined") return;
    const next = window.prompt("重命名", sessionLabel(session))?.trim();
    if (!next || next === sessionLabel(session)) return;
    void updateSession({ id: session.sessionId, title: next })
      .then((result) => {
        const title = result.session?.title;
        if (title) {
          setPage((current) => ({
            ...current,
            sessions: current.sessions.map((candidate) =>
              candidate.sessionId === session.sessionId ? { ...candidate, title } : candidate,
            ),
          }));
          setTreePage((current) => ({
            ...current,
            sessions: current.sessions.map((node) => ({
              ...node,
              session: node.session.sessionId === session.sessionId ? { ...node.session, title } : node.session,
              childSessions: node.childSessions.map((candidate) =>
                candidate.sessionId === session.sessionId ? { ...candidate, title } : candidate,
              ),
            })),
          }));
        }
        return refreshRail();
      })
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleToggleSessionPin = (session: WebuiClientSession) => {
    setPinnedSessions(toggleSessionOverlay("pins", session.sessionId));
  };
  const handleArchiveSession = (session: WebuiClientSession) => {
    if (!archiveSession) return;
    void archiveSession({ id: session.sessionId })
      .then(() => refreshRail())
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleArchiveProject = (project: WebuiProjectGroup) => {
    if (!archiveSession) return;
    const ids = new Set(project.sessionIds);
    for (const node of treePage.sessions) {
      if (!project.sessionIds.includes(node.session.sessionId)) continue;
      for (const child of node.childSessions) ids.add(child.sessionId);
    }
    void Promise.all([...ids].map((id) => archiveSession({ id })))
      .then(() => refreshRail())
      .catch((reason: unknown) => setPageError(reason instanceof Error ? reason.message : String(reason)));
  };
  const handleForkSession = (session: WebuiClientSession, createIsolatedWorktree: boolean) => {
    if (!forkSession) return;
    void (async () => {
      const options = await getSessionForkOptions?.({ id: session.sessionId });
      if (options && !options.canFork)
        throw new Error(`当前会话不可复制：${options.unavailableReason ?? "没有可复制的消息边界"}`);
      if (createIsolatedWorktree && options && !options.worktreeVisible)
        throw new Error(`当前会话不可复制到新工作树：${options.worktreeUnavailableReason ?? "工作树不可用"}`);
      return forkSession({
        id: session.sessionId,
        clientRequestId: globalThis.crypto.randomUUID(),
        useSuggestedTitle: true,
        createIsolatedWorktree,
      });
    })()
      .then(async (result) => {
        await refreshRail();
        const id = result.session?.sessionId;
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
  const handleDeleteSession = (session: WebuiClientSession) => {
    if (!deleteSession) return;
    void deleteSession({ id: session.sessionId })
      .then(async () => {
        if (selectedSessionId === session.sessionId) {
          setSelectedSessionId(undefined);
          if (typeof window !== "undefined") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
        await refreshRail();
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
    homeMode && loadSessions !== undefined && page.sessions.length === 0 && loading;
  const selectedSession = flatSessionsWithChildren.find(
    (session) => session.sessionId === selectedSessionId,
  );
  const [newTaskWorkspaceDir, setNewTaskWorkspaceDir] = useState<string | undefined>(
    () => {
      // Honour an explicit "no project" choice from localStorage so the
      // auto-fill below doesn't immediately pull a workspace back.
      if (readNoProjectFlag()) return undefined;
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
  const userClearedWorkspaceRef = useRef(readNoProjectFlag());
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
        writeNoProjectFlag(true);
      } else {
        userClearedWorkspaceRef.current = false;
        writeNoProjectFlag(false);
      }
      setNewTaskWorkspaceDir(workspaceDir);
      setWorkspaceMenuOpen(false);
    },
    [],
  );
  const handleSessionCreated = (id: string) => {
    // The first turn streams into the home key before the session exists;
    // carry it (and the sending flag) across the view switch so the reply
    // stays on screen, and leave home clean.
    migrateSessionRuntimeState(HOME_SESSION_RUNTIME_KEY, id);
    // The composer store follows the same home → session migration: the
    // input just submitted was recorded under the home slot, and the new
    // session's history (and any unsent draft) should own it from here on.
    // `keepKey` is the NEW session id — `composerKeyRef` still reads "home"
    // until the next render, and home is being deleted anyway.
    applyComposerStore(
      (current) => migrateWebuiHomeComposerState(current, id),
      id,
    );
    setSelectedSessionId(id);
    writeTeamModeSessionChoice(id, teamModeOff);
    setTeamModeChoices((current) => ({ ...current, [id]: teamModeOff }));
    // Refresh the project projection after the first message creates a session.
    if (loadSessions)
      void loadSessions()
        .then((nextPage) => {
          setPage(nextPage);
          setPageError(undefined);
        })
        .catch((reason: unknown) =>
          setPageError(reason instanceof Error ? reason.message : String(reason)),
        );
    if (loadSessionTree)
      void loadSessionTree()
        .then(setTreePage)
        .catch(() => undefined);
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
    writeNoProjectFlag(clearedWorkspace);
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
  const pluginManagementArea = webuiPluginManagementArea(shellSurface);
  const pluginManagementOpen = isPluginManagementSurface(shellSurface);
  const openPluginManagement = useCallback((area: WebuiPluginManagementArea) => {
    dispatchShellSurface({ type: "open-plugin-management", area });
  }, [dispatchShellSurface]);
  const [workspacePanelStates, setWorkspacePanelStates] = useState<WorkspacePanelSessionStates>(() => new Map());
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

  const progressPanelContent = <WebuiProgressOverviewPanel workspaceDir={selectedSession?.workspaceDir} isDefaultWorkspace={selectedSession?.isDefaultWorkspace} todos={progressTodos} subagents={progressSubagents} showProgress={!homeMode} showEmptyProgress={true} getWorkspaceEnvironment={transport?.getWorkspaceEnvironment} watchEvents={transport?.watchEvents} mutateWorkspaceGit={transport?.mutateWorkspaceGit} environmentCollapsed={workspaceEnvironmentCollapsed} progressCollapsed={workspaceProgressCollapsed} subagentsCollapsed={workspaceSubagentsCollapsed} onToggleEnvironment={() => setWorkspaceEnvironmentCollapsed((value) => !value)} onToggleProgress={() => setWorkspaceProgressCollapsed((value) => !value)} onToggleSubagents={() => setWorkspaceSubagentsCollapsed((value) => !value)} onMemberClick={handleWorkspaceSubagentClick} onOpenChanges={() => selectedSession?.workspaceDir && selectedSessionId ? dispatchWorkspacePanel({ type: "open-workspace-review", sessionId: selectedSessionId, workspaceDir: selectedSession.workspaceDir }) : undefined} onOpenTerminal={() => dispatchWorkspacePanel({ type: "open-tab", kind: "terminal", workspaceDir: selectedSession?.workspaceDir })} />;

  return (
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
            data-webui-placeholder-chrome="search"
            aria-disabled="true"
            aria-label="搜索"
            disabled
            className="pointer-events-auto flex size-[30px] cursor-default items-center justify-center rounded-lg text-text_default_tertiary opacity-70"
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
                  </div>

                  <div className="relative min-h-0 flex-1">
                    <div className="webui-rail-scroll h-full overflow-x-hidden overflow-y-auto px-4">
                      <div className="space-y-px pb-2">
                        <RailRow label="插件" icon={<WebuiIconPlugins />} active={pluginManagementOpen} onSelect={() => openPluginManagement("plugins")} />
                        <RailRow label="定时" icon={<WebuiIconSchedule />} inert />
                        <RailRow label="网站" icon={<WebuiIconSites />} inert />
                        <RailRow label="远程" icon={<WebuiIconRemote />} inert />
                      </div>

                      <WebuiProjectList
                        page={page}
                        treePage={treePage.sessions.length > 0 ? treePage : undefined}
                        projectRecords={projectRecords}
                        loading={loading}
                        onLoadMore={loadMore}
                        selectedSessionId={selectedSessionId}
                        onProjectSelect={setNewTaskWorkspaceDir}
                        onCreateTaskInProject={(project) => startNewTask(project.workspaceDir)}
                        error={pageError}
                        pinnedSessions={pinnedSessions}
                        pinnedProjects={pinnedProjects}
                        projectNames={projectNames}
                        onRenameProject={handleRenameProject}
                        onToggleProjectPin={handleToggleProjectPin}
                        onArchiveProject={handleArchiveProject}
                        onRenameSession={handleRenameSession}
                        onToggleSessionPin={handleToggleSessionPin}
                        onArchiveSession={handleArchiveSession}
                        onForkSession={handleForkSession}
                        onCopySession={handleCopySession}
                        onDeleteSession={handleDeleteSession}
                      />
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
                  transport={transport}
                  getSigninPanel={transport?.getSigninPanel}
                  claimSignin={transport?.claimSignin}
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
            {pluginManagementArea ? <PluginManagement transport={transport} initialArea={pluginManagementArea} onChatWithAgent={async (name) => {
              if (!transport?.createSession) throw new Error("当前 WebUI 未连接会话创建服务");
              const created = await transport.createSession({ name });
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
                    createSession={transport?.createSession}
                    createSessionWorkspaceDir={newTaskWorkspaceDir}
                    onWorkspaceChange={handleWorkspaceChange}
                    workspaceMenuOpen={workspaceMenuOpen}
                    setWorkspaceMenuOpen={setWorkspaceMenuOpen}
                    recentWorkspaceDirs={recentWorkspaceDirs}
                    runCommand={transport?.runCommand}
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
                    watchEvents={transport?.watchEvents}
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
                    inputHistory={composerStore.history[composerKey] ?? []}
                    onInputSubmitted={recordComposerInput}
                    teamModeOff={composerTeamModeOff}
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
            {!homeMode && workspacePanel.open ? <WebuiWorkspacePanel state={workspacePanel} dispatch={dispatchWorkspacePanel} sessionId={selectedSessionId} workspaceDir={selectedSession?.workspaceDir} listWorkspaceFileTree={transport?.listWorkspaceFileTree} readWorkspaceFile={transport?.readWorkspaceFile} workspaceFileUrl={transport?.workspaceFileUrl} readWorkspaceArchive={transport?.readWorkspaceArchive} extractWorkspaceArchive={transport?.extractWorkspaceArchive} readCanvas={transport?.readCanvas} applyCanvas={transport?.applyCanvas} createTerminal={transport?.createTerminal} listTerminals={transport?.listTerminals} writeTerminal={transport?.writeTerminal} disposeTerminal={transport?.disposeTerminal} watchTerminal={transport?.watchTerminal} getWorkspaceReviewSummary={transport?.getWorkspaceReviewSummary} listWorkspaceReviewFileDiffs={transport?.listWorkspaceReviewFileDiffs} searchWorkspaceReviewDiffs={transport?.searchWorkspaceReviewDiffs} onClose={() => dispatchWorkspacePanel({ type: "close-panel" })} /> : null}
            </>}
          </main>
        </div>
      </div>
    </div>
    </ArchonShell>
  );
}

export default WebuiClientFoundationApp;
