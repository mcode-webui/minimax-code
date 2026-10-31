// Unit tests for the Phase-6 OutputError transcription.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OutputError } from "../../src/client/features/transcript/ui/OutputError.public.js";

describe("OutputError", () => {
  it("emits the desktop testids for the generic error variant", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "运行失败",
      }),
    );
    expect(html).toContain('data-testid="output-error-surface"');
    expect(html).toContain('data-output-error-variant="output_error"');
    expect(html).toContain('data-testid="output-error-divider"');
    expect(html).toContain('data-testid="output-error-text"');
    expect(html).toContain('data-testid="output-error-icon"');
    expect(html).toContain("运行失败");
  });

  it("renders the retry button when onRetry is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "失败",
        onRetry: () => {},
        retryLabel: "重试",
      }),
    );
    expect(html).toContain('data-testid="output-error-retry"');
    expect(html).toContain("重试");
  });

  it("hides the retry button when output is retrying", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_retrying",
        text: "重试中",
        onRetry: () => {},
      }),
    );
    expect(html).not.toContain('data-testid="output-error-retry"');
    expect(html).not.toContain('data-testid="output-error-retry-count"');
  });

  it("shows the retry counter when retryCount is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "失败",
        onRetry: () => {},
        retryCount: { current: 2, total: 5 },
      }),
    );
    expect(html).toContain('data-testid="output-error-retry-count"');
    expect(html).toContain("（2/5）");
  });

  it("does not render a retry-count when total is zero", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "失败",
        retryCount: { current: 0, total: 0 },
      }),
    );
    expect(html).not.toContain('data-testid="output-error-retry-count"');
  });

  it("accepts a custom testId on the inner alert", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "fail",
        testId: "llm-retry-notice",
      }),
    );
    expect(html).toContain('data-testid="llm-retry-notice"');
    expect(html).toContain("fail");
  });

  it("passes through role and aria-live", () => {
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_retrying",
        text: "…",
        role: "status",
        ariaLive: "polite",
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("forwards onRetry invocations through the button click handler", () => {
    const onRetry = vi.fn();
    let retryClick: (() => void) | undefined;
    const html = renderToStaticMarkup(
      createElement(OutputError, {
        variant: "output_error",
        text: "失败",
        onRetry,
        renderRetryButton: ({ onClick, label }: { onClick: () => void; label: React.ReactNode }) => {
          retryClick = onClick;
          return createElement("button", { type: "button", "data-testid": "test-retry" }, label);
        },
      } as React.ComponentProps<typeof OutputError> & {
        renderRetryButton: (params: { onClick: () => void; label: React.ReactNode }) => React.ReactNode;
      }),
    );
    expect(html).toContain('data-testid="test-retry"');
    expect(retryClick).toBeTypeOf("function");
    retryClick!();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
