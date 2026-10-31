// Unit tests for the Phase-6 TurnNavigator transcription.
//
// Each test asserts against the exact `data-testid` values, the
// `data-turn-id` / `data-state` attributes the component emits, and the
// `data-mode` / `data-hidden` flags the parent uses to drive the strip
// visibility. The brief lists 17 testids; this file covers them all.
//
// The second half covers the integrator helpers `SessionTranscript` exports:
// the hover-preview projection, the tick→message anchor selector, and the
// reveal effect. The projection is fed groups built by the REAL message
// projection, so the shapes are the ones the transcript renders, not hand
// copies that could drift.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TurnNavigator } from "../../src/client/features/transcript/ui/TurnNavigator.js";
import {
  projectTurnNavigatorPreview,
  revealTurnNavigatorAnchor,
  turnNavigatorAnchorSelector,
  TURN_NAVIGATOR_FLASH_CLASS,
} from "../../src/client/features/transcript/ui/SessionTranscript.js";
import { projectWebuiMessage } from "../../src/client/features/transcript/projection/message-projection.js";
import { groupWebuiTranscriptItems } from "../../src/client/features/transcript/projection/transcript-projection.js";

const baseTurns = [
  { id: "turn-1", state: "default" as const },
  { id: "turn-2", state: "active" as const },
  { id: "turn-3", state: "running" as const },
  { id: "turn-4", state: "error" as const },
];

/** Two full turns through the real projection: user question, then the
 *  assistant block (thinking + answer) the strip lists a tick for. */
const navigatorGroups = groupWebuiTranscriptItems([
  ...projectWebuiMessage({
    msgId: "nav-user-1",
    role: "user",
    msgContent: "第一问",
    timestamp: new Date(2026, 9, 26, 12, 30).getTime(),
  }),
  ...projectWebuiMessage({
    msgId: "nav-assistant-1",
    role: "assistant",
    thinkingContent: "先推理",
    msgContent: "第一答",
    timestamp: new Date(2026, 9, 26, 12, 34).getTime(),
  }),
  ...projectWebuiMessage({
    msgId: "nav-user-2",
    role: "user",
    msgContent: "第二问",
    timestamp: new Date(2026, 9, 26, 12, 40).getTime(),
  }),
  ...projectWebuiMessage({
    msgId: "nav-assistant-2",
    role: "assistant",
    msgContent: "  \n第二答第一行\n后面几行不进摘要",
    timestamp: new Date(2026, 9, 26, 12, 44).getTime(),
  }),
]);

describe("TurnNavigator", () => {
  it("emits the root, strip, and tick testids", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, { turns: baseTurns }),
    );
    expect(html).toContain('data-testid="message-turn-navigator"');
    expect(html).toContain('data-testid="message-turn-navigator-strip"');
    expect(html).toContain('data-testid="message-turn-navigator-tick"');
    expect(html).toContain('data-testid="message-turn-navigator-tick-hit-target"');
    expect(html).toContain('data-mode="default"');
    expect(html).toContain('data-hidden="false"');
  });

  it("reflects each turn's state on the corresponding tick", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, { turns: baseTurns }),
    );
    for (const turn of baseTurns) {
      const re = new RegExp(`data-turn-id="${turn.id}"[^>]*data-state="${turn.state}"`);
      expect(html).toMatch(re);
    }
  });

  it("renders the top/bottom mask when no preview disables them", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, { turns: baseTurns }),
    );
    expect(html).toContain('data-testid="message-turn-navigator-mask-top"');
    expect(html).toContain('data-testid="message-turn-navigator-mask-bottom"');
  });

  it("renders the preview card with every desktop testid", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, {
        turns: baseTurns,
        preview: {
          title: "总结标题",
          time: "12:34",
          previousQuery: "上一个问题",
          nextQuery: "下一个问题",
          response: "回复片段",
          artefacts: [
            { id: "a1", label: "alpha", icon: "X" },
            { id: "a2", label: "beta" },
          ],
          fileChangeCount: { additions: 12, deletions: 4 },
        },
      }),
    );
    expect(html).toContain('data-testid="message-turn-navigator-preview"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-title"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-time"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-previous-query"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-next-query"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-response"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-divider"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-artifacts"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-file-change-count"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-artifact-icon"');
    expect(html).toContain('data-testid="message-turn-navigator-preview-artifact-label"');
    expect(html).toContain("总结标题");
    expect(html).toContain("+12 / -4");
  });

  it("omits the preview block when preview is null", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, { turns: baseTurns, preview: null }),
    );
    expect(html).not.toContain('data-testid="message-turn-navigator-preview"');
  });

  it("reflects the hidden flag on the root element", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, { turns: baseTurns, hidden: true }),
    );
    expect(html).toContain('data-hidden="true"');
  });
});

describe("TurnNavigator integration helpers (SessionTranscript)", () => {
  it("builds the hover preview from the real groups: index, time, both neighbouring queries, first answer line", () => {
    const preview = projectTurnNavigatorPreview({
      turnId: "nav-assistant-1",
      groups: navigatorGroups,
    });
    // The timestamp is built from a local-time Date, so the formatted value is
    // stable on every timezone the suite runs on.
    expect(preview).toEqual({
      title: "第 1 轮",
      time: "10月26日, 12:34",
      previousQuery: "第一问",
      nextQuery: "第二问",
      response: "第一答",
    });
  });

  it("numbers the second assistant turn like the strip does and omits a missing next query", () => {
    const preview = projectTurnNavigatorPreview({
      turnId: "nav-assistant-2",
      groups: navigatorGroups,
    });
    expect(preview?.title).toBe("第 2 轮");
    expect(preview?.previousQuery).toBe("第二问");
    expect(preview?.nextQuery).toBeUndefined();
    // Leading blank lines are skipped: the summary is the first non-empty line.
    expect(preview?.response).toBe("第二答第一行");
  });

  it("returns null for ids the strip lists no tick for", () => {
    // A user block is not a tick, and an unknown id is not a turn at all.
    expect(
      projectTurnNavigatorPreview({ turnId: "nav-user-1", groups: navigatorGroups }),
    ).toBeNull();
    expect(
      projectTurnNavigatorPreview({ turnId: "missing", groups: navigatorGroups }),
    ).toBeNull();
  });

  it("caps a long first answer line for the preview card", () => {
    const groups = groupWebuiTranscriptItems([
      ...projectWebuiMessage({ msgId: "u", role: "user", msgContent: "问" }),
      ...projectWebuiMessage({
        msgId: "a",
        role: "assistant",
        msgContent: "长".repeat(300),
      }),
    ]);
    const response = projectTurnNavigatorPreview({ turnId: "a", groups })?.response;
    expect(response).toBeDefined();
    expect(response!.length).toBe(120);
    expect(response!.endsWith("…")).toBe(true);
  });

  it("feeds a projection the component's preview slot renders as-is", () => {
    const html = renderToStaticMarkup(
      createElement(TurnNavigator, {
        turns: baseTurns,
        preview: projectTurnNavigatorPreview({
          turnId: "nav-assistant-1",
          groups: navigatorGroups,
        }),
      }),
    );
    expect(html).toContain("第 1 轮");
    expect(html).toContain("10月26日, 12:34");
    expect(html).toContain("第一问");
    expect(html).toContain("第二问");
    expect(html).toContain("第一答");
  });

  it("anchors a tick to its message root's data-message-id, with quotes escaped", () => {
    expect(turnNavigatorAnchorSelector("nav-assistant-1")).toBe(
      '[data-message-id="nav-assistant-1"]',
    );
    // A message id carrying a quote must not close the attribute selector.
    expect(turnNavigatorAnchorSelector('msg"1\\2')).toBe(
      '[data-message-id="msg\\"1\\\\2"]',
    );
  });

  it("centers the jumped-to turn and flashes it transiently", () => {
    vi.useFakeTimers();
    try {
      const scrolls: unknown[] = [];
      const classLog: string[] = [];
      const target = {
        scrollIntoView: (options?: ScrollIntoViewOptions) => scrolls.push(options),
        classList: {
          add: (token: string) => classLog.push(`+${token}`),
          remove: (token: string) => classLog.push(`-${token}`),
        },
      };
      revealTurnNavigatorAnchor(target, 1200);
      expect(scrolls).toEqual([{ block: "center", behavior: "smooth" }]);
      expect(classLog).toEqual([`+${TURN_NAVIGATOR_FLASH_CLASS}`]);
      vi.advanceTimersByTime(1199);
      expect(classLog).toEqual([`+${TURN_NAVIGATOR_FLASH_CLASS}`]);
      vi.advanceTimersByTime(1);
      expect(classLog).toEqual([
        `+${TURN_NAVIGATOR_FLASH_CLASS}`,
        `-${TURN_NAVIGATOR_FLASH_CLASS}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
