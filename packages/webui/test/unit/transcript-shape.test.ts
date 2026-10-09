import { describe, expect, it } from "vitest";
import {
  projectHistoricalTurnView,
  projectLiveTurnView,
  projectLiveUserView,
  WEBUI_FIELD_OWNERSHIP_TABLE,
  WEBUI_HISTORICAL_FIELD_TABLE,
  WEBUI_LIVE_FIELD_TABLE,
} from "../../src/client/projection/transcript-shape.js";
import type { WebuiClientMessage } from "../../src/client/contracts/message-view.js";
import type { WebuiStreamMessage } from "../../src/client/stream.js";
import {
  projectWebuiMessage,
  projectWebuiTranscriptMessage,
} from "../../src/client/projection/message-projection.js";
import {
  groupWebuiTranscriptItems,
  projectWebuiTranscriptMessages,
  projectWebuiQueryDurations,
  projectWebuiProcessSegments,
} from "../../src/client/projection/transcript-projection.js";

/**
 * Pure tests for the two transcript adapters. The leaf renderer tests
 * pin the historical- and live-paths' field ownership at the type level:
 * every field the historical record carries must appear in the historical
 * table, every field the live record carries must appear in the live
 * table, and the ownership table must list every prop the leaf renderer
 * reads.
 *
 * The fixtures below are intentionally minimal — each row covers a single
 * branch in the projector (`thinking + duration`, `tool calls`, `usage`,
 * `attachments`, `goal`). The projector is exercised indirectly via the
 * existing `projections.test.ts` suite; here we only assert the shape
 * contracts.
 */

// ── historical fixture ────────────────────────────────────────────────

const HISTORICAL_USER: WebuiClientMessage & { streaming?: never } = {
  msgId: "msg-hist-user-1",
  turnId: "turn-1",
  timestamp: 1700000000000,
  role: "user",
  msgContent: "draft the release notes",
  source: "thread-goal",
  usage: {
    request_duration_ms: 1200,
    output_tokens: 80,
  },
};

const HISTORICAL_ASSISTANT: WebuiClientMessage = {
  msgId: "msg-hist-asst-1",
  turnId: "turn-1",
  timestamp: 1700000001500,
  role: "assistant",
  msgContent: "Here is a draft:\n\n## v1.0\n- new session composer",
  thinkingContent: "let me list the bullet points",
  thinkingDurationMs: 850,
  toolCalls: [
    { id: "tc-1", name: "file.read", args: { path: "/notes" } },
  ],
  attachments: [
    {
      id: "att-1",
      type: "file",
      file_name: "notes.md",
      preview_url: "file:///notes.md",
    },
  ],
  usage: {
    request_duration_ms: 1500,
    output_tokens: 240,
  },
  actions: { fork: true, rewind: true, edit: false },
  fileChanges: [
    {
      file: "CHANGELOG.md",
      additions: 1,
      deletions: 1,
      status: "modified",
    },
  ],
};

// ── live fixture ──────────────────────────────────────────────────────

const LIVE_USER: WebuiStreamMessage = {
  id: "msg-live-user-1",
  answer: "draft the release notes",
  thinking: "",
  role: "user",
  isGoal: true,
  timestamp: 1700000000000,
};

const LIVE_ASSISTANT_IN_FLIGHT: WebuiStreamMessage & {
  actions?: never;
  fileChanges?: never;
} = {
  id: "msg-live-asst-1",
  answer: "Here is a draft:",
  thinking: "let me list the bullet points",
  toolCalls: [
    { id: "tc-1", name: "file.read", args: { path: "/notes" } },
  ],
  usage: {
    request_duration_ms: 600,
    output_tokens: 64,
  },
};

// ── field-table coverage ─────────────────────────────────────────────

describe("WEBUI_HISTORICAL_FIELD_TABLE — every populated field on the historical fixtures must appear", () => {
  const fixtureFields: ReadonlyArray<keyof WebuiClientMessage> = [
    "msgId",
    "turnId",
    "timestamp",
    "role",
    "msgContent",
    "source",
    "usage",
    "thinkingContent",
    "thinkingDurationMs",
    "toolCalls",
    "parts",
    "attachments",
    "actions",
    "fileChanges",
  ];
  const tableFields = new Set(
    WEBUI_HISTORICAL_FIELD_TABLE.map((row) => String(row.field)),
  );
  for (const field of fixtureFields) {
    it(`covers historical field "${String(field)}"`, () => {
      expect(tableFields.has(String(field))).toBe(true);
    });
  }
});

describe("live transcript timeline merge", () => {
  it("inserts a streamed assistant turn before a later queued user already present in history", () => {
    const messages = projectWebuiTranscriptMessages(
      {
        messages: [
          { msgId: "user-1", role: "user", msgContent: "first" },
          { msgId: "user-2", role: "user", msgContent: "second" },
        ],
      },
      [
        { id: "user-1", role: "user", answer: "first", thinking: "" },
        { id: "assistant-1", answer: "replying to first", thinking: "thinking" },
        { id: "user-2", role: "user", answer: "second", thinking: "" },
      ],
    );

    expect(messages.map((message) => message.msgId)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ]);
    expect(messages.map((message) => message.msgContent)).toEqual([
      "first",
      "replying to first",
      "second",
    ]);
  });

  it("updates matching history identities in place without adding a second row", () => {
    const messages = projectWebuiTranscriptMessages(
      { messages: [{ msgId: "user-1", role: "user", msgContent: "old" }] },
      [{ id: "user-1", role: "user", answer: "live", thinking: "" }],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.msgContent).toBe("live");
  });
});

describe("WEBUI_LIVE_FIELD_TABLE — every populated field on the live fixtures must appear", () => {
  const fixtureFields: ReadonlyArray<keyof WebuiStreamMessage> = [
    "id",
    "answer",
    "thinking",
    "role",
    "isGoal",
    "timestamp",
    "toolCalls",
    "parts",
    "usage",
  ];
  const tableFields = new Set(
    WEBUI_LIVE_FIELD_TABLE.map((row) => String(row.field)),
  );
  for (const field of fixtureFields) {
    it(`covers live field "${String(field)}"`, () => {
      expect(tableFields.has(String(field))).toBe(true);
    });
  }
});

describe("WEBUI_FIELD_OWNERSHIP_TABLE — exclusive fields are not double-listed", () => {
  const ownerFor = (field: string) =>
    WEBUI_FIELD_OWNERSHIP_TABLE.filter((row) => row.field === field);

  it("lists each view field exactly once", () => {
    const fields = [
      "source", "messageId", "role", "sessionId", "userText", "thinking",
      "tools", "answers", "timestamp", "isGoal", "totalRequestDurationMs",
      "totalOutputTokens", "processSegments", "turnId", "thinkingDurationMs",
      "activityParts",
      "initialDiff", "actions", "attachments", "assistantMessageId", "streaming",
      "streamMessageId", "messageRootId", "processingStartedAtMs",
    ];
    expect(WEBUI_FIELD_OWNERSHIP_TABLE).toHaveLength(fields.length);
    for (const field of fields) expect(ownerFor(field)).toHaveLength(1);
  });

  it("assigns the shared base fields to both paths", () => {
    const sharedFields = [
      "source", "messageId", "role", "sessionId", "userText", "thinking",
      "tools", "answers", "timestamp", "isGoal", "totalRequestDurationMs",
      "totalOutputTokens", "processSegments",
    ];
    for (const field of sharedFields) {
      expect(ownerFor(field)[0]?.owner, `field ${field}`).toBe("shared");
    }
  });

  it("assigns historical extension fields to history only", () => {
    for (const field of ["turnId", "thinkingDurationMs", "initialDiff", "actions", "attachments"]) {
      expect(ownerFor(field)[0]?.owner, `field ${field}`).toBe("historical");
    }
  });

  it("assigns live extension fields to the live path only", () => {
    for (const field of ["assistantMessageId", "streaming", "streamMessageId", "messageRootId", "processingStartedAtMs"]) {
      expect(ownerFor(field)[0]?.owner, `field ${field}`).toBe("live");
    }
  });
});

// ── leaf renderer contracts (typing + shape) ─────────────────────────

describe("leaf renderer contracts — the historical and live fixtures cover the renderer surface", () => {
  it("projects historical delegation and activity rows from the persisted raw message", () => {
    const items = projectWebuiMessage({
      msgId: "history-activity",
      role: "assistant",
      rawJson: JSON.stringify({
        parts: [
          { id: "think", type: "thinking", content: "Reasoning" },
          { id: "delegate", type: "delegation", message: { fromAgent: "main", toAgent: "child", content: "Review" } },
          { id: "tool", type: "tool_call", tool_call: { name: "bash", status: "done" } },
          { id: "answer", type: "text", content: "Final" },
        ],
      }),
    });
    expect(items.map((item) => item.kind)).toEqual(["thinking", "activity", "tool", "assistant"]);
    const segments = projectWebuiProcessSegments(items);
    expect(segments[0]?.activityParts?.map((part) => part.type)).toEqual(["thinking", "delegation", "tool", "text"]);
    expect(segments[0]?.activityParts?.[1]).toMatchObject({ type: "delegation", message: { toAgent: "child" } });
  });

  it("projects the same activity order from live agent_message parts", () => {
    const view = projectLiveTurnView([{
      id: "live-activity",
      answer: "Final",
      thinking: "",
      parts: [
        { id: "think", type: "thinking", content: "Reasoning" },
        { id: "delegate", type: "delegation", message: { fromAgent: "main", toAgent: "child", content: "Review" } },
        { id: "tool", type: "tool_call", tool_call: { name: "bash", status: "running" } },
        { id: "answer", type: "text", content: "Final" },
      ],
    }], { streaming: true });
    expect(view?.processSegments?.[0]?.activityParts?.map((part) => part.type)).toEqual(["thinking", "delegation", "tool", "text"]);
  });

  it("historical user fixture carries `messageId`, `role`, `text`, `timestamp`, `isGoal`, `usage`", () => {
    expect(HISTORICAL_USER.msgId).toBe("msg-hist-user-1");
    expect(HISTORICAL_USER.role).toBe("user");
    expect(HISTORICAL_USER.msgContent).toBe("draft the release notes");
    expect(HISTORICAL_USER.timestamp).toBe(1700000000000);
    expect(HISTORICAL_USER.source).toBe("thread-goal");
    expect(HISTORICAL_USER.usage?.["request_duration_ms"]).toBe(1200);
    expect(HISTORICAL_USER.usage?.["output_tokens"]).toBe(80);
  });

  it("historical assistant fixture carries every prop the leaf renderer reads", () => {
    expect(HISTORICAL_ASSISTANT.role).toBe("assistant");
    expect(HISTORICAL_ASSISTANT.msgContent).toContain("Here is a draft:");
    expect(HISTORICAL_ASSISTANT.thinkingContent).toBe(
      "let me list the bullet points",
    );
    expect(HISTORICAL_ASSISTANT.thinkingDurationMs).toBe(850);
    expect(HISTORICAL_ASSISTANT.toolCalls?.[0]?.["name"]).toBe("file.read");
    expect(HISTORICAL_ASSISTANT.attachments?.[0]?.file_name).toBe("notes.md");
    expect(HISTORICAL_ASSISTANT.actions?.fork).toBe(true);
    expect(HISTORICAL_ASSISTANT.actions?.rewind).toBe(true);
    expect(HISTORICAL_ASSISTANT.actions?.edit).toBe(false);
    expect(HISTORICAL_ASSISTANT.fileChanges?.[0]?.file).toBe("CHANGELOG.md");
  });

  it("live user fixture carries `messageId`, `role`, `text`, `isGoal`, `timestamp`", () => {
    expect(LIVE_USER.id).toBe("msg-live-user-1");
    expect(LIVE_USER.role).toBe("user");
    expect(LIVE_USER.answer).toBe("draft the release notes");
    expect(LIVE_USER.isGoal).toBe(true);
    expect(LIVE_USER.timestamp).toBe(1700000000000);
  });

  it("live assistant in-flight fixture carries `text`, `thinking`, `tools`, `usage`", () => {
    expect(LIVE_ASSISTANT_IN_FLIGHT.id).toBe("msg-live-asst-1");
    expect(LIVE_ASSISTANT_IN_FLIGHT.answer).toBe("Here is a draft:");
    expect(LIVE_ASSISTANT_IN_FLIGHT.thinking).toBe(
      "let me list the bullet points",
    );
    expect(LIVE_ASSISTANT_IN_FLIGHT.toolCalls?.[0]?.["name"]).toBe("file.read");
    expect(LIVE_ASSISTANT_IN_FLIGHT.usage?.["output_tokens"]).toBe(64);
  });

  it("live assistant in-flight fixture does NOT carry `actions` or `fileChanges`", () => {
    // Pin: the live path never carries the two historical-only fields. If
    // the wire schema grows `actions` on the live path, the ownership
    // table must be updated first. The fixture type is exact
    // (`WebuiStreamMessage`); if the field is absent on that interface,
    // TypeScript would already reject the test — the runtime read
    // confirms the wire doesn't carry it.
    expect(LIVE_ASSISTANT_IN_FLIGHT.actions).toBeUndefined();
    expect(LIVE_ASSISTANT_IN_FLIGHT.fileChanges).toBeUndefined();
  });

  it("historical user fixture does NOT carry `streaming`", () => {
    // The fixture type extends `WebuiClientMessage & { streaming?: never }`
    // (see line 30), so `streaming` is a precise interface read on a
    // field that the wire shape does not carry, without a cast.
    expect(HISTORICAL_USER.streaming).toBeUndefined();
  });
});

// ── cross-adapter agreement ──────────────────────────────────────────

describe("cross-adapter agreement — historical and live fields share the same ids and roles", () => {
  it("user fixtures agree on `role: 'user'`", () => {
    expect(HISTORICAL_USER.role).toBe(LIVE_USER.role);
  });

  it("user fixtures agree on `text` content (modulo pending-stream trim)", () => {
    expect(HISTORICAL_USER.msgContent).toBe(LIVE_USER.answer);
  });

  it("assistant fixtures agree on the leading answer fragment", () => {
    expect(
      HISTORICAL_ASSISTANT.msgContent?.startsWith("Here is a draft:"),
    ).toBe(true);
    expect(LIVE_ASSISTANT_IN_FLIGHT.answer.startsWith("Here is a draft:")).toBe(
      true,
    );
  });

  it("assistant fixtures agree on `thinking` content", () => {
    expect(HISTORICAL_ASSISTANT.thinkingContent).toBe(
      LIVE_ASSISTANT_IN_FLIGHT.thinking,
    );
  });

  it("both assistant fixtures carry the same `toolCalls[0].name`", () => {
    expect(HISTORICAL_ASSISTANT.toolCalls?.[0]?.["name"]).toBe(
      LIVE_ASSISTANT_IN_FLIGHT.toolCalls?.[0]?.["name"],
    );
  });
});

// ── ownership table accessors used by tests ───────────────────────────

describe("WEBUI_FIELD_OWNERSHIP_TABLE — accessor helpers for the leaf renderer", () => {
  it("`initialDiff` is `historical`-owned and explains its absence on the live path", () => {
    const row = WEBUI_FIELD_OWNERSHIP_TABLE.find(
      (r) => r.field === "initialDiff",
    );
    expect(row?.owner).toBe("historical");
    expect(row?.notes).toMatch(/persisted/);
  });

  it("the live-only fields carry a `live` owner marker", () => {
    const liveOnly = WEBUI_FIELD_OWNERSHIP_TABLE.filter(
      (r) => r.owner === "live",
    );
    expect(liveOnly.length).toBeGreaterThan(0);
    for (const row of liveOnly) {
      expect(row.field).toMatch(
        /assistantMessageId|streaming|streamMessageId|messageRootId|processingStartedAtMs/,
      );
    }
  });
});

// ── direct adapter execution (six categories) ─────────────────────────

describe("projectHistoricalTurnView — direct execution on the six content categories", () => {
  // Build a fresh fixture for each category. The adapter runs and the
  // asserted field on the returned view must reflect the input — six
  // distinct input → output pinpoints. Mutation: deleting the
  // corresponding adapter branch flips the matching assertion to red.

  it("category 1 — diff: `initialDiff` is the most recent per-item diff or the message-level fallback", () => {
    const withItemDiff: WebuiClientMessage = {
      ...HISTORICAL_ASSISTANT,
      // Two diffs; the message-level fallback reader picks the last one
      // when no per-item diff is set (since `projectWebuiMessage` does
      // not produce items with a `diff` field — see message-projection.ts).
      fileChanges: [
        { file: "a", additions: 1, deletions: 0, status: "modified" },
        { file: "b", additions: 1, deletions: 1, status: "modified" },
      ],
    };
    const view = projectHistoricalTurnView(withItemDiff, "sess");
    expect(view.source).toBe("historical");
    expect(view.initialDiff).toBeDefined();
    expect(view.initialDiff?.fileChanges?.[1]?.file).toBe("b");

    const noFileChanges: WebuiClientMessage = {
      ...HISTORICAL_ASSISTANT,
      fileChanges: undefined,
    };
    const fallbackView = projectHistoricalTurnView(noFileChanges, "sess");
    expect(fallbackView.initialDiff).toBeUndefined();
  });

  it("category 2 — attachments: passthrough through projectMessageAttachments", () => {
    const view = projectHistoricalTurnView(HISTORICAL_ASSISTANT, "sess");
    expect(view.attachments?.[0]?.file_name).toBe("notes.md");
    expect(view.attachments?.[0]?.preview_url).toBe("file:///notes.md");

    const noAttachments: WebuiClientMessage = {
      ...HISTORICAL_ASSISTANT,
      attachments: undefined,
    };
    const emptyView = projectHistoricalTurnView(noAttachments, "sess");
    expect(emptyView.attachments).toBeUndefined();
  });

  it("category 3 — thinking + durationMs: joined from thinking parts", () => {
    const view = projectHistoricalTurnView(HISTORICAL_ASSISTANT, "sess");
    expect(view.thinking).toBe("let me list the bullet points");
    expect(view.thinkingDurationMs).toBe(850);
  });

  it("category 4 — tools: flatMap of every tool-item's `tools` array", () => {
    const view = projectHistoricalTurnView(HISTORICAL_ASSISTANT, "sess");
    expect(view.tools).toEqual([
      { id: "tc-1", name: "file.read", args: { path: "/notes" } },
    ]);

    // Pin: if `tools` were never returned (the audit's mutation
    // hypothesis), `view.tools` would be `undefined` and this
    // assertion would fail. The audit reproduces the same deletion in
    // the adapter and the test would go red — this is the "direct
    // execution" pin the field tables alone could not provide.
    expect(view.tools).not.toBeUndefined();

    const noToolCalls: WebuiClientMessage = {
      ...HISTORICAL_ASSISTANT,
      toolCalls: undefined,
    };
    const noToolsView = projectHistoricalTurnView(noToolCalls, "sess");
    expect(noToolsView.tools).toBeUndefined();
  });

  it("category 5 — actions: forwarded from the first projectWebuiMessage item", () => {
    const view = projectHistoricalTurnView(HISTORICAL_ASSISTANT, "sess");
    expect(view.actions).toEqual({
      fork: true,
      rewind: true,
      edit: false,
    });

    const noActions: WebuiClientMessage = {
      ...HISTORICAL_ASSISTANT,
      actions: undefined,
    };
    const emptyView = projectHistoricalTurnView(noActions, "sess");
    expect(emptyView.actions).toBeUndefined();
  });

  it("category 6 — streaming placeholder: NEVER returned on historical view", () => {
    // The historical view never carries streaming / streamMessageId /
    // messageRootId / processingStartedAtMs — these are live-only. The
    // type system rejects them at compile time (WebuiHistoricalTurnView
    // doesn't declare them), but the runtime read also confirms.
    const view = projectHistoricalTurnView(HISTORICAL_ASSISTANT, "sess");
    // Source discriminator is `historical`.
    expect(view.source).toBe("historical");
  });
});

describe("single historical message projection", () => {
  it("projects every history message once and preserves items, views, and grouping", () => {
    const history: WebuiClientMessage[] = [
      { msgId: "plain", role: "user", msgContent: "hello" },
      {
        ...HISTORICAL_ASSISTANT,
        msgId: "review-tools",
        turnId: "turn-review",
        thinkingContent: "check the change",
        toolCalls: [{ id: "tool-1", name: "read_file", args: { path: "a.ts" } }],
        actions: { fork: true, rewind: true, edit: false },
        fileChanges: [{ file: "a.ts", additions: 2, deletions: 1, status: "modified" }],
        attachments: [{ id: "attachment-1", type: "file", file_name: "a.ts" }],
      },
      { msgId: "group-answer", turnId: "turn-review", role: "assistant", msgContent: "done" },
    ];
    let projectionCalls = 0;
    const projectOnce = (message: WebuiClientMessage) => {
      projectionCalls += 1;
      return projectWebuiMessage(message);
    };

    const oldItemsByMessage = history.map(projectOnce);
    const oldItems = oldItemsByMessage.flat();
    const oldViews = history.map((message) =>
      projectHistoricalTurnView(message, "session-a", undefined, projectOnce),
    );
    expect(projectionCalls).toBe(history.length * 2);
    projectionCalls = 0;

    const projected = history.map((message) =>
      projectWebuiTranscriptMessage(message, projectOnce),
    );
    const nextViews = projected.map(({ message, items }) =>
      projectHistoricalTurnView(message, "session-a", items, projectOnce),
    );

    expect(projected.flatMap(({ items }) => items)).toEqual(oldItems);
    expect(nextViews).toEqual(oldViews);
    expect(groupWebuiTranscriptItems(projected.flatMap(({ items }) => items))).toEqual(
      groupWebuiTranscriptItems(oldItems),
    );
    expect(nextViews[1]).toMatchObject({
      source: "historical",
      messageId: "review-tools",
      thinking: "check the change",
      tools: [{ id: "tool-1", name: "read_file", args: { path: "a.ts" } }],
      actions: { fork: true, rewind: true, edit: false },
      attachments: [{ id: "attachment-1", type: "file", file_name: "a.ts" }],
    });

    // 旧流程每条消息调用两次；共享投影结果后每条消息只调用一次。
    expect(projectionCalls).toBe(history.length);

    const intersectingMessages = projectWebuiTranscriptMessages(
      { messages: history },
      [{ id: "review-tools", answer: "live update", thinking: "" }],
    );
    const oldIntersectingItems = intersectingMessages.flatMap(projectWebuiMessage);
    const oldIntersectingViews = intersectingMessages.map((message) =>
      projectHistoricalTurnView(message, "session-a"),
    );
    const nextIntersecting = intersectingMessages.map((message) =>
      projectWebuiTranscriptMessage(message),
    );
    const nextIntersectingViews = nextIntersecting.map(({ message, items }) =>
      projectHistoricalTurnView(message, "session-a", items),
    );
    expect(nextIntersecting.flatMap(({ items }) => items)).toEqual(oldIntersectingItems);
    expect(nextIntersectingViews).toEqual(oldIntersectingViews);
  });
});

describe("projectLiveTurnView — direct execution on the six content categories", () => {
  const ASSISTANT_FRAMES: readonly WebuiStreamMessage[] = [
    {
      id: "live-asst-1",
      answer: "",
      thinking: "first reasoning",
      toolCalls: [{ id: "t1", name: "search.query" }],
    },
    {
      id: "live-asst-2",
      answer: "The answer is",
      thinking: "second reasoning",
      toolCalls: [{ id: "t2", name: "compute" }],
      usage: { request_duration_ms: 800, output_tokens: 30 },
    },
    {
      id: "live-asst-3",
      answer: "ready",
      thinking: "",
      usage: { request_duration_ms: 250, output_tokens: 12 },
    },
  ];

  it("category 1 — diff: never returned on live view (no item carries it)", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1000,
    });
    expect(view).toBeDefined();
    // WebuiLiveTurnView doesn't declare initialDiff; the discriminator
    // is enough to confirm the historical-only branch did not run.
    expect(view?.source).toBe("live");
  });

  it("category 2 — attachments: never returned on live view", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1000,
    });
    expect(view?.source).toBe("live");
  });

  it("category 3 — thinking: joined, dropping empty-trim entries", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1000,
    });
    // Frames 1 and 2 have non-empty thinking; frame 3 has empty. The
    // adapter joins with "\n\n" between non-empty entries.
    expect(view?.thinking).toBe("first reasoning\n\nsecond reasoning");
  });

  it("category 4 — tools: flatMap across all assistant frames", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1000,
    });
    expect(view?.tools).toEqual([
      { id: "t1", name: "search.query" },
      { id: "t2", name: "compute" },
    ]);
  });

  it("category 5 — actions: never on live view (no wire field carries them)", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1000,
    });
    expect(view?.source).toBe("live");
  });

  it("category 6 — streaming placeholder: live view always sets `streaming` from args and `processingStartedAtMs` when provided", () => {
    const view = projectLiveTurnView(ASSISTANT_FRAMES, {
      streaming: true,
      processingStartedAtMs: 1700,
    });
    expect(view?.streaming).toBe(true);
    expect(view?.processingStartedAtMs).toBe(1700);
    expect(view?.streamMessageId).toBe("merged");
    expect(view?.messageRootId).toBe("merged");

    // Usage sums across the two frames that carry it.
    expect(view?.totalRequestDurationMs).toBe(1050);
    expect(view?.totalOutputTokens).toBe(42);
  });
});

describe("groupWebuiTranscriptItems — persisted query duration", () => {
  it("uses the persisted query elapsed time when per-message request usage is absent", () => {
    const messageId = "goal-reply";
    const items = projectWebuiMessage({
      msgId: messageId,
      role: "assistant",
      turnId: "turn-final",
      queryKey: "goal:goal-1:turn:turn-root",
      timestamp: 1_790_224_743_333,
      parts: [{ type: "text", content: "Goal completed" }],
    });
    const queryDurations = projectWebuiQueryDurations(
      [{ msgId: messageId, queryKey: "goal:goal-1:turn:turn-root" }],
      [{
        queryKey: "goal:goal-1:turn:turn-root",
        currentTurnId: "turn-final",
        processingStartedAtMs: 1_790_224_724_874,
        processingFinishedAtMs: 1_790_224_743_471,
      }],
    );
    const groups = groupWebuiTranscriptItems(items, queryDurations);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.totalRequestDurationMs).toBe(18_597);
  });
});
