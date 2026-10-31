import type { MouseEvent, ReactElement } from "react";

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
import { FeedbackError } from "../../../ui/feedback.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";

import { FeedbackEmpty } from "../../../ui/feedback.js";
/** Project rows consume rail-owned display state and return named view actions. */
export function ProjectList({
  projects,
  pinnedProjectGroups,
  pinnedSessions,
  pinnedSessionState,
  pinnedProjects,
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
  readonly childrenByParentId: ReadonlyMap<string, readonly WebuiClientSession[]>;
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
  const renderProjects = (items: readonly WebuiProjectGroup[]) => (
    <WebuiStack as="ul" gap="hairline" data-webui-project-list-items="true">
      {items.map((project) => {
        const expanded = expandedProjects.has(project.key);
        const projectName = projectNames?.[project.key] ?? project.name;
        const orderedSessionIds = sortWebuiProjectSessionIds(
          page.sessions,
          pinnedSessionState ?? {},
          project.sessionIds.filter((sessionId) => !pinnedSessionState?.[sessionId]),
        );
        const visibleSessionCount =
          visibleProjectSessionCounts[project.key] ?? PROJECT_SESSION_BATCH_SIZE;
        const visibleSessionIds = orderedSessionIds.slice(0, visibleSessionCount);
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
            </div>
            <ProjectExpansion
              projectKey={project.key}
              expanded={expanded}
              sessionsById={sessionsById}
              childrenByParentId={childrenByParentId}
              visibleSessionIds={visibleSessionIds}
              hasMore={orderedSessionIds.length > visibleSessionCount}
              expandedSessionIds={expandedSessions}
              selectedSessionId={selectedSessionId}
              activity={activity}
              now={now}
              pinnedSessions={pinnedSessionState}
              onToggleChildren={onToggleChildren}
              onShowMore={() => onShowMore(project.key)}
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
    <div className="webui-project-sections">
      <RailSectionHeader
        label="置顶"
        expanded={pinnedSectionExpanded}
        onToggle={onTogglePinnedSection}
        testId="pinned"
      />
      <div
        className="webui-project-section-content"
        data-webui-section-expanded={pinnedSectionExpanded ? "true" : "false"}
        aria-hidden={!pinnedSectionExpanded}
      >
        <div className="webui-project-section-content-inner" data-webui-pinned-section="true">
          {pinnedSessions.length > 0 ? (
            <WebuiStack as="ul" gap="hairline" data-webui-pinned-sessions="true">
              {pinnedSessions.map((session) => (
                <li key={session.sessionId}>
                  <div
                    className="webui-pinned-session-row group/session"
                    data-webui-session-active={
                      selectedSessionId === session.sessionId ? "true" : "false"
                    }
                  >
                    <a
                      href={sessionHash(session.sessionId)}
                      data-webui-session-link={session.sessionId}
                      data-webui-session-active={
                        selectedSessionId === session.sessionId ? "true" : "false"
                      }
                      title={session.workspaceDir ?? undefined}
                      onContextMenu={(event) => onSessionContextMenu(event, session)}
                      className="webui-pinned-session-card text-text_default_primary"
                    >
                      <WebuiIconSession className="flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {sessionLabel(session)}
                      </span>
                      <SessionActivityMeta
                        session={session}
                        activity={activity}
                        now={now}
                      />
                    </a>
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
                        onClick={(event) => onSessionContextMenu(event, session)}
                      >
                        <WebuiIconMore />
                      </WebuiIconButton>
                    </div>
                  </div>
                </li>
              ))}
            </WebuiStack>
          ) : null}
          {renderProjects(pinnedProjectGroups)}
        </div>
      </div>

      <RailSectionHeader
        label="项目"
        expanded={projectSectionExpanded}
        onToggle={onToggleProjectSection}
        testId="projects"
      />
      <div
        className="webui-project-section-content"
        data-webui-section-expanded={projectSectionExpanded ? "true" : "false"}
        aria-hidden={!projectSectionExpanded}
      >
        <div className="webui-project-section-content-inner" data-webui-projects-section="true">
          {error ? (
            <FeedbackError message="Unable to load projects: {error}" className="px-1 pb-1 text-text_default_secondary text-size_12 leading-line_height_16" />
          ) : null}
          {projectLoadError ? (
            <FeedbackError message="Unable to load project list: {projectLoadError}" className="px-1 pb-1 text-text_default_secondary text-size_12 leading-line_height_16" />
          ) : null}
          {!error && projects.length === 0 ? (
            <p className="webui-project-empty">
              <WebuiIconFolder aria-hidden="true" />
              <span>{pinnedProjectGroups.length > 0 ? "项目已全部置顶" : "暂无项目"}</span>
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
      </div>
    </div>
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
      <WebuiIconSessionDisclosure className={expanded ? "is-expanded" : undefined} />
    </WebuiButton>
  );
}
