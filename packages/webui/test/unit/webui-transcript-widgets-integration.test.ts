// Round-2 widget integration tests.
//
// These tests render the full `WebuiClientFoundationApp` shell with the
// minimum scaffolding each transcript widget needs to be reached, then
// assert ONE core marker per widget. They were written BEFORE the
// corresponding wiring landed in the shell and confirmed to fail; the
// widget-specific unit tests in this directory cover the per-component
// shape, while this file covers the wiring.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiClientFoundationApp } from "../../src/client/components/WebuiClientFoundationApp.js";
import type { WebuiClientMessage, WebuiClientMessagePage } from "../../src/client/contracts.js";

import { updateSessionRuntimeState } from "../../src/client/session-runtime-store.js";
import type { WebuiUsageQuotaResult } from "../../src/shared/contracts/usage-quota.js";

const SESSION_ID = "session-widgets";

function sessionShell(opts: {
  readonly messages?: readonly WebuiClientMessage[];
  readonly quota?: WebuiUsageQuotaResult;
  readonly streamingPhase?: "streaming" | "waiting" | "reconnecting" | "refused" | "error";
  readonly streamUserText?: string;
  readonly streamAssistantAnswer?: string;
  readonly streamAssistantThinking?: string;
  readonly streamRefusal?: string;
  readonly transcriptIncomplete?: boolean;
}): string {
  // The runtime map is module-scoped; clear any prior turn on the same key so
  // each test sees a clean slate.
  updateSessionRuntimeState(SESSION_ID, (current) => ({
    ...current,
    sending: opts.streamingPhase
      ? opts.streamingPhase !== "refused" && opts.streamingPhase !== "error"
      : false,
    stream: {
      phase: opts.streamingPhase ?? "idle",
      messages: opts.streamUserText
        ? [
            {
              id: "stream-user-1",
              answer: opts.streamUserText,
              thinking: "",
              role: "user" as const,
              timestamp: Date.now(),
            },
            ...(opts.streamAssistantAnswer
              ? [{
                  id: "stream-assistant-1",
                  answer: opts.streamAssistantAnswer,
                  thinking: opts.streamAssistantThinking ?? "",
                  timestamp: Date.now(),
                }]
              : []),
          ]
        : opts.streamAssistantAnswer
          ? [{
              id: "stream-assistant-1",
              answer: opts.streamAssistantAnswer,
              thinking: opts.streamAssistantThinking ?? "",
              timestamp: Date.now(),
            }]
          : [],
      runtimeEvents: [],
      actionDeltas: [],
      workspaceProgress: current.stream.workspaceProgress,
      resumeRequired: false,
      transcriptIncomplete: opts.transcriptIncomplete === true,
      ...(opts.streamRefusal ? { refusal: opts.streamRefusal } : {}),
      ...(opts.streamingPhase === "streaming"
        ? { processingStartedAtMs: Date.now() - 1000 }
        : {}),
    },
  }));
  return renderToStaticMarkup(
    createElement(WebuiClientFoundationApp, {
      label: "webui-foundation",
      locationHash: `#session=${SESSION_ID}`,
      sessionPage: {
        sessions: [
          {
            sessionId: SESSION_ID,
            agentName: "main",
            createdAt: 1,
            updatedAt: 2,
            workspaceDir: "/tmp/project",
          },
        ],
        hasMore: false,
      },
      initialMessages: { messages: opts.messages ?? [], hasMore: false },
      ...(opts.quota ? { initialUsageQuota: opts.quota } : {}),
      transport: {
        loadMessages: async () => ({
          messages: opts.messages ?? [],
          hasMore: false,
        }),
        getUsageQuota: async () =>
          opts.quota ?? {
            signedIn: false,
          },
        watchEvents: () => () => undefined,
      },
    }),
  );
}

const assistantWithAttachments: WebuiClientMessage[] = [
  {
    msgId: "m-user",
    role: "user",
    msgContent: "看看这两张图",
    timestamp: 1,
  },
  {
    msgId: "m-assistant",
    role: "assistant",
    msgContent: "已对比两张图。",
    timestamp: 2,
    attachments: [
      {
        id: "att-1",
        type: "image",
        file_name: "first.png",
        src: "data:image/png;base64,iVBORw0KGgo=",
        mime_type: "image/png",
      },
    ],
  },
];

const quotaHighUsage: WebuiUsageQuotaResult = {
  signedIn: true,
  quota: {
    fiveHour: {
      usedPercent: 80,
      totalPercent: 100,
      resetAtMs: Date.now() + 3600_000,
      unlimited: false,
    },
    weekly: {
      usedPercent: 0,
      totalPercent: 100,
      resetAtMs: Date.now() + 7 * 86_400_000,
      unlimited: false,
    },
    video: {
      usedCount: 0,
      totalCount: 100,
      resetAtMs: Date.now() + 86_400_000,
      unlimited: false,
    },
  },
};

describe("WebUI transcript widget wiring", () => {
  it("renders MessageAttachments under an assistant message", () => {
    const html = sessionShell({ messages: assistantWithAttachments });
    expect(html).toContain('data-testid="message-attachments"');
  });

  it("renders TurnNavigator in the session transcript", () => {
    const html = sessionShell({ messages: assistantWithAttachments });
    expect(html).toContain('data-testid="message-turn-navigator"');
  });

  it("replaces the bare alert with OutputError when the stream refuses", () => {
    const html = sessionShell({
      streamingPhase: "refused",
      streamRefusal: "upstream rejected",
    });
    expect(html).toContain('data-testid="output-error-surface"');
    // The bare alert text must not survive the swap.
    expect(html).not.toContain("发送消息失败");
  });

  it("renders ChatSkeleton while the transcript is loading with no items", () => {
    // Force the loading state by holding loadMessages unresolved.
    const html = renderToStaticMarkup(
      createElement(WebuiClientFoundationApp, {
        label: "webui-foundation",
        locationHash: `#session=${SESSION_ID}`,
        sessionPage: {
          sessions: [
            {
              sessionId: SESSION_ID,
              agentName: "main",
              createdAt: 1,
              updatedAt: 2,
              workspaceDir: "/tmp/project",
            },
          ],
          hasMore: false,
        },
        transport: {
          loadMessages: () => new Promise<WebuiClientMessagePage>(() => undefined),
          watchEvents: () => () => undefined,
        },
    }),
    );
    expect(html).toContain('data-testid="chat-skeleton"');
  });

  it("renders ConversationUsageBanner at the session top when quota is high", () => {
    const html = sessionShell({ quota: quotaHighUsage });
    expect(html).toContain('data-testid="conversation-usage-banner"');
  });

  it("suppresses ConversationUsageBanner when the high-usage window is unlimited", () => {
    // Same percentages as `quotaHighUsage`; only `unlimited` differs. The notice
    // projection skips unlimited windows, so the banner must not appear —
    // without this, `unlimited: false` above reads as an arbitrary fixture key.
    const quotaUnlimited: WebuiUsageQuotaResult = {
      signedIn: true,
      quota: {
        fiveHour: {
          usedPercent: 80,
          totalPercent: 100,
          resetAtMs: Date.now() + 3600_000,
          unlimited: true,
        },
        weekly: {
          usedPercent: 0,
          totalPercent: 100,
          resetAtMs: Date.now() + 7 * 86_400_000,
          unlimited: true,
        },
        video: {
          usedCount: 0,
          totalCount: 100,
          resetAtMs: Date.now() + 86_400_000,
          unlimited: true,
        },
      },
    };
    const html = sessionShell({ quota: quotaUnlimited });
    expect(html).not.toContain('data-testid="conversation-usage-banner"');
  });

  it("renders ActivityIndicator while streaming and no assistant text yet", () => {
    const html = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "我说一句",
    });
    expect(html).toContain('data-testid="streaming-rose-loader"');
    expect(html).not.toContain("No messages in this session.");
  });

  it("renders the first live turn once in the shared transcript with its loader", () => {
    const html = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "你好",
    });
    expect(html).toContain('data-webui-session-transcript-scroll="true"');
    expect(html.match(/data-webui-message-role="user"/gu)).toHaveLength(1);
    expect(html.match(/data-testid="streaming-rose-loader"/gu)).toHaveLength(1);
    expect(html).not.toContain('data-webui-transcript-empty-live="true"');
  });

  it("keeps the transcript expanded when a later turn is streaming", () => {
    const html = sessionShell({
      messages: [
        {
          msgId: "history-user-1",
          role: "user",
          msgContent: "你好",
          timestamp: 1,
        },
        {
          msgId: "history-assistant-1",
          role: "assistant",
          msgContent: "你好！我是 Mavis。",
          timestamp: 2,
        },
      ],
      streamingPhase: "streaming",
      streamUserText: "你能做什么",
    });
    expect(html).not.toContain('data-webui-transcript-empty-live="true"');
  });

  it("keeps a Desktop-style bottom spacer after the shared live viewport", () => {
    const html = sessionShell({
      messages: [
        {
          msgId: "history-user-1",
          role: "user",
          msgContent: "你好",
          timestamp: 1,
        },
        {
          msgId: "history-assistant-1",
          role: "assistant",
          msgContent: "你好！我是 Mavis。",
          timestamp: 2,
        },
      ],
      streamingPhase: "streaming",
      streamUserText: "你能做什么",
    });
    expect(html).toContain('data-webui-session-scroll="true"');
    expect(html).toContain('data-testid="message-bottom-padding"');
    expect(html).toContain('data-webui-session-bottom-padding="true"');
  });

  it("keeps the same animated loader after the assistant starts streaming", () => {
    const html = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "我说一句",
      streamAssistantAnswer: "我开始回复",
    });
    expect(html).toContain('data-testid="streaming-rose-loader"');
    expect(html.match(/data-testid="streaming-rose-loader"/gu)).toHaveLength(1);
    expect(html).not.toContain("webui-thinking-indicator");
  });

  it("uses one animated loader when streamed thinking and answer text coexist", () => {
    const html = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "我说一句",
      streamAssistantThinking: "我正在思考",
      streamAssistantAnswer: "我开始回复",
    });
    expect(html.match(/data-testid="streaming-rose-loader"/gu)).toHaveLength(1);
    expect(html).not.toContain("webui-thinking-indicator");
  });

  it("keeps the thinking loader geometry when the assistant frame arrives", () => {
    const waiting = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "我说一句",
    });
    const replying = sessionShell({
      streamingPhase: "streaming",
      streamUserText: "我说一句",
      streamAssistantThinking: "我正在思考",
      streamAssistantAnswer: "我开始回复",
    });
    const loaderGeometry =
      'style="width:27px;height:27px;min-width:27px;min-height:27px"';
    expect(waiting).toContain(loaderGeometry);
    expect(replying).toContain(loaderGeometry);
  });

  it("renders MessageAfterQueryStreamingPlaceholder while waiting on a pending user turn", () => {
    const html = sessionShell({
      streamingPhase: "waiting",
      streamUserText: "我说一句",
    });
    expect(html).toContain('data-testid="message-after-query-streaming-placeholder"');
    expect(html).toContain('data-testid="streaming-rose-loader"');
    expect(html).toContain('data-testid="streaming-rose-loader-label"');
    expect(html).toContain("思考中…");
  });

  it("renders MessagePassiveLoadingPlaceholder while reconnecting", () => {
    const html = sessionShell({ streamingPhase: "reconnecting" });
    expect(html).toMatch(/data-testid="message-passive-loading-(placeholder|status)"/);
  });
});
