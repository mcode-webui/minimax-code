import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WebuiWorktreePanel } from "../../src/client/components/SettingsModal.js";
import {
  groupWebuiWorktreeWorkspaces,
  selectWebuiWorktreeWorkspaces,
  type WebuiWorktreeSourceSession,
} from "../../src/client/projection/worktree-state.js";

/* `renderToStaticMarkup` runs the first render and never runs effects, so the
 * fetching half of this page cannot be asserted here. What this file proves is
 * that the panel renders the grouping it is handed faithfully — in particular
 * that a page with no worktrees says so instead of showing an empty shell, and
 * that a branch's sessions are reachable by the same `#session=` link the rail
 * uses, so there is one navigation path rather than two. */

const main = "C:\\repos\\my-app";
const branchA = "C:\\repos\\my-app\\.worktrees\\feature-a";
const branchB = "C:\\repos\\my-app\\.worktrees\\feature-b";

const session = (
  sessionId: string,
  updatedAt: number,
  extra: Partial<WebuiWorktreeSourceSession> = {},
): WebuiWorktreeSourceSession => ({ sessionId, updatedAt, ...extra });

const panel = (sessions: readonly WebuiWorktreeSourceSession[], props: Record<string, unknown> = {}): string => {
  const workspaces = groupWebuiWorktreeWorkspaces(sessions);
  return renderToStaticMarkup(
    createElement(WebuiWorktreePanel, {
      workspaces,
      worktrees: selectWebuiWorktreeWorkspaces(workspaces),
      ...props,
    } as never),
  );
};

describe("worktree page", () => {
  it("says so plainly when there is no worktree yet", () => {
    const markup = panel([session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true })]);
    expect(markup).toContain('data-webui-worktree-state="empty"');
    expect(markup).toContain('data-testid="worktree-empty"');
    expect(markup).toContain("复制到新工作树");
  });

  /* The point of the row: a project with parallel experiment branches should
   * be able to see them. A page that renders only the primary checkout would
   * be indistinguishable from the empty state. */
  it("lists every worktree alongside the primary checkout", () => {
    const markup = panel([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true, title: "主线" }),
      session("s2", 300, { workspaceDir: branchA, title: "实验 A", parentSessionId: "s1" }),
      session("s4", 250, { workspaceDir: branchA, title: "实验 A 续", parentSessionId: "s1" }),
      session("s3", 200, { workspaceDir: branchB, title: "实验 B", parentSessionId: "s1" }),
    ]);
    expect(markup).toContain('data-webui-worktree-state="ready"');
    expect(markup).toContain('data-testid="worktree-primary"');
    expect(markup).toContain("主线");
    expect(markup).toContain("实验 A");
    expect(markup).toContain("实验 A 续");
    expect(markup).toContain("实验 B");
    expect(markup).toContain("主检出");
    // feature-a holds two sessions and feature-b one, so the per-branch count
    // has to differ between them rather than repeat a single number.
    expect(markup).toContain("2 个会话");
    expect(markup).toContain("1 个会话");
  });

  it("links a branch session through the same hash route the rail uses", () => {
    const markup = panel([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: branchA, title: "实验 A" }),
    ]);
    expect(markup).toContain('href="#session=s2"');
    expect(markup).toContain('data-webui-worktree-session="s2"');
  });

  it("marks a session forked from another as derived", () => {
    const markup = panel([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: branchA, parentSessionId: "s1" }),
    ]);
    expect(markup).toContain("派生");
    expect(markup).toContain("派生自 s1");
  });

  it("reports a failed load as an error", () => {
    const markup = panel([], { error: "会话列表读取失败" });
    expect(markup).toContain('data-webui-worktree-state="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("会话列表读取失败");
  });

  it("shows the full checkout path so two branches of the same name are distinguishable", () => {
    const markup = panel([
      session("s1", 100, { workspaceDir: main, isDefaultWorkspace: true }),
      session("s2", 300, { workspaceDir: branchA }),
    ]);
    expect(markup).toContain(branchA);
  });
});
