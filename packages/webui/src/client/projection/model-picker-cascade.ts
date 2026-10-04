/**
 * The model picker's cascade rules (roadmap H, 模型选择器级联).
 *
 * The picker's settings live in a fly-out anchored to a row, not in a
 * permanent right column. That shape forces a set of decisions that are easy to
 * state and easy to get subtly wrong, so they live here as data rather than as
 * conditions inside the component:
 *
 *   - Which rows are worth describing? (a model with settings, one with none)
 *   - When are the controls live, and when are they a preview?
 *   - What does Escape do from each tier?
 *
 * "Tier" here is the LIST and the SETTINGS FLY-OUT — the two surfaces the
 * Escape rule moves between. The context sizes are not a third tier: they are
 * listed in place inside the fly-out, one surface from the row.
 *
 * CHANGED from the source implementation
 * (`176b8b7 feat(webui): the model picker is a cascade again, not a two-column
 * panel`): a click on a row always COMPLETES the selection. The source made a
 * model with settings two clicks deep — click the row to reach its fly-out, then
 * pick a context window inside it to finish. That made choosing a model a
 * two-step errand over settings that are all optional and all defaulted, and it
 * made the fly-out unreachable by pointer, since the pointer could not open it.
 * The fly-out is now reached by HOVER, which is where a pointer expects to find
 * a description of the row it is on, so a click is left with one meaning —
 * "this is the one".
 *
 * `rowClickOutcome` and `tierAfterRowClick` were removed rather than left
 * returning constants: a function that ignores its argument and always says
 * "close" is a name the next reader will trust.
 */
import type { WebuiModelPickerEntry } from "../components/ModelPicker.js";

/** Which tier of the cascade is showing. */
export type CascadeTier = "list" | "settings";

/**
 * True when this model has anything to configure.
 *
 * Drives what the fly-out offers on hover — a model with settings describes
 * itself beside its row, one with nothing to configure has nothing to show.
 * It no longer decides whether a click completes: a click always completes now
 * (see `rowClickOutcome`).
 */
export function modelHasSettings(
  model: WebuiModelPickerEntry | undefined,
): boolean {
  if (!model) return false;
  return (
    (model.effortOptions?.length ?? 0) > 0 ||
    (model.contextWindowOptions?.length ?? 0) > 0
  );
}

/**
 * Whether this model's row opens a settings fly-out on hover.
 *
 * The only remaining per-model rule in the cascade. A model with settings
 * describes itself beside its row; one without has nothing to show, and opening
 * an empty panel would be worse than opening none.
 */
export function rowHasFlyout(model: WebuiModelPickerEntry | undefined): boolean {
  return modelHasSettings(model);
}

/**
 * True when the fly-out describes a model other than the active one.
 *
 * Carried on the surface as state, NOT as a gate. It used to disable every
 * control until the row was picked, which made the panel read-only in exactly
 * the case it was opened for: a user hovering a model they had not yet chosen,
 * to see what it offers. They had to click the row first to unlock it, and then
 * the fly-out had saved them nothing over the settings column it replaced. So
 * every control here is a way of PICKING the row this panel describes, and the
 * answer to that is the same whether or not the row was already active.
 */
export function isPreview(
  focusedKey: string | undefined,
  selectedKey: string | undefined,
): boolean {
  if (!focusedKey) return true;
  return focusedKey !== selectedKey;
}

/** What Escape does from a given tier. */
export type EscapeOutcome = "retract-tier" | "close-menu" | "ignore";

/**
 * What Escape does, from where.
 *
 * Backs out ONE tier at a time: the first press retracts an open fly-out and
 * leaves the list, the second closes the menu. A single Escape that closed
 * everything would throw away the list position the user had built up, which is
 * the part of the interaction that took effort to reach.
 *
 * From the list with no fly-out open there is nothing to retract, so Escape
 * closes the menu.
 */
export function escapeOutcome(tier: CascadeTier): EscapeOutcome {
  return tier === "settings" ? "retract-tier" : "close-menu";
}
