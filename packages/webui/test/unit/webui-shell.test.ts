// Verify the WebUI shell (retailored by the visual-alignment pass).
//
// The shell renders the desktop application's anatomy: a 240px rail on
// `bg_default_scrim`, a main surface on `bg_grouped_secondary`, a window strip
// carrying the rail controls, a fixed "new task" row, the navigation block, the
// project list, the identity row, and on the surface a centred hero with the
// floating composer.
//
// The criterion for a visual change is the rendered result, and a markup
// assertion cannot establish that on its own: a class name in the output says
// nothing about whether the class resolves or what it paints. What this file
// guards is the contract the rest of the code depends on — region markers, state
// hooks, the utility and component classes that must reach the stylesheet, and
// the rule that a reproduced-but-unbacked control is inert. The compiled side of
// that contract (each named component class lands in the output, and every
// `var(--x)` in it closes against a definition) is asserted in
// webui-design-tokens.test.ts against the stylesheet `pnpm build:webui` produces,
// which is also where the desktop's mono stack for `code`/`pre` is checked.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  WebuiContextMenu,
  placeWebuiContextMenu,
} from "../../src/client/components/ContextMenu.js";
import { WebuiInteractionPanel } from "../../src/client/components/InteractionPanel.js";
import {
  WebuiProjectList,
  WebuiSessionList,
  groupWebuiSessionsByWorkspace,
  resolveDefaultExpandedProjectKey,
  sessionHash,
  sortWebuiProjectSessionIds,
} from "../../src/client/components/SessionRail.js";
import { WebuiSessionTranscript } from "../../src/client/components/SessionTranscript.js";
import { WebuiWorkspaceDirectoryBrowser } from "../../src/client/components/SessionComposer.js";
import {
  WebuiIconContextArchive,
  WebuiIconContextCopy,
  WebuiIconContextChevron,
  WebuiIconContextFeedback,
  WebuiIconContextFork,
  WebuiIconContextPin,
  WebuiIconContextRename,
  WebuiIconContextTrash,
  WebuiIconFolder,
} from "../../src/client/icons.js";
import {
  TurnElapsedRow,
  WebuiThinkingBlock,
  WebuiToolResults,
} from "../../src/client/components/TranscriptPrimitives.js";
import {
  WebuiClientFoundationApp,
  readSessionIdFromHash,
  subscribeToSessionHash,
} from "../../src/client/components/WebuiClientFoundationApp.js";
import type { WebuiClientMessageEnqueuer, WebuiClientMessageSender, WebuiClientSessionResumer } from "../../src/client/contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "../../src/client/contracts/message-view.js";
import type { WebuiTranscriptItem } from "../../src/client/contracts/transcript-view.js";
import {
  buildWebuiModelSelectionRequest,
  webuiModelOptionValue,
} from "../../src/client/projection/action-requests.js";
import {
  buildWebuiComposerHandlers,
  createdSessionId,
  looksLikeAbsoluteWorkspacePath,
  submitWebuiGoal,
  submitWebuiComposerTurn,
} from "../../src/client/projection/composer-state.js";
import { projectWebuiMessage } from "../../src/client/projection/message-projection.js";
import { projectLiveTurnView } from "../../src/client/projection/transcript-shape.js";
import { buildWebuiQuestionnaireAnswers } from "../../src/client/projection/questionnaire-state.js";
import { groupWebuiTranscriptItems } from "../../src/client/projection/transcript-projection.js";
import type {
  WebuiGoal,
  WebuiGoalPatchRequest,
} from "../../src/shared/contracts/goal.js";
import type { WebuiQuestionnaireRequest } from "../../src/shared/contracts/interactions.js";
import {
  migrateSessionRuntimeState,
  readSessionRuntimeState,
  updateSessionRuntimeState,
} from "../../src/client/session-runtime-store.js";
import {
  buildWebuiStreamLoopSink,
  runWebuiStreamLoop as runStreamLoop,
  type WebuiStreamLoopArgs,
  type WebuiStreamLoopDeps,
  type WebuiStreamLoopSink,
} from "../../src/client/stream-loop.js";
import { streamRecoveryProjection } from "../../src/client/projection/stream-recovery.js";

/**
 * `runWebuiStreamLoop` now requires the injected history/context bundle so a
 * caller cannot forget it and get a mis-shaped transcript. The shell tests that
 * never traverse a resync/attach path pass no bundle; this fills the real pure
 * transforms in, changing nothing about what is asserted.
 */
const loopWithProjection = (
  deps: Omit<WebuiStreamLoopDeps, "projection"> & {
    readonly projection?: WebuiStreamLoopDeps["projection"];
  },
  args: WebuiStreamLoopArgs,
  sink: WebuiStreamLoopSink,
) =>
  runStreamLoop(
    { ...deps, projection: deps.projection ?? streamRecoveryProjection },
    args,
    sink,
  );
import { createSessionOperation } from "../../src/server/operation/operations.js";
import {
  initialWebuiStreamState,
  ownsWebuiStreamGeneration,
  reduceWebuiStreamFrame,
  settleAbortedStream,
  stopWebuiTurn,
  type WebuiStreamState,
} from "../../src/client/stream.js";
import { projectWebuiTodos, WebuiProgressOverviewPanel, WebuiProgressPanel, WebuiSubagentsPanel, WebuiWorkspacePanel, WebuiWorkspacePanelControls } from "../../src/client/components/WorkspacePanels.js";
import { initialWorkspacePanelState, reduceWorkspacePanelState } from "../../src/client/projection/workspace-panel-state.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";
import type { WebuiWorkspaceEnvironment } from "../../src/shared/contracts/workspace.js";

function renderShell(label = "webui-foundation"): string {
  return renderToStaticMarkup(
    createElement(WebuiClientFoundationApp, { label }),
  );
}

function renderSessionShell(): string {
  return renderToStaticMarkup(
    createElement(WebuiClientFoundationApp, {
      label: "webui-foundation",
      locationHash: "#session=session-1",
      sessionPage: {
        sessions: [
          {
            sessionId: "session-1",
            agentName: "main",
            createdAt: 1,
            updatedAt: 2,
            workspaceDir: "/tmp/project",
          },
        ],
        hasMore: false,
      },
    transport: { loadMessages: async () => ({ messages: [], hasMore: false }) },
    }),
  );
}

/** The rail destinations the desktop ships that the WebUI has no feature for. */
const INERT_NAV_LABELS = ["网站", "远程"];

describe("WebUI shell", () => {
  it("projects desktop workspace state and exposes only the supported add-menu tabs", () => {
    expect(projectWebuiTodos([{ toolCalls: [{ name: "todowrite", input: { todos: [{ content: "完成面板", status: "in_progress" }] } }] }])).toEqual([{ content: "完成面板", status: "in_progress" }]);
    expect(projectWebuiTodos([{ msgContent: JSON.stringify({ eventType: "todo_updated", todos: [{ content: "事件进度", status: "completed", priority: "high" }] }) }])).toEqual([{ content: "事件进度", status: "completed", priority: "high" }]);
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "files" });
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "canvas" });
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "terminal" });
    state = reduceWorkspacePanelState(state, { type: "toggle-add-menu" });
    const markup = renderToStaticMarkup(createElement(WebuiWorkspacePanel, { state, dispatch: () => undefined, workspaceDir: "/tmp" }));
    expect(markup).toContain('data-testid="workspace-panel"');
    expect(markup).toContain("查看文件");
    expect(markup).toContain("画布");
    expect(markup).toContain("终端");
    expect(markup).not.toContain('data-webui-progress-panel="true"');
    expect(markup).not.toContain("浏览器");
    expect(markup).not.toContain("Mini App");
  });

  it("renders Desktop-compatible Subagents and exposes child selection", () => {
    const markup = renderToStaticMarkup(createElement(WebuiSubagentsPanel, {
      subagents: [{ sessionId: "child-1", agentName: "goal-verification", title: "Goal verification", status: "completed" }],
    }));
    expect(markup).toContain("Subagents");
    expect(markup).toContain("Goal verification");
    expect(markup).toContain("webui-subagent-status--completed");
    expect(markup).toContain('data-webui-subagents-panel="true"');
  });

  it("renders the environment/progress content inside the single right panel structure", () => {
    const environment: WebuiWorkspaceEnvironment = { isGitRepo: true, branch: "webui", changedFiles: 2, insertions: 4, deletions: 1, lineStatsStatus: "ready", canPush: true };
    const overview = renderToStaticMarkup(createElement(WebuiProgressOverviewPanel, { workspaceDir: "/tmp/project", workspaceEnvironment: environment, todos: [] }));
    expect(overview).toContain('data-testid="progress-overview-card"');
    expect(overview).toContain("环境信息");
    expect(overview).toContain(">webui<");
    // 158a301 起行数拆成两个着色 span，"+4 -1" 不再是连续文本。
    // 断言功能效果：新增/删除计数对视觉与辅助技术都可见，不绑定 markup 结构。
    const changesBadge = overview.match(/<small[^>]*>[\s\S]*?<\/small>/)?.[0] ?? "";
    const changesText = changesBadge.replace(/<[^>]*>/g, "");
    expect(changesText).toContain(`+${environment.insertions}`);
    expect(changesText).toContain(`-${environment.deletions}`);
    expect(changesBadge).toContain(`aria-label="新增 ${environment.insertions} 行，删除 ${environment.deletions} 行"`);
    expect(overview).toContain("进度");
    expect(overview).toContain("跟踪较长任务的进度");
    expect(overview).not.toContain('data-webui-placeholder-chrome="environment-变更"');

    const controls = renderToStaticMarkup(createElement(WebuiWorkspacePanelControls, { filePanelOpen: false, progressPanelOpen: true, onOpenFiles: () => undefined, onToggleProgressPanel: () => undefined }));
    expect(controls).toContain('aria-label="工作区文件侧栏"');
    expect(controls).toContain('aria-label="环境信息与进度"');
    expect(controls).not.toContain('aria-label="浏览器"');
  });

  it("does not render Desktop's environment section for a non-git session", () => {
    const overview = renderToStaticMarkup(createElement(WebuiProgressOverviewPanel, {
      workspaceDir: "/tmp/non-git-workspace",
      workspaceEnvironment: { isGitRepo: false, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "skipped" },
      todos: [],
    }));
    expect(overview).not.toContain("环境信息");
    expect(overview).toContain("进度");
  });

  it("renders completed, in-progress, and pending progress rows in SSR", () => {
    const markup = renderToStaticMarkup(createElement(WebuiProgressPanel, {
      todos: [
        { content: "已完成步骤", status: "completed" },
        { content: "当前步骤", status: "in_progress" },
        { content: "待处理步骤", status: "pending" },
      ],
    }));

    expect(markup).toContain("已完成步骤");
    expect(markup).toContain("当前步骤");
    expect(markup).toContain("待处理步骤");
    expect(markup).toContain("webui-progress-row--completed");
    expect(markup).toContain("webui-progress-row--in_progress");
    expect(markup).toContain("webui-progress-row--pending");
    expect(markup).toContain("line-through");
    expect(markup).toContain('class="webui-progress-marker"><svg');
  });
  it("preserves an explicit empty thinking variant in model selection requests", () => {
    expect(
      buildWebuiModelSelectionRequest(
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          variant: "thinking",
          contextLimit: 512_000,
        },
        { variant: "", contextLimit: 1_000_000 },
        "session-1",
      ),
    ).toEqual({
      providerId: "minimax",
      modelId: "MiniMax-M3",
      variant: "",
      contextLimit: 1_000_000,
      sessionId: "session-1",
    });
  });

  it("keeps model variants distinct when selecting the next-turn model", () => {
    const fast = {
      providerId: "provider",
      modelId: "model",
      variant: "fast",
    };
    const deep = { ...fast, variant: "deep" };
    expect(webuiModelOptionValue(fast)).not.toBe(webuiModelOptionValue(deep));
    expect(webuiModelOptionValue(fast)).toBe("provider/model/fast");
  });

  it("preserves a questionnaire's Other answer for the running turn", () => {
    const request = {
      schemaVersion: 1,
      id: "questionnaire-1",
      presentation: {
        replaceComposer: false,
        showProgress: true,
        allowBackNavigation: false,
      },
      steps: [
        {
          id: "purpose",
          question: "What should happen?",
          selectionMode: 0,
          allowOther: true,
          otherPlaceholder: "Describe it",
          required: true,
          options: [{ id: "ship", label: "Ship it" }],
        },
      ],
    } as const;
    expect(
      buildWebuiQuestionnaireAnswers(
        request,
        { purpose: [] },
        { purpose: true },
        { purpose: "Keep the current behavior" },
      ),
    ).toEqual([
      {
        stepId: "purpose",
        selectedOptionIds: [],
        selectedOther: true,
        otherText: "Keep the current behavior",
      },
    ]);
  });

  it("reads a created session id from either supported response shape", () => {
    expect(createdSessionId({ sessionId: "a" })).toBe("a");
    expect(createdSessionId({ session: { sessionId: "b" } })).toBe("b");
    expect(createdSessionId({ sessionId: "  c  " })).toBe("c");
    expect(createdSessionId({ session: { sessionId: "  d  " } })).toBe("d");
    expect(createdSessionId({})).toBeUndefined();
    expect(
      createdSessionId({ agentName: "x" } as Parameters<
        typeof createdSessionId
      >[0]),
    ).toBeUndefined();
  });

  it("round-trips the selected session through the URL hash", () => {
    expect(sessionHash("session with spaces")).toBe(
      "#session=session+with+spaces",
    );
    expect(readSessionIdFromHash("#session=session+with+spaces")).toBe(
      "session with spaces",
    );
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: {
          sessions: [
            {
              sessionId: "session-1",
              agentName: "agent",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          hasMore: false,
        },
        loading: false,
      }),
    );
    expect(html).toContain('href="#session=session-1"');
  });

  it("projects every persisted message facet independently", () => {
    expect(
      projectWebuiMessage({ msgId: "thinking", thinkingContent: "Reasoning" }),
    ).toEqual([{ kind: "thinking", text: "Reasoning", messageId: "thinking" }]);
    expect(
      projectWebuiMessage({ msgId: "tools", toolCalls: [{ name: "read" }] })[0]
        .kind,
    ).toBe("tool");
    expect(
      projectWebuiMessage({
        msgId: "both",
        thinkingContent: "Think",
        toolCalls: [{ name: "read" }],
        msgContent: "Answer",
      }).map((item) => item.kind),
    ).toEqual(["thinking", "assistant", "tool"]);
    expect(
      projectWebuiMessage({
        msgId: "answer",
        role: "user",
        msgContent: "Question",
      })[0].kind,
    ).toBe("user");
    expect(projectWebuiMessage({ msgId: "empty" })).toEqual([]);
  });

  it("recovers thinking and usage from persisted raw JSON fields", () => {
    const items = projectWebuiMessage({
      msgId: "raw-history",
      msgContent: "最终答复",
      rawJson: JSON.stringify({
        thinking_content: "被持久化的思考",
        usage: { request_duration_ms: 18_000, output_tokens: 1_746 },
      }),
    });
    expect(items.map((item) => item.kind)).toEqual(["thinking", "assistant"]);
    const groups = groupWebuiTranscriptItems(items);
    expect(groups[0]?.totalRequestDurationMs).toBe(18_000);
    expect(groups[0]?.totalOutputTokens).toBe(1_746);
  });

  it("renders an empty transcript without treating it as an error", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionTranscript, {
        sessionId: "empty-session",
        loadMessages: async () => ({ messages: [], hasMore: false }),
        initialMessages: { messages: [], hasMore: false },
      }),
    );
    expect(html).toContain('data-webui-transcript="empty-session"');
    expect(html).toContain('data-webui-transcript-empty="true"');
    expect(html).toContain('data-testid="transcript-empty-state"');
    expect(html).toContain("当前会话暂无消息");
  });

  it("groups a flat transcript into one block per message", () => {
    // The desktop renders one block per turn: a process disclosure carrying the
    // thinking and the tool steps, then the answer. Both belong to the same
    // message and must stay together; a user turn is its own block.
    const groups = groupWebuiTranscriptItems([
      ...projectWebuiMessage({
        msgId: "turn-1",
        role: "user",
        msgContent: "Question",
      }),
      ...projectWebuiMessage({
        msgId: "turn-2",
        thinkingContent: "Reasoning",
        toolCalls: [{ name: "read" }],
        msgContent: "Answer",
      }),
      ...projectWebuiMessage({ msgId: "turn-3", msgContent: "Afterwards" }),
    ]);
    expect(groups.map((group) => group.messageId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
    // turn-2 and turn-3 are adjacent assistant messages: one merged block.
    expect(groups[1].items.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(groupWebuiTranscriptItems([])).toEqual([]);
  });

  it("computes the wall-clock turn duration from user/assistant timestamps that live in different groups", () => {
    // Bug A regression: the user bubble opens its own group, then the assistant
    // block is a separate group. The duration has to span across both groups
    // via the shared `turnId`, not stay zero because they never share a block.
    const userItems = projectWebuiMessage({
      msgId: "u-1",
      role: "user",
      msgContent: "问题",
      turnId: "turn_04c6c7fe",
      timestamp: 1790087735738,
    });
    const assistantItems = projectWebuiMessage({
      msgId: "a-1",
      role: "assistant",
      msgContent: "回答",
      turnId: "turn_04c6c7fe",
      timestamp: 1790088159203,
    });
    const groups = groupWebuiTranscriptItems([...userItems, ...assistantItems]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messageId).toBe("u-1");
    expect(groups[1]?.messageId).toBe("a-1");
    expect(groups[1]?.wallClockDurationMs).toBe(1790088159203 - 1790087735738);
    expect(groups[1]?.wallClockDurationMs).toBe(423465);
  });

  it("counts each assistant message's outputTokens exactly once when thinking+tool+answer all carry the same usage blob", () => {
    // Regression for the duplicate-counting bug: `projectWebuiMessage`
    // emits one transcript item per part (thinking / tool / answer) for
    // every assistant message, and every part carries the same `usage`.
    // The aggregator must dedupe by messageId so a message with thinking
    // + tool + answer contributes its tokens once, not three times.
    const groups = groupWebuiTranscriptItems([
      ...projectWebuiMessage({
        msgId: "u-1",
        role: "user",
        msgContent: "做",
        turnId: "turn-A",
        timestamp: 1000,
      }),
      ...projectWebuiMessage({
        msgId: "a-1",
        role: "assistant",
        thinkingContent: "先想",
        toolCalls: [{ name: "read" }],
        msgContent: "中间",
        turnId: "turn-A",
        timestamp: 2000,
        usage: { outputTokens: 100 },
      }),
      ...projectWebuiMessage({
        msgId: "a-2",
        role: "assistant",
        msgContent: "结尾",
        turnId: "turn-A",
        timestamp: 3000,
        usage: { outputTokens: 250 },
      }),
    ]);
    // Adjacent assistant items share a single block; the user line opens
    // its own block. Two groups total.
    expect(groups).toHaveLength(2);
    // a-1 emits 3 parts (thinking, tool, answer), each with usage.outputTokens=100
    // a-2 emits 1 part (answer) with usage.outputTokens=250
    // Total unique: 100 + 250 = 350 (not 100*3 + 250 = 550).
    expect(groups[1]?.totalOutputTokens).toBe(350);
  });

  it("matches the Desktop rate (outputTokens / wallClockDurationMs) after dedup", () => {
    // Replays the target session: user ts=1790087735738, assistant ts=1790088159203,
    // 33 assistant messages, sum(outputTokens)=18411.
    //   18411 / (1790088159203 - 1790087735738) = 43.5 token/s
    // WebUI's dedupe must yield 18411, not the ×3 inflated value.
    const items: ReturnType<typeof projectWebuiMessage> = [];
    items.push(
      ...projectWebuiMessage({
        msgId: "u-target",
        role: "user",
        msgContent: "do",
        turnId: "turn_04c6c7fe",
        timestamp: 1790087735738,
      }),
    );
    // Build 33 assistant messages, each contributing 18411 / 33 ≈ 557.9 output
    // tokens. The exact distribution doesn't matter for dedup; what matters
    // is that every message also has thinking + tool parts so the dedupe
    // path runs. The final message lands on the real wall-clock end
    // (1790088159203) so the duration is 423465ms exactly.
    const tokensPerMessage = Math.round(18411 / 33);
    const span = 423465;
    const step = Math.floor(span / 33);
    for (let i = 0; i < 33; i++) {
      const ts =
        i === 32
          ? 1790088159203
          : 1790087735738 + (i + 1) * step;
      items.push(
        ...projectWebuiMessage({
          msgId: `a-target-${i}`,
          role: "assistant",
          thinkingContent: "think",
          toolCalls: [{ name: "bash" }],
          msgContent: "answer",
          turnId: "turn_04c6c7fe",
          timestamp: ts,
          usage: { outputTokens: tokensPerMessage },
        }),
      );
    }
    const groups = groupWebuiTranscriptItems(items);
    // Find the single assistant group.
    const assistantGroup = groups.find(
      (g) => g.items[0]?.kind !== "user",
    );
    expect(assistantGroup?.wallClockDurationMs).toBe(423465);
    // Allow off-by-one from the per-message rounding (33 * tokensPerMessage).
    expect(assistantGroup?.totalOutputTokens).toBeGreaterThanOrEqual(18411 - 33);
    expect(assistantGroup?.totalOutputTokens).toBeLessThanOrEqual(18411 + 33);
  });

  it("scopes the wall-clock duration to the same turnId so turns never bleed into each other", () => {
    const groups = groupWebuiTranscriptItems([
      ...projectWebuiMessage({
        msgId: "u-1",
        role: "user",
        msgContent: "one",
        turnId: "turn-A",
        timestamp: 100,
      }),
      ...projectWebuiMessage({
        msgId: "a-1",
        role: "assistant",
        msgContent: "first answer",
        turnId: "turn-A",
        timestamp: 2146 + 100,
      }),
      ...projectWebuiMessage({
        msgId: "u-2",
        role: "user",
        msgContent: "two",
        turnId: "turn-B",
        timestamp: 5000,
      }),
      ...projectWebuiMessage({
        msgId: "a-2",
        role: "assistant",
        msgContent: "second answer",
        turnId: "turn-B",
        timestamp: 5000 + 1422,
      }),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups[1]?.turnId).toBe("turn-A");
    expect(groups[1]?.wallClockDurationMs).toBe(2146);
    expect(groups[3]?.turnId).toBe("turn-B");
    expect(groups[3]?.wallClockDurationMs).toBe(1422);
    // The end of turn-A is 2246ms but turn-B starts at 5000ms; if we
    // accidentally bled across turns, the duration would be ≥ 5000ms.
    expect(groups[1]?.wallClockDurationMs).toBeLessThan(5000);
  });

  it("keeps the conversation's reading column and message chrome in the markup", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionTranscript, {
        sessionId: "reading-column",
        loadMessages: async () => ({ messages: [], hasMore: false }),
      }),
    );
    // The reading column and the message list region survive regardless of
    // whether any message loaded.
    expect(html).toContain('data-webui-message-list="true"');
  });

  it("renders newest sessions without a competing timestamp and falls back when title is absent", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: {
          sessions: [
            {
              sessionId: "older-id",
              agentName: "older-agent",
              createdAt: 1000,
              updatedAt: 2000,
            },
            {
              sessionId: "newer-id",
              agentName: "newer-agent",
              title: "Named session",
              createdAt: 3000,
              updatedAt: 4000,
            },
          ],
          hasMore: false,
        },
        loading: false,
      }),
    );
    expect(html.indexOf("Named session")).toBeLessThan(
      html.indexOf("older-agent"),
    );
    expect(html).toContain("older-agent");
    expect(html).not.toContain(new Date(2000).toLocaleString());
    expect(html).toContain('data-webui-session-list="true"');
    // The row's component class is on the anchor, which only exists once there
    // is a session to render.
    expect(html).toMatch(/webui-session-card/u);
  });

  it("projects the desktop's project-first rail from session workspaces", () => {
    const sessions = [
      {
        sessionId: "new-project-session",
        agentName: "main",
        createdAt: 1,
        updatedAt: 30,
        workspaceDir: "/work/minimax-code",
      },
      {
        sessionId: "old-project-session",
        agentName: "main",
        createdAt: 1,
        updatedAt: 20,
        workspaceDir: "/work/minimax-code",
      },
      {
        sessionId: "unassigned-session",
        agentName: "main",
        createdAt: 1,
        updatedAt: 10,
      },
    ];
    expect(groupWebuiSessionsByWorkspace(sessions)).toEqual([
      {
        key: "/work/minimax-code",
        name: "minimax-code",
        workspaceDir: "/work/minimax-code",
        latestSessionId: "new-project-session",
        sessionIds: ["new-project-session", "old-project-session"],
        updatedAt: 30,
      },
      {
        key: "__webui_unassigned_project__",
        name: "未选项目",
        latestSessionId: "unassigned-session",
        sessionIds: ["unassigned-session"],
        updatedAt: 10,
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(WebuiProjectList, {
        page: { sessions, hasMore: false },
        loading: false,
        selectedSessionId: "old-project-session",
      }),
    );
    expect(html).toContain('data-webui-project-list="true"');
    expect(html).toContain("minimax-code");
    expect(html).toContain("未选项目");
    expect(html).not.toContain('data-webui-session-list="true"');
    expect(html).not.toContain("<time");
  });

  it("expands the first project only when no session is selected", () => {
    // `latestSessionId` is required on the type but unread by
    // `resolveDefaultExpandedProjectKey`; it is filled in the way the rail
    // builds a group (`sessions[0]?.sessionId`) so the fixture is a shape the
    // component could actually hand this function.
    const projects = [
      { key: "/work/alpha", name: "alpha", sessionIds: ["a"], latestSessionId: "a", updatedAt: 20 },
      { key: "/work/beta", name: "beta", sessionIds: ["b"], latestSessionId: "b", updatedAt: 10 },
    ];
    expect(resolveDefaultExpandedProjectKey(projects, undefined, false)).toBe("/work/alpha");
    expect(resolveDefaultExpandedProjectKey(projects, "a", false)).toBeUndefined();
    expect(resolveDefaultExpandedProjectKey(projects, undefined, true)).toBeUndefined();
    expect(resolveDefaultExpandedProjectKey([], undefined, false)).toBeUndefined();
  });

  it("renders the desktop context-menu vocabulary and inert WebUI-only gaps", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiContextMenu, {
        x: 12,
        y: 18,
        onClose: () => undefined,
        items: [
          { kind: "item", key: "rename", label: "重命名", icon: createElement("span") },
          { kind: "divider", key: "divider" },
          {
            kind: "item",
            key: "copy",
            label: "复制",
            submenu: [
              { kind: "item", key: "copy-id", label: "复制会话 ID", disabled: false },
            ],
          },
          { kind: "item", key: "feedback", label: "问题反馈", disabled: true },
          { kind: "item", key: "delete", label: "删除", danger: true },
        ],
      }),
    );
    expect(html).toContain('data-webui-context-menu="true"');
    expect(html).toContain("重命名");
    expect(html).toContain("复制");
    expect(html).toContain("问题反馈");
    expect(html).toContain("删除");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("webui-context-menu-divider");
  });

  it("uses Desktop-sized SVGs and separate pinned and unpinned pin glyphs", () => {
    const glyphs = [
      WebuiIconContextRename,
      WebuiIconContextArchive,
      WebuiIconContextFork,
      WebuiIconContextCopy,
      WebuiIconContextFeedback,
      WebuiIconContextTrash,
      WebuiIconFolder,
    ];
    for (const Glyph of glyphs) {
      const markup = renderToStaticMarkup(createElement(Glyph));
      expect(markup).toContain('width="18" height="18" viewBox="0 0 20 20"');
      expect(markup).toContain('fill="currentColor"');
    }

    const pinned = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: true }));
    const unpinned = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: false }));
    expect(pinned).toContain('width="18" height="18" viewBox="0 0 20 20"');
    expect(unpinned).toContain('width="18" height="18" viewBox="0 0 20 20"');
    expect(pinned).not.toBe(unpinned);

    const submenuChevron = renderToStaticMarkup(createElement(WebuiIconContextChevron));
    expect(submenuChevron).toContain('width="16" height="16" viewBox="0 0 16 16"');
  });

  it("moves a pinned session ahead of newer unpinned sessions", () => {
    const sessions = [
      { sessionId: "newer", agentName: "main", createdAt: 1, updatedAt: 30 },
      { sessionId: "pinned", agentName: "main", createdAt: 1, updatedAt: 10 },
    ];
    expect(sortWebuiProjectSessionIds(sessions, { pinned: true }, ["newer", "pinned"]))
      .toEqual(["pinned", "newer"]);
  });

  it("flips a context menu above the pointer when it would hit the viewport bottom", () => {
    expect(placeWebuiContextMenu({
      x: 10,
      y: 780,
      width: 208,
      height: 360,
      viewportWidth: 1024,
      viewportHeight: 900,
    })).toEqual({ left: 10, top: 420 });
  });

  it("keeps the first project session aligned after its leading marker", () => {
    const styles = readFileSync(
      new URL("../../src/client/styles/shell.css", import.meta.url),
      "utf8",
    );
    const projectSessionsRule = styles.match(
      /\.webui-project-session-list\s*\{([^}]*)\}/u,
    );
    expect(projectSessionsRule, "project session list rule is missing").not.toBeNull();
    expect(projectSessionsRule![1]).toMatch(
      /padding:\s*1px\s+0\s+var\(--spacing_4\)\s+2px/u,
    );
    const leadingMarkerRule = styles.match(
      /\.webui-session-leading-marker\s*\{([^}]*)\}/u,
    );
    expect(leadingMarkerRule, "session leading marker rule is missing").not.toBeNull();
    expect(leadingMarkerRule![1]).toMatch(/width:\s*18px/u);
    expect(leadingMarkerRule![1]).toMatch(/flex:\s*0\s+0\s+18px/u);
  });

  it("keeps subagent sessions visibly nested under their parent session", () => {
    const styles = readFileSync(
      new URL("../../src/client/styles/shell.css", import.meta.url),
      "utf8",
    );
    const childListRule = styles.match(
      /\.webui-project-child-session-list\s*\{([^}]*)\}/u,
    );
    const childCardRule = [...styles.matchAll(
      /\.webui-project-child-session-card\s*\{([^}]*)\}/gu,
    )].find((match) => /height:\s*30px/u.test(match[1]));
    expect(childListRule, "child session list rule is missing").not.toBeNull();
    expect(childListRule![1]).toMatch(/gap:\s*2px/u);
    expect(childListRule![1]).toMatch(/padding-top:\s*1px/u);
    expect(childCardRule, "child session card rule is missing").not.toBeNull();
    expect(childCardRule![1]).toMatch(/height:\s*30px/u);
    expect(childCardRule![1]).toMatch(/padding-left:\s*34px/u);
    const sessionTypographyRule = styles.match(
      /\.webui-project-session-card,\s*\.webui-project-child-session-card\s*\{([^}]*)\}/u,
    );
    expect(sessionTypographyRule, "shared session typography rule is missing").not.toBeNull();
    expect(sessionTypographyRule![1]).toMatch(/font-size:\s*var\(--size_12\)/u);
    expect(sessionTypographyRule![1]).toMatch(
      /line-height:\s*var\(--line_height_16\)/u,
    );
    expect(styles).toMatch(/\.webui-project-card:hover\s*\{/u);
    expect(styles).not.toMatch(
      /\.webui-project-card\[data-webui-project-active="true"\]/u,
    );
  });

  it("reacts to hashchange so navigation selects a different transcript without reload", () => {
    const originalWindow = globalThis.window;
    let hash = "#session=first";
    const listeners = new Set<(event: Event) => void>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get location() {
          return { hash };
        },
        addEventListener(type: string, listener: (event: Event) => void) {
          if (type === "hashchange") listeners.add(listener);
        },
        removeEventListener(type: string, listener: (event: Event) => void) {
          if (type === "hashchange") listeners.delete(listener);
        },
      },
    });
    try {
      let selected = readSessionIdFromHash(hash);
      const unsubscribe = subscribeToSessionHash((id) => {
        selected = id;
      });
      hash = "#session=second";
      for (const listener of listeners) listener(new Event("hashchange"));
      expect(selected).toBe("second");
      unsubscribe();
      expect(listeners).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("shows the bound working directory without offering a directory edit control", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: {
          sessions: [
            {
              sessionId: "session-1",
              agentName: "agent",
              createdAt: 1,
              updatedAt: 2,
              workspaceDir: "/tmp/project",
            },
          ],
          hasMore: false,
        },
        loading: false,
      }),
    );
    expect(html).toContain("/tmp/project");
    expect(html).not.toMatch(/edit.*directory|change.*directory/iu);
  });

  it("renders a legitimate empty shared-history state", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [], hasMore: false },
        loading: false,
      }),
    );
    // Chinese, like the rest of the rail. The running and unread views override
    // this with their own, and "no sessions yet" is false in both of them.
    expect(html).toContain("暂无会话");
  });

  it("lets a view name its own empty state", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [], hasMore: false },
        loading: false,
        emptyLabel: "没有未读会话",
      }),
    );
    expect(html).toContain("没有未读会话");
    expect(html).not.toContain("暂无会话");
  });
});

describe("WebUI shell — desktop anatomy", () => {
  it("declares the shell as a two-column rail plus surface", () => {
    const html = renderShell();
    expect(html).toMatch(/data-webui-shell="two-column"/u);
    expect(html).toMatch(/data-webui-shell-region="rail"/u);
    expect(html).toMatch(/data-webui-shell-region="surface"/u);
  });

  it("sizes and colours the rail the way the desktop does", () => {
    const html = renderShell();

    // 240px fixed, one step off the main surface, and no border between the two.
    expect(html).toMatch(/data-webui-rail-width="240"/u);
    expect(html).toMatch(/w-\[240px\]/u);
    expect(html).toMatch(/webui-rail-scroll/u);
    expect(html).toMatch(/bg-bg_default_scrim/u);
    // The main surface is the lightest step.
    expect(html).toMatch(/bg-bg_grouped_secondary/u);
    // The composer carries the elevated desktop surface token.
    expect(html).toMatch(/bg-bg_grouped_secondary_elevated/u);
  });

  it("keeps the rail scrollable without showing a scrollbar", () => {
    const styles = readFileSync(
      new URL("../../src/client/styles/shell.css", import.meta.url),
      "utf8",
    );
    const railScrollRule = styles.match(
      /\.webui-rail-scroll\s*\{([^}]*)\}/u,
    );
    const webkitScrollbarRule = styles.match(
      /\.webui-rail-scroll::-webkit-scrollbar\s*\{([^}]*)\}/u,
    );
    expect(railScrollRule, "rail scrollbar rule is missing").not.toBeNull();
    expect(railScrollRule![1]).toMatch(/scrollbar-width:\s*none/u);
    expect(railScrollRule![1]).toMatch(/-ms-overflow-style:\s*none/u);
    expect(webkitScrollbarRule, "WebKit rail scrollbar rule is missing").not.toBeNull();
    expect(webkitScrollbarRule![1]).toMatch(/display:\s*none/u);
  });

  it("stacks the rail in the desktop's order", () => {
    const html = renderShell();
    const order = [
      'data-webui-sidebar-toggle="true"',
      'data-webui-rail-fixed-row="true"',
      'data-webui-nav-item="插件"',
      'data-webui-rail-section-header="true"',
      'data-webui-rail-identity="true"',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = html.indexOf(marker);
      expect(at, `${marker} missing from the rail`).toBeGreaterThan(-1);
      expect(at, `${marker} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("wires plugin navigation and leaves unsupported destinations inert", () => {
    const html = renderShell();

    // Only the unsupported destinations carry inert markers; the Plugin row
    // opens its management surface.
    const markers =
      html.match(/data-webui-placeholder-chrome="rail-nav"/gu) ?? [];
    expect(markers).toHaveLength(INERT_NAV_LABELS.length);

    for (const label of INERT_NAV_LABELS) {
      const at = html.indexOf(`data-webui-nav-item="${label}"`);
      expect(at, `nav row ${label} missing`).toBeGreaterThan(-1);
      expect(html.slice(at, at + 500), `nav row ${label} is not inert`).toMatch(
        /disabled/u,
      );
    }
    expect(html).toMatch(/data-webui-nav-item="插件"/u);

    // The current destination carries the state hook, so the selected row has
    // something to read.
    expect(html).toMatch(/data-webui-nav-active="true"/u);
  });

  it("uses token-derived colour utilities and the shell's component classes", () => {
    const html = renderShell();

    expect(html).toMatch(/text-text_default_primary/u);
    expect(html).toMatch(/text-text_default_secondary/u);
    expect(html).toMatch(/text-text_default_tertiary/u);
    expect(html).toMatch(/text-icon_default_tertiary/u);
    expect(html).toMatch(/border-border_default/u);
    expect(html).toMatch(/text-size_12/u);
    expect(html).toMatch(/leading-line_height_16/u);

    expect(html).toMatch(/webui-nav-item/u);
    expect(html).toMatch(/webui-empty-state/u);
    expect(html).toMatch(/webui-textarea/u);
    // The workspace trigger moved off the generic `webui-pill` onto the
    // purpose-built bar class, because it now sits inside the grey band that
    // carries the project context rather than floating as its own pill.
    // `webui-pill` is still live — SessionRail's project chips use it — but the
    // rail is not part of this render, so asserting it here would only pass by
    // accident of composition.
    expect(html).toMatch(/webui-workspace-bar/u);
    expect(html).toMatch(/webui-workspace-bar-trigger/u);
  });

  it("nests the project row inside the scrim container, not beside it", () => {
    const html = renderShell();

    // The seam the row used to have came from being a SIBLING of the scrim
    // container: the card, the container's own `pb-2` and the row's separate
    // fill met along one line and read as two stacked boxes. Sharing the
    // container's box is what makes the card and the band one surface, so
    // document order is the cheap structural proxy — the row must come after
    // the scrim opens and before the composer form ends.
    const scrim = html.indexOf("message-input-home-container");
    const form = html.indexOf('data-webui-composer="true"');
    const bar = html.indexOf("webui-workspace-bar");

    expect(scrim).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(-1);
    expect(form).toBeLessThan(scrim);
    expect(scrim).toBeLessThan(bar);
    // Exactly one scrim box: a second would reintroduce the second surface.
    expect(html.split("message-input-home-container")).toHaveLength(2);
  });

  it("uses the desktop's own class composition for rows and pills", () => {
    const html = renderShell();

    // Row and control geometry the desktop states as utilities rather than as
    // tokens: 32px nav rows on an 8px radius, 48px identity row on 10px,
    // 14px body type and the user-menu identity row's desktop radius.
    expect(html).toMatch(/h-8/u);
    expect(html).toMatch(/rounded-lg/u);
    expect(html).toMatch(/text-sm/u);
    expect(html).toMatch(/h-12/u);
    expect(html).toMatch(/webui-user-menu-trigger/u);
    expect(html).toMatch(/webui-user-menu-anchor/u);
  });

  it("never leaves a control operable but unbound", () => {
    // The failure this guards: a control that renders enabled, shows a pointer
    // cursor and a hover fill, and has nothing behind it. A screen full of those
    // reads as broken — and it is not caught by any styling assertion, because the
    // markup and the stylesheet are both exactly what was asked for.
    //
    // Every rendered control is backed by an actual WebUI transport or local
    // composer action. The attachment menu is now operable and opens the
    // catalogue/file actions rather than a disabled placeholder. The rail
    // search button joined them when session search shipped — it toggles the
    // search input rather than sitting disabled, which is why the count moved
    // from 6 to 7. The rail import row joined them when session import
    // shipped: it opens a file picker that posts to /session-import, so it is
    // bound rather than a placeholder, and the count moved from 7 to 8. The
    // three rail view tabs joined them when the project/running/unread switch
    // shipped: each one changes the list, so they are bound rather than
    // decorative, and the count moved from 8 to 11. The favourites tab joined
    // them when starring shipped: it swaps the rail to the starred set, so it
    // is bound on the same terms, and the count moved from 11 to 12.
    const html = renderShell();
    const controlTags: string[] = [];
    const re = /<(button|div|a|input|textarea|select)\b[^>]*>/gu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const tag = match[0];
      if (/^<button\b/u.test(tag) || /role="button"/u.test(tag))
        controlTags.push(tag);
    }
    const operable = controlTags.filter(
      (tag) =>
        !/(?:^|\s)disabled(?:=|\s|>)/u.test(tag) &&
        !/aria-disabled="true"/u.test(tag),
    );
    expect(operable).toHaveLength(12);
    expect(html).toMatch(/data-testid="composer-add-menu"/u);
    expect(html).toMatch(/data-webui-sidebar-toggle="true"/u);
    expect(html).toMatch(/data-webui-nav-item="新建任务"/u);
    // The search control must stay operable: reverting it to the disabled
    // placeholder would silently drop session search rather than fail loudly.
    expect(html).toMatch(/data-webui-search="true" aria-expanded="false"/u);
    expect(html).not.toMatch(/data-webui-search="true"[^>]*\sdisabled/u);
    // Same for import. Without this the picker could be unbound -- the server
    // route would still answer, and only a real user's click would find out.
    expect(html).toMatch(/data-webui-nav-item="导入会话"/u);
    expect(html).toMatch(/data-webui-session-import-input="true"/u);
    expect(html).not.toMatch(/data-webui-nav-item="导入会话"[^>]*\sdisabled/u);
    // Same for the view tabs. A tab that is operable but does nothing is
    // the exact shape this test exists to catch, so every one is asserted by
    // name and none of them may be disabled. A view added to the rail without
    // being added here would sail past this contract.
    for (const view of ["projects", "running", "unread", "stars"]) {
      expect(html, view).toMatch(new RegExp(`data-webui-rail-view="${view}"`, "u"));
      expect(html, view).not.toMatch(
        new RegExp(`data-webui-rail-view="${view}"[^>]*\\sdisabled`, "u"),
      );
    }
    expect(html).toMatch(/data-webui-rail-view="projects"[^>]*aria-selected="true"/u);
  });

  it("lets the composer take a draft before a session exists", () => {
    // Composing does not need a target; only sending does. With a transport present
    // the field must accept text even though nothing is selected yet — leaving it
    // disabled is what made the first screen look like it could not be used at all.
    const html = renderToStaticMarkup(
      createElement(WebuiClientFoundationApp, {
        label: "webui-foundation",
        transport: { sendMessage: async () => undefined },
      }),
    );
    const at = html.indexOf("<textarea");
    const field = html.slice(at, html.indexOf(">", at) + 1);
    expect(field).toMatch(/data-webui-composer-input="true"/u);
    expect(field).not.toMatch(/(?:^|\s)disabled(?:=|\s|>)/u);

    // The send action stays unavailable until there is something to send.
    const sendAt = html.indexOf("webui-send-button");
    const send = html.slice(
      html.lastIndexOf("<button", sendAt),
      html.indexOf(">", sendAt) + 1,
    );
    expect(send).toMatch(/(?:^|\s)disabled(?:=|\s|>)/u);
  });

  it("puts the hero and the desktop composer on the home surface", () => {
    const html = renderShell();

    expect(html).toMatch(/data-webui-home-content="true"/u);
    expect(html).toContain("MiniMax Code，让工作更简单。");
    // The hero column keeps the desktop's 743px width below a 240px spacer.
    expect(html).toMatch(/max-w-\[743px\]/u);
    // The spacer is decorative, full-bleed, and holds its size in the flex
    // column. Its height is the desktop's 240px as a *cap*, not a literal:
    // d9b9519 ("update onboarding layout and responsive design") made the
    // spacer responsive with `h-[clamp(96px,24vh,240px)]`, which still resolves
    // to 240px on any desktop-height window and only shrinks on short ones.
    // Asserting the cap keeps the 240px headroom under test while leaving the
    // responsive expression free to move; pinning the exact utility string
    // would fail again on the next viewport pass without catching a real
    // regression.
    const spacerMatch = html.match(/<div aria-hidden="true" class="([^"]*)"><\/div>/u);
    expect(spacerMatch, "home hero spacer is missing").not.toBeNull();
    const spacerClasses = spacerMatch?.[1] ?? "";
    // h-[…] whose expression names 240px, so the headroom is bounded by the
    // desktop's value and never grows past it.
    expect(spacerClasses, "spacer height must stay capped at 240px").toMatch(/(?:^|\s)h-\[[^\]]*\b240px\b[^\]]*\]/u);
    expect(spacerClasses, "spacer must stay full-bleed").toMatch(/(?:^|\s)w-full(?:\s|$)/u);
    expect(spacerClasses, "spacer must not shrink in the flex column").toMatch(/(?:^|\s)shrink(?:\s|$)/u);
    expect(html).not.toMatch(/data-webui-recommendations="true"/u);
    expect(html).not.toMatch(/data-webui-conversation-source="true"/u);
    // New Task is the desktop's clean home state, not the WebUI-only create-session
    // form and not a previously selected transcript.
    expect(html).not.toMatch(/data-webui-create-form="true"/u);
    expect(html).not.toMatch(/data-webui-transcript="/u);

    // The composer card carries the desktop's own geometry: a 20px radius over a
    // hairline border plus the soft layer. The border alone reads as nothing on
    // this surface, so the shadow is the load-bearing part.
    expect(html).toMatch(/data-webui-composer="true"/u);
    expect(html).toMatch(/data-webui-composer-input="true"/u);
    expect(html).toMatch(/data-webui-composer-toolbar="true"/u);
    expect(html).toMatch(/data-webui-workspace-toolbar="true"/u);
    expect(html).toMatch(/rounded-\[20px\]/u);
    // The card's second layer is a component rule with a token value, not an
    // arbitrary-value utility: `shadow-[…var(--a_b)]` compiles the token's
    // underscore into a space (an invalid reference) and emits a
    // `--tw-shadow-color` reference nothing defines, which the closure check in
    // webui-design-tokens.test.ts rejects.
    expect(html).toMatch(/webui-composer-card/u);
    expect(html).toMatch(/webui-hero-avatar/u);
    expect(html).toMatch(/data-webui-model-selector="true"/u);
    expect(html).toMatch(/webui-model-selector-trigger/u);
    expect(html).toMatch(/data-webui-workspace-picker="true"/u);
    expect(html).toMatch(/data-webui-composer-submit="true"/u);
    expect(html).not.toMatch(/data-webui-placeholder-chrome="recommendation-chips"/u);
  });

  it("does not add the generic blue focus ring to the composer input", () => {
    const styles = readFileSync(
      new URL("../../src/client/styles/shell.css", import.meta.url),
      "utf8",
    );
    const composerFocusRule = styles.match(
      /\.webui-textarea\.webui-composer-input:focus,\s*\.webui-textarea\.webui-composer-input:focus-visible\s*\{([^}]*)\}/u,
    );
    expect(composerFocusRule, "composer focus override is missing").not.toBeNull();
    expect(composerFocusRule![1]).toMatch(/border:\s*0/u);
    expect(composerFocusRule![1]).toMatch(/outline:\s*none/u);
    expect(composerFocusRule![1]).toMatch(/box-shadow:\s*none/u);
  });

  it("keeps the session composer below a separately scrolling transcript", () => {
    const html = renderSessionShell();

    expect(html).toMatch(/data-webui-session-layout="true"/u);
    expect(html).not.toMatch(/webui-session-surface-with-workspace/u);
    expect(html).toMatch(/webui-session-layout relative flex h-full min-h-0 w-full/u);
    expect(html).toMatch(/data-webui-session-transcript-scroll="true"/u);
    expect(html).toMatch(/data-webui-session-composer="true"/u);
    expect(html).toMatch(/webui-session-transcript-scroll/u);
    expect(html).toMatch(/webui-session-composer/u);
    expect(html).not.toMatch(/data-webui-workspace-toolbar="true"/u);
    expect(html).not.toMatch(/data-webui-workspace-picker="true"/u);
  });

  it("does not render a usage summary in the session composer", () => {
    const source = readFileSync(
      new URL("../../src/client/components/SessionComposer.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('data-webui-session-usage="true"');
  });

  it("keeps the token-named spacing and type scale in the blocks that use it", () => {
    // The desktop composes both scales; the WebUI's own surfaces (the transcript,
    // the transcript) are written in the token-named one, so assert it where it
    // is actually rendered rather than in the home shell.
    const transcript = renderToStaticMarkup(
      createElement(WebuiSessionTranscript, {
        sessionId: "s",
        loadMessages: async () => ({ messages: [], hasMore: false }),
        initialMessages: { messages: [], hasMore: false },
      }),
    );
    expect(transcript).toMatch(/p-spacing_/u);
    expect(transcript).toMatch(/gap-spacing_/u);
    expect(transcript).toMatch(/text-size_/u);
    expect(transcript).toMatch(/leading-line_height_/u);
    // `webui-button-secondary` belongs to the "Load older" control, which only
    // renders once a second page is known to exist; that the class reaches the
    // compiled stylesheet is asserted in webui-design-tokens.test.ts.
  });
});

describe("WebUI shell — theme switching", () => {
  it("is opt-in via a class on the root element", () => {
    // The HTML wrapper that ships with the build sets `class="light"` on
    // <html> so the compiled `.light` rule applies by default. Switching
    // happens by toggling the class on the root element.
    const html = readFileSync(
      new URL("../../src/client/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toMatch(/<html[^>]+class="light"/u);
  });

  it("flips the primary surface when the root class changes", () => {
    const tokens = readFileSync(
      new URL("../../src/client/styles/tokens.css", import.meta.url),
      "utf8",
    );
    const lightMatch = tokens.match(
      /\.light\s*\{([^}]*--bg_default_primary[^;]*);/u,
    );
    const darkMatch = tokens.match(
      /\.dark\s*\{([^}]*--bg_default_primary[^;]*);/u,
    );
    expect(
      lightMatch,
      ".light must rebind --bg_default_primary",
    ).not.toBeNull();
    expect(darkMatch, ".dark must rebind --bg_default_primary").not.toBeNull();
    expect(lightMatch![1].trim()).not.toBe(darkMatch![1].trim());
  });
});

describe("WebUI rail row click wiring", () => {
  it("does not pass React's click event to a no-argument selection callback", () => {
    const source = readFileSync(
      new URL("../../src/client/components/RailRow.tsx", import.meta.url),
      "utf8",
    );

    // React supplies a MouseEvent to a directly assigned onClick handler even
    // when the callback's TypeScript type takes no arguments. New Task accepts
    // an optional workspace path, so forwarding that event makes the composer
    // call `.trim()` on the event object and clears the whole React root.
    expect(source).toContain("onClick={() => onSelect?.()}");
  });
});

// Behaviour-level coverage of the composer's send/resume loop. The test
// drives the same `runWebuiStreamLoop` the composer in
// `components/SessionComposer.tsx` calls
// from its submit handler, with a WebSocket double (the mocked
// `sendMessage` / `resumeSession` close over the `onFrame` callback the
// transport would otherwise hand to a real socket). The assertions
// observe the loop's outcome through the sink callbacks, which is the
// same observable the React shell binds to `setStream`. No DOM is
// rendered; the review noted the absence of a DOM environment and
// ruled out adding one. What this gives us is effect-based evidence
// that the reconnect branch is reachable and that the composer calls
// `resumeSession` with the cursor it observed before the drop.
describe("WebUI composer send/resume loop", () => {
  it("calls resumeSession with the cursor it observed before a mid-stream socket drop", async () => {
    // Scenario: the user's prompt starts a stream; the server emits a
    // cursor-bearing frame; then the WebSocket closes before [DONE].
    // The brief's F1 says the loop must call `resumeSession` with
    // `afterCursor: <that cursor>` and surface the `reconnecting`
    // phase the shell renders. The previous implementation had the
    // reconnect branch after the `await sendMessage` line, so a
    // rejection landed in the catch and went straight to `refused`;
    // this test asserts the *recovered* sequence.
    const observedPhases: string[] = [];
    const resumeCalls: { afterCursor?: string }[] = [];
    const applied: WebuiStreamFrame[] = [];

    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        // Open the stream; emit a chunk that carries the cursor the
        // upstream group would carry. Then reject to simulate the WS
        // closing before `[DONE]`.
        onFrame({
          dataJson:
            '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
          cursor: "c1",
        });
        throw new Error("WebUI connection closed before [DONE]");
      },
    );
    const resumeSession: WebuiClientSessionResumer = vi.fn(
      async (req, onFrame) => {
        resumeCalls.push({ afterCursor: req.afterCursor });
        // The fresh subscription ends with `[DONE]` — same wire shape
        // as a successful send. The loop's only job here is to route
        // the frames through `applyFrame` and resolve.
        onFrame({ dataJson: '{"type":10}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );

    await loopWithProjection(
      { sendMessage, resumeSession },
      { sessionId: "session-1", message: "hello" },
      {
        applyFrame: (frame) => applied.push(frame),
        setPhase: (phase) => observedPhases.push(phase),
        setMessages: () => undefined,
        refuse: () => undefined,
      },
    );

    // The loop's phase trace must contain `reconnecting` — the same
    // phase the shell turns into the `Reconnecting…` row. The previous
    // implementation never reached this phase because the rejection
    // went straight to `refused`.
    expect(observedPhases).toContain("reconnecting");
    expect(observedPhases).not.toContain("refused");
    // The cursor captured before the drop is forwarded to
    // `resumeSession` as `afterCursor`. That is the exact contract the
    // brief's resume criterion relies on.
    expect(resumeCalls).toEqual([{ afterCursor: "c1" }]);
    // The capture pipeline saw both the chunk from the original stream
    // and the frames from the resumed stream. The chunk is what gave
    // the loop its cursor.
    expect(applied.some((f) => f.cursor === "c1")).toBe(true);
    // The phase sequence ends in `done` — the resumed stream resolved
    // its `[DONE]` and the loop fell through to the final commit.
    expect(observedPhases.at(-1)).toBe("done");
  });

  it("reloads history and resubscribes with no cursor after a resume_overflow frame", async () => {
    // Scenario: a stream emits a `resume_overflow` event mid-flight
    // before `[DONE]`. The brief's F2 says the loop must reload
    // authoritative history through `getMessages` and establish a
    // fresh `resumeSession` subscription with no cursor. The previous
    // implementation read the `needsHistoryReload` flag at the top of
    // the loop, but the `await sendMessage` line broke out of the loop
    // before the next iteration could observe it.
    const observedPhases: string[] = [];
    const resumeCalls: { afterCursor?: string }[] = [];
    let loadMessagesCalls = 0;

    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"stale answer"}}',
          cursor: "c-stale",
        });
        onFrame({ dataJson: '{"type":"resume_overflow"}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const resumeSession: WebuiClientSessionResumer = vi.fn(
      async (req, onFrame) => {
        resumeCalls.push({ afterCursor: req.afterCursor });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const loadMessages: WebuiClientMessageLoader = vi.fn(async () => {
      loadMessagesCalls += 1;
      return { messages: [], hasMore: false };
    });

    await loopWithProjection(
      { sendMessage, resumeSession, loadMessages, projection: streamRecoveryProjection },
      { sessionId: "session-1", message: "hello" },
      {
        applyFrame: () => undefined,
        setPhase: (phase) => observedPhases.push(phase),
        setMessages: () => undefined,
        refuse: () => undefined,
      },
    );

    // `loadMessages` ran exactly once, the way the brief intends.
    expect(loadMessagesCalls).toBe(1);
    // `resumeSession` was called once, with no `afterCursor`, because
    // the reload already established the fresh subscription point.
    expect(resumeCalls).toEqual([{ afterCursor: undefined }]);
    // The loop moved through `reconnecting` and never went to
    // `refused`. The phase sequence must contain `reconnecting` so the
    // shell renders its `Reconnecting…` indicator.
    expect(observedPhases).toContain("reconnecting");
    expect(observedPhases).not.toContain("refused");
    expect(observedPhases.at(-1)).toBe("done");
  });

  it("resyncs one stream message per history record and retains ordered Desktop parts", async () => {
    const orderedHistoryMessage = {
      msgId: "resync-ordered",
      role: "assistant",
      msgContent: "legacy message text",
      thinkingContent: "legacy thinking",
      toolCalls: [{ name: "legacy_tool" }],
      timestamp: 123,
      usage: { request_duration_ms: 1_250, output_tokens: 42 },
      parts: [
        { id: "p1", type: "thinking", content: "first thought" },
        { id: "p2", type: "tool_call", tool_call: { name: "read_file", input: "src/a.ts" } },
        { id: "p3", type: "text", content: "text between activities" },
        { id: "p4", type: "cognitive", content: "cognitive detail" },
        { id: "p5", type: "delegation", message: { fromAgent: "main", toAgent: "reviewer", content: "review this" } },
        { id: "p6", type: "text", content: "final ordered text" },
      ],
    };
    const legacyHistoryMessage = {
      msgId: "resync-legacy",
      role: "assistant",
      msgContent: "legacy answer",
      thinkingContent: "legacy thought",
      toolCalls: [{ name: "bash", input: "pwd" }],
    };
    const userHistoryMessage = {
      msgId: "msg-user-resync",
      role: "user",
      msgContent: "original prompt",
    };
    const history = [orderedHistoryMessage, legacyHistoryMessage, userHistoryMessage];
    let resyncedMessages: Parameters<WebuiStreamLoopSink["setMessages"]>[0] = [];
    const sendMessage: WebuiClientMessageSender = async (_request, onFrame) => {
      onFrame({ dataJson: '{"type":"resume_overflow"}' });
      onFrame({ dataJson: "[DONE]" });
    };
    const resumeSession: WebuiClientSessionResumer = async (_request, onFrame) => {
      onFrame({ dataJson: "[DONE]" });
    };
    const loadMessages: WebuiClientMessageLoader = async () => ({
      messages: history,
      hasMore: false,
    });

    await loopWithProjection(
      { sendMessage, resumeSession, loadMessages, projection: streamRecoveryProjection },
      { sessionId: "session-resync", message: "prompt" },
      {
        applyFrame: () => undefined,
        setPhase: () => undefined,
        setMessages: (messages) => { resyncedMessages = messages; },
        refuse: () => undefined,
      },
    );

    expect(resyncedMessages).toHaveLength(history.length);
    expect(resyncedMessages.map((message) => message.id)).toEqual([
      "resync-ordered", "resync-legacy", "msg-user-resync",
    ]);
    expect(resyncedMessages[0]).toMatchObject({
      timestamp: 123,
      usage: { request_duration_ms: 1_250, output_tokens: 42 },
      parts: orderedHistoryMessage.parts,
    });
    expect(resyncedMessages[0]).not.toHaveProperty("role");
    expect(resyncedMessages[2]).toMatchObject({ role: "user", answer: "original prompt" });
    expect(resyncedMessages[1]).toMatchObject({
      answer: "legacy answer",
      thinking: "legacy thought",
      toolCalls: legacyHistoryMessage.toolCalls,
    });

    const liveView = projectLiveTurnView(resyncedMessages, {
      sessionId: "session-resync",
      streaming: false,
    });
    expect(liveView?.processSegments?.[0]?.activityParts?.map((part) => part.type)).toEqual([
      "thinking", "tool", "text", "cognitive", "delegation", "text",
    ]);
    expect(liveView?.processSegments?.[0]?.activityParts?.map((part) =>
      part.type === "text" || part.type === "thinking" || part.type === "cognitive"
        ? part.text
        : part.type === "delegation"
          ? part.message.content
          : part.type === "tool"
            ? part.tool.name
            : undefined,
    )).toEqual([
      "first thought", "read_file", "text between activities", "cognitive detail", "review this", "final ordered text",
    ]);
  });

  it("contains sink callback failures — the loop never rejects even if the sink throws", async () => {
    // Brief R8 said the documented "never rejects" guarantee was false
    // when a sink callback throws. The fix wraps every sink callback
    // in a try/catch; the outer loop must resolve regardless. The
    // transport mocks here all resolve cleanly so the only failures
    // come from the sink itself; we then assert the loop resolved.
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: '{"type":10}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const throwingSink = {
      applyFrame: () => {
        throw new Error("applyFrame blew up");
      },
      setPhase: () => {
        throw new Error("setPhase blew up");
      },
      setMessages: () => {
        throw new Error("setMessages blew up");
      },
      refuse: () => {
        throw new Error("refuse blew up");
      },
    };
    await expect(
      loopWithProjection(
        { sendMessage },
        { sessionId: "session-1", message: "hello" },
        throwingSink,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("WebUI composer sink binding", () => {
  // Brief R7: the previous shell tests called `runWebuiStreamLoop`
  // directly with their own sinks, so a misrouted or dropped callback
  // in the production binding (the inline object literal the composer
  // used to build) would not fail a test. The fix extracts
  // the binding into `buildWebuiStreamLoopSink`, which the production
  // shell now uses. This describe block exercises that helper with a
  // recording state reducer so that:
  //  - `applyFrame` routed to `setStream(reduce(current, frame))` —
  //    dropping this binding leaves the reducer out of the loop and
  //    fails the `applyFrame` assertion;
  //  - `setPhase` updates `state.phase` only — confusing it with
  //    `refuse` would write `phase: "refused"` instead of the
  //    intended value;
  //  - `setMessages` replaces `state.messages` without touching phase
  //    — confusing it with `setPhase` would drop the messages;
  //  - `refuse` writes `phase: "refused"` and `refusal` — confusing
  //    either field fails the corresponding assertion.
  type Reducer = (current: WebuiStreamState) => WebuiStreamState;
  const recordingReducer = (log: Reducer[]): ((update: Reducer) => void) => {
    return (update) => {
      log.push(update);
    };
  };

  it("binds the composer sink to the React state reducer correctly", () => {
    const log: Reducer[] = [];
    const setStream = recordingReducer(log);
    const sink = buildWebuiStreamLoopSink(setStream);

    // `applyFrame` must reduce the current state with the frame.
    sink.applyFrame({
      dataJson:
        '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"hello","thinking_content":"thought"}}',
    });
    expect(log).toHaveLength(1);
    const applyResult = log[0]!(initialWebuiStreamState);
    expect(applyResult.messages[0]).toEqual({
      id: "m1",
      answer: "hello",
      thinking: "thought",
    });
    expect(applyResult.phase).toBe("streaming");
    log.length = 0;

    // `setPhase` must update phase without touching the rest.
    sink.setPhase("reconnecting");
    expect(log).toHaveLength(1);
    const phaseResult = log[0]!({
      ...initialWebuiStreamState,
      messages: applyResult.messages,
    });
    expect(phaseResult.phase).toBe("reconnecting");
    expect(phaseResult.messages).toEqual(applyResult.messages);
    log.length = 0;

    // `setMessages` must replace messages without touching phase.
    sink.setMessages([{ id: "loaded", answer: "from server", thinking: "" }]);
    expect(log).toHaveLength(1);
    const messagesResult = log[0]!({
      ...initialWebuiStreamState,
      phase: "streaming",
    });
    expect(messagesResult.messages).toEqual([
      { id: "loaded", answer: "from server", thinking: "" },
    ]);
    expect(messagesResult.phase).toBe("streaming");
    log.length = 0;

    // `refuse` must write phase: "refused" AND the refusal string —
    // the test asserts both fields so a binding that forgot to set
    // `phase` (or to write the refusal string) fails one of them.
    sink.refuse("connection closed");
    expect(log).toHaveLength(1);
    const refuseResult = log[0]!({
      ...initialWebuiStreamState,
      phase: "streaming",
    });
    expect(refuseResult.phase).toBe("refused");
    expect(refuseResult.refusal).toBe("connection closed");
  });

  it("drives the actual loop with the production sink binding", async () => {
    // End-to-end evidence: a single submit run, with the production
    // binding helper, drives the same React state a real composer
    // would. We then assert the final state matches what the brief
    // expects for each of the three reachable outcomes (resumed,
    // refused, resynced). A misbinding inside the helper would fail
    // one of these assertions.
    const buildState = () => {
      const log: Reducer[] = [];
      let state = initialWebuiStreamState;
      const setStream = (update: Reducer): void => {
        log.push(update);
        state = update(state);
      };
      return { setStream, getState: () => state, log };
    };

    // Outcome 1 — resumed after a mid-stream drop.
    {
      const { setStream, getState } = buildState();
      const sink = buildWebuiStreamLoopSink(setStream);
      const sendMessage: WebuiClientMessageSender = vi.fn(
        async (_req, onFrame) => {
          onFrame({
            dataJson:
              '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
            cursor: "c1",
          });
          throw new Error("WS dropped");
        },
      );
      const resumeSession: WebuiClientSessionResumer = vi.fn(
        async (_req, onFrame) => {
          onFrame({ dataJson: "[DONE]" });
        },
      );
      await loopWithProjection(
        { sendMessage, resumeSession },
        { sessionId: "s", message: "hi" },
        sink,
      );
      const final = getState();
      expect(final.phase).toBe("done");
      expect(final.messages[0]?.id).toBe("m1");
      // The cursor captured before the drop is preserved in state —
      // it's the only stable resumption point the loop has, so it
      // must not be wiped just because the resumed stream did not
      // emit a fresh cursor on `[DONE]`.
      expect(final.cursor).toBe("c1");
    }

    // Outcome 2 — refused without a cursor (no resume possible).
    {
      const { setStream, getState } = buildState();
      const sink = buildWebuiStreamLoopSink(setStream);
      const sendMessage: WebuiClientMessageSender = vi.fn(
        async (_req, _onFrame) => {
          throw new Error("WS dropped before any frame");
        },
      );
      await loopWithProjection(
        { sendMessage, resumeSession: undefined },
        { sessionId: "s", message: "hi" },
        sink,
      );
      const final = getState();
      expect(final.phase).toBe("refused");
      expect(final.refusal).toBe("WS dropped before any frame");
    }

    // Outcome 3 — resynced after a resume_overflow mid-flight.
    {
      const { setStream, getState } = buildState();
      const sink = buildWebuiStreamLoopSink(setStream);
      const sendMessage: WebuiClientMessageSender = vi.fn(
        async (_req, onFrame) => {
          onFrame({
            dataJson:
              '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"stale"}}',
            cursor: "c-stale",
          });
          onFrame({ dataJson: '{"type":"resume_overflow"}' });
          onFrame({ dataJson: "[DONE]" });
        },
      );
      const resumeSession: WebuiClientSessionResumer = vi.fn(
        async (req, onFrame) => {
          // The fresh subscription starts with no cursor.
          expect(req.afterCursor).toBeUndefined();
          onFrame({ dataJson: "[DONE]" });
        },
      );
      const loadMessages: WebuiClientMessageLoader = vi.fn(async () => ({
        messages: [],
        hasMore: false,
      }));
      await loopWithProjection(
        { sendMessage, resumeSession, loadMessages, projection: streamRecoveryProjection },
        { sessionId: "s", message: "hi" },
        sink,
      );
      const final = getState();
      // Phase flipped to `reconnecting` mid-run, then back through
      // `done` after the resumed stream emitted `[DONE]`. The reload
      // replaced the transcript with the server's authoritative
      // history (empty in this fixture); the stale `m1` from the
      // first subscription is no longer in state. The reducer does
      // not clear `resumeRequired` on `[DONE]` — it is a sticky flag
      // that the shell uses to decide whether to reload again — so the
      // value stays `true` until the next `resume_overflow`-bearing
      // subscription resolves it.
      expect(final.phase).toBe("done");
      expect(final.messages).toEqual([]);
      expect(final.resumeRequired).toBe(true);
    }
  });
});

// Coverage of the production app-to-helper seam. The earlier binding
// tests exercised `buildWebuiStreamLoopSink` and the loop that uses
// it; they did not exercise the React composer's submit handler at
// `components/SessionComposer.tsx:723-788` (the seam where the component
// assembles its
// handlers and hands them to `submitWebuiComposerTurn`). The new
// shape: `submitWebuiComposerTurn` is the extracted form-submit body
// that the React component calls once per submit, and
// `buildWebuiComposerHandlers` is the extracted assembly the
// component calls to bundle its setters. Tests drive both directly.
//
// Boundary: the component's single call into
// `buildWebuiComposerHandlers({ setStream, ... })` is verified by
// inspection only — no DOM environment exists, and source-text
// assertions are not part of this project's policy. The helpers
// themselves are covered by the tests below; the loop's reaction to
// the bundled handlers is covered by the default-path test.
describe("WebUI composer app-to-helper seam", () => {
  type Reducer = (current: WebuiStreamState) => WebuiStreamState;
  function makeRecording(): {
    setStream: (update: Reducer) => void;
    getState: () => WebuiStreamState;
  } {
    let state = initialWebuiStreamState;
    const setStream = (update: Reducer): void => {
      state = update(state);
    };
    return { setStream, getState: () => state };
  }

  it("creates a home-session goal and patches an existing goal through the goal RPCs", async () => {
    const nextGoal = (sessionId: string, objective: string): WebuiGoal => ({
      goalId: "goal-1",
      sessionId,
      objective,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: null,
      statusReason: null,
    });
    const createGoal = vi.fn(async (request: { sessionId: string; objective: string }) =>
      nextGoal(request.sessionId, request.objective),
    );
    const createSession = vi.fn(async () => ({ sessionId: "new-session" }));
    const onSessionCreated = vi.fn();
    await submitWebuiGoal(
      {
        objective: "  ship the feature  ",
        createGoal,
        createSession,
        createSessionWorkspaceDir: "/workspace",
        teamModeOff: true,
      },
      onSessionCreated,
    );
    expect(createSession).toHaveBeenCalledWith({
      name: "main",
      workspaceDir: "/workspace",
      teamModeOff: true,
    });
    expect(createGoal).toHaveBeenCalledWith({
      sessionId: "new-session",
      objective: "ship the feature",
    });
    expect(onSessionCreated).toHaveBeenCalledWith("new-session");

    // The mock takes the real request type: `objective` is optional on
    // `WebuiGoalPatchRequest` (a patch may carry only a status or a budget),
    // so a mock demanding a `string` was narrower than the contract it stands
    // in for. The objective still comes from the request, as before.
    const patchGoal = vi.fn(async (request: WebuiGoalPatchRequest) =>
      nextGoal(request.sessionId, request.objective ?? ""),
    );
    const currentGoal = nextGoal("existing-session", "old");
    await submitWebuiGoal({
      sessionId: "existing-session",
      objective: "new objective",
      currentGoal,
      createGoal,
      patchGoal,
    });
    expect(patchGoal).toHaveBeenCalledWith({
      sessionId: "existing-session",
      objective: "new objective",
    });
  });

  it("buildWebuiComposerHandlers passes every field through unchanged", () => {
    // R13: the handler assembly is a named unit. A regression that
    // drops `setStream`, swaps it for `setSending`, or ignores any
    // other field is caught here. The component's single call into
    // the helper is verified by inspection only — no DOM exists —
    // but the helper itself is fully covered.
    const setStream = vi.fn();
    const setSending = vi.fn();
    const onDraftChange = vi.fn();
    const onNeedsSession = vi.fn();
    const handlers = buildWebuiComposerHandlers({
      setStream,
      setSending,
      onDraftChange,
      onNeedsSession,
    });
    // Every field is the same function reference. A regression that
    // returned a no-op sink, swapped `setStream` with `setSending`,
    // or omitted any field dies here.
    expect(handlers.setStream).toBe(setStream);
    expect(handlers.setSending).toBe(setSending);
    expect(handlers.onDraftChange).toBe(onDraftChange);
    expect(handlers.onNeedsSession).toBe(onNeedsSession);
  });

  it("drives the production helper seam end-to-end", async () => {
    // R11: the production path. `submitWebuiComposerTurn` calls
    // `buildWebuiStreamLoopSink(handlers.setStream)` unconditionally
    // and passes it to the loop. If a regression replaces the helper
    // with an empty object, passes a no-op state setter, or ignores
    // the returned sink, the live reducer never sees the frames and
    // `messages` stays empty. This is the observable that fails when
    // the seam is bypassed end-to-end.
    const { setStream, getState } = makeRecording();
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"hello"}}',
        });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await submitWebuiComposerTurn(
      { sessionId: "s", draft: "hi", sending: false, deps: { sendMessage } },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
      }),
    );
    const final = getState();
    // The live reducer accumulated the message and reached `done`.
    // A regression that bypasses the helper, swaps the state
    // setter for a no-op, or returns a sink that never reaches the
    // loop leaves `messages` empty.
    expect(final.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(final.phase).toBe("done");
  });

  it("creates the first task silently and sends the original draft", async () => {
    const { setStream, getState } = makeRecording();
    const createSession = vi.fn(async (request) => ({
      sessionId: request.workspaceDir === "/work/minimax-code" ? "created" : undefined,
    }));
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (request, onFrame) => {
        expect(request).toEqual({ id: "created", content: "start working" });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const onSessionCreated = vi.fn();

    await submitWebuiComposerTurn(
      {
        draft: "start working",
        sending: false,
        deps: { sendMessage },
        createSession,
        createSessionWorkspaceDir: "/work/minimax-code",
        teamModeOff: true,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
        onSessionCreated,
      }),
    );

    expect(createSession).toHaveBeenCalledWith({
      name: "main",
      workspaceDir: "/work/minimax-code",
      teamModeOff: true,
    });
    expect(onSessionCreated).toHaveBeenCalledWith("created");
    expect(getState().phase).toBe("done");
  });

  it("enters the session view before the first turn streams", async () => {
    // Reported bug: the first message rendered under the welcome hero on the
    // new-task page and only switched into the session after the reply
    // finished. The switch must happen between createSession and sendMessage.
    const { setStream, getState } = makeRecording();
    const events: string[] = [];
    const createSession = vi.fn(async () => {
      events.push("create");
      return { sessionId: "created" };
    });
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_request, onFrame) => {
      events.push("send");
      onFrame({ dataJson: "[DONE]" });
    });
    const onSessionCreated = vi.fn(() => {
      events.push("session-created");
    });

    await submitWebuiComposerTurn(
      {
        draft: "hi",
        sending: false,
        deps: { sendMessage },
        createSession,
        createSessionWorkspaceDir: "/work/minimax-code",
        teamModeOff: false,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
        onSessionCreated,
      }),
    );

    expect(events).toEqual(["create", "session-created", "send"]);
    expect(onSessionCreated).toHaveBeenCalledWith("created");
    expect(getState().phase).toBe("done");
  });

  it("sends the first message when no workspace folder is selected", async () => {
    // Reported bug: with the folder pill unset ("选择文件夹") the send was
    // swallowed silently — no session, no feedback. The harness resolves a
    // default workspace, so an absent workspaceDir must flow through.
    const { setStream, getState } = makeRecording();
    const requests: unknown[] = [];
    const createSession = vi.fn(async (request) => {
      requests.push(request);
      return { sessionId: "created" };
    });
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_request, onFrame) => {
      onFrame({ dataJson: "[DONE]" });
    });
    const onSessionCreated = vi.fn();

    await submitWebuiComposerTurn(
      {
        draft: "你好",
        sending: false,
        deps: { sendMessage },
        createSession,
        // No createSessionWorkspaceDir — the folder pill is unset.
        teamModeOff: false,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
        onSessionCreated,
      }),
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      { name: "main", workspaceDir: undefined, teamModeOff: false },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledWith("created");
    expect(getState().phase).toBe("done");
  });

  it("keeps rejecting relative or empty workspaceDir while allowing the field to be absent", () => {
    expect(createSessionOperation.validate({ name: "main" }).ok).toBe(true);
    expect(
      createSessionOperation.validate({ name: "main", workspaceDir: "  " }).ok,
    ).toBe(false);
    expect(
      createSessionOperation.validate({ name: "main", workspaceDir: "relative" })
        .ok,
    ).toBe(false);
    expect(
      createSessionOperation.validate({ name: "" }).ok,
    ).toBe(false);
  });

  it("recognises absolute workspace paths on both platforms and rejects bare names", () => {
    // A browser can only report a bare folder name for a picked project, so
    // this predicate is what keeps one out of a createSession request.
    expect(looksLikeAbsoluteWorkspacePath("/home/you/project")).toBe(true);
    expect(looksLikeAbsoluteWorkspacePath("C:\\Users\\you\\project")).toBe(true);
    expect(looksLikeAbsoluteWorkspacePath("\\\\server\\share\\project")).toBe(
      true,
    );
    expect(looksLikeAbsoluteWorkspacePath("my-project")).toBe(false);
    expect(looksLikeAbsoluteWorkspacePath("./my-project")).toBe(false);
    expect(looksLikeAbsoluteWorkspacePath("")).toBe(false);
  });

  it("refuses a relative workspace folder before it can reach createSession", async () => {
    // Reported bug: 选择新项目 fed the bare directory name the browser picker
    // returns, and the turn died on the server's
    // `workspaceDir must be an absolute path`. The submit path now fails with
    // a message that names the cause, without calling createSession.
    const { setStream, getState } = makeRecording();
    const createSession = vi.fn(async () => ({ sessionId: "created" }));
    const sendMessage: WebuiClientMessageSender = vi.fn(async () => undefined);

    await submitWebuiComposerTurn(
      {
        draft: "hi",
        sending: false,
        deps: { sendMessage },
        createSession,
        createSessionWorkspaceDir: "my-project",
        teamModeOff: false,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
      }),
    );

    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getState().refusal).toContain("绝对路径");
  });

  it("passes an absolute workspace folder straight through to createSession", async () => {
    const { setStream, getState } = makeRecording();
    const requests: unknown[] = [];
    const createSession = vi.fn(async (request) => {
      requests.push(request);
      return { sessionId: "created" };
    });
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_request, onFrame) => {
      onFrame({ dataJson: "[DONE]" });
    });

    await submitWebuiComposerTurn(
      {
        draft: "hi",
        sending: false,
        deps: { sendMessage },
        createSession,
        createSessionWorkspaceDir: "/work/minimax-code",
        teamModeOff: false,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
      }),
    );

    expect(requests).toEqual([
      { name: "main", workspaceDir: "/work/minimax-code", teamModeOff: false },
    ]);
    expect(getState().phase).toBe("done");
  });

  it("offers a manual absolute-path field when the transport cannot browse directories", () => {
    // The old picker resolved to "" on any engine without File.path, and the
    // caller dropped that falsy value — clicking 选择新项目 did nothing at all.
    // Without browseWorkspaceDirs the popover must show a usable field.
    const markup = renderToStaticMarkup(
      createElement(WebuiWorkspaceDirectoryBrowser, {
        onSelect: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain("项目绝对路径");
    expect(markup).toContain("使用此目录");
  });

  it("migrates the in-flight home turn into the created session and leaves home clean", async () => {
    // Reported bug: after 新建任务 the welcome hero replayed the previous
    // turn's messages. The turn state must follow the session switch and the
    // home key must come back initial.
    const homeKey = "__webui-home__";
    updateSessionRuntimeState(homeKey, (current) => ({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
      sending: true,
    }));

    migrateSessionRuntimeState(homeKey, "session-1");

    expect(readSessionRuntimeState(homeKey)).toEqual({
      stream: initialWebuiStreamState,
      sending: false,
    });
    expect(readSessionRuntimeState("session-1")).toEqual({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
      sending: true,
    });

    // Cleanup: never leak runtime state across tests (the store is a
    // module-level singleton).
    migrateSessionRuntimeState("session-1", homeKey);
    updateSessionRuntimeState(homeKey, () => ({
      stream: initialWebuiStreamState,
      sending: false,
    }));
  });

  it("queues a second composer submission while the current turn is running", async () => {
    const { setStream, getState } = makeRecording();
    const enqueueMessage: WebuiClientMessageEnqueuer = vi.fn(async () => ({
      itemId: "queue-1",
      status: "queued",
      position: 1,
    }));
    const onDraftChange = vi.fn();
    const onQueued = vi.fn();
    await submitWebuiComposerTurn(
      {
        sessionId: "s",
        draft: "second turn",
        sending: true,
        deps: {},
        enqueueMessage,
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange,
        onQueued,
      }),
    );
    expect(enqueueMessage).toHaveBeenCalledWith({
      id: "s",
      content: "second turn",
    });
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(onQueued).toHaveBeenCalledOnce();
    expect(getState().phase).toBe("idle");
  });
});

// R12 — sink failure must change the outcome. The previous commit
// implemented `safeSink` as a defensive try/catch that did nothing
// with the failure; the reviewer reproduced a case where `applyFrame`
// threw and the loop still committed `phase: "done"`. The fixed
// `safeSink` records the first failure, disables further callbacks,
// blocks the normal `done` commit, and surfaces the failure through a
// direct `sink.refuse` call (with a `console.error` fallback when
// every callback is broken). These tests pin that contract.
describe("WebUI composer sink-failure semantics", () => {
  it("skips the normal done commit when applyFrame throws and emits a refusal", async () => {
    // Reproduction from the reviewer's edge-case script: `applyFrame`
    // throws, the stream continues to emit `[DONE]`, and the loop
    // would previously commit `phase: "done"` with no refusal. The
    // fixed loop records the failure, blocks the done commit, and
    // calls `sink.refuse` with a reason that names the failing
    // callback.
    const events: string[] = [];
    const sink = {
      applyFrame: () => {
        events.push("applyFrame");
        throw new Error("applyFrame blew up");
      },
      setPhase: (phase: string) => {
        events.push(`phase:${phase}`);
      },
      setMessages: (messages: readonly unknown[]) => {
        events.push(`messages:${messages.length}`);
      },
      refuse: (reason: string) => {
        events.push(`refuse:${reason}`);
      },
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: '{"type":10}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await loopWithProjection(
      { sendMessage },
      { sessionId: "s", message: "hi" },
      sink,
    );
    // The normal `done` commit must not appear; the loop recorded a
    // failure instead and surfaced a refusal naming the failing
    // callback.
    expect(events).not.toContain("phase:done");
    expect(
      events.some(
        (event) => event.startsWith("refuse:") && event.includes("applyFrame"),
      ),
    ).toBe(true);
  });

  it("falls back to console.error when every callback is broken", async () => {
    // The extreme case: a sink that throws from every callback.
    // The refusal attempt itself throws, so the loop falls back to
    // `console.error` rather than losing the diagnostic. The promise
    // still resolves — the never-reject contract is preserved.
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const sink = {
        applyFrame: () => {
          throw new Error("applyFrame broken");
        },
        setPhase: () => {
          throw new Error("setPhase broken");
        },
        setMessages: () => {
          throw new Error("setMessages broken");
        },
        refuse: () => {
          throw new Error("refuse broken");
        },
      };
      const sendMessage: WebuiClientMessageSender = vi.fn(
        async (_req, onFrame) => {
          onFrame({ dataJson: '{"type":10}' });
          onFrame({ dataJson: "[DONE]" });
        },
      );
      await expect(
        loopWithProjection(
          { sendMessage },
          { sessionId: "s", message: "hi" },
          sink,
        ),
      ).resolves.toBeUndefined();
      // The fallback diagnostic path ran at least once.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("routes the no-cursor-during-drop early return through the finalization helper", async () => {
    // R14 site: sendMessage rejects before any cursor was observed;
    // the loop's send-error branch used to return after the wrapped
    // refuse recorded the failure, never finalising it. The reviewer
    // reproduced this with a sink that only fails the raw refuse; the
    // loop resolved with no refusal and no console diagnostic. With
    // `finalizeOnExit`, the early-return path now calls the raw
    // refuse through `guarded.reportSinkFailure`; that call also
    // throws here, so the fallback `console.error` runs and the
    // promise still resolves. The original buggy code resolved
    // without either observable.
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const sink = {
        applyFrame: () => undefined,
        setPhase: (phase: string) => {
          // setPhase works; only refuse throws.
        },
        setMessages: () => undefined,
        refuse: () => {
          throw new Error("refuse broken");
        },
      };
      const sendMessage: WebuiClientMessageSender = vi.fn(async () => {
        throw new Error("dropped before any frame");
      });
      await loopWithProjection(
        { sendMessage },
        { sessionId: "s", message: "hi" },
        sink,
      );
      // The fallback diagnostic path ran. The buggy behaviour was
      // no observable at all (no refuse event, no console.error).
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("routes the loadMessages-rejection early return through the finalization helper", async () => {
    // R14 site: the resume_overflow path runs `loadMessages`, which
    // rejects; the early-return inside that try/catch used to skip
    // the failure report. With `finalizeOnExit`, the rejection
    // reason is finalised through `sink.refuse` before returning.
    // The reproduction mirrors the reviewer's
    // "load-rejects-with-sink-throws" scenario in a recoverable
    // form: a sink that records the failure but still accepts the
    // raw refuse.
    const events: string[] = [];
    const sink = {
      applyFrame: () => undefined,
      setPhase: (phase: string) => {
        events.push(`phase:${phase}`);
      },
      setMessages: () => undefined,
      refuse: (reason: string) => {
        events.push(`refuse:${reason}`);
      },
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: '{"type":"resume_overflow"}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const loadMessages = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    await loopWithProjection(
      { sendMessage, loadMessages, resumeSession: vi.fn(), projection: streamRecoveryProjection },
      { sessionId: "s", message: "hi" },
      sink,
    );
    expect(events).toContain("phase:reconnecting");
    expect(
      events.some(
        (event) =>
          event.startsWith("refuse:") && event.includes("history unavailable"),
      ),
    ).toBe(true);
  });

  it("routes the missing-resumeSession early return through the finalization helper", async () => {
    // R14 site: the resync branch with no `resumeSession` available.
    // The events observed end with a refuse call naming the missing
    // transport.
    const events: string[] = [];
    const sink = {
      applyFrame: () => undefined,
      setPhase: (phase: string) => {
        events.push(`phase:${phase}`);
      },
      setMessages: () => undefined,
      refuse: (reason: string) => {
        events.push(`refuse:${reason}`);
      },
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: '{"type":"resume_overflow"}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await loopWithProjection(
      // No resumeSession; no loadMessages.
      { sendMessage },
      { sessionId: "s", message: "hi" },
      sink,
    );
    expect(
      events.some(
        (event) =>
          event.startsWith("refuse:") &&
          event.includes("resumeSession transport is unavailable"),
      ),
    ).toBe(true);
  });

  it("routes the missing-resumeSession-during-resume early return through the finalization helper", async () => {
    // R14 site: the resume branch finds no `resumeSession`. We
    // arrange for the loop to enter the resume branch with a cursor
    // by emitting a cursor-bearing chunk first, then letting
    // `sendMessage` reject. The loop schedules `resume`, schedules
    // a session id, and the next iteration tries to resume — but
    // `resumeSession` is undefined, so the early-return fires.
    //
    // Concretely: a `sendMessage` mock that emits a chunk frame
    // with a cursor, then throws. The loop observes the cursor
    // (`c1`), schedules `nextAction = "resume"`, and the next
    // iteration enters the resume branch with `!resumeSession`.
    const events: string[] = [];
    const sink = {
      applyFrame: () => undefined,
      setPhase: (phase: string) => {
        events.push(`phase:${phase}`);
      },
      setMessages: () => undefined,
      refuse: (reason: string) => {
        events.push(`refuse:${reason}`);
      },
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({
          dataJson:
            '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
          cursor: "c1",
        });
        throw new Error("dropped mid-stream");
      },
    );
    await loopWithProjection(
      // No resumeSession — the resume branch refuses.
      { sendMessage },
      { sessionId: "s", message: "hi" },
      sink,
    );
    expect(
      events.some(
        (event) =>
          event.startsWith("refuse:") &&
          event.includes("resumeSession transport is unavailable"),
      ),
    ).toBe(true);
  });

  it("routes the missing-sendMessage early return through the finalization helper", async () => {
    // R14 site: the very first iteration finds `sendMessage` is
    // missing and refuses with the documented reason.
    const events: string[] = [];
    const sink = {
      applyFrame: () => undefined,
      setPhase: (phase: string) => {
        events.push(`phase:${phase}`);
      },
      setMessages: () => undefined,
      refuse: (reason: string) => {
        events.push(`refuse:${reason}`);
      },
    };
    await loopWithProjection(
      // No sendMessage at all.
      {},
      { sessionId: "s", message: "hi" },
      sink,
    );
    expect(
      events.some(
        (event) =>
          event.startsWith("refuse:") &&
          event.includes("sendMessage transport is unavailable"),
      ),
    ).toBe(true);
  });
});

// R16 — when the loop ends in `refused` because a sink callback failed
// after the reducer had already accepted frames, the rendered
// transcript may be incomplete. The state field `transcriptIncomplete`
// is set as part of the failure transition; the shell renders an
// additional user-visible message alongside the refusal. The
// `applyFrame`-throw case after some frames flips the flag; the
// applyFrame-throw-before-any-frame case does not.
describe("WebUI composer transcriptIncomplete", () => {
  it("sets transcriptIncomplete when a sink failure happens after frames were accepted", async () => {
    let state = initialWebuiStreamState;
    const setStream = (
      update: (current: WebuiStreamState) => WebuiStreamState,
    ): void => {
      state = update(state);
    };
    // The third frame is delivered by the transport, but the sink's
    // applyFrame throws before the reducer sees it. We wire a sink
    // whose third call blows up; the loop must record the failure,
    // refuse with `transcriptIncomplete: true`, and leave the
    // previously accepted frames in state.
    let applyCount = 0;
    const sink: WebuiStreamLoopSink = {
      applyFrame: (frame) => {
        applyCount += 1;
        if (applyCount >= 3) throw new Error("third applyFrame blew up");
        setStream((current) => reduceWebuiStreamFrame(current, frame));
      },
      setPhase: (phase) => setStream((current) => ({ ...current, phase })),
      setMessages: (messages) =>
        setStream((current) => ({ ...current, messages })),
      refuse: (reason, options) =>
        setStream((current) => ({
          ...current,
          phase: "refused",
          refusal: reason,
          transcriptIncomplete: options?.transcriptIncomplete ?? false,
        })),
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"first answer"}}',
        });
        onFrame({
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"m2","msg_content":"partial"}}',
        });
        onFrame({
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"m3","msg_content":"never rendered"}}',
        });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await loopWithProjection(
      { sendMessage },
      { sessionId: "s", message: "hi" },
      sink,
    );
    // The failure landed in refuse; the loop did not commit `done`;
    // and `transcriptIncomplete` is set because the reducer had
    // accepted frames before the failure.
    expect(state.phase).toBe("refused");
    expect(state.transcriptIncomplete).toBe(true);
    // The user-visible transcript still contains the frames that
    // arrived before the failure — the reducer accumulated them
    // before the third `applyFrame` threw. The third frame did not
    // reach the reducer, so it is not in the list.
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("does not set transcriptIncomplete when the failure happens before any frame", async () => {
    let state = initialWebuiStreamState;
    const setStream = (
      update: (current: WebuiStreamState) => WebuiStreamState,
    ): void => {
      state = update(state);
    };
    // A sink whose applyFrame throws on the very first call. The
    // reducer never accepted a frame; `transcriptIncomplete` must
    // stay false (there is nothing incomplete to flag).
    let applyCount = 0;
    const sink: WebuiStreamLoopSink = {
      applyFrame: () => {
        applyCount += 1;
        throw new Error("applyFrame blew up before any frame");
      },
      setPhase: (phase) => setStream((current) => ({ ...current, phase })),
      setMessages: (messages) =>
        setStream((current) => ({ ...current, messages })),
      refuse: (reason, options) =>
        setStream((current) => ({
          ...current,
          phase: "refused",
          refusal: reason,
          transcriptIncomplete: options?.transcriptIncomplete ?? false,
        })),
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: '{"type":10}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await loopWithProjection(
      { sendMessage },
      { sessionId: "s", message: "hi" },
      sink,
    );
    expect(state.phase).toBe("refused");
    expect(state.transcriptIncomplete).toBe(false);
    expect(state.messages).toEqual([]);
    expect(applyCount).toBe(1);
  });

  it("does not render the incomplete-state paragraph unless transcriptIncomplete is set", () => {
    // The composer renders a paragraph with
    // `data-webui-transcript-incomplete="true"` only when the flag
    // is true. We render the foundation app with no transcript state
    // and assert the paragraph is absent — the state-side tests
    // above pin the flag's truthiness; this guards the markup side.
    const html = renderToStaticMarkup(
      createElement(WebuiClientFoundationApp, {
        label: "webui-foundation",
        transport: { sendMessage: () => Promise.resolve() },
      }),
    );
    expect(html).not.toContain("data-webui-transcript-incomplete");
  });

  it("carries the in-flight user line and turn clock in the live state", async () => {
    let state: WebuiStreamState = initialWebuiStreamState;
    const setStream = (
      value:
        | WebuiStreamState
        | ((current: WebuiStreamState) => WebuiStreamState),
    ) => {
      state = typeof value === "function" ? value(state) : value;
    };
    const getState = () => state;
    const sendMessage: WebuiClientMessageSender = vi.fn(
      async (_req, onFrame) => {
        onFrame({ dataJson: "[DONE]" });
      },
    );
    await submitWebuiComposerTurn(
      {
        sessionId: "s",
        draft: "你好",
        sending: false,
        deps: { sendMessage },
      },
      buildWebuiComposerHandlers({
        setStream,
        setSending: () => undefined,
        onDraftChange: () => undefined,
      }),
    );
    const final = getState();
    // The turn clock drives 已执行 N 秒 / the thinking seconds counter; the
    // user's line comes from the replayed `msg-user-*` frame instead of a
    // second pending renderer — covered by the next test, which feeds that
    // frame and reads `role`.
    //
    // This assertion used to be `expect(final.pendingUser).toBeUndefined()`.
    // `pendingUser` no longer exists anywhere in `src/`, so that read could
    // never fail and pinned nothing. Deleted rather than cast away; the test
    // keeps the real `processingStartedAtMs` assertion below it.
    expect(typeof final.processingStartedAtMs).toBe("number");
  });

  it("tags the server's replayed user frame with role=user", () => {
    let state = reduceWebuiStreamFrame(initialWebuiStreamState, {
      dataJson:
        '{"type":2,"agent_message":{"msg_id":"msg-user-v1-abc","msg_content":"帮我画一只鹈鹕"}}',
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");

    state = reduceWebuiStreamFrame(state, {
      dataJson:
        '{"type":2,"agent_message":{"msg_id":"m-assistant","msg_content":"好的"}}',
    });
    expect(state.messages[1]?.role).toBeUndefined();
  });

  it("merges adjacent assistant messages into one transcript block", () => {
    // The server splits one reply across several msg_ids (one per tool
    // round), each with its own thinking — desktop renders the turn as a
    // single disclosure, so adjacent non-user groups collapse into one and
    // the render aggregates their facets.
    const groups = groupWebuiTranscriptItems([
      ...projectWebuiMessage({ msgId: "u1", role: "user", msgContent: "做" }),
      ...projectWebuiMessage({
        msgId: "a1",
        thinkingContent: "第一段",
        toolCalls: [{ name: "read" }],
        msgContent: "中间",
      }),
      ...projectWebuiMessage({
        msgId: "a2",
        thinkingContent: "第二段",
        toolCalls: [{ name: "write" }],
        msgContent: "结尾",
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items[0]?.kind).toBe("user");
    expect(groups[1]?.items.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "thinking",
      "assistant",
      "tool",
    ]);

    const html = renderToStaticMarkup(
      createElement(WebuiSessionTranscript, {
        sessionId: "merge-session",
        loadMessages: async () => ({
          messages: [
            { msgId: "u1", role: "user", msgContent: "做" },
            {
              msgId: "a1",
              thinkingContent: "第一段",
              toolCalls: [{ name: "read" }],
              msgContent: "中间",
            },
            {
              msgId: "a2",
              thinkingContent: "第二段",
              toolCalls: [{ name: "write" }],
              msgContent: "结尾",
            },
          ],
          hasMore: false,
        }),
      }),
    );
    // Effect-gated load: SSR never runs effects, so assert the grouping
    // contract above and the single-block markup via the group renderer.
    expect(html).toContain('data-webui-transcript="merge-session"');
  });

  it("enriches a matched historical group view from every group item", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionTranscript, {
        sessionId: "group-enrichment-session",
        loadMessages: async () => ({ messages: [], hasMore: false }),
        initialMessages: {
          messages: [
            {
              msgId: "group-user",
              role: "user",
              msgContent: "Please inspect these files",
              source: "thread-goal",
              timestamp: 1_700_000_000_000,
              actions: { edit: true },
            },
            {
              msgId: "assistant-first",
              turnId: "assistant-group-turn",
              thinkingContent: "First reasoning segment",
              thinkingDurationMs: 1_500,
              toolCalls: [{ name: "read" }],
              msgContent: "First answer",
              attachments: [
                {
                  id: "attachment-first",
                  type: "file",
                  file_name: "group-output.txt",
                  preview_url: "/tmp/group-output.txt",
                },
              ],
              fileChanges: [
                { file: "stale.ts", additions: 1, deletions: 0 },
              ],
              usage: { request_duration_ms: 2_000, output_tokens: 20 },
            },
            {
              msgId: "assistant-second",
              turnId: "assistant-group-turn",
              thinkingContent: "Second reasoning segment",
              thinkingDurationMs: 2_500,
              toolCalls: [{ name: "search" }],
              msgContent: "Second answer",
              actions: { fork: true },
              fileChanges: [
                { file: "latest.ts", additions: 3, deletions: 1 },
              ],
              usage: { request_duration_ms: 3_000, output_tokens: 70 },
            },
          ],
          hasMore: false,
        },
      }),
    );

    expect(html).toContain("Please inspect these files");
    expect(html).toContain('data-webui-goal-message="true"');
    expect(html).toContain('data-testid="user-message-edit-button"');
    expect(html).toContain('data-message-timestamp="1700000000000"');
    expect(html.match(/class="webui-turn-process-segment"/g)).toHaveLength(2);
    expect(html).toContain("First reasoning segment");
    expect(html).toContain("Second reasoning segment");
    expect(html).toContain(">1s<");
    expect(html).toContain(">2s<");
    expect(html).toContain('data-webui-tool-call="read"');
    expect(html).toContain('data-webui-tool-call="search"');
    expect(html).toContain("First answer");
    expect(html).toContain("Second answer");
    expect(html).toContain("group-output.txt");
    expect(html).toContain('data-testid="message-fork-button"');
    expect(html).toContain('data-file-path="latest.ts"');
    expect(html).not.toContain('data-file-path="stale.ts"');
    expect(html).toContain("18 token/s");
  });

  it("renders the desktop thinking block: history and live forms", () => {
    const history = renderToStaticMarkup(
      createElement(WebuiThinkingBlock, {
        text: "推理过程",
        durationMs: 5000,
      }),
    );
    expect(history).toContain("已完成推理");
    expect(history).toContain(">5s<");
    expect(history).not.toContain("webui-thinking-indicator");

    const live = renderToStaticMarkup(
      createElement(WebuiThinkingBlock, {
        text: "推理过程",
        streaming: true,
        processingStartedAtMs: Date.now() - 5000,
      }),
    );
    expect(live).toContain("推理中...");
    expect(live).toContain('data-testid="streaming-rose-loader"');
    expect(live).not.toContain("webui-thinking-indicator");
    expect(live).toContain(">5s<");
  });

  it("ticks the turn clock as the desktop 已执行 N 秒 row", () => {
    const html = renderToStaticMarkup(
      createElement(TurnElapsedRow, {
        startedAtMs: Date.now() - 5000,
        running: true,
      }),
    );
    expect(html).toContain("已执行 5 秒");
    expect(
      renderToStaticMarkup(
        createElement(TurnElapsedRow, {
          startedAtMs: Date.now(),
          running: true,
        }),
      ),
    ).toBe("");
  });

  it("renders desktop's edited-files card for edit tools", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiToolResults, {
        tools: [
          {
            tool_call_name: "edit_file",
            tool_call_args: JSON.stringify({ file_path: "src/app.ts" }),
            tool_call_result_data:
              "--- a/src/app.ts\n+++ b/src/app.ts\n+one\n+two\n-zero\n",
          },
          { tool_call_name: "read", tool_call_args: "README.md" },
        ],
      }),
    );
    expect(html).toContain("webui-diff-card");
    expect(html).toContain("已编辑 1 个文件");
    expect(html).toContain("+2");
    expect(html).toContain("-1");
    expect(html).toContain("app.ts");

    const noEdits = renderToStaticMarkup(
      createElement(WebuiToolResults, {
        tools: [{ tool_call_name: "read", tool_call_args: "README.md" }],
      }),
    );
    expect(noEdits).not.toContain("webui-diff-card");
    expect(noEdits).toContain("webui-tool-list");
  });

  it("renders the desktop questionnaire card copy and layout", () => {
    const questionnaire: WebuiQuestionnaireRequest = {
      // The wire shape the runtime sends: current schema, and the default
      // presentation for an ordinary questionnaire. `showProgress` and
      // `allowBackNavigation` are only read when there is more than one step,
      // and this card has exactly one, so the progress block stays unrendered
      // either way — the copy assertions below are unaffected.
      schemaVersion: 2,
      presentation: {
        replaceComposer: true,
        showProgress: true,
        allowBackNavigation: true,
      },
      id: "q1",
      steps: [
        {
          id: "st1",
          question: "怎么部署？",
          selectionMode: 0,
          required: false,
          allowOther: true,
          // Read only when `selectedOther` is true. Deliberately a non-empty
          // string distinct from 自定义回答... so the assertion below is
          // discriminating: a card that wrongly took the `selectedOther`
          // branch would render this text and fail, rather than rendering the
          // same fallback the code falls back to.
          otherPlaceholder: "Describe it",
          options: [
            { id: "a", label: "选项一" },
            { id: "b", label: "选项二" },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, {
        sessionId: "s1",
        permissions: [],
        questionnaire,
        onPermission: vi.fn(async () => undefined),
        onQuestionnaire: vi.fn(async () => undefined),
        onDismiss: vi.fn(async () => undefined),
        interactionError: undefined,
      }),
    );
    expect(html).toContain("智能体需要你的回答");
    expect(html).toContain("webui-questionnaire-letter");
    expect(html).toContain("怎么部署？");
    expect(html).toContain("提交");
    expect(html).toContain("跳过");
    expect(html).toContain("自定义回答...");
    expect(html).toContain("data-webui-dismiss-questionnaire");
  });
});

/**
 * A `resumeSession` that stays open until the test lets it finish. Frames
 * and the promise's resolution are separate: a real socket delivers a frame
 * and then the iterable ends, so a test that only delivers `[DONE]` without
 * ending the stream would wait forever.
 */
function parkedResume() {
  const handle: {
    deliver?: (frame: WebuiStreamFrame) => void;
    finish?: () => void;
  } = {};
  const resumer: WebuiClientSessionResumer = vi.fn(
    async (_req, onFrame) =>
      new Promise<void>((resolve) => {
        handle.deliver = onFrame;
        handle.finish = () => {
          resolve();
        };
      }),
  );
  return { resumer, handle };
}

/**
 * The lease is the only thing standing between an ordinary turn and two
 * streams writing the same state — chunks would append twice and the resume
 * cursor would follow whichever stream reported last. These tests pin the
 * claim/release discipline so deleting either call turns the suite red.
 */
describe("WebUI stream loop · subscription lease discipline", () => {
  it("claims as local-send before the first frame of a locally sent turn", async () => {
    const order: string[] = [];
    const sink: WebuiStreamLoopSink = {
      applyFrame: () => {
        order.push("frame");
      },
      setPhase: (phase) => {
        order.push(`phase:${phase}`);
      },
      setMessages: () => undefined,
      claimSubscription: (owner) => {
        order.push(`claim:${owner}`);
        // `claimSubscription` returns the claimed generation, or `undefined`
        // when the caller does not model one. These sinks only record the
        // order, so `undefined` is the honest return and
        // `runWebuiStreamLoop` tolerates it.
        return undefined;
      },
      releaseSubscription: () => {
        order.push("release");
      },
      refuse: () => undefined,
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "m1", msg_content: "hi" } }) });
      onFrame({ dataJson: "[DONE]" });
    });
    await loopWithProjection({ sendMessage }, { sessionId: "lease-1", message: "hello" }, sink);

    expect(order.indexOf("claim:local-send")).toBeGreaterThanOrEqual(0);
    // The claim has to land before the turn's first frame reaches the
    // reducer, otherwise a `session.start` racing the stream finds no lease.
    expect(order.indexOf("claim:local-send")).toBeLessThan(order.indexOf("frame"));
    // Release before the terminal phase is committed, so a `session.start`
    // that lands right after cannot find a lease for the finished turn.
    expect(order.indexOf("release")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("release")).toBeLessThan(order.indexOf("phase:done"));
  });

  it("claims as recovered with the turn id when attaching to a server-started turn", async () => {
    const claims: { owner: string; turnId?: string }[] = [];
    let released = 0;
    const sink: WebuiStreamLoopSink = {
      applyFrame: () => undefined,
      setPhase: () => undefined,
      setMessages: () => undefined,
      claimSubscription: (owner, turnId) => {
        claims.push({ owner, ...(turnId ? { turnId } : {}) });
        // This sink records the claim rather than holding a lease, so it has
        // no generation to hand back — `undefined` is the real return type.
        return undefined;
      },
      releaseSubscription: () => {
        released += 1;
      },
      refuse: () => undefined,
    };
    const resumeSession = vi.fn(async () => undefined);
    // No `message`: the loop attaches to a turn it did not start.
    await loopWithProjection({ resumeSession }, { sessionId: "lease-2", attachTurnId: "turn-9" }, sink);

    expect(claims).toEqual([{ owner: "recovered", turnId: "turn-9" }]);
    expect(released).toBe(1);
  });

  it("anchors an attachment with history so the runtime replays the turn", async () => {
    // Mocked against the real `WebuiClientSessionResumer`, so `mock.calls[0]`
    // is a two-element tuple. A zero-arg mock typed the call as `[]` and made
    // the assertion below unreachable at the type level even though the loop
    // really does pass the request.
    const resumeSession = vi.fn<WebuiClientSessionResumer>(
      async () => undefined,
    );
    const loadMessages = vi.fn(async () => ({
      messages: [
        { msgId: "history-1", role: "user", msgContent: "earlier", timestamp: 1_700_000_000_001 },
        { msgId: "history-2", role: "assistant", msgContent: "earlier answer", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
    }));
    await loopWithProjection(
      { resumeSession, loadMessages, projection: streamRecoveryProjection },
      { sessionId: "lease-3", attachTurnId: "turn-10" },
      {
        applyFrame: () => undefined,
        setPhase: () => undefined,
        setMessages: () => undefined,
        setStreamExtra: () => undefined,
        claimSubscription: () => undefined,
        releaseSubscription: () => undefined,
        refuse: () => undefined,
      },
    );
    // An unanchored resume makes the runtime skip every frame the turn
    // produced before we subscribed, so the turn would render empty.
    expect(resumeSession.mock.calls[0]?.[0]).toEqual({
      id: "lease-3",
      afterMsgId: "history-2",
    });
  });

  it("releases the lease when the send fails without a cursor", async () => {
    let released = 0;
    const sendMessage: WebuiClientMessageSender = vi.fn(async () => {
      throw new Error("dropped before any frame");
    });
    await loopWithProjection(
      { sendMessage },
      { sessionId: "lease-4", message: "hello" },
      {
        applyFrame: () => undefined,
        setPhase: () => undefined,
        setMessages: () => undefined,
        claimSubscription: () => undefined,
        releaseSubscription: () => {
          released += 1;
        },
        refuse: () => undefined,
      },
    );
    // A refusal is a terminal exit: leaving the lease behind would make every
    // later `session.start` resolve to a `recheck` forever.
    expect(released).toBe(1);
  });

  it("seeds the live turn state from history when attaching", async () => {
    let state = initialWebuiStreamState;
    const setStream = (update: (current: WebuiStreamState) => WebuiStreamState): void => {
      state = update(state);
    };
    const loadMessages = vi.fn(async () => ({
      messages: [
        { msgId: "history-1", role: "user", msgContent: "earlier", timestamp: 1_700_000_000_001 },
        {
          msgId: "history-2",
          role: "assistant",
          msgContent: "earlier answer",
          timestamp: 1_700_000_000_002,
          contextUsage: { used: 1234, total: 100_000 },
        },
      ],
      hasMore: false,
    }));
    // Park the stream so the state can be read while the turn is still live.
    const parked = parkedResume();
    const run = loopWithProjection(
      { resumeSession: parked.resumer, loadMessages, projection: streamRecoveryProjection },
      { sessionId: "lease-5", attachTurnId: "turn-11" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && state.processingStartedAtMs === undefined; tick += 1)
      await Promise.resolve();
    // The live elapsed counter and the context meter both read from these
    // fields. An attachment that opened a stream without seeding them
    // renders a live turn with no timer and no context reading, which is
    // indistinguishable from the frozen UI this fix exists to remove.
    // The clock starts at the *user* message, not the last message — that
    // is the moment the turn began.
    expect(state.phase).toBe("streaming");
    expect(state.contextUsage).toEqual({ used: 1234, total: 100_000 });
    expect(state.processingStartedAtMs).toBe(1_700_000_000_001);
    parked.handle.deliver?.({ dataJson: "[DONE]" });
    parked.handle.finish?.();
    await run;
  });
});

/**
 * A stream the server never cancels stays open on its own. When a probe
 * retargets us onto a different turn, the old loop keeps receiving frames and
 * its `[DONE]` still arrives — so authority over the store cannot come from
 * "do I hold the lease" alone. It comes from the generation stamped at claim
 * time: a loop that has been superseded writes nothing.
 */
describe("WebUI stream loop · superseded loop fencing", () => {
  const buildSharedStore = () => {
    let state = initialWebuiStreamState;
    const setStream = (update: (current: WebuiStreamState) => WebuiStreamState): void => {
      state = update(state);
    };
    return { setStream, getState: () => state };
  };


  it("drops a superseded loop's frames, phase and terminal frame", async () => {
    const { setStream, getState } = buildSharedStore();
    const old = parkedResume();
    // The old loop parks here and never comes back on its own.
    loopWithProjection(
      {
        resumeSession: old.resumer,
        loadMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      },
      { sessionId: "fence-1", attachTurnId: "turn-old" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && old.handle.deliver === undefined; tick += 1)
      await Promise.resolve();

    // A second loop claims the same session while the first is still parked.
    const fresh = parkedResume();
    const newRun = loopWithProjection(
      { resumeSession: fresh.resumer },
      { sessionId: "fence-1", attachTurnId: "turn-new" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && fresh.handle.deliver === undefined; tick += 1)
      await Promise.resolve();
    expect(getState().subscription?.turnId).toBe("turn-new");
    const stateAfterNewClaim = getState();

    // The old stream was never cancelled server-side, so its late chunk, its
    // phase write and its `[DONE]` all still arrive.
    old.handle.deliver?.({
      dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "m-old", msg_content: "stale" } }),
    });
    old.handle.deliver?.({ dataJson: "[DONE]" });
    old.handle.finish?.();
    await Promise.resolve();
    expect(getState()).toEqual(stateAfterNewClaim);
    // And the newer loop's lease is still the live one.
    expect(getState().subscription?.turnId).toBe("turn-new");

    fresh.handle.deliver?.({ dataJson: "[DONE]" });
    fresh.handle.finish?.();
    await newRun;
    expect(getState().subscription).toBeUndefined();
  });

  it("keeps a superseded loop fenced after the newer lease is released", async () => {
    const { setStream, getState } = buildSharedStore();
    const old = parkedResume();
    loopWithProjection(
      {
        resumeSession: old.resumer,
        loadMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      },
      { sessionId: "fence-6", attachTurnId: "turn-old" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && old.handle.deliver === undefined; tick += 1)
      await Promise.resolve();

    const fresh = parkedResume();
    const newRun = loopWithProjection(
      { resumeSession: fresh.resumer },
      { sessionId: "fence-6", attachTurnId: "turn-new" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && fresh.handle.deliver === undefined; tick += 1)
      await Promise.resolve();
    fresh.handle.deliver?.({ dataJson: "[DONE]" });
    fresh.handle.finish?.();
    await newRun;
    // The newer turn is over and the lease is gone. Fencing that compared
    // against the live lease would now readmit the superseded loop, and its
    // late frames would land in a session that had already moved on.
    expect(getState().subscription).toBeUndefined();
    const settled = getState();

    old.handle.deliver?.({
      dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "m-old", msg_content: "stale" } }),
    });
    old.handle.deliver?.({ dataJson: "[DONE]" });
    old.handle.finish?.();
    await Promise.resolve();
    expect(getState()).toEqual(settled);
  });

  it("resolves rather than rejects when the attach claim throws", async () => {
    // The claim sits at the top of the loop; a throw there used to escape
    // the promise and break the never-reject contract callers depend on.
    const resolveSession = vi.fn(async () => undefined);
    await expect(
      loopWithProjection(
        { resumeSession: resolveSession, loadMessages: vi.fn(async () => ({ messages: [], hasMore: false })), projection: streamRecoveryProjection },
        { sessionId: "fence-7", attachTurnId: "turn-13" },
        {
          applyFrame: () => undefined,
          setPhase: () => undefined,
          setMessages: () => undefined,
          claimSubscription: () => {
            throw new Error("claim exploded");
          },
          refuse: () => undefined,
        },
      ),
    ).resolves.toBeUndefined();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("releases the lease even when an earlier sink callback threw", async () => {
    let released = 0;
    // `safeSink` disables its wrapped callbacks after the first failure, so
    // a release routed through the wrapper would silently become a no-op —
    // leaving the session stuck in "thinking" with no owner to release it.
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: "[DONE]" });
    });
    await loopWithProjection(
      { sendMessage },
      { sessionId: "fence-2", message: "hello" },
      {
        applyFrame: () => {
          throw new Error("renderer exploded");
        },
        setPhase: () => undefined,
        setMessages: () => undefined,
        claimSubscription: () => undefined,
        releaseSubscription: () => {
          released += 1;
        },
        refuse: () => undefined,
      },
    );
    expect(released).toBe(1);
  });

  it("keeps writing after its own [DONE] released the lease mid-loop", async () => {
    // A `[DONE]` frame releases the lease, but a `resume_overflow` seen in
    // the same batch still owes a resync. Fencing on "do I hold the lease"
    // would drop that resync and leave the stale transcript on screen.
    const { setStream, getState } = buildSharedStore();
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame({
        dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "m1", msg_content: "stale" } }),
      });
      onFrame({ dataJson: '{"type":"resume_overflow"}' });
      onFrame({ dataJson: "[DONE]" });
    });
    const loadMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: "[DONE]" });
    });
    await loopWithProjection(
      { sendMessage, resumeSession, loadMessages, projection: streamRecoveryProjection },
      { sessionId: "fence-3", message: "hello" },
      buildWebuiStreamLoopSink(setStream),
    );
    expect(loadMessages).toHaveBeenCalled();
    expect(getState().messages).toEqual([]);
    expect(getState().phase).toBe("done");
  });

  it("keeps a superseded loop's refusal off the turn that replaced it", async () => {
    // Refusal is a write to the same shared state as every frame, so it
    // carries the same fence. A loop that was replaced must not stamp the
    // new turn's phase as `refused` with the old turn's reason.
    const { setStream, getState } = buildSharedStore();
    let failOldLoop: (() => void) | undefined;
    const oldResume: WebuiClientSessionResumer = vi.fn(
      async (_req, _onFrame) =>
        new Promise<void>((_resolve, reject) => {
          failOldLoop = () => {
            reject(new Error("old stream died"));
          };
        }),
    );
    loopWithProjection(
      {
        resumeSession: oldResume,
        loadMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      },
      { sessionId: "fence-8", attachTurnId: "turn-old" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && failOldLoop === undefined; tick += 1)
      await Promise.resolve();

    const fresh = parkedResume();
    const newRun = loopWithProjection(
      { resumeSession: fresh.resumer },
      { sessionId: "fence-8", attachTurnId: "turn-new" },
      buildWebuiStreamLoopSink(setStream),
    );
    for (let tick = 0; tick < 8 && fresh.handle.deliver === undefined; tick += 1)
      await Promise.resolve();
    expect(getState().subscription?.turnId).toBe("turn-new");
    const claimed = getState();

    // The superseded loop's transport now fails, and its refusal must not
    // land on the turn that replaced it.
    failOldLoop?.();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    expect(getState()).toEqual(claimed);
    expect(getState().phase).not.toBe("refused");

    fresh.handle.deliver?.({ dataJson: "[DONE]" });
    fresh.handle.finish?.();
    await newRun;
  });

  it("reports the generation it claimed so callers can check ownership", async () => {
    const { setStream, getState } = buildSharedStore();
    const generation = await loopWithProjection(
      { sendMessage: vi.fn(async () => undefined) },
      { sessionId: "fence-9", message: "hello" },
      buildWebuiStreamLoopSink(setStream),
    );
    expect(generation).toBeTypeOf("number");
    expect(ownsWebuiStreamGeneration(getState(), generation)).toBe(true);

    // A stop releases the lease and takes ownership away with it, so the
    // stopped loop's queued frames can no longer pass the fence.
    const stopped = settleAbortedStream(getState());
    expect(ownsWebuiStreamGeneration(stopped, generation)).toBe(false);
    expect(stopped.subscription).toBeUndefined();
    expect(stopped.phase).toBe("done");
    expect(stopped.status).toBe("aborted");
  });

  it("stops the turn and drops the lease when there is no abort event to do it", async () => {
    let state: WebuiStreamState = {
      ...initialWebuiStreamState,
      phase: "streaming",
      subscription: { owner: "recovered", turnId: "turn-12", generation: 7 },
    };
    const setStream = (update: (current: WebuiStreamState) => WebuiStreamState): void => {
      state = update(state);
    };
    const setSending = vi.fn();
    // The runtime reports the session as not running and sends no
    // `session.abort`, so the stop button is the only thing that can
    // release the lease.
    const abortSession = vi.fn(async () => ({ success: true }));
    await stopWebuiTurn({ abortSession, sessionId: "fence-4", setSending, setStream });
    expect(abortSession).toHaveBeenCalledWith({ id: "fence-4" });
    expect(setSending).toHaveBeenCalledWith(false);
    expect(state.subscription).toBeUndefined();
    expect(state.phase).toBe("done");
    expect(state.status).toBe("aborted");
  });

  it("reports a refused stop instead of settling a turn that is still running", async () => {
    const setStream = vi.fn();
    const setSending = vi.fn();
    await expect(
      stopWebuiTurn({
        abortSession: vi.fn(async () => ({ success: false })),
        sessionId: "fence-5",
        setSending,
        setStream,
      }),
    ).rejects.toThrow("The running turn could not be stopped");
    expect(setStream).not.toHaveBeenCalled();
  });
});
