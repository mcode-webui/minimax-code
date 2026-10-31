/**
 * Where a dropdown popup goes.
 *
 * The shared skeleton (`client/ui/Dropdown.tsx`) owns the surface, the motion
 * and the dismissal; the geometry is here, as a pure function, because the
 * geometry is the part that is easy to get subtly wrong and impossible to
 * eyeball in a screenshot — a popup that opens above the trigger when the
 * trigger is near the bottom of the viewport, a popup that is aligned to the
 * wrong edge, a popup that hangs off the side of the screen — so it is decided
 * by numbers a test can assert, not by a screenshot.
 *
 * Three things decide the answer:
 *
 *   - **the anchor** — a rectangle in viewport space. It is usually the
 *     trigger's own rectangle, but it can be anything: a row in a list, a
 *     point on the canvas, the ring of a gauge. The skeleton accepts a
 *     resolver, so the anchor is ASKED for at measure time rather than
 *     remembered at render time — a row that the list remounts would leave a
 *     captured element pointing at a detached node.
 *   - **the surface** — the popup's own measured size. It is measured and
 *     never declared, because a popup's height follows its content: a menu
 *     with one row and a menu with thirty do not have the same height, and a
 *     clamp computed against a constant lets the last row fall off screen.
 *   - **the viewport** — what the popup has to fit inside.
 *
 * The rules the four strategies express:
 *
 *   - `side` says WHICH EDGE of the anchor the popup hangs from.
 *   - `align` says WHICH POINT of that edge it lines up with. On a vertical
 *     side it is horizontal alignment (start = the anchor's left edge), on a
 *     horizontal side it is vertical alignment (start = the anchor's top
 *     edge).
 *   - `width` says how wide the popup is: its own content, at least the
 *     anchor's width, or exactly the anchor's width.
 *   - `collision` says what happens when the popup does not fit: nothing, a
 *     clamp into the viewport, or a flip to the other side.
 */

import {
  clampOverlayToViewport,
  overlayAxisStart,
  type OverlayRect,
} from "./overlay-geometry.js";

/**
 * The anchor's rectangle, in viewport space.
 *
 * The same shape `overlay-geometry.ts` calls a rectangle, so a surface that
 * already measures one does not have to translate it.
 */
export type WebuiDropdownAnchorRect = OverlayRect;

/** The popup's own measured size. */
export interface WebuiDropdownSurfaceSize {
  readonly width: number;
  readonly height: number;
}

/** The space the popup has to fit inside. */
export interface WebuiDropdownViewport {
  readonly width: number;
  readonly height: number;
}

/** What a placement rule is given. */
export interface WebuiDropdownPlacementArgs {
  readonly anchor: WebuiDropdownAnchorRect;
  readonly surface: WebuiDropdownSurfaceSize;
  readonly viewport: WebuiDropdownViewport;
}

/**
 * A placement rule a surface can supply itself.
 *
 * The built-in rules cover the common shapes, but a surface whose geometry is
 * genuinely its own — a context menu that opens at the pointer, a gauge panel
 * that hangs above its ring without ever opening downwards, a cascade
 * fly-out that reads left to right — states the rule here instead of
 * re-implementing the surface, the motion and the dismissal to get it.
 */
export type WebuiDropdownPlacement = (
  args: WebuiDropdownPlacementArgs,
) => WebuiDropdownPlacementResult;

/** Which edge of the anchor the popup hangs from. */
export type WebuiDropdownSide = "bottom" | "top" | "right" | "left";

/**
 * Which point of that edge the popup lines up with.
 *
 * On a vertical side (`top`/`bottom`) it is horizontal alignment; on a
 * horizontal side (`right`/`left`) it is vertical alignment.
 */
export type WebuiDropdownAlign = "start" | "end" | "center";

/**
 * How wide the popup is.
 *
 *   - `content` — the popup's own width.
 *   - `match` — at least the anchor's width, wider if the content needs it.
 *   - `anchor` — exactly the anchor's width.
 */
export type WebuiDropdownWidth = "content" | "match" | "anchor";

/**
 * What happens when the popup does not fit.
 *
 *   - `none` — nothing; the popup may hang off the viewport.
 *   - `clamp` — the popup is kept inside the viewport, on the side it asked
 *     for.
 *   - `flip` — the popup opens on the other side if it does not fit, and is
 *     kept inside the viewport either way.
 */
export type WebuiDropdownCollision = "none" | "clamp" | "flip";

/** Space kept between the popup and the viewport edge, in px. */
export const WEBUI_DROPDOWN_VIEWPORT_MARGIN = 8;

/** The space between the anchor and the popup, in px. */
export const WEBUI_DROPDOWN_OFFSET = 4;

/** The placement the rules produced. */
export interface WebuiDropdownPlacementResult {
  readonly left: number;
  readonly top: number;
  /**
   * The side the popup actually opened on.
   *
   * It can differ from the side that was asked for: `flip` is the only
   * strategy that changes it, and a surface that draws an arrow towards its
   * anchor needs to know which edge it ended up on.
   */
  readonly side?: WebuiDropdownSide;
  /** The popup's width, when the width mode fixes it. */
  readonly width?: string;
  /** The popup's minimum width, when the width mode fixes it. */
  readonly minWidth?: string;
}

/** The opposite of a side. */
function oppositeSide(side: WebuiDropdownSide): WebuiDropdownSide {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

/** Whether a side is vertical — it opens above or below the anchor. */
function isVerticalSide(side: WebuiDropdownSide): boolean {
  return side === "top" || side === "bottom";
}

/**
 * Whether a popup of `size` fits against the anchor on `side`.
 *
 * The test is deliberately strict: the popup has to fit with the viewport
 * margin to spare, not merely reach the edge. A popup that exactly fills the
 * remaining space has no breathing room and reads as clipped.
 */
function fitsOnSide(args: {
  readonly side: WebuiDropdownSide;
  readonly anchor: WebuiDropdownAnchorRect;
  readonly surface: WebuiDropdownSurfaceSize;
  readonly viewport: WebuiDropdownViewport;
  readonly offset: number;
  readonly margin: number;
}): boolean {
  const { side, anchor, surface, viewport, offset, margin } = args;
  if (side === "bottom") {
    return anchor.top + anchor.height + offset + surface.height + margin <= viewport.height;
  }
  if (side === "top") {
    return anchor.top - offset - surface.height - margin >= 0;
  }
  if (side === "right") {
    return anchor.left + anchor.width + offset + surface.width + margin <= viewport.width;
  }
  return anchor.left - offset - surface.width - margin >= 0;
}

/**
 * Place a popup against its anchor.
 *
 * The order of the steps is the design:
 *
 *   1. **The side.** `flip` opens the popup on the other edge when the one
 *      that was asked for has no room. The other strategies keep the side
 *      they were given — a panel that must not cover the control that opened
 *      it is better off being clipped than being flipped over it.
 *   2. **The raw coordinates.** Where the popup would go if the viewport were
 *      large enough.
 *   3. **The width.** `anchor` fixes the popup's width, so the alignment is
 *      computed against the width the popup will actually have rather than
 *      the one it happened to be measured at.
 *   4. **The clamp.** The popup is kept inside the viewport. `none` keeps the
 *      old behaviour of only refusing to start left of the margin, which is
 *      what a popup that hangs off the right edge of a narrow window needs.
 */
export function placeWebuiDropdown(args: {
  readonly anchor: WebuiDropdownAnchorRect;
  readonly surface: WebuiDropdownSurfaceSize;
  readonly viewport: WebuiDropdownViewport;
  readonly side?: WebuiDropdownSide;
  readonly align?: WebuiDropdownAlign;
  readonly width?: WebuiDropdownWidth;
  readonly offset?: number;
  readonly collision?: WebuiDropdownCollision;
  readonly margin?: number;
}): WebuiDropdownPlacementResult {
  const side = args.side ?? "bottom";
  const align = args.align ?? "start";
  const widthMode = args.width ?? "content";
  const collision = args.collision ?? "none";
  const offset = args.offset ?? WEBUI_DROPDOWN_OFFSET;
  const margin = args.margin ?? WEBUI_DROPDOWN_VIEWPORT_MARGIN;
  const { anchor, viewport } = args;

  let resolvedSide = side;
  if (collision === "flip" && !fitsOnSide({ ...args, side, offset, margin })) {
    const alternative = oppositeSide(side);
    if (fitsOnSide({ ...args, side: alternative, offset, margin })) {
      resolvedSide = alternative;
    }
  }

  // A popup whose width is fixed by the anchor is aligned against the width
  // it will have, not against the one it was measured at.
  const surfaceWidth =
    widthMode === "anchor" ? anchor.width : args.surface.width;

  const horizontal = (): number => {
    if (align === "end") return anchor.left + anchor.width - surfaceWidth;
    if (align === "center") return anchor.left + (anchor.width - surfaceWidth) / 2;
    return anchor.left;
  };
  const vertical = (): number => {
    if (align === "end") return anchor.top + anchor.height - args.surface.height;
    if (align === "center") return anchor.top + (anchor.height - args.surface.height) / 2;
    return anchor.top;
  };

  let rawLeft: number;
  let rawTop: number;
  if (resolvedSide === "bottom") {
    rawTop = anchor.top + anchor.height + offset;
    rawLeft = horizontal();
  } else if (resolvedSide === "top") {
    rawTop = anchor.top - offset - args.surface.height;
    rawLeft = horizontal();
  } else if (resolvedSide === "right") {
    rawLeft = anchor.left + anchor.width + offset;
    rawTop = vertical();
  } else {
    rawLeft = anchor.left - offset - surfaceWidth;
    rawTop = vertical();
  }

  let left: number;
  let top: number;
  if (collision === "none") {
    // No viewport handling, but the popup still refuses to start left of the
    // margin: a popup at a negative coordinate is a popup whose left half is
    // off screen, and there is no reason for that.
    left = Math.max(margin, rawLeft);
    top = Math.max(margin, rawTop);
  } else {
    left = overlayAxisStart(rawLeft, surfaceWidth, viewport.width, margin);
    top = overlayAxisStart(rawTop, args.surface.height, viewport.height, margin);
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    side: resolvedSide,
    ...(widthMode === "anchor" ? { width: `${Math.round(anchor.width)}px` } : {}),
    ...(widthMode === "match" ? { minWidth: `${Math.round(anchor.width)}px` } : {}),
  };
}

/**
 * Keep a point inside the viewport.
 *
 * A context menu opens at the pointer, and the pointer can be at the very
 * edge of the screen — where a popup of any size hangs off it. The rule is
 * the same one the other overlays use: the popup is kept inside, and it is
 * kept inside by moving its origin rather than by shrinking it.
 */
export function clampPointToViewport(
  point: { readonly x: number; readonly y: number },
  viewport: WebuiDropdownViewport,
  margin = WEBUI_DROPDOWN_VIEWPORT_MARGIN,
): { readonly x: number; readonly y: number } {
  return {
    x: clampOverlayToViewport(point.x, margin, Math.max(margin, viewport.width - margin)),
    y: clampOverlayToViewport(point.y, margin, Math.max(margin, viewport.height - margin)),
  };
}
