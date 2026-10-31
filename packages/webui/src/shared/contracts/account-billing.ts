// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiCreditFallbackView` | Whether chat usage may fall back to credits once the M Plan quota is exhausted. | Runtime `UsageQuotaClient` (`runtime/usage-quota.ts`). | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageModelSettings.tsx`. |
// | `WebuiResetCardView` | One redeemable reset card. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
// | `WebuiResetCardListResult` | The page of reset cards plus the server-side total. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
// | `WebuiResetCardFlowView` | One grant/use record of a reset card. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
// | `WebuiResetCardFlowsResult` | A page of reset-card history. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
// | `WebuiResetCardOutcome` | The redemption result the account API reports. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
// | `WebuiResetCardUseResult` | The redemption answer. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/ui/UsageResetCards.tsx`. |
//
// The Desktop is the behavioural authority for this surface: the account API
// paths, the `outcome` enum, the card identity key and the phase machine were
// read out of the Desktop renderer bundle before this contract was written.

/**
 * Whether the account may spend credits (including gifted credits) once the
 * plan quota is exhausted. `enabled` is absent while the read has not resolved
 * or failed; `resolved` says whether the read produced a verdict.
 */
export interface WebuiCreditFallbackView {
  readonly enabled?: boolean;
  readonly resolved: boolean;
}

/** One redeemable reset card. */
export interface WebuiResetCardView {
  readonly cardId: string;
  /** The human card name; the client falls back to its own copy when absent. */
  readonly name?: string;
  /** The quota the card resets (`FIVE_HOUR` / `WEEKLY` / `VIDEO`). */
  readonly quotaType?: string;
  /** The account-side identity pair; the redemption request sends both back. */
  readonly sourceType?: string;
  readonly outBizNo?: string;
  readonly createTimeMs?: number;
  readonly expireTimeMs?: number;
}

/** A page of reset cards. `total` is the server-side count across all pages. */
export interface WebuiResetCardListResult {
  readonly cards: readonly WebuiResetCardView[];
  readonly total: number;
}

/** One grant/use record of a reset card. */
export interface WebuiResetCardFlowView {
  readonly cardId: string;
  /** `GRANT` when the card was issued, `USE` when it was redeemed. */
  readonly eventType: string;
  readonly name?: string;
  readonly createTimeMs?: number;
  readonly sourceType?: string;
}

/** A page of reset-card history. */
export interface WebuiResetCardFlowsResult {
  readonly flows: readonly WebuiResetCardFlowView[];
}

/**
 * The redemption result. `SUCCESS` and `REPLAYED` mean the quota was reset;
 * the rest describe why the card could not be used.
 */
export type WebuiResetCardOutcome =
  | "SUCCESS"
  | "REPLAYED"
  | "EXPIRED"
  | "NOT_FOUND"
  | "RETRYABLE_FAIL"
  | "LOCK_BUSY"
  | "UNKNOWN";

/** The redemption answer. */
export interface WebuiResetCardUseResult {
  readonly outcome: WebuiResetCardOutcome;
}
