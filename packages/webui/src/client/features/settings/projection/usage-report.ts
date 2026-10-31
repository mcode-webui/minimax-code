// The account page's arithmetic, ported from the Desktop renderer.
//
// The Desktop's account page is the behavioural authority for this surface: the
// token parsing, the compact formatting, the ranking thresholds, the calendar
// model and the month labels were read out of the Desktop renderer bundle
// (`chunks/69200.*.js`, helpers `t0`/`t1`/`t2`/`t3`/`tJ`/`tQ`/`tG`/`tX`/`tY`
// and the account page's `useMemo`) before this module was written. The rules
// below are transcriptions, not reinterpretations — a different threshold
// table or a different quantile would show a different calendar.
//
// The one thing that is not a transcription is where the numbers come from: the
// Desktop reads the raw account-API payload in the renderer, while the WebUI
// reads a projected payload (see `shared/contracts/account-usage.ts`) and does
// the same arithmetic here.

import type {
  WebuiUsageDayView,
  WebuiUsageSummaryView,
} from "../../../../shared/contracts/account-usage.js";

/** The ranking percentiles the Desktop shows. A ranking above the last one has no bucket. */
export const WEBUI_USAGE_RANKING_THRESHOLDS: readonly number[] = [1, 5, 10, 25, 50];

/** The day the Desktop's usage tracking starts; the calendar's own origin. */
export const WEBUI_USAGE_TRACKING_START_DATE = "2025-11-01";

/** The timezone the Desktop's calendar is drawn in. */
export const WEBUI_USAGE_TIME_ZONE = "Asia/Shanghai";

/** The number of week columns the Desktop's calendar shows. */
export const WEBUI_USAGE_CALENDAR_COLUMNS = 50;

const TOKEN_AMOUNT_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)\s*([KMB]?)$/iu;
const REGIONAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A token count in any of the shapes the account API uses: a number, a plain
 * number string or a compact string (`"6.21B"`). Anything unreadable is zero.
 */
export function parseTokenAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== "string") return 0;
  const match = TOKEN_AMOUNT_PATTERN.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const scaled =
    amount * (unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1);
  return Number.isFinite(scaled) && scaled > 0 ? scaled : 0;
}

/**
 * The compact form the account page shows: `"6.21B"`, `"426.11M"`, `"1.20K"`
 * or a rounded integer. An absent value reads as `"--"`.
 */
export function formatCompactToken(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "--";
  const amount = parseTokenAmount(value);
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
  return String(Math.round(amount));
}

/**
 * The share image's form of the same number: the unit is separated from the
 * digits by a space (`"6.21 B"`).
 */
export function formatSpacedToken(value: string): string {
  return value.replace(/([\d.])([KMB])$/u, "$1 $2");
}

/** The three headline numbers of the account page. */
export interface WebuiUsageMetrics {
  readonly totalToken: string;
  readonly peakToken: string;
  readonly usageRanking: string;
}

/**
 * The account page's three headline numbers.
 *
 * The peak day is the busiest day the account API reports, or — when it
 * reports none — the busiest day in the daily series. The ranking is the
 * percentile bucket the account falls into; above the last bucket the Desktop
 * shows an em dash rather than a made-up percentile.
 */
export function projectUsageMetrics(summary: WebuiUsageSummaryView): WebuiUsageMetrics {
  const busiestDay = parseTokenAmount(summary.mostActiveDayTokenCount);
  const busiestFromDays = (summary.days ?? []).reduce(
    (max, day) => Math.max(max, day.totalToken),
    0,
  );
  return {
    totalToken: formatCompactToken(summary.totalTokenConsumed),
    peakToken: formatCompactToken(busiestDay || busiestFromDays),
    usageRanking: formatUsageRanking(summary.usageRankingPercent),
  };
}

/**
 * The ranking label. An unreadable percentile reads as `"--"`; a percentile
 * above the last bucket reads as an em dash.
 */
export function formatUsageRanking(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent) || percent < 0) return "--";
  const bucket = WEBUI_USAGE_RANKING_THRESHOLDS.find((threshold) => percent <= threshold);
  return bucket === undefined ? "—" : `前 ${bucket}%`;
}

/**
 * The quantile the Desktop's calendar thresholds are cut at. The input is
 * expected to be sorted ascending.
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * q) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

/**
 * Parses a `YYYY-MM-DD` day into its UTC midnight. A day that does not exist
 * (`2026-02-30`) is rejected the way the Desktop rejects it.
 */
export function parseRegionalDate(value: string): number | null {
  if (!REGIONAL_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}

/** The UTC day of a timestamp, as `YYYY-MM-DD`. */
export function formatUtcDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The day a moment falls on in a given timezone, as `YYYY-MM-DD`. */
export function formatZonedDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The cell's readable date: `"10月20日"`. */
export function formatUsageCellDate(date: string): string {
  const [, month = "", day = ""] = date.split("-").map((part) => String(Number(part)));
  return `${month}月${day}日`;
}

/**
 * The account's phone number, masked the way the Desktop masks it: the first
 * three digits and the last four stay, the middle four become `****`.
 */
export function maskAccountPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d{4}(\d+)$/u, "$1****$2");
}

/** One day of the calendar. */
export interface WebuiUsageHeatmapCell {
  readonly date: string;
  readonly totalToken: number;
  readonly cacheHitPercent: number;
  /** `0` = no usage, `1`-`4` = the four usage buckets. */
  readonly level: 0 | 1 | 2 | 3 | 4;
  /**
   * `day` = a day the account could have used, `future` = a day that has not
   * happened yet, `unregistered` = a day before the account existed.
   */
  readonly kind: "day" | "future" | "unregistered";
  readonly columnIndex: number;
  readonly dayIndex: number;
}

/** One week of the calendar. */
export interface WebuiUsageHeatmapColumn {
  readonly weekStart: string;
  readonly cells: readonly WebuiUsageHeatmapCell[];
}

/** One month label, anchored to the column it belongs to. */
export interface WebuiUsageHeatmapMonthLabel {
  readonly label: string;
  readonly columnIndex: number;
}

/** The whole calendar. */
export interface WebuiUsageHeatmapModel {
  readonly today: string;
  readonly trackingStartDate: string | null;
  readonly columns: readonly WebuiUsageHeatmapColumn[];
  readonly cells: readonly WebuiUsageHeatmapCell[];
  readonly monthLabels: readonly WebuiUsageHeatmapMonthLabel[];
}

/**
 * Builds the calendar.
 *
 * The shape is the Desktop's: 50 week columns ending with the current week,
 * seven days per column, Monday first. The four usage buckets are cut at the
 * 25th, 50th and 75th percentile of the days that actually had usage inside
 * the shown range — the same rule the Desktop applies, so the same account
 * produces the same picture.
 */
export function buildUsageHeatmapModel(
  days: readonly WebuiUsageDayView[] | undefined,
  options: {
    readonly registrationTimeMs?: number;
    readonly now?: Date;
    readonly timeZone?: string;
    readonly weekCount?: number;
  } = {},
): WebuiUsageHeatmapModel {
  const timeZone = options.timeZone ?? WEBUI_USAGE_TIME_ZONE;
  const weekCount = options.weekCount ?? WEBUI_USAGE_CALENDAR_COLUMNS;
  const now = options.now ?? new Date();
  const today = formatZonedDate(now, timeZone);
  const todayTimestamp = parseRegionalDate(today);
  if (todayTimestamp === null) {
    throw new Error(`Unable to resolve regional date: ${today}`);
  }
  const usage = new Map<string, WebuiUsageDayView>();
  for (const day of days ?? []) {
    if (!day || parseRegionalDate(day.date) === null) continue;
    usage.set(day.date, day);
  }
  const trackingStart = parseRegionalDate(WEBUI_USAGE_TRACKING_START_DATE);
  const registrationDay = resolveRegistrationDay(
    options.registrationTimeMs,
    timeZone,
    today,
  );
  const firstWeekStart =
    mondayOf(todayTimestamp) - (weekCount - 1) * 7 * 24 * 60 * 60 * 1_000;
  const usedAmounts = [...usage.entries()]
    .filter(([date, day]) => {
      const timestamp = parseRegionalDate(date);
      return (
        day.totalToken > 0 &&
        timestamp !== null &&
        timestamp >= firstWeekStart &&
        timestamp <= todayTimestamp
      );
    })
    .map(([, day]) => day.totalToken)
    .sort((a, b) => a - b);
  const thresholds = [
    quantile(usedAmounts, 0.25),
    quantile(usedAmounts, 0.5),
    quantile(usedAmounts, 0.75),
  ];
  const columns: WebuiUsageHeatmapColumn[] = [];
  for (let columnIndex = 0; columnIndex < weekCount; columnIndex += 1) {
    const weekStart = firstWeekStart + 7 * columnIndex * 24 * 60 * 60 * 1_000;
    const cells: WebuiUsageHeatmapCell[] = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const timestamp = weekStart + dayIndex * 24 * 60 * 60 * 1_000;
      const date = formatUtcDate(timestamp);
      const day = usage.get(date);
      const totalToken = day?.totalToken ?? 0;
      const kind: WebuiUsageHeatmapCell["kind"] =
        timestamp > todayTimestamp
          ? "future"
          : registrationDay !== null && timestamp < registrationDay
            ? "unregistered"
            : "day";
      cells.push({
        date,
        totalToken,
        cacheHitPercent: day?.cacheHitPercent ?? 0,
        level:
          kind === "future" || kind === "unregistered"
            ? 0
            : totalToken <= 0
              ? 0
              : totalToken <= thresholds[0]!
                ? 1
                : totalToken <= thresholds[1]!
                  ? 2
                  : totalToken <= thresholds[2]!
                    ? 3
                    : 4,
        kind,
        columnIndex,
        dayIndex,
      });
    }
    columns.push({ weekStart: formatUtcDate(weekStart), cells });
  }
  return {
    today,
    trackingStartDate: trackingStart === null ? null : formatUtcDate(trackingStart),
    columns,
    cells: columns.flatMap((column) => column.cells),
    monthLabels: buildMonthLabels(columns),
  };
}

/**
 * The month labels under the calendar.
 *
 * A label is placed at the first column of a month, but not on a column that
 * is less than two columns away from the previous label — two labels that
 * close together would overlap, so the second one is dropped.
 */
function buildMonthLabels(
  columns: readonly WebuiUsageHeatmapColumn[],
): WebuiUsageHeatmapMonthLabel[] {
  const labels: WebuiUsageHeatmapMonthLabel[] = [];
  let previousMonth = "";
  let previousColumn = -2;
  for (const [columnIndex, column] of columns.entries()) {
    const month = column.weekStart.slice(0, 7);
    if (month === previousMonth) continue;
    previousMonth = month;
    if (columnIndex - previousColumn < 2) continue;
    labels.push({ label: String(Number(month.slice(5, 7))), columnIndex });
    previousColumn = columnIndex;
  }
  return labels;
}

/** The Monday that starts the week the given day belongs to. */
function mondayOf(timestamp: number): number {
  const weekday = new Date(timestamp).getUTCDay();
  return timestamp - (weekday === 0 ? 6 : weekday - 1) * 24 * 60 * 60 * 1_000;
}

/**
 * The day the account was registered, in the calendar's timezone. A
 * registration time in the future or an unreadable one yields no day, and
 * then no cell is marked as "before registration".
 */
function resolveRegistrationDay(
  registrationTimeMs: number | undefined,
  timeZone: string,
  today: string,
): number | null {
  if (
    registrationTimeMs === undefined ||
    !Number.isFinite(registrationTimeMs) ||
    registrationTimeMs <= 0
  ) {
    return null;
  }
  try {
    const day = parseRegionalDate(formatZonedDate(new Date(registrationTimeMs), timeZone));
    return day !== null && day <= (parseRegionalDate(today) ?? Number.POSITIVE_INFINITY)
      ? day
      : null;
  } catch {
    return null;
  }
}
