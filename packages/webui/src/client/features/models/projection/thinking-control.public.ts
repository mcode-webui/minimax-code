/**
 * The model's thinking contract, as the controls read it.
 *
 * The wire carries a model's thinking in two fields, and they are not the same
 * question: `thinking.effort` is a DEPTH (`low`, `medium`, `high`), and the
 * wire VARIANT is a SWITCH (`"thinking"`, or empty for the non-thinking
 * variant). A model with a depth scale is changed through the effort; a
 * two-state model is changed through the variant, because it has no depth to
 * record.
 *
 * Which of the two a model has is a fact about the MODEL CONTRACT, not about
 * the control that shows it — and it used to be answered twice: once for the
 * cascade's fly-out and once for the composer's brain icon. Two answers to one
 * question is how a control ends up claiming a level the model cannot honour,
 * so the answer lives here once and every surface reads it from here.
 *
 * The panel that shows the scale is the models feature's own; the composer's
 * chip names the level beside the model name, and names it in the interface's
 * language rather than the wire's.
 */

import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts/model-view.js";

/** Which control shape a model's thinking options render as. */
export type ThinkingControlShape = "switch" | "radiogroup" | null;

/**
 * Which control a model's option list renders as.
 *
 *   - exactly `["off","on"]` (either order) → a switch, the two-state shape a
 *     switchable builtin projects;
 *   - anything else with entries → a radio group, because that is a depth scale
 *     and a switch cannot express "medium";
 *   - an empty list → NO control at all. A no-op control is worse than none: it
 *     invites a click that changes nothing.
 */
export function thinkingControlShape(
  options: readonly string[],
): ThinkingControlShape {
  if (options.length === 0) return null;
  if (options.length === 2 && options.includes("off") && options.includes("on")) {
    return "switch";
  }
  return "radiogroup";
}

/**
 * The Chinese label for one wire level.
 *
 * The wire speaks English (`low`, `medium`, `high`) and the interface speaks
 * Chinese, so the translation lives here rather than in the runtime: the
 * runtime's levels are its own, and a client that printed them raw would put
 * `high` next to 「模型」. A level this table does not know is shown as it
 * arrived — a name we cannot translate is still better than a wrong one.
 */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  default: "默认",
  off: "关闭",
  on: "开启",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};

/** The label one level is shown with. */
export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

/**
 * The level word the model chip carries, for a DEPTH model. `""` for none.
 *
 * The chip names the level beside the model name, in the muted colour: a level
 * is a POSITION on a scale, and a colour cannot express one. Which is also why
 * this is empty for a binary model — there the level is a switch, and it is
 * named by the panel that owns the switch.
 *
 * Empty for an absent record and for a record the model does not offer: a level
 * the target cannot honour is not a level to print.
 */
export function chipLevelLabel(
  options: readonly string[],
  recorded: string | undefined,
): string {
  if (thinkingControlShape(options) !== "radiogroup") return "";
  const value = (recorded ?? "").trim();
  if (value === "" || !options.includes(value)) return "";
  return effortLabel(value);
}

/**
 * The thinking options a model offers, in the order a control renders them.
 *
 * `effortOptions` is the runtime's explicit list when it fills one. Otherwise a
 * model that reports switchable thinking is treated as a binary off/on toggle,
 * so the picker surfaces the control without the runtime having to fill the
 * list. `default_value` counts as the runtime's own statement that a switch
 * exists, which keeps the control from depending on the variant list arriving
 * intact.
 *
 * It lives here rather than beside the picker because the option list is what
 * `variantForEffort` and `thinkingDraftPatch` are defined against.
 */
export function resolveEffortOptions(
  model: WebuiModelPickerEntry,
): readonly string[] {
  const explicit = model.effortOptions ?? [];
  if (explicit.length > 0) {
    return explicit.includes("default") ? explicit : ["default", ...explicit];
  }
  // The runtime reports switchable thinking via `thinkingConfig.mode` +
  // `supportedVariants`. Treat any model that supports both an empty and a
  // non-empty variant as a binary "off / on" toggle so the picker still
  // surfaces the control without the runtime having to fill `effortOptions`.
  if (model.thinkingConfig?.mode === "switchable") {
    const variants = model.supportedVariants ?? [];
    const hasOff = variants.includes("") || variants.includes("none-thinking");
    const hasOn = variants.some((variant) => variant && variant !== "none-thinking");
    // `default_value` is the runtime's own statement that this model has a
    // thinking switch, and it reaches the client on `thinkingConfig` even when
    // the variant list does not. Trusting it means the control does not depend
    // on a second field arriving intact.
    const declaredSwitch = model.thinkingConfig?.default_value !== undefined;
    if ((hasOff && hasOn) || declaredSwitch) return ["off", "on"];
  }
  return [];
}

/** The wire variant an effort selection implies, when it implies one. */
export function variantForEffort(
  model: WebuiModelPickerEntry,
  effort: string,
): string | undefined {
  const options = resolveEffortOptions(model);
  if (options.length === 0) return undefined;
  const thinkingOn = options.includes("on");
  if (thinkingOn && (effort === "on" || effort === "off")) {
    return effort === "on" ? "thinking" : "";
  }
  // Multi-level efforts (low/high/max, …) are not part of the wire variant;
  // their value is carried by the thinking.effort selection instead.
  return undefined;
}

/**
 * What selecting one thinking option writes onto a model draft.
 *
 * Three shapes, and which one applies is a fact about the model contract rather
 * than about the control that reported it:
 *
 *   * `default` — the user asked for no override, so `thinkingEffort` is `null`
 *     and the engine picks. `null` is not "off"; the two are different claims.
 *   * `off` / `on` — a binary model carries this in the wire `variant`, which
 *     `variantForEffort` supplies, so the patch adds nothing.
 *   * anything else — a level (`low`, `high`, `max`), carried by
 *     `thinking.effort`.
 */
export function thinkingDraftPatch(
  model: WebuiModelPickerEntry,
  option: string,
): Partial<Pick<WebuiModelPickerDraft, "variant" | "thinkingEffort">> {
  const variant = variantForEffort(model, option);
  return {
    ...(variant !== undefined ? { variant } : {}),
    ...(option === "default"
      ? { thinkingEffort: null }
      : option === "off" || option === "on"
        ? {}
        : { thinkingEffort: option }),
  };
}
