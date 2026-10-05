import { describe, expect, it } from "vitest";

import {
  groupWebuiWorktreeWorkspaces,
  normalizeWebuiWorkspaceDir,
  selectWebuiPrimaryWorkspace,
  selectWebuiWorktreeWorkspaces,
  webuiWorkspaceName,
  type WebuiWorktreeSourceSession,
} from "../../src/client/projection/worktree-state.js";

const session = (
  sessionId: string,
  updatedAt: number,
  extra: Partial<WebuiWorktreeSourceSession> = {},
): WebuiWorktreeSourceSession => ({ sessionId, updatedAt, ...extra });

describe("workspace path normalization", () => {
  /* A fork round-trips the path through the runtime, and Windows and POSIX
   * spell the same checkout differently. One checkout reported as two
   * worktrees is a wrong list, not a cosmetic one. */
  it("treats separator and trailing-slash variants as one checkout", () => {
    expect(normalizeWebuiWorkspaceDir("C:\\repo")).toBe("c:/repo");
    expect(normalizeWebuiWorkspaceDir("C:/repo")).toBe("c:/repo");
    expect(normalizeWebuiWorkspaceDir("C:/repo/")).toBe("c:/repo");
    expect(normalizeWebuiWorkspaceDir("  C:\\repo\\  ")).toBe("c:/repo");
  });

  it("names a checkout from its last path segment", () => {
    expect(webuiWorkspaceName("C:\\repos\\my-app")).toBe("my-app");
    expect(webuiWorkspaceName("/home/dev/my-app/")).toBe("my-app");
    expect(webuiWorkspaceName("")).toBe("");
  });
});

describe("grouping sessions into checkouts", () => {
  const main = "C:\\repos\\my-app";
  const worktreeA = "C:\\repos\\my-app\\.worktrees\\feature-a";
  const worktreeB = "C:\\repos\\my-app\\.worktrees\\feature-b";

  it("separates the primary checkout from its worktrees", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: worktreeA, parentSessionId: "s1" }),
      session("s3", 200, { workspaceDir: worktreeB, parentSessionId: "s1" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.isPrimary).toBe(true);
    expect(selectWebuiPrimaryWorkspace(groups)?.workspaceDir).toBe(main);
    expect(selectWebuiWorktreeWorkspaces(groups).map((group) => group.name)).toEqual(["feature-a", "feature-b"]);
  });

  it("orders worktrees by most recently touched, primary first", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: worktreeA }),
      session("s3", 200, { workspaceDir: worktreeB }),
    ]);
    expect(groups.map((group) => group.workspaceDir)).toEqual([main, worktreeA, worktreeB]);
    // The primary sorts first even though it is the oldest of the three.
    expect(groups[0]?.updatedAt).toBe(100);
    expect(groups[1]?.updatedAt).toBe(300);
  });

  it("keeps a checkout primary when a later session omits the flag", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 200, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 100, { workspaceDir: main }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.isPrimary).toBe(true);
    expect(groups[0]?.sessions).toHaveLength(2);
  });

  it("merges sessions that reach the same checkout by different spellings", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 200, { workspaceDir: "C:\\repos\\my-app", isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: "c:/repos/my-app/" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((entry) => entry.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(groups[0]?.updatedAt).toBe(300);
  });

  it("sorts the sessions inside a checkout by most recently touched", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("old", 100, { workspaceDir: worktreeA }),
      session("new", 500, { workspaceDir: worktreeA }),
      session("mid", 300, { workspaceDir: worktreeA }),
    ]);
    expect(groups[0]?.sessions.map((entry) => entry.sessionId)).toEqual(["new", "mid", "old"]);
  });

  /* An archived session belongs to the archived page. Counting it here would
   * make an abandoned worktree look like a live experiment branch. */
  it("drops archived sessions and the worktrees that were only archived", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: worktreeA, archived: true }),
    ]);
    expect(groups).toHaveLength(1);
    expect(selectWebuiWorktreeWorkspaces(groups)).toEqual([]);
  });

  /* A session with no checkout has no worktree to belong to; a synthetic
   * bucket for it would show up as a phantom branch. */
  it("drops sessions with no workspace", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 100),
      session("s2", 200, { workspaceDir: "   " }),
      session("s3", 300, { workspaceDir: main, isDefaultWorkspace: true }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((entry) => entry.sessionId)).toEqual(["s3"]);
  });

  it("falls back to the session id when a title is blank", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s1", 100, { workspaceDir: main, title: "   " }),
    ]);
    expect(groups[0]?.sessions[0]?.title).toBe("s1");
  });

  it("carries the fork parent so a branch can be traced to its origin", () => {
    const groups = groupWebuiWorktreeWorkspaces([
      session("s2", 100, { workspaceDir: worktreeA, parentSessionId: "s1" }),
      session("s3", 100, { workspaceDir: worktreeB }),
    ]);
    expect(groups[0]?.sessions[0]?.parentSessionId).toBe("s1");
    expect(groups[1]?.sessions[0]?.parentSessionId).toBeUndefined();
  });

  it("orders equal timestamps deterministically by path", () => {
    const first = groupWebuiWorktreeWorkspaces([
      session("s1", 100, { workspaceDir: "C:\\b" }),
      session("s2", 100, { workspaceDir: "C:\\a" }),
    ]);
    const second = groupWebuiWorktreeWorkspaces([
      session("s2", 100, { workspaceDir: "C:\\a" }),
      session("s1", 100, { workspaceDir: "C:\\b" }),
    ]);
    expect(first.map((group) => group.workspaceDir)).toEqual(second.map((group) => group.workspaceDir));
    expect(first.map((group) => group.name)).toEqual(["a", "b"]);
  });

  it("handles an empty session list", () => {
    expect(groupWebuiWorktreeWorkspaces([])).toEqual([]);
    expect(selectWebuiWorktreeWorkspaces([])).toEqual([]);
    expect(selectWebuiPrimaryWorkspace([])).toBeUndefined();
  });
});
