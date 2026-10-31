// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiUsageQuotaWindowView` | One percentage window (5-hour / weekly) of the token-plan quota. | Runtime `UsageQuotaClient` (`runtime/usage-quota.ts`). | `client/features/account/ui/UserMenuUsage.tsx` (via `WebuiUsageQuotaResult`). |
// | `WebuiUsageQuotaVideoView` | The count-based video quota. | Runtime `UsageQuotaClient`. | `client/features/account/ui/UserMenuUsage.tsx`. |
// | `WebuiUsageQuotaView` | The token-plan quota view (fiveHour, weekly, video). | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts` (via `WebuiUsageQuotaResult`). |
// | `WebuiUsageQuotaResult` | The account quota answer (signed-out, or plan/credit fields plus quota). | Runtime `getUsageQuota` (`runtime/harness/account.ts`; `runtime/usage-quota.ts`). | `client/features/account/contracts/account-port.ts`; `client/features/account/ui/UserMenuUsage.tsx`; `client/features/settings/ui/UsageModelSettings.tsx`; `client/features/composer/ui/WebuiComposer.tsx`. |
/** One percentage window (5-hour / weekly) of the token-plan quota. */
export interface WebuiUsageQuotaWindowView {
  /** Used percent, 0-100, already rounded; absent when unlimited or unknown. */
  readonly usedPercent?: number;
  /** Total percent for the window (the API reports `100%`); drives 总额 X%. */
  readonly totalPercent?: number;
  readonly resetAtMs?: number;
  readonly unlimited: boolean;
}

/** The video quota is count-based (`used/total`), not percentage-based. */
export interface WebuiUsageQuotaVideoView {
  readonly usedCount?: number;
  readonly totalCount?: number;
  readonly resetAtMs?: number;
  readonly unlimited: boolean;
}

export interface WebuiUsageQuotaView {
  readonly fiveHour: WebuiUsageQuotaWindowView;
  readonly weekly: WebuiUsageQuotaWindowView;
  readonly video?: WebuiUsageQuotaVideoView;
}

export type WebuiUsageQuotaResult =
  | { readonly signedIn: false }
  | {
      readonly signedIn: true;
      readonly hasTokenPlan?: boolean;
      /** Raw credit balance as the account API reports it (string or numeric string). */
      readonly creditBalance?: string;
      readonly tokenPlanTier?: string;
      /**
       * The account's plan subscription kind as the membership API reports it
       * (`mplan` / `token_plan` / `agent_plan` / `none`). The Desktop picks the
       * model-source label from it: the legacy `token_plan` subscription still
       * reads "Token Plan", every other kind reads "M Plan".
       */
      readonly subscriptionType?: string;
      /** The plan display name the membership API reports (`plan_name`). */
      readonly planName?: string;
      readonly tokenPlanExpiresAt?: number;
      readonly upgradeAction?: string;
      readonly willRenewal?: boolean;
      readonly purchasedCredits?: string;
      readonly freeCredits?: string;
      readonly quota?: WebuiUsageQuotaView;
    };
