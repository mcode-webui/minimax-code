// ProjectExpansion — extracted from `SessionRail.tsx`.
// The declaration body is verbatim; the `export` keyword, this header and the
// import specifiers are the only differences.

import { memo, type MouseEvent } from "react";
import {
  WebuiIconContextArchive,
  WebuiIconContextPin,
  WebuiIconMore,
  WebuiIconSessionTreeDisclosure,
} from "../../../shell/icons.js";
import type { WebuiClientSession } from "../contracts/session-view.js";
import { sessionHash } from "../../../projection/common/router.js";
import { type WebuiSessionActivityMap } from "../projection/session-activity.js";
import { sessionLabel } from "../projection/rail-groups.js";
import { SessionActivityMeta } from "./session-activity-meta.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiAgentAvatar } from "../../../ui/agent-avatar.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";
import { WebuiDisclosure, WebuiMotion, WebuiMotionSlot } from "../../../ui/page.js";

/**
 * One project's expansion: the sessions under a project's row, each collapsible
 * to its child sessions, with the "更多" control that reveals the next batch.
 *
 * A cut, not a move: the state stays in `WebuiProjectList` and arrives as props and
 * callbacks, so the lifetimes are exactly what they were. Nothing here is stateful.
 */
interface ProjectExpansionProps {
  readonly projectKey: string;
  readonly expanded: boolean;
  readonly sessionsById: ReadonlyMap<string, WebuiClientSession>;
  readonly childrenByParentId: ReadonlyMap<string, readonly WebuiClientSession[]>;
  readonly visibleSessionIds: readonly string[];
  readonly hasMore: boolean;
  readonly expandedSessionIds: ReadonlySet<string>;
  readonly selectedSessionId?: string;
  readonly activity?: WebuiSessionActivityMap;
  readonly now?: number;
  readonly pinnedSessions?: Readonly<Record<string, boolean>>;
  readonly onToggleChildren: (sessionId: string) => void;
  readonly onShowMore: (projectKey: string) => void;
  readonly onToggleSessionPin?: (session: WebuiClientSession) => void;
  readonly onArchiveSession?: (session: WebuiClientSession) => void;
  readonly onSessionContextMenu: (
    event: MouseEvent<HTMLElement>,
    session: WebuiClientSession,
    isChild?: boolean,
  ) => void;
}

function ProjectExpansionView({
  projectKey,
  expanded,
  sessionsById,
  childrenByParentId,
  visibleSessionIds,
  hasMore,
  expandedSessionIds,
  selectedSessionId,
  activity,
  now,
  pinnedSessions,
  onToggleChildren,
  onShowMore,
  onToggleSessionPin,
  onArchiveSession,
  onSessionContextMenu,
}: ProjectExpansionProps) {
  return (
                <WebuiDisclosure
                  as="div"
                  open={expanded}
                  className="webui-project-section-content"
                  data-webui-section-expanded={expanded ? "true" : "false"}
                >
                  <WebuiStack
                    as="ul"
                    gap="hairline"
                    className="webui-project-session-list"
                    data-webui-project-sessions={projectKey}
                  >
                    {visibleSessionIds.map((sessionId) => {
                      const session = sessionsById.get(sessionId);
                      if (!session) return null;
                      const children = childrenByParentId.get(session.sessionId) ?? [];
                      const childrenExpanded = expandedSessionIds.has(session.sessionId);
                      const sessionActive = session.sessionId === selectedSessionId;
                      return (
                        <li key={session.sessionId}>
                          <WebuiMotionSlot kind="feedback">
                          <div
                            className="webui-project-session-row group/session"
                            data-webui-session-active={sessionActive ? "true" : "false"}
                          >
                            <span className="webui-session-leading-marker">
                            {children.length > 0 ? (
                              <WebuiIconButton
                                tone="bare"
                                size="rail"
                                label={`${childrenExpanded ? "收起" : "展开"}子会话：${sessionLabel(session)}`}
                                className="webui-session-disclosure"
                                aria-expanded={childrenExpanded}
                                title={childrenExpanded ? "收起子会话" : "展开子会话"}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onToggleChildren(session.sessionId);
                                }}
                              >
                                <WebuiMotionSlot kind="disclosure-transform" rotation={childrenExpanded ? 90 : 0}>
                                  <WebuiIconSessionTreeDisclosure />
                                </WebuiMotionSlot>
                              </WebuiIconButton>
                            ) : <span aria-hidden="true" className="webui-session-leading-line" />}
                            </span>
                            <WebuiMotionSlot kind="feedback">
                            <a
                              href={sessionHash(session.sessionId)}
                              data-webui-session-link={session.sessionId}
                              data-webui-session-active={sessionActive ? "true" : "false"}
                              onContextMenu={(event) => onSessionContextMenu(event, session)}
                              className="webui-project-session-card text-text_default_primary"
                            >
                              <WebuiMotionSlot kind="feedback-padding">
                                <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                              </WebuiMotionSlot>
                              <SessionActivityMeta
                                session={session}
                                activity={activity}
                                now={now}
                              />
                            </a>
                            </WebuiMotionSlot>
                            <WebuiMotionSlot kind="feedback-opacity">
                            <div className="webui-session-row-actions">
                              {onToggleSessionPin ? (
                                <WebuiIconButton
                                  tone="bare"
                                  size="rail"
                                  label={`${pinnedSessions?.[session.sessionId] ? "取消置顶" : "置顶"}：${sessionLabel(session)}`}
                                  title={pinnedSessions?.[session.sessionId] ? "取消置顶" : "置顶"}
                                  data-webui-rail-action="pin"
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
                                </WebuiIconButton>
                              ) : null}
                              {onArchiveSession ? (
                                <WebuiIconButton
                                  tone="bare"
                                  size="rail"
                                  label={`${session.archived ? "取消归档" : "归档"}：${sessionLabel(session)}`}
                                  title={session.archived ? "取消归档" : "归档"}
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
                            </WebuiMotionSlot>
                          </div>
                          </WebuiMotionSlot>
                          {children.length > 0 ? (
                            <WebuiDisclosure
                              as="div"
                              open={childrenExpanded}
                              className="webui-project-section-content"
                              data-webui-section-expanded={childrenExpanded ? "true" : "false"}
                            >
                              <WebuiStack
                                as="ul"
                                gap="micro"
                                className="webui-project-child-session-list"
                                data-webui-project-child-sessions={session.sessionId}
                              >
                                {children.map((child) => (
                                  <li key={child.sessionId}>
                                    <WebuiMotionSlot kind="feedback">
                                    <div className="webui-project-child-session-row group/session">
                                    <WebuiMotionSlot kind="feedback">
                                      <a
                                        href={sessionHash(child.sessionId)}
                                        data-webui-session-link={child.sessionId}
                                        data-webui-session-child-of={session.sessionId}
                                        data-webui-session-active={
                                          child.sessionId === selectedSessionId
                                            ? "true"
                                            : "false"
                                        }
                                        onContextMenu={(event) => onSessionContextMenu(event, child, true)}
                                        className="webui-project-child-session-card text-text_default_primary"
                                      >
                                        <WebuiAgentAvatar agentName={child.agentName} size="compact" />
                                        <WebuiMotionSlot kind="feedback-padding">
                                          <span className="webui-project-child-session-title min-w-0 flex-1 truncate">{sessionLabel(child)}</span>
                                        </WebuiMotionSlot>
                                        <SessionActivityMeta
                                          session={child}
                                          activity={activity}
                                          now={now}
                                        />
                                      </a>
                                    </WebuiMotionSlot>
                                      <WebuiMotionSlot kind="feedback-opacity">
                                      <div className="webui-session-row-actions">
                                        <WebuiIconButton
                                          tone="bare"
                                          size="rail"
                                          label={`${sessionLabel(child)} 更多操作`}
                                          title="更多操作"
                                          onClick={(event) => onSessionContextMenu(event, child, true)}
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
                            </WebuiDisclosure>
                          ) : null}
                        </li>
                      );
                    })}
                    {hasMore ? (
                      <li key={`${projectKey}-more`}>
                        <WebuiButton
                          variant="selectable-row"
                          size="compact"
                          className="webui-project-session-more text-text_default_tertiary"
                          onClick={() => {
                            onShowMore(projectKey);
                          }}
                        >
                          更多
                        </WebuiButton>
                      </li>
                    ) : null}
                  </WebuiStack>
                </WebuiDisclosure>
  );
}

function sameExpandedSessions(previous: ProjectExpansionProps, next: ProjectExpansionProps): boolean {
  return previous.visibleSessionIds.every((sessionId) =>
    previous.expandedSessionIds.has(sessionId) === next.expandedSessionIds.has(sessionId),
  );
}

export const ProjectExpansion = memo(
  ProjectExpansionView,
  (previous, next) =>
    previous.projectKey === next.projectKey &&
    previous.expanded === next.expanded &&
    previous.sessionsById === next.sessionsById &&
    previous.childrenByParentId === next.childrenByParentId &&
    previous.visibleSessionIds === next.visibleSessionIds &&
    previous.hasMore === next.hasMore &&
    sameExpandedSessions(previous, next) &&
    previous.selectedSessionId === next.selectedSessionId &&
    previous.activity === next.activity &&
    previous.now === next.now &&
    previous.pinnedSessions === next.pinnedSessions &&
    previous.onToggleChildren === next.onToggleChildren &&
    previous.onShowMore === next.onShowMore &&
    previous.onToggleSessionPin === next.onToggleSessionPin &&
    previous.onArchiveSession === next.onArchiveSession &&
    previous.onSessionContextMenu === next.onSessionContextMenu,
);
