// The layout threshold contract (ADR 0025).
//
// The thresholds live in `client/ui/layout-thresholds.ts` and in the stylesheet.
// A container or media query condition cannot use `var()`, so the two surfaces
// necessarily hold a copy of each number — and this file is what keeps the
// copies equal.
//
// Why it matters: a threshold that drifts is a layout that breaks quietly. The
// stylesheet would change the panel's form at one width while the resize logic
// kept clamping against another, and the two would disagree exactly where the
// disagreement hurts — at the boundary, where the space is already tight. The
// assertions below read the SOURCE stylesheets, so they do not depend on
// `pnpm build:styles` having run.
//
// The contract has one idea behind it: the surface's width is a budget, and
// the regions spend it in a fixed order. The conversation column keeps a
// floor; the tool regions give way instead. So most of the thresholds are not
// preferences at all — they are the sums of the floors they protect, and the
// assertions below say so.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBUI_LAYOUT_THRESHOLDS,
  WEBUI_PROGRESS_PANEL_NARROW_QUERY,
  webuiOverlayPanelWidth,
  webuiPanelWidthBounds,
  webuiRailIsDrawer,
  webuiSurfaceTier,
} from "../../src/client/ui/layout-thresholds.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(packageDir, relative), "utf8");

const layoutCss = read("src/client/styles/layout.css");
const composerCss = read("src/client/features/composer/ui/composer.css");
const modelsCss = read("src/client/features/models/ui/models.css");
const workspaceCss = read("src/client/features/workspace/ui/workspace.css");
const workspaceProgressCss = read("src/client/features/workspace/ui/workspace-progress.css");

/** The value of a custom property, in the layout contract's own stylesheet. */
function customProperty(name: string): string | undefined {
  const match = layoutCss.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`, "u"));
  return match ? match[1].trim() : undefined;
}

/** The pixel value of a custom property, when it is a plain length. */
function customPropertyPx(name: string): number | undefined {
  const value = customProperty(name);
  if (value === undefined) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)px$/u);
  return match ? Number(match[1]) : undefined;
}

describe("the layout threshold contract", () => {
  it("states the thresholds the stylesheet and the resize logic both read", () => {
    expect(WEBUI_LAYOUT_THRESHOLDS).toEqual({
      shellCompact: 640,
      conversationMin: 320,
      surfaceSplit: 680,
      panelMin: 360,
      panelOverlayMax: 560,
      composerModelIcon: 360,
      composerPermissionIcon: 272,
      progressPanelMinWidth: 1080,
    });
  });

  it("keeps the stylesheet's custom properties equal to the module's constants", () => {
    // Every threshold that the stylesheet reads as a length lives in a custom
    // property, because a property value may use `var()` where a query
    // condition may not.
    const expectations: readonly (readonly [string, number])[] = [
      ["webui-shell-compact", WEBUI_LAYOUT_THRESHOLDS.shellCompact],
      ["webui-surface-split", WEBUI_LAYOUT_THRESHOLDS.surfaceSplit],
      ["webui-conversation-min", WEBUI_LAYOUT_THRESHOLDS.conversationMin],
      ["webui-panel-min", WEBUI_LAYOUT_THRESHOLDS.panelMin],
      ["webui-panel-overlay-max", WEBUI_LAYOUT_THRESHOLDS.panelOverlayMax],
      ["webui-composer-model-icon", WEBUI_LAYOUT_THRESHOLDS.composerModelIcon],
      ["webui-composer-permission-icon", WEBUI_LAYOUT_THRESHOLDS.composerPermissionIcon],
    ];
    for (const [name, expected] of expectations) {
      expect(customPropertyPx(name), `--${name} in layout.css`).toBe(expected);
    }
  });

  it("keeps the stylesheet's query conditions equal to the module's constants", () => {
    // The composer's two narrow forms are the thresholds a query condition has
    // to spell out, because a container condition cannot read a custom
    // property. They live in the two stylesheets that own the controls: the
    // composer's own permission control, and the model trigger.
    expect(composerCss).toContain(
      `@container webui-composer (max-width: ${WEBUI_LAYOUT_THRESHOLDS.composerPermissionIcon - 1}px)`,
    );
    expect(modelsCss).toContain(
      `@container webui-composer (max-width: ${WEBUI_LAYOUT_THRESHOLDS.composerModelIcon - 1}px)`,
    );
  });

  it("narrows the model name before the permission label", () => {
    // The order is the contract: the model name is the variable-length thing
    // and gives up its text first; the permission label is the fixed one and
    // keeps its words as long as it can.
    expect(WEBUI_LAYOUT_THRESHOLDS.composerModelIcon)
      .toBeGreaterThan(WEBUI_LAYOUT_THRESHOLDS.composerPermissionIcon);
    expect(modelsCss.indexOf("max-width: 359px")).toBeGreaterThan(-1);
  });

  it("reads the panel's floor and cap from the contract rather than from literals", () => {
    // A literal here would be a third copy of a number the module already owns.
    expect(workspaceCss).toContain("min-width: var(--webui-panel-min)");
    expect(workspaceCss).toContain("max-width: calc(100% - var(--webui-conversation-min))");
    expect(workspaceCss).toContain("width: min(100%, var(--webui-panel-overlay-max))");
    expect(workspaceCss).not.toMatch(/min-width:\s*360px/u);
  });
});

describe("the surface tier", () => {
  it("is a column beside the conversation only when the surface can hold both floors", () => {
    expect(webuiSurfaceTier(WEBUI_LAYOUT_THRESHOLDS.surfaceSplit)).toBe("split");
    expect(webuiSurfaceTier(WEBUI_LAYOUT_THRESHOLDS.surfaceSplit - 1)).toBe("overlay");
    expect(webuiSurfaceTier(1440)).toBe("split");
    expect(webuiSurfaceTier(320)).toBe("overlay");
  });

  it("splits at the sum of the two floors", () => {
    // The threshold is not a preference: the column form needs the panel's
    // floor and the conversation's floor at the same time. The two columns are
    // flush against each other and separated by a hairline rather than by a
    // gutter, so there is no gutter to count.
    expect(WEBUI_LAYOUT_THRESHOLDS.surfaceSplit).toBe(
      WEBUI_LAYOUT_THRESHOLDS.panelMin + WEBUI_LAYOUT_THRESHOLDS.conversationMin,
    );
  });
});

describe("the panel's width bounds", () => {
  it("never lets the panel claim the space the conversation column needs", () => {
    const bounds = webuiPanelWidthBounds(1000);
    expect(bounds.max).toBe(1000 - WEBUI_LAYOUT_THRESHOLDS.conversationMin);
    expect(bounds.min).toBe(WEBUI_LAYOUT_THRESHOLDS.panelMin);
  });

  it("meets the two bounds where the surface cannot hold even the panel's floor", () => {
    const bounds = webuiPanelWidthBounds(WEBUI_LAYOUT_THRESHOLDS.conversationMin + 10);
    expect(bounds.max).toBe(10);
    expect(bounds.min).toBe(10);
  });

  it("never reports a negative width for a surface that is gone", () => {
    const bounds = webuiPanelWidthBounds(0);
    expect(bounds.min).toBe(0);
    expect(bounds.max).toBe(0);
  });
});

describe("the overlay's width", () => {
  it("covers the surface up to the cap and never exceeds it", () => {
    expect(webuiOverlayPanelWidth(320)).toBe(320);
    expect(webuiOverlayPanelWidth(WEBUI_LAYOUT_THRESHOLDS.panelOverlayMax)).toBe(
      WEBUI_LAYOUT_THRESHOLDS.panelOverlayMax,
    );
    expect(webuiOverlayPanelWidth(1200)).toBe(WEBUI_LAYOUT_THRESHOLDS.panelOverlayMax);
  });
});

describe("the rail's drawer threshold", () => {
  it("is a drawer below the compact width and a column at it", () => {
    expect(webuiRailIsDrawer(WEBUI_LAYOUT_THRESHOLDS.shellCompact - 1)).toBe(true);
    expect(webuiRailIsDrawer(WEBUI_LAYOUT_THRESHOLDS.shellCompact)).toBe(false);
    expect(webuiRailIsDrawer(1440)).toBe(false);
  });
});

describe("the progress panel keeps the form it always had", () => {
  it("is still a card floating over the conversation's right edge", () => {
    // The progress panel is not part of the threshold contract. It is a card
    // that floats over the conversation and is anchored to the window, so its
    // width is the window's business — the same rule the viewport-anchored
    // overlays follow.
    expect(workspaceProgressCss).toContain("position: fixed");
    expect(workspaceProgressCss).toContain("top: 72px");
    expect(workspaceProgressCss).toContain("right: 12px");
    expect(workspaceProgressCss).toContain("border-radius: 16px");
    expect(workspaceProgressCss).toContain("max-width: min(288px, calc(100vw - 24px))");
  });

  it("keeps the gutter that gives the card a place of its own", () => {
    // The card lands in a gutter the conversation keeps for it, so the card
    // does not sit on top of the text. Below the contract's width the
    // conversation cannot spare the gutter, so the panel closes itself rather
    // than floating over the conversation's corner.
    expect(workspaceCss).toContain("padding-right: 312px");
    expect(workspaceCss).toContain(
      `@media (max-width: ${WEBUI_LAYOUT_THRESHOLDS.progressPanelMinWidth - 1}px)`,
    );
  });

  it("closes itself at the same width the gutter ends", () => {
    // The panel's card and the gutter it lives in are one decision: the card
    // may only be open where the gutter is there to hold it. If the two read
    // different numbers, the card opens exactly where it has no place of its
    // own and covers the text it is meant to report on.
    expect(WEBUI_PROGRESS_PANEL_NARROW_QUERY).toBe(
      `(max-width: ${WEBUI_LAYOUT_THRESHOLDS.progressPanelMinWidth - 1}px)`,
    );
    expect(workspaceCss).toContain(
      `@media ${WEBUI_PROGRESS_PANEL_NARROW_QUERY}`,
    );
  });
});
