/**
 * The composer's thinking trigger (roadmap H, 模型与用量).
 *
 * A brain icon beside the send button that answers ONE question — is thinking
 * on — and, for a model with a depth scale, a second control beside it that
 * answers a different one: which level. Two questions, two controls, because
 * the brain cannot ask which depth the user wants; a clickable brain would have
 * to guess one, and a guess presented as a control is worse than no control.
 *
 * The interesting part is the THREE-valued `isThinkingOn`. A colour is a
 * claim, and there is a case where this process cannot support any claim at
 * all: the wire contract says an empty effort means "no override, the engine
 * picks", and the engine never reports back which level it chose. So the empty
 * case is `null`, not `false` — a blue brain next to the word "Default" would
 * assert a state nothing here can verify. `null` renders in the neutral colour
 * and lets the LABEL carry the truth; colour reinforces, text decides.
 *
 * Ported from `webapp/lib/effort-control.ts` in the other WebUI implementation,
 * re-shaped onto this repository's model entry: the target reports
 * `effortOptions` plus `thinking.effort` / `variant`, where the source reported
 * a `thinkingLevels` array and a single `thinking` string. The shape decisions
 * are unchanged.
 */

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
 * Is thinking ON — `true` / `false` / `null` for "this process cannot say".
 *
 *   - an absent or empty record is the ENGINE's default and is `null`;
 *   - a record the model does not offer is `null` too, because the record does
 *     not describe this model — a cross-model leftover, not a state;
 *   - a recorded DEPTH (low / medium / high / …) counts as ON. It is a request
 *     FOR thinking, and treating it as off would grey the control while the
 *     engine is visibly reasoning. Only an explicit "off" is off.
 */
export function isThinkingOn(
  options: readonly string[],
  recorded: string | undefined,
): boolean | null {
  const value = (recorded ?? "").trim();
  if (value === "") return null;
  if (!options.includes(value)) return null;
  return value !== "off";
}

/**
 * The option the control highlights as current, or `null`.
 *
 *   - a previewed row (focused ≠ active) never highlights: the record belongs
 *     to the active model, and highlighting it against another model is a lie
 *     about which model the setting is for;
 *   - an absent record maps to "default";
 *   - a recorded option the target does NOT offer highlights NOTHING, rather
 *     than silently falling back to "default" and pretending the engine default
 *     is picked. The same anti-stale rule the row badge applies.
 *
 * Reads `options`, not the radio group's rendered list, so the check holds for
 * the switch form too — that form never builds a list, and gating its checked
 * state on one made every recorded "on" read as off.
 */
export function resolveEffortCurrent(
  options: readonly string[],
  recorded: string | undefined,
  preview: boolean,
): string | null {
  if (preview) return null;
  const value = (recorded ?? "").trim();
  if (value === "") return "default";
  return options.includes(value) ? value : null;
}

/** The accent token a brain should wear, given a three-valued verdict. */
export type BrainTone = "on" | "off" | "unstated";

/**
 * Map the verdict to a tone.
 *
 * A named mapping rather than a ternary at the call site, because the mistake
 * this guards against is collapsing `null` into `false`: that renders an
 * unstated state as a confidently-off one, which is the exact claim the
 * three-valued return exists to avoid.
 */
export function brainTone(thinkingOn: boolean | null): BrainTone {
  if (thinkingOn === null) return "unstated";
  return thinkingOn ? "on" : "off";
}

/**
 * What the brain says on hover.
 *
 * Two hover titles, one per question. The brain's title states the ON/OFF
 * verdict; when the model has a depth scale, the LEVEL control carries its own
 * title naming the level. Collapsing them into one tooltip would make the
 * control that names a level indistinguishable from the one that only says
 * whether thinking is on.
 */
export function brainHoverLabel(
  tone: BrainTone,
  levelLabel: string | undefined,
): string {
  const state =
    tone === "on" ? "已开启思考" : tone === "off" ? "已关闭思考" : "思考由引擎决定";
  return levelLabel ? `${state} · ${levelLabel}` : state;
}
