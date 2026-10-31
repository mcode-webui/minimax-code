// The account page.
//
// The Desktop is the behavioural authority for this surface, and these tests
// pin down the three things the port had to get right:
//
//  1. the calendar model — 50 week columns ending with the current week, seven
//     days per column, Monday first, the four usage buckets cut at the 25th,
//     50th and 75th percentile of the days that had usage, and the month
//     labels that skip a column less than two away from the previous label;
//  2. the three headline numbers, including the ranking bucket and the
//     busiest-day fallback;
//  3. the two reads the page makes — the usage summary and the profile — and
//     the projection each of them goes through.
//
// The fixtures are shaped after the account API's real answers: the summary
// answers flat with `date_model_usage`, `most_active_day` and
// `total_token_consumed`, and the profile answers flat with `user_name`,
// `avatar_url` and `agent_register_time`.

import { describe, expect, it } from "vitest";

import {
  projectAccountProfile,
  projectUsageSummary,
} from "../../src/runtime/usage-summary-projection.js";
import {
  buildUsageHeatmapModel,
  formatCompactToken,
  formatSpacedToken,
  formatUsageCellDate,
  formatUsageRanking,
  maskAccountPhone,
  parseTokenAmount,
  projectUsageMetrics,
  quantile,
  WEBUI_USAGE_CALENDAR_COLUMNS,
} from "../../src/client/features/settings/projection/usage-report.js";
import { accountUsageShareFileName } from "../../src/client/features/settings/ui/account-usage-share-image.js";
import {
  getAccountProfileOperation,
  getAccountUsageSummaryOperation,
} from "../../src/server/operation/account.js";

/** A day of usage, as the account API reports it. */
const day = (date: string, totalToken: number, cacheHitPercent = "0%"): Record<string, unknown> => ({
  date,
  models: [],
  total_input_token: totalToken,
  total_cache_read_token: 0,
  total_cache_create_token: 0,
  total_output_token: 0,
  total_token: totalToken,
  cache_hit_percent: cacheHitPercent,
});

/** A summary with the given days, in the shape the account API answers. */
const summaryBody = (
  days: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  active_days: days.length,
  base_resp: { status_code: 0 },
  date_model_usage: days,
  most_active_day: { date: days[0]?.["date"], token_count: "426.11M" },
  total_days: days.length,
  total_token_consumed: "6.21B",
  usage_ranking_percent: 1.5,
  ...overrides,
});

describe("the account page's token arithmetic", () => {
  it("parses the compact token strings the account API reports", () => {
    expect(parseTokenAmount("6.21B")).toBe(6.21e9);
    expect(parseTokenAmount("426.11M")).toBe(426.11e6);
    expect(parseTokenAmount("1.20K")).toBe(1200);
    expect(parseTokenAmount("512")).toBe(512);
    expect(parseTokenAmount(".5K")).toBe(500);
    expect(parseTokenAmount(1024)).toBe(1024);
  });

  it("reads an unusable token amount as no usage at all", () => {
    expect(parseTokenAmount("")).toBe(0);
    expect(parseTokenAmount("abc")).toBe(0);
    expect(parseTokenAmount(-5)).toBe(0);
    expect(parseTokenAmount(null)).toBe(0);
    expect(parseTokenAmount(undefined)).toBe(0);
  });

  it("formats the compact form the account page shows", () => {
    expect(formatCompactToken("6.21B")).toBe("6.21B");
    expect(formatCompactToken("426.11M")).toBe("426.11M");
    expect(formatCompactToken(1200)).toBe("1.20K");
    expect(formatCompactToken(512)).toBe("512");
    expect(formatCompactToken(null)).toBe("--");
  });

  it("separates the unit from the digits in the share image's form", () => {
    expect(formatSpacedToken("6.21B")).toBe("6.21 B");
    expect(formatSpacedToken("426.11M")).toBe("426.11 M");
    expect(formatSpacedToken("512")).toBe("512");
  });

  it("buckets the ranking the way the Desktop does", () => {
    expect(formatUsageRanking(1)).toBe("前 1%");
    expect(formatUsageRanking(1.5)).toBe("前 5%");
    expect(formatUsageRanking(12)).toBe("前 25%");
    expect(formatUsageRanking(50)).toBe("前 50%");
    // Above the last bucket there is no bucket to show.
    expect(formatUsageRanking(80)).toBe("—");
    expect(formatUsageRanking(undefined)).toBe("--");
    expect(formatUsageRanking(-1)).toBe("--");
  });

  it("takes the quantile the calendar's thresholds are cut at", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3);
  });

  it("masks the account's phone number the way the Desktop does", () => {
    expect(maskAccountPhone("19931152496")).toBe("199****2496");
    // Anything that is not a phone number is left alone.
    expect(maskAccountPhone("user@example.com")).toBe("user@example.com");
  });

  it("names the day a calendar cell belongs to", () => {
    expect(formatUsageCellDate("2026-10-20")).toBe("10月20日");
  });
});

describe("the account page's three headline numbers", () => {
  it("reads the cumulative total, the busiest day and the ranking", () => {
    const summary = projectUsageSummary(
      summaryBody([day("2026-09-29", 426110000)], {
        most_active_day: { date: "2026-09-29", token_count: "426.11M" },
      }),
    );
    expect(projectUsageMetrics(summary)).toEqual({
      totalToken: "6.21B",
      peakToken: "426.11M",
      usageRanking: "前 5%",
    });
  });

  it("falls back to the busiest day in the series when the API reports none", () => {
    const summary = projectUsageSummary(
      summaryBody([day("2026-09-01", 10), day("2026-09-02", 20)], {
        most_active_day: { date: "2026-09-02", token_count: "" },
      }),
    );
    expect(projectUsageMetrics(summary).peakToken).toBe("20");
  });
});

describe("the account page's calendar", () => {
  const now = new Date("2026-10-21T04:00:00.000Z");

  it("draws 50 week columns of seven days, ending with the current week", () => {
    const model = buildUsageHeatmapModel([], { now });
    expect(model.columns).toHaveLength(WEBUI_USAGE_CALENDAR_COLUMNS);
    expect(model.columns.every((column) => column.cells.length === 7)).toBe(true);
    // The last column is the week the current day belongs to.
    expect(model.today).toBe("2026-10-21");
    expect(model.columns[model.columns.length - 1]?.cells[6]?.date).toBe("2026-10-25");
  });

  it("starts each column on a Monday", () => {
    const model = buildUsageHeatmapModel([], { now });
    const firstCell = model.columns[0]?.cells[0];
    expect(new Date(`${firstCell?.date}T00:00:00.000Z`).getUTCDay()).toBe(1);
  });

  it("marks the days that have not happened yet as future", () => {
    const model = buildUsageHeatmapModel([], { now });
    const future = model.cells.find((cell) => cell.date === "2026-10-22");
    expect(future?.kind).toBe("future");
    expect(future?.level).toBe(0);
  });

  it("marks the days before the account existed as unregistered", () => {
    const model = buildUsageHeatmapModel([], {
      now,
      registrationTimeMs: Date.parse("2026-10-01T00:00:00.000Z"),
    });
    const before = model.cells.find((cell) => cell.date === "2026-09-30");
    expect(before?.kind).toBe("unregistered");
    const after = model.cells.find((cell) => cell.date === "2026-10-02");
    expect(after?.kind).toBe("day");
  });

  it("cuts the four usage buckets at the 25th, 50th and 75th percentile", () => {
    const days = projectUsageSummary(
      summaryBody([
        day("2026-10-01", 10),
        day("2026-10-02", 20),
        day("2026-10-03", 30),
        day("2026-10-04", 40),
        day("2026-10-05", 1000),
      ]),
    ).days;
    const model = buildUsageHeatmapModel(days, { now });
    const level = (date: string): number | undefined =>
      model.cells.find((cell) => cell.date === date)?.level;
    // The thresholds are the quartiles of [10, 20, 30, 40, 1000]: 20, 30 and 40.
    // A day at or below a threshold falls in the bucket that threshold closes.
    expect(level("2026-10-01")).toBe(1);
    expect(level("2026-10-02")).toBe(1);
    expect(level("2026-10-03")).toBe(2);
    expect(level("2026-10-04")).toBe(3);
    expect(level("2026-10-05")).toBe(4);
  });

  it("reads a day without usage as level zero", () => {
    const days = projectUsageSummary(summaryBody([day("2026-10-01", 0)])).days;
    const model = buildUsageHeatmapModel(days, { now });
    expect(model.cells.find((cell) => cell.date === "2026-10-01")?.level).toBe(0);
  });

  it("labels the months and skips a label that would overlap the last one", () => {
    const model = buildUsageHeatmapModel([], { now });
    expect(model.monthLabels.length).toBeGreaterThan(0);
    for (const label of model.monthLabels) {
      expect(label.label).toMatch(/^\d{1,2}$/u);
    }
    const columns = model.monthLabels.map((label) => label.columnIndex);
    for (let index = 1; index < columns.length; index += 1) {
      expect((columns[index] ?? 0) - (columns[index - 1] ?? 0)).toBeGreaterThanOrEqual(2);
    }
  });

  it("records the day the tracking starts", () => {
    const model = buildUsageHeatmapModel([], { now });
    expect(model.trackingStartDate).toBe("2025-11-01");
  });
});

describe("the account page's reads", () => {
  it("projects the usage summary's days", () => {
    const summary = projectUsageSummary(
      summaryBody([day("2026-09-29", 426110000, "84.36%")]),
    );
    expect(summary.totalTokenConsumed).toBe("6.21B");
    expect(summary.mostActiveDayTokenCount).toBe("426.11M");
    expect(summary.usageRankingPercent).toBe(1.5);
    expect(summary.days).toEqual([
      { date: "2026-09-29", totalToken: 426110000, cacheHitPercent: 84.36 },
    ]);
  });

  it("drops a day without a date and reads an unusable cache hit as zero", () => {
    const summary = projectUsageSummary(
      summaryBody([{ total_token: 10 }, day("2026-09-29", 10, "n/a")]),
    );
    expect(summary.days).toEqual([
      { date: "2026-09-29", totalToken: 10, cacheHitPercent: 0 },
    ]);
  });

  it("projects the profile's fields", () => {
    const profile = projectAccountProfile(
      {
        user_id: "484066441267863560",
        user_name: "贾晓源",
        email: "",
        avatar_url: "https://cdn.hailuoai.com/agent-admin/avatar/1.png",
        default_avatar_url: "https://cdn.hailuoai.com/agent-admin/avatar/2.png",
        agent_register_time: 1772266577757,
        base_resp: { status_code: 0 },
      },
      { phone: "19931152496" },
    );
    expect(profile).toEqual({
      userName: "贾晓源",
      avatarUrl: "https://cdn.hailuoai.com/agent-admin/avatar/1.png",
      defaultAvatarUrl: "https://cdn.hailuoai.com/agent-admin/avatar/2.png",
      phone: "19931152496",
      agentRegisterTimeMs: 1772266577757,
    });
  });

  it("reads a profile without a name as no name at all", () => {
    const profile = projectAccountProfile({ user_name: "  " });
    expect(profile.userName).toBeUndefined();
  });

  it("names the share image after the account", () => {
    expect(accountUsageShareFileName("贾晓源")).toBe("Minimax_Code_贾晓源.png");
    expect(accountUsageShareFileName("a/b")).toBe("Minimax_Code_a_b.png");
    expect(accountUsageShareFileName("  ")).toBe("Minimax_Code_User.png");
  });
});

describe("the account page's operations", () => {
  it("takes an empty body, because the reads take no arguments", () => {
    expect(getAccountUsageSummaryOperation.validate({}).ok).toBe(true);
    expect(getAccountProfileOperation.validate({}).ok).toBe(true);
    expect(getAccountUsageSummaryOperation.validate({ page: 1 }).ok).toBe(false);
    expect(getAccountProfileOperation.validate({ page: 1 }).ok).toBe(false);
  });
});
