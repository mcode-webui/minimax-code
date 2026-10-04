/**
 * Fixed-viewport placement for the model picker's settings fly-out.
 *
 * ONE engine, kept as a module rather than inlined in the component, because
 * flipping and clamping are exactly the two rules that are easy to get subtly
 * wrong and impossible to eyeball in a screenshot — so they are pure functions
 * with no DOM to pin them against.
 *
 * `surface` is MEASURED by the caller, never a constant: the fly-out's height
 * follows the number of context sizes the described model offers, and a clamp
 * computed against a stale height lets the bottom of that list fall off screen.
 *
 * The surface is positioned `fixed` so it escapes the model list's own
 * `overflow-y: auto`. That is why the anchor is a viewport-space rect rather
 * than an offset parent: an `absolute` fly-out inside the scrolling list would
 * be clipped by it, and the list is the one thing the fly-out has to escape.
 */

export interface FlyoutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FlyoutPlacement {
  readonly left: number;
  readonly top: number;
  /** Which side the surface opened on. Drives the arrow and the test names. */
  readonly side: "right" | "left" | "below";
}

/** Space kept between the surface and the viewport edge, in px. */
export const FLYOUT_VIEWPORT_MARGIN = 8;

/** Space between the anchor row and the surface, in px. */
export const FLYOUT_ANCHOR_GAP = 6;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Place a surface beside `anchor`, flipping and clamping into the viewport.
 *
 * The order of attempts is the design, not an implementation detail:
 *
 *   1. **Right** — the cascade reads left-to-right and the model list sits on
 *      the left edge of the menu, so right is where the eye already is.
 *   2. **Left** — when the list is near the right edge of the viewport.
 *   3. **Below** — the last resort, and only when neither side has room. The
 *      surface is wider than the row it is anchored to, so a narrow viewport
 *      can have room beside the row and none at all under it; that is
 *      deliberate, because a surface that cannot be seen at all is worse than
 *      one that covers the row.
 *
 * Vertical alignment is to the anchor's TOP, not its vertical centre. The
 * surface is taller than a row, and centring pushes its first control below the
 * pointer that opened it, which is the control the user is reaching for.
 *
 * Every branch ends in a clamp, so the surface is always fully on screen even
 * when the anchor itself is partly off it — a scrolled list can put a row under
 * the viewport edge, and an unclamped surface would be unreachable there.
 */
export function positionFlyout(args: {
  readonly anchor: FlyoutRect;
  readonly surface: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number;
  readonly margin?: number;
}): FlyoutPlacement {
  const gap = args.gap ?? FLYOUT_ANCHOR_GAP;
  const margin = args.margin ?? FLYOUT_VIEWPORT_MARGIN;
  const { anchor, surface, viewport } = args;

  const fitsRight =
    anchor.left + anchor.width + gap + surface.width + margin <= viewport.width;
  const fitsLeft = anchor.left - gap - surface.width - margin >= 0;

  const side: FlyoutPlacement["side"] = fitsRight
    ? "right"
    : fitsLeft
      ? "left"
      : "below";

  const rawLeft =
    side === "right"
      ? anchor.left + anchor.width + gap
      : side === "left"
        ? anchor.left - gap - surface.width
        : anchor.left;

  const rawTop =
    side === "below"
      ? anchor.top + anchor.height + gap
      : anchor.top;

  return {
    left: Math.round(
      clamp(rawLeft, margin, Math.max(margin, viewport.width - surface.width - margin)),
    ),
    top: Math.round(
      clamp(rawTop, margin, Math.max(margin, viewport.height - surface.height - margin)),
    ),
    side,
  };
}

/**
 * The inline style for a placed fly-out.
 *
 * `fixed` with `left`/`top` only. Deliberately NOT `transform`-based: the menu
 * animates its own panels, and a transform here would fight that. `visibility`
 * is left to CSS — this function answers "where", not "whether".
 */
export function flyoutStyle(
  placement: FlyoutPlacement,
): { readonly position: "fixed"; readonly left: string; readonly top: string } {
  return {
    position: "fixed",
    left: `${placement.left}px`,
    top: `${placement.top}px`,
  };
}
