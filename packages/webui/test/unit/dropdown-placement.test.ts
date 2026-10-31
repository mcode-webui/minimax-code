// The shared dropdown's placement arithmetic.
//
// Every floating popup in the client is placed by these rules, and the rules
// are the part of a dropdown that a screenshot cannot check: a popup that
// opens on the wrong side of its trigger, one that lines up with the wrong
// edge, one that hangs off the side of the screen — all of them render, all
// of them look plausible, and all of them are wrong.
//
// So the arithmetic is here, as numbers, and it is tested as numbers. The
// anchors and the surfaces are the ones a real window produces: a 28px ring
// near the bottom of a column, a 320px menu under a 40px trigger, a 480px
// panel in a 240px rail.

import { describe, expect, it } from "vitest";

import {
  WEBUI_DROPDOWN_OFFSET,
  WEBUI_DROPDOWN_VIEWPORT_MARGIN,
  clampPointToViewport,
  placeWebuiDropdown,
} from "../../src/client/projection/common/dropdown-placement.js";

/** A 1209x1235 window, the size the context panel was reported at. */
const VIEWPORT = { width: 1209, height: 1235 };

/** A trigger on the bottom bar: 40px wide, 32px tall. */
const TRIGGER = { left: 800, top: 1180, width: 40, height: 32 };

/** A menu of the size the composer's palette is. */
const MENU = { width: 320, height: 240 };

describe("placeWebuiDropdown — the side the popup hangs from", () => {
  it("opens below the anchor by default, with the gap between them", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
    });

    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(TRIGGER.top + TRIGGER.height + WEBUI_DROPDOWN_OFFSET);
    expect(placed.left).toBe(TRIGGER.left);
  });

  it("opens above the anchor when told to, with its bottom edge clear of it", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      side: "top",
    });

    expect(placed.side).toBe("top");
    expect(placed.top).toBe(TRIGGER.top - WEBUI_DROPDOWN_OFFSET - MENU.height);
    // The popup's BOTTOM edge is the gap above the anchor's top edge.
    expect(placed.top + MENU.height).toBe(TRIGGER.top - WEBUI_DROPDOWN_OFFSET);
  });

  it("opens to the right of the anchor, aligned with its top edge", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      side: "right",
    });

    expect(placed.side).toBe("right");
    expect(placed.left).toBe(TRIGGER.left + TRIGGER.width + WEBUI_DROPDOWN_OFFSET);
    expect(placed.top).toBe(TRIGGER.top);
  });

  it("opens to the left of the anchor, with its right edge clear of it", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      side: "left",
    });

    expect(placed.left).toBe(TRIGGER.left - WEBUI_DROPDOWN_OFFSET - MENU.width);
    expect(placed.left + MENU.width).toBe(TRIGGER.left - WEBUI_DROPDOWN_OFFSET);
  });

  it("takes the gap from the caller when it is given one", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      offset: 8,
    });

    expect(placed.top).toBe(TRIGGER.top + TRIGGER.height + 8);
  });
});

describe("placeWebuiDropdown — the edge the popup lines up with", () => {
  it("aligns its start with the anchor's start", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      align: "start",
    });

    expect(placed.left).toBe(TRIGGER.left);
  });

  it("aligns its end with the anchor's end", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      align: "end",
    });

    expect(placed.left).toBe(TRIGGER.left + TRIGGER.width - MENU.width);
  });

  it("centres on the anchor", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      align: "center",
    });

    expect(placed.left).toBe(TRIGGER.left + (TRIGGER.width - MENU.width) / 2);
  });

  it("reads align vertically on a horizontal side", () => {
    // On a vertical side the alignment is horizontal; on a horizontal side it
    // is vertical. A fly-out that lined up with the anchor's left edge when it
    // opens to the right would be a fly-out hanging at the wrong height.
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      side: "right",
      align: "end",
    });

    expect(placed.top).toBe(TRIGGER.top + TRIGGER.height - MENU.height);
  });
});

describe("placeWebuiDropdown — how wide the popup is", () => {
  it("sizes to its own content by default", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
    });

    expect(placed.width).toBeUndefined();
    expect(placed.minWidth).toBeUndefined();
  });

  it("gives the popup at least the anchor's width", () => {
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      width: "match",
    });

    expect(placed.minWidth).toBe(`${TRIGGER.width}px`);
    expect(placed.width).toBeUndefined();
  });

  it("gives the popup exactly the anchor's width, and aligns against THAT width", () => {
    // The alignment is computed against the width the popup WILL have, not
    // against the one it happened to be measured at. A popup that is about to
    // be 40px wide and is aligned as if it were 320px wide ends up 280px to
    // the left of where it should be.
    const placed = placeWebuiDropdown({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      width: "anchor",
      align: "end",
    });

    expect(placed.width).toBe(`${TRIGGER.width}px`);
    expect(placed.left).toBe(TRIGGER.left + TRIGGER.width - TRIGGER.width);
  });
});

describe("placeWebuiDropdown — what happens when it does not fit", () => {
  it("flips to the other side when the one it asked for has no room", () => {
    // A trigger near the BOTTOM of the window cannot open a 240px menu below
    // it, but there is room above it — so the menu opens upwards instead.
    const anchor = { left: 800, top: 1100, width: 40, height: 32 };
    const placed = placeWebuiDropdown({
      anchor,
      surface: MENU,
      viewport: VIEWPORT,
      side: "bottom",
      collision: "flip",
    });

    expect(placed.side).toBe("top");
    expect(placed.top).toBe(anchor.top - WEBUI_DROPDOWN_OFFSET - MENU.height);
  });

  it("keeps the side it was given when the other one has no room either", () => {
    // A viewport too short for the menu on either side: the popup stays where
    // it was asked to go and is clamped, because a panel at the top margin is
    // still a panel the user can read.
    const placed = placeWebuiDropdown({
      anchor: { left: 800, top: 100, width: 40, height: 32 },
      surface: { width: 320, height: 900 },
      viewport: { width: 1209, height: 500 },
      side: "bottom",
      collision: "flip",
    });

    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(WEBUI_DROPDOWN_VIEWPORT_MARGIN);
  });

  it("clamps into the viewport without flipping", () => {
    const placed = placeWebuiDropdown({
      anchor: { left: 1190, top: 4, width: 19, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
      side: "bottom",
      collision: "clamp",
    });

    expect(placed.side).toBe("bottom");
    expect(placed.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - WEBUI_DROPDOWN_VIEWPORT_MARGIN);
    expect(placed.top).toBeGreaterThanOrEqual(WEBUI_DROPDOWN_VIEWPORT_MARGIN);
  });

  it("leaves the popup where it falls when no collision handling is asked for", () => {
    // `none` is what a popup that may hang off the right edge wants: it is
    // only ever kept off the LEFT edge, because a popup that starts at a
    // negative coordinate has its left half off screen for no reason.
    const placed = placeWebuiDropdown({
      anchor: { left: 1150, top: 4, width: 40, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
      side: "bottom",
      collision: "none",
    });

    expect(placed.left).toBe(1150);
  });

  it("never starts left of the margin", () => {
    const placed = placeWebuiDropdown({
      anchor: { left: -40, top: 100, width: 40, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
      collision: "none",
    });

    expect(placed.left).toBe(WEBUI_DROPDOWN_VIEWPORT_MARGIN);
  });
});

describe("clampPointToViewport — a point anchor", () => {
  it("leaves a point that is already inside alone", () => {
    expect(clampPointToViewport({ x: 300, y: 400 }, VIEWPORT)).toEqual({ x: 300, y: 400 });
  });

  it("pulls a point back inside the margin", () => {
    const clamped = clampPointToViewport({ x: -20, y: 5000 }, VIEWPORT);

    expect(clamped.x).toBe(WEBUI_DROPDOWN_VIEWPORT_MARGIN);
    expect(clamped.y).toBe(VIEWPORT.height - WEBUI_DROPDOWN_VIEWPORT_MARGIN);
  });
});
