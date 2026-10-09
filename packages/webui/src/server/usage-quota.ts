// Cloud account-quota client for the WebUI's user-menu usage panel.
//
// The desktop's usage popover reads two cloud APIs: billing/quota
// (`GET /backend/account/token_plan/remains_percent` — the exact endpoint its
// popover renders from) and membership
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
// Wire-protocol constants (`yy` / `x-timestamp` / `x-signature`, the inline
// salt, `app_id` / `version_code`) tag a request as a first-party MiniMax
// client. They are shared across all first-party clients and are not
// credentials; authorization is the `Authorization: Bearer` header. Changing
// either value requires a coordinated server-side rollout.

import { createHash } from "node:crypto";

import type {
  WebuiUsageQuotaResult,
  WebuiUsageQuotaVideoView,
  WebuiUsageQuotaView,
  WebuiUsageQuotaWindowView,
} from "../shared/contracts/usage-quota.js";

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
// The desktop popover's own quota endpoint: returns used/total percent per
// window (`"96%"` / `"100%"`) plus count-based video rows. The sibling
// `/v1/api/openplatform/coding_plan/remains` reports *remaining* percent and
// feeds the terminal client's "% left" display — not this panel's copy.
const TOKEN_PLAN_REMAINS_PATH = "/backend/account/token_plan/remains_percent";
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
  readonly tokenPlanExpiresAt?: number;
  readonly upgradeAction?: string;
  readonly willRenewal?: boolean;
  readonly purchasedCredits?: string;
  readonly freeCredits?: string;
}

interface CacheEntry<V> {
  readonly key: string;
  readonly expiresAtMs: number;
  readonly value: V;
}

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
   * failure throws (the panel shows the desktop's error-plus-retry branch);
   * a quota failure after a successful membership read does not — the panel
   * degrades to the credits-only row exactly as the desktop does when quota
   * data is empty.
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
      ...(billing.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: billing.tokenPlanExpiresAt } : {}),
      ...(billing.upgradeAction ? { upgradeAction: billing.upgradeAction } : {}),
      ...(billing.willRenewal !== undefined ? { willRenewal: billing.willRenewal } : {}),
      ...(billing.purchasedCredits !== undefined ? { purchasedCredits: billing.purchasedCredits } : {}),
      ...(billing.freeCredits !== undefined ? { freeCredits: billing.freeCredits } : {}),
      ...(quota ? { quota } : {}),
    };
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
        tokenPlanExpiresAt?: number;
        upgradeAction?: string;
        willRenewal?: boolean;
        purchasedCredits?: string;
        freeCredits?: string;
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
      ...(personalWorkspace.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: personalWorkspace.tokenPlanExpiresAt } : {}),
      ...(personalWorkspace.upgradeAction ? { upgradeAction: personalWorkspace.upgradeAction } : {}),
      ...(personalWorkspace.willRenewal !== undefined ? { willRenewal: personalWorkspace.willRenewal } : {}),
      ...(personalWorkspace.purchasedCredits !== undefined ? { purchasedCredits: personalWorkspace.purchasedCredits } : {}),
      ...(personalWorkspace.freeCredits !== undefined ? { freeCredits: personalWorkspace.freeCredits } : {}),
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
    const origin = OPEN_PLATFORM_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) return undefined;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`${origin}${TOKEN_PLAN_REMAINS_PATH}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.accessToken}`,
        ...(opGroupId ? { "X-Group-Id": opGroupId } : {}),
      },
      signal,
    });
    if (!response.ok) return undefined;
    const body = asRecord(await response.json());
    if (!body) return undefined;
    const baseResponse = asRecord(body.base_resp);
    if (
      typeof baseResponse?.status_code === "number" &&
      baseResponse.status_code !== 0
    ) {
      return undefined;
    }
    const modelRemains = Array.isArray(body.model_remains) ? body.model_remains : [];
    const rows = modelRemains
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined);
    // Mirror the desktop's row selection: the `general` row first, else the
    // first non-video row, else the first row (the bundled SDK's
    // `queryPercent` behind the popover).
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
    const second = Math.floor(requestTime / 1_000);
    const body = JSON.stringify(payload);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${token.accessToken}`,
        yy: md5(`${encodeURIComponent(pathWithSearch)}_${body}${md5(String(requestTime))}ooui`),
        "x-timestamp": String(second),
        "x-signature": md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${body}`),
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

  private async fetchAccountIdentity(accessToken: string): Promise<UsageQuotaAccountIdentity> {
    const origin = MATRIX_ORIGINS[this.options.region]?.[this.options.buildEnv];
    if (!origin) throw new Error("Account identity unavailable outside configured Matrix origins");
    const requestTime = this.now();
    const url = buildMatrixUrl(USER_INFO_PATH, origin, requestTime, undefined, {
      region: this.options.region,
      timezoneOffsetSeconds: this.timezoneOffsetSeconds(),
    });
    const pathWithSearch = `${url.pathname}${url.search}`;
    const second = Math.floor(requestTime / 1_000);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MiniMaxCode",
        Authorization: `Bearer ${accessToken}`,
        yy: md5(`${encodeURIComponent(pathWithSearch)}_{}${md5(String(requestTime))}ooui`),
        "x-timestamp": String(second),
        "x-signature": md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
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

interface ProjectedMembership {
  readonly hasTokenPlan?: boolean;
  readonly opGroupId?: string;
  readonly creditBalance?: string;
  readonly tokenPlanTier?: string;
  readonly tokenPlanExpiresAt?: number;
  readonly upgradeAction?: string;
  readonly willRenewal?: boolean;
  readonly purchasedCredits?: string;
  readonly freeCredits?: string;
}

/** Reads the fields the desktop popover derives `hasTokenPlan`/credits from. */
function projectMembership(body: Record<string, unknown>): ProjectedMembership {
  const data = asRecord(body.data);
  const hasTokenPlan = readBoolean(body, data, "has_token_plan");
  const opGroupId = readString(body, data, "op_group_id");
  const creditSummary = asRecord(body.op_credit_summary) ?? asRecord(data?.op_credit_summary);
  const creditBalance =
    readString(creditSummary, undefined, "total_remaining_amount") ??
    readNumberishString(body, data, "opcredit_balance");
  const tokenPlanTier = readString(body, data, "token_plan_tier");
  const tokenPlanExpiresAt = finiteNumber(body.token_plan_expires_at ?? data?.token_plan_expires_at);
  const upgradeAction = readString(body, data, "upgrade_action");
  const willRenewalValue = body.will_renewal ?? data?.will_renewal;
  const willRenewal = typeof willRenewalValue === "boolean" ? willRenewalValue : undefined;
  const purchasedCredits = readString(creditSummary, undefined, "purchased_remaining_amount");
  const freeCredits = readString(creditSummary, undefined, "free_remaining_amount");
  return {
    ...(hasTokenPlan !== undefined ? { hasTokenPlan } : {}),
    ...(opGroupId ? { opGroupId } : {}),
    ...(creditBalance !== undefined ? { creditBalance } : {}),
    ...(tokenPlanTier ? { tokenPlanTier } : {}),
    ...(tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt } : {}),
    ...(upgradeAction ? { upgradeAction } : {}),
    ...(willRenewal !== undefined ? { willRenewal } : {}),
    ...(purchasedCredits !== undefined ? { purchasedCredits } : {}),
    ...(freeCredits !== undefined ? { freeCredits } : {}),
  };
}

function projectPersonalWorkspace(
  body: Record<string, unknown>,
):
  | {
      workspaceId: number | string;
      opGroupId?: string;
      hasTokenPlan?: boolean;
      creditBalance?: string;
      tokenPlanTier?: string;
      tokenPlanExpiresAt?: number;
      upgradeAction?: string;
      willRenewal?: boolean;
      purchasedCredits?: string;
      freeCredits?: string;
    }
  | undefined {
  const data = asRecord(body.data);
  const workspaces = Array.isArray(body.workspaces)
    ? body.workspaces
    : Array.isArray(data?.workspaces)
      ? data.workspaces
      : [];
  for (const value of workspaces) {
    const workspace = asRecord(value);
    if (!workspace || finiteNumber(workspace.workspace_type) !== 0) continue;
    const workspaceId = readWorkspaceId(workspace.workspace_id);
    if (workspaceId === undefined) continue;
    const membership = projectMembership(workspace);
    return {
      workspaceId,
      ...(membership.opGroupId ? { opGroupId: membership.opGroupId } : {}),
      ...(membership.hasTokenPlan !== undefined
        ? { hasTokenPlan: membership.hasTokenPlan }
        : {}),
      ...(membership.creditBalance !== undefined
        ? { creditBalance: membership.creditBalance }
        : {}),
      ...(membership.tokenPlanTier ? { tokenPlanTier: membership.tokenPlanTier } : {}),
      ...(membership.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: membership.tokenPlanExpiresAt } : {}),
      ...(membership.upgradeAction ? { upgradeAction: membership.upgradeAction } : {}),
      ...(membership.willRenewal !== undefined ? { willRenewal: membership.willRenewal } : {}),
      ...(membership.purchasedCredits !== undefined ? { purchasedCredits: membership.purchasedCredits } : {}),
      ...(membership.freeCredits !== undefined ? { freeCredits: membership.freeCredits } : {}),
    };
  }
  return undefined;
}

function mergeMembership(
  personal: ProjectedMembership,
  scoped: ProjectedMembership,
): ProjectedMembership {
  const hasTokenPlan =
    personal.hasTokenPlan === true || scoped.hasTokenPlan === true
      ? true
      : personal.hasTokenPlan === false || scoped.hasTokenPlan === false
        ? false
        : undefined;
  const creditBalance = scoped.creditBalance ?? personal.creditBalance;
  const opGroupId = personal.opGroupId ?? scoped.opGroupId;
  const tokenPlanTier = scoped.tokenPlanTier ?? personal.tokenPlanTier;
  const tokenPlanExpiresAt = scoped.tokenPlanExpiresAt ?? personal.tokenPlanExpiresAt;
  const upgradeAction = scoped.upgradeAction ?? personal.upgradeAction;
  const willRenewal = scoped.willRenewal ?? personal.willRenewal;
  const purchasedCredits = scoped.purchasedCredits ?? personal.purchasedCredits;
  const freeCredits = scoped.freeCredits ?? personal.freeCredits;
  return {
    ...(hasTokenPlan !== undefined ? { hasTokenPlan } : {}),
    ...(opGroupId ? { opGroupId } : {}),
    ...(creditBalance !== undefined ? { creditBalance } : {}),
    ...(tokenPlanTier ? { tokenPlanTier } : {}),
    ...(tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt } : {}),
    ...(upgradeAction ? { upgradeAction } : {}),
    ...(willRenewal !== undefined ? { willRenewal } : {}),
    ...(purchasedCredits !== undefined ? { purchasedCredits } : {}),
    ...(freeCredits !== undefined ? { freeCredits } : {}),
  };
}

function isVideoRow(row: Record<string, unknown>): boolean {
  return /video/iu.test(readString(row, undefined, "model_name") ?? "");
}

/**
 * Normalizes one percentage window (5-hour / weekly) from the
 * `remains_percent` response: `current_interval_used_percent` is the USED
 * percent as a `"96%"` string (probe-verified 2026-09-22 — the same response
 * the desktop popover renders as 已用 96%). `resetAtMs` comes from
 * `end_time` / `weekly_end_time`, which the API sends in seconds below 1e12
 * or milliseconds above; normalize to ms.
 */
export function readQuotaWindow(
  value: Record<string, unknown>,
  kind: "interval" | "weekly",
): WebuiUsageQuotaWindowView {
  const prefix = kind === "interval" ? "current_interval" : "current_weekly";
  const status = finiteNumber(value[`${prefix}_status`]);
  const unlimited = status === 3;
  const usedPercent = readPercent(value[`${prefix}_used_percent`]);
  const totalPercent = readPercent(value[`${prefix}_total_percent`]);
  const resetAtMs = normalizeEpochMs(
    finiteNumber(value[kind === "interval" ? "end_time" : "weekly_end_time"]),
  );
  return {
    ...(unlimited || usedPercent === undefined ? {} : { usedPercent }),
    ...(unlimited || totalPercent === undefined ? {} : { totalPercent }),
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    unlimited,
  };
}

/** Video quotas are count-based: the panel renders `used/total` (`0/3`). */
export function readVideoQuota(value: Record<string, unknown>): WebuiUsageQuotaVideoView {
  const status = finiteNumber(value.current_interval_status);
  const usedCount = finiteNumber(value.current_interval_used_count);
  const totalCount = finiteNumber(value.current_interval_total_count);
  const resetAtMs = normalizeEpochMs(finiteNumber(value.end_time));
  return {
    ...(usedCount === undefined ? {} : { usedCount: Math.max(0, usedCount) }),
    ...(totalCount === undefined ? {} : { totalCount: Math.max(0, totalCount) }),
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    unlimited: status === 3,
  };
}

/** Parses `"96%"` / `96` / `null` into 0-100; non-finite input → undefined. */
function readPercent(value: unknown): number | undefined {
  const numeric =
    typeof value === "string"
      ? Number(value.trim().replace(/%$/u, ""))
      : typeof value === "number"
        ? value
        : undefined;
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined;
  return Math.round(Math.min(100, Math.max(0, numeric)));
}

function normalizeEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  return value < 1e12 ? value * 1_000 : value;
}

function readWorkspaceId(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function readBoolean(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function readNumberishString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCacheTtl(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
