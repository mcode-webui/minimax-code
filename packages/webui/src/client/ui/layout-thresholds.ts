/**
 * The layout threshold contract (ADR 0025).
 *
 * These are the widths the client adapts at. They are stated as the **smallest width at which the
 * full form applies**, so the narrow form's condition is one pixel below the threshold — `360px` is
 * written `max-width: 359px` — and the unit test derives that complement from the threshold, so
 * the two cannot drift apart.
 *
 * The stylesheet cannot read this module, and a container or media query condition cannot use
 * `var()` at all, so the values appear in both places. That duplication is deliberate and fenced:
 * `test/unit/webui-layout-thresholds.test.ts` asserts that the stylesheet and this module agree,
 * and a threshold that drifts is a failing test rather than a layout that breaks quietly.
 *
 * The contract has one idea behind it: **the surface's width is a budget, and the regions spend
 * it in a fixed order.** The conversation column is the reading surface, so it keeps a floor and
 * the tool regions give way instead. A region that cannot have the width it wants does not
 * pretend to have it — it changes form, from a column into an overlay, or from a full label into
 * an icon — and it never takes more of the surface than it is using.
 *
 * **The progress panel is in this contract for one thing only: when it may be open.** It is a card
 * that floats over the conversation's right edge and is anchored to the window, and the
 * conversation keeps a gutter for it so that the card lands in that gutter rather than on top of
 * the text. Below `progressPanelMinWidth` the conversation cannot spare that gutter, so the panel
 * closes itself instead of covering what it is meant to report on. The card's own width is the
 * window's business, which is the same rule the viewport-anchored overlays follow: the viewport
 * is the box they are placed against.
 */

/** The threshold contract. Every adaptive decision in the client reads one of these. */
export const WEBUI_LAYOUT_THRESHOLDS = Object.freeze({
  /**
   * At this viewport width and above the left rail is a column beside the surface. Below it the
   * rail is an overlay drawer that does not take width from the conversation.
   *
   * The rail spans the whole window, so its width is the viewport's business rather than a
   * container's.
   */
  shellCompact: 640,
  /**
   * The conversation column is never narrower than this. It is the reading surface, so it is the
   * thing that keeps its space when space runs short.
   */
  conversationMin: 320,
  /**
   * At this surface width and above the workspace panel is a column beside the conversation.
   * Below it the panel is an overlay, because the surface cannot hold both the panel's floor and
   * the conversation column's floor.
   *
   * It is the conversation's floor plus the panel's floor: 320 + 360. The two columns are flush
   * against each other and separated by a hairline rather than by a gutter, so there is no gutter
   * to count.
   */
  surfaceSplit: 680,
  /**
   * The workspace panel is never narrower than this while it is a column.
   */
  panelMin: 360,
  /**
   * The widest the workspace panel is while it is an overlay. An overlay does not spend the
   * surface's width, so it does not need to be defended against the conversation column.
   */
  panelOverlayMax: 560,
  /**
   * The composer's card is narrower than the column it sits in even on a wide screen — it does not
   * fill it — so the toolbar's own width is the width that decides the composer's form.
   *
   * At this card width and above the toolbar shows every control in its full form: the model by
   * name and the permission control by its label. Below it the model name becomes an icon, and
   * below `composerPermissionIcon` the permission label does too.
   *
   * These are the widths the full forms actually need, measured from the controls themselves:
   * the add button (28), two gutters (12 each), the permission label (108), the context ring, the
   * model trigger and the send control. The model name is the one variable part, so the trigger
   * truncates rather than pushing the row over: a toolbar that wrapped is the failure this
   * contract exists to prevent.
   */
  composerModelIcon: 360,
  /**
   * At this card width and above the permission control keeps its label. Below it the label
   * becomes a shield, and the control's accessible name keeps saying what the mode is.
   */
  composerPermissionIcon: 272,
  /**
   * The narrowest viewport at which the progress panel may be open.
   *
   * The panel is a card that floats over the conversation's right edge, and the conversation keeps
   * a gutter for it so that the card lands in that gutter rather than on top of the text. Below
   * this width the conversation cannot spare that gutter, and a card that sits on the text is
   * worse than no card at all — the panel closes itself.
   *
   * This is not a sum of floors. The conversation could spare the gutter further down: it could
   * give up width until it was at its own floor. The panel closes instead, because the
   * conversation is the thing the client is for and the panel is a report on it.
   */
  progressPanelMinWidth: 1080,
});

/** Which form the shell's surface takes for the workspace panel. */
export type WebuiSurfaceTier = "split" | "overlay";

/**
 * The tier a surface of the given width takes for the workspace panel.
 *
 * The surface's width is what the conversation column and the workspace panel actually share, which
 * is not the viewport's width: the rail takes its share first. A viewport breakpoint would have to
 * guess that share.
 */
export function webuiSurfaceTier(surfaceWidth: number): WebuiSurfaceTier {
  return surfaceWidth >= WEBUI_LAYOUT_THRESHOLDS.surfaceSplit ? "split" : "overlay";
}

/**
 * The width the workspace panel may take while it is a column.
 *
 * The upper bound is the surface minus the conversation column's floor: a panel that claims more
 * than that does not shrink the conversation column, it eliminates it. The lower bound is the
 * panel's own floor, except where the surface is too narrow to hold even that, in which case the
 * two bounds meet and the panel is as wide as the space allows.
 */
export function webuiPanelWidthBounds(surfaceWidth: number): { readonly min: number; readonly max: number } {
  const max = Math.max(0, surfaceWidth - WEBUI_LAYOUT_THRESHOLDS.conversationMin);
  return { min: Math.min(WEBUI_LAYOUT_THRESHOLDS.panelMin, max), max };
}

/**
 * The width the workspace panel may take while it is an overlay.
 *
 * The overlay is anchored to the surface's right edge and never exceeds the surface it covers.
 */
export function webuiOverlayPanelWidth(surfaceWidth: number): number {
  return Math.max(0, Math.min(surfaceWidth, WEBUI_LAYOUT_THRESHOLDS.panelOverlayMax));
}

/**
 * Whether the rail is a drawer at the given viewport width.
 *
 * The rail is the one part of the shell whose width is the viewport's business rather than a
 * container's: it is the only element that spans the whole window.
 */
export function webuiRailIsDrawer(viewportWidth: number): boolean {
  return viewportWidth < WEBUI_LAYOUT_THRESHOLDS.shellCompact;
}

/**
 * The media condition under which the progress panel closes itself.
 *
 * The panel's card is anchored to the window rather than to the surface, so the width that decides
 * this is the window's — and it is read the way the stylesheet reads it, with the same `max-width`
 * condition, so the card and the gutter it lives in are never on opposite sides of the boundary.
 */
export const WEBUI_PROGRESS_PANEL_NARROW_QUERY =
  `(max-width: ${WEBUI_LAYOUT_THRESHOLDS.progressPanelMinWidth - 1}px)`;
