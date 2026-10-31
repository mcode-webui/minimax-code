// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiModelEntry` | One model available to the composer/settings. | Runtime `listModels` (`runtime/harness/models-plugins.ts`; CliService). | `client/features/settings/contracts/settings-port.ts`; `client/features/sessions/projection/action-requests.public.ts`; `client/features/composer/ui/WebuiComposer.tsx`; `client/features/settings/ui/SettingsModal.tsx`; `runtime/commands/runner.ts`. |
// | `WebuiSkillEntry` | A slash-palette skill (name/displayName/description). | Runtime `listSkills` (`runtime/harness/models-plugins.ts`, maps the harness `SkillInfo` subset). | `client/features/composer/ui/slash-palette.ts` (structural read); `server/operation/queue.ts` (`listSkills` response). |
export interface WebuiModelEntry {
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Which upstream serves this model: a first-party provider, the user's own
   * MiniMax API key, or a provider the user configured themselves.
   *
   * The runtime has always sent this; the port just never declared it, so the
   * client could not tell a model the account's plan meters from one another
   * account bills. `isTokenPlanModel` reads it to decide whether the plan
   * figures belong beside a given model.
   */
  readonly providerSource?: "provider" | "minimax_api" | "custom_provider";
  readonly displayName?: string;
  readonly selected?: boolean;
  readonly enabled?: boolean;
  readonly variant?: string;
  /**
   * The variants this model reports: `""` for thinking off, `thinking` for on,
   * a level name for a depth scale. `listModels` fills it with
   * `normalizeSupportedVariants`; the client's `resolveEffortOptions` reads it
   * to decide whether a `switchable` model gets an on/off control.
   *
   * The runtime has always sent it; the port just never declared it, so the
   * client's read sat on the index signature like a condition only the client
   * believed in.
   */
  readonly supportedVariants?: readonly string[];
  readonly effortOptions?: readonly string[];
  readonly defaultEffort?: string;
  readonly contextWindowOptions?: readonly number[];
  readonly contextWindowOptionHints?: Readonly<Record<string, string>>;
  readonly contextLimit?: number;
  /**
   * The runtime's thinking contract. `default_value` is what marks a
   * `switchable` model as having an on/off thinking switch, and the client's
   * `resolveEffortOptions` reads it to decide whether to draw the brain.
   */
  readonly thinkingConfig?: {
    readonly mode?: string;
    readonly default_value?: "true" | "false";
  };
  readonly thinking?: { readonly effort?: string };
  readonly providerName?: string;
  readonly status?: {
    readonly state?: string;
    readonly lastErrorMessage?: string;
  };
  readonly [key: string]: unknown;
}

/**
 * Minimal skill projection the WebUI composer needs to populate the slash
 * palette. Mirrors the `listSkills(agentName, ...)` call shape;
 * the harness returns whatever subset of `SkillInfo` it needs, and the
 * client only depends on these three fields to render the popover row.
 */
export interface WebuiSkillEntry {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}

/* ------------------------------------------------------------------ *
 * Provider write requests.
 *
 * These mirror the runtime's real provider inputs
 * (`packages/local-runtime-v2/src/application/session/process-local-application-contract.ts`,
 * `modelProviders`), field for field. They are **request** types, so their
 * extension data stays open: the runtime forwards fields it does not know, and a
 * validator that rebuilt a lossy whitelist would drop them. The read DTOs are
 * closed instead — a known read must not carry an index signature.
 * ------------------------------------------------------------------ */

/**
 * One model entry submitted with a provider create, update or candidate. Mirrors
 * the runtime's `UserModelInputView`.
 */
export interface WebuiUserModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly configurationSource?: string;
  readonly enabled?: boolean;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly temperature?: boolean;
  readonly capabilities?: Record<string, unknown>;
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly thinkingConfig?: { readonly mode?: string; readonly defaultValue?: string };
  readonly effortOptions?: readonly string[];
  /** Extensions the runtime supports today or grows later; forwarded unchanged. */
  readonly [extension: string]: unknown;
}

/**
 * The candidate a discovery, save or test call carries. `baseUrl` is the one
 * field every call requires; the saved-provider branch adds
 * `providerId` + `expectedRevision`, the new-provider branch adds
 * `name` + `apiKey` + `apiFormat` (see the discovery request below).
 */
export interface WebuiModelProviderCandidateInput {
  readonly providerId?: string;
  readonly expectedRevision?: string;
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly apiFormat?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly removeHeaders?: readonly string[];
  readonly models?: readonly WebuiUserModelInput[];
  readonly [extension: string]: unknown;
}

/** `createUserModelProvider`: a new provider needs its endpoint and its key. */
export interface WebuiCreateUserModelProviderRequest {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiFormat?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly WebuiUserModelInput[];
  readonly saveAndUse?: boolean;
  readonly [extension: string]: unknown;
}

/**
 * `updateUserModelProvider`: every patch field is optional, and an empty
 * `apiKey` is meaningful — it clears the stored key, where omitting it keeps it.
  * That three-way distinction is the runtime's (`normalizeApiKeyUpdate`).
 */
export interface WebuiUpdateUserModelProviderRequest {
  readonly providerId: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiFormat?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly removeHeaders?: readonly string[];
  readonly enabled?: boolean;
  readonly models?: readonly WebuiUserModelInput[];
  readonly saveAndUse?: boolean;
  readonly [extension: string]: unknown;
}

/**
 * `discoverUserModelsCandidate`: exactly one of the runtime's two branches, both
 * carrying the endpoint. A half-filled branch is a rejection, not a defaulted
 * request — the runtime's input type is a union and never an optional bag.
 */
export type WebuiDiscoverUserModelsCandidateRequest = {
  readonly baseUrl: string;
  readonly [extension: string]: unknown;
} & (
  | { readonly providerId: string; readonly expectedRevision: string }
  | { readonly name: string; readonly apiKey: string; readonly apiFormat: string }
);

/** `saveUserModelProviderCandidate`: the nested candidate plus the outer save options. */
export interface WebuiSaveUserModelProviderCandidateRequest {
  readonly candidate: WebuiModelProviderCandidateInput;
  /** Optional: the panel submits the first typed model id, which may be blank. */
  readonly modelId?: string;
  readonly saveAndUse?: boolean;
  readonly skipConnectionTest?: boolean;
  readonly [extension: string]: unknown;
}

/** `testUserModelCandidate`: the nested candidate and the model to probe. */
export interface WebuiTestUserModelCandidateRequest {
  readonly candidate: WebuiModelProviderCandidateInput;
  readonly modelId: string;
  readonly [extension: string]: unknown;
}

/** One discovered model, as discovery answers it. */
export interface WebuiDiscoveredModel {
  readonly modelId: string;
  readonly displayName?: string;
}

/* ------------------------------------------------------------------ *
 * Provider reads.
 *
 * Closed on purpose: these describe a payload the runtime actually sends
 * (`ModelProviderView` in `local-runtime-v2`'s model-system contracts), so an
 * index signature here would make `provider.revision` and `provider.headers`
 * typecheck when the real fields are `configRevision` and `headerNames` — the
 * two misspellings this DTO exists to stop.
 * ------------------------------------------------------------------ */

/** The cached status of one provider or model, as the runtime reports it. */
export interface WebuiModelCacheStatus {
  readonly state: string;
  readonly lastTestedAt?: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

/**
 * One model under a provider. `providerId`/`modelConfigId` and the capability
 * flags are the runtime's; the model pickers read `displayName`, `enabled`,
 * `selected` and `thinking`.
 */
export interface WebuiModelProviderModelEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly displayName: string;
  readonly configurationSource?: "manual" | "discovered";
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly contextLimit?: number;
  readonly defaultContextLimit?: number;
  readonly thinking?: { readonly effort?: string };
  readonly contextWindowOptions?: readonly number[];
  readonly contextWindowOptionHints?: Readonly<Record<string, "higher_usage">>;
  readonly maxOutputTokens?: number;
  readonly effortOptions?: readonly string[];
  readonly defaultEffort?: string;
  readonly supportedVariants?: readonly string[];
  readonly thinkingConfig?: {
    readonly mode: "switchable" | "forced_on" | "forced_off" | "hidden";
    readonly default_value?: "true" | "false";
  };
  readonly variant?: string;
  readonly providerSource?: string;
  readonly providerKind?: string;
  readonly providerName?: string;
  readonly apiFormat?: string;
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
  readonly status?: WebuiModelCacheStatus;
}

/**
 * One configured provider.
 *
 * `headerNames` is **names only** and `maskedApiKey` is masked: raw saved
 * credential values are deliberately never sent, so the editor reconstructs a
 * saved header row from its name and keeps the stored value unless the row is
 * renamed or removed.
 */
export interface WebuiModelProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly source: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly apiFormat?: string;
  readonly hasApiKey: boolean;
  readonly maskedApiKey?: string;
  readonly headerNames?: readonly string[];
  /** The revision a candidate write must carry to be accepted. */
  readonly configRevision?: string;
  readonly models: readonly WebuiModelProviderModelEntry[];
  readonly status?: WebuiModelCacheStatus;
}
