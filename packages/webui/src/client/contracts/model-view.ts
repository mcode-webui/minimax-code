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

/**
 * One provider's rows in the picker, or the favourites section that repeats
 * starred rows above them.
 *
 * Moved here from `components/ModelPicker.tsx` so the pure picker projections
 * (`projection/model-favorites.ts`, `projection/model-picker-search.ts`) can
 * consume it without importing a React component (plan §3).
 */
export interface WebuiModelProviderGroup {
  /**
   * Stable identity for the group: the provider id, or `FAVORITES_SECTION_ID`
   * for the starred section. This is what React keys on and what the search
   * filter keeps order by — NOT `label`, because two providers are free to
   * share a display name and keying on it would make the second one a
   * duplicate-key render.
   */
  readonly id: string;
  readonly label: string;
  readonly models: readonly WebuiModelPickerEntry[];
  /**
   * The provider each row really belongs to, keyed by `modelKey` — set only on
   * a section that is not the model's own provider, which today means the
   * favourites section.
   *
   * A starred model is listed TWICE on purpose: it stays where the catalogue
   * put it, under the provider that owns it, and it is also repeated at the top
   * because that is what a shortlist is for. The repeat is the only part that
   * needs explaining, so every repeated row says which provider it came from.
   * Without it, a favourites list of eight rows from five providers is eight
   * names with no way to tell a deprecated model from a different vendor's.
   */
  readonly modelOriginLabels?: Readonly<Record<string, string>>;
}

export interface WebuiModelSelectionRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly contextLimit?: number;
  readonly thinking?: { readonly effort?: string } | null;
  readonly sessionId?: string;
}
