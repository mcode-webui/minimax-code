// Which sessions the rail is showing, per view.
//
// The rail had one view: every session, grouped by project. That answers
// "where did I put that thing" and nothing else. With sessions running in
// parallel -- the runtime keeps a drain loop per session id -- it cannot answer
// "what is working right now" or "what finished while I was elsewhere" without
// the reader scanning every project.
//
// Those are not a second and third grouping to stack on top of the project
// list. Stacking them forces a choice between showing the same session twice
// and stripping it out of its project, and both are wrong: one doubles the
// rail's length, the other empties a project of everything unread. So they are
// separate *views* of the same list, and only one is on screen at a time. Each
// view is internally complete, which is what lets the count on a tab be a
// number the reader can reconcile against the rows they are looking at.
//
// The counts are the reason this is worth a tab rather than a badge. Knowing
// "2 running, 3 unread" without looking is the entire benefit; a badge on a
// session the reader has to find first does not carry that.
//
// Nothing here fetches, stores or persists. `session-activity.ts` already
// tracks `busy` and `unread` per session, so this is a filter and a sort over
// data the rail is already holding.

import type { WebuiClientSession } from "./contracts.js";
import type { WebuiSessionActivityMap } from "./session-activity.js";

export type WebuiRailView = "projects" | "running" | "unread";

export interface WebuiRailViewTab {
  readonly view: WebuiRailView;
  readonly label: string;
  /**
   * What the view says when it is empty. "No sessions yet" is a lie in these
   * views -- there are plenty of sessions, just not the kind this tab collects.
   */
  readonly emptyLabel: string;
  /**
   * Rows this view would show. `projects` reports the whole page because that
   * view is not a filter and a number there would mean nothing.
   */
  readonly count: number;
}

const TAB_LABELS: Readonly<Record<WebuiRailView, string>> = {
  projects: "项目",
  running: "运行中",
  unread: "未读",
};

const TAB_EMPTY_LABELS: Readonly<Record<WebuiRailView, string>> = {
  projects: "暂无会话",
  running: "没有运行中的会话",
  unread: "没有未读会话",
};

/**
 * Last activity for a session, preferring what this client observed.
 *
 * A session with no entry never watched by this client, or paged out of the
 * list and back in. `updatedAt` is the record's own timestamp and moves for
 * reasons unrelated to a turn, so it is a tiebreaker, not a claim.
 */
function activityOf(
  activity: WebuiSessionActivityMap | undefined,
  sessionId: string,
): number | undefined {
  return activity?.[sessionId]?.lastActivityAt;
}

function sortByLastActivity(
  left: WebuiClientSession,
  right: WebuiClientSession,
  activity: WebuiSessionActivityMap | undefined,
): number {
  return (
    (activityOf(activity, right.sessionId) ?? right.updatedAt) -
    (activityOf(activity, left.sessionId) ?? left.updatedAt)
  );
}

/**
 * The sessions a view shows, newest activity first.
 *
 * `projects` is passed through untouched. The project view owns its own
 * grouping and ordering, and re-ordering here would fight it.
 */
export function filterWebuiRailViewSessions(
  sessions: readonly WebuiClientSession[],
  activity: WebuiSessionActivityMap | undefined,
  view: WebuiRailView,
): readonly WebuiClientSession[] {
  if (view === "projects") return sessions;
  const selected = sessions.filter((session) => {
    const entry = activity?.[session.sessionId];
    // A session that is both running and unread belongs to "running": it is
    // mid-answer, so the answer is not waiting on the reader yet. Listing it
    // in both views is the duplication the view switch exists to remove.
    if (view === "running") return entry?.busy !== undefined;
    return entry?.unread !== undefined && entry.unread > 0 && entry.busy === undefined;
  });
  return [...selected].sort((left, right) =>
    sortByLastActivity(left, right, activity),
  );
}

/**
 * The tab row, with the count each view would show.
 *
 * Counts are derived from the page rather than from the activity map, so a
 * session that finished and was archived, or one this page has not paged in,
 * cannot put a number on a tab that no row accounts for.
 */
export function selectWebuiRailViewTabs(
  sessions: readonly WebuiClientSession[],
  activity: WebuiSessionActivityMap | undefined,
): readonly WebuiRailViewTab[] {
  return (["projects", "running", "unread"] as const).map((view) => ({
    view,
    label: TAB_LABELS[view],
    emptyLabel: TAB_EMPTY_LABELS[view],
    count: filterWebuiRailViewSessions(sessions, activity, view).length,
  }));
}
