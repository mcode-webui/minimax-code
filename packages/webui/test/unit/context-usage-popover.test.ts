// The composer's context-usage panel placement (roadmap H, 模型与用量).
//
// Caught on the running app, and this file exists because the cause was neither
// of the two the symptom invited.
//
// The panel is 480px wide and right-aligned to a ring about a third of the way
// across the session column, so it reaches left past the column's edge — and on
// a 240px rail that is the heading, the token figures and every plan meter's
// label gone, with the rail showing through exactly where they were.
//
// The tempting reading is a stacking problem, because the rail carries `z-50`
// and the panel `z-60`, and 60 does beat 50 — in the same stacking context. It
// is not the same stacking context. The composer sits inside
// `.webui-session-composer-overlay`, a positioned element with a z-index, which
// is a stacking context in its own right; everything the composer opens is
// ranked inside it and cannot outrank the rail outside it however high it says.
// Raising the panel to 1000 changed nothing on screen, which is what a trapped
// context looks like and what a missing one never looks like.
//
// The other half is a clip, and it is independent: the panel was `absolute`
// inside a column that is `overflow: hidden`, so it was cut there too. Geometry
// is what this file pins — the clip is fixed by `position: fixed`, and the
// occlusion by the overlay's own rule in the sheet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_POPOVER_EDGE_OFFSET,
  contextUsagePopoverStyle,
  positionContextUsagePopover,
  sameContextUsagePlacement,
} from "../../src/client/projection/context-usage-popover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../src/client");

function readClient(relative: string): string {
  return readFileSync(path.join(clientDir, relative), "utf8");
}

/** A 1209x1235 window, the size the bug was reported at. */
const VIEWPORT = { width: 1209, height: 1235 };

/**
 * The ring in that window: 28px control, right edge 588, top 1172.
 *
 * Real numbers rather than round ones, because the bug is arithmetic: 588 + 4
 * minus a 480px panel is 112, and 112 is left of the 240px rail. That single
 * subtraction is the whole defect.
 */
const RING = { left: 560, top: 1172, width: 28, height: 28 };

/** The panel as it renders closed: three rows of figures. */
const PANEL = { width: 480, height: 236 };

/** …and with the disclosure open, which adds six breakdown rows. */
const PANEL_OPEN = { width: 480, height: 452 };

describe("context-usage panel — placed from the ring, not from CSS offsets", () => {
  it("opens above the ring with the right edges aligned", () => {
    const placement = positionContextUsagePopover({
      anchor: RING,
      surface: PANEL,
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(RING.left + RING.width + CONTEXT_POPOVER_EDGE_OFFSET - PANEL.width);
    expect(placement.top).toBe(RING.top - 8 - PANEL.height);
  });

  it("reaches LEFT of the rail, which is the point — it is not inside the column", () => {
    // 112 < 240. The panel deliberately overlaps the rail, so the rail's
    // opacity cannot be what hides part of it: the old clipping did, and the
    // only way to be free of it is to stop being laid out inside the column.
    const placement = positionContextUsagePopover({
      anchor: RING,
      surface: PANEL,
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(112);
    expect(placement.left).toBeLessThan(240);
    // …and the whole panel is still on screen, which is what clamping buys.
    expect(placement.left + PANEL.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it("moves UP when the disclosure adds rows, rather than pushing them off screen", () => {
    const closed = positionContextUsagePopover({ anchor: RING, surface: PANEL, viewport: VIEWPORT });
    const open = positionContextUsagePopover({
      anchor: RING,
      surface: PANEL_OPEN,
      viewport: VIEWPORT,
    });

    // A taller panel has to start higher or its last row leaves the window —
    // which is the reason the surface is measured rather than assumed.
    expect(open.top).toBeLessThan(closed.top);
    expect(open.left).toBe(closed.left);
  });

  it("clamps against the RIGHT edge when the ring is near it", () => {
    // The ring's own right edge is already past the viewport's, so the raw
    // placement would hang the panel off the window. A ring merely NEAR the edge
    // does not need the clamp: its right edge is still on screen, and moving the
    // panel inward to the margin would be the clamp inventing a problem.
    const placement = positionContextUsagePopover({
      anchor: { left: 1190, top: 1172, width: 28, height: 28 },
      surface: PANEL,
      viewport: VIEWPORT,
    });

    expect(placement.left + PANEL.width).toBe(VIEWPORT.width - 8);
  });

  it("stays at the top margin when the panel cannot fit above the ring", () => {
    // No flip downwards: the ring is pinned to the bottom of the column, so
    // "above" is the only side that is ever right, and a panel the user can read
    // beats one covering the control they just pressed.
    const placement = positionContextUsagePopover({
      anchor: { left: 560, top: 300, width: 28, height: 28 },
      surface: { width: 480, height: 900 },
      viewport: { width: 1209, height: 1000 },
    });

    expect(placement.top).toBe(8);
  });

  it("clamps rather than inverting when the panel is wider than the window", () => {
    // `clamp` returns its minimum when there is no valid range, so a panel wider
    // than the viewport lands at the margin rather than at a negative left.
    const placement = positionContextUsagePopover({
      anchor: RING,
      surface: { width: 1600, height: 236 },
      viewport: VIEWPORT,
    });

    expect(placement.left).toBe(8);
  });

  it("emits fixed left/top and nothing else", () => {
    // `fixed` is what escapes the column's `overflow: hidden`. `right`/`bottom`
    // must NOT reappear: with a viewport-sized panel they would win over a
    // measured `left` and put it back against the window edge.
    expect(contextUsagePopoverStyle({ left: 112, top: 928 })).toEqual({
      position: "fixed",
      left: "112px",
      top: "928px",
    });
  });

  it("treats an unchanged measurement as no change at all", () => {
    // The measure runs on every render while the panel is open, so without this
    // each measurement would schedule a render that measures again.
    const a = { left: 112, top: 928 };
    const b = { left: 112, top: 928 };

    expect(sameContextUsagePlacement(a, b)).toBe(true);
    expect(sameContextUsagePlacement(a, a)).toBe(true);
    expect(sameContextUsagePlacement(a, { left: 112, top: 700 })).toBe(false);
    expect(sameContextUsagePlacement(undefined, undefined)).toBe(true);
    expect(sameContextUsagePlacement(a, undefined)).toBe(false);
    expect(sameContextUsagePlacement(undefined, a)).toBe(false);
  });
});

describe("context-usage panel — the shape the source has to keep", () => {
  const css = readClient("styles/shell.css");
  const composer = readClient("components/SessionComposer.tsx");
  // The panel's OWN declaration block and nothing after it. Slicing to the end of
  // the sheet would match every later rule, including rules that have nothing to
  // do with this panel — which is how a tripwire starts passing for the wrong
  // reason and then failing for the right one.
  const start = css.indexOf(".webui-context-usage-popover {");
  const popoverRule = css.slice(start, css.indexOf("}", start) + 1);

  it("is positioned fixed, so the column's overflow cannot clip it", () => {
    expect(popoverRule).toMatch(/\.webui-context-usage-popover \{ position: fixed;/u);
  });

  it("has an overlay that outranks the rail, because the panel is inside it", () => {
    // The half of the bug no amount of measuring could reach. The panel's own
    // z-index is only ever compared inside the composer's overlay, so the
    // overlay is what has to clear the rail's z-50 — and it used to sit at 20,
    // which is how a panel at 60 was still underneath it.
    const overlayStart = css.indexOf(".webui-session-layout .webui-session-composer-overlay {");
    expect(overlayStart).toBeGreaterThan(-1);
    const overlay = css.slice(overlayStart, css.indexOf("}", overlayStart) + 1);
    const zIndex = Number(/z-index:\s*([0-9]+)/u.exec(overlay)?.[1]);
    // The rail's layer, from the `z-50` on the aside in
    // `WebuiClientFoundationApp.tsx`. Compared by NUMBER because a z-index
    // written inside a stacking context is a claim, not a fact.
    expect(zIndex).toBeGreaterThan(50);
  });

  it("carries no CSS offset that could override the measured placement", () => {
    // These two are half the bug. They resolve against the nearest POSITIONED
    // ancestor, not against the ring, and a viewport-wide panel laid out that
    // way is a panel that leaves its column.
    expect(popoverRule).not.toContain("right: -4px");
    expect(popoverRule).not.toContain("bottom: calc(100%");
  });

  it("keeps its width on the viewport rather than the column", () => {
    // The panel is free to sit over the rail; that is what makes it a panel and
    // not a card, and a width capped to the column would re-clip it.
    expect(popoverRule).toContain("width: min(480px, calc(100vw - 32px))");
  });

  it("takes its coordinates from a measurement of the ring and the panel", () => {
    expect(composer).toContain("anchor: anchor.getBoundingClientRect()");
    expect(composer).toContain("surface: { width: rect.width, height: rect.height }");
    expect(composer).toContain("viewport: { width: window.innerWidth, height: window.innerHeight }");
    expect(composer).toContain("style={placement ? contextUsagePopoverStyle(placement) : undefined}");
  });

  it("re-measures while open, and follows the ring when the column scrolls", () => {
    // The panel is fixed and the composer is not, so a scroll that moves one and
    // not the other leaves the panel pointing at nothing.
    expect(composer).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(open\) measurePanel\(\);/u);
    expect(composer).toContain('window.addEventListener("scroll", measurePanel, true)');
    expect(composer).toContain('window.addEventListener("resize", measurePanel)');
  });
});
