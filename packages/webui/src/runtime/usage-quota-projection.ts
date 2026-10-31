// The pure half of the quota client: payload in, view out.
//
// Split from `runtime/usage-quota.ts` along the one boundary it actually has.
// The client next to this module owns the request and the cache — identity keys,
// TTLs, in-flight sharing, force-refresh, signing, auth rejection and the
// credits-only degradation — because those decisions only make sense together
// and share one cache. What is left is arithmetic and field picking over
// untrusted JSON, and it is the part that can be reasoned about without a clock,
// a fetch or a credential.
//
// The bodies are the ones that sat in `usage-quota.ts`; only the `export`
// keyword, this header and the import specifiers differ. The client keeps
// `normalizeCacheTtl` (cache policy) and `optionalIdentityField` (identity
// assembly), which are not payload projection.

import type {
  WebuiUsageQuotaVideoView,
  WebuiUsageQuotaWindowView,
} from "../shared/contracts/usage-quota.js";

export interface ProjectedMembership {
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
  /**
   * The personal workspace's name. The Desktop reads the account's phone
   * number from this field, so the account page masks it the same way.
   */
  readonly workspaceName?: string;
}

/** Reads the fields the usage panel derives `hasTokenPlan`/credits from. */
export function projectMembership(body: Record<string, unknown>): ProjectedMembership {
  const data = asRecord(body.data);
  const hasTokenPlan = readBoolean(body, data, "has_token_plan");
  const opGroupId = readString(body, data, "op_group_id");
  const creditSummary = asRecord(body.op_credit_summary) ?? asRecord(data?.op_credit_summary);
  const creditBalance =
    readString(creditSummary, undefined, "total_remaining_amount") ??
    readNumberishString(body, data, "opcredit_balance");
  const tokenPlanTier = readString(body, data, "token_plan_tier");
  // The Desktop reads the plan name from two places: `token_plan_tier` when the
  // account is subscribed and `plan_name` when it is not. `subscription_type`
  // tells the two subscription kinds apart — the legacy `token_plan` one still
  // reads "Token Plan", every other kind reads "M Plan".
  const subscriptionType = readString(body, data, "subscription_type");
  const planName = readString(body, data, "plan_name");
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
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(planName ? { planName } : {}),
    ...(tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt } : {}),
    ...(upgradeAction ? { upgradeAction } : {}),
    ...(willRenewal !== undefined ? { willRenewal } : {}),
    ...(purchasedCredits !== undefined ? { purchasedCredits } : {}),
    ...(freeCredits !== undefined ? { freeCredits } : {}),
  };
}

export function projectPersonalWorkspace(
  body: Record<string, unknown>,
):
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
    const workspaceName = readString(workspace, undefined, "workspace_name");
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
      ...(membership.subscriptionType ? { subscriptionType: membership.subscriptionType } : {}),
      ...(membership.planName ? { planName: membership.planName } : {}),
      ...(membership.tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt: membership.tokenPlanExpiresAt } : {}),
      ...(membership.upgradeAction ? { upgradeAction: membership.upgradeAction } : {}),
      ...(membership.willRenewal !== undefined ? { willRenewal: membership.willRenewal } : {}),
      ...(membership.purchasedCredits !== undefined ? { purchasedCredits: membership.purchasedCredits } : {}),
      ...(membership.freeCredits !== undefined ? { freeCredits: membership.freeCredits } : {}),
      ...(workspaceName !== undefined ? { workspaceName } : {}),
    };
  }
  return undefined;
}

export function mergeMembership(
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
  const subscriptionType = scoped.subscriptionType ?? personal.subscriptionType;
  const planName = scoped.planName ?? personal.planName;
  const tokenPlanExpiresAt = scoped.tokenPlanExpiresAt ?? personal.tokenPlanExpiresAt;
  const upgradeAction = scoped.upgradeAction ?? personal.upgradeAction;
  const willRenewal = scoped.willRenewal ?? personal.willRenewal;
  const purchasedCredits = scoped.purchasedCredits ?? personal.purchasedCredits;
  const freeCredits = scoped.freeCredits ?? personal.freeCredits;
  const workspaceName = personal.workspaceName ?? scoped.workspaceName;
  return {
    ...(hasTokenPlan !== undefined ? { hasTokenPlan } : {}),
    ...(opGroupId ? { opGroupId } : {}),
    ...(creditBalance !== undefined ? { creditBalance } : {}),
    ...(tokenPlanTier ? { tokenPlanTier } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(planName ? { planName } : {}),
    ...(tokenPlanExpiresAt !== undefined ? { tokenPlanExpiresAt } : {}),
    ...(upgradeAction ? { upgradeAction } : {}),
    ...(willRenewal !== undefined ? { willRenewal } : {}),
    ...(purchasedCredits !== undefined ? { purchasedCredits } : {}),
    ...(freeCredits !== undefined ? { freeCredits } : {}),
    ...(workspaceName !== undefined ? { workspaceName } : {}),
  };
}

export function isVideoRow(row: Record<string, unknown>): boolean {
  return /video/iu.test(readString(row, undefined, "model_name") ?? "");
}

/**
 * Normalizes one percentage window (5-hour / weekly) from the
 * `remains_percent` response: `current_interval_used_percent` is the USED
 * percent as a `"96%"` string (probe-verified 2026-09-22 — the panel renders
 * it as 已用 96%). `resetAtMs` comes from
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

export function readString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
