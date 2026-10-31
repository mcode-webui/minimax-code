// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiUsageDayView` | One day of the account's token usage. | Runtime `UsageQuotaClient` (`runtime/usage-quota.ts`). | `client/features/account/contracts/account-port.ts`; `client/features/settings/projection/usage-report.ts`. |
// | `WebuiUsageSummaryView` | The account's lifetime token usage: the cumulative total, the busiest day and the usage ranking. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/projection/usage-report.ts`. |
// | `WebuiAccountProfileView` | The signed-in account's public profile: display name, avatar, contact and registration time. | Runtime `UsageQuotaClient`. | `client/features/account/contracts/account-port.ts`; `client/features/settings/projection/usage-report.ts`. |
//
// The Desktop is the behavioural authority for this surface: the
// `usage_summary` and `user/profile` reads, the ranking thresholds and the
// calendar model were read out of the Desktop renderer bundle before this
// contract was written.

/** One day of the account's token usage. */
export interface WebuiUsageDayView {
  /** The calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  /** The day's total token count, already parsed to a number. */
  readonly totalToken: number;
  /** The day's cache-hit rate in percent (`0` when the API did not report one). */
  readonly cacheHitPercent: number;
}

/**
 * The account's lifetime token usage.
 *
 * The three headline numbers stay in the shape the account API reports them:
 * `totalTokenConsumed` and `mostActiveDayTokenCount` keep their compact
 * strings (`"6.21B"`, `"426.11M"`) and `usageRankingPercent` keeps its raw
 * percentage, because the Desktop formats all three in the view layer and the
 * same formatting belongs there.
 */
export interface WebuiUsageSummaryView {
  /** The cumulative token count, e.g. `"6.21B"`. */
  readonly totalTokenConsumed?: string;
  /** The busiest day's token count, e.g. `"426.11M"`. */
  readonly mostActiveDayTokenCount?: string;
  /** The percentile of the account's usage ranking (`1.5` = top 1.5%). */
  readonly usageRankingPercent?: number;
  /** One entry per day the API reported, oldest first. */
  readonly days: readonly WebuiUsageDayView[];
}

/**
 * The signed-in account's public profile.
 *
 * `phone` carries the personal workspace's name, which is the account's
 * phone number; the view layer masks it the way the Desktop does.
 */
export interface WebuiAccountProfileView {
  /** The account's display name. */
  readonly userName?: string;
  /** The uploaded avatar, when the account has one. */
  readonly avatarUrl?: string;
  /** The avatar the account falls back to. */
  readonly defaultAvatarUrl?: string;
  /** The account's contact address, when the account has one. */
  readonly email?: string;
  /** The personal workspace's name — the account's phone number. */
  readonly phone?: string;
  /** When the account was registered, in epoch milliseconds. */
  readonly agentRegisterTimeMs?: number;
}
