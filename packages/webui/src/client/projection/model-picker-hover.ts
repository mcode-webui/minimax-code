/**
 * When the model picker's settings fly-out opens, and what a hover that is not
 * yet a decision must NOT do.
 *
 * Two defects shaped this, both reported against the same surface:
 *
 *   - The fly-out opened the INSTANT the pointer touched a row. Sweeping the
 *     pointer down a list of models therefore threw a panel after every row it
 *     crossed, and the panel is wide enough to sit over the list it is
 *     describing. A panel that chases a moving pointer is not a description, it
 *     is a flicker.
 *   - Nothing retracted the fly-out when the interaction moved to the search
 *     box. The panel stayed up, describing one model and anchored beside a row
 *     the user was no longer reading — over the search results, which are the
 *     entire reason the user reached for the box.
 *
 * So the pointer has to REST on a row before the panel describes it, and the
 * panel belongs to the pointer's own region: leaving a row cancels the pending
 * open, arriving at a different row retracts the old panel immediately, and
 * taking the interaction away from the list retracts it outright.
 *
 * The rules live here as data rather than as conditions inside the component,
 * following `model-picker-cascade.ts` next door, and are pinned in
 * `test/unit/model-picker-hover.test.ts`. The timers and the DOM events that
 * feed them are in `ModelPicker.tsx`.
 */
import type { CascadeTier } from "./model-picker-cascade.js";

/**
 * How long the pointer must rest on a row before its fly-out opens.
 *
 * Long enough that a sweep across the list never opens one, short enough that a
 * deliberate hover does not read as the UI ignoring the pointer. The delay is
 * paid once per row: moving on before it expires cancels it, so the cost of a
 * wrong hover is bounded instead of compounding down the list.
 *
 * The row's HIGHLIGHT is deliberately not part of this delay. Highlighting is
 * the list saying "this is the row under the pointer" and is expected to be
 * instant; the panel is the list making a claim ABOUT that row, and claims are
 * what wait.
 */
export const MODEL_FLYOUT_HOVER_DELAY_MS = 350;

/** What the pointer arriving on a row does to the fly-out. */
export type HoverArrival =
  /**
   * The open panel already describes this row. Do nothing at all.
   *
   * The pointer has just crossed back out of the panel, or never left the row
   * it is describing.
   */
  | "keep-open"
  /**
   * Retract whatever is up now, and open THIS row's panel once the pointer has
   * rested.
   */
  | "retract-then-open"
  /**
   * Retract, and never open: this row has nothing to describe.
   */
  | "retract-only";

/**
 * What the pointer arriving on `key` does to the fly-out.
 *
 * The retract-then-open split is the one that carries the design. Retracting
 * first is what keeps the panel attached to the row the pointer is on: without
 * it, the highlight moves to the next row on the same mouse event that opened
 * the previous row's panel, and the panel re-anchors itself to the new row
 * before the delay has even been paid — the user sees the old model's settings
 * sliding onto a model they have not settled on.
 */
export function hoverArrival(params: {
  readonly key: string;
  readonly focusedKey: string | undefined;
  readonly tier: CascadeTier;
  readonly hasFlyout: boolean;
}): HoverArrival {
  // Already describing this row. Retracting here would close the panel under
  // the pointer on its way to being used, and re-scheduling would restart the
  // delay on a hover that has already been satisfied — the panel would flicker
  // closed and open again as the pointer crossed back over its own row.
  if (params.tier === "settings" && params.key === params.focusedKey) {
    return "keep-open";
  }
  // A model with nothing to configure has nothing to describe, and the previous
  // row's panel has to go: left standing it describes a model the pointer has
  // already left, anchored to a row nothing is pointing at.
  if (!params.hasFlyout) return "retract-only";
  return "retract-then-open";
}
