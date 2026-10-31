// One model-draft selection workflow.
//
// Selecting a model and editing one of its settings used to be three handlers in
// the picker, each assembling the next draft and each making its own decision
// about committing and closing. They agreed by convention, which is how a
// "changed a setting" path and a "picked a model" path drift apart — one of them
// leaves the tick beside a model the user has just chosen. The decision is a
// catalogue fact, so it lives here once and the picker performs it.

import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts/model-view.js";
import { thinkingDraftPatch } from "./thinking-control.public.js";

/**
 * What the user did to the row.
 *
 * A row click finishes a visit; a thinking level is a mid-visit edit that keeps
 * the panel open so a window can still be picked in the same visit; a context
 * window is the commitment that completes the selection.
 */
export type ModelDraftChange =
  | { readonly kind: "select" }
  | { readonly kind: "thinking"; readonly option: string }
  | { readonly kind: "context"; readonly value: number };

export interface ModelDraftResolution {
  /** The draft the row now carries. */
  readonly draft: WebuiModelPickerDraft;
  /**
   * Whether the change is also a settings write. A plain selection is not: the
   * row's settings were already committed when they were edited, and the local
   * draft is the mirror of that, not a second write.
   */
  readonly commitsSettings: boolean;
  /** Whether the change finishes the visit and the menu closes. */
  readonly closes: boolean;
}

/**
 * Resolves one change into the row's next draft, whether it writes settings, and
 * whether it closes the menu.
 *
 * A thinking option RESETS to the model's configured default, flips the wire
 * VARIANT, or records a depth level depending on its shape — that mapping is
 * `thinkingDraftPatch`'s, and the option is reported verbatim by the control
 * rather than pre-mapped there.
 *
 * The picker performs the resolution itself: it has ONE write to make, and
 * making it twice — once as a settings change and once as a selection — put two
 * answers to one press on the wire, in the order the runtime felt like
 * answering them. The panel that owns the control is the only surface that
 * decides what a change DOES, so the decision is here and the calls are
 * there.
 */
export function resolveModelDraftSelection(params: {
  readonly model: WebuiModelPickerEntry;
  readonly draft: WebuiModelPickerDraft;
  readonly change: ModelDraftChange;
}): ModelDraftResolution {
  const { model, draft, change } = params;
  switch (change.kind) {
    case "select":
      return { draft, commitsSettings: false, closes: true };
    case "thinking":
      return {
        draft: { ...draft, ...thinkingDraftPatch(model, change.option) },
        commitsSettings: true,
        closes: false,
      };
    case "context":
      return {
        draft: { ...draft, contextLimit: change.value },
        commitsSettings: true,
        closes: true,
      };
  }
}
