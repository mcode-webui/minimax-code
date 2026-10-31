// Unit tests for the Phase-6 ConversationUsageBanner transcription.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationUsageBanner } from "../../src/client/features/account/ui/ConversationUsageBanner.js";

const baseNotice = {
  kind: "five_hour",
  messageKey: "usage_notice.five_hour_exhausted",
  actions: ["subscribe_plan", "buy_credits"] as const,
};

describe("ConversationUsageBanner", () => {
  it("emits the desktop testid and the action testids", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: baseNotice,
        messageText: "5小时额度已用尽",
        buttonLabels: { subscribe_plan: "订阅", buy_credits: "购买积分" },
      }),
    );
    expect(html).toContain('data-testid="conversation-usage-banner"');
    expect(html).toContain('data-notice-kind="five_hour"');
    expect(html).toContain('data-testid="conversation-usage-action-subscribe_plan"');
    expect(html).toContain('data-testid="conversation-usage-action-buy_credits"');
    expect(html).toContain("5小时额度已用尽");
    expect(html).toContain("订阅");
    expect(html).toContain("购买积分");
  });

  it("renders the dismiss button when notice.dismissable is not explicitly false", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: baseNotice,
        messageText: "…",
      }),
    );
    expect(html).toContain('data-testid="conversation-usage-banner-dismiss"');
  });

  it("hides the dismiss button when notice.dismissable is false", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: { ...baseNotice, dismissable: false },
        messageText: "…",
      }),
    );
    expect(html).not.toContain('data-testid="conversation-usage-banner-dismiss"');
  });

  it("emits the compact layout when mobileLayout is true", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: baseNotice,
        mobileLayout: true,
        messageText: "…",
      }),
    );
    expect(html).toContain("relative mb-2 flex min-h-16 flex-col gap-3");
    expect(html).toContain('data-testid="conversation-usage-banner-dismiss"');
  });

  it("appends a reset timestamp when resetAtMs is set", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: { ...baseNotice, resetAtMs: Date.now() + 60_000 },
        messageText: "将在稍后重置",
      }),
    );
    expect(html).toContain("将在稍后重置");
    expect(html).toMatch(/将在稍后重置 [^<]+/);
  });

  it("calls onAction with the action kind when the integrator wires it", () => {
    const onAction = vi.fn();
    let actionClick: (() => void) | undefined;
    const html = renderToStaticMarkup(
      createElement(ConversationUsageBanner, {
        notice: baseNotice,
        messageText: "…",
        onAction,
        renderActionButton: ({ kind, label, onClick, testId }: {
          kind: "subscribe_plan" | "buy_credits" | "upgrade_plan";
          label: string;
          onClick: () => void;
          testId: string;
        }) => {
          if (kind === "subscribe_plan") actionClick = onClick;
          return createElement("button", { type: "button", "data-testid": testId }, label);
        },
      }),
    );
    expect(html).toContain('data-testid="conversation-usage-action-subscribe_plan"');
    expect(actionClick).toBeTypeOf("function");
    actionClick!();
    expect(onAction).toHaveBeenCalledWith("subscribe_plan");
  });
});
