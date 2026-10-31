// SessionRail — the rail listing projects + recent sessions.
//
// The grouping/labelling/search rules live in
// `features/sessions/projection/rail-groups.ts`; a project's expansion and
// the row context menu (`rail-context-menu.tsx`) and the activity meta line
// (`session-activity-meta.tsx`). What stays here is the two list surfaces and
// the state they own.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import {
  WebuiIconContextArchive,
  WebuiIconContextCopy,
  WebuiIconContextExport,
  WebuiIconContextFeedback,
  WebuiIconContextFork,
  WebuiIconContextPin,
  WebuiIconContextRename,
  WebuiIconContextTrash,
  WebuiIconFolder,
} from "../../../shell/icons.js";
import { type WebuiContextMenuItem } from "../../../ui/ContextMenu.js";
import type {
  WebuiClientSession,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
  WebuiClientProject,
} from "../contracts/session-view.js";
import { workspaceProjectName } from "../../workspace/projection/workspace-name.public.js";
import { ProjectList } from "./ProjectList.js";
import { RailContextMenu } from "./rail-context-menu.js";
import { RailRow } from "./RailRow.js";
import {
  PROJECT_SESSION_BATCH_SIZE,
  PROJECT_GROUP_BATCH_SIZE,
  filterWebuiSessionsByQuery,
  filterWebuiProjectsByQuery,
  groupWebuiSessionsByWorkspace,
  resolveDefaultExpandedProjectKey,
  type WebuiProjectGroup,
} from "../projection/rail-groups.js";
import {
  webuiRailMenuFor,
  type WebuiRailMenuEntry,
  type WebuiRailMenuSubject,
} from "../projection/rail-menu.js";
import { type WebuiSessionActivityMap } from "../projection/session-activity.js";
import { useRailContextMenu } from "../bindings/use-rail-context-menu.js";

/**
 * What the rail-menu wiring needs, gathered from the component's props and the
 * subject being opened for. `session` and `project` are optional because the two
 * menus use disjoint halves of it; each wiring entry reads the one its subject
 * supplies.
 */
interface RailMenuHandlers {
  readonly session?: WebuiClientSession;
  readonly project?: WebuiProjectGroup;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly hasWorkspaceDir: boolean;
  readonly onToggleSessionPin?: (session: WebuiClientSession) => void;
  readonly onRenameSession?: (session: WebuiClientSession) => void;
  readonly onArchiveSession?: (session: WebuiClientSession) => void;
  readonly onForkSession?: (
    session: WebuiClientSession,
    worktree: boolean,
  ) => void;
  readonly onCopySession?: (
    session: WebuiClientSession,
    kind: "sessionId" | "workspaceDir",
  ) => void;
  readonly onExportSession?: (session: WebuiClientSession) => void;
  readonly onDeleteSession?: (session: WebuiClientSession) => void;
  readonly onRenameProject?: (project: WebuiProjectGroup) => void;
  readonly onToggleProjectPin?: (project: WebuiProjectGroup) => void;
  readonly onArchiveProject?: (project: WebuiProjectGroup) => void;
}

export function WebuiProjectList({
  page,
  treePage,
  projectRecords,
  query,
  loading,
  onLoadMore,
  selectedSessionId,
  onProjectSelect,
  onCreateTaskInProject,
  error,
  projectLoadError,
  pinnedSessions,
  pinnedProjects,
  projectNames,
  teamModeLabel,
  onRenameProject,
  onToggleProjectPin,
  onArchiveProject,
  onRenameSession,
  onToggleSessionPin,
  onArchiveSession,
  onForkSession,
  onCopySession,
  onExportSession,
  onDeleteSession,
  activity,
  now,
}: {
  readonly page: WebuiClientSessionPage;
  readonly treePage?: WebuiClientSessionTreePage;
  readonly projectRecords?: readonly WebuiClientProject[];
  readonly query?: string;
  readonly loading: boolean;
  readonly onLoadMore?: () => void;
  readonly selectedSessionId?: string;
  readonly onProjectSelect?: (workspaceDir?: string) => void;
  readonly onCreateTaskInProject?: (project: WebuiProjectGroup) => void;
  readonly error?: string;
  readonly projectLoadError?: string;
  readonly pinnedSessions?: Readonly<Record<string, boolean>>;
  readonly pinnedProjects?: Readonly<Record<string, boolean>>;
  readonly projectNames?: Readonly<Record<string, string>>;
  readonly onRenameProject?: (project: WebuiProjectGroup) => void;
  readonly onToggleProjectPin?: (project: WebuiProjectGroup) => void;
  readonly onArchiveProject?: (project: WebuiProjectGroup) => void;
  readonly onRenameSession?: (session: WebuiClientSession) => void;
  readonly onToggleSessionPin?: (session: WebuiClientSession) => void;
  readonly onArchiveSession?: (session: WebuiClientSession) => void;
  readonly onForkSession?: (
    session: WebuiClientSession,
    createIsolatedWorktree: boolean,
  ) => void;
  readonly onCopySession?: (
    session: WebuiClientSession,
    value: "workspaceDir" | "sessionId",
  ) => void;
  readonly onExportSession?: (session: WebuiClientSession) => void;
  readonly onDeleteSession?: (session: WebuiClientSession) => void;
  /** Per-session running state and last-activity, for the row's right-hand end. */
  readonly activity?: WebuiSessionActivityMap;
  readonly now?: number;
  /**
   * The Agent Team badge's tooltip, injected by the composition root. A view may
   * not read the platform adapter that holds the team-mode choice, so whoever
   * renders the rail passes the label in.
   */
  readonly teamModeLabel?: string;
}): ReactElement {
  // Build a lookup from parent session id to its child sessions. When
  // `treePage` is provided, this lets the rail render child sessions under
  // each root.
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, readonly WebuiClientSession[]>();
    if (!treePage) return map;
    for (const node of treePage.sessions) {
      if (node.childSessions.length > 0) {
        map.set(node.session.sessionId, node.childSessions);
      }
    }
    return map;
  }, [treePage]);
  const projects = useMemo(() => {
    const grouped = projectRecords
      ? (() => {
          const sessionsByWorkspace = new Map<string, WebuiClientSession[]>();
          for (const session of page.sessions) {
            const key = session.isDefaultWorkspace
              ? "__webui_unassigned_project__"
              : session.workspaceDir?.trim() || "__webui_unassigned_project__";
            const values = sessionsByWorkspace.get(key) ?? [];
            values.push(session);
            sessionsByWorkspace.set(key, values);
          }
          return projectRecords
            .filter((project) => !project.hidden)
            .map((project) => {
              const key =
                project.workspaceDir ?? "__webui_unassigned_project__";
              const sessions = sessionsByWorkspace.get(key) ?? [];
              return {
                key,
                name: workspaceProjectName(project.workspaceDir ?? undefined),
                ...(project.workspaceDir
                  ? { workspaceDir: project.workspaceDir }
                  : {}),
                latestSessionId: sessions[0]?.sessionId ?? "",
                sessionIds: sessions.map(({ sessionId }) => sessionId),
                updatedAt: project.recentAtMs ?? project.latestActivityAtMs,
                pinned: project.pinned,
              };
            });
        })()
      : groupWebuiSessionsByWorkspace(page.sessions);
    return [...filterWebuiProjectsByQuery(grouped, query ?? "")].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }, [page.sessions, projectRecords, query]);
  const pinnedProjectGroups = useMemo(
    () => projects.filter((project) => Boolean(pinnedProjects?.[project.key] ?? project.pinned)),
    [projects, pinnedProjects],
  );
  const regularProjectGroups = useMemo(
    () => projects.filter((project) => !Boolean(pinnedProjects?.[project.key] ?? project.pinned)),
    [projects, pinnedProjects],
  );
  const pinnedSessionRows = useMemo(
    () =>
      [...filterWebuiSessionsByQuery(
        page.sessions.filter((session) => Boolean(pinnedSessions?.[session.sessionId])),
        query ?? "",
      )].sort((left, right) => right.updatedAt - left.updatedAt),
    [page.sessions, pinnedSessions, query],
  );
  const [pinnedSectionExpanded, setPinnedSectionExpanded] = useState(true);
  const [projectSectionExpanded, setProjectSectionExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 用户手动折叠过项目后，不再自动展开首个项目。
  const projectExpansionTouched = useRef(false);
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sessionExpansionTouched = useRef(false);
  const [visibleProjectSessionCounts, setVisibleProjectSessionCounts] =
    useState<Readonly<Record<string, number>>>({});
  const [visibleProjectCount, setVisibleProjectCount] = useState(PROJECT_GROUP_BATCH_SIZE);
  const menuAttachment = useRailContextMenu();
  const sessionsById = useMemo(
    () => new Map(page.sessions.map((session) => [session.sessionId, session])),
    [page.sessions],
  );

  const contextMenu = menuAttachment.menu;

  /**
   * The host render branch for the rail's context menu. What the menu *is* lives
   * in `projection/rail-menu.ts`; what each declared key *does* — its icon,
   * whether it is enabled, and what it calls — is this one table. A second place
   * that enumerates the items is forbidden, so the two builders below read the
   * registry and nothing here lists a label.
   */
  const railMenuWiring: Readonly<
    Record<
      string,
      {
        readonly icon: (handlers: RailMenuHandlers) => ReactElement;
        readonly enabled: (handlers: RailMenuHandlers) => boolean;
        readonly select?: (handlers: RailMenuHandlers) => () => void;
      }
    >
  > = {
    rename: {
      icon: () => <WebuiIconContextRename />,
      enabled: (h) => Boolean(h.onRenameSession),
      select: (h) => () => h.onRenameSession?.(h.session as WebuiClientSession),
    },
    archive: {
      icon: () => <WebuiIconContextArchive />,
      enabled: (h) => Boolean(h.onArchiveSession),
      select: (h) => () =>
        h.onArchiveSession?.(h.session as WebuiClientSession),
    },
    "fork-current": {
      icon: () => <WebuiIconContextFork />,
      enabled: (h) => Boolean(h.onForkSession),
      select: (h) => () =>
        h.onForkSession?.(h.session as WebuiClientSession, false),
    },
    "fork-worktree": {
      icon: () => <WebuiIconContextFork />,
      enabled: (h) => Boolean(h.onForkSession),
      select: (h) => () =>
        h.onForkSession?.(h.session as WebuiClientSession, true),
    },
    "show-folder": { icon: () => <WebuiIconFolder />, enabled: () => false },
    copy: { icon: () => <WebuiIconContextCopy />, enabled: () => true },
    "copy-workspace-dir": {
      icon: () => <WebuiIconContextCopy />,
      enabled: (h) => h.hasWorkspaceDir && Boolean(h.onCopySession),
      select: (h) => () =>
        h.onCopySession?.(h.session as WebuiClientSession, "workspaceDir"),
    },
    "copy-session-id": {
      icon: () => <WebuiIconContextCopy />,
      enabled: (h) => Boolean(h.onCopySession),
      select: (h) => () =>
        h.onCopySession?.(h.session as WebuiClientSession, "sessionId"),
    },
    export: {
      icon: () => <WebuiIconContextExport />,
      enabled: (h) => Boolean(h.onExportSession),
      select: (h) => () => h.onExportSession?.(h.session as WebuiClientSession),
    },
    feedback: {
      icon: () => <WebuiIconContextFeedback />,
      enabled: () => false,
    },
    delete: {
      icon: () => <WebuiIconContextTrash />,
      enabled: (h) => Boolean(h.onDeleteSession),
      select: (h) => () => h.onDeleteSession?.(h.session as WebuiClientSession),
    },
    "rename-project": {
      icon: () => <WebuiIconContextRename />,
      enabled: (h) => Boolean(h.onRenameProject),
      select: (h) => () => h.onRenameProject?.(h.project as WebuiProjectGroup),
    },
    "toggle-pin-project": {
      icon: (h) => <WebuiIconContextPin pinned={h.pinned} />,
      enabled: (h) => Boolean(h.onToggleProjectPin),
      select: (h) => () =>
        h.onToggleProjectPin?.(h.project as WebuiProjectGroup),
    },
    "show-project-in-folder": {
      icon: () => <WebuiIconFolder />,
      enabled: () => false,
    },
    "archive-project-sessions": {
      icon: () => <WebuiIconContextArchive />,
      enabled: (h) => Boolean(h.onArchiveProject),
      select: (h) => () => h.onArchiveProject?.(h.project as WebuiProjectGroup),
    },
    "remove-project": {
      icon: () => <WebuiIconContextTrash />,
      enabled: () => false,
    },
  };

  const buildRailMenu = (
    subject: WebuiRailMenuSubject,
    handlers: RailMenuHandlers,
  ): readonly WebuiContextMenuItem[] => {
    const render = (entry: WebuiRailMenuEntry): WebuiContextMenuItem => {
      if (entry.kind === "divider") return { kind: "divider", key: entry.key };
      const wiring = railMenuWiring[entry.key];
      const enabled =
        entry.unwired !== true &&
        wiring !== undefined &&
        wiring.enabled(handlers);
      return {
        kind: "item",
        key: entry.key,
        label:
          typeof entry.label === "string"
            ? entry.label
            : (entry.label?.({
                pinned: handlers.pinned,
                archived: handlers.archived,
              }) ?? entry.key),
        ...(wiring ? { icon: wiring.icon(handlers) } : {}),
        ...(entry.danger ? { danger: true } : {}),
        ...(enabled ? {} : { disabled: true }),
        ...(enabled && wiring?.select
          ? { onSelect: wiring.select(handlers) }
          : {}),
        ...(entry.submenu ? { submenu: entry.submenu.map(render) } : {}),
      };
    };
    return webuiRailMenuFor(subject, {
      pinned: handlers.pinned,
      archived: handlers.archived,
    }).map(render);
  };

  const openSessionMenu = (
    event: MouseEvent<HTMLElement>,
    session: WebuiClientSession,
    isChild = false,
  ) => {
    menuAttachment.open(
      event,
      buildRailMenu(isChild ? "child-session" : "session", {
        session,
        pinned: Boolean(pinnedSessions?.[session.sessionId]),
        archived: Boolean(session.archived),
        hasWorkspaceDir: Boolean(session.workspaceDir),
        onToggleSessionPin,
        onRenameSession,
        onArchiveSession,
        onForkSession,
        onCopySession,
        onExportSession,
        onDeleteSession,
      }),
    );
  };

  const openProjectMenu = (
    event: MouseEvent<HTMLElement>,
    project: WebuiProjectGroup,
  ) => {
    if (!project.workspaceDir) return;
    menuAttachment.open(
      event,
      buildRailMenu("project", {
        project,
        pinned: Boolean(pinnedProjects?.[project.key]),
        archived: false,
        hasWorkspaceDir: true,
        onRenameProject,
        onToggleProjectPin,
        onArchiveProject,
      }),
    );
  };

  useEffect(() => {
    const key = resolveDefaultExpandedProjectKey(
      projects,
      selectedSessionId,
      projectExpansionTouched.current,
    );
    if (!key) return;
    setExpandedProjects((current) => {
      if (current.has(key)) return current;
      return new Set(current).add(key);
    });
  }, [projects, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const activeProject = projects.find((project) =>
      project.sessionIds.includes(selectedSessionId),
    );
    if (!activeProject) return;
    setExpandedProjects((current) => {
      if (current.has(activeProject.key)) return current;
      return new Set(current).add(activeProject.key);
    });
  }, [projects, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !treePage) return;
    const parent = treePage.sessions.find((node) =>
      node.childSessions.some((child) => child.sessionId === selectedSessionId),
    );
    if (!parent) return;
    setExpandedSessions((current) =>
      current.has(parent.session.sessionId)
        ? current
        : new Set(current).add(parent.session.sessionId),
    );
  }, [selectedSessionId, treePage]);

  // Render the automatic initial expansion in the same pass as the project
  // rows. Waiting for the effects below paints the project closed first, then
  // opens it on the next frame, which looks like a flash during rail startup.
  const autoExpandedProjectKey = selectedSessionId
    ? projects.find((project) => project.sessionIds.includes(selectedSessionId))?.key
    : resolveDefaultExpandedProjectKey(projects, undefined, projectExpansionTouched.current);
  const expandedProjectsForRender =
    !projectExpansionTouched.current &&
    autoExpandedProjectKey &&
    !expandedProjects.has(autoExpandedProjectKey)
      ? new Set(expandedProjects).add(autoExpandedProjectKey)
      : expandedProjects;
  const selectedChildParentId = selectedSessionId && treePage
    ? treePage.sessions.find((node) =>
        node.childSessions.some((child) => child.sessionId === selectedSessionId),
      )?.session.sessionId
    : undefined;
  const expandedSessionsForRender =
    !sessionExpansionTouched.current &&
    selectedChildParentId &&
    !expandedSessions.has(selectedChildParentId)
      ? new Set(expandedSessions).add(selectedChildParentId)
      : expandedSessions;

  return (
    <section data-webui-project-list="true">
      <ProjectList
        projects={regularProjectGroups}
        pinnedProjectGroups={pinnedProjectGroups}
        pinnedSessions={pinnedSessionRows}
        pinnedSectionExpanded={pinnedSectionExpanded}
        projectSectionExpanded={projectSectionExpanded}
        projectLoading={loading}
        hasMoreProjects={
          regularProjectGroups.length > visibleProjectCount ||
          (page.hasMore && Boolean(onLoadMore))
        }
        visibleProjectCount={visibleProjectCount}
        onTogglePinnedSection={() => setPinnedSectionExpanded((expanded) => !expanded)}
        onToggleProjectSection={() => setProjectSectionExpanded((expanded) => !expanded)}
        onShowMoreProjects={() => {
          setVisibleProjectCount((current) => current + PROJECT_GROUP_BATCH_SIZE);
          if (page.hasMore) onLoadMore?.();
        }}
        page={page}
        sessionsById={sessionsById}
        childrenByParentId={childrenByParentId}
        selectedSessionId={selectedSessionId}
        projectNames={projectNames}
        pinnedSessionState={pinnedSessions}
        pinnedProjects={pinnedProjects}
        activity={activity}
        now={now}
        expandedProjects={expandedProjectsForRender}
        expandedSessions={expandedSessionsForRender}
        visibleProjectSessionCounts={visibleProjectSessionCounts}
        onProjectSelect={onProjectSelect}
        onToggleProject={(projectKey) => {
          projectExpansionTouched.current = true;
          setExpandedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectKey)) next.delete(projectKey);
            else next.add(projectKey);
            return next;
          });
        }}
        onOpenProjectMenu={openProjectMenu}
        onCreateTaskInProject={onCreateTaskInProject}
        onToggleChildren={(sessionId) => {
          sessionExpansionTouched.current = true;
          setExpandedSessions((current) => {
            const next = new Set(current);
            if (next.has(sessionId)) next.delete(sessionId);
            else next.add(sessionId);
            return next;
          });
        }}
        onShowMore={(projectKey) => {
          setVisibleProjectSessionCounts((current) => ({
            ...current,
            [projectKey]:
              (current[projectKey] ?? PROJECT_SESSION_BATCH_SIZE) +
              PROJECT_SESSION_BATCH_SIZE,
          }));
        }}
        onToggleSessionPin={onToggleSessionPin}
        onArchiveSession={onArchiveSession}
        onSessionContextMenu={openSessionMenu}
        onRenameProject={onRenameProject}
        onToggleProjectPin={onToggleProjectPin}
        onArchiveProject={onArchiveProject}
        error={error}
        projectLoadError={projectLoadError}
      />
      {contextMenu ? (
        <RailContextMenu menu={contextMenu} onClose={menuAttachment.close} />
      ) : null}
    </section>
  );
}
