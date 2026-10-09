// Browser-local model picker view types.
//
// `components/ModelPicker.tsx` and `projection/action-requests.ts` consume
// these; they are declared here so the projection layer can compose a
// selection request without importing the React component. Split from the
// former `client/contracts.ts`.

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
   * variant list does. `resolveEffortOptions` reads it so the brain icon does
   * not depend on a second field surviving the trip.
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

export interface WebuiModelSelectionRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly contextLimit?: number;
  readonly thinking?: { readonly effort?: string } | null;
  readonly sessionId?: string;
}
