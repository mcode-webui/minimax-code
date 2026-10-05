/** Pure grouping for the WebUI worktree surface (roadmap E 区「工作树隔离」).
 *
 * Creating an isolated worktree already works — the rail's context menu
 * carries 「复制到新工作树」 and the server answers with
 * `worktreeVisible` / `worktreeUnavailableReason`. What did not exist was a
 * place to see what those worktrees are, which is the "并行实验分支" half of
 * the row.
 *
 * A worktree is not a first-class field on a session. It is inferred: git
 * creates a second checkout with its own absolute path, so a session whose
 * `workspaceDir` differs from the project's default checkout is running in
 * one. `isDefaultWorkspace` is the runtime's own statement of which checkout
 * is the primary one, and it is trusted over any guess made here.
 *
 * Grouping is a pure function so it can be asserted without a DOM: the page
 * that renders it runs `renderToStaticMarkup`, which never runs effects.
 */

export interface WebuiWorktreeSession {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly parentSessionId?: string;
}

export interface WebuiWorktreeWorkspace {
  readonly workspaceDir: string;
  readonly name: string;
  /** True for the project's own checkout. A worktree is a non-primary one. */
  readonly isPrimary: boolean;
  readonly sessions: readonly WebuiWorktreeSession[];
  readonly updatedAt: number;
}

export interface WebuiWorktreeSourceSession {
  readonly sessionId: string;
  readonly title?: string;
  readonly archived?: boolean;
  readonly updatedAt: number;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly parentSessionId?: string;
}

/** Windows and POSIX spell the same checkout differently in stored paths
 * (`C:\repo` vs `C:/repo`). Normalising the separator keeps one worktree from
 * being reported twice because a fork round-tripped the path. */
export function normalizeWebuiWorkspaceDir(workspaceDir: string): string {
  return workspaceDir.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

export function webuiWorkspaceName(workspaceDir: string): string {
  const normalized = workspaceDir.trim().replace(/[\\/]+$/u, "");
  if (!normalized) return normalized;
  const segments = normalized.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

/** Groups sessions into checkouts, most recently touched first.
 *
 * Archived sessions are dropped: the archived page already owns them, and a
 * worktree whose every session is archived is not a parallel experiment
 * branch anyone is using. Sessions with no `workspaceDir` are dropped too —
 * there is no checkout to attach them to, and inventing a bucket for them
 * would show up as a phantom worktree. */
export function groupWebuiWorktreeWorkspaces(
  sessions: readonly WebuiWorktreeSourceSession[],
): readonly WebuiWorktreeWorkspace[] {
  const groups = new Map<string, { workspaceDir: string; isPrimary: boolean; sessions: WebuiWorktreeSession[]; updatedAt: number }>();
  for (const session of sessions) {
    if (session.archived) continue;
    const raw = session.workspaceDir?.trim();
    if (!raw) continue;
    const key = normalizeWebuiWorkspaceDir(raw);
    if (!key) continue;
    const existing = groups.get(key);
    const entry: WebuiWorktreeSession = {
      sessionId: session.sessionId,
      title: session.title?.trim() || session.sessionId,
      updatedAt: session.updatedAt,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    };
    if (existing) {
      existing.sessions.push(entry);
      // A checkout only counts as primary if the runtime said so. A later
      // session without the flag must not demote one that has it.
      existing.isPrimary = existing.isPrimary || session.isDefaultWorkspace === true;
      existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
      continue;
    }
    groups.set(key, {
      workspaceDir: raw,
      isPrimary: session.isDefaultWorkspace === true,
      sessions: [entry],
      updatedAt: session.updatedAt,
    });
  }
  const workspaces = [...groups.values()].map((group) => ({
    workspaceDir: group.workspaceDir,
    name: webuiWorkspaceName(group.workspaceDir),
    isPrimary: group.isPrimary,
    sessions: [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    updatedAt: group.updatedAt,
  }));
  // Primary first, then most recently touched. The tie-break on path keeps the
  // order stable when two checkouts share a timestamp, which a fast test
  // fixture almost always does.
  return workspaces.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.workspaceDir.localeCompare(b.workspaceDir);
  });
}

/** The parallel experiment branches: every checkout that is not the project's
 * own. This is the list the page is named after, so it is kept separate from
 * the grouping function rather than re-derived by the component. */
export function selectWebuiWorktreeWorkspaces(
  workspaces: readonly WebuiWorktreeWorkspace[],
): readonly WebuiWorktreeWorkspace[] {
  return workspaces.filter((workspace) => !workspace.isPrimary);
}

export function selectWebuiPrimaryWorkspace(
  workspaces: readonly WebuiWorktreeWorkspace[],
): WebuiWorktreeWorkspace | undefined {
  return workspaces.find((workspace) => workspace.isPrimary);
}
