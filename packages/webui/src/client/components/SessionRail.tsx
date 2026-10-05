// SessionRail — the desktop-faithful rail listing projects + recent sessions,
// plus the helpers they share (`sessionLabel`,
// `groupWebuiSessionsByWorkspace`, `sortWebuiProjectSessionIds`,
// `WebuiProjectGroup`).
//
// W3 tier 3 lift: this cluster (2 components + 4 helpers) was moved
// verbatim out of `app.tsx`. The bodies are byte-identical to what used
// to live there; the lift is move-only. `app.tsx` keeps a thin re-export
// block so existing consumers (`webui-shell.test.ts`, importers via
// `app.tsx`) keep their current import path during the W3 wave.

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
  WebuiIconMore,
  WebuiIconProjectAdd,
  WebuiIconSessionPinMark,
  WebuiIconSessionStar,
  WebuiIconSessionStarMark,
  WebuiIconSessionDisclosure,
  WebuiIconAgent,
} from "../icons.js";
import { WebuiContextMenu, type WebuiContextMenuItem } from "./ContextMenu.js";
import { RailRow } from "./RailRow.js";
import {
  formatWebuiSessionAge,
  type WebuiSessionActivityMap,
} from "../session-activity.js";
import {
  filterWebuiRailViewSessions,
  selectWebuiRailViewTabs,
  type WebuiRailView,
} from "../rail-buckets.js";
import { formatWebuiUnreadBadge } from "../session-unread.js";
import type {
  WebuiClientSession,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
  WebuiClientProject,
} from "../contracts.js";
import { teamModeCopy, type TeamModeSessionChoices } from "../team-mode.js";

const PROJECT_SESSION_BATCH_SIZE = 6;

export interface WebuiProjectGroup {
  readonly key: string;
  readonly name: string;
  readonly workspaceDir?: string;
  readonly latestSessionId: string;
  readonly sessionIds: readonly string[];
  readonly updatedAt: number;
  readonly pinned?: boolean;
}

/**
 * The desktop's home rail is project-first, even though its source data is a
 * session history. Keep the grouping deterministic so paging and a refresh do
 * not reshuffle a project while the user is looking at it.
 */
export function groupWebuiSessionsByWorkspace(
  sessions: readonly WebuiClientSession[],
): WebuiProjectGroup[] {
  const ordered = [...sessions].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const groups = new Map<string, WebuiProjectGroup>();
  for (const session of ordered) {
    const workspaceDir = session.workspaceDir?.trim() || undefined;
    const key = workspaceDir ?? "__webui_unassigned_project__";
    const current = groups.get(key);
    if (current) {
      groups.set(key, {
        ...current,
        sessionIds: [...current.sessionIds, session.sessionId],
      });
      continue;
    }
    groups.set(key, {
      key,
      name: workspaceProjectName(workspaceDir),
      ...(workspaceDir ? { workspaceDir } : {}),
      latestSessionId: session.sessionId,
      sessionIds: [session.sessionId],
      updatedAt: session.updatedAt,
    });
  }
  return [...groups.values()];
}

export function sortWebuiProjectSessionIds(
  sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
  pinnedSessions: Readonly<Record<string, boolean>>,
  sessionIds: readonly string[],
): string[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  return [...sessionIds].sort((left, right) => {
    const pinDelta = Number(Boolean(pinnedSessions[right])) - Number(Boolean(pinnedSessions[left]));
    if (pinDelta) return pinDelta;
    return (byId.get(right)?.updatedAt ?? 0) - (byId.get(left)?.updatedAt ?? 0);
  });
}

export function sessionLabel(session: WebuiClientSession): string {
  return session.title?.trim() || session.agentName || session.sessionId;
}

/**
 * Whether a session matches a rail search query.
 *
 * Matching is a case-insensitive substring over the label the rail already
 * renders (`sessionLabel`) plus the workspace directory, so a project path is
 * findable even when no session title inside it contains the query. An empty
 * or whitespace-only query matches everything, so callers can hand the raw
 * input value straight through without guarding.
 */
export function matchesWebuiSessionQuery(session: WebuiClientSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (sessionLabel(session).toLowerCase().includes(needle)) return true;
  return (session.workspaceDir ?? "").toLowerCase().includes(needle);
}

/**
 * The sessions matching `query`, in the caller's order. Returns the input
 * unchanged for an empty query so the unfiltered rail keeps its identity.
 */
export function filterWebuiSessionsByQuery(
  sessions: readonly WebuiClientSession[],
  query: string,
): readonly WebuiClientSession[] {
  if (!query.trim()) return sessions;
  return sessions.filter((session) => matchesWebuiSessionQuery(session, query));
}

export function workspaceProjectName(workspaceDir?: string): string {
  const value = workspaceDir?.trim();
  if (!value) return "未选项目";
  const normalized = value.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || normalized;
}

export function sessionHash(sessionId: string): string {
  const params = new URLSearchParams();
  params.set("session", sessionId);
  return `#${params.toString()}`;
}

/**
 * 没有选中会话时默认展开的项目 key。
 * 有选中会话、用户已手动切换过展开状态，或没有任何项目时返回 undefined。
 */
export function resolveDefaultExpandedProjectKey(
  projects: readonly WebuiProjectGroup[],
  selectedSessionId: string | undefined,
  expansionTouched: boolean,
): string | undefined {
  if (selectedSessionId) return undefined;
  if (expansionTouched) return undefined;
  return projects[0]?.key;
}

/**
 * Whether a rail search query names the project row itself, rather than one of
 * the sessions under it. Callers pair this with a "still has a matching
 * session" check, because projects are rendered from `projectRecords`, not
 * from the session list: without the pairing, every non-hidden project would
 * survive a query that matched none of its sessions, and the rail would fill
 * with empty project rows that look like unfiltered results.
 */
export function matchesWebuiProjectQuery(project: WebuiProjectGroup, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (project.name.toLowerCase().includes(needle)) return true;
  return (project.workspaceDir ?? "").toLowerCase().includes(needle);
}

/**
 * The project rows that survive a rail search, in the caller's order.
 *
 * A project survives when it still holds at least one matching session, or
 * when the query names the row itself. Both clauses are load-bearing:
 *
 * - Without the session clause, every non-hidden project would render on
 *   every query. `projects` is built from `projectRecords` (the whole
 *   workspace) while the sessions under each project come from the filtered
 *   page, so projects with nothing left to show came through as empty rows
 *   that read as unfiltered results.
 * - Without the name clause, a project would be unsearchable until its
 *   sessions happened to page in — `page.sessions` is one page, and a
 *   project's row exists long before its sessions are loaded.
 *
 * An empty query returns the input array by identity, so the unfiltered rail
 * keeps its referential stability across renders.
 */
export function filterWebuiProjectsByQuery(
  projects: readonly WebuiProjectGroup[],
  query: string,
): readonly WebuiProjectGroup[] {
  if (!query.trim()) return projects;
  return projects.filter(
    (project) => project.sessionIds.length > 0 || matchesWebuiProjectQuery(project, query),
  );
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
  pinnedSessions,
  starredSessions,
  pinnedProjects,
  projectNames,
  onRenameProject,
  onToggleProjectPin,
  onArchiveProject,
  onRenameSession,
  onToggleSessionPin,
  onToggleSessionStar,
  onArchiveSession,
  onForkSession,
  onCopySession,
  onExportSession,
  onDeleteSession,
  activity,
  now,
  view: viewProp,
  onViewChange,
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
  readonly pinnedSessions?: Readonly<Record<string, boolean>>;
  /** Which rows the 收藏 view collects, and which carry the standing star. */
  readonly starredSessions?: Readonly<Record<string, boolean>>;
  readonly pinnedProjects?: Readonly<Record<string, boolean>>;
  readonly projectNames?: Readonly<Record<string, string>>;
  readonly onRenameProject?: (project: WebuiProjectGroup) => void;
  readonly onToggleProjectPin?: (project: WebuiProjectGroup) => void;
  readonly onArchiveProject?: (project: WebuiProjectGroup) => void;
  readonly onRenameSession?: (session: WebuiClientSession) => void;
  readonly onToggleSessionPin?: (session: WebuiClientSession) => void;
  readonly onToggleSessionStar?: (session: WebuiClientSession) => void;
  readonly onArchiveSession?: (session: WebuiClientSession) => void;
  readonly onForkSession?: (session: WebuiClientSession, createIsolatedWorktree: boolean) => void;
  readonly onCopySession?: (session: WebuiClientSession, value: "workspaceDir" | "sessionId") => void;
  readonly onExportSession?: (session: WebuiClientSession) => void;
  readonly onDeleteSession?: (session: WebuiClientSession) => void;
  /** Per-session running state and last-activity, for the row's right-hand end. */
  readonly activity?: WebuiSessionActivityMap;
  readonly now?: number;
  /** Which slice of the list to show. Falls back to internal state. */
  readonly view?: WebuiRailView;
  readonly onViewChange?: (view: WebuiRailView) => void;
}): ReactElement {
  // Build a lookup from parent session id to its child sessions. When
  // `treePage` is provided, this lets the rail render child sessions under
  // each root — mirroring the desktop sidebar's parent/child grouping.
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
  const projects = useMemo(
    () => {
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
            return projectRecords.filter((project) => !project.hidden).map((project) => {
              const key = project.workspaceDir ?? "__webui_unassigned_project__";
              const sessions = sessionsByWorkspace.get(key) ?? [];
              return {
                key,
                name: workspaceProjectName(project.workspaceDir ?? undefined),
                ...(project.workspaceDir ? { workspaceDir: project.workspaceDir } : {}),
                latestSessionId: sessions[0]?.sessionId ?? "",
                sessionIds: sessions.map(({ sessionId }) => sessionId),
                updatedAt: project.recentAtMs ?? project.latestActivityAtMs,
                pinned: project.pinned,
              };
            });
          })()
        : groupWebuiSessionsByWorkspace(page.sessions);
      return [...filterWebuiProjectsByQuery(grouped, query ?? "")].sort((left, right) => {
        const pinDelta = Number(Boolean(pinnedProjects?.[right.key] ?? right.pinned)) - Number(Boolean(pinnedProjects?.[left.key] ?? left.pinned));
        return pinDelta || right.updatedAt - left.updatedAt;
      });
    },
    [page.sessions, pinnedProjects, projectRecords, query],
  );
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 用户手动折叠过项目后，不再自动展开首个项目。
  const projectExpansionTouched = useRef(false);
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [visibleProjectSessionCounts, setVisibleProjectSessionCounts] = useState<
    Readonly<Record<string, number>>
  >({});
  const [contextMenu, setContextMenu] = useState<
    | { readonly x: number; readonly y: number; readonly items: readonly WebuiContextMenuItem[] }
    | undefined
  >();
  const sessionsById = useMemo(
    () => new Map(page.sessions.map((session) => [session.sessionId, session])),
    [page.sessions],
  );

  const showContextMenu = (event: MouseEvent<HTMLElement>, items: readonly WebuiContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const fromContextMenu = event.type === "contextmenu";
    setContextMenu({
      x: fromContextMenu ? event.clientX : bounds.right - 220,
      y: fromContextMenu ? event.clientY : bounds.bottom,
      items,
    });
  };

  const openSessionMenu = (event: MouseEvent<HTMLElement>, session: WebuiClientSession, isChild = false) => {
    const items: readonly WebuiContextMenuItem[] = isChild
      ? [
        {
          kind: "item",
          key: "rename",
          label: "重命名",
          icon: <WebuiIconContextRename />,
          disabled: !onRenameSession,
          onSelect: () => onRenameSession?.(session),
        },
        {
          kind: "item",
          key: "export",
          label: "导出会话",
          icon: <WebuiIconContextExport />,
          disabled: !onExportSession,
          onSelect: () => onExportSession?.(session),
        },
        {
          kind: "item",
          key: "copy-session-id",
          label: "复制会话 ID",
          icon: <WebuiIconContextCopy />,
          disabled: !onCopySession,
          onSelect: () => onCopySession?.(session, "sessionId"),
        },
        {
          kind: "item",
          key: "delete",
          label: "删除",
          icon: <WebuiIconContextTrash />,
          danger: true,
          disabled: !onDeleteSession,
          onSelect: () => onDeleteSession?.(session),
        },
      ]
      : [
        {
          kind: "item",
          key: "pin",
          label: pinnedSessions?.[session.sessionId] ? "取消置顶" : "置顶",
          icon: <WebuiIconContextPin pinned={Boolean(pinnedSessions?.[session.sessionId])} />,
          disabled: !onToggleSessionPin,
          onSelect: () => onToggleSessionPin?.(session),
        },
        {
          kind: "item",
          key: "star",
          label: starredSessions?.[session.sessionId] ? "取消收藏" : "收藏",
          icon: <WebuiIconSessionStar starred={Boolean(starredSessions?.[session.sessionId])} />,
          disabled: !onToggleSessionStar,
          onSelect: () => onToggleSessionStar?.(session),
        },
        {
          kind: "item",
          key: "rename",
          label: "重命名",
          icon: <WebuiIconContextRename />,
          disabled: !onRenameSession,
          onSelect: () => onRenameSession?.(session),
        },
        {
          kind: "item",
          key: "archive",
          label: session.archived ? "取消归档" : "归档",
          icon: <WebuiIconContextArchive />,
          disabled: !onArchiveSession,
          onSelect: () => onArchiveSession?.(session),
        },
        { kind: "divider", key: "fork-divider" },
        {
          kind: "item",
          key: "fork-current",
          label: "复制为新会话",
          icon: <WebuiIconContextFork />,
          disabled: !onForkSession,
          onSelect: () => onForkSession?.(session, false),
        },
        {
          kind: "item",
          key: "fork-worktree",
          label: "复制到新工作树",
          icon: <WebuiIconContextFork />,
          disabled: !onForkSession,
          onSelect: () => onForkSession?.(session, true),
        },
        { kind: "divider", key: "copy-divider" },
        {
          kind: "item",
          key: "show-folder",
          label: "在文件夹中显示",
          icon: <WebuiIconFolder />,
          disabled: true,
        },
        {
          kind: "item",
          key: "copy",
          label: "复制",
          icon: <WebuiIconContextCopy />,
          submenu: [
            {
              kind: "item",
              key: "copy-workspace-dir",
              label: "复制工作目录",
              icon: <WebuiIconContextCopy />,
              disabled: !session.workspaceDir || !onCopySession,
              onSelect: () => onCopySession?.(session, "workspaceDir"),
            },
            {
              kind: "item",
              key: "copy-session-id",
              label: "复制会话 ID",
              icon: <WebuiIconContextCopy />,
              disabled: !onCopySession,
              onSelect: () => onCopySession?.(session, "sessionId"),
            },
          ],
        },
        {
          kind: "item",
          key: "export",
          label: "导出会话",
          icon: <WebuiIconContextExport />,
          disabled: !onExportSession,
          onSelect: () => onExportSession?.(session),
        },
        {
          kind: "item",
          key: "feedback",
          label: "问题反馈",
          icon: <WebuiIconContextFeedback />,
          disabled: true,
        },
        { kind: "divider", key: "delete-divider" },
        {
          kind: "item",
          key: "delete",
          label: "删除",
          icon: <WebuiIconContextTrash />,
          danger: true,
          disabled: !onDeleteSession,
          onSelect: () => onDeleteSession?.(session),
        },
      ];
    showContextMenu(event, items);
  };

  const openProjectMenu = (event: MouseEvent<HTMLElement>, project: WebuiProjectGroup) => {
    if (!project.workspaceDir) return;
    showContextMenu(event, [
      {
        kind: "item",
        key: "rename-project",
        label: "重命名项目",
        icon: <WebuiIconContextRename />,
        disabled: !onRenameProject,
        onSelect: () => onRenameProject?.(project),
      },
      {
        kind: "item",
        key: "toggle-pin-project",
        label: pinnedProjects?.[project.key] ? "取消置顶项目" : "置顶项目",
        icon: <WebuiIconContextPin pinned={Boolean(pinnedProjects?.[project.key])} />,
        disabled: !onToggleProjectPin,
        onSelect: () => onToggleProjectPin?.(project),
      },
      {
        kind: "item",
        key: "show-project-in-folder",
        label: "在文件夹中显示",
        icon: <WebuiIconFolder />,
        disabled: true,
      },
      {
        kind: "item",
        key: "archive-project-sessions",
        label: "归档对话",
        icon: <WebuiIconContextArchive />,
        disabled: !onArchiveProject,
        onSelect: () => onArchiveProject?.(project),
      },
      {
        kind: "item",
        key: "remove-project",
        label: "移除",
        icon: <WebuiIconContextTrash />,
        danger: true,
        disabled: true,
      },
    ]);
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

  // The rail has one view per tab rather than one stacked list. Uncontrolled
  // by default so the app does not have to own it; `view` exists so a caller
  // (or a test) can drive it.
  const [internalView, setInternalView] = useState<WebuiRailView>("projects");
  const activeView = viewProp ?? internalView;
  const setActiveView = onViewChange ?? setInternalView;
  const railTabs = useMemo(
    () => selectWebuiRailViewTabs(page.sessions, activity, starredSessions),
    [activity, page.sessions, starredSessions],
  );
  const viewSessions = useMemo(
    () => filterWebuiRailViewSessions(page.sessions, activity, activeView, starredSessions),
    [activeView, activity, page.sessions, starredSessions],
  );
  const activeTab = railTabs.find((entry) => entry.view === activeView);
  const activeTabLabel = activeTab?.label ?? "项目";

  const railViewTabs = (
    <div
      className="webui-rail-view-tabs"
      role="tablist"
      data-webui-rail-view-tabs="true"
    >
      {railTabs.map((entry) => (
        <button
          key={entry.view}
          type="button"
          data-webui-rail-view={entry.view}
          role="tab"
          aria-selected={activeView === entry.view}
          className="webui-rail-view-tab"
          onClick={() => setActiveView(entry.view)}
        >
          {entry.label}
          {entry.view === "projects" ? null : (
            <span className="webui-rail-view-count" data-webui-rail-view-count={entry.view}>
              {entry.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  // Not a header the user can dismiss: the count is the point. The rail keeps
  // the session the reader is on in the main column whatever the tab says, so
  // an empty tab means "nothing is running", not "you lost your conversation".
  if (activeView !== "projects") {
    return (
      <section data-webui-project-list="true" data-webui-rail-view-active={activeView}>
        {railViewTabs}
        <WebuiSessionList
          page={{ sessions: viewSessions, hasMore: false }}
          loading={loading}
          selectedSessionId={selectedSessionId}
          error={error}
          activity={activity}
          now={now}
          pinnedSessions={pinnedSessions}
          starredSessions={starredSessions}
          heading={activeTabLabel}
          emptyLabel={activeTab?.emptyLabel}
          preserveOrder
          onSessionContextMenu={openSessionMenu}
        />
        {/* The menu render exists in BOTH return branches on purpose. The flat
         * views open the same `contextMenu` state the projects view does, but
         * this early return predates the menu: rendering the portal from the
         * projects branch alone left a right-click here setting state that no
         * subtree ever painted — the row appeared to do nothing. */}
        {contextMenu ? (
          <WebuiContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenu.items}
            onClose={() => setContextMenu(undefined)}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section data-webui-project-list="true">
      {railViewTabs}
      <div
        className="flex h-7 items-center px-2 text-sm font-normal leading-5 text-text_default_tertiary"
        data-webui-rail-section-header="true"
      >
        项目
      </div>
      {error ? (
        <p
          role="alert"
          className="px-1 pb-1 text-text_default_secondary text-size_12 leading-line_height_16"
        >
          Unable to load projects: {error}
        </p>
      ) : null}
      {!error && projects.length === 0 ? (
        <p className="webui-empty-state mx-1 text-text_default_secondary text-size_12 leading-line_height_16">
          暂无项目
        </p>
      ) : (
        <ul className="space-y-px" data-webui-project-list-items="true">
          {projects.map((project) => {
            const expanded = expandedProjects.has(project.key);
            const projectName = projectNames?.[project.key] ?? project.name;
            const orderedSessionIds = sortWebuiProjectSessionIds(
              page.sessions,
              pinnedSessions ?? {},
              project.sessionIds,
            );
            const visibleSessionCount =
              visibleProjectSessionCounts[project.key] ?? PROJECT_SESSION_BATCH_SIZE;
            const visibleSessionIds = orderedSessionIds.slice(0, visibleSessionCount);
            return (
              <li key={project.key}>
                <div className="webui-project-row group/project">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => {
                      onProjectSelect?.(project.workspaceDir);
                      projectExpansionTouched.current = true;
                      setExpandedProjects((current) => {
                        const next = new Set(current);
                        if (next.has(project.key)) next.delete(project.key);
                        else next.add(project.key);
                        return next;
                      });
                    }}
                    onContextMenu={(event) => openProjectMenu(event, project)}
                    data-webui-project-link={project.key}
                    title={project.workspaceDir}
                    className="webui-project-card text-left text-text_default_secondary"
                  >
                    <WebuiIconFolder className="flex-shrink-0" />
                    {pinnedProjects?.[project.key] ?? project.pinned ? (
                      /* Leading edge, not the trailing one: `.webui-project-row-actions`
                       * is pinned to the row's right and only appears on hover, so a
                       * mark on that side would be standing proof of nothing. */
                      <span
                        className="webui-project-pin-mark"
                        data-webui-project-pin-mark="true"
                        title="已置顶"
                        aria-label="已置顶"
                        role="img"
                      >
                        <WebuiIconSessionPinMark />
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-sm leading-5">
                      {projectName}
                    </span>
                  </button>
                  <div className="webui-project-row-actions" aria-hidden="false">
                    {project.workspaceDir && (onRenameProject || onToggleProjectPin || onArchiveProject) ? (
                      <button
                        type="button"
                        aria-label={`${projectName} 项目操作`}
                        title="项目操作"
                        className="webui-rail-action"
                        onClick={(event) => openProjectMenu(event, project)}
                      >
                        <WebuiIconMore />
                      </button>
                    ) : null}
                    {onCreateTaskInProject ? (
                      <button
                        type="button"
                        aria-label={`在 ${projectName} 中新建任务`}
                        title="新建任务"
                        className="webui-rail-action"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCreateTaskInProject(project);
                        }}
                      >
                        <WebuiIconProjectAdd />
                      </button>
                    ) : null}
                  </div>
                </div>
                <div
                  className={`webui-expandable-motion${expanded ? " is-open" : ""}`}
                  aria-hidden={!expanded}
                  ref={(element) => element?.toggleAttribute("inert", !expanded)}
                >
                  <ul
                    className="webui-project-session-list"
                    data-webui-project-sessions={project.key}
                  >
                    {visibleSessionIds.map((sessionId) => {
                      const session = sessionsById.get(sessionId);
                      if (!session) return null;
                      const children = childrenByParentId.get(session.sessionId) ?? [];
                      const childrenExpanded = expandedSessions.has(session.sessionId);
                      const sessionActive = session.sessionId === selectedSessionId;
                      return (
                        <li key={session.sessionId}>
                          <div
                            className="webui-project-session-row group/session"
                            data-webui-session-active={sessionActive ? "true" : "false"}
                          >
                            <span className="webui-session-leading-marker">
                            {children.length > 0 ? (
                              <button
                                type="button"
                                className="webui-session-disclosure"
                                aria-label={`${childrenExpanded ? "收起" : "展开"}子会话：${sessionLabel(session)}`}
                                aria-expanded={childrenExpanded}
                                title={childrenExpanded ? "收起子会话" : "展开子会话"}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setExpandedSessions((current) => {
                                    const next = new Set(current);
                                    if (next.has(session.sessionId)) next.delete(session.sessionId);
                                    else next.add(session.sessionId);
                                    return next;
                                  });
                                }}
                              >
                                <WebuiIconSessionDisclosure className={childrenExpanded ? "is-expanded" : undefined} />
                              </button>
                            ) : <span aria-hidden="true" className="webui-session-leading-line" />}
                            </span>
                            <a
                              href={sessionHash(session.sessionId)}
                              data-webui-session-link={session.sessionId}
                              data-webui-session-active={sessionActive ? "true" : "false"}
                              onContextMenu={(event) => openSessionMenu(event, session)}
                              className="webui-project-session-card text-text_default_primary"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {sessionLabel(session)}
                              </span>
                              <SessionActivityMeta
                                session={session}
                                activity={activity}
                                now={now}
                                pinned={Boolean(pinnedSessions?.[session.sessionId])}
                                starred={Boolean(starredSessions?.[session.sessionId])}
                              />
                            </a>
                            <div className="webui-session-row-actions">
                              {onToggleSessionPin ? (
                                <button
                                  type="button"
                                  aria-label={`${pinnedSessions?.[session.sessionId] ? "取消置顶" : "置顶"}：${sessionLabel(session)}`}
                                  title={pinnedSessions?.[session.sessionId] ? "取消置顶" : "置顶"}
                                  className="webui-rail-action"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onToggleSessionPin(session);
                                  }}
                                >
                                  {/* The glyph draws the ACTION, not the state: already
                                   *  pinned means the click unpins, so the button offers
                                   *  the slashed pin. Same component the context menu
                                   *  uses, so the two cannot drift apart. */}
                                  <WebuiIconContextPin pinned={Boolean(pinnedSessions?.[session.sessionId])} />
                                </button>
                              ) : null}
                              {onToggleSessionStar ? (
                                <button
                                  type="button"
                                  aria-label={`${starredSessions?.[session.sessionId] ? "取消收藏" : "收藏"}：${sessionLabel(session)}`}
                                  title={starredSessions?.[session.sessionId] ? "取消收藏" : "收藏"}
                                  className="webui-rail-action"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onToggleSessionStar(session);
                                  }}
                                >
                                  {/* Outline until starred, yellow fill after. Unlike the
                                   *  pin, this glyph shows the state rather than the
                                   *  action: a filled star is not read as "remove"
                                   *  anywhere in the world's icon vocabulary. */}
                                  <WebuiIconSessionStar starred={Boolean(starredSessions?.[session.sessionId])} />
                                </button>
                              ) : null}
                              {onArchiveSession ? (
                                <button
                                  type="button"
                                  aria-label={`${session.archived ? "取消归档" : "归档"}：${sessionLabel(session)}`}
                                  title={session.archived ? "取消归档" : "归档"}
                                  className="webui-rail-action"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onArchiveSession(session);
                                  }}
                                >
                                  <WebuiIconContextArchive />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                aria-label={`${sessionLabel(session)} 更多操作`}
                                title="更多操作"
                                className="webui-rail-action"
                                onClick={(event) => openSessionMenu(event, session)}
                              >
                                <WebuiIconMore />
                              </button>
                            </div>
                          </div>
                          {children.length > 0 && childrenExpanded ? (
                            <ul
                              className="webui-project-child-session-list"
                              data-webui-project-child-sessions={session.sessionId}
                            >
                              {children.map((child) => (
                                <li key={child.sessionId}>
                                  <div className="webui-project-child-session-row group/session">
                                    <a
                                      href={sessionHash(child.sessionId)}
                                      data-webui-session-link={child.sessionId}
                                      data-webui-session-child-of={session.sessionId}
                                      data-webui-session-active={
                                        child.sessionId === selectedSessionId
                                          ? "true"
                                          : "false"
                                      }
                                      onContextMenu={(event) => openSessionMenu(event, child, true)}
                                      className="webui-project-child-session-card text-text_default_primary"
                                    >
                                      <WebuiIconAgent className="size-4 shrink-0" />
                                      <span className="min-w-0 flex-1 truncate">
                                        {sessionLabel(child)}
                                      </span>
                                      <SessionActivityMeta
                                        session={child}
                                        activity={activity}
                                        now={now}
                                        pinned={Boolean(pinnedSessions?.[child.sessionId])}
                                        starred={Boolean(starredSessions?.[child.sessionId])}
                                      />
                                    </a>
                                    <div className="webui-session-row-actions">
                                      <button
                                        type="button"
                                        aria-label={`${sessionLabel(child)} 更多操作`}
                                        title="更多操作"
                                        className="webui-rail-action"
                                        onClick={(event) => openSessionMenu(event, child, true)}
                                      >
                                        <WebuiIconMore />
                                      </button>
                                    </div>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                    {orderedSessionIds.length > visibleSessionCount ? (
                      <li key={`${project.key}-more`}>
                        <button
                          type="button"
                          className="webui-project-session-more text-text_default_tertiary"
                          onClick={() => {
                            setVisibleProjectSessionCounts((current) => ({
                              ...current,
                              [project.key]:
                                (current[project.key] ?? PROJECT_SESSION_BATCH_SIZE) +
                                PROJECT_SESSION_BATCH_SIZE,
                            }));
                          }}
                        >
                          更多
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {page.hasMore && onLoadMore ? (
        <div className="px-1 pt-px">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="webui-rail-more text-text_default_secondary"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
      {contextMenu ? (
        <WebuiContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
    </section>
  );
}

/**
 * The right-hand end of a rail row: a spinner while a turn holds the session,
 * and how long ago it was last active.
 *
 * Shared by all three row shapes -- project rows, child rows, and the flat
 * "all sessions" list -- so a session reads the same wherever it is listed.
 * Renders nothing when the host passes neither map nor clock, which is what
 * keeps the existing snapshots and SSR fixtures byte-identical: the rail is
 * also rendered outside the app (`webui-w0-ssr-fixtures`), where there is no
 * subscription and no clock to format against.
 */
function SessionActivityMeta({
  session,
  activity,
  now,
  pinned = false,
  starred = false,
}: {
  readonly session: WebuiClientSession;
  readonly activity?: WebuiSessionActivityMap;
  readonly now?: number;
  /** Draws the standing pin mark. Independent of the live state below it. */
  readonly pinned?: boolean;
  /** Draws the standing star mark. Also independent of the live state. */
  readonly starred?: boolean;
}): ReactElement | null {
  // `pinned` and `starred` join the guard rather than riding on it. A host that
  // passes neither an activity map nor a clock is the rail rendered outside the
  // app (SSR fixtures, and any host that does not subscribe) -- exactly the case
  // where a marked row has no running/unread signal to read its state against,
  // so swallowing the mark there loses the only thing the row was saying.
  if (!activity && now === undefined && !pinned && !starred) return null;
  const entry = activity?.[session.sessionId];
  const busy = entry?.busy;
  const badge = formatWebuiUnreadBadge(entry?.unread);
  return (
    <span className="webui-rail-session-meta">
      {pinned ? (
        <span
          className="webui-rail-pin-mark"
          data-webui-pin-mark="true"
          title="已置顶"
          aria-label="已置顶"
          role="img"
        >
          <WebuiIconSessionPinMark />
        </span>
      ) : null}
      {starred ? (
        <span
          className="webui-rail-star-mark"
          data-webui-star-mark="true"
          title="已收藏"
          aria-label="已收藏"
          role="img"
        >
          <WebuiIconSessionStarMark />
        </span>
      ) : null}
      {badge ? (
        <span
          className="webui-rail-unread-badge"
          role="status"
          aria-label={`${badge} 条未读`}
          data-webui-unread-badge={entry?.unread}
        >
          {badge}
        </span>
      ) : null}
      {busy ? (
        <span
          className="webui-rail-spinner"
          role="status"
          aria-label={busy.busyReason === "compaction" ? "正在压缩上下文" : "正在运行"}
        />
      ) : null}
      <span data-webui-session-age="true">
        {formatWebuiSessionAge(entry?.lastActivityAt ?? session.updatedAt, now ?? session.updatedAt)}
      </span>
    </span>
  );
}

export function WebuiSessionList({
  page,
  loading,
  onLoadMore,
  selectedSessionId,
  error,
  teamModeChoices,
  activity,
  now,
  pinnedSessions,
  starredSessions,
  heading,
  emptyLabel,
  preserveOrder,
  onSessionContextMenu,
}: {
  readonly page: WebuiClientSessionPage;
  readonly loading: boolean;
  readonly onLoadMore?: () => void;
  readonly selectedSessionId?: string;
  readonly onProjectSelect?: (workspaceDir?: string) => void;
  readonly error?: string;
  readonly teamModeChoices?: TeamModeSessionChoices;
  readonly activity?: WebuiSessionActivityMap;
  /** Injected so the age labels re-render on a tick instead of on every event. */
  readonly now?: number;
  /**
   * Which rows carry the standing pin mark. The running and unread views are
   * exactly where a user needs it -- those rows are ordered by activity, so
   * sort position says nothing about which one the user chose to keep.
   */
  readonly pinnedSessions?: Readonly<Record<string, boolean>>;
  /**
   * Which rows carry the standing star mark. 收藏 is a flat list, so a starred
   * row has no project furniture to be recognised by and the mark is the only
   * thing distinguishing it from an ordinary one.
   */
  readonly starredSessions?: Readonly<Record<string, boolean>>;
  /**
   * Overrides the section label. The rail reuses this list for its running and
   * unread views, where "recent tasks" would be a lie -- the list is filtered,
   * and by what depends on the view.
   */
  readonly heading?: string;
  /** Shown when the list is empty. Defaults to the neutral "no sessions". */
  readonly emptyLabel?: string;
  /**
   * Keeps the order the caller handed in. The running and unread views sort by
   * last observed activity, which is not the session record's `updatedAt` and
   * would be undone by the default sort below.
   */
  readonly preserveOrder?: boolean;
  /**
   * Opens the session context menu on a right-click. The flat views (收藏 /
   * 运行中 / 未读) list the same root sessions the projects view groups under
   * their project, so they offer the same menu: a row that only responds in
   * one tab reads as broken in the other three. Optional because this list is
   * also rendered outside the app (SSR fixtures, un-wired hosts) — a host that
   * passes nothing keeps the native context menu these rows always had.
   */
  readonly onSessionContextMenu?: (
    event: MouseEvent<HTMLElement>,
    session: WebuiClientSession,
  ) => void;
}): ReactElement {
  const sessions = useMemo(
    () =>
      preserveOrder
        ? page.sessions
        : [...page.sessions].sort(
            (left, right) => right.updatedAt - left.updatedAt,
          ),
    [page.sessions, preserveOrder],
  );
  return (
    <div
      className="transition-colors group/project-list"
      data-webui-rail-sessions="true"
    >
      <div
        className="group/section flex h-[30px] items-center gap-1 pl-2 pr-0.5"
        data-webui-rail-section-header="true"
      >
        <span className="truncate text-sm font-normal leading-5 text-text_default_tertiary">
          {heading ?? "最近任务"}
        </span>
        <span className="ml-auto flex-shrink-0 text-sm font-normal leading-5 text-text_default_tertiary">
          {sessions.length}
        </span>
      </div>
      {error ? (
        <p
          role="alert"
          className="px-1 pb-1 text-text_default_secondary text-size_12 leading-line_height_16"
        >
          会话加载失败：{error}
        </p>
      ) : null}
      {!error && sessions.length === 0 ? (
        <p className="webui-empty-state mx-1 text-text_default_secondary text-size_12 leading-line_height_16">
          {emptyLabel ?? "暂无会话"}
        </p>
      ) : (
        <ul className="pt-px space-y-px" data-webui-session-list="true">
          {sessions.map((session) => (
            <li key={session.sessionId} data-webui-session-card="true">
              <a
                href={sessionHash(session.sessionId)}
                data-webui-session-link={session.sessionId}
                data-webui-session-active={
                  selectedSessionId === session.sessionId ? "true" : "false"
                }
                title={session.workspaceDir ?? undefined}
                onContextMenu={(event) => onSessionContextMenu?.(event, session)}
                className="webui-session-card text-text_default_primary"
              >
                <span className="flex h-[31px] w-[18px] flex-shrink-0 items-center justify-center">
                  <span className="block h-[31px] w-0 border-l-[0.5px] border-border_default" />
                </span>
                <span className="w-0 flex-1 truncate text-sm">
                  {sessionLabel(session)}
                </span>
                {teamModeChoices?.[session.sessionId] === false ||
                sessions.some(
                  (child) => child.parentSessionId === session.sessionId,
                ) ? (
                  <span
                    className="webui-pill flex-shrink-0 bg-bg_interaction_primary_default text-text_default_primary text-[11px]"
                    data-webui-team-badge="true"
                    title={teamModeCopy().label}
                  >
                    Agent Team
                  </span>
                ) : null}
                <SessionActivityMeta
                  session={session}
                  activity={activity}
                  now={now}
                  pinned={Boolean(pinnedSessions?.[session.sessionId])}
                  starred={Boolean(starredSessions?.[session.sessionId])}
                />
              </a>
              {session.workspaceDir ? (
                <div
                  data-webui-workspace-dir={session.workspaceDir}
                  className="truncate pl-[28px] pr-1 text-xs leading-4 text-text_default_tertiary"
                >
                  {session.workspaceDir}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {page.hasMore && onLoadMore ? (
        <div className="px-1 pt-px">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="webui-rail-more text-text_default_secondary"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
