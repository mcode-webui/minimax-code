// W0 safety net — the session-scoped workspace-progress projection.
//
// `reduceWebuiWorkspaceProgressEvent` and `projectWebuiWorkspaceHistory` turn
// raw Desktop-compatible events into the todos/subagents the workspace panel
// renders. W2 moves them out of `workspace-progress.ts`, and W0 found they had
// no direct test at all — only the rendered panel is asserted, in
// `webui-shell.test.ts`. A move that silently changed the accepted event shape
// or the status mapping would have shown up nowhere.
//
// The fixtures below are written against the *event* shape, and every expected
// value is spelled out here rather than derived from an implementation
// constant, so a change on either side fails the test.

import { describe, it, expect } from "vitest";
import {
  initialWebuiWorkspaceProgress,
  PROGRESS_EVENT_TYPES,
  projectWebuiWorkspaceHistory,
  reduceWebuiWorkspaceProgressEvent,
  webuiWorkspaceSubagentStatus,
  type WebuiWorkspaceProgressState,
} from "../../src/client/projection/workspace-progress.js";
import type { WebuiClientMessage } from "../../src/client/contracts/message-view.js";

function message(value: Record<string, unknown>): WebuiClientMessage {
  return value as unknown as WebuiClientMessage;
}

function withTodoSnapshot(
  content: string,
  status: "pending" | "in_progress" | "completed" | "cancelled",
  priority?: "high" | "medium" | "low",
): WebuiWorkspaceProgressState {
  return reduceWebuiWorkspaceProgressEvent(initialWebuiWorkspaceProgress, {
    type: "todo_updated",
    todos: [{ content, status, ...(priority ? { priority } : {}) }],
  });
}

describe("W0 · workspace progress · subagent status mapping", () => {
  it("maps the numeric and string spellings the runtime sends", () => {
    expect(webuiWorkspaceSubagentStatus(1)).toBe("running");
    expect(webuiWorkspaceSubagentStatus("running")).toBe("running");
    expect(webuiWorkspaceSubagentStatus("started")).toBe("running");

    expect(webuiWorkspaceSubagentStatus(2)).toBe("error");
    expect(webuiWorkspaceSubagentStatus(3)).toBe("error");
    expect(webuiWorkspaceSubagentStatus("failed")).toBe("error");
    expect(webuiWorkspaceSubagentStatus("aborted")).toBe("error");
    expect(webuiWorkspaceSubagentStatus("cancelled")).toBe("error");
  });

  it("treats an unknown or missing status as completed", () => {
    expect(webuiWorkspaceSubagentStatus(undefined)).toBe("completed");
    expect(webuiWorkspaceSubagentStatus("something-else")).toBe("completed");
  });

  it("unwraps the object spellings before mapping", () => {
    expect(webuiWorkspaceSubagentStatus({ statusType: "running" })).toBe(
      "running",
    );
    expect(webuiWorkspaceSubagentStatus({ status: "error" })).toBe("error");
    expect(webuiWorkspaceSubagentStatus({ type: 3 })).toBe("error");
  });
});

describe("W0 · workspace progress · event reducer", () => {
  it("allows only names that actually dispatch", () => {
    // Message content is free-form assistant text, so embedded events are
    // filtered through PROGRESS_EVENT_TYPES — an excess entry would let prose
    // rewrite the panel, an omission would drop a real event. The allowlist is
    // built from the same constants the reducer dispatches on, so this asserts
    // the behaviour rather than the source text: every allowed name must move
    // the state, given the payload shape that branch reads.
    const cases: Record<string, Record<string, unknown>> = {
      todo_updated: { todos: [{ content: "a", status: "pending" }] },
      "session.spawned": { data: { sessionId: "child-1", agentName: "explore" } },
      "session.status_updated": { data: { sessionId: "child-1", status: "failed" } },
      "session.finish": { data: { sessionId: "child-1" } },
      "session.error": { data: { sessionId: "child-1" } },
      "session.abort": { data: { sessionId: "child-1" } },
      "session.aborted": { data: { sessionId: "child-1" } },
      session_status: { data: { sessionId: "child-1", status: "blocked" } },
      "session.status": { data: { sessionId: "child-1", status: "queued" } },
    };

    // Every allowed name must have a case, so a newly added branch cannot slip
    // in unproven.
    expect([...PROGRESS_EVENT_TYPES].sort()).toEqual(Object.keys(cases).sort());

    const empty = initialWebuiWorkspaceProgress;
    // Status events only act on a subagent that already exists, and the
    // terminal ones only register a change from a non-terminal status, so seed
    // a child that is still running.
    const withRunningChild = reduceWebuiWorkspaceProgressEvent(
      reduceWebuiWorkspaceProgressEvent(
        empty,
        { eventType: "session.spawned", data: { sessionId: "child-1", agentName: "explore" } },
        "root",
      ),
      { eventType: "session_status", data: { sessionId: "child-1", status: "running" } },
      "root",
    );
    const needsChild = new Set([
      "session.status_updated",
      "session.finish",
      "session.error",
      "session.abort",
      "session.aborted",
      "session_status",
      "session.status",
    ]);

    for (const [type, payload] of Object.entries(cases)) {
      const seeded = needsChild.has(type) ? withRunningChild : empty;
      const next = reduceWebuiWorkspaceProgressEvent(seeded, { eventType: type, ...payload }, "root");
      expect(next, `${type} dispatched without moving the state`).not.toEqual(seeded);
    }
  });

  it("keeps only the todo entries with a content and a known status", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "todo_updated",
        todos: [
          { content: "写测试", status: "in_progress", priority: "high" },
          { content: "", status: "pending" },
          { content: "状态非法", status: "unknown" },
          { content: "没有优先级", status: "completed" },
        ],
      },
    );

    expect(next.todos).toEqual([
      { content: "写测试", status: "in_progress", priority: "high" },
      { content: "没有优先级", status: "completed" },
    ]);
    expect(next.hasTodoSnapshot).toBe(true);
  });

  it("leaves the state untouched when the todo payload is not an array", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      { type: "todo_updated", todos: "nope" },
    );

    expect(next).toBe(initialWebuiWorkspaceProgress);
  });

  it("registers a spawned child session and falls back to the parent argument", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "session.spawned",
        data: {
          sessionId: "child-1",
          agentName: "explore",
          status: "running",
          createdAt: 5,
        },
      },
      "root-session",
    );

    expect(next.subagents).toEqual([
      {
        sessionId: "child-1",
        agentName: "explore",
        status: "running",
        createdAt: 5,
        parentSessionId: "root-session",
      },
    ]);
    expect(next.hasSubagentSnapshot).toBe(true);
  });

  it("reads the same event through the generic wrapper", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        generic: {
          eventType: "session.spawned",
          data: { sessionId: "child-2", agentName: "worker" },
        },
      },
      "root-session",
    );

    expect(next.subagents).toEqual([
      {
        sessionId: "child-2",
        agentName: "worker",
        status: "completed",
        parentSessionId: "root-session",
      },
    ]);
  });

  it("ignores a spawn event that carries no session identity", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      { type: "session.spawned", data: { agentName: "explore" } },
    );

    expect(next).toBe(initialWebuiWorkspaceProgress);
  });

  it("settles a known child on finish, error and abort", () => {
    const spawned = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "session.spawned",
        data: { sessionId: "child-1", agentName: "explore", status: "running" },
      },
    );

    const finished = reduceWebuiWorkspaceProgressEvent(spawned, {
      type: "session.finish",
      data: { sessionId: "child-1" },
    });
    expect(finished.subagents[0].status).toBe("completed");

    const errored = reduceWebuiWorkspaceProgressEvent(spawned, {
      type: "session.error",
      data: { sessionId: "child-1" },
    });
    expect(errored.subagents[0].status).toBe("error");

    const aborted = reduceWebuiWorkspaceProgressEvent(spawned, {
      type: "session.abort",
      data: { sessionId: "child-1" },
    });
    expect(aborted.subagents[0].status).toBe("error");
  });

  it("ignores a settle event for a child it never registered", () => {
    const spawned = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "session.spawned",
        data: { sessionId: "child-1", agentName: "explore" },
      },
    );

    const next = reduceWebuiWorkspaceProgressEvent(spawned, {
      type: "session.finish",
      data: { sessionId: "child-unknown" },
    });

    expect(next).toBe(spawned);
  });

  it("updates the status of a known child from a status event", () => {
    const spawned = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "session.spawned",
        data: { sessionId: "child-1", agentName: "explore" },
      },
    );

    const next = reduceWebuiWorkspaceProgressEvent(spawned, {
      type: "session.status",
      data: { sessionId: "child-1", status: "running" },
    });

    expect(next.subagents[0].status).toBe("running");
    expect(next.hasSubagentSnapshot).toBe(true);
  });

  it("returns the same state for an event type it does not project", () => {
    const next = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      { type: "something.else", data: { sessionId: "child-1" } },
    );

    expect(next).toBe(initialWebuiWorkspaceProgress);
  });
});

describe("W0 · workspace progress · history projection", () => {
  it("rebuilds todos from a todowrite tool call", () => {
    const state = projectWebuiWorkspaceHistory(
      [
        message({
          toolCalls: [
            {
              name: "todowrite",
              input: { todos: [{ content: "写测试", status: "in_progress" }] },
            },
          ],
        }),
      ],
      "root-session",
    );

    expect(state.todos).toEqual([{ content: "写测试", status: "in_progress" }]);
    expect(state.hasTodoSnapshot).toBe(true);
  });

  it("rebuilds todos from a todowrite call whose arguments are still a JSON string", () => {
    // The shared reader now serves both the history rebuild and the live
    // stream. History used to expect an already-parsed `input`, so a stored
    // call that still carries the wire shape contributed nothing; pin the
    // widened behaviour so it is a decision rather than an accident.
    const state = projectWebuiWorkspaceHistory(
      [
        message({
          toolCalls: [
            {
              function: {
                name: "todowrite",
                arguments: JSON.stringify({
                  todos: [{ content: "字符串入参", status: "pending" }],
                }),
              },
            },
          ],
        }),
      ],
      "root-session",
    );

    expect(state.todos).toEqual([{ content: "字符串入参", status: "pending" }]);
    expect(state.hasTodoSnapshot).toBe(true);
  });

  it("lets an embedded todo_updated win over a todowrite call in the same message", () => {
    // Ordering is load-bearing: the tool call is read first, then the
    // embedded event, so the later event still decides the snapshot.
    const state = projectWebuiWorkspaceHistory(
      [
        message({
          toolCalls: [
            { name: "todowrite", input: { todos: [{ content: "工具调用版本", status: "pending" }] } },
          ],
          msgContent: JSON.stringify({
            eventType: "todo_updated",
            todos: [{ content: "事件版本", status: "completed" }],
          }),
        }),
      ],
      "root-session",
    );

    expect(state.todos).toEqual([{ content: "事件版本", status: "completed" }]);
  });

  it("rebuilds the subagent list from persisted event payloads", () => {
    const state = projectWebuiWorkspaceHistory(
      [
        message({
          msgContent: JSON.stringify({
            type: "session.spawned",
            data: { sessionId: "child-1", agentName: "explore" },
          }),
        }),
      ],
      "root-session",
    );

    expect(state.subagents).toEqual([
      {
        sessionId: "child-1",
        agentName: "explore",
        status: "completed",
        parentSessionId: "root-session",
      },
    ]);
  });

  it("skips messages it cannot read and tool calls it does not project", () => {
    const state = projectWebuiWorkspaceHistory(
      [
        message({ msgContent: "not json at all" }),
        message({ toolCalls: [{ name: "read", input: { file_path: "/tmp" } }] }),
      ],
      "root-session",
    );

    expect(state).toEqual(initialWebuiWorkspaceProgress);
  });

  it("starts from the initial state for an empty history", () => {
    expect(projectWebuiWorkspaceHistory([], "root-session")).toEqual(
      initialWebuiWorkspaceProgress,
    );
  });

  it("carries the snapshot flags a snapshot-built state sets", () => {
    const state = withTodoSnapshot("只剩一项", "pending", "low");

    expect(state.todos).toEqual([
      { content: "只剩一项", status: "pending", priority: "low" },
    ]);
    expect(state.hasTodoSnapshot).toBe(true);
    expect(state.subagents).toEqual([]);
  });
});
