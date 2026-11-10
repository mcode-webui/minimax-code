import { useMemo, type MouseEvent, type ReactElement } from "react";

import {
  WebuiIconContextArchive,
  WebuiIconContextPin,
  WebuiIconFolder,
  WebuiIconMore,
  WebuiIconProjectAdd,
  WebuiIconSession,
  WebuiIconSessionDisclosure,
} from "../../../shell/icons.js";
import type {
  WebuiClientSession,
  WebuiClientSessionPage,
} from "../contracts/session-view.js";
import { sessionHash } from "../../../projection/common/router.js";
import type { WebuiSessionActivityMap } from "../projection/session-activity.js";
import type { WebuiProjectGroup } from "../projection/rail-groups.js";
import {
  PROJECT_SESSION_BATCH_SIZE,
  sortWebuiProjectSessionIds,
  sessionLabel,
} from "../projection/rail-groups.js";
import { ProjectExpansion } from "./project-expansion.js";
import { SessionActivityMeta } from "./session-activity-meta.js";
import { FeedbackAnnouncement } from "../../../ui/feedback.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import {
  WebuiDisclosure,
  WebuiMotion,
  WebuiMotionSlot,
  WebuiSkeleton,
} from "../../../ui/page.js";

import { FeedbackEmpty } from "../../../ui/feedback.js";
/** Project rows consume rail-owned display state and return named view actions. */
export function ProjectList({
  projects,
  pinnedProjectGroups,
  pinnedSessions,
  pinnedSessionState,
  pinnedProjects,
  catalogLoading,
  pinnedSectionExpanded,
  projectSectionExpanded,
  projectLoading,
  hasMoreProjects,
  visibleProjectCount,
  onTogglePinnedSection,
  onToggleProjectSection,
  onShowMoreProjects,
  page,
  sessionsById,
  childrenByParentId,
  selectedSessionId,
  projectNames,
  activity,
  now,
  expandedProjects,
  expandedSessions,
  visibleProjectSessionCounts,
  onProjectSelect,
  onToggleProject,
  onOpenProjectMenu,
  onCreateTaskInProject,
  onToggleChildren,
  onShowMore,
  onToggleSessionPin,
  onArchiveSession,
  onSessionContextMenu,
  onRenameProject,
  onToggleProjectPin,
  onArchiveProject,
  error,
  projectLoadError,
}: {
  readonly projects: readonly WebuiProjectGroup[];
  readonly pinnedProjectGroups: readonly WebuiProjectGroup[];
  readonly pinnedSessions: readonly WebuiClientSession[];
  readonly pinnedSessionState?: Readonly<Record<string, boolean>>;
  readonly pinnedProjects?: Readonly<Record<string, boolean>>;
  readonly catalogLoading: boolean;
  readonly pinnedSectionExpanded: boolean;
  readonly projectSectionExpanded: boolean;
  readonly projectLoading: boolean;
  readonly hasMoreProjects: boolean;
  readonly visibleProjectCount: number;
  readonly onTogglePinnedSection: () => void;
  readonly onToggleProjectSection: () => void;
  readonly onShowMoreProjects: () => void;
  readonly page: WebuiClientSessionPage;
  readonly sessionsById: ReadonlyMap<string, WebuiClientSession>;
  readonly childrenByParentId: ReadonlyMap<
    string,
    readonly WebuiClientSession[]
  >;
  readonly selectedSessionId?: string;
  readonly projectNames?: Readonly<Record<string, string>>;
  readonly activity?: WebuiSessionActivityMap;
  readonly now?: number;
  readonly expandedProjects: ReadonlySet<string>;
  readonly expandedSessions: ReadonlySet<string>;
  readonly visibleProjectSessionCounts: Readonly<Record<string, number>>;
  readonly onProjectSelect?: (workspaceDir?: string) => void;
  readonly onToggleProject: (projectKey: string) => void;
  readonly onOpenProjectMenu: (
    event: MouseEvent<HTMLElement>,
    project: WebuiProjectGroup,
  ) => void;
  readonly onCreateTaskInProject?: (project: WebuiProjectGroup) => void;
  readonly onToggleChildren: (sessionId: string) => void;
  readonly onShowMore: (projectKey: string) => void;
  readonly onToggleSessionPin?: (session: WebuiClientSession) => void;
  readonly onArchiveSession?: (session: WebuiClientSession) => void;
  readonly onSessionContextMenu: (
    event: MouseEvent<HTMLElement>,
    session: WebuiClientSession,
    isChild?: boolean,
  ) => void;
  readonly onRenameProject?: (project: WebuiProjectGroup) => void;
  readonly onToggleProjectPin?: (project: WebuiProjectGroup) => void;
  readonly onArchiveProject?: (project: WebuiProjectGroup) => void;
  readonly error?: string;
  readonly projectLoadError?: string;
}): ReactElement {
  const visibleSessionsByProject = useMemo(() => {
    const result = new Map<string, { readonly sessionIds: readonly string[]; readonly hasMore: boolean }>();
    for (const project of [...pinnedProjectGroups, ...projects]) {
      const orderedSessionIds = sortWebuiProjectSessionIds(
        page.sessions,
        pinnedSessionState ?? {},
        project.sessionIds.filter((sessionId) => !pinnedSessionState?.[sessionId]),
      );
      const visibleSessionCount = visibleProjectSessionCounts[project.key] ?? PROJECT_SESSION_BATCH_SIZE;
      result.set(project.key, {
        sessionIds: orderedSessionIds.slice(0, visibleSessionCount),
        hasMore: orderedSessionIds.length > visibleSessionCount,
      });
    }
    return result;
  }, [page.sessions, pinnedProjectGroups, pinnedSessionState, projects, visibleProjectSessionCounts]);
  // The two load failures are said once each, and they leave the rail's
  // layout alone: the list below is either drawn or empty, and a notice
  // that takes room from it is a state pretending to be a message.
  useWebuiToastError(
    error === undefined ? undefined : `Unable to load projects: ${error}`,
  );
  useWebuiToastError(
    projectLoadError === undefined
      ? undefined
      : `Unable to load project list: ${projectLoadError}`,
  );

  if (catalogLoading) {
    return (
      <>
        <FeedbackAnnouncement message="正在加载项目和会话" />
        <div className="webui-project-list-skeleton" aria-hidden="true">
          {Array.from({ length: 11 }, (_, index) => (
            <WebuiSkeleton key={index} />
          ))}
        </div>
      </>
    );
  }

  const renderProjects = (items: readonly WebuiProjectGroup[]) => (
    <WebuiStack as="ul" gap="hairline" data-webui-project-list-items="true">
      {items.map((project) => {
        const expanded = expandedProjects.has(project.key);
        const projectName = projectNames?.[project.key] ?? project.name;
        const visibleSessions = visibleSessionsByProject.get(project.key) ?? { sessionIds: [], hasMore: false };
        return (
          <li key={project.key}>
            <div className="webui-project-row group/project">
              <WebuiButton
                variant="selectable-row"
                size="rail"
                aria-expanded={expanded}
                onClick={() => {
                  onProjectSelect?.(project.workspaceDir);
                  onToggleProject(project.key);
                }}
                onContextMenu={(event) => onOpenProjectMenu(event, project)}
                data-webui-project-link={project.key}
                title={project.workspaceDir}
                className="webui-project-card"
              >
                <WebuiIconFolder className="webui-project-folder-icon flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm leading-5">
                  {projectName}
                </span>
              </WebuiButton>
              <WebuiMotionSlot kind="feedback-opacity">
                <div className="webui-project-row-actions" aria-hidden="false">
                {project.workspaceDir &&
                (onRenameProject || onToggleProjectPin || onArchiveProject) ? (
                  <WebuiIconButton
                    tone="bare"
                    size="rail"
                    label={`${projectName} 项目操作`}
                    title="项目操作"
                    onClick={(event) => onOpenProjectMenu(event, project)}
                  >
                    <WebuiIconMore />
                  </WebuiIconButton>
                ) : null}
                {onCreateTaskInProject ? (
                  <WebuiIconButton
                    tone="bare"
                    size="rail"
                    label={`在 ${projectName} 中新建任务`}
                    title="新建任务"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCreateTaskInProject(project);
                    }}
                  >
                    <WebuiIconProjectAdd />
                  </WebuiIconButton>
                ) : null}
                </div>
              </WebuiMotionSlot>
            </div>
            <ProjectExpansion
              projectKey={project.key}
              expanded={expanded}
              sessionsById={sessionsById}
              childrenByParentId={childrenByParentId}
              visibleSessionIds={visibleSessions.sessionIds}
              hasMore={visibleSessions.hasMore}
              expandedSessionIds={expandedSessions}
              selectedSessionId={selectedSessionId}
              activity={activity}
              now={now}
              pinnedSessions={pinnedSessionState}
              onToggleChildren={onToggleChildren}
              onShowMore={onShowMore}
              onToggleSessionPin={onToggleSessionPin}
              onArchiveSession={onArchiveSession}
              onSessionContextMenu={onSessionContextMenu}
            />
          </li>
        );
      })}
    </WebuiStack>
  );

  return (
    <>
      <div className="webui-project-sections">
        <RailSectionHeader
          label="置顶"
          expanded={pinnedSectionExpanded}
          onToggle={onTogglePinnedSection}
          testId="pinned"
        />
        <WebuiDisclosure
          as="div"
          open={pinnedSectionExpanded}
          className="webui-project-section-content"
          data-webui-section-expanded={pinnedSectionExpanded ? "true" : "false"}
        >
          <div
            className="webui-project-section-content-inner"
            data-webui-pinned-section="true"
          >
            {pinnedSessions.length > 0 ? (
              <WebuiStack
                as="ul"
                gap="hairline"
                data-webui-pinned-sessions="true"
              >
                {pinnedSessions.map((session) => (
                  <li key={session.sessionId}>
                    <WebuiMotionSlot kind="feedback">
                      <div
                      className="webui-pinned-session-row group/session"
                      data-webui-session-active={
                        selectedSessionId === session.sessionId
                          ? "true"
                          : "false"
                      }
                    >
                      <a
                        href={sessionHash(session.sessionId)}
                        data-webui-session-link={session.sessionId}
                        data-webui-session-active={
                          selectedSessionId === session.sessionId
                            ? "true"
                            : "false"
                        }
                        title={session.workspaceDir ?? undefined}
                        onContextMenu={(event) =>
                          onSessionContextMenu(event, session)
                        }
                        className="webui-pinned-session-card text-text_default_primary"
                      >
                        <WebuiIconSession className="flex-shrink-0" />
                        <WebuiMotionSlot kind="feedback-padding">
                          <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                        </WebuiMotionSlot>
                        <SessionActivityMeta
                          session={session}
                          activity={activity}
                          now={now}
                        />
                      </a>
                      <WebuiMotionSlot kind="feedback-opacity">
                        <div className="webui-session-row-actions">
                        {onToggleSessionPin ? (
                          <WebuiIconButton
                            tone="bare"
                            size="rail"
                            label={`取消置顶：${sessionLabel(session)}`}
                            title="取消置顶"
                            data-webui-rail-action="pin"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onToggleSessionPin(session);
                            }}
                          >
                            <WebuiIconContextPin pinned />
                          </WebuiIconButton>
                        ) : null}
                        {onArchiveSession ? (
                          <WebuiIconButton
                            tone="bare"
                            size="rail"
                            label={`归档：${sessionLabel(session)}`}
                            title="归档"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onArchiveSession(session);
                            }}
                          >
                            <WebuiIconContextArchive />
                          </WebuiIconButton>
                        ) : null}
                        <WebuiIconButton
                          tone="bare"
                          size="rail"
                          label={`${sessionLabel(session)} 更多操作`}
                          title="更多操作"
                          onClick={(event) =>
                            onSessionContextMenu(event, session)
                          }
                        >
                          <WebuiIconMore />
                        </WebuiIconButton>
                        </div>
                      </WebuiMotionSlot>
                    </div>
                    </WebuiMotionSlot>
                  </li>
                ))}
              </WebuiStack>
            ) : null}
            {renderProjects(pinnedProjectGroups)}
          </div>
        </WebuiDisclosure>

        <RailSectionHeader
          label="项目"
          expanded={projectSectionExpanded}
          onToggle={onToggleProjectSection}
          testId="projects"
        />
        <WebuiDisclosure
          as="div"
          open={projectSectionExpanded}
          className="webui-project-section-content"
          data-webui-section-expanded={
            projectSectionExpanded ? "true" : "false"
          }
        >
          <div
            className="webui-project-section-content-inner"
            data-webui-projects-section="true"
          >
            {!error && projects.length === 0 ? (
              <p className="webui-project-empty">
                <WebuiIconFolder aria-hidden="true" />
                <span>
                  {pinnedProjectGroups.length > 0
                    ? "项目已全部置顶"
                    : "暂无项目"}
                </span>
              </p>
            ) : (
              <>
                {renderProjects(projects.slice(0, visibleProjectCount))}
                {hasMoreProjects ? (
                  <div className="px-1 pt-px">
                    <WebuiButton
                      variant="selectable-row"
                      size="compact"
                      className="webui-project-session-more text-text_default_secondary"
                      onClick={onShowMoreProjects}
                      disabled={projectLoading}
                      aria-label="显示更多项目"
                    >
                      {projectLoading ? "加载中…" : "更多"}
                    </WebuiButton>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </WebuiDisclosure>
      </div>
    </>
  );
}

function RailSectionHeader({
  label,
  expanded,
  onToggle,
  testId,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly testId: string;
}): ReactElement {
  return (
    <WebuiButton
      variant="quiet-subtle"
      size="rail"
      className="webui-project-section-toggle"
      aria-expanded={expanded}
      data-webui-rail-section-header="true"
      data-webui-rail-section-id={testId}
      onClick={onToggle}
    >
      <span>{label}</span>
      <WebuiMotionSlot kind="disclosure-transform" rotation={expanded ? 90 : 0}>
        <WebuiIconSessionDisclosure />
      </WebuiMotionSlot>
    </WebuiButton>
  );
}
