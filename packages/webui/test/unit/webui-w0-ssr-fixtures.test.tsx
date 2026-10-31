// Safety net — SSR markup fixtures for components with no SSR assertions.
//
// Scope: the exported components that no existing test renders at all. These had
// zero SSR assertions anywhere in the suite, while the others already have them
// (mostly in `webui-shell.test.ts` and `webui-round3-acceptance.test.tsx`).
// Duplicating the covered ones would add noise, not evidence, so this file fills
// exactly the gap. Shell-level session switching is already asserted in
// `webui-shell.test.ts` and is deliberately not repeated here.
//
// The assertions are structural — `data-testid`, `aria-*`, `role`, and the
// presence of the copy the component renders — not whole-HTML equality. A whole
// string snapshot would fail on every unrelated whitespace change and would
// fossilise the current output, including its bugs.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WebuiFeedbackActions,
  WebuiMessageActionButton,
} from "../../src/client/features/transcript/ui/MessageActions.js";
import { LeftRail } from "../../src/client/features/sessions/ui/LeftRail.js";
import { WebuiQuestionnaireResponse } from "../../src/client/features/transcript/ui/QuestionnaireResponse.js";
import {
  mergeOlderTranscriptPage,
  type WebuiOwnedTranscriptState,
} from "../../src/client/conversation/transcript-request-ownership.js";
import {
  WebuiActivityGroup,
  WebuiTurnProcess,
} from "../../src/client/features/transcript/ui/TranscriptPrimitives.js";

const READ_TOOL = { tool_call_name: "read", tool_call_args: "README.md" };
const EDIT_TOOL = {
  tool_call_name: "edit_file",
  tool_call_args: JSON.stringify({ file_path: "src/app.ts" }),
  tool_call_result_data:
    "--- a/src/app.ts\n+++ b/src/app.ts\n+one\n+two\n-zero\n",
};

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe("W0 · SSR · WebuiActivityGroup", () => {
  it("renders nothing for an empty tool list", () => {
    expect(
      render(createElement(WebuiActivityGroup, { tools: [] })),
    ).toBe("");
  });

  it("renders the disclosure with a non-empty summary", () => {
    const html = render(
      createElement(WebuiActivityGroup, { tools: [READ_TOOL] }),
    );

    expect(html).toContain('data-testid="activity-group"');
    expect(html).toContain("activity-group-summary");
    expect(html).toContain("activity-group-icon");
    expect(html).toContain("activity-group-chevron");
    expect(html).toContain("timeline-spine");
    expect(html).not.toContain('data-streaming="true"');

    const summary = html.match(
      /<span class="activity-group-summary">([^<]*)<\/span>/u,
    );
    expect(summary?.[1]?.length ?? 0).toBeGreaterThan(0);
  });

  it("marks an active tool group and opens it by default", () => {
    const html = render(
      createElement(WebuiActivityGroup, {
        tools: [{ ...READ_TOOL, status: "running" }],
      }),
    );

    expect(html).toContain('data-active="true"');
    expect(html).toContain("open");
  });

  it("routes edit tools into the diff card branch", () => {
    const withEdits = render(
      createElement(WebuiActivityGroup, { tools: [EDIT_TOOL, READ_TOOL] }),
    );
    expect(withEdits).toContain("webui-diff-card");
    expect(withEdits).toContain("已编辑 1 个文件");

    const authoritative = render(
      createElement(WebuiActivityGroup, {
        tools: [EDIT_TOOL, READ_TOOL],
        authoritativeDiffAvailable: true,
      }),
    );
    expect(authoritative).not.toContain("webui-diff-card");
    expect(authoritative).toContain("webui-tool-list");
  });

  it("keeps file-edit children in a mixed thinking activity when turn diff is available", () => {
    const html = render(
      createElement(WebuiActivityGroup, {
        tools: [{ ...EDIT_TOOL, tool_call_name: "write" }],
        activityItems: [
          { type: "thinking", text: "准备修改文件" },
          { type: "tool", tool: { ...EDIT_TOOL, tool_call_name: "write" } },
        ],
        authoritativeDiffAvailable: true,
      }),
    );

    expect(html).toContain("思考 1 次，修改 1 个文件");
    expect(html).toContain('data-webui-tool-call="write"');
  });
});

describe("W0 · SSR · WebuiTurnProcess", () => {
  const child = createElement("span", { "data-testid": "turn-child" }, "detail");

  it("opens the live form and counts seconds while the turn runs", () => {
    const html = render(
      createElement(WebuiTurnProcess, { active: true, children: child }),
    );

    expect(html).toContain('data-testid="turn-process-disclosure"');
    expect(html).toContain('data-testid="turn-process-summary"');
    expect(html).toContain('data-testid="turn-process-summary-text"');
    expect(html).toContain('data-testid="turn-process-separator"');
    expect(html).toContain('data-testid="turn-process-detail"');
    expect(html).toContain('data-summary-text="已执行 0 秒"');
    expect(html).toContain('aria-expanded="true"');
    // The live form never shows the finished-turn output rate.
    expect(html).not.toContain('data-testid="turn-output-rate"');
  });

  it("collapses finished activity rows and derives the output rate", () => {
    const html = render(
      createElement(WebuiTurnProcess, {
        active: false,
        startedAtMs: 1_000,
        endedAtMs: 4_000,
        requestDurationMs: 3_000,
        tokenCount: 300,
        children: child,
      }),
    );

    expect(html).toContain('data-summary-text="共执行 3 秒"');
    expect(html).toContain('data-testid="turn-output-rate"');
    expect(html).toContain(">100 token/s<");
    expect(html).not.toContain("共执行 3 秒 · 100 token/s");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/data-testid="turn-process-detail" hidden=""/u);
  });

  it("falls back to the wall-clock span and then to zero seconds", () => {
    const wallClock = render(
      createElement(WebuiTurnProcess, {
        active: false,
        wallClockDurationMs: 90_000,
        children: child,
      }),
    );
    expect(wallClock).toContain('data-summary-text="共执行 1 分 30 秒"');

    const unknown = render(
      createElement(WebuiTurnProcess, { active: false, children: child }),
    );
    expect(unknown).toContain('data-summary-text="共执行 0 秒"');
  });
});

describe("W0 · SSR · WebuiMessageActionButton", () => {
  const icon = createElement("span", null, "i");

  it("renders the desktop's glyph-only action button", () => {
    const html = render(
      createElement(WebuiMessageActionButton, {
        testId: "w0-action",
        label: "赞",
        icon,
        onClick: () => undefined,
      }),
    );

    expect(html).toContain('data-testid="w0-action"');
    expect(html).toContain('aria-label="赞"');
    expect(html).toContain('title="赞"');
    expect(html).toContain('type="button"');
    expect(html).toContain("webui-icon-button");
    // No selection state is passed, so the toggle must not claim one.
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("webui-message-action-active");
  });

  it("carries the selection and disabled states through", () => {
    const html = render(
      createElement(WebuiMessageActionButton, {
        testId: "w0-action",
        label: "踩",
        icon,
        onClick: () => undefined,
        active: true,
        disabled: true,
      }),
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("webui-message-action-active");
    expect(html).toContain("disabled");
  });
});

describe("W0 · SSR · WebuiFeedbackActions", () => {
  it("renders both toggles unselected by default", () => {
    const html = render(
      createElement(WebuiFeedbackActions, { onChange: () => undefined }),
    );

    expect(html).toContain('data-testid="message-feedback-actions"');
    expect(html).toContain('data-testid="message-feedback-like"');
    expect(html).toContain('data-testid="message-feedback-dislike"');
    expect(html).toContain('data-testid="message-feedback-like-action"');
    expect(html).toContain('data-testid="message-feedback-dislike-action"');
    expect(html.match(/aria-pressed="false"/gu)).toHaveLength(2);
  });

  it("marks the selected side only", () => {
    const liked = render(
      createElement(WebuiFeedbackActions, {
        value: "like",
        onChange: () => undefined,
      }),
    );
    expect(liked.match(/aria-pressed="true"/gu)).toHaveLength(1);
    expect(liked).toContain('aria-label="赞"');

    const disliked = render(
      createElement(WebuiFeedbackActions, {
        value: "dislike",
        onChange: () => undefined,
      }),
    );
    expect(disliked.match(/aria-pressed="true"/gu)).toHaveLength(1);
  });
});

describe("W0 · SSR · WebuiQuestionnaireResponse", () => {
  it("renders only the meta fields the summary actually carries", () => {
    const html = render(
      createElement(WebuiQuestionnaireResponse, {
        messageId: "message-1",
        summary: { requestId: "request-1", answers: [] },
      }),
    );

    expect(html).toContain('data-webui-questionnaire-history="true"');
    expect(html).toContain('data-message-id="message-1"');
    expect(html).toContain('data-webui-questionnaire-request="request-1"');
    expect(html).toContain('data-testid="questionnaire-history-request-1"');
    expect(html).toContain('data-testid="questionnaire-history-label"');
    expect(html).toContain("问卷回答");
    expect(html).toContain('data-testid="questionnaire-history-meta-requestId"');
    // Absent fields must not render their rows at all.
    expect(html).not.toContain("questionnaire-history-meta-schema");
    expect(html).not.toContain("questionnaire-history-meta-submitted");
    expect(html).not.toContain("questionnaire-history-meta-mode");
    expect(html).not.toContain("questionnaire-history-meta-source");
    expect(html).not.toContain("questionnaire-history-meta-feature-key");
    expect(html).not.toContain('data-testid="questionnaire-history-timestamp"');
  });

  it("renders every carried meta field and each answer in order", () => {
    const html = render(
      createElement(WebuiQuestionnaireResponse, {
        messageId: "message-1",
        timestamp: 1_758_000_000_000,
        summary: {
          requestId: "request-1",
          schemaVersion: "2",
          submittedAt: "2026-09-23T00:00:00.000Z",
          mode: "single",
          source: "tool",
          featureKey: "onboarding",
          answers: [
            { question: "选哪个方案？", labels: ["方案 A", "方案 B"] },
            { question: "补充说明", labels: ["无"] },
          ],
        },
      }),
    );

    for (const field of [
      "schema",
      "submitted",
      "mode",
      "source",
      "feature-key",
    ])
      expect(html).toContain(`data-testid="questionnaire-history-meta-${field}"`);

    expect(html).toContain('data-testid="questionnaire-history-answers"');
    expect(html).toContain('data-testid="questionnaire-history-answer-0"');
    expect(html).toContain('data-testid="questionnaire-history-answer-1"');
    expect(html).toContain("选哪个方案？");
    expect(html).toContain("补充说明");
    expect(html).toContain('data-testid="questionnaire-history-answer-0-label-0"');
    expect(html).toContain('data-testid="questionnaire-history-answer-0-label-1"');
    expect(html).toContain("方案 A");
    expect(html).toContain("方案 B");
    expect(html).toContain('data-testid="questionnaire-history-timestamp"');

    // Answer order is the response's order, not a re-sorted one.
    expect(html.indexOf("选哪个方案？")).toBeLessThan(
      html.indexOf("补充说明"),
    );
  });

  it("falls back for a missing request id", () => {
    const html = render(
      createElement(WebuiQuestionnaireResponse, {
        messageId: "message-1",
        summary: { requestId: "", answers: [] },
      }),
    );

    expect(html).toContain("(未提供)");
  });
});

describe("WebUI transcript page merging", () => {
  const page = (ids: readonly string[], cursor?: string) => ({
    messages: ids.map((msgId) => ({ msgId })),
    nextCursor: cursor,
    hasMore: Boolean(cursor),
  });

  const state = (
    ownerSessionId: string,
    generation: number,
    messages: readonly string[],
    loading: boolean,
    error?: string,
  ): WebuiOwnedTranscriptState => ({
    ownerSessionId,
    generation,
    page: page(messages, "cursor-a"),
    loading,
    error,
  });

  it("prepends same-session pages with cursor and collapse-view progression", () => {
    const current = state("A", 1, ["newer"], false);
    const currentPage = {
      ...current,
      page: {
        ...current.page,
        queryCollapseViews: [
          { queryKey: "shared", currentTurnId: "new-turn", processingStartedAtMs: 2 },
          { queryKey: "new", currentTurnId: "new-turn", processingStartedAtMs: 3 },
        ],
      },
    };
    const result = mergeOlderTranscriptPage(currentPage, {
      messages: [{ msgId: "older" }],
      queryCollapseViews: [
        { queryKey: "shared", currentTurnId: "old-turn", processingStartedAtMs: 1 },
        { queryKey: "old", currentTurnId: "old-turn", processingStartedAtMs: 0 },
      ],
      nextCursor: "cursor-older",
      hasMore: true,
    }, "cursor-a");

    expect(result.error).toBeUndefined();
    expect(result.state.page.messages?.map(({ msgId }) => msgId)).toEqual([
      "older",
      "newer",
    ]);
    expect(result.state.page.nextCursor).toBe("cursor-older");
    expect(result.state.page.queryCollapseViews).toEqual([
      { queryKey: "shared", currentTurnId: "old-turn", processingStartedAtMs: 1 },
      { queryKey: "new", currentTurnId: "new-turn", processingStartedAtMs: 3 },
      { queryKey: "old", currentTurnId: "old-turn", processingStartedAtMs: 0 },
    ]);
  });

  it("keeps the session's context snapshot while merging an older page in", () => {
    // The snapshot says how much of the context window the SESSION has spent,
    // and the composer's ring is drawn from it. An older page carries no
    // snapshot of its own, so a merge that rebuilt the page from the older
    // half alone took the reading away from every reader of the page — the
    // ring went blank the moment the user scrolled up.
    const base = state("A", 1, ["newer"], false);
    const current: WebuiOwnedTranscriptState = {
      ...base,
      page: {
        ...base.page,
        contextSnapshot: {
          status: "live",
          usage: { total_tokens: 1200, context_window: 20000 },
        },
      },
    };
    const result = mergeOlderTranscriptPage(current, {
      messages: [{ msgId: "older" }],
      nextCursor: "cursor-older",
      hasMore: true,
    }, "cursor-a");

    expect(result.state.page.contextSnapshot).toEqual({
      status: "live",
      usage: { total_tokens: 1200, context_window: 20000 },
    });
  });

  it("keeps the no-progress error and disables further pagination", () => {
    const current = state("A", 1, ["newer"], true);
    const result = mergeOlderTranscriptPage(current, {
      messages: [],
      nextCursor: "cursor-a",
      hasMore: true,
    }, "cursor-a");

    expect(result.error).toBe("没有找到更早的消息，请刷新会话后重试。");
    expect(result.state.page.messages?.map(({ msgId }) => msgId)).toEqual([
      "newer",
    ]);
    expect(result.state.page.hasMore).toBe(false);
    expect(result.state.page.nextCursor).toBeUndefined();
  });
});

describe("W0 · SSR · LeftRail", () => {
  // The frame's whole contract: the landmark and the `contents` display, with
  // the rail's own markup passed through. It used to carry a second body that
  // rendered only when no children were passed, and the one call site always
  // passes them.
  const markup = renderToStaticMarkup(
    createElement(LeftRail, null, createElement("span", { "data-testid": "rail-child" })),
  );

  it("renders the rail landmark around its children", () => {
    expect(markup).toContain('data-webui-component="left-rail"');
    expect(markup).toContain('data-testid="rail-child"');
  });

  it("contributes no layout of its own", () => {
    // `contents` is what lets the shell's own aside be the rail's box; a
    // wrapper that generated a box would change the rail's geometry.
    expect(markup).toContain('class="contents"');
    expect(markup).not.toContain("webui-button-primary");
    expect(markup).not.toContain("Desktop only");
  });
});
