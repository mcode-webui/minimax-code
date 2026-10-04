/**
 * The model picker's cascade rules (roadmap H, 模型选择器级联).
 *
 * The picker's settings live in a fly-out anchored to a row, not in a
 * permanent right column. That shape forces a set of decisions that are easy to
 * state and easy to get subtly wrong, so they live here as data rather than as
 * conditions inside the component:
 *
 *   - When does a click COMPLETE the selection, and when does it only advance?
 *   - When are the controls live, and when are they a preview?
 *   - What does Escape do from each tier?
 *
 * "Tier" here is the LIST and the SETTINGS FLY-OUT — the two surfaces the
 * Escape rule moves between. The context sizes are not a third tier: they are
 * listed in place inside the fly-out, one surface from the row.
 *
 * Ported from the cascade rework in the other WebUI implementation
 * (`176b8b7 feat(webui): the model picker is a cascade again, not a two-column
 * panel`). The rules are unchanged; the entry type is this repository's.
 */
import type { WebuiModelPickerEntry } from "../components/ModelPicker.js";

/** Which tier of the cascade is showing. */
export type CascadeTier = "list" | "settings";

/**
 * True when this model has anything to configure.
 *
 * Drives the ONE asymmetry in the whole cascade: a model with settings is not
 * finished when its row is clicked, and a model without them is. Getting this
 * backwards is visible immediately — a model with nothing to set would refuse
 * to close, and a model with settings would close before the user could reach
 * its controls — which is exactly why it is a named predicate rather than an
 * inline `!== 0`.
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

/** What a click on a model row does to the surface. */
export type RowClickOutcome = "close" | "advance";

/**
 * What clicking a model row does: complete the selection, or advance to the
 * settings tier.
 *
 * The asymmetry is the point of the cascade, and it is deliberate:
 *
 *   - A model with NO settings completes on its own click. There is nothing
 *     left to visit, so keeping the surface open would strand the user on a
 *     menu they have finished with.
 *   - A model WITH settings records the model — which is also what turns its
 *     fly-out from a read-only preview into live controls — and LEAVES the
 *     surface open. The selection completes by picking a context window from
 *     the fly-out.
 */
export function rowClickOutcome(model: WebuiModelPickerEntry | undefined): RowClickOutcome {
  return modelHasSettings(model) ? "advance" : "close";
}

/** What committing the THINKING control does to the surface. */
export type ThinkingCommitOutcome = "close" | "keep-open";

/**
 * What committing the THINKING control does.
 *
 * Records and keeps the fly-out open. Closing here would make it impossible to
 * set a level and a window in one visit, which is the ordinary thing a user does
 * when they open a model's settings at all — the context sizes are listed in the
 * same surface, so the two controls are meant to be adjusted together.
 *
 * Choosing a window behaves the other way: that is the commitment that closes
 * the picker. The asymmetry is the reference's completion rule, and it is why
 * this is a named outcome rather than two call sites deciding independently.
 */
export function thinkingCommitOutcome(): ThinkingCommitOutcome {
  return "keep-open";
}

/**
 * True when the fly-out's controls are a PREVIEW and must render disabled.
 *
 * A fly-out describing a model the user has not picked renders its controls
 * disabled. The recorded settings belong to the ACTIVE model, and committing
 * them for an unpicked model has no contract meaning: the picker's
 * `onSettingChange` reports a change against a model the runtime is not using.
 *
 * So the options are still SHOWN — the user can see what the model offers before
 * committing to it — but they cannot be committed until the row is picked, and
 * picking the row is what makes the surface live.
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

/**
 * The tier to show after a row click.
 *
 * Separate from `rowClickOutcome` because the two answer different questions —
 * "does the surface stay?" and "what do we draw?" — and a caller that derived
 * one from the other by inverting a boolean would be expressing a guess.
 */
export function tierAfterRowClick(model: WebuiModelPickerEntry | undefined): CascadeTier {
  return rowClickOutcome(model) === "advance" ? "settings" : "list";
}
