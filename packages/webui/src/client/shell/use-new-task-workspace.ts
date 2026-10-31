/**
 * The new-task workspace: which directory the next session starts in, and the
 * three ways that choice changes.
 *
 * The *policy* is not here. Which directory a fresh home starts in, what the
 * auto-fill may do to it, what an explicit pick or an explicit clearing means,
 * and what starting a new task does to the home's identity are all
 * `taskSessions`': the rule that an explicit "no project" choice wins over the
 * auto-fill lived in this file's effect before, where reaching it needed a
 * mounted shell. What stays is the presentation — the picker's open flag, the
 * recent-directory projection, and the navigation effects that only the shell
 * can perform.
 *
 * Extracted from `WebuiClientFoundationApp.tsx`: the frame keeps layout and
 * public business composition, and this is one behaviour with its own change
 * driver.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { deriveRecentWorkspaceDirs } from "../features/composer/projection/composer-state.js";
import { sessionHash } from "../projection/common/router.js";
import type { WebuiClientSession } from "../features/sessions/contracts/session-view.js";
import type { WebuiShellSurfaceCommand } from "../features/shell/projection/shell-surface.js";

/**
 * The workspace-policy capability the shell consumes, as the application's task
 * use case satisfies it. Declared here rather than imported: the shell may not
 * import the assembly, so it states the shape it needs and the composition
 * satisfies it.
 */
export interface NewTaskWorkspacePolicy {
  readonly initialWorkspaceDir: (input: {
    readonly selectedSessionId?: string;
    readonly sessions: readonly WebuiClientSession[];
  }) => string | undefined;
  readonly autoFillWorkspaceDir: (input: {
    readonly current: string | undefined;
    readonly selectedSessionId?: string;
    readonly sessions: readonly WebuiClientSession[];
  }) => string | undefined;
  readonly chooseWorkspaceDir: (workspaceDir: string | undefined) => string | undefined;
  readonly beginNewTask: (workspaceDir?: string) => {
    readonly navigationEpoch: number;
    readonly workspaceDir: string | undefined;
  };
}

export interface UseNewTaskWorkspaceOptions {
  /** The task/session use case: workspace policy, home identity, creation. */
  readonly taskSessions: NewTaskWorkspacePolicy;
  /** The session the shell currently shows, if any. */
  readonly selectedSession: WebuiClientSession | undefined;
  /** Every session visible to lookups (flat page plus tree children). */
  readonly flatSessionsWithChildren: readonly WebuiClientSession[];
  readonly setDraft: (draft: string) => void;
  readonly dispatchShellSurface: (command: WebuiShellSurfaceCommand) => void;
  readonly selectSession: (id: string | undefined) => void;
  /**
   * Records the Agent Team choice the created session was started with. Sessions
   * owns that choice, so this hook asks for the record rather than reaching the
   * storage adapter itself.
   */
  readonly recordSessionTeamMode: (sessionId: string, teamModeOff: boolean) => void;
}

export interface NewTaskWorkspace {
  readonly newTaskWorkspaceDir: string | undefined;
  readonly workspaceMenuOpen: boolean;
  readonly setWorkspaceMenuOpen: (open: boolean) => void;
  readonly recentWorkspaceDirs: readonly string[];
  readonly handleWorkspaceChange: (workspaceDir?: string) => void;
  readonly handleSessionCreatedViewEffect: (
    id: string,
    selected: boolean,
    teamModeOff: boolean,
  ) => void;
  readonly startNewTask: (workspaceDir?: string) => void;
}

export function useNewTaskWorkspace(options: UseNewTaskWorkspaceOptions): NewTaskWorkspace {
  const {
    taskSessions,
    selectedSession,
    flatSessionsWithChildren,
    setDraft,
    dispatchShellSurface,
    selectSession,
    recordSessionTeamMode,
  } = options;

  const [newTaskWorkspaceDir, setNewTaskWorkspaceDir] = useState<string | undefined>(() =>
    taskSessions.initialWorkspaceDir({
      selectedSessionId: selectedSession?.sessionId,
      sessions: flatSessionsWithChildren,
    }),
  );
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  // The `最近` group in the workspace picker. Derived from the sessions the
  // client already holds rather than a new operation — see
  // `deriveRecentWorkspaceDirs` for why there is nothing to call instead.
  const recentWorkspaceDirs = useMemo(
    () => deriveRecentWorkspaceDirs(flatSessionsWithChildren),
    [flatSessionsWithChildren],
  );
  useEffect(() => {
    // The use case answers with the directory that should be showing, so an
    // explicit clearing needs no separate flag here: it returns the current
    // value and nothing moves. The effect still owns *when* to ask — sessions
    // loading and the selection moving are shell facts.
    const next = taskSessions.autoFillWorkspaceDir({
      current: newTaskWorkspaceDir,
      selectedSessionId: selectedSession?.sessionId,
      sessions: flatSessionsWithChildren,
    });
    if (next !== newTaskWorkspaceDir) setNewTaskWorkspaceDir(next);
  }, [
    taskSessions,
    newTaskWorkspaceDir,
    flatSessionsWithChildren,
    selectedSession?.sessionId,
  ]);
  // Single workspace-change entry point the composer calls: the use case records
  // the user's intent (cleared vs picked) and answers what to render.
  const handleWorkspaceChange = useCallback(
    (workspaceDir?: string) => {
      setNewTaskWorkspaceDir(taskSessions.chooseWorkspaceDir(workspaceDir));
      setWorkspaceMenuOpen(false);
    },
    [taskSessions],
  );
  const handleSessionCreatedViewEffect = (
    id: string,
    selected: boolean,
    teamModeOff: boolean,
  ) => {
    // The choice the session was created with is recorded whichever surface
    // committed the creation: it is not a navigation effect, and a late
    // completion still records its legitimate state.
    recordSessionTeamMode(id, teamModeOff);
    // Rules 7-8: the browser effect consumes the committed result and checks the
    // navigation claim again. A user navigation between the business commit and
    // this effect wins, so a late background completion changes no selection and
    // no URL. The catalogue reads are not repeated here: creation completion
    // refreshes them in the use case, which is the one owner of that rule.
    if (!selected) return;
    selectSession(id);
    if (typeof window !== "undefined")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${sessionHash(id)}`,
      );
  };
  const startNewTask = (workspaceDir?: string) => {
    // A project row's plus action opens a fresh home composer preselected to
    // that workspace; the global new-task action still clears the workspace. The
    // choice is the use case's, so the persisted "no project" flag and the rule
    // about what an explicit clearing means have one home.
    //
    // Advance the home identity before clearing view state. A pending create must
    // finish against the incarnation that started it, not adopt into this new
    // home slot when the user explicitly starts another task.
    const task = taskSessions.beginNewTask(workspaceDir);
    setNewTaskWorkspaceDir(task.workspaceDir);
    setWorkspaceMenuOpen(false);
    setDraft("");
    // 「新建任务」 is the one navigation that does not change the selected
    // session when the shell is already on the home surface, so the effect that
    // watches the session id cannot see it. Close the marketplace here too, or
    // the row looks dead exactly as it did before.
    dispatchShellSurface({ type: "show-conversation" });
    selectSession(undefined);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  };

  return {
    newTaskWorkspaceDir,
    workspaceMenuOpen,
    setWorkspaceMenuOpen,
    recentWorkspaceDirs,
    handleWorkspaceChange,
    handleSessionCreatedViewEffect,
    startNewTask,
  };
}
