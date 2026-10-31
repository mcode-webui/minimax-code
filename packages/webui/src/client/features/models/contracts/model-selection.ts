// Turning a chosen model into the request the runtime consumes.
//
// This is model knowledge — what a variant is, why an empty variant is not the
// same as an absent one, which fields a per-pick override may replace — so it
// belongs to Models, and Models publishes it. It used to be built in two places
// outside Models, in two shapes: the composer reached into the sessions
// business's projection for it, and the settings dialog spelled a second,
// thinner version inline from a model's fields. Two builders for one request
// meant a field added to the selection could reach one caller and not the other.
//
// Pure functions: no I/O, no React, no clock.

import type { WebuiModelEntry } from "../../../../shared/contracts/models.js";
import type {
  WebuiModelSelectionRequest,
  WebuiModelPickerDraft,
} from "./model-view.js";

/**
 * The selection request for a model, with the draft's per-pick overrides applied.
 *
 * An override replaces the model's current projection rather than merging into
 * it, and an *empty* variant stays meaningful rather than being dropped: `""`
 * is how a user turns thinking off, so treating it as absence would leave the
 * model's default in force — the picker would appear to accept the choice and
 * the model would keep its old behaviour.
 */
export function buildWebuiModelSelectionRequest(
  model: WebuiModelEntry,
  draft: WebuiModelPickerDraft = {},
  sessionId?: string,
): WebuiModelSelectionRequest {
  const variant = draft.variant !== undefined ? draft.variant : model.variant;
  const contextLimit =
    draft.contextLimit !== undefined
      ? draft.contextLimit
      : typeof model.contextLimit === "number"
        ? model.contextLimit
        : undefined;
  const thinking =
    draft.thinkingEffort === undefined
      ? model.thinking
      : draft.thinkingEffort === null
        ? null
        : { effort: draft.thinkingEffort };
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(variant !== undefined ? { variant } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * The option value (`providerId/modelId/variant`) for a `<select>` model entry.
 *
 * The trailing `variant` is included even when empty so the lookup after a change
 * selects the same catalogue entry the user actually chose. It is the inverse of
 * {@link buildWebuiModelSelectionRequest}, and it lives beside it so the two
 * cannot drift: a value written by one and read by the other is a round trip,
 * and the round trip is where the trailing-slash bug lives.
 */
export function webuiModelOptionValue(model: WebuiModelEntry): string {
  return `${model.providerId}/${model.modelId}/${model.variant ?? ""}`;
}

/** The entry whose option value is `value`, or `undefined`. */
export function webuiModelFromOptionValue(
  models: readonly WebuiModelEntry[],
  value: string,
): WebuiModelEntry | undefined {
  return models.find((candidate) => webuiModelOptionValue(candidate) === value);
}
