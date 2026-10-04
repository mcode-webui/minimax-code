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

/** The whole of a model entry's thinking state, as the controls read it. */
export interface ThinkingState {
  /** The wire variant: `"thinking"`, `""` for the non-thinking variant. */
  readonly variant?: string;
  /** The recorded depth, or `null` for an explicit "engine decides". */
  readonly thinkingEffort?: string | null;
}

/**
 * Is thinking ON, reading the field that actually carries the answer.
 *
 * The switch's state is the WIRE VARIANT, not the effort. A two-state model has
 * no depth to record, so an on/off commit writes `variant: "thinking"` or
 * `variant: ""` and deliberately leaves `thinking.effort` alone — reading the
 * effort here therefore read a field the toggle never writes, and the control
 * sat in `unstated` for the whole life of the session no matter how many times
 * it was pressed.
 *
 * A present variant is a STATEMENT, so it is never `null`: the runtime always
 * reports one for a selected model, falling back to the model's declared
 * default. Only a model that reports no variant at all falls through to the
 * effort, and that keeps the three-valued verdict intact — an absent record is
 * still the engine's choice rather than a confident "off".
 *
 * `options` narrows the effort fallback, so a cross-model leftover ("high" on a
 * switch) still reads as `null` instead of as "on".
 */
export function resolveThinkingVerdict(
  options: readonly string[],
  state: ThinkingState,
): boolean | null {
  if (state.variant !== undefined) return state.variant === "thinking";
  return isThinkingOn(options, state.thinkingEffort ?? undefined);
}

/**
 * The level word the model chip carries, for a DEPTH model. `""` for none.
 *
 * The chip names the level beside the model name, in the muted colour: "High" is
 * a POSITION on a scale, and an on/off colour cannot express one. Which is also
 * why this is empty for a binary model — there the brain's blue already answers
 * "on", and 「开启」 in the chip restated what the glyph beside it says, two
 * controls apart in the same toolbar.
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
  return value;
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
 *
 * The unstated case names the ACTION, not just the state. 「思考由引擎决定」
 * alone reads as an answer and gives no reason to click, which is wrong for a
 * control whose entire job is to be clicked: the state is true, and it is also
 * the state a click changes. So it reads as the state plus what pressing it
 * does.
 */
export function brainHoverLabel(
  tone: BrainTone,
  levelLabel: string | undefined,
  action: "turn-on" | "turn-off" | undefined = undefined,
): string {
  const state =
    tone === "on" ? "已开启思考" : tone === "off" ? "已关闭思考" : "思考由引擎决定";
  const suffix = action === "turn-on" ? "点击开启" : action === "turn-off" ? "点击关闭" : undefined;
  const base = suffix ? `${state} · ${suffix}` : state;
  return levelLabel ? `${base} · ${levelLabel}` : base;
}
