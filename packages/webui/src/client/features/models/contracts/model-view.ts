// Browser-local model picker view types.
//
// `features/models/ui/ModelPicker.tsx` and
// `features/sessions/projection/action-requests.public.ts` consume these; they are declared
// here so the projection layer can compose a selection request without importing the
// React component.

export interface WebuiModelPickerEntry {
  readonly providerId: string;
  /** Human-facing provider label; the picker groups rows by it. */
  readonly providerName?: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly variant?: string;
  readonly supportedVariants?: readonly string[];
  readonly effortOptions?: readonly string[];
  readonly defaultEffort?: string;
  readonly contextWindowOptions?: readonly number[];
  readonly contextWindowOptionHints?: Readonly<Record<string, string>>;
  readonly contextLimit?: number;
  /**
   * The runtime's thinking contract for this model.
   *
   * `default_value` is the runtime's own statement that a `switchable` model
   * has an on/off thinking switch, and it arrives here whether or not the
   * variant list does. `resolveEffortOptions` reads it so the panel's control
   * does not depend on a second field surviving the trip.
   */
  readonly thinkingConfig?: {
    readonly mode?: string;
    readonly default_value?: "true" | "false";
  };
  readonly thinking?: { readonly effort?: string };
  readonly [key: string]: unknown;
}

export interface WebuiModelPickerDraft {
  readonly variant?: string;
  readonly contextLimit?: number;
  /** null resets to the model's configured default effort. */
  readonly thinkingEffort?: string | null;
}

/**
 * One provider's rows in the picker.
 *
 * Moved here so the picker's projection (`features/models/projection/model-picker-rows.ts`)
 * can compose a group without importing a React component.
 */
export interface WebuiModelProviderGroup {
  /**
   * Stable identity for the group: the provider id.
   *
   * This is what React keys on — NOT `label`, because two providers are free to
   * share a display name and keying on it would make the second one a
   * duplicate-key render.
   */
  readonly id: string;
  readonly label: string;
  readonly models: readonly WebuiModelPickerEntry[];
}

export interface WebuiModelSelectionRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly contextLimit?: number;
  readonly thinking?: { readonly effort?: string } | null;
  readonly sessionId?: string;
}
