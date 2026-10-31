// The overlay geometry both fixed overlays place against (U12).
//
// `flyout-position.ts` and `context-usage-popover.ts` each carried their own
// copy of the clamp and their own identical rect shape. The copies were the
// same code, so this file pins the RULE rather than either copy's arithmetic:
// a box that fits is kept fully inside the viewport with the margin at both
// ends, and a box that cannot fit is pinned to the near edge instead of being
// pushed off it.
//
// The strategies stay where they are and are checked as properties here —
// which side the fly-out picks, which edge the panel aligns to — because those
// are the parts the two modules deliberately do not share.
import { describe, expect, it } from "vitest";

import {
  clampOverlayToViewport,
  overlayAxisStart,
} from "../../src/client/projection/common/overlay-geometry.js";
import { positionFlyout } from "../../src/client/projection/common/flyout-position.js";
import { positionContextUsagePopover } from "../../src/client/features/composer/projection/context-usage-popover.js";

const MARGIN = 8;

describe("clampOverlayToViewport", () => {
  it("leaves a value inside the range alone", () => {
    expect(clampOverlayToViewport(50, 0, 100)).toBe(50);
  });

  it("pulls a value below the range up to the minimum", () => {
    expect(clampOverlayToViewport(-40, 0, 100)).toBe(0);
  });

  it("pulls a value above the range down to the maximum", () => {
    expect(clampOverlayToViewport(400, 0, 100)).toBe(100);
  });

  it("answers with the minimum when the range is inverted", () => {
    // An inverted range is "no room", and the near edge is the usable answer.
    // Returning the raw value here would put the box outside the viewport.
    expect(clampOverlayToViewport(300, 100, 20)).toBe(100);
  });
});

describe("overlayAxisStart", () => {
  it("keeps a box that fits inside the viewport with the margin at both ends", () => {
    for (const viewportSize of [200, 480, 1024, 2560]) {
      for (const size of [80, 240, 320]) {
        if (viewportSize - size - 2 * MARGIN < 0) continue;
        for (const raw of [-500, 0, 40, viewportSize / 2, viewportSize + 500]) {
          const start = overlayAxisStart(raw, size, viewportSize, MARGIN);
          expect(start).toBeGreaterThanOrEqual(MARGIN);
          expect(start + size).toBeLessThanOrEqual(viewportSize - MARGIN);
        }
      }
    }
  });

  it("pins a box that cannot fit to the margin rather than off the edge", () => {
    // 300 + 2*8 > 200: the range is inverted, and the answer must stay a
    // coordinate the reader can still see.
    expect(overlayAxisStart(0, 300, 200, MARGIN)).toBe(MARGIN);
  });
});

describe("the two overlays keep their box inside the viewport", () => {
  const viewports = [
    { width: 1280, height: 900 },
    { width: 900, height: 500 },
    { width: 640, height: 360 },
  ];

  it("places the model fly-out inside, on every side", () => {
    for (const viewport of viewports) {
      for (const anchor of [
        { left: 0, top: 0, width: 240, height: 36 },
        { left: viewport.width - 250, top: 0, width: 240, height: 36 },
        { left: 300, top: viewport.height - 40, width: 240, height: 36 },
        { left: 60, top: viewport.height / 2, width: 240, height: 36 },
      ]) {
        const surface = { width: 320, height: 300 };
        const placement = positionFlyout({ anchor, surface, viewport });
        if (viewport.width - surface.width - 2 * MARGIN >= 0) {
          expect(placement.left).toBeGreaterThanOrEqual(MARGIN);
          expect(placement.left + surface.width).toBeLessThanOrEqual(
            viewport.width - MARGIN,
          );
        }
        if (viewport.height - surface.height - 2 * MARGIN >= 0) {
          expect(placement.top).toBeGreaterThanOrEqual(MARGIN);
          expect(placement.top + surface.height).toBeLessThanOrEqual(
            viewport.height - MARGIN,
          );
        }
      }
    }
  });

  it("picks the side by which one has room, and falls back to below", () => {
    const surface = { width: 320, height: 300 };
    const roomy = { width: 1280, height: 900 };
    const anchor = { left: 200, top: 100, width: 240, height: 36 };

    expect(positionFlyout({ anchor, surface, viewport: roomy }).side).toBe("right");
    expect(
      positionFlyout({
        anchor: { ...anchor, left: roomy.width - 250 },
        surface,
        viewport: roomy,
      }).side,
    ).toBe("left");
    expect(
      positionFlyout({
        anchor: { ...anchor, left: roomy.width - 250 },
        surface: { width: roomy.width - 100, height: 300 },
        viewport: roomy,
      }).side,
    ).toBe("below");
  });

  it("aligns the context-usage panel's right edge to the ring, then clamps", () => {
    const surface = { width: 480, height: 260 };
    const viewport = { width: 1280, height: 900 };
    const anchor = { left: 700, top: 700, width: 40, height: 40 };

    const placement = positionContextUsagePopover({ anchor, surface, viewport });
    // Right edges aligned, and it opens above rather than below.
    expect(placement.left + surface.width).toBe(anchor.left + anchor.width + 4);
    expect(placement.top + surface.height).toBeLessThanOrEqual(anchor.top);
  });
});
