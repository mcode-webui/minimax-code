/**
 * The project-group projection.
 *
 * `listVisibleProjects` answers "which projects exist"; the phone's remote-control
 * project list needs the sessions under each project as well, because that is where
 * its recent conversations come from. This pins that projection: the project view
 * the Desktop addresses projects by, and the session tree each group carries.
 */
import { describe, expect, it, vi } from "vitest";

import { SessionQueryApplication } from "./query-application.js";
import { projectDisplayName, toProjectDetail } from "./wire.js";

const projectRecord = {
  projectId: 1,
  projectKind: "workspace" as const,
  workspaceDir: "/workspace/demo",
  pinned: true,
  hidden: false,
  orderIndex: 3,
  recentAtMs: 1_700_000_000_000,
  latestActivityAtMs: 1_700_000_500_000,
  sessionCount: 2,
  extraDataJson: "",
  createdAtMs: 1_699_000_000_000,
  updatedAtMs: 1_700_000_500_000,
};

function application(
  groups: readonly unknown[],
): SessionQueryApplication {
  return new SessionQueryApplication({
    service: {} as never,
    projects: {
      list: async () => ({ projects: groups, hasMore: false }),
    } as never,
  });
}

describe("项目分组投影", () => {
  it("项目会话分页使用运行时返回的游标与会话树", async () => {
    const session = {
      sessionId: "s-1", agentName: "mavis", sessionType: "root", title: "Test", archived: false,
      status: "idle", createdAtMs: 1, updatedAtMs: 2, workspaceDir: "/workspace/demo",
      runtime: "pi-agent", isDefaultWorkspace: false, visibility: "visible", sessionKind: "conversation",
    };
    const listSessions = vi.fn(async () => ({ sessions: [session], childrenByParent: new Map(), hasMore: true, nextCursor: "next" }));
    const query = new SessionQueryApplication({ service: {} as never, projects: { listSessions } as never });
    const reference = { projectKey: "workspace:/workspace/demo" };
    const input = { filter: { archived: false }, cursor: "previous", limit: 1 };
    const page = await query.listProjectSessions(reference, input);
    expect(listSessions).toHaveBeenCalledWith(reference, input);
    expect(page).toMatchObject({ hasMore: true, nextCursor: "next", sessions: [{ session: { sessionId: "s-1" }, childSessions: [] }] });
  });
  it("项目视图带上手机寻址用的 key 与显示名", () => {
    const detail = toProjectDetail(projectRecord);

    expect(detail.key).toBe("workspace:/workspace/demo");
    expect(detail.workspaceDir).toBe("/workspace/demo");
    expect(detail.displayName).toBe("demo");
    expect(detail.latestActivityAt).toBe(1_700_000_500_000);
    expect(detail.sessionCount).toBe(2);
    expect(detail.state).toMatchObject({ pinned: true, hidden: false, orderIndex: 3 });
  });

  it("没有工作目录的项目落在默认桶里", () => {
    const detail = toProjectDetail({ ...projectRecord, workspaceDir: null, projectKind: "default" });

    expect(detail.key).toBe("default");
    expect(detail.workspaceDir).toBeUndefined();
    expect(detail.displayName).toBe("No project selected");
  });

  it("显示名取工作目录自己的名字", () => {
    expect(projectDisplayName("/workspace/demo")).toBe("demo");
    expect(projectDisplayName("/workspace/demo/nested")).toBe("nested");
    expect(projectDisplayName(undefined)).toBe("No project selected");
  });

  it("分组里带着项目自己的会话，手机的「最近」才有内容", async () => {
    const session = {
      sessionId: "s-1",
      agentName: "mavis",
      sessionType: "root",
      title: "跑一次回归",
      archived: false,
      status: "idle",
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_400_000,
      workspaceDir: "/workspace/demo",
      runtime: "pi-agent",
      isDefaultWorkspace: false,
      visibility: "visible",
      sessionKind: "conversation",
      runLocation: undefined,
    };

    const result = await application([
      {
        project: projectRecord,
        sessionCount: 1,
        sessions: [session],
        childrenByParent: new Map(),
        hasMoreSessions: false,
      },
    ]).listProjectGroups({
      sessionFilter: {
        archived: false,
        includeHidden: true,
        excludeInternalTreeSessions: true,
      },
    });

    expect(result.hasMore).toBe(false);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.project.key).toBe("workspace:/workspace/demo");
    expect(result.projects[0]?.sessions[0]?.session.sessionId).toBe("s-1");
    expect(result.projects[0]?.sessions[0]?.session.title).toBe("跑一次回归");
    expect(result.projects[0]?.sessions[0]?.childSessions).toEqual([]);
  });
});
