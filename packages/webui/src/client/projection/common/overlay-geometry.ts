/**
 * Viewport-space geometry shared by the two fixed overlays.
 *
 * `flyout-position.ts` and `context-usage-popover.ts` place different surfaces
 * with different strategies, but they answer the same two questions about
 * coordinates: what a viewport rectangle is, and where a box of a known size
 * starts once it is kept inside the viewport. Both answers were written out
 * verbatim in both files.
 *
 * What is deliberately NOT here is the strategy — which side to open on, which
 * edge to align to. That is the part the two modules actually disagree about,
 * and folding it in would trade one duplicated rule for a mode parameter that
 * makes the interface as complex as the implementation.
 */

/** A rectangle in viewport space, as `getBoundingClientRect` reports it. */
export interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Clamp `value` into `[min, max]`, tolerating an inverted range. */
export function clampOverlayToViewport(
  value: number,
  min: number,
  max: number,
): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * The start coordinate that keeps a `size`-long box inside `viewportSize`,
 * leaving `margin` at both ends.
 *
 * An inverted range resolves to `margin`, not to a negative start: a viewport
 * narrower than the box plus its margins is a box that cannot fit, and pinning
 * it to the near edge is the placement a reader can still use. The
 * `Math.max(margin, …)` is what expresses that — without it the upper bound
 * would fall below the lower one, and the clamp would answer with the lower one
 * anyway but for the wrong reason.
 */
export function overlayAxisStart(
  raw: number,
  size: number,
  viewportSize: number,
  margin: number,
): number {
  return clampOverlayToViewport(
    raw,
    margin,
    Math.max(margin, viewportSize - size - margin),
  );
}
