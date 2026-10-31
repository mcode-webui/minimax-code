// Cloud account-quota client for the WebUI's user-menu usage panel.
//
// The usage panel reads two cloud APIs: billing/quota
// (`GET /backend/account/token_plan/remains_percent` — the exact endpoint it
// renders from) and membership
// (`POST /matrix/api/v1/commerce/get_membership_info`, preceded by
// `get_user_extra_info` to resolve the personal workspace). Both require a
// fresh OAuth lease from `@mavis/oauth-core`; the cli-auth projection
// (`<dataDir>/cli-auth/.../local-runtime.auth.json`) carries a harness bearer
// the account APIs reject with 401 / "cookie is missing" (verified by probe,
// 2026-09-22). The assembly therefore supplies a `tokenProvider` that leases
// from oauth-core, mirroring what `packages/tui/src/tui/launcher.ts` does for
// its account client.
//
// ADR 0003 forbids importing `packages/tui`, whose
// `src/account/matrix-account-client.ts` implements the same wire protocol.
// This module mirrors that client deliberately rather than by import: same
// origin tables, same query/signature headers, same membership projection.
// Read `matrix-account-client.ts` when changing this file — the terminal
// client is the reference implementation.
//
// Wire-protocol constants (`app_id` / `version_code`) tag a request as a
// first-party MiniMax client; the `yy` / `x-timestamp` / `x-signature` triple
// they travel with is built by `./signing.js`, which the daily check-in client
// shares.

import { webuiFirstPartySignatureHeaders } from "./signing.js";

import type {
  WebuiAccountProfileView,
  WebuiUsageSummaryView,
} from "../shared/contracts/account-usage.js";
import type {
  WebuiCreditFallbackView,
  WebuiResetCardFlowsResult,
  WebuiResetCardListResult,
  WebuiResetCardUseResult,
} from "../shared/contracts/account-billing.js";
import type {
  WebuiUsageQuotaResult,
  WebuiUsageQuotaVideoView,
  WebuiUsageQuotaView,
  WebuiUsageQuotaWindowView,
} from "../shared/contracts/usage-quota.js";
import {
  projectCreditFallback,
  projectResetCardFlows,
  projectResetCardList,
  projectResetCardUse,
} from "./reset-card-projection.js";
import {
  projectAccountProfile,
  projectUsageSummary,
} from "./usage-summary-projection.js";
import {
  asRecord,
  finiteNumber,
  isVideoRow,
  mergeMembership,
  projectMembership,
  projectPersonalWorkspace,
  readQuotaWindow,
  readString,
  readVideoQuota,
  type ProjectedMembership,
} from "./usage-quota-projection.js";

const MATRIX_ORIGINS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cn: {
    prod: "https://agent.minimaxi.com",
    staging: "https://matrix-pre.example.invalid",
    test: "https://matrix-test.example.invalid",
    dev: "https://matrix-test.example.invalid",
  },
  en: {
    prod: "https://agent.minimax.io",
    staging: "https://matrix-overseas-pre.example.invalid",
    test: "https://matrix-overseas-test.example.invalid",
    dev: "https://matrix-overseas-test.example.invalid",
  },
};

const OPEN_PLATFORM_ORIGINS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cn: {
    prod: "https://www.minimaxi.com",
    staging: "https://open-platform-for-online-test.example.invalid",
    test: "https://openplatform-test.example.invalid",
    dev: "https://openplatform-test.example.invalid",
  },
  en: {
    prod: "https://platform.minimax.io",
    staging: "https://mmx-pre.example.invalid",
    test: "https://mmx-test.example.invalid",
    dev: "https://mmx-test.example.invalid",
  },
};

const USER_EXTRA_INFO_PATH = "/matrix/api/v1/user/get_user_extra_info";
const MEMBERSHIP_INFO_PATH = "/matrix/api/v1/commerce/get_membership_info";
const USER_INFO_PATH = "/v1/api/user/info";
// The account page's profile read: the display name, the avatar and the
// registration time the Desktop's account page renders.
const USER_PROFILE_PATH = "/matrix/api/v1/user/profile";
// The panel's own quota endpoint: returns used/total percent per
// window (`"96%"` / `"100%"`) plus count-based video rows. The sibling
// `/v1/api/openplatform/coding_plan/remains` reports *remaining* percent and
// feeds the terminal client's "% left" display — not this panel's copy.
const TOKEN_PLAN_REMAINS_PATH = "/backend/account/token_plan/remains_percent";
// The credit pool and the reset cards live on the same open-platform origin as
// the quota endpoint above; the paths and the request/response shapes were read
// out of the Desktop renderer bundle, which is the behavioural authority for
// this surface.
const TOKEN_PLAN_CREDIT_PATH = "/backend/account/token_plan_credit";
const TOKEN_PLAN_CREDIT_FALLBACK_PATH = "/backend/account/token_plan_credit/fallback";
const RESET_CARD_LIST_PATH = "/backend/account/reset_card/list";
const RESET_CARD_USE_PATH = "/backend/account/reset_card/use";
const RESET_CARD_FLOWS_PATH = "/backend/account/reset_card/flows";
// The account page's calendar: the cumulative token total, the busiest day and
// one entry per day for the last 365 days. It lives on the same open-platform
// origin as the quota endpoint above; the path and the query were read out of
// the Desktop renderer bundle.
const USAGE_SUMMARY_PATH = "/backend/account/token_plan/usage_summary";
/** The Desktop asks for the text models of the last 365 days. */
const USAGE_SUMMARY_HEATMAP_DAYS = 365;
const USAGE_SUMMARY_TOKEN_TYPE = 5;
/** The Desktop pages the reset-card list and the history 20 rows at a time. */
const RESET_CARD_PAGE_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MEMBERSHIP_CACHE_TTL_MS = 30_000;
const DEFAULT_QUOTA_CACHE_TTL_MS = 5_000;
const NEED_LOGIN_ERROR_CODE = 1_000_048;

export interface UsageQuotaTokenContext {
  readonly accessToken: string;
  readonly realUserID?: string;
}

export interface UsageQuotaAccountIdentity {
  readonly realUserID: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
}

export interface UsageQuotaClientOptions {
  /**
   * Resolves a fresh account-API credential (oauth-core lease in production).
   * Returns undefined when nobody is signed in — the panel renders the
   * signed-out copy, not an error.
   */
  readonly tokenProvider: () => Promise<UsageQuotaTokenContext | undefined>;
  readonly region: "cn" | "en";
  readonly buildEnv: "dev" | "test" | "staging" | "prod";
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly membershipCacheTtlMs?: number;
  readonly quotaCacheTtlMs?: number;
  readonly now?: () => number;
  readonly timezoneOffsetSeconds?: () => number;
}

interface BillingContext {
  readonly hasTokenPlan?: boolean;
  readonly opGroupId?: string;
  readonly creditBalance?: string;
  readonly tokenPlanTier?: string;
  readonly subscriptionType?: string;
  readonly planName?: string;
  readonly tokenPlanExpiresAt?: number;
  readonly upgradeAction?: string;
  readonly willRenewal?: boolean;
  readonly purchasedCredits?: string;
  readonly freeCredits?: string;
  /** The personal workspace's name — the account's phone number. */
  readonly workspaceName?: string;
}

interface CacheEntry<V> {
  readonly key: string;
  readonly expiresAtMs: number;
  readonly value: V;
}

/**
 * The one owner of the account-billing requests and their cache.
 *
 * The absence of a split is as much a decision as a split is, so it is recorded
 * here: this class stays in one piece. The identity keys, the two TTLs, the
 * in-flight sharing, the force-refresh path, the signing headers, the auth
 * rejection and the credits-only degradation are one policy, and they share one
 * cache — a reader that spread them over per-endpoint modules would have to hand
 * the cache and the clock between them, which is exactly the complexity the
 * split would have been meant to remove. What left is the pure projection in
 * `usage-quota-projection.ts` and `reset-card-projection.ts`.
 *
 * The surface it owns is the account-billing one the Desktop settings page
 * shows: the plan quota (`token_plan/remains_percent`), the credit fallback
 * switch (`token_plan_credit`) and the reset cards (`reset_card/*`). The
 * Desktop renderer calls the same endpoints from the same origin, so this is
 * the same seam rather than a new one.
 */
export class UsageQuotaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly timezoneOffsetSeconds: () => number;
  private readonly membershipCacheTtlMs: number;
  private readonly quotaCacheTtlMs: number;
  private billingCache: CacheEntry<BillingContext> | undefined;
  private billingInFlight: Promise<BillingContext> | undefined;
  private billingInFlightKey: string | undefined;
  private quotaCache: CacheEntry<WebuiUsageQuotaView | undefined> | undefined;
  private quotaInFlight: Promise<WebuiUsageQuotaView | undefined> | undefined;
  private quotaInFlightKey: string | undefined;
  private identityCache: CacheEntry<UsageQuotaAccountIdentity> | undefined;
  private identityInFlight: Promise<UsageQuotaAccountIdentity> | undefined;
  private identityInFlightKey: string | undefined;

  constructor(private readonly options: UsageQuotaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.timezoneOffsetSeconds =
      options.timezoneOffsetSeconds ?? (() => new Date().getTimezoneOffset() * -60);
    this.membershipCacheTtlMs = normalizeCacheTtl(
      options.membershipCacheTtlMs,
      DEFAULT_MEMBERSHIP_CACHE_TTL_MS,
    );
    this.quotaCacheTtlMs = normalizeCacheTtl(
      options.quotaCacheTtlMs,
      DEFAULT_QUOTA_CACHE_TTL_MS,
    );
  }

  /**
   * The panel's payload. A missing lease yields `{ signedIn: false }` so the
   * panel can render the signed-out copy instead of an error. A membership
   * failure throws (the panel shows its error-plus-retry branch); a quota
   * failure after a successful membership read does not — the panel degrades
   * to the credits-only row when quota data is empty.
   */
  async getUsageQuota(options?: { forceRefresh?: boolean }): Promise<WebuiUsageQuotaResult> {
    const token = await this.options.tokenProvider().catch(() => undefined);
    if (!token) return { signedIn: false };
    const force = options?.forceRefresh === true;
    const billing = await this.resolveBillingContext(token, force);
    if (billing.hasTokenPlan === false) {
      return {
        signedIn: true,
        hasTokenPlan: false,
        ...(billing.creditBalance !== undefined
          ? { creditBalance: billing.creditBalance }
          : {}),
        ...(billing.tokenPlanTier ? { tokenPlanTier: billing.tokenPlanTier } : {}),
        ...(billing.subscriptionType ? { subscriptionType: billing.subscriptionType } : {}),
        ...(billing.planName ? { planName: billing.planName } : {}),
        ...(billing.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: billing.tokenPlanExpiresAt } : {}),
        ...(billing.upgradeAction ? { upgradeAction: billing.upgradeAction } : {}),
        ...(billing.willRenewal !== undefined ? { willRenewal: billing.willRenewal } : {}),
        ...(billing.purchasedCredits !== undefined ? { purchasedCredits: billing.purchasedCredits } : {}),
        ...(billing.freeCredits !== undefined ? { freeCredits: billing.freeCredits } : {}),
      };
    }
    const quota = await this.resolveQuota(token, billing.opGroupId, force).catch(
      () => undefined,
    );
    return {
      signedIn: true,
      ...(billing.hasTokenPlan !== undefined ? { hasTokenPlan: billing.hasTokenPlan } : {}),
      ...(billing.creditBalance !== undefined
        ? { creditBalance: billing.creditBalance }
        : {}),
      ...(billing.tokenPlanTier ? { tokenPlanTier: billing.tokenPlanTier } : {}),
      ...(billing.subscriptionType ? { subscriptionType: billing.subscriptionType } : {}),
      ...(billing.planName ? { planName: billing.planName } : {}),
      ...(billing.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: billing.tokenPlanExpiresAt } : {}),
      ...(billing.upgradeAction ? { upgradeAction: billing.upgradeAction } : {}),
      ...(billing.willRenewal !== undefined ? { willRenewal: billing.willRenewal } : {}),
      ...(billing.purchasedCredits !== undefined ? { purchasedCredits: billing.purchasedCredits } : {}),
      ...(billing.freeCredits !== undefined ? { freeCredits: billing.freeCredits } : {}),
      ...(quota ? { quota } : {}),
    };
  }

  /**
   * Whether chat usage may fall back to credits once the plan quota is
   * exhausted. A signed-out account reads as "not resolved" rather than as
   * "off": the settings row hides itself in that case instead of showing a
   * switch that cannot be written.
   */
  async getCreditFallback(): Promise<WebuiCreditFallbackView> {
    const token = await this.options.tokenProvider().catch(() => undefined);
    if (!token) return { resolved: false };
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(TOKEN_PLAN_CREDIT_PATH, {
      method: "GET",
      token,
      opGroupId: billing.opGroupId,
    });
    return projectCreditFallback(body);
  }

  /**
   * Turns the credit fallback on or off. The answer is the account API's own
   * verdict, not the requested value: the Desktop re-reads the flag from the
   * response so the switch cannot drift from the server.
   */
  async setCreditFallback(request: {
    readonly enabled: boolean;
  }): Promise<WebuiCreditFallbackView> {
    const token = await this.requireBillingToken();
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(TOKEN_PLAN_CREDIT_FALLBACK_PATH, {
      method: "PUT",
      token,
      opGroupId: billing.opGroupId,
      body: { enabled: request.enabled },
    });
    return projectCreditFallback(body);
  }

  /** One page of the account's redeemable reset cards. */
  async listResetCards(request?: {
    readonly page?: number;
    readonly size?: number;
  }): Promise<WebuiResetCardListResult> {
    const token = await this.requireBillingToken();
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(RESET_CARD_LIST_PATH, {
      method: "GET",
      token,
      opGroupId: billing.opGroupId,
      query: {
        page: request?.page ?? 1,
        size: request?.size ?? RESET_CARD_PAGE_SIZE,
      },
    });
    return projectResetCardList(body);
  }

  /**
   * Redeems one reset card. The card identity the account API expects is the
   * `(source_type, out_biz_no)` pair the card was issued with, not its id.
   */
  async useResetCard(request: {
    readonly sourceType?: string;
    readonly outBizNo?: string;
  }): Promise<WebuiResetCardUseResult> {
    const token = await this.requireBillingToken();
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(RESET_CARD_USE_PATH, {
      method: "POST",
      token,
      opGroupId: billing.opGroupId,
      body: {
        source_type: request.sourceType ?? "",
        out_biz_no: request.outBizNo ?? "",
      },
    });
    return projectResetCardUse(body);
  }

  /**
   * One page of the reset-card history. `createTimeMs` is the lower bound the
   * Desktop asks for: the history window is the last 30 days.
   */
  async queryResetCardFlows(request?: {
    readonly page?: number;
    readonly size?: number;
    readonly createTimeMs?: number;
  }): Promise<WebuiResetCardFlowsResult> {
    const token = await this.requireBillingToken();
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(RESET_CARD_FLOWS_PATH, {
      method: "GET",
      token,
      opGroupId: billing.opGroupId,
      query: {
        page: request?.page ?? 1,
        size: request?.size ?? RESET_CARD_PAGE_SIZE,
        create_time: request?.createTimeMs,
      },
    });
    return { flows: projectResetCardFlows(body) };
  }

  /**
   * The account page's calendar: the lifetime token total, the busiest day and
   * one entry per day. The Desktop asks the same endpoint for the same window,
   * so this is the same seam rather than a new one.
   */
  async getUsageSummary(): Promise<WebuiUsageSummaryView> {
    const token = await this.requireBillingToken();
    const billing = await this.resolveBillingContext(token, false);
    const body = await this.openPlatformRequest(USAGE_SUMMARY_PATH, {
      method: "GET",
      token,
      opGroupId: billing.opGroupId,
      query: {
        token_type: USAGE_SUMMARY_TOKEN_TYPE,
        heatmap_days: USAGE_SUMMARY_HEATMAP_DAYS,
      },
    });
    return projectUsageSummary(body);
  }

  /**
   * The account page's profile: the display name, the avatar and the
   * registration time the calendar's first column depends on.
   *
   * The phone number comes from the personal workspace, which is a different
   * endpoint; a failed workspace read degrades to no phone instead of failing
   * the whole profile.
   */
  async getAccountProfile(): Promise<WebuiAccountProfileView> {
    const token = await this.requireBillingToken();
    const [body, workspaceName] = await Promise.all([
      this.getMatrixJson(USER_PROFILE_PATH, token, "account profile request"),
      this.resolveBillingContext(token, false)
        .then((billing) => billing.workspaceName)
        .catch(() => undefined),
    ]);
    return projectAccountProfile(body, { phone: workspaceName });
  }

  /** Resolves the account identity required by the identity and check-in UI. */
  async resolveAccountIdentity(accessToken: string): Promise<UsageQuotaAccountIdentity> {
    const key = accessToken;
    const cached = this.identityCache;
    if (cached?.key === key && cached.expiresAtMs > this.now()) return cached.value;
    if (this.identityInFlightKey === key && this.identityInFlight) return this.identityInFlight;

    const request = this.fetchAccountIdentity(accessToken);
    this.identityInFlight = request;
    this.identityInFlightKey = key;
    const settle = () => {
      if (this.identityInFlight === request) {
        this.identityInFlight = undefined;
        this.identityInFlightKey = undefined;
      }
    };
    void request.then(
      (value) => {
        if (this.identityInFlight === request) {
          this.identityCache = {
            key,
            expiresAtMs: this.now() + this.membershipCacheTtlMs,
            value,
          };
        }
        settle();
      },
      () => settle(),
    );
    return request;
  }

  private async resolveBillingContext(
    token: UsageQuotaTokenContext,
    forceRefresh: boolean,
  ): Promise<BillingContext> {
    if (!forceRefresh) {
      const cached = this.billingCache;
      if (cached?.key === token.accessToken && cached.expiresAtMs > this.now()) {
        return cached.value;
      }
      if (this.billingInFlightKey === token.accessToken && this.billingInFlight) {
        return this.billingInFlight;
      }
    }
    const request = this.fetchBillingContext(token);
    this.billingInFlight = request;
    this.billingInFlightKey = token.accessToken;
    const settle = () => {
      if (this.billingInFlight === request) {
        this.billingInFlight = undefined;
        this.billingInFlightKey = undefined;
      }
    };
    void request.then(
      (value) => {
        if (!forceRefresh && this.billingInFlight === request) {
          this.billingCache = {
            key: token.accessToken,
            expiresAtMs: this.now() + this.membershipCacheTtlMs,
            value,
          };
        }
        settle();
      },
      () => settle(),
    );
    return request;
  }

  private async fetchBillingContext(token: UsageQuotaTokenContext): Promise<BillingContext> {
    let personalWorkspace:
      | {
        workspaceId: number | string;
        opGroupId?: string;
        hasTokenPlan?: boolean;
        creditBalance?: string;
        tokenPlanTier?: string;
        subscriptionType?: string;
        planName?: string;
        tokenPlanExpiresAt?: number;
        upgradeAction?: string;
        willRenewal?: boolean;
        purchasedCredits?: string;
        freeCredits?: string;
        workspaceName?: string;
        }
      | undefined;
    try {
      const userExtra = await this.postMatrixJson(
        USER_EXTRA_INFO_PATH,
        {},
        token,
        "workspace lookup",
      );
      personalWorkspace = projectPersonalWorkspace(userExtra);
    } catch {
      const fallback = await this.postMatrixJson(
        MEMBERSHIP_INFO_PATH,
        {},
        token,
        "membership request",
      );
      return projectMembership(fallback);
    }
    if (!personalWorkspace) return {};
    let merged: ProjectedMembership = {
      ...(personalWorkspace.hasTokenPlan !== undefined
        ? { hasTokenPlan: personalWorkspace.hasTokenPlan }
        : {}),
      ...(personalWorkspace.creditBalance !== undefined
        ? { creditBalance: personalWorkspace.creditBalance }
        : {}),
      ...(personalWorkspace.opGroupId ? { opGroupId: personalWorkspace.opGroupId } : {}),
      ...(personalWorkspace.tokenPlanTier ? { tokenPlanTier: personalWorkspace.tokenPlanTier } : {}),
      ...(personalWorkspace.subscriptionType ? { subscriptionType: personalWorkspace.subscriptionType } : {}),
      ...(personalWorkspace.planName ? { planName: personalWorkspace.planName } : {}),
      ...(personalWorkspace.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: personalWorkspace.tokenPlanExpiresAt } : {}),
      ...(personalWorkspace.upgradeAction ? { upgradeAction: personalWorkspace.upgradeAction } : {}),
      ...(personalWorkspace.willRenewal !== undefined ? { willRenewal: personalWorkspace.willRenewal } : {}),
      ...(personalWorkspace.purchasedCredits !== undefined ? { purchasedCredits: personalWorkspace.purchasedCredits } : {}),
      ...(personalWorkspace.freeCredits !== undefined ? { freeCredits: personalWorkspace.freeCredits } : {}),
      ...(personalWorkspace.workspaceName !== undefined ? { workspaceName: personalWorkspace.workspaceName } : {}),
    };
    try {
      const scoped = await this.postMatrixJson(
        MEMBERSHIP_INFO_PATH,
        { workspace_id: personalWorkspace.workspaceId },
        token,
        "membership request",
      );
      merged = mergeMembership(merged, projectMembership(scoped));
    } catch {
      // The unscoped personal-workspace read already carries the data the
      // panel needs; a failed scoped refresh degrades instead of failing.
    }
    return merged;
  }

  private async resolveQuota(
    token: UsageQuotaTokenContext,
    opGroupId: string | undefined,
    forceRefresh: boolean,
  ): Promise<WebuiUsageQuotaView | undefined> {
    const cacheKey = `${token.accessToken}\u0000${opGroupId ?? ""}`;
    if (!forceRefresh) {
      const cached = this.quotaCache;
      if (cached?.key === cacheKey && cached.expiresAtMs > this.now()) {
        return cached.value;
      }
      if (this.quotaInFlightKey === cacheKey && this.quotaInFlight) {
        return this.quotaInFlight;
      }
    }
    const request = this.fetchQuota(token, opGroupId);
    this.quotaInFlight = request;
    this.quotaInFlightKey = cacheKey;
    const settle = () => {
      if (this.quotaInFlight === request) {
        this.quotaInFlight = undefined;
        this.quotaInFlightKey = undefined;
      }
    };
    void request.then(
      (value) => {
        if (!forceRefresh && this.quotaInFlight === request) {
          this.quotaCache = {
            key: cacheKey,
            expiresAtMs: this.now() + this.quotaCacheTtlMs,
            value,
          };
        }
        settle();
      },
      () => settle(),
    );
    return request;
  }

  private async fetchQuota(
    token: UsageQuotaTokenContext,
    opGroupId: string | undefined,
  ): Promise<WebuiUsageQuotaView | undefined> {
    let body: Record<string, unknown>;
    try {
      body = await this.openPlatformRequest(TOKEN_PLAN_REMAINS_PATH, {
        method: "GET",
        token,
        opGroupId,
      });
    } catch {
      return undefined;
    }
    const modelRemains = Array.isArray(body.model_remains) ? body.model_remains : [];
    const rows = modelRemains
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined);
    // Row selection: the `general` row first, else the first non-video row,
    // else the first row (the bundled SDK's `queryPercent` that produces it).
    const primary =
      rows.find((row) => readString(row, undefined, "model_name") === "general") ??
      rows.find((row) => !isVideoRow(row)) ??
      rows[0];
    if (!primary) return undefined;
    const video = rows.find(
      (row) => isVideoRow(row) && (finiteNumber(row.current_interval_total_count) ?? 0) > 0,
    );
    return {
      fiveHour: readQuotaWindow(primary, "interval"),
      weekly: readQuotaWindow(primary, "weekly"),
      ...(video ? { video: readVideoQuota(video) } : {}),
    };
  }

  /**
   * The one request shape the open-platform account endpoints share: a bearer
   * lease, the group header when the account has a group, and the same
   * `base_resp` / `statusInfo` verdict the Desktop's interceptor applies.
   */
  private async openPlatformRequest(
    pathname: string,
    options: {
      readonly method: "GET" | "POST" | "PUT";
      readonly token: UsageQuotaTokenContext;
      readonly opGroupId?: string;
      readonly query?: Readonly<Record<string, string | number | undefined>>;
      readonly body?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const origin = OPEN_PLATFORM_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) {
      throw new Error(`Usage quota ${pathname} unavailable outside prod origins`);
    }
    const url = new URL(pathname, origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${options.token.accessToken}`,
        ...(options.opGroupId ? { "X-Group-Id": options.opGroupId } : {}),
      },
      ...(payload ? { body: payload } : {}),
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new UsageQuotaAuthError(response.status);
    }
    if (!response.ok) {
      throw new Error(`Usage quota ${pathname} failed with HTTP ${response.status}`);
    }
    const responseBody = asRecord(await response.json());
    if (!responseBody) {
      throw new Error(`Usage quota ${pathname} returned an invalid response`);
    }
    // The open-platform account endpoints carry their verdict in
    // `base_resp.status_code` — the same field the Desktop's client reads. The
    // matrix convention (`statusInfo.code`) belongs to the matrix endpoints and
    // is not consulted here, so the quota endpoint keeps the behaviour it had
    // before this request shape was shared.
    const baseResponse = asRecord(responseBody.base_resp);
    if (
      typeof baseResponse?.status_code === "number" &&
      baseResponse.status_code !== 0
    ) {
      throw new Error(`Usage quota ${pathname} failed with status ${baseResponse.status_code}`);
    }
    return responseBody;
  }

  /** A billing call needs a signed-in account; the panel hides the row instead. */
  private async requireBillingToken(): Promise<UsageQuotaTokenContext> {
    const token = await this.options.tokenProvider().catch(() => undefined);
    if (!token) throw new Error("Account billing is unavailable while signed out");
    return token;
  }

  private async postMatrixJson(
    pathname: string,
    payload: Record<string, unknown>,
    token: UsageQuotaTokenContext,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const origin = MATRIX_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) throw new Error(`Usage quota ${operation} unavailable outside prod origins`);
    const requestTime = this.now();
    const url = buildMatrixUrl(pathname, origin, requestTime, token.realUserID, {
      region: this.options.region,
      timezoneOffsetSeconds: this.timezoneOffsetSeconds(),
    });
    const pathWithSearch = `${url.pathname}${url.search}`;
    const body = JSON.stringify(payload);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${token.accessToken}`,
        ...webuiFirstPartySignatureHeaders({ pathWithSearch, nowMs: requestTime, body }),
      },
      body,
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new UsageQuotaAuthError(response.status);
    }
    if (!response.ok) {
      throw new Error(`Usage quota ${operation} failed with HTTP ${response.status}`);
    }
    const responseBody = asRecord(await response.json());
    if (!responseBody) throw new Error(`Usage quota ${operation} returned an invalid response`);
    assertSuccessfulResponse(responseBody, operation);
    return responseBody;
  }

  /**
   * A matrix read that answers with a body. The matrix endpoints are signed
   * with the same `yy` / `x-timestamp` / `x-signature` triple the POST path
   * uses, so only the method differs.
   */
  private async getMatrixJson(
    pathname: string,
    token: UsageQuotaTokenContext,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const origin = MATRIX_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) throw new Error(`Usage quota ${operation} unavailable outside prod origins`);
    const requestTime = this.now();
    const url = buildMatrixUrl(pathname, origin, requestTime, token.realUserID, {
      region: this.options.region,
      timezoneOffsetSeconds: this.timezoneOffsetSeconds(),
    });
    const pathWithSearch = `${url.pathname}${url.search}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${token.accessToken}`,
        ...webuiFirstPartySignatureHeaders({ pathWithSearch, nowMs: requestTime }),
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new UsageQuotaAuthError(response.status);
    }
    if (!response.ok) {
      throw new Error(`Usage quota ${operation} failed with HTTP ${response.status}`);
    }
    const responseBody = asRecord(await response.json());
    if (!responseBody) throw new Error(`Usage quota ${operation} returned an invalid response`);
    assertSuccessfulResponse(responseBody, operation);
    return responseBody;
  }

  private async fetchAccountIdentity(accessToken: string): Promise<UsageQuotaAccountIdentity> {
    const origin = MATRIX_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) throw new Error("Account identity unavailable outside configured Matrix origins");
    const requestTime = this.now();
    const url = buildMatrixUrl(USER_INFO_PATH, origin, requestTime, undefined, {
      region: this.options.region,
      timezoneOffsetSeconds: this.timezoneOffsetSeconds(),
    });
    const pathWithSearch = `${url.pathname}${url.search}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${accessToken}`,
        ...webuiFirstPartySignatureHeaders({ pathWithSearch, nowMs: requestTime }),
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new UsageQuotaAuthError(response.status);
    }
    if (!response.ok) throw new Error(`Account identity request failed with HTTP ${response.status}`);
    const body = asRecord(await response.json());
    if (!body) throw new Error("Account identity request returned an invalid response");
    assertSuccessfulResponse(body, "account identity request");
    const data = asRecord(body.data);
    const userInfo =
      asRecord(data?.userInfo) ??
      asRecord(data?.user_info) ??
      asRecord(body.userInfo) ??
      asRecord(body.user_info);
    const realUserID =
      readString(userInfo, undefined, "realUserID") ??
      readString(userInfo, undefined, "real_user_id");
    if (!realUserID) throw new Error("Account identity response did not include a user ID");
    return {
      realUserID,
      ...optionalIdentityField(userInfo, "userEmail", "email", "userMail", "user_email"),
      ...optionalIdentityField(userInfo, "userName", "name", "user_name"),
      ...optionalIdentityField(userInfo, "subUserName", "sub_user_name"),
    };
  }
}

export class UsageQuotaAuthError extends Error {
  override readonly name = "UsageQuotaAuthError";

  constructor(readonly status: 401 | 403) {
    super("MiniMax sign-in expired. Run mcode login in the TUI, then retry.");
  }
}

function buildMatrixUrl(
  pathname: string,
  origin: string,
  requestTime: number,
  realUserID: string | undefined,
  options: { region: "cn" | "en"; timezoneOffsetSeconds: number },
): URL {
  const url = new URL(pathname, origin);
  const language = options.region === "cn" ? "zh" : "en";
  url.search = new URLSearchParams({
    device_platform: "mcode",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(requestTime),
    timezone_offset: String(options.timezoneOffsetSeconds),
    sys_language: language,
    lang: language,
    device_id: "0",
    os_name: process.platform,
    browser_name: "mcode",
    user_id: realUserID?.trim() || "0",
    client: "mcode",
  }).toString();
  return url;
}

function assertSuccessfulResponse(body: Record<string, unknown>, operation: string): void {
  const statusInfo = asRecord(body.statusInfo);
  if (typeof statusInfo?.code === "number" && statusInfo.code !== 0) {
    if (statusInfo.code === NEED_LOGIN_ERROR_CODE) throw new UsageQuotaAuthError(401);
    throw new Error(`Usage quota ${operation} failed with status ${statusInfo.code}`);
  }
  const baseResponse = asRecord(body.base_resp);
  if (typeof baseResponse?.status_code === "number" && baseResponse.status_code !== 0) {
    throw new Error(`Usage quota ${operation} failed with status ${baseResponse.status_code}`);
  }
}

function optionalIdentityField(
  source: Record<string, unknown> | undefined,
  outputKey: "userEmail" | "userName" | "subUserName",
  ...keys: string[]
): Partial<UsageQuotaAccountIdentity> {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) {
      return { [outputKey]: value.trim() };
    }
  }
  return {};
}

function normalizeCacheTtl(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
