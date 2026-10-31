// The rail's grouping, labelling and search rules.
//
// These are the decisions about *which* sessions and projects the rail shows and
// in what order, with no React in them: the project grouping the rail
// is built on, the pin-then-recency order inside a group, the label a row
// renders, and the two search predicates (a session, and a project row).
//
// They were declared inside `SessionRail.tsx` — a presentation module —
// so the rules could only be exercised through a component that has to be
// rendered to run at all. They are the same bodies, moved; the rail imports them
// from here and `session-rail-search.test.ts` drives them directly.

import type { WebuiClientSession } from "../contracts/session-view.js";
import { workspaceProjectName } from "../../workspace/projection/workspace-name.public.js";

export const PROJECT_SESSION_BATCH_SIZE = 6;
export const PROJECT_GROUP_BATCH_SIZE = 6;

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
 * The home rail is project-first, even though its source data is a
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
