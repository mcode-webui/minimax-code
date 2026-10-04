// The model picker's cascade (roadmap H, 模型选择器级联).
//
// Two halves, and the split is deliberate.
//
// The RULES are pure functions in `projection/model-picker-cascade.ts` and are
// driven directly below: when a click completes the selection, when controls are
// live versus previewed, and what Escape does from each tier. Those are the
// decisions that are easy to state and easy to get subtly wrong, so they are
// pinned as behaviour.
//
// The WIRING is pinned as source tripwires, for the same reason the source
// implementation pinned it: `WebuiModelPicker` is a component tree behind the
// runtime's model graph, and `renderToStaticMarkup` renders it with the menu
// CLOSED — so the cascade's shape cannot be observed by rendering it. A
// structural assertion is honest about that; pretending a rendered assertion
// covered it would not be. What the tripwires check is the shape decisions that
// the design turns on: one placement engine, no permanent settings column, and
// the context sizes listed IN PLACE rather than behind a third tier.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  escapeOutcome,
  isPreview,
  modelHasSettings,
  rowClickOutcome,
  thinkingCommitOutcome,
  tierAfterRowClick,
} from "../../src/client/projection/model-picker-cascade.js";
import {
  FLYOUT_ANCHOR_GAP,
  flyoutStyle,
  positionFlyout,
} from "../../src/client/projection/flyout-position.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const componentDir = path.resolve(here, "../../src/client/components");

function readComponent(file: string): string {
  return readFileSync(path.join(componentDir, file), "utf8");
}

function entry(over: Partial<WebuiModelPickerEntry> = {}): WebuiModelPickerEntry {
  return { providerId: "minimax_api", modelId: "MiniMax-M3", ...over };
}

const WITH_SETTINGS = entry({
  effortOptions: ["default", "on", "off"],
  contextWindowOptions: [200_000, 1_000_000],
});
const WITH_NO_SETTINGS = entry();

describe("cascade — a model's own settings decide whether a click finishes", () => {
  it("treats a model with nothing to configure as complete on its click", () => {
    // There is nothing left to visit, so keeping the surface open would strand
    // the user on a menu they have finished with.
    expect(modelHasSettings(WITH_NO_SETTINGS)).toBe(false);
    expect(rowClickOutcome(WITH_NO_SETTINGS)).toBe("close");
    expect(tierAfterRowClick(WITH_NO_SETTINGS)).toBe("list");
  });

  it("treats a model with settings as advancing to the second tier", () => {
    expect(modelHasSettings(WITH_SETTINGS)).toBe(true);
    expect(rowClickOutcome(WITH_SETTINGS)).toBe("advance");
    expect(tierAfterRowClick(WITH_SETTINGS)).toBe("settings");
  });

  it("counts either control as settings on its own", () => {
    expect(modelHasSettings(entry({ effortOptions: ["on"] }))).toBe(true);
    expect(modelHasSettings(entry({ contextWindowOptions: [1_000] }))).toBe(true);
  });

  it("counts an EMPTY options list as nothing to configure", () => {
    // `length > 0`, not mere presence: an empty array is a control with no
    // options in it, and offering the user a second tier for one is the same
    // strand the close rule exists to prevent.
    expect(modelHasSettings(entry({ effortOptions: [] }))).toBe(false);
    expect(modelHasSettings(entry({ contextWindowOptions: [] }))).toBe(false);
  });

  it("has no model to describe as nothing to configure", () => {
    expect(modelHasSettings(undefined)).toBe(false);
    expect(rowClickOutcome(undefined)).toBe("close");
  });
});

describe("cascade — the thinking switch does not finish the visit", () => {
  it("keeps the surface open so a window can still be set", () => {
    // The context sizes are listed in the same fly-out, so closing on a level
    // would make it impossible to set a level and a window in one visit, which
    // is the ordinary thing a user does on opening a model's settings at all.
    expect(thinkingCommitOutcome()).toBe("keep-open");
  });
});

describe("cascade — an unpicked model's controls are a preview", () => {
  it("previews whenever the focused row is not the active model", () => {
    expect(isPreview("a/b/", "a/b/")).toBe(false);
    expect(isPreview("a/b/", "c/d/")).toBe(true);
  });

  it("previews when nothing is focused or nothing is selected", () => {
    // The recorded settings belong to the ACTIVE model. With no active model
    // there is no record to be consistent with, so the safe answer is preview.
    expect(isPreview(undefined, "a/b/")).toBe(true);
    expect(isPreview("a/b/", undefined)).toBe(true);
    expect(isPreview(undefined, undefined)).toBe(true);
  });
});

describe("cascade — Escape backs out one tier at a time", () => {
  it("retracts an open fly-out before it closes the menu", () => {
    // A single Escape that closed everything would throw away the list
    // position the user had built up, which is the part that took effort.
    expect(escapeOutcome("settings")).toBe("retract-tier");
    expect(escapeOutcome("list")).toBe("close-menu");
  });
});

describe("fly-out placement — one engine, so the tiers cannot disagree", () => {
  const anchor = { left: 100, top: 200, width: 280, height: 32 };
  const surface = { width: 208, height: 236 };
  const roomy = { width: 1400, height: 900 };

  it("opens to the RIGHT by default, aligned to the anchor's top", () => {
    // The cascade reads left-to-right and the list sits on the left of the
    // menu, so right is where the eye already is. Top alignment rather than
    // vertical centring: the surface is taller than a row, and centring pushes
    // its first control below the pointer that opened it.
    const placement = positionFlyout({ anchor, surface, viewport: roomy });
    expect(placement.side).toBe("right");
    expect(placement.left).toBe(100 + 280 + FLYOUT_ANCHOR_GAP);
    expect(placement.top).toBe(200);
  });

  it("flips LEFT when the list is near the right edge", () => {
    const placement = positionFlyout({
      anchor: { left: 1150, top: 200, width: 240, height: 32 },
      surface,
      viewport: roomy,
    });
    expect(placement.side).toBe("left");
    expect(placement.left).toBe(1150 - FLYOUT_ANCHOR_GAP - surface.width);
  });

  it("falls back to BELOW only when neither side has room", () => {
    // A narrow viewport can have room beside the row and none under it, and
    // that is deliberate: a surface that cannot be seen at all is worse than
    // one covering the row.
    const narrow = { width: 300, height: 800 };
    const placement = positionFlyout({
      anchor: { left: 20, top: 200, width: 260, height: 32 },
      surface,
      viewport: narrow,
    });
    expect(placement.side).toBe("below");
  });

  it("clamps so the surface is fully on screen even when the anchor is not", () => {
    // A scrolled list can put a row under the viewport edge. An unclamped
    // surface would be unreachable there.
    const placement = positionFlyout({
      anchor: { left: 20, top: 880, width: 260, height: 32 },
      surface,
      viewport: roomy,
    });
    expect(placement.top).toBeLessThanOrEqual(roomy.height - surface.height);
    expect(placement.left).toBeGreaterThanOrEqual(0);
  });

  it("never returns a negative coordinate for a negative anchor", () => {
    const placement = positionFlyout({
      anchor: { left: -400, top: -40, width: 260, height: 32 },
      surface,
      viewport: roomy,
    });
    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.top).toBeGreaterThanOrEqual(0);
  });

  it("places identically for a surface bigger than the viewport", () => {
    // max < min would make clamp invert; the surface still has to land on a
    // usable coordinate rather than NaN.
    const placement = positionFlyout({
      anchor,
      surface: { width: 2000, height: 2000 },
      viewport: roomy,
    });
    expect(Number.isFinite(placement.left)).toBe(true);
    expect(Number.isFinite(placement.top)).toBe(true);
    expect(placement.left).toBeGreaterThanOrEqual(0);
  });

  it("emits fixed positioning, not transform-based", () => {
    // The menu animates its own panels; a transform here would fight that.
    expect(flyoutStyle({ left: 10, top: 20, side: "right" })).toEqual({
      position: "fixed",
      left: "10px",
      top: "20px",
    });
  });
});

describe("cascade — the shape the source has to keep", () => {
  const picker = readComponent("ModelPicker.tsx");
  const flyout = readComponent("ModelSettingsFlyout.tsx");

  it("has no permanent settings column left in the menu", () => {
    // The whole point of the cascade. A `webui-model-menu-detail` element is
    // the permanent right column this replaced, and its return is the exact
    // shape the two reference screenshots do NOT show.
    expect(picker).not.toContain("webui-model-menu-detail");
    expect(picker).not.toContain("webui-model-menu--two-column");
  });

  it("renders the cascade's single column", () => {
    expect(picker).toContain("webui-model-menu--cascade");
  });

  it("mounts the fly-out instead of an in-menu panel", () => {
    expect(picker).toContain("ModelSettingsFlyout");
  });

  it("drives its one surface through the one placement hook", () => {
    // Counted as "one definition, one call site" so a second copy of the
    // flip/clamp math is caught. With the third tier gone there is exactly one
    // caller left, and the count is what says so.
    expect(flyout.match(/function useFlyoutPlacement\(/gu) ?? []).toHaveLength(1);
    expect(flyout.match(/= useFlyoutPlacement\(/gu) ?? []).toHaveLength(1);
    // And the hook itself delegates to the one shared arithmetic module.
    expect(flyout.match(/positionFlyout\(/gu) ?? []).toHaveLength(1);
  });

  it("measures the surface instead of declaring its size", () => {
    // The context sizes are inline, so the fly-out is as tall as the model
    // happens to have options. A frozen height means the clamp is computed
    // against a size that is not the one on screen, and a model with a long
    // option list loses its own options off the bottom of the viewport.
    expect(flyout).not.toMatch(/const TIER_(ONE|TWO)_(WIDTH|HEIGHT)/u);
    expect(flyout).toContain("ResizeObserver");
    expect(flyout).toContain("surface.getBoundingClientRect()");
  });

  it("lists the context sizes in place, not behind a third fly-out", () => {
    // The whole point of this shape. The surface already says which model it
    // describes, so a collapsed row restating the current value, a chevron over
    // it, and then a separate panel carrying the same sizes are three ways to
    // answer one question — and that panel was a floating surface landing back
    // over the model list it was describing. The literal greps cover COMMENTS
    // too, which is the point: a retired class named in prose is how it comes
    // back.
    expect(flyout).toContain('role="listbox"');
    expect(flyout).toContain('role="option"');
    expect(flyout).not.toContain('data-webui-model-flyout="tier-two"');
    expect(flyout).not.toContain("webui-model-flyout--tier-two");
    expect(flyout).not.toContain("webui-model-context-trigger");
    expect(flyout).not.toContain("webui-model-context-caret");
    expect(flyout).not.toContain("aria-expanded");
    expect(flyout).not.toContain("menuitemradio");
  });

  it("keeps the list container from being duplicated", () => {
    // The list is rendered from one place; a second copy would be a second
    // scroll container inside the same menu.
    expect(picker.match(/WebuiModelMenuList/g) ?? []).toHaveLength(2);
  });
});
