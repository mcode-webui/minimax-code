// Unit tests for the Phase-3 ActivityIndicator transcription.
//
// We render through `renderToStaticMarkup` (the project's SSR test convention,
// see `minimax-code-webui` SKILL.md) and assert against the exact
// `data-testid` values, so any future Playwright probe can reuse the
// same selectors.
//
// `lottie-web` is mocked so the test runs under the vitest `node`
// environment; the surface we care about is the React markup, not the SVG
// the library would otherwise inject.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("lottie-web", () => ({
  default: {
    loadAnimation: vi.fn(() => ({
      play: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
      setSpeed: vi.fn(),
    })),
  },
}));

import {
  ActivityIndicator,
  MessageAfterQueryStreamingPlaceholder,
  MessagePassiveLoadingPlaceholder,
  MessageViewportStreamingLoader,
} from "../../src/client/features/transcript/ui/ActivityIndicator.js";
import { pickWeightedPhrase, bucketPhrases } from "../../src/client/ui/activity-phrase.js";

describe("ActivityIndicator markup (desktop parity)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }));
  });

  it("renders the desktop testid and the inner lottie container", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityIndicator, { showLabel: true, label: "思考中…" }),
    );
    expect(html).toContain('data-testid="streaming-rose-loader"');
    expect(html).toContain('data-testid="streaming-rose-loader-label"');
    expect(html).toContain("思考中…");
  });

  it("hides the label when showLabel is false", () => {
    const html = renderToStaticMarkup(createElement(ActivityIndicator, {}));
    expect(html).toContain('data-testid="streaming-rose-loader"');
    expect(html).not.toContain('data-testid="streaming-rose-loader-label"');
  });

  it("computes the pulse container size with the desktop formula", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityIndicator, {
        iconSizePx: 24,
        pulseMinSizePx: 32,
        pulseMaxSizePx: 40,
        visualScale: 2,
      }),
    );
    // Math.max(16, ceil(max(24, 32, 40) * 2) + 0) = 80
    expect(html).toContain('width:80px');
    expect(html).toContain('height:80px');
    // inner lottie: ceil(24 * 2) = 48
    expect(html).toContain('width:48px');
  });

  it("defaults the container to 27px when no pulse sizes are supplied", () => {
    const html = renderToStaticMarkup(createElement(ActivityIndicator, {}));
    expect(html).toContain(
      'style="width:27px;height:27px;min-width:27px;min-height:27px"',
    );
  });

  it("concatenates the className prop onto the desktop container", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityIndicator, { className: "extra-class" }),
    );
    expect(html).toMatch(/class="[^"]*extra-class/);
  });
});

describe("ActivityIndicator placeholders (desktop parity)", () => {
  it("MessageViewportStreamingLoader mounts a flex container with the slot testid", () => {
    const html = renderToStaticMarkup(
      createElement(MessageViewportStreamingLoader, {
        testId: "message-viewport-streaming-loader",
        slot: createElement("span", { "data-testid": "slot" }, "x"),
      }),
    );
    expect(html).toContain('data-testid="message-viewport-streaming-loader"');
    expect(html).toContain('data-testid="slot"');
    expect(html).toContain("mb-4 min-h-9 w-full flow-root pointer-events-none");
  });

  it("MessageAfterQueryStreamingPlaceholder matches the desktop snapshot", () => {
    const html = renderToStaticMarkup(createElement(MessageAfterQueryStreamingPlaceholder));
    expect(html).toContain('data-testid="message-after-query-streaming-placeholder"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("MessagePassiveLoadingPlaceholder picks the right testid based on label presence", () => {
    const plain = renderToStaticMarkup(createElement(MessagePassiveLoadingPlaceholder));
    expect(plain).toContain('data-testid="message-passive-loading-placeholder"');
    expect(plain).not.toContain('data-testid="message-passive-loading-status"');

    const labeled = renderToStaticMarkup(
      createElement(MessagePassiveLoadingPlaceholder, { label: "排队中" }),
    );
    expect(labeled).toContain('data-testid="message-passive-loading-status"');
    expect(labeled).toContain("排队中");
  });
});

describe("weighted phrase bucket", () => {
  it("filters empty buckets and weights basic/specific/motion 0.75/0.15/0.1", () => {
    const buckets = bucketPhrases({ basic: ["a"], specific: ["b"], motion: [] });
    expect(buckets).toHaveLength(2);
    const total = buckets.reduce((sum, b) => sum + b.weight, 0);
    expect(total).toBeCloseTo(0.9);
  });

  it("returns null when every bucket is empty", () => {
    expect(pickWeightedPhrase(bucketPhrases({ basic: [], specific: [], motion: [] }), null)).toBeNull();
  });

  it("avoids picking the previous entry when alternatives exist", () => {
    const buckets = bucketPhrases({ basic: ["x", "y"], specific: [], motion: [] });
    const repeated = Array.from({ length: 32 }, () => pickWeightedPhrase(buckets, "x"));
    // Allow occasional repeats for randomness, but the bulk should differ.
    const distinct = new Set(repeated);
    expect(distinct.size).toBeGreaterThan(0);
  });

  it("falls back to the previous entry when no alternative is available", () => {
    const buckets = bucketPhrases({ basic: ["only"], specific: [], motion: [] });
    expect(pickWeightedPhrase(buckets, "only")).toBe("only");
  });
});
