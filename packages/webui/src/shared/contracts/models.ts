// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiModelEntry` | One model available to the composer/settings. | Runtime `listModels` (`runtime/harness/models-plugins.ts`; CliService). | `client/contracts/settings-port.ts`; `client/projection/action-requests.ts`; `client/components/SessionComposer.tsx`; `client/components/SettingsModal.tsx`; `runtime/commands/runner.ts`. |
// | `WebuiSkillEntry` | A slash-palette skill (name/displayName/description). | Runtime `listSkills` (`runtime/harness/models-plugins.ts`, maps the harness `SkillInfo` subset). | `client/slash-palette.ts` (structural read); `server/operation/queue.ts` (`listSkills` response). |
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
 * palette. Mirrors the desktop's `listSkills(agentName, ...)` call shape;
 * the harness returns whatever subset of `SkillInfo` it needs, and the
 * client only depends on these three fields to render the popover row.
 */
export interface WebuiSkillEntry {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}
