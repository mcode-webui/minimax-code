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
} from "../../shared/contracts/account.js";
import type { WebuiUsageQuotaResult } from "../../shared/contracts/usage-quota.js";

export interface AccountPort {
  readonly getUsageQuota?: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<WebuiUsageQuotaResult>;
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
}
