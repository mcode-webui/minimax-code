import { describe, expect, it } from "vitest";

import { WebuiBrowserTargetRegistry } from "../../src/runtime/browser/target-registry.js";
import type { WebuiBrowserTargetId } from "../../src/shared/contracts/browser.js";

const TARGET = {
  surface: "isolated-chromium",
  browserId: "browser-1",
  targetId: "tab-1",
} as const;

describe("browser target registry", () => {
  it("gives a first sighting its first generation", () => {
    const registry = new WebuiBrowserTargetRegistry();
    const state = registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    expect(state.id.generation).toBe(1);
    expect(state.title).toBe("Example");
    expect(state.status).toBe("open");
  });

  it("does not raise the generation when the provider reports the target again", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    // The provider reports its targets repeatedly. Raising the generation on
    // every sighting would invalidate every reference the moment the provider
    // refreshed its list.
    const again = registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    expect(again.id.generation).toBe(1);
  });

  it("raises the generation when the page behind the target is replaced", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    const raised = registry.raiseGeneration(TARGET);
    expect(raised?.id.generation).toBe(2);
  });

  it("refuses an identity whose generation is behind the current one", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    const stale: WebuiBrowserTargetId = { ...TARGET, generation: 1 };
    expect(registry.isCurrent(stale)).toBe(true);

    registry.raiseGeneration(TARGET);

    // The tab is still there, but the page behind it is not the one the
    // reference was recorded against.
    expect(registry.isCurrent(stale)).toBe(false);
    expect(registry.isCurrent({ ...TARGET, generation: 2 })).toBe(true);
  });

  it("refuses an identity for a target it never saw", () => {
    const registry = new WebuiBrowserTargetRegistry();
    expect(registry.isCurrent({ ...TARGET, generation: 1 })).toBe(false);
  });

  it("refuses an identity for a closed target", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "Example", url: "https://example.test" });
    registry.close(TARGET);
    expect(registry.isCurrent({ ...TARGET, generation: 1 })).toBe(false);
    // The entry is kept so a stale reference is explainable rather than merely
    // unknown.
    expect(registry.resolve({ ...TARGET, generation: 1 })?.status).toBe("closed");
  });

  it("separates two browsers of the same surface", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "One", url: "https://one.test" });
    registry.observe({
      ...TARGET,
      browserId: "browser-2",
      title: "Two",
      url: "https://two.test",
    });
    expect(registry.list("isolated-chromium")).toHaveLength(2);
    // A generation raised on one browser says nothing about the other.
    registry.raiseGeneration(TARGET);
    expect(registry.isCurrent({ ...TARGET, generation: 1 })).toBe(false);
    expect(
      registry.isCurrent({ ...TARGET, browserId: "browser-2", generation: 1 }),
    ).toBe(true);
  });

  it("lists only the surface that was asked for", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "Isolated", url: "https://one.test" });
    registry.observe({
      surface: "chrome",
      browserId: "browser-9",
      targetId: "tab-9",
      title: "Chrome",
      url: "https://two.test",
    });
    expect(registry.list("isolated-chromium")).toHaveLength(1);
    expect(registry.list("chrome")).toHaveLength(1);
    expect(registry.list("edge")).toHaveLength(0);
  });

  it("forgets a browser entirely when it is switched off", () => {
    const registry = new WebuiBrowserTargetRegistry();
    registry.observe({ ...TARGET, title: "One", url: "https://one.test" });
    registry.observe({
      ...TARGET,
      browserId: "browser-2",
      title: "Two",
      url: "https://two.test",
    });
    registry.forgetBrowser("isolated-chromium", "browser-1");
    expect(registry.list("isolated-chromium")).toHaveLength(1);
    expect(registry.resolve({ ...TARGET, generation: 1 })).toBeUndefined();
  });
});
