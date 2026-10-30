/**
 * The rail's own state and affordances: collapse, session search, the
 * per-session and per-project overlays (pins and project names), and the
 * row actions the list dispatches.
 *
 * Extracted from `WebuiClientFoundationApp.tsx`. Everything here changes when
 * the rail changes — its search, its overlays, its row actions — and nothing
 * else does; the shell frame keeps the layout and hands the hook the list it
 * renders plus the two setters it needs.
 *
 * The overlays are browser-local by design: they are display preferences, not
 * session facts, so they live in `browserStorage` and never reach the host. The
 * actions that do change host state go through the session workflows, which own
 * the RPC, its error state and the refresh.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import type { WebuiProjectGroup } from "../features/sessions/projection/rail-groups.js";
import {
  filterWebuiSessionsByQuery,
  sessionLabel,
} from "../features/sessions/projection/rail-groups.js";
import type {
  WebuiClientSession,
  WebuiClientSessionPage,
} from "../features/sessions/contracts/session-view.js";
import type { selectWebuiCatalogTreePage } from "../features/sessions/application/session-catalog.public.js";
import { sessionHash } from "../projection/common/router.js";
import {
  useSessionRailPins,
  type WebuiRailPinStorage,
} from "../features/sessions/bindings/use-session-rail-pins.js";

/** The tree page's shape, taken from the selector that builds it. */
export type WebuiRailTreePage = ReturnType<typeof selectWebuiCatalogTreePage>;

/**
 * The session mutations the rail's rows dispatch, stated as the surface used:
 * the shell may not reach into the workflows assembly (role rule), and the
 * workflows are handed down as a capability.
 */
export interface WebuiRailWorkflows {
  readonly canMutate: boolean;
  readonly canFork: boolean;
  rename(sessionId: string, title: string): Promise<unknown>;
  archive(sessionId: string): Promise<unknown>;
  archiveMany(sessionIds: readonly string[]): Promise<unknown>;
  fork(sessionId: string, createIsolatedWorktree: boolean): Promise<{ sessionId?: string } | undefined>;
  remove(sessionId: string): Promise<unknown>;
  importSession(
    file: File,
    context: { agentName: string; workspaceDir: string | undefined },
  ): Promise<{ sessionId: string }>;
  /**
   * Export one session as a transfer file. The rail submits the request and the
   * sessions owner starts the download through the adapter the composition root
   * injected: navigating is platform IO, and a view may not hold it.
   */
  exportSession(sessionId: string): void;
  refresh(): Promise<unknown>;
}

export interface UseSessionRailActionsOptions {
  readonly page: WebuiClientSessionPage;
  readonly treePage: WebuiRailTreePage;
  /** The browser storage the overlays are read through, injected. */
  readonly storage: WebuiRailPinStorage;
  readonly workflows: WebuiRailWorkflows;
  readonly selectedSessionId: string | undefined;
  readonly selectedSession: WebuiClientSession | undefined;
  readonly selectSession: (sessionId: string | undefined) => void;
  readonly setPageError: (message: string) => void;
}

export interface SessionRailActions {
  readonly railCollapsed: boolean;
  readonly setRailCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  readonly railSearchOpen: boolean;
  readonly railSearchQuery: string;
  readonly setRailSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  readonly railSearchInputRef: { current: HTMLInputElement | null };
  readonly sessionImportInputRef: { current: HTMLInputElement | null };
  readonly openSessionImportPicker: () => void;
  readonly sessionImportBusy: boolean;
  readonly openRailSearch: () => void;
  readonly closeRailSearch: () => void;
  readonly railPage: WebuiClientSessionPage;
  readonly railTreePage: WebuiRailTreePage | undefined;
  readonly pinnedSessions: Record<string, boolean>;
  readonly pinnedProjects: Record<string, boolean>;
  readonly projectNames: Record<string, string>;
  readonly onRenameProject: (project: WebuiProjectGroup) => void;
  readonly onToggleProjectPin: (project: WebuiProjectGroup) => void;
  readonly onArchiveProject: (project: WebuiProjectGroup) => void;
  readonly onRenameSession: (session: WebuiClientSession) => void;
  readonly onToggleSessionPin: (session: WebuiClientSession) => void;
  readonly onArchiveSession: (session: WebuiClientSession) => void;
  readonly onForkSession: (session: WebuiClientSession, createIsolatedWorktree: boolean) => void;
  readonly onCopySession: (session: WebuiClientSession, value: "workspaceDir" | "sessionId") => void;
  readonly onExportSession: (session: WebuiClientSession) => void;
  readonly onDeleteSession: (session: WebuiClientSession) => void;
  readonly onSessionImportPicked: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useSessionRailActions({
  page,
  treePage,
  storage,
  workflows,
  selectedSessionId,
  selectedSession,
  selectSession,
  setPageError,
}: UseSessionRailActionsOptions): SessionRailActions {
  // The overlay state itself belongs to Sessions and is read through that
  // feature's own binding; this hook keeps the rail's UI state and actions.
  const overlays = useSessionRailPins(storage);
  const { pinnedSessions, pinnedProjects, projectNames } = overlays;
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
  // loses every node falls back to the session page rather than rendering empty.
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
  const refreshRail = async () => {
    await workflows.refresh();
  };
  const fail = (reason: unknown) =>
    setPageError(reason instanceof Error ? reason.message : String(reason));
  const handleRenameProject = (project: WebuiProjectGroup) => {
    if (typeof window === "undefined") return;
    const next = window.prompt("重命名项目", projectNames[project.key] ?? project.name)?.trim();
    if (next) overlays.renameProject(project.key, next);
  };
  const handleToggleProjectPin = (project: WebuiProjectGroup) => {
    overlays.toggleProjectPin(project.key);
  };
  const handleRenameSession = (session: WebuiClientSession) => {
    if (!workflows.canMutate || typeof window === "undefined") return;
    const next = window.prompt("重命名", sessionLabel(session))?.trim();
    if (!next || next === sessionLabel(session)) return;
    void workflows
      .rename(session.sessionId, next)
      .then(() => refreshRail())
      .catch(fail);
  };
  const handleToggleSessionPin = (session: WebuiClientSession) => {
    overlays.toggleSessionPins("pins", session.sessionId);
  };
  const handleArchiveSession = (session: WebuiClientSession) => {
    void workflows.archive(session.sessionId).catch(fail);
  };
  const handleArchiveProject = (project: WebuiProjectGroup) => {
    const ids = new Set(project.sessionIds);
    for (const node of treePage.sessions) {
      if (!project.sessionIds.includes(node.session.sessionId)) continue;
      for (const child of node.childSessions) ids.add(child.sessionId);
    }
    void workflows.archiveMany([...ids]).catch(fail);
  };
  const handleForkSession = (session: WebuiClientSession, createIsolatedWorktree: boolean) => {
    if (!workflows.canFork) return;
    void workflows
      .fork(session.sessionId, createIsolatedWorktree)
      .then((forked) => {
        const id = forked?.sessionId;
        if (id) {
          selectSession(id);
          if (typeof window !== "undefined")
            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${window.location.search}${sessionHash(id)}`,
            );
        }
      })
      .catch(fail);
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
    // `session-transfer-download.ts` for why this is a navigation. The request
    // goes through the sessions owner rather than this view reaching the
    // platform adapter.
    try {
      workflows.exportSession(session.sessionId);
    } catch (reason: unknown) {
      fail(reason);
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
        const result = await workflows.importSession(file, {
          // The caller's context, never the file's session block: a downloaded
          // file must not be able to name the working directory.
          agentName: "main",
          workspaceDir: selectedSession?.workspaceDir,
        });
        await refreshRail();
        selectSession(result.sessionId);
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}${sessionHash(result.sessionId)}`,
          );
        }
      } catch (reason: unknown) {
        fail(reason);
      } finally {
        setSessionImportBusy(false);
      }
    })();
  };
  const handleDeleteSession = (session: WebuiClientSession) => {
    void workflows
      .remove(session.sessionId)
      .then(() => {
        if (selectedSessionId === session.sessionId) {
          selectSession(undefined);
          if (typeof window !== "undefined")
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
      })
      .catch(fail);
  };
  return {
    railCollapsed,
    setRailCollapsed,
    railSearchOpen,
    railSearchQuery,
    setRailSearchQuery,
    railSearchInputRef,
    sessionImportInputRef,
    openSessionImportPicker: () => sessionImportInputRef.current?.click(),
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
  };
}
