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
 */

/** A rectangle in viewport space, the same shape the fly-out anchor reports. */
export interface PopoverAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ContextUsagePlacement {
  readonly left: number;
  readonly top: number;
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

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

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
    left: Math.round(
      clamp(
        anchor.left + anchor.width + edgeOffset - surface.width,
        margin,
        Math.max(margin, viewport.width - surface.width - margin),
      ),
    ),
    top: Math.round(
      clamp(
        anchor.top - gap - surface.height,
        margin,
        Math.max(margin, viewport.height - surface.height - margin),
      ),
    ),
  };
}

/**
 * The inline style for a placed panel.
 *
 * `fixed`, for the reason the module doc gives. `visibility` and opacity are
 * left to CSS — this answers "where", not "whether" — and so is the entry
 * transform, which the sheet animates.
 */
export function contextUsagePopoverStyle(placement: ContextUsagePlacement): {
  readonly position: "fixed";
  readonly left: string;
  readonly top: string;
} {
  return {
    position: "fixed",
    left: `${placement.left}px`,
    top: `${placement.top}px`,
  };
}

/**
 * Two placements that would render identically.
 *
 * The measure runs on every render while the panel is open — it has to, because
 * the panel's own height changes when the disclosure opens — and `useState`
 * compares by identity, so without this each measurement would schedule a render
 * that produces another measurement.
 */
export function sameContextUsagePlacement(
  a: ContextUsagePlacement | undefined,
  b: ContextUsagePlacement | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top;
}
