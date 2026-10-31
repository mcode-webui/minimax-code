// The pure half of the account-usage reads: payload in, view out.
//
// Split from `runtime/usage-quota.ts` along the same boundary the quota
// projection uses: the client owns the request, the credential and the cache;
// this module owns the arithmetic and the field picking over untrusted JSON.
//
// The Desktop renderer is the behavioural authority for these two payloads. The
// token strings (`"6.21B"`, `"426.11M"`) are kept in the shape the account API
// reports them, because the Desktop formats them in the view layer and the same
// formatting belongs there. The per-day totals are already numbers on the
// wire, so they are normalized here and the view only has to format them.

import type {
  WebuiAccountProfileView,
  WebuiUsageDayView,
  WebuiUsageSummaryView,
} from "../shared/contracts/account-usage.js";

/**
 * The account's lifetime token usage.
 *
 * `date_model_usage` carries one entry per day, oldest first; the entries the
 * Desktop skips (a missing date) are dropped here for the same reason.
 */
export function projectUsageSummary(body: Record<string, unknown>): WebuiUsageSummaryView {
  const root = usageRoot(body);
  const mostActiveDay = asRecord(root.most_active_day);
  const totalTokenConsumed = readString(root, undefined, "total_token_consumed");
  const mostActiveDayTokenCount = readString(mostActiveDay, undefined, "token_count");
  const usageRankingPercent = finiteNumber(root.usage_ranking_percent);
  const entries = Array.isArray(root.date_model_usage) ? root.date_model_usage : [];
  const days: WebuiUsageDayView[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const date = readString(record, undefined, "date");
    if (!date) continue;
    days.push({
      date,
      totalToken: positiveNumber(record.total_token),
      cacheHitPercent: readCacheHitPercent(record.cache_hit_percent),
    });
  }
  return {
    ...(totalTokenConsumed !== undefined ? { totalTokenConsumed } : {}),
    ...(mostActiveDayTokenCount !== undefined ? { mostActiveDayTokenCount } : {}),
    ...(usageRankingPercent !== undefined ? { usageRankingPercent } : {}),
    days,
  };
}

/**
 * The account's public profile.
 *
 * The matrix profile endpoint answers with the fields at the top level, not
 * under `data`; the `data` wrapper is accepted too because the same endpoint
 * is served wrapped by some deployments.
 *
 * `phone` is the personal workspace's name — the account's phone number. It
 * comes from a different endpoint than the profile, so it is passed in
 * separately and the profile read still succeeds without it.
 */
export function projectAccountProfile(
  body: Record<string, unknown>,
  options: { readonly phone?: string } = {},
): WebuiAccountProfileView {
  const root = profileRoot(body);
  const userName = readString(root, undefined, "user_name");
  const avatarUrl = readString(root, undefined, "avatar_url");
  const defaultAvatarUrl = readString(root, undefined, "default_avatar_url");
  const email = readString(root, undefined, "email");
  const agentRegisterTimeMs = finiteNumber(root.agent_register_time);
  const phone = options.phone?.trim();
  return {
    ...(userName !== undefined ? { userName } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(defaultAvatarUrl !== undefined ? { defaultAvatarUrl } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(agentRegisterTimeMs !== undefined ? { agentRegisterTimeMs } : {}),
  };
}

/** The usage payload answers flat; a `data` wrapper is accepted as well. */
function usageRoot(body: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(body.data);
  if (!data) return body;
  return "date_model_usage" in data || "total_token_consumed" in data ? data : body;
}

/** The profile payload answers flat; a `data` wrapper is accepted as well. */
function profileRoot(body: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(body.data);
  if (!data) return body;
  return "user_name" in data || "avatar_url" in data ? data : body;
}

/**
 * The cache-hit rate arrives as a percent string (`"84.36%"`). The Desktop
 * parses it with `parseFloat` and clamps it into 0-100; anything unparsable
 * reads as no cache hit.
 */
function readCacheHitPercent(value: unknown): number {
  const numeric =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

/** A day's token total: the Desktop treats anything below zero as no usage. */
function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
