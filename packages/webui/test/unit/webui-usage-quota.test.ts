// The user-menu usage panel's cloud-quota path: response parsing, the
// client's state machine (signed-out / membership / quota degradation /
// caching), the operation validator, and the panel's rendered states.
//
// Response fixtures are verbatim captures from the production account APIs
// (probe, 2026-09-22): `remains_percent` reports used/total percent as
// `"96%"` strings, `get_user_extra_info` carries the personal workspace
// (`has_token_plan`, `op_group_id`, `opcredit_balance`).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  UsageQuotaAuthError,
  UsageQuotaClient,
  readQuotaWindow,
  readVideoQuota,
} from "../../src/runtime/usage-quota.js";
import { getUsageQuotaOperation } from "../../src/server/operation/operations.js";
import {
  UsagePanel,
  formatUsageResetLabel,
} from "../../src/client/components/UserMenu.js";

const REMAINS_PERCENT_BODY = {
  model_remains: [
    {
      model_name: "general",
      start_time: 1790060400000,
      end_time: 1790078400000,
      remains_time: 9099756,
      current_interval_total_count: -1,
      current_interval_used_count: -1,
      current_interval_remains_count: -1,
      current_interval_used_percent: "96%",
      current_interval_total_percent: "100%",
      current_interval_status: 1,
      weekly_start_time: 1789920000000,
      weekly_end_time: 1790524800000,
      weekly_remains_time: 455499756,
      current_weekly_total_count: -1,
      current_weekly_used_count: -1,
      current_weekly_remains_count: -1,
      current_weekly_used_percent: "38%",
      current_weekly_total_percent: "100%",
      current_weekly_status: 1,
    },
    {
      model_name: "video",
      start_time: 1790006400000,
      end_time: 1790092800000,
      remains_time: 23499756,
      current_interval_total_count: 3,
      current_interval_used_count: 0,
      current_interval_remains_count: 3,
      current_interval_used_percent: "0%",
      current_interval_total_percent: "100%",
      current_interval_status: 1,
      current_weekly_total_count: 21,
      current_weekly_used_count: 0,
      current_weekly_status: 1,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

const USER_EXTRA_BODY = {
  user_extra: {},
  workspaces: [
    {
      workspace_id: 0,
      workspace_name: "personal",
      workspace_type: 0,
      status: 0,
      selected: true,
      op_group_id: "2034290788388578210",
      opcredit_balance: 1526,
      has_token_plan: true,
      token_plan_tier: "Max Plan",
      token_plan_expires_at: 1792281600000,
      upgrade_action: "Month",
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

const MEMBERSHIP_BODY = {
  data: {
    has_token_plan: true,
    op_group_id: "2034290788388578210",
    op_credit_summary: { total_remaining_amount: "7726" },
  },
  base_resp: { status_code: 0, status_msg: "success" },
};

interface FetchRouteOptions {
  readonly quotaStatus?: number;
  readonly matrixStatus?: number;
  readonly membershipBody?: Record<string, unknown>;
}

function createRoutedFetch(options: FetchRouteOptions = {}) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ method: init?.method ?? "GET", url, headers });
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("remains_percent")) {
      return respond(REMAINS_PERCENT_BODY, options.quotaStatus ?? 200);
    }
    if (url.includes("get_user_extra_info")) {
      return options.matrixStatus
        ? respond({}, options.matrixStatus)
        : respond(USER_EXTRA_BODY);
    }
    if (url.includes("get_membership_info")) {
      return options.matrixStatus
        ? respond({}, options.matrixStatus)
        : respond(options.membershipBody ?? MEMBERSHIP_BODY);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createClient(options: FetchRouteOptions & {
  readonly signedOut?: boolean;
} = {}): { client: UsageQuotaClient; calls: { method: string; url: string; headers: Record<string, string> }[] } {
  const { fetchImpl, calls } = createRoutedFetch(options);
  const client = new UsageQuotaClient({
    tokenProvider: async () =>
      options.signedOut
        ? undefined
        : { accessToken: "lease-token", realUserID: "123456789012345678" },
    region: "cn",
    buildEnv: "prod",
    fetchImpl,
    now: () => 1_790_070_000_000,
    timezoneOffsetSeconds: () => 28_800,
    membershipCacheTtlMs: 30_000,
    quotaCacheTtlMs: 5_000,
  });
  return { client, calls };
}

describe("quota response parsing", () => {
  it("reads used/total percent and reset time from the remains_percent window", () => {
    const general = (REMAINS_PERCENT_BODY.model_remains[0] ?? {}) as Record<string, unknown>;
    expect(readQuotaWindow(general, "interval")).toEqual({
      usedPercent: 96,
      totalPercent: 100,
      resetAtMs: 1790078400000,
      unlimited: false,
    });
    expect(readQuotaWindow(general, "weekly")).toEqual({
      usedPercent: 38,
      totalPercent: 100,
      resetAtMs: 1790524800000,
      unlimited: false,
    });
  });

  it("normalizes second-epoch reset times to milliseconds", () => {
    const window = readQuotaWindow(
      {
        current_interval_status: 1,
        current_interval_used_percent: "50%",
        current_interval_total_percent: "100%",
        end_time: 1_790_078_400,
      },
      "interval",
    );
    expect(window.resetAtMs).toBe(1_790_078_400_000);
  });

  it("drops percent labels for unlimited windows", () => {
    const window = readQuotaWindow(
      {
        current_interval_status: 3,
        current_interval_used_percent: "12%",
        current_interval_total_percent: "100%",
        end_time: 1790078400000,
      },
      "interval",
    );
    expect(window).toEqual({ resetAtMs: 1790078400000, unlimited: true });
  });

  it("reads the video quota as counts", () => {
    const video = (REMAINS_PERCENT_BODY.model_remains[1] ?? {}) as Record<string, unknown>;
    expect(readVideoQuota(video)).toEqual({
      usedCount: 0,
      totalCount: 3,
      resetAtMs: 1790092800000,
      unlimited: false,
    });
  });
});

describe("UsageQuotaClient", () => {
  it("returns the full panel payload on the happy path", async () => {
    const { client, calls } = createClient();
    const result = await client.getUsageQuota();
    expect(result.signedIn).toBe(true);
    if (result.signedIn === false) throw new Error("unreachable");
    expect(result.hasTokenPlan).toBe(true);
    expect(result.creditBalance).toBe("7726");
    expect(result.quota?.fiveHour.usedPercent).toBe(96);
    expect(result.quota?.weekly.usedPercent).toBe(38);
    expect(result.quota?.video).toMatchObject({ usedCount: 0, totalCount: 3 });
    // The quota GET carries the personal workspace group id.
    const quotaCall = calls.find((call) => call.url.includes("remains_percent"));
    expect(quotaCall?.headers["x-group-id"]).toBe("2034290788388578210");
    expect(quotaCall?.headers.authorization).toBe("Bearer lease-token");
  });

  it("reports signed-out without touching the network when no lease exists", async () => {
    const { client, calls } = createClient({ signedOut: true });
    expect(await client.getUsageQuota()).toEqual({ signedIn: false });
    expect(calls).toHaveLength(0);
  });

  it("throws the auth error when the matrix endpoints reject the lease", async () => {
    const { client } = createClient({ matrixStatus: 401 });
    await expect(client.getUsageQuota()).rejects.toBeInstanceOf(UsageQuotaAuthError);
  });

  it("degrades to credits-only when the quota endpoint fails", async () => {
    const { client } = createClient({ quotaStatus: 500 });
    const result = await client.getUsageQuota();
    expect(result).toEqual({
      signedIn: true,
      hasTokenPlan: true,
      creditBalance: "7726",
      tokenPlanTier: "Max Plan",
      tokenPlanExpiresAt: 1792281600000,
      upgradeAction: "Month",
    });
  });

  it("serves the second read from cache unless forceRefresh is set", async () => {
    const { client, calls } = createClient();
    await client.getUsageQuota();
    const afterFirst = calls.length;
    await client.getUsageQuota();
    expect(calls.length).toBe(afterFirst);
    await client.getUsageQuota({ forceRefresh: true });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});

describe("getUsageQuota operation validation", () => {
  it("accepts an absent body and a boolean forceRefresh", () => {
    expect(getUsageQuotaOperation.validate(undefined)).toEqual({
      ok: true,
      body: {},
    });
    expect(getUsageQuotaOperation.validate({ forceRefresh: true })).toEqual({
      ok: true,
      body: { forceRefresh: true },
    });
    expect(getUsageQuotaOperation.validate({})).toEqual({ ok: true, body: {} });
  });

  it("rejects a non-boolean forceRefresh and a non-object body", () => {
    const badFlag = getUsageQuotaOperation.validate({ forceRefresh: "yes" });
    expect(badFlag.ok).toBe(false);
    const badBody = getUsageQuotaOperation.validate("getUsageQuota");
    expect(badBody.ok).toBe(false);
  });
});

describe("formatUsageResetLabel", () => {
  const now = 1_790_070_000_000;
  it("renders hours and minutes below a day", () => {
    expect(formatUsageResetLabel(now + 3 * 3_600_000 + 13 * 60_000, now)).toBe(
      "3小时13分后重置",
    );
  });
  it("renders days and hours (no minutes) once a day has passed", () => {
    expect(formatUsageResetLabel(now + 5 * 86_400_000 + 7 * 3_600_000, now)).toBe(
      "5天7小时后重置",
    );
  });
  it("renders minutes below an hour", () => {
    expect(formatUsageResetLabel(now + 13 * 60_000, now)).toBe("13分后重置");
  });
  it("renders nothing for past or missing timestamps", () => {
    expect(formatUsageResetLabel(now - 1_000, now)).toBeUndefined();
    expect(formatUsageResetLabel(undefined, now)).toBeUndefined();
  });
});

describe("UsagePanel states", () => {
  const render = (state: Parameters<typeof UsagePanel>[0]["state"]) =>
    renderToStaticMarkup(createElement(UsagePanel, { state, onRetry: () => undefined }));

  it("shows the animated skeleton while loading", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('data-testid="usage-popover-loading"');
    expect(html).toContain("webui-user-menu-usage-skeleton-bar--a");
  });

  it("shows the pending skeleton before the first load", () => {
    expect(render({ status: "idle" })).toContain('data-testid="usage-popover-pending"');
  });

  it("distinguishes auth errors from generic failures and offers retry", () => {
    const authHtml = render({ status: "error", errorMessage: "Run mcode login in the TUI, then retry." });
    expect(authHtml).toContain("请重新登录");
    expect(authHtml).toContain("重试");
    expect(authHtml).toContain('data-testid="usage-popover-error"');
    const genericHtml = render({
      status: "error",
      errorMessage: "Usage quota membership request failed with HTTP 500",
    });
    expect(genericHtml).toContain("加载失败");
  });

  it("shows the signed-out copy when nobody is signed in", () => {
    const html = render({ status: "ready", result: { signedIn: false } });
    expect(html).toContain('data-testid="usage-popover-no-workspace"');
    expect(html).toContain("登录后查看用量");
  });

  it("renders real quota rows, credits and reset labels", () => {
    // Reset stamps are relative to now on purpose: a hard-coded timestamp
    // silently stops rendering its label once wall-clock time passes it, and
    // `formatUsageResetLabel` deliberately renders nothing for a past stamp.
    // A fixed stamp made this test a time bomb.
    const now = Date.now();
    const html = render({
      status: "ready",
      result: {
        signedIn: true,
        hasTokenPlan: true,
        // Verbatim from the production API: desktop renders this as 7,726.
        creditBalance: "7726.2119999999995",
        quota: {
          fiveHour: {
            usedPercent: 96,
            totalPercent: 100,
            // 3h13m out, so the label reads `3小时13分后重置`.
            resetAtMs: now + 3 * 3_600_000 + 13 * 60_000,
            unlimited: false,
          },
          weekly: {
            usedPercent: 38,
            totalPercent: 100,
            // 5d7h out, so the label reads `5天7小时后重置`.
            resetAtMs: now + 5 * 86_400_000 + 7 * 3_600_000,
            unlimited: false,
          },
          video: {
            usedCount: 0,
            totalCount: 3,
            // 13m out, so the label reads `13分后重置`.
            resetAtMs: now + 13 * 60_000,
            unlimited: false,
          },
        },
      },
    });
    expect(html).toContain('data-testid="usage-popover-content"');
    expect(html).toContain("5 小时限额");
    expect(html).toContain("已用 96%");
    expect(html).toContain("总额 100%");
    expect(html).toContain("周限额");
    expect(html).toContain("已用 38%");
    expect(html).toContain("视频限额");
    expect(html).toContain("0/3");
    expect(html).toContain("积分");
    expect(html).toContain("7,726");
    expect(html).not.toContain("7726.21");
    expect(html).toContain("后重置");
    expect(html).toContain("webui-user-menu-usage-hairline");
  });

  it("omits the reset label once the reset stamp is in the past", () => {
    // The other half of the contract: a past stamp must render no label at
    // all, so the popover never claims a reset that already happened.
    const html = render({
      status: "ready",
      result: {
        signedIn: true,
        hasTokenPlan: true,
        creditBalance: "7726.2119999999995",
        quota: {
          fiveHour: {
            usedPercent: 96,
            totalPercent: 100,
            resetAtMs: Date.now() - 60_000,
            unlimited: false,
          },
          weekly: {
            usedPercent: 38,
            totalPercent: 100,
            resetAtMs: Date.now() - 60_000,
            unlimited: false,
          },
        },
      },
    });
    expect(html).toContain("5 小时限额");
    expect(html).not.toContain("后重置");
  });

  it("renders the not-subscribed branch without quota rows", () => {
    const html = render({
      status: "ready",
      result: { signedIn: true, hasTokenPlan: false, creditBalance: "1526" },
    });
    expect(html).toContain("Token Plan");
    expect(html).toContain("未订阅");
    expect(html).toContain("积分");
    expect(html).not.toContain("5 小时限额");
  });

  it("renders credits alone (no hairline) when quota data is absent", () => {
    const html = render({
      status: "ready",
      result: { signedIn: true, hasTokenPlan: true, creditBalance: "7726" },
    });
    expect(html).toContain("积分");
    expect(html).toContain("7,726");
    expect(html).not.toContain("webui-user-menu-usage-hairline");
    expect(html).not.toContain("5 小时限额");
  });
});
