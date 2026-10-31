// Account capability port.
//
// Account login/quota/check-in/sign-out. Split from the monolithic
// `WebuiTransport` in the former `client/contracts.ts`; `transport.ts`
// composes it. Every method stays optional — `undefined` means "the operation
// is not wired".

import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "../../../../shared/contracts/account.js";
import type {
  WebuiCreditFallbackView,
  WebuiResetCardFlowsResult,
  WebuiResetCardListResult,
  WebuiResetCardUseResult,
} from "../../../../shared/contracts/account-billing.js";
import type {
  WebuiAccountProfileView,
  WebuiUsageSummaryView,
} from "../../../../shared/contracts/account-usage.js";
import type { WebuiUsageQuotaResult } from "../../../../shared/contracts/usage-quota.js";

export interface AccountPort {
  readonly getUsageQuota?: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<WebuiUsageQuotaResult>;
  /** Whether chat usage may fall back to credits once the plan quota is spent. */
  readonly getCreditFallback?: () => Promise<WebuiCreditFallbackView>;
  /** Turns the credit fallback on or off; the answer is the account's verdict. */
  readonly setCreditFallback?: (request: {
    readonly enabled: boolean;
  }) => Promise<WebuiCreditFallbackView>;
  /** One page of the account's redeemable reset cards. */
  readonly listResetCards?: (request?: {
    readonly page?: number;
    readonly size?: number;
  }) => Promise<WebuiResetCardListResult>;
  /** Redeems one reset card. */
  readonly useResetCard?: (request: {
    readonly sourceType?: string;
    readonly outBizNo?: string;
  }) => Promise<WebuiResetCardUseResult>;
  /** One page of the reset-card history. */
  readonly queryResetCardFlows?: (request?: {
    readonly page?: number;
    readonly size?: number;
    readonly createTimeMs?: number;
  }) => Promise<WebuiResetCardFlowsResult>;
  /** The account page's calendar: the lifetime token usage. */
  readonly getAccountUsageSummary?: () => Promise<WebuiUsageSummaryView>;
  /** The account page's profile: the display name, the avatar, the phone. */
  readonly getAccountProfile?: () => Promise<WebuiAccountProfileView>;
  readonly getSigninPanel?: () => Promise<WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<WebuiClaimSigninView>;
  /** Account login (device authorization) and its polling/cancel pair.
   *  Optional like every capability: an un-wired host shows no login entry. */
  readonly beginAccountLogin?: () => Promise<WebuiAccountLoginView>;
  readonly getAccountLoginStatus?: () => Promise<WebuiAccountLoginView>;
  readonly cancelAccountLogin?: () => Promise<{ readonly ok: true }>;
  readonly getAccountStatus?: (request?: {
    readonly sessionId?: string;
  }) => Promise<Record<string, unknown>>;
  readonly signOut?: () => Promise<{ readonly success?: boolean }>;
  /** Credential-status reads. They answer *which* credential the runtime holds,
   *  so they belong to the Account lifetime, not to the settings surface that
   *  happens to render them. */
  readonly getMiniMaxApiKeyStatus?: () => Promise<Record<string, unknown>>;
  readonly getCodexOAuthStatus?: () => Promise<Record<string, unknown>>;
}
