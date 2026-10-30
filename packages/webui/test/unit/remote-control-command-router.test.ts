/**
 * 桥的命令路由所调用的本地运行时入口。
 *
 * 被测的是映射本身：桥发过来的 Desktop 路由落到 WebUI 运行时上，回给桥的响应体是桥的解析器
 * 吃得懂的形状。运行时是脚本化的，路由是真实的那一份 —— 所以一个从 Desktop 学到词汇的手机，
 * 在这里也能读懂答案。
 *
 * 置顶状态与队列由运行时拥有，入口只转换 Desktop 的 HTTP 字段。
 */
import { describe, expect, it } from "vitest";

import { createRemoteControlLocalRuntimeInvoke } from "../../src/runtime/remote-control/command-router.js";

const DESKTOP = "http://localhost/minimax-desktop/api/v1";

interface Call {
  readonly method: string;
  readonly args: unknown;
}

/** 一个会记账的运行时。 */
function cliServiceStub(
  overrides: Record<string, unknown> = {},
  options: { readonly permissionSucceeds?: boolean } = {},
) {
  const calls: Call[] = [];
  const record = (method: string) => async (request: unknown) => {
    calls.push({ method, args: request });
  };
  return {
    calls,
    getSessionTree: async (request: unknown) => {
      calls.push({ method: "getSessionTree", args: request });
      return {
        sessions: [
          {
            session: {
              sessionId: "s-1",
              title: "跑一次回归",
              visibility: "visible",
              status: { statusType: 1 },
              updatedAt: 1_700_000_000_000,
              workspaceDir: "/workspace/demo",
            },
            childSessions: [],
          },
        ],
        hasMore: false,
      };
    },
    searchSessions: async (request: unknown) => {
      calls.push({ method: "searchSessions", args: request });
      return {
        sessions: [
          {
            sessionId: "s-1",
            title: "跑一次回归",
            visibility: "visible",
            status: { statusType: 1 },
            updatedAt: 1_700_000_000_000,
            workspaceDir: "/workspace/demo",
          },
        ],
        hasMore: false,
      };
    },
    getMessages: async (request: unknown) => {
      calls.push({ method: "getMessages", args: request });
      return {
        messages: [{ msgId: "m-1", msgContent: "继续" }],
        hasMore: false,
        lastMsgId: "m-1",
      };
    },
    sendMessage: async (request: unknown) => {
      calls.push({ method: "sendMessage", args: request });
      return {
        ok: true,
        source: {
          async *[Symbol.asyncIterator]() {
            yield { cursor: "c-1", dataJson: "[DONE]" };
          },
        },
      };
    },
    enqueueMessage: async (request: unknown) => {
      calls.push({ method: "enqueueMessage", args: request });
      return { itemId: "q-1", status: "queued", position: 0 };
    },
    listQueueMessages: async (request: unknown) => {
      calls.push({ method: "listQueueMessages", args: request });
      return { items: [{ itemId: "q-1", sessionId: "s-1", status: "queued" }], paused: false, pendingCount: 1 };
    },
    deleteQueueItem: async (request: unknown) => {
      calls.push({ method: "deleteQueueItem", args: request });
      return { item: { itemId: "q-1", sessionId: "s-1", status: "cancelled" } };
    },
    getQueueItem: async (request: unknown) => {
      calls.push({ method: "getQueueItem", args: request });
      return { item: { itemId: "q-1", sessionId: "s-1", status: "queued" } };
    },
    updateQueueItem: async (request: unknown) => {
      calls.push({ method: "updateQueueItem", args: request });
      return { item: { itemId: "q-1", sessionId: "s-1", status: "queued", content: "updated" } };
    },
    reorderQueue: async (request: unknown) => {
      calls.push({ method: "reorderQueue", args: request });
      return { items: [{ itemId: "q-1", sessionId: "s-1", status: "queued" }] };
    },
    getPendingQuestionnaire: async (request: unknown) => {
      calls.push({ method: "getPendingQuestionnaire", args: request });
      return { request: { requestId: "r-1", sessionId: "s-1", schemaVersion: 1 } };
    },
    getLatestPlanReview: async (request: unknown) => {
      calls.push({ method: "getLatestPlanReview", args: request });
      return {};
    },
    replyQuestionnaire: async (request: unknown) => {
      calls.push({ method: "replyQuestionnaire", args: request });
      return { ok: true, requestId: "r-1", sessionId: "s-1", answeredAt: 123 };
    },
    dismissQuestionnaire: async (request: unknown) => {
      calls.push({ method: "dismissQuestionnaire", args: request });
      return { ok: true, requestId: "r-1", sessionId: "s-1", dismissedAt: 124 };
    },
    listPendingPermissions: async (request: unknown) => {
      calls.push({ method: "listPendingPermissions", args: request });
      return { requests: [{ requestId: "r-1", sessionId: "s-1", toolInput: '{"filePath":"a"}' }] };
    },
    getGoal: async (request: unknown) => {
      calls.push({ method: "getGoal", args: request });
      return undefined;
    },
    createGoal: async (request: unknown) => {
      calls.push({ method: "createGoal", args: request });
      return { goalId: "g-1", sessionId: "s-1", objective: "test", status: "active", createdAt: 1, updatedAt: 2, tokensUsed: 0, turnsUsed: 0, timeUsedSeconds: 0, tokenBudget: null, statusReason: null };
    },
    patchGoal: async (sessionId: string, patch: unknown) => {
      calls.push({ method: "patchGoal", args: { sessionId, patch } });
      return { goalId: "g-1", sessionId, objective: "test", status: "paused", createdAt: 1, updatedAt: 2, tokensUsed: 0, turnsUsed: 0, timeUsedSeconds: 0, tokenBudget: null, statusReason: null };
    },
    getPinnedItemsOrder: async () => {
      calls.push({ method: "getPinnedItemsOrder", args: undefined });
      return { items: [{ itemType: 1, id: "s-1", session: { sessionId: "s-1" } }] };
    },
    putPinnedItemsOrder: async (request: unknown) => {
      calls.push({ method: "putPinnedItemsOrder", args: request });
      return { items: [] };
    },
    pinSession: async (request: unknown) => {
      calls.push({ method: "pinSession", args: request });
      return { success: true, items: [{ itemType: 1, id: "s-1" }] };
    },
    createSession: async (request: unknown) => {
      calls.push({ method: "createSession", args: request });
      return { agentName: "main", sessionId: "s-new", session: { sessionId: "s-new" } };
    },
    getSession: async (request: unknown) => {
      calls.push({ method: "getSession", args: request });
      return { session: { sessionId: "s-1", title: "跑一次回归", model: { providerId: "p", modelId: "m" } } };
    },
    updateSession: async (request: unknown) => {
      calls.push({ method: "updateSession", args: request });
      return { session: { sessionId: "s-1", title: "新标题" } };
    },
    deleteSession: async (request: unknown) => {
      calls.push({ method: "deleteSession", args: request });
      return { success: true };
    },
    resumeSession: async (request: unknown) => {
      calls.push({ method: "resumeSession", args: request });
      return {
        ok: true,
        source: {
          async *[Symbol.asyncIterator]() {
            yield { dataJson: "[RESUMED]" };
          },
        },
      };
    },
    abortSession: async (request: unknown) => {
      calls.push({ method: "abortSession", args: request });
      return { success: true };
    },
    replyPermission: async (request: unknown) => {
      calls.push({ method: "replyPermission", args: request });
      return { success: options.permissionSucceeds ?? true };
    },
    listModels: async (request: unknown) => {
      calls.push({ method: "listModels", args: request });
      return [
        {
          providerId: "minimax",
          modelId: "m-1",
          enabled: true,
          selected: true,
          contextLimit: 200_000,
        },
      ];
    },
    selectModel: async (input: unknown) => {
      calls.push({ method: "selectModel", args: input });
      return true;
    },
    listSkills: async (request: unknown) => {
      calls.push({ method: "listSkills", args: request });
      return { skills: [{ name: "review", displayName: "Review" }] };
    },
    listVisibleProjects: async (limit?: number) => {
      calls.push({ method: "listVisibleProjects", args: limit });
      return [
        {
          projectId: 1,
          projectKind: "workspace",
          workspaceDir: "/workspace/demo",
          pinned: false,
          hidden: false,
          orderIndex: 0,
          recentAtMs: null,
          latestActivityAtMs: 1_700_000_000_000,
          sessionCount: 2,
        },
        {
          projectId: 2,
          projectKind: "default",
          workspaceDir: null,
          pinned: false,
          hidden: true,
          orderIndex: 1,
          recentAtMs: null,
          latestActivityAtMs: 1,
          sessionCount: 0,
        },
      ];
    },
    getPermissionMode: async () => {
      calls.push({ method: "getPermissionMode", args: undefined });
      return "auto";
    },
    getWorkspaceGitBranches: async (workspaceDir: string, includeRemote?: boolean) => {
      calls.push({ method: "getWorkspaceGitBranches", args: { workspaceDir, includeRemote } });
      return {
        success: true,
        current: "main",
        branches: ["main", "feature/x"],
        local: ["main", "feature/x"],
      };
    },
    getWorkspaceGitBranchPicker: async (workspaceDir: string) => {
      calls.push({ method: "getWorkspaceGitBranchPicker", args: workspaceDir });
      return {
        success: true,
        current: "main",
        branches: ["main"],
        local: ["main"],
        worktrees: [{ path: "/workspace/demo", branch: "main", isMain: true }],
      };
    },
    listProjectGroups: async (request: unknown) => {
      calls.push({ method: "listProjectGroups", args: request });
      return {
        projects: [
          {
            project: {
              key: "workspace:/workspace/demo",
              projectId: 1,
              workspaceDir: "/workspace/demo",
              displayName: "demo",
              archived: false,
              latestActivityAt: 1_700_000_000_000,
              sessionCount: 2,
            },
            sessions: [
              {
                session: {
                  sessionId: "s-1",
                  title: "跑一次回归",
                  status: { statusType: 1 },
                  updatedAt: 1_700_000_000_000,
                  workspaceDir: "/workspace/demo",
                },
                childSessions: [],
              },
            ],
            hasMoreSessions: false,
          },
        ],
        hasMore: false,
      };
    },
    ...overrides,
  };
}

interface Harness {
  readonly invoke: (request: Request) => Promise<Response>;
  readonly calls: Call[];
  readonly logs: string[];
}

function harness(
  overrides: Record<string, unknown> = {},
  options: { readonly permissionSucceeds?: boolean; readonly browserPort?: import("../../src/runtime/remote-control/command-router.js").RemoteControlLocalRuntimeInvokeOptions["browserPort"] } = {},
): Harness {
  const cliService = cliServiceStub(overrides, options);
  const logs: string[] = [];
  const logger = {
    debug: (message: string) => logs.push(message),
    info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
    error: (message: string) => logs.push(message),
  };
  return {
    invoke: createRemoteControlLocalRuntimeInvoke({
      cliService: cliService as never,
      logger,
      agentName: "main",
      ...(options.browserPort ? { browserPort: options.browserPort } : {}),
    }),
    calls: cliService.calls,
    logs,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
): Request {
  return new Request(`${DESKTOP}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("本地运行时入口", () => {
  it("把会话树路由中的 agent 交给运行时", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(request("GET", "/agent/mavis/session/tree?limit=25"));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "getSessionTree", args: { name: "mavis", limit: 25 } });
  });

  it("把会话检索和分页交给运行时", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(request("GET", "/session/search?keyword=回归&limit=12"));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.sessions).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "searchSessions", args: { agentName: "main", keyword: "回归", limit: 12 } });
    await invoke(request("GET", "/session/search?agent_name=custom&keyword=term"));
    expect(calls[1]).toEqual({ method: "searchSessions", args: { agentName: "custom", keyword: "term" } });
  });

  it("读会话记录时给出桥的解析器吃得懂的形状", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(request("GET", "/session/s-1/message?limit=15"));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.messages).toEqual([{ msgId: "m-1", msgContent: "继续" }]);
    expect(body.hasMore).toBe(false);
    expect(calls[0]).toEqual({ method: "getMessages", args: { id: "s-1", limit: 15 } });
  });

  it("发消息时回一串 SSE 帧，而不是 JSON", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/session/s-1/message", { content: "继续" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("id: c-1\ndata: [DONE]\n\n");
    expect(calls[0]).toEqual({
      method: "sendMessage",
      args: { id: "s-1", content: "继续" },
    });
  });

  it("会话正忙时如实回 409 与 busy 的 code，让桥转去排队", async () => {
    const { invoke } = harness({
      sendMessage: async () => ({
        ok: false,
        status: 409,
        body: { key: "local_session_busy", message: "the session is busy" },
      }),
    });

    const response = await invoke(
      request("POST", "/session/s-1/message", { content: "继续" }),
    );

    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.key).toBe("local_session_busy");
    expect(body.message).toBe("the session is busy");
  });

  it("排队时给出队列项的 id", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/session/s-1/queue", { content: "排队" }),
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.item_id).toBe("q-1");
    expect(calls[0]).toEqual({
      method: "enqueueMessage",
      args: { id: "s-1", content: "排队" },
    });
  });

  it("读取和删除队列项时使用 Desktop 的 wire 字段", async () => {
    const { invoke, calls } = harness();
    const list = await invoke(request("GET", "/session/s-1/queue"));
    expect(await json(list)).toEqual({
      items: [{ item_id: "q-1", session_id: "s-1", status: "queued" }],
      paused: false,
      pending_count: 1,
    });
    const deleted = await invoke(request("DELETE", "/session/s-1/queue/q-1"));
    expect(await json(deleted)).toEqual({
      item: { item_id: "q-1", session_id: "s-1", status: "cancelled" },
    });
    expect(calls).toEqual([
      { method: "listQueueMessages", args: { id: "s-1" } },
      { method: "deleteQueueItem", args: { id: "s-1", itemId: "q-1" } },
    ]);
  });

  it("读取、编辑和排序队列时保留运行时请求与 Desktop 应答", async () => {
    const { invoke, calls } = harness();
    expect(await json(await invoke(request("GET", "/session/s-1/queue/q-1")))).toEqual({ item: { item_id: "q-1", session_id: "s-1", status: "queued" } });
    expect(await json(await invoke(request("PATCH", "/session/s-1/queue/q-1", { content: "updated", attachments: [] })))).toMatchObject({ item: { content: "updated" } });
    expect(await json(await invoke(request("POST", "/session/s-1/queue/reorder", { item_ids: ["q-1"] })))).toMatchObject({ items: [{ item_id: "q-1" }] });
    expect(calls).toEqual([
      { method: "getQueueItem", args: { id: "s-1", itemId: "q-1" } },
      { method: "updateQueueItem", args: { id: "s-1", itemId: "q-1", content: "updated", attachments: [] } },
      { method: "reorderQueue", args: { id: "s-1", itemIds: ["q-1"] } },
    ]);
    expect((await invoke(request("POST", "/session/s-1/queue/reorder", { item_ids: [1] }))).status).toBe(400);
  });

  it("按会话读取待回答的问题并使用 Desktop 的 wire 字段", async () => {
    const { invoke, calls } = harness();
    const missing = await invoke(request("GET", "/agent/mavis/questionnaire/pending"));
    expect(missing.status).toBe(400);
    const result = await invoke(request("GET", "/agent/mavis/questionnaire/pending?session_id=s-1"));
    expect(await json(result)).toEqual({ request: { request_id: "r-1", session_id: "s-1", schema_version: 1 } });
    expect(calls).toEqual([{ method: "getPendingQuestionnaire", args: { name: "mavis", sessionId: "s-1" } }]);
  });

  it("读取权限、计划审阅和目标的真实状态", async () => {
    const { invoke, calls } = harness();
    expect(await json(await invoke(request("GET", "/permission/requests")))).toEqual({ requests: [{ request_id: "r-1", session_id: "s-1", tool_input: '{"filePath":"a"}' }] });
    expect(await json(await invoke(request("GET", "/agent/mavis/s-1/questionnaire/plan-review")))).toEqual({});
    expect(await json(await invoke(request("GET", "/session/s-1/goal")))).toEqual({});
    expect(calls).toEqual([
      { method: "listPendingPermissions", args: {} },
      { method: "getLatestPlanReview", args: { name: "mavis", sessionId: "s-1" } },
      { method: "getGoal", args: "s-1" },
    ]);
  });

  it("将运行时的目标等待状态映射为 Desktop GoalState", async () => {
    const { invoke } = harness({ getGoal: async () => ({
      goalId: "g-1", sessionId: "s-1", objective: "test", status: "active", createdAt: 1, updatedAt: 2,
      tokensUsed: 3, turnsUsed: 4, timeUsedSeconds: 5, tokenBudget: null, statusReason: null,
      executionWait: { reason: "questionnaire", sinceMs: 42 },
      objectiveResources: [{ type: "file", filePath: "/workspace/a.txt", fileName: "a.txt", mimeType: "text/plain", assetId: "asset-1" }],
    }) });
    expect(await json(await invoke(request("GET", "/session/s-1/goal")))).toEqual({ goal: {
      goal_id: "g-1", session_id: "s-1", objective: "test", status: "active", created_at: 1, updated_at: 2,
      tokens_used: 3, turns_used: 4, time_used_seconds: 5,
      objective_resources: [{ meta: { attachment_type: "file", file_name: "a.txt", mime_type: "text/plain" }, local: { asset_id: "asset-1", file_path: "/workspace/a.txt" } }],
      execution: { wait_reason: "questionnaire", wait_since: 42 },
    } });
  });

  it("创建目标时要求运行时完成 kickoff 准入并转发附件", async () => {
    const { invoke, calls } = harness();
    const result = await invoke(request("POST", "/session/s-1/goal", { objective: "test", token_budget: 500 }));
    expect((await json(result)).goal).toMatchObject({ goal_id: "g-1", session_id: "s-1", objective: "test" });
    expect(calls).toEqual([{ method: "createGoal", args: { sessionId: "s-1", objective: "test", tokenBudget: 500, requireKickoffAdmission: true } }]);
    expect((await invoke(request("POST", "/session/s-1/goal", { objective: "test", attachments: [{ meta: { file_name: "x.txt", mime_type: "text/plain" }, local: { file_path: "/download/x.txt" } }] }))).status).toBe(200);
    expect(calls[1]).toEqual({ method: "createGoal", args: { sessionId: "s-1", objective: "test", kickoffAttachments: [{ type: "file", filePath: "/download/x.txt", fileName: "x.txt", mimeType: "text/plain" }], requireKickoffAdmission: true } });
    expect((await invoke(request("POST", "/session/s-1/goal", { objective: "test", attachments: [{}] }))).status).toBe(400);
  });

  it("目标更新保留并发检查并拒绝不完整的检查条件", async () => {
    const { invoke, calls } = harness();
    const result = await invoke(request("PATCH", "/session/s-1/goal", { status: "paused", expected_goal_id: "g-1", expected_updated_at: 42 }));
    expect((await json(result)).goal).toMatchObject({ goal_id: "g-1", status: "paused" });
    expect(calls).toEqual([{ method: "patchGoal", args: { sessionId: "s-1", patch: { status: "paused", expectedGoalId: "g-1", rejectIfUpdatedAtChangedFrom: 42 } } }]);
    expect((await invoke(request("PATCH", "/session/s-1/goal", { status: "paused", expected_goal_id: "g-1" }))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("编辑目标时保留空资源列表的清空语义", async () => {
    const { invoke, calls } = harness();
    const result = await invoke(request("PATCH", "/session/s-1/goal", { objective: "new", objective_resources: [] }));
    expect(result.status).toBe(200);
    expect(calls).toEqual([{ method: "patchGoal", args: { sessionId: "s-1", patch: { objective: "new", objectiveResources: [] } } }]);
  });

  it("按 Desktop 的回答与取消契约转发问题", async () => {
    const { invoke, calls } = harness();
    const reply = await invoke(request("POST", "/agent/mavis/questionnaire/r-1/reply", {
      schema_version: 1, answers: [{ step_id: "step-1", selected_option_ids: ["a"], selected_other: true, other_text: "other" }], submitted_at: 120,
    }));
    expect(await json(reply)).toEqual({ ok: true, request_id: "r-1", session_id: "s-1", answered_at: 123 });
    const dismiss = await invoke(request("POST", "/agent/mavis/questionnaire/r-1/dismiss", {}));
    expect(await json(dismiss)).toEqual({ ok: true, request_id: "r-1", session_id: "s-1", dismissed_at: 124 });
    expect(calls).toEqual([
      { method: "replyQuestionnaire", args: { name: "mavis", requestId: "r-1", schemaVersion: 1, answers: [{ stepId: "step-1", selectedOptionIds: ["a"], selectedOther: true, otherText: "other" }], submittedAt: 120 } },
      { method: "dismissQuestionnaire", args: { name: "mavis", requestId: "r-1" } },
    ]);
    expect((await invoke(request("POST", "/agent/mavis/questionnaire/r-1/reply", { schema_version: 1, answers: [{ step_id: "step-1", selected_option_ids: [7] }] }))).status).toBe(400);
  });

  it("保留运行时问题回复的状态和错误码", async () => {
    const error = Object.assign(new Error("not visible"), { status: 403, code: "AGENT_SCOPE_MISMATCH" });
    const { invoke } = harness({ replyQuestionnaire: async () => { throw error; } });
    const result = await invoke(request("POST", "/agent/mavis/questionnaire/r-1/reply", { schema_version: 2, answers: [] }));
    expect(result.status).toBe(403);
    expect(await json(result)).toEqual({ key: "AGENT_SCOPE_MISMATCH", message: "not visible" });
  });

  it("新建会话时把标题、模型与位置直接交给运行时", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/agent/mavis/session", {
        title: "新会话",
        workspace_dir: "/workspace/demo",
        team_mode_off: true,
        model: { provider_id: "minimax", model_id: "m-1" },
        parent_session_id: "parent-1",
        run_location: { mode: "local", worktree_dir: "/workspace/tree", new_worktree_branch: "feature" },
      }),
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.session_id).toBe("s-new");
    expect(body.agent_name).toBe("main");
    expect(calls[0]).toEqual({
      method: "createSession",
      args: { name: "mavis", workspaceDir: "/workspace/demo", teamModeOff: true, title: "新会话", parentSessionId: "parent-1", model: { providerId: "minimax", modelId: "m-1" }, runLocation: { mode: "local", worktreeDir: "/workspace/tree", newWorktreeBranch: "feature" } },
    });
    expect(calls).toHaveLength(1);
    expect(body.session).toMatchObject({ session_id: "s-new" });
  });

  it("列出模型时包成桥的形状", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(request("GET", "/models/list"));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.models).toEqual([
      {
        providerId: "minimax",
        modelId: "m-1",
        enabled: true,
        selected: true,
        contextLimit: 200_000,
      },
    ]);
    expect(calls[0]).toEqual({ method: "listModels", args: {} });
  });

  it("选模型时把成功与否如实回给桥", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/models/select", {
        session_id: "s-1",
        provider_id: "minimax",
        model_id: "m-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    expect(calls[0]).toEqual({
      method: "selectModel",
      args: { providerId: "minimax", modelId: "m-1", sessionId: "s-1" },
    });
  });

  it("选模型缺参数时回 400，不伪造成功", async () => {
    const { invoke } = harness();

    const response = await invoke(request("POST", "/models/select", { model_id: "m-1" }));

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.key).toBe("INVALID_ARGUMENT");
  });

  it("续流时同样回 SSE", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/session/s-1/resume", { after_msg_id: "m-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: [RESUMED]\n\n");
    expect(calls[0]).toEqual({
      method: "resumeSession",
      args: { id: "s-1", afterMsgId: "m-1" },
    });
  });

  it("停止时把运行时的结果如实回给桥", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/session/s-1/abort", { turn_id: "turn-1", reason: "user_stop" }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    // `reason: "user_stop"` 让运行时暂停目标与队列：丢掉它，手机的停止按钮就与桌面端不同。
    expect(calls[0]).toEqual({
      method: "abortSession",
      args: { id: "s-1", turnId: "turn-1", reason: "user_stop" },
    });
  });

  it("发消息时把手机选定的模型带进运行时", async () => {
    const { invoke, calls } = harness();

    await invoke(
      request("POST", "/session/s-1/message", {
        content: "继续",
        model: { provider_id: "minimax", model_id: "m-1", context_limit: 200_000 },
      }),
    );

    expect(calls[0]).toEqual({
      method: "sendMessage",
      args: {
        id: "s-1",
        content: "继续",
        model: { providerId: "minimax", modelId: "m-1", contextLimit: 200_000 },
      },
    });
  });

  it("置顶会话通过运行时执行", async () => {
    const { invoke, calls } = harness();
    const response = await invoke(request("POST", "/pin/session", { session_id: "s-1", pinned: true }));
    expect(await json(response)).toEqual({ success: true, items: [{ item_type: 1, id: "s-1" }] });
    expect(calls[0]).toEqual({ method: "pinSession", args: { sessionId: "s-1", pinned: true } });
  });

  it("置顶名册来自运行时", async () => {
    const { invoke } = harness();

    const response = await invoke(request("GET", "/preferences/pinned-items-order"));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ items: [{ item_type: 1, id: "s-1", session: { session_id: "s-1" } }] });
  });

  it("调整置顶顺序时把引用交给运行时", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("PUT", "/preferences/pinned-items-order", { items: [{ item_type: 1, id: "s-1" }] }),
    );

    expect(await json(response)).toEqual({ items: [] });
    expect(calls[0]).toEqual({ method: "putPinnedItemsOrder", args: [{ itemType: 1, id: "s-1" }] });
  });

  it("批量回复权限时用运行时的编号，并分出处理与跳过", async () => {
    const { invoke, calls } = harness({}, { permissionSucceeds: false });

    const response = await invoke(
      request("POST", "/permission/batch-reply", {
        request_ids: ["req-1", "req-2"],
        decision: 0,
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ processed: [], skipped: ["req-1", "req-2"] });
    expect(calls[0]).toEqual({
      method: "replyPermission",
      args: { name: "main", requestId: "req-1", reply: 0 },
    });
  });

  it("批量回复权限时吃得下手机侧的原始形状", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("POST", "/permission/batch-reply", {
        request_ids: ["req-1"],
        decision: "allow-always",
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ processed: ["req-1"], skipped: [] });
    expect(calls[0]).toEqual({
      method: "replyPermission",
      args: { name: "main", requestId: "req-1", reply: 1 },
    });
  });

  it("列项目时给出 daemon 的分组形状，并且每个项目带着自己的会话", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(request("GET", "/projects"));

    expect(response.status).toBe(200);
    const body = await json(response);
    const groups = body.projects as {
      project: Record<string, unknown>;
      sessions: { session: Record<string, unknown> }[];
    }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.project).toMatchObject({
      key: "workspace:/workspace/demo",
      workspace_dir: "/workspace/demo",
      display_name: "demo",
      latest_activity_at: 1_700_000_000_000,
    });
    // 手机侧的「最近」就是从这些 sessions 渲染的：少了它们，手机既看不到最近
    // 的会话，也找不到自己刚建的那个。
    expect(groups[0]?.sessions[0]?.session).toMatchObject({
      session_id: "s-1",
      title: "跑一次回归",
    });
    expect(calls[0]).toEqual({
      method: "listProjectGroups",
      args: {
        agentName: "main",
        sessionFilter: {
          archived: false,
          includeHidden: true,
          excludeInternalTreeSessions: true,
        },
        includeHiddenProjects: false,
      },
    });
  });

  it("列项目时把手机带来的分页与过滤参数带给运行时", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request(
        "GET",
        "/projects?limit=20&session_limit=3&cursor=abc&include_hidden=true&exclude_purpose_prefix=task%3A",
      ),
    );

    expect(response.status).toBe(200);
    const call = calls[0] as { method: string; args: Record<string, unknown> };
    expect(call.method).toBe("listProjectGroups");
    expect(call.args).toMatchObject({
      limit: 20,
      sessionLimit: 3,
      cursor: "abc",
      includeHiddenProjects: true,
    });
    expect(call.args.sessionFilter).toMatchObject({
      includeHidden: true,
      excludePurposePrefix: "task:",
    });
  });

  it("列工作区分支时把运行时自己的分支表回给桥", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      request("GET", "/file/git/branches?workspace=%2Fworkspace%2Fdemo"),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      success: true,
      current: "main",
      branches: ["main", "feature/x"],
    });
    expect(calls[0]).toEqual({
      method: "getWorkspaceGitBranches",
      args: { workspaceDir: "/workspace/demo", includeRemote: false },
    });
  });

  it("列工作区分支选择器时把 worktree 一起回给桥", async () => {
    const { invoke, calls } = harness();

    // 手机走的是 Desktop 的旧版 Mavis 前缀，两种前缀要落到同一条路由上。
    const response = await invoke(
      new Request(
        "http://localhost/mavis/api/file/git/branch-picker?workspace=%2Fworkspace%2Fdemo",
      ),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      success: true,
      worktrees: [{ branch: "main", isMain: true }],
    });
    expect(calls[0]).toEqual({
      method: "getWorkspaceGitBranchPicker",
      args: "/workspace/demo",
    });
  });

  it("缺工作目录时如实回 400，不伪造分支表", async () => {
    const { invoke } = harness();

    const response = await invoke(request("GET", "/file/git/branches"));

    expect(response.status).toBe(400);
    expect((await json(response)).key).toBe("INVALID_ARGUMENT");
  });

  it("运行时列不出项目时如实报错", async () => {
    const { invoke } = harness({ listProjectGroups: undefined });

    const response = await invoke(request("GET", "/projects"));

    expect(response.status).toBe(501);
    expect((await json(response)).key).toBe("NOT_IMPLEMENTED");
  });

  it("读、改、删会话都落到运行时上", async () => {
    const { invoke, calls } = harness();

    const get = await invoke(request("GET", "/session/s-1"));
    expect(get.status).toBe(200);
    expect((await json(get)).session).toMatchObject({ session_id: "s-1" });

    const patch = await invoke(request("PATCH", "/session/s-1", { title: "新标题" }));
    expect(patch.status).toBe(200);
    expect((await json(patch)).session).toMatchObject({ title: "新标题" });

    const remove = await invoke(request("DELETE", "/session/s-1"));
    expect(remove.status).toBe(200);
    expect(await json(remove)).toEqual({ success: true });

    expect(calls.map((call) => call.method)).toEqual([
      "getSession",
      "updateSession",
      "deleteSession",
    ]);
  });

  it("列技能时把运行时的清单原样回给桥", async () => {
    const { invoke } = harness();

    const response = await invoke(request("GET", "/skills?keyword=rev"));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.skills).toEqual([{ name: "review", displayName: "Review" }]);
  });

  it("配置路由给出本运行时的权限模式与可选值", async () => {
    const { invoke } = harness();

    const config = await invoke(request("GET", "/config"));
    expect(config.status).toBe(200);
    expect(await json(config)).toEqual({ permissionMode: "auto", beta: { filePanelBrowser: false, browserUseTooling: false } });

    const options = await invoke(request("GET", "/config/permission-mode-options"));
    expect(options.status).toBe(200);
    const body = await json(options);
    expect(body.options).toEqual([
      expect.objectContaining({ value: "default", label_i18n: expect.any(String), description_i18n: expect.any(String) }),
      expect.objectContaining({ value: "auto", label_i18n: expect.any(String), description_i18n: expect.any(String) }),
      expect.objectContaining({ value: "bypassPermissions", label_i18n: expect.any(String), description_i18n: expect.any(String) }),
    ]);
  });

  it("分支切换转发给运行时并保留失败结果", async () => {
    const calls: unknown[] = [];
    const { invoke } = harness({ checkoutWorkspaceGitBranch: async (workspace: string, branch: string) => {
      calls.push({ workspace, branch });
      return { success: false, error: "branch is checked out elsewhere" };
    } });
    expect(await json(await invoke(request("POST", "/file/git/checkout", { workspace: "/repo", branch: "feature" })))).toEqual({ success: false, error: "branch is checked out elsewhere" });
    expect(calls).toEqual([{ workspace: "/repo", branch: "feature" }]);
    expect((await invoke(request("POST", "/file/git/checkout", { workspace: "/repo" }))).status).toBe(400);
  });

  it("项目会话分页透传项目、过滤条件和游标", async () => {
    const calls: unknown[] = [];
    const { invoke } = harness({ listProjectSessions: async (reference: unknown, input: unknown) => {
      calls.push({ reference, input });
      return { sessions: [{ session: { sessionId: "s-1" }, childSessions: [] }], hasMore: true, nextCursor: "next" };
    } });
    const response = await invoke(request("GET", "/project/sessions?project_key=default&agent_name=mavis&limit=3&cursor=prior"));
    expect(await json(response)).toEqual({ sessions: [{ session: { session_id: "s-1" }, child_sessions: [] }], has_more: true, next_cursor: "next" });
    expect(calls).toEqual([{ reference: { projectKey: "default" }, input: { agentName: "mavis", filter: { archived: false, includeHidden: true, excludeInternalTreeSessions: true }, limit: 3, cursor: "prior" } }]);
  });

  it("手机浏览器开关读写同一个隔离浏览器授权", async () => {
    let isolatedChromium = false;
    const authorization = () => ({ isolatedChromium, edge: false, chrome: false, fullCdp: false });
    const { invoke } = harness({}, { browserPort: {
      getAuthorization: async () => authorization(),
      setAuthorization: async (patch) => { isolatedChromium = patch.isolatedChromium ?? isolatedChromium; return authorization(); },
    } });
    expect(await json(await invoke(request("GET", "/config")))).toMatchObject({ beta: { filePanelBrowser: true, browserUseTooling: false } });
    expect(await json(await invoke(request("PUT", "/config", { field: "beta.browserUseTooling", set: true })))).toMatchObject({ beta: { filePanelBrowser: true, browserUseTooling: true } });
    expect((await invoke(request("PUT", "/config", { field: "beta.other", set: true }))).status).toBe(501);
  });

  it("旧版 Mavis 前缀落到同一套路由上", async () => {
    const { invoke, calls } = harness();

    const response = await invoke(
      new Request("http://localhost/mavis/api/session/s-1/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "继续" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({
      method: "sendMessage",
      args: { id: "s-1", content: "继续" },
    });
  });

  it("文件树和搜索调用运行时并返回 Desktop 与旧接口各自的格式", async () => {
    const { invoke } = harness({
      listWorkspaceFileTree: async () => [{ name: "a.txt", path: "a.txt", type: "file" }],
      searchWorkspaceFiles: async () => ["a.txt"],
    });
    const tree = await invoke(request("GET", "/file/tree?workspace=%2Fwork"));
    expect(await tree.json()).toEqual({ entries: [{ name: "a.txt", path: "a.txt", type: "file" }] });
    const legacy = await invoke(new Request("http://localhost/mavis/api/file/search?workspace=%2Fwork&query=a"));
    expect(await legacy.json()).toEqual(["a.txt"]);
    const unsupported = await invoke(request("GET", "/file/tree?workspace=%2Fwork&cursor=next"));
    expect(unsupported.status).toBe(501);
  });

  it("未知路径回 404 如实错误，并把方法与路径打进日志", async () => {
    const { invoke, logs } = harness();

    const response = await invoke(request("GET", "/config/unknown-thing"));

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body.key).toBe("NOT_FOUND");
    expect(body.message).toContain("/config/unknown-thing");
    expect(
      logs.some((line) =>
        line.includes(
          "[rc.invoke] method=GET path=/minimax-desktop/api/v1/config/unknown-thing status=404",
        ),
      ),
    ).toBe(true);
  });

  it("不是本运行时 API 的路径也回 404，不当成成功", async () => {
    const { invoke } = harness();

    const response = await invoke(new Request("http://localhost/other/thing"));

    expect(response.status).toBe(404);
    expect((await json(response)).key).toBe("NOT_FOUND");
  });
});
