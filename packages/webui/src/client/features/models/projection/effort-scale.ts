// The thinking scale as the panel reads it.
//
// The runtime owns the SHAPE of the scale — which levels a model offers — and
// this module owns how it is read: a label for each stop, and the position of
// the current one. A fixed four-stop product scale would send levels a model
// does not offer, so the stops come from the model's own `effortOptions` and
// the slider is exactly as long as that list.
//
// Nothing here decides anything: the scale is a reading of the model contract,
// and the commit that moves the slider is the same `selectModel` the model
// list uses.

import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts/model-view.js";
import { effortLabel, resolveEffortOptions } from "./thinking-control.public.js";

/** One stop on the scale. */
export interface WebuiEffortStop {
  /** The wire value this stop commits. */
  readonly value: string;
  /** The label it is shown with. */
  readonly label: string;
}

/** The scale one model offers. */
export interface WebuiEffortScale {
  readonly stops: readonly WebuiEffortStop[];
  /**
   * A model with no thinking at all.
   *
   * The slider is still there — a control that vanishes takes the panel's
   * layout with it — and it does nothing.
   */
  readonly disabled: boolean;
}

/**
 * Is this model's thinking a SWITCH rather than a scale?
 *
 * The wire carries a switch in the VARIANT, not in an effort: a two-state
 * model has no depth to record, so the switch commits `variant: "thinking"`
 * or `variant: ""` and deliberately leaves the effort alone. A control that
 * read the effort would sit in the wrong state for the whole life of the
 * session.
 */
export function isBinaryEffort(model: WebuiModelPickerEntry | undefined): boolean {
  const options = model ? resolveEffortOptions(model) : [];
  return options.includes("off") && options.includes("on");
}

/**
 * The scale one model offers, as stops.
 *
 * A switch's two positions are the whole scale. The "default" the runtime may
 * list beside them is the engine's choice, and a switch cannot express it:
 * the variant carries this state, so a stop that wrote an effort would move
 * nothing.
 */
export function effortScaleFor(
  model: WebuiModelPickerEntry | undefined,
): WebuiEffortScale {
  const options = model ? resolveEffortOptions(model) : [];
  const stops = isBinaryEffort(model)
    ? options.filter((option) => option === "off" || option === "on")
    : options;
  return {
    stops: stops.map((value) => ({ value, label: effortLabel(value) })),
    disabled: stops.length === 0,
  };
}

/**
 * The level the model is on now.
 *
 * "Now" is the DRAFT's value when there is one, because a draft is what the
 * user is in the middle of choosing, and the model's own value otherwise.
 *
 * A level the model does not offer reads as the default stop. It is the only
 * place the thumb can rest that does not claim a level the model cannot
 * honour — the alternative, no position at all, would leave a control whose
 * state cannot be read.
 */
export function currentEffortValue(
  model: WebuiModelPickerEntry | undefined,
  draft: WebuiModelPickerDraft | undefined,
): string {
  const options = model ? resolveEffortOptions(model) : [];
  if (options.length === 0) return "default";
  if (isBinaryEffort(model)) {
    const variant =
      draft?.variant !== undefined ? draft.variant : model?.variant;
    if (variant !== undefined) return variant === "thinking" ? "on" : "off";
    // The runtime's own statement of the switch's default, when it made one.
    return model?.thinkingConfig?.default_value === "true" ? "on" : "off";
  }
  const recorded =
    draft?.thinkingEffort !== undefined
      ? draft.thinkingEffort
      : (model?.thinking?.effort ?? null);
  if (recorded === null || recorded === undefined) return "default";
  return options.includes(recorded) ? recorded : "default";
}

/**
 * Which stop the current level sits on.
 *
 * A level the scale does not carry rests on the first stop: the scale starts
 * at the default, and that is the position a level we cannot place would
 * otherwise claim.
 */
export function effortStopIndex(
  scale: WebuiEffortScale,
  value: string,
): number {
  if (scale.stops.length === 0) return -1;
  const at = scale.stops.findIndex((stop) => stop.value === value);
  return at === -1 ? 0 : at;
}

/**
 * The stop the RESET goes back to.
 *
 * A depth scale's is the default — "no override, the engine decides", which is
 * a real position and not the absence of one. A switch has no such position:
 * its state is the variant, and the position it rests at by default is the one
 * the RUNTIME declares, so the reset returns to what the runtime said rather
 * than to a guess.
 */
export function effortResetOption(
  model: WebuiModelPickerEntry | undefined,
): string {
  if (!model) return "default";
  if (isBinaryEffort(model)) {
    return model.thinkingConfig?.default_value === "true" ? "on" : "off";
  }
  return "default";
}

/**
 * Where a stop sits along the rail, as a fraction of the travel.
 *
 * A fraction, not a percentage: the rail's travel is inset by the thumb's
 * radius, so the stops do not reach the ends of the track — the thumb is a
 * circle, and a circle at the end of a track hangs off it. The caller places
 * the stop inside that inset.
 *
 * One stop has no span to sit in, so it rests in the middle: a rail with a
 * single position is a position, not a range.
 */
export function effortStopRatio(index: number, total: number): number {
  if (total <= 1) return 0.5;
  return index / (total - 1);
}
