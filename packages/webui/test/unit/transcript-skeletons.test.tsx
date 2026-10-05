// Unit tests for the Phase-6 TranscriptSkeletons transcription.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatSkeleton,
  GreetingSkeleton,
  SKELETON_CONTENT_MAX_WIDTH_PX,
} from "../../src/client/components/TranscriptSkeletons.js";
import { WebuiActivityGroup, WebuiThinkingBlock, WebuiTurnProcess } from "../../src/client/components/TranscriptPrimitives.js";
import { WebuiAssistantBody } from "../../src/client/components/AssistantBody.js";
import { WebuiMarkdown } from "../../src/client/markdown.js";

function countByClass(html: string, className: string): number {
  const re = new RegExp(`class="[^"]*\\b${className}\\b`, "g");
  return html.match(re)?.length ?? 0;
}

describe("TranscriptSkeletons", () => {
  it("ChatSkeleton emits the desktop testid and the centred column", () => {
    const html = renderToStaticMarkup(createElement(ChatSkeleton));
    expect(html).toContain('data-testid="chat-skeleton"');
    // The column width comes from the shared constant rather than a literal,
    // so it can be asserted against `.message-list`'s max-width elsewhere and
    // cannot drift back to a hard-coded value.
    expect(html).toContain(`max-width:${SKELETON_CONTENT_MAX_WIDTH_PX}px`);
    expect(html).toContain("mx-auto");
    expect(html).toContain("animate-shimmer");
  });

  it("ChatSkeleton uses the desktop line widths (8 primary + 4 secondary)", () => {
    const html = renderToStaticMarkup(createElement(ChatSkeleton));
    // Eight 22px bars in the primary block, four 24px bars in the secondary
    // block (Desktop `i` array has 8 entries, `l` array has 4).
    expect(countByClass(html, "animate-shimmer")).toBe(13);
    expect((html.match(/height:22px/g) ?? []).length).toBe(8);
    expect((html.match(/height:24px/g) ?? []).length).toBe(4);
  });

  it("GreetingSkeleton uses the rounded-40 avatar instead of the user bubble", () => {
    const html = renderToStaticMarkup(createElement(GreetingSkeleton));
    expect(html).toContain('data-testid="greeting-skeleton"');
    // The column width comes from the shared constant rather than a literal,
    // so it can be asserted against `.message-list`'s max-width elsewhere and
    // cannot drift back to a hard-coded value.
    expect(html).toContain(`max-width:${SKELETON_CONTENT_MAX_WIDTH_PX}px`);
    expect(html).toContain("mx-auto");
    // The avatar uses `border-radius:9999px` (full circle). React serialises
    // numeric pixels with units.
    expect(html).toContain("border-radius:9999px");
  });

  it("Both skeletons apply the gradient mask to the secondary block", () => {
    const chat = renderToStaticMarkup(createElement(ChatSkeleton));
    const greeting = renderToStaticMarkup(createElement(GreetingSkeleton));
    for (const html of [chat, greeting]) {
      expect(html).toContain("mask-image:linear-gradient(180deg");
      expect(html).toContain("transparent 100%)");
    }
  });
});

describe("Agent activity disclosure", () => {
  it("keeps completed thinking collapsed by default and opens only while streaming", () => {
    const completed = renderToStaticMarkup(createElement(WebuiThinkingBlock, { text: "Completed reasoning" }));
    const live = renderToStaticMarkup(createElement(WebuiThinkingBlock, { text: "Current reasoning", streaming: true }));
    expect(completed).toContain("Completed reasoning");
    expect(completed).not.toContain('<details class="webui-thinking-block" data-webui-thinking-block="true" open=""');
    expect(live).toContain('<details class="webui-thinking-block" data-webui-thinking-block="true" open=""');
  });

  it("keeps the final answer visible when the process disclosure is collapsed", () => {
    const html = renderToStaticMarkup(createElement(WebuiTurnProcess, {
      active: false,
      initiallyExpanded: false,
      children: (expanded) => <>{expanded ? <span>Tool activity</span> : null}<p data-testid="persistent-final-answer">Final answer</p></>,
    }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="turn-process-detail"');
    expect(html).toContain("Final answer");
    expect(html).not.toContain("Tool activity");
  });

  it("preserves source order for interleaved answer text and tools while activity is expanded", () => {
    const html = renderToStaticMarkup(createElement(WebuiAssistantBody, {
      messageId: "interleaved",
      answers: ["before tool", "after tool"],
      processInitiallyExpanded: true,
      processSegments: [{ messageId: "interleaved", activityParts: [
        { type: "text", text: "before tool" },
        { type: "tool", tool: { name: "read_file", status: "done", input: "README.md" } },
        { type: "text", text: "after tool" },
      ] }],
    }));
    const before = html.indexOf("before tool");
    const tool = html.indexOf("读取文件");
    const after = html.indexOf("after tool");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(tool);
    expect((html.match(/before tool/g) ?? []).length).toBe(1);
    expect((html.match(/after tool/g) ?? []).length).toBe(1);
  });

  it("keeps the final answer beside activity without a whole-turn disclosure", () => {
    const html = renderToStaticMarkup(createElement(WebuiAssistantBody, {
      messageId: "collapsed-interleaved",
      answers: ["before tool", "final answer"],
      processInitiallyExpanded: false,
      processSegments: [{ messageId: "collapsed-interleaved", activityParts: [
        { type: "text", text: "before tool" },
        { type: "tool", tool: { name: "read_file", status: "done", input: "README.md" } },
        { type: "text", text: "final answer" },
      ] }],
    }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("final answer");
    expect(html).toContain('data-testid="turn-process-detail" hidden=""');
    expect((html.match(/final answer/g) ?? []).length).toBe(1);
  });

  it("renders all Desktop activity row kinds in their projected order", () => {
    const html = renderToStaticMarkup(createElement(WebuiAssistantBody, {
      messageId: "activity-view",
      answers: [],
      processInitiallyExpanded: true,
      getTurnDiff: async () => ({ fileChanges: [] }),
      revertTurnDiff: async () => ({ success: true }),
      reapplyTurnDiff: async () => ({ success: true }),
      processSegments: [{
        messageId: "activity-view",
        activityParts: [
          { type: "thinking", text: "Thinking text" },
          { type: "cognitive", text: "Cognitive text" },
          { type: "compaction", text: "Context summary" },
          { type: "delegation", message: { fromAgent: "main", toAgent: "reviewer", content: "Review request" } },
          { type: "agent_joined", agent: { agentName: "reviewer", title: "Review implementation", sessionId: "child-session" } },
          { type: "agent_joined", agent: { agentName: "tester", title: "Run focused checks", sessionId: "child-session-2" } },
          { type: "tool", tool: { name: "bash", status: "done", input: "pwd" } },
          { type: "tool", tool: { name: "bash", status: "done", input: "git status" } },
        ],
      }],
    }));
    const rowOrder = [
      html.indexOf("Thinking text"), html.indexOf("Cognitive text"),
      html.indexOf("Context summary"), html.indexOf("main 发给 reviewer"),
      html.indexOf("分配任务"), html.indexOf("Review implementation"), html.indexOf("终端"),
    ];
    expect(rowOrder.every((position) => position >= 0)).toBe(true);
    expect(rowOrder).toEqual([...rowOrder].sort((a, b) => a - b));
    expect(html).toContain('data-webui-agent-activity="delegation"');
    expect(html).toContain('data-webui-agent-activity="agent-joined-group"');
    expect(html).toContain('data-testid="agent-task-list"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-webui-agent-task-session="child-session"');
    expect(html).toContain('data-webui-agent-task-session="child-session-2"');
    expect(html).not.toContain('role="button" tabindex="0"');
    expect(html).toContain("执行 2 条命令");
    expect((html.match(/data-testid="activity-group"/gu) ?? []).length).toBe(1);
  });

  it("combines a message's thinking and file tools into one Desktop activity summary", () => {
    const tools = Array.from({ length: 5 }, (_, index) => ({
      id: `read-${index}`,
      name: "read_file",
      status: "done",
      input: `file-${index}.ts`,
    }));
    const activityItems = [
      { type: "thinking" as const, text: "Reasoning details", durationMs: 1_000 },
      ...tools.map((tool) => ({ type: "tool" as const, tool })),
    ];
    const html = renderToStaticMarkup(createElement(WebuiAssistantBody, {
      messageId: "thinking-and-files",
      answers: [],
      processInitiallyExpanded: true,
      processSegments: [{
        messageId: "thinking-and-files",
        activityParts: activityItems,
      }],
    }));
    expect(html).toContain("思考 1 次，查看 5 个文件");
    expect(html).not.toContain("已完成推理 1s");
    expect((html.match(/data-testid="activity-group"/gu) ?? []).length).toBe(1);
    expect((html.match(/data-webui-tool-call="read_file"/gu) ?? []).length).toBe(5);
    expect(html).toContain("Reasoning details");

    const expanded = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools,
      activityItems,
      initiallyExpanded: true,
    }));
    expect(expanded).toContain('class="activity-group" data-testid="activity-group" open=""');
    expect(expanded).toContain("思考 1 次，查看 5 个文件");
    expect((expanded.match(/data-webui-tool-call="read_file"/gu) ?? []).length).toBe(5);
    for (let index = 0; index < 5; index += 1) {
      expect(expanded).toContain(`file-${index}.ts`);
    }
    expect((expanded.match(/class="webui-tool-resource-path"/gu) ?? []).length).toBe(5);
    expect((expanded.match(/class="webui-tool-chevron"/gu) ?? []).length).toBe(0);
    expect(expanded).toContain("Reasoning details");
  });

  it("keeps thinking standalone when its message has no tool calls", () => {
    const html = renderToStaticMarkup(createElement(WebuiAssistantBody, {
      messageId: "thinking-only",
      answers: [],
      processInitiallyExpanded: true,
      processSegments: [{
        messageId: "thinking-only",
        activityParts: [{ type: "thinking", text: "Reasoning without tools" }],
      }],
    }));
    expect(html).toContain("思考 1 次");
    expect(html).not.toContain("已完成推理");
    expect(html).toContain("Reasoning without tools");
    expect(html).not.toContain('data-testid="activity-group"');
    expect(html).toContain('class="webui-thinking-block" data-webui-thinking-block="true" open=""');
  });

  it("renders workspace paths in list items as linked file references", () => {
    const html = renderToStaticMarkup(createElement(WebuiMarkdown, {
      source: "- `src/components/Map View.tsx`",
      workspaceDir: "/workspace",
      onOpenFile: () => undefined,
    }));
    expect(html).toContain('class="webui-message-file-link"');
    expect(html).toContain('data-webui-file-reference="src/components/Map View.tsx"');
    expect(html).toContain("Map View.tsx");
  });

  it("shows an absolute read-file path as its basename without a row chevron", () => {
    const fullPath = "/home/user/workspace/brief-m3-batch-D-composer-state-and-submit.md";
    const html = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ name: "read_file", status: "done", input: { file_path: fullPath } }],
      initiallyExpanded: true,
    }));
    expect(html).toContain(`<span class="webui-tool-resource-path" title="${fullPath}">brief-m3-batch-D-composer-state-and-submit.md</span>`);
    expect(html).not.toContain("已完成");
    expect(html).not.toContain('class="webui-tool-chevron"');
  });

  it("extracts a Windows read-file basename while retaining the full path title", () => {
    const fullPath = "C:\\Users\\reviewer\\brief-m3-batch-D-composer-state-and-submit.md";
    const html = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ name: "read_file", status: "done", input: { file_path: fullPath } }],
      initiallyExpanded: true,
    }));
    expect(html).toContain(`title="${fullPath}"`);
    expect(html).toContain(">brief-m3-batch-D-composer-state-and-submit.md</span>");
    expect(html).not.toContain('class="webui-tool-chevron"');
  });

  it("keeps a running tool expanded and labels its actual state", () => {
    const html = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ id: "tc-running", name: "bash", tool_call_status: 1, input: "pwd" }],
    }));
    expect(html).toContain('data-testid="activity-group"');
    expect(html).toContain("open=\"\"");
    expect(html).toContain('data-webui-tool-status="running"');
    expect(html).toContain("运行中");
  });

  it("treats Desktop Preparing and Prepared statuses as pending active work", () => {
    for (const status of [4, 5]) {
      const html = renderToStaticMarkup(createElement(WebuiActivityGroup, {
        tools: [{ name: "bash", tool_call_status: status }],
      }));
      expect(html).toContain('data-active="true"');
      expect(html).toContain('data-webui-tool-status="pending"');
      expect(html).toContain('open=""');
    }
  });

  it("shows the representative category glyph in a folded group and combine for mixed tools", () => {
    const command = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ name: "bash", status: "done" }, { name: "terminal", status: "done" }],
    }));
    const mixed = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ name: "bash", status: "done" }, { name: "read_file", status: "done" }],
    }));
    expect(command).toContain('data-webui-activity-icon-category="command"');
    expect(command).not.toContain('data-active="true"');
    expect(mixed).toContain('data-webui-activity-icon-category="combine"');
  });

  it("renders tool input, result, and error as distinct Desktop detail sections", () => {
    const html = renderToStaticMarkup(createElement(WebuiActivityGroup, {
      tools: [{ name: "bash", status: "error", input: "false", result: "exit code 1", error: "command failed" }],
    }));
    expect(html).toContain("输入");
    expect(html).toContain("false");
    expect(html).toContain("结果");
    expect(html).toContain("exit code 1");
    expect(html).toContain("错误");
    expect(html).toContain("command failed");
  });

  it("keeps completed, failed, and interrupted outcomes distinct", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      ...[
        { id: "done", name: "read", status: "done", result: "file contents" },
        { id: "failed", name: "bash", status: "failed", error: "exit 1" },
        { id: "stopped", name: "bash", status: "interrupted" },
      ].map((tool) => createElement(WebuiActivityGroup, {
        key: tool.id,
        tools: [tool],
      })),
    ));
    expect(html).toContain('data-webui-tool-status="completed"');
    expect(html).toContain('data-webui-tool-status="error"');
    expect(html).toContain("失败");
    expect(html).toContain('data-webui-tool-status="cancelled"');
    expect(html).toContain("exit 1");
    expect(html).toContain("已取消");
    expect(html).not.toContain('data-active="true"');
  });
});
