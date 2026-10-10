// SPEC-C item C-4 — "Mixed media and retry".
//
// C-4 was marked "not verified" by the roadmap. The three clauses are:
//
//   1. A failed turn surfaces a retry affordance, and retrying re-sends the
//      same user input.
//   2. A rate-limit response surfaces as a distinct message from a generic
//      failure.
//   3. Image and text in one assistant message render together, in order.
//
// No DOM framework is available, so every render goes through
// `renderToStaticMarkup` and every interaction goes through the component's
// own injection seam (`renderRetryButton`), per `packages/webui/AGENTS.md`.
// Nothing here asserts that a testid merely exists: each assertion pins the
// text, the countdown arithmetic, the click path, or the document order.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OutputError } from "../../src/client/components/OutputError.js";
import { WebuiAssistantBody } from "../../src/client/components/AssistantBody.js";
import { WebuiClientFoundationApp } from "../../src/client/components/WebuiClientFoundationApp.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { projectMessageParts } from "../../src/client/projection/message-parts.js";
import type { WebuiClientMessage } from "../../src/client/contracts/message-view.js";

/** Captures the retry control's click handler out of a static render. */
function renderWithRetryCapture(props: {
  variant: "output_retrying" | "output_rate_limited" | "output_error";
  text: React.ReactNode;
  errorAt?: number;
  onRetry?: () => void;
  retryCount?: { current: number; total: number };
}): { html: string; click: (() => void) | undefined } {
  let click: (() => void) | undefined;
  const html = renderToStaticMarkup(
    createElement(OutputError, {
      ...props,
      renderRetryButton: ({ onClick, label }: { onClick: () => void; label: React.ReactNode }) => {
        click = onClick;
        return createElement(
          "button",
          { type: "button", "data-testid": "captured-retry" },
          label,
        );
      },
    } as React.ComponentProps<typeof OutputError> & {
      renderRetryButton: (params: {
        onClick: () => void;
        label: React.ReactNode;
      }) => React.ReactNode;
    }),
  );
  return { html, click };
}

describe("C-4.1 a failed turn surfaces a retry affordance", () => {
  it("shows the failure text and fires the retry handler when retry is pressed", () => {
    const onRetry = vi.fn();
    const { html, click } = renderWithRetryCapture({
      variant: "output_error",
      text: "upstream rejected: connection reset",
      errorAt: Date.now(),
      onRetry,
    });

    // The failure itself is surfaced, not a bare control.
    expect(html).toContain("upstream rejected: connection reset");
    expect(html).toContain('data-testid="captured-retry"');
    expect(html).toContain("重试");

    // …and the affordance is wired to the retry handler, not merely present.
    expect(click).toBeTypeOf("function");
    click?.();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("withholds the retry affordance while the turn is still retrying", () => {
    const onRetry = vi.fn();
    const { html, click } = renderWithRetryCapture({
      variant: "output_retrying",
      text: "重试中",
      onRetry,
    });

    // A turn in flight must not offer a second attempt.
    expect(html).toContain("重试中");
    expect(html).not.toContain('data-testid="captured-retry"');
    expect(click).toBeUndefined();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("C-4.2 a rate-limit response is distinguishable from a generic failure", () => {
  it("renders a count-down window and suppresses retry while the rate limit is live", () => {
    const onRetry = vi.fn();
    // errorAt is "now", so the 10s window has 10s left.
    const { html, click } = renderWithRetryCapture({
      variant: "output_rate_limited",
      text: "请求过于频繁",
      errorAt: Date.now(),
      onRetry,
    });

    expect(html).toContain('data-output-error-variant="output_rate_limited"');
    expect(html).toContain("请求过于频繁");
    expect(html).toContain('data-testid="output-error-countdown"');
    expect(html).toContain("（10s）");
    // Retrying inside the window is what gets a client rate-limited again.
    expect(html).not.toContain('data-testid="captured-retry"');
    expect(click).toBeUndefined();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("counts the rate-limit window down and clamps it at zero", () => {
    const fourSecondsIn = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_rate_limited",
        text: "请求过于频繁",
        errorAt: Date.now() - 4_000,
      }),
    );
    expect(fourSecondsIn).toContain("（6s）");

    // A stale errorAt must not render a negative count-down.
    const longExpired = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_rate_limited",
        text: "请求过于频繁",
        errorAt: Date.now() - 60_000,
      }),
    );
    expect(longExpired).not.toContain('data-testid="output-error-countdown"');
    expect(longExpired).not.toContain("（-50s）");
  });

  it("restores the retry affordance once the rate-limit window has expired", () => {
    const onRetry = vi.fn();
    const { html, click } = renderWithRetryCapture({
      variant: "output_rate_limited",
      text: "请求过于频繁",
      errorAt: Date.now() - 20_000,
      onRetry,
    });

    expect(html).not.toContain('data-testid="output-error-countdown"');
    expect(html).toContain('data-testid="captured-retry"');
    click?.();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders a generic failure as a different surface from a rate limit", () => {
    const generic = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "upstream rejected",
        errorAt: Date.now(),
        onRetry: () => undefined,
      }),
    );
    const rateLimited = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_rate_limited",
        text: "upstream rejected",
        errorAt: Date.now(),
        onRetry: () => undefined,
      }),
    );

    // Same message, different variant ⇒ different surface. The generic failure
    // offers retry and no count-down; the live rate limit does the opposite.
    expect(generic).toContain('data-output-error-variant="output_error"');
    expect(generic).toContain('data-testid="output-error-retry"');
    expect(generic).not.toContain('data-testid="output-error-countdown"');

    expect(rateLimited).toContain('data-output-error-variant="output_rate_limited"');
    expect(rateLimited).toContain('data-testid="output-error-countdown"');
    expect(rateLimited).not.toContain('data-testid="output-error-retry"');

    expect(generic).not.toBe(rateLimited);
  });

  it("still shows the retry counter alongside a rate limit", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_rate_limited",
        text: "请求过于频繁",
        errorAt: Date.now(),
        retryCount: { current: 1, total: 3 },
      }),
    );
    expect(html).toContain('data-testid="output-error-retry-count"');
    expect(html).toContain("（1/3）");
  });
});

describe("C-4.3 image and text in one assistant message render together, in order", () => {
  it("projects a delivered image after the text that introduces it, and strips the wire XML", () => {
    const parts = projectMessageParts({
      msgId: "msg-assistant-1",
      msgContent:
        '这是生成的示意图。\n<deliver-assets><media src="https://example.test/chart.png" name="chart.png" /></deliver-assets>\n后续说明。',
    });

    // Text first, image second — the order they appear in the source.
    expect(parts.map((part) => part.type)).toEqual(["text", "asset_list"]);

    const text = parts[0];
    expect(text?.type).toBe("text");
    // `expect(...).toBe` checks the discriminant at runtime; it does not narrow
    // the type for the compiler, and only some part kinds carry `content`. The
    // same narrowing the `asset_list` branch below uses, kept honest: a part
    // that is not text reads as `undefined` and fails the first assertion here.
    const textContent = text?.type === "text" ? text.content : undefined;
    expect(textContent).toContain("这是生成的示意图。");
    expect(textContent).toContain("后续说明。");
    // The renderer XML must not leak into the visible answer.
    expect(textContent).not.toContain("deliver-assets");

    const assets = parts[1];
    expect(assets?.type).toBe("asset_list");
    expect(assets?.type === "asset_list" ? assets.assets : []).toEqual([
      { src: "https://example.test/chart.png", name: "chart.png" },
    ]);
  });

  it("keeps the text of an assistant message and its image attachment in one body, text first", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiAssistantBody, {
        messageId: "msg-assistant-2",
        answers: ["这是生成的示意图。"],
        attachments: [
          {
            id: "img-1",
            type: "image",
            file_name: "chart.png",
            src: "https://example.test/chart.png",
          },
        ],
      }),
    );

    // Both halves are present in the same rendered message…
    expect(html).toContain("这是生成的示意图。");
    expect(html).toContain('src="https://example.test/chart.png"');
    // …and the image follows the text rather than preceding it.
    expect(html.indexOf("这是生成的示意图。")).toBeLessThan(
      html.indexOf('src="https://example.test/chart.png"'),
    );
  });

  it("keeps several images in one assistant message in source order", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiAssistantBody, {
        messageId: "msg-assistant-3",
        answers: ["两张图。"],
        attachments: [
          {
            id: "img-1",
            type: "image",
            file_name: "first.png",
            src: "https://example.test/first.png",
          },
          {
            id: "img-2",
            type: "image",
            file_name: "second.png",
            src: "https://example.test/second.png",
          },
        ],
      }),
    );

    const first = html.indexOf('src="https://example.test/first.png"');
    const second = html.indexOf('src="https://example.test/second.png"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // The text still leads both.
    expect(html.indexOf("两张图。")).toBeLessThan(first);
  });

  it("delivers an assistant message's image attachment alongside its text, in order, through the shell", () => {
    // The component-level tests above prove the body orders its own halves.
    // This one closes the last hop: `MessageItem` has to hand the historical
    // message's `attachments` to that body at all, or the image never renders.
    const SESSION_ID = "session-mixed-media";
    const messages: WebuiClientMessage[] = [
      {
        msgId: "m-user",
        role: "user",
        msgContent: "把这两张图对比一下",
        timestamp: 1,
      },
      {
        msgId: "m-assistant",
        role: "assistant",
        msgContent: "这是两张图的对比。",
        timestamp: 2,
        attachments: [
          {
            id: "att-1",
            type: "image",
            file_name: "first.png",
            src: "https://example.test/first.png",
            mime_type: "image/png",
          },
        ],
      },
    ];

    // The shell is handed the one application store, so the transcript reads
    // exactly this instance (ticket #45). A fresh store starts at the idle
    // phase this case wants; no prior turn can bleed in.
    const sessionStore = createWebuiSessionStore();

    const html = renderToStaticMarkup(
      createElement(WebuiClientFoundationApp, {
        label: "webui-foundation",
        sessionStore,
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
        initialMessages: { messages, hasMore: false },
        transport: {
          loadMessages: async () => ({ messages, hasMore: false }),
          watchEvents: () => () => undefined,
        },
      } as React.ComponentProps<typeof WebuiClientFoundationApp>),
    );

    expect(html).toContain("这是两张图的对比。");
    expect(html).toContain('src="https://example.test/first.png"');
    expect(html.indexOf("这是两张图的对比。")).toBeLessThan(
      html.indexOf('src="https://example.test/first.png"'),
    );
  });
});
