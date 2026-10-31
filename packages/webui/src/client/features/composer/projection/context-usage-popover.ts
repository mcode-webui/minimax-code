/**
 * Fixed-viewport placement for the composer's context-usage panel.
 *
 * The sibling of `flyout-position.ts`, and it exists for the same reason: an
 * overlay has to escape the surface that happens to contain it, and `fixed` is
 * how that is spelled when the container scrolls or clips.
 *
 * This panel was cut in half by two separate mechanisms at once, and naming both
 * is the point of this file — fixing either one alone leaves the user looking at
 * a panel with no heading.
 *
 * The CLIP: the panel was `absolute` inside the session column, which is
 * `overflow: hidden`, and the panel is 480px wide and right-aligned to a ring
 * about a third of the way across that column. It reaches left past the column's
 * edge, and the clip takes the rest.
 *
 * The OCCLUSION: the composer sits in `.webui-session-composer-overlay`, which is
 * a positioned element with a z-index, so it is a STACKING CONTEXT. The rail is
 * outside it at z-50 and the overlay is at z-20, so everything the composer opens
 * was ranked below the rail no matter what z-index it carried. Raising the panel
 * to 1000 changed nothing at all, which is the signature of a trapped context
 * rather than a missing one — and the reason the clip is only half the story and
 * the other half lives in the sheet, not here.
 *
 * What is left for this module is geometry: the panel is `fixed`, so its
 * coordinates are viewport coordinates, and something has to supply them.
 *
 * `surface` is MEASURED by the caller, never a constant, for the reason the
 * sibling gives: the panel grows by six breakdown rows when the disclosure is
 * opened, and a clamp computed against the closed height lets the last row fall
 * off screen.
 *
 * The rect shape and the clamp-into-the-viewport rule come from
 * `overlay-geometry.ts`, which this module shares with the model fly-out.
 */

import {
  overlayAxisStart,
  type OverlayRect,
} from "../../../projection/common/overlay-geometry.js";

/**
 * A rectangle in viewport space, the same shape the fly-out anchor reports.
 * It is that shared rect; the alias is kept because the composer names it in
 * its own props.
 */
export type PopoverAnchorRect = OverlayRect;

export interface ContextUsagePlacement {
  readonly left: number;
  readonly top: number;
  /**
   * The side the panel opened on.
   *
   * The panel opens ABOVE the ring, always: the ring is at the bottom of the
   * composer and the panel is a tall one. The shared layer needs the side for
   * the motion, which has to slide the panel the way it came — up from below,
   * not down from above.
   */
  readonly side: "top";
}

/** Space kept between the panel and the viewport edge, in px. */
export const CONTEXT_POPOVER_VIEWPORT_MARGIN = 8;

/** Space between the ring and the panel's bottom edge, in px. */
export const CONTEXT_POPOVER_ANCHOR_GAP = 8;

/**
 * How far the panel's RIGHT edge sits past the ring's right edge, in px.
 *
 * The old `right: -4px`, kept so the panel does not shift sideways when this
 * starts placing it. It is a nudge, not a rule, and it is named so that nobody
 * later reads it as alignment.
 */
export const CONTEXT_POPOVER_EDGE_OFFSET = 4;

/**
 * Place the panel ABOVE the ring, right edges aligned, clamped into the viewport.
 *
 * There is no side to choose, and that is the whole difference from the model
 * fly-out. The ring is in the composer, which is pinned to the bottom of the
 * column, so "above" is the only answer that is ever right and the panel has
 * never had a reason to open downwards — it would cover the transcript and the
 * composer's own controls. Folding is therefore left to the clamp rather than to
 * a branch: a viewport too short to hold the panel above the ring gets the panel
 * at the top margin, which is a panel the user can still read, where a flip
 * would have put it over the control they just pressed.
 *
 * Right-edge alignment rather than centring is what the panel looked like before
 * (`right: -4px`), and it is the better answer besides: the ring is the last
 * control in its row, so the panel grows away from the composer's other
 * controls instead of over them.
 *
 * The panel is a dropdown, so the shared skeleton places it: it measures the
 * anchor and the panel and hands both to this rule. The rule answers "where",
 * and the skeleton's surface answers "whether" and "how it looks".
 */
export function positionContextUsagePopover(args: {
  readonly anchor: PopoverAnchorRect;
  readonly surface: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number;
  readonly margin?: number;
  readonly edgeOffset?: number;
}): ContextUsagePlacement {
  const gap = args.gap ?? CONTEXT_POPOVER_ANCHOR_GAP;
  const margin = args.margin ?? CONTEXT_POPOVER_VIEWPORT_MARGIN;
  const edgeOffset = args.edgeOffset ?? CONTEXT_POPOVER_EDGE_OFFSET;
  const { anchor, surface, viewport } = args;

  return {
    side: "top",
    left: Math.round(
      overlayAxisStart(
        anchor.left + anchor.width + edgeOffset - surface.width,
        surface.width,
        viewport.width,
        margin,
      ),
    ),
    top: Math.round(
      overlayAxisStart(
        anchor.top - gap - surface.height,
        surface.height,
        viewport.height,
        margin,
      ),
    ),
  };
}
