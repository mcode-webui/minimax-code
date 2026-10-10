// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiUsageQuotaWindowView` | One percentage window (5-hour / weekly) of the token-plan quota. | Runtime `UsageQuotaClient` (`runtime/usage-quota.ts`). | `client/components/UserMenu.tsx` (via `WebuiUsageQuotaResult`). |
// | `WebuiUsageQuotaVideoView` | The count-based video quota. | Runtime `UsageQuotaClient`. | `client/components/UserMenu.tsx`. |
// | `WebuiUsageQuotaView` | The token-plan quota view (fiveHour, weekly, video). | Runtime `UsageQuotaClient`. | `client/contracts/account-port.ts` (via `WebuiUsageQuotaResult`). |
// | `WebuiUsageQuotaResult` | The account quota answer (signed-out, or plan/credit fields plus quota). | Runtime `getUsageQuota` (`runtime/harness/account.ts`; `runtime/usage-quota.ts`). | `client/contracts/account-port.ts`; `client/components/UserMenu.tsx`; `client/components/settings/UsageModelSettings.tsx`; `client/components/SessionComposer.tsx`. |
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
      readonly tokenPlanExpiresAt?: number;
      readonly upgradeAction?: string;
      readonly willRenewal?: boolean;
      readonly purchasedCredits?: string;
      readonly freeCredits?: string;
      readonly quota?: WebuiUsageQuotaView;
    };
