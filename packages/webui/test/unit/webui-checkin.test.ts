// Daily check-in: wire-protocol client (copied contract from the TUI
// gateway), operation validators, and the signin card's desktop-parity render.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SigninDayStatus, SigninClaimResult, SigninPanelScene } from "@mavis/shared/daily-signin";
import {
  DailyCheckinClient,
  CheckInAuthError,
} from "../../src/runtime/check-in.js";
import {
  getSigninPanelOperation,
  claimSigninOperation,
} from "../../src/server/operation/operations.js";
import { SigninCard } from "../../src/client/components/UserMenu.js";

const PANEL = {
  scene: SigninPanelScene.Active,
  days: [
    { day_no: 1, points: 400, status: SigninDayStatus.Claimed, is_today: false },
    { day_no: 2, points: 400, status: SigninDayStatus.Claimed, is_today: false },
    { day_no: 3, points: 1000, bonus_points: 100, status: SigninDayStatus.Claimable, is_today: true },
    { day_no: 4, points: 400, status: SigninDayStatus.Upcoming, is_today: false },
    { day_no: 5, points: 400, status: SigninDayStatus.Upcoming, is_today: false },
    { day_no: 6, points: 400, status: SigninDayStatus.Upcoming, is_today: false },
    { day_no: 7, points: 1000, status: SigninDayStatus.Upcoming, is_today: false },
  ],
};

const CLAIMED_PANEL = {
  scene: SigninPanelScene.Active,
  days: PANEL.days.map((day) =>
    day.day_no === 3
      ? { ...day, status: SigninDayStatus.Claimed }
      : day,
  ),
};

const CLAIM = {
  claim_id: "claim-1",
  claim_result: SigninClaimResult.Claimed,
  day_no: 3,
  points: 1000,
  expire_at_ms: 1_792_881_600_000,
  panel: CLAIMED_PANEL,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function makeFetch(
  handler: (request: RecordedRequest, call: number) => Response | Promise<Response>,
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([key, value]) => [key.toLowerCase(), String(value)],
      ),
    );
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    const call = requests.length;
    requests.push(request);
    return handler(request, call);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const AUTH = { accessToken: "lease-token", realUserID: "user-42" };

function makeClient(
  fetchImpl: typeof fetch,
  tokenProvider: () => Promise<typeof AUTH | undefined> = async () => AUTH,
  nowMs = () => 1_790_070_000_000,
) {
  return new DailyCheckinClient({
    tokenProvider,
    region: "cn",
    buildEnv: "prod",
    appVersion: "0.4.2-webui",
    fetchImpl,
    nowMs,
  });
}

describe("DailyCheckinClient wire contract", () => {
  it("requests the status endpoint with the public-gateway signing", async () => {
    const { requests, fetchImpl } = makeFetch(() =>
      jsonResponse({ base_resp: { status_code: 0 }, data: PANEL }),
    );
    const client = makeClient(fetchImpl);
    const panel = await client.getSigninPanel();
    expect(panel.days).toHaveLength(7);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe("GET");
    expect(request.url).toContain("https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status?");
    expect(request.url).toContain("user_id=user-42");
    expect(request.url).toContain("unix=1790070000000");
    expect(request.url).toContain("browser_name=mcode");
    expect(request.headers.authorization).toBe("Bearer lease-token");
    expect(request.headers["user-agent"]).toBe("MiniMaxCode");
    // attribution headers: `yy` / `x-signature` are md5 hex, `x-timestamp` seconds
    expect(request.headers.yy).toMatch(/^[0-9a-f]{32}$/u);
    expect(request.headers["x-signature"]).toMatch(/^[0-9a-f]{32}$/u);
    expect(request.headers["x-timestamp"]).toBe("1790070000");
  });

  it("claims through the claim endpoint with the status account guard", async () => {
    const { requests, fetchImpl } = makeFetch((request) =>
      request.url.includes("/signin/status")
        ? jsonResponse({ base_resp: { status_code: 0 }, data: PANEL })
        : jsonResponse({ base_resp: { status_code: 0 }, data: CLAIM }),
    );
    const client = makeClient(fetchImpl);
    await client.getSigninPanel();
    const claim = await client.claimSignin();
    expect(claim.claim_result).toBe(SigninClaimResult.Claimed);
    expect(claim.panel.days[2].status).toBe(SigninDayStatus.Claimed);
    const post = requests[1];
    expect(post.method).toBe("POST");
    expect(post.url).toContain("https://agent.minimaxi.com/minimax-cloud/api/v1/signin/claim?");
    expect(post.body).toBe("{}");
  });

  it("rejects a claim when the account changed since the status call", async () => {
    let current = { ...AUTH };
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ base_resp: { status_code: 0 }, data: PANEL }),
    );
    const client = makeClient(fetchImpl, async () => current);
    await client.getSigninPanel();
    current = { accessToken: "other", realUserID: "user-99" };
    await expect(client.claimSignin()).rejects.toThrow(
      "MiniMax account changed during daily check-in.",
    );
  });

  it("re-leases once on 401 and fails as auth on a second 401", async () => {
    const first = makeClient(
      makeFetch(() => jsonResponse({ message: "cookie is missing" }, 401)).fetchImpl,
    );
    await expect(first.getSigninPanel()).rejects.toBeInstanceOf(CheckInAuthError);

    let leases = 0;
    const second = makeClient(
      makeFetch((_request, call) =>
        call === 0 ? jsonResponse({}, 401) : jsonResponse({ base_resp: { status_code: 0 }, data: PANEL }),
      ).fetchImpl,
      async () => {
        leases += 1;
        return { accessToken: `lease-${leases}`, realUserID: "user-42" };
      },
    );
    const panel = await second.getSigninPanel();
    expect(panel.days).toHaveLength(7);
    // initial lease + 401 re-lease + the post-response account check
    expect(leases).toBe(3);
  });

  it("treats a missing lease as signed out without touching the network", async () => {
    const { requests, fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = makeClient(fetchImpl, async () => undefined);
    await expect(client.getSigninPanel()).rejects.toBeInstanceOf(CheckInAuthError);
    expect(requests).toHaveLength(0);
  });

  it("surfaces base_resp failures and missing data", async () => {
    const failed = makeClient(
      makeFetch(() =>
        jsonResponse({ base_resp: { status_code: 1004, status_msg: "系统繁忙" } }),
      ).fetchImpl,
    );
    await expect(failed.getSigninPanel()).rejects.toThrow("系统繁忙");

    const empty = makeClient(
      makeFetch(() => jsonResponse({ base_resp: { status_code: 0 }, data: null })).fetchImpl,
    );
    await expect(empty.getSigninPanel()).rejects.toThrow("response data is missing");
  });

  it("rejects malformed panel/claim payloads through the shared validators", async () => {
    const badStatus = makeClient(
      makeFetch(() =>
        jsonResponse({ base_resp: { status_code: 0 }, data: { scene: 0, days: [{ day_no: 1 }] } }),
      ).fetchImpl,
    );
    await expect(badStatus.getSigninPanel()).rejects.toThrow("Invalid sign-in panel");

    const badClaim = makeClient(
      makeFetch(() =>
        jsonResponse({ base_resp: { status_code: 0 }, data: { ...CLAIM, claim_id: "" } }),
      ).fetchImpl,
    );
    await expect(badClaim.claimSignin()).rejects.toThrow("Invalid sign-in claim response");
  });
});

describe("check-in operations", () => {
  it("accepts an empty object body and rejects anything else", () => {
    for (const operation of [getSigninPanelOperation, claimSigninOperation]) {
      expect(operation.name).toMatch(/SigninPanel|claimSignin/u);
      expect(operation.validate({})).toEqual({ ok: true, body: {} });
      expect(operation.validate({ extra: 1 }).ok).toBe(false);
      expect(operation.validate(undefined).ok).toBe(false);
    }
  });
});

function renderCard(props: Partial<Parameters<typeof SigninCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SigninCard, {
      loading: false,
      claiming: false,
      animatedDay: null,
      onClaim: () => undefined,
      onRetry: () => undefined,
      onNavigateToUsage: () => undefined,
      ...props,
    }),
  );
}

describe("SigninCard desktop parity", () => {
  it("renders the skeleton while loading without a panel", () => {
    const html = renderCard({ loading: true });
    expect(html).toContain('data-testid="signin-card-skeleton"');
    expect(html).toContain("signin-progress");
  });

  it("renders the error card with desktop copy and retry", () => {
    const html = renderCard({ error: "签到暂时不可用，请稍后重试" });
    expect(html).toContain('data-testid="signin-card-error"');
    expect(html).toContain("签到暂时不可用，请稍后重试");
    expect(html).toContain("重试");
  });

  it("renders a claimable panel: streak, seven days, claim button and bonus", () => {
    const html = renderCard({ panel: PANEL });
    expect(html).toContain('data-testid="signin-card"');
    expect(html).toContain("每日签到");
    expect(html).toContain('data-testid="signin-streak"');
    expect(html).toContain("本轮已连续签到");
    expect(html).toContain(">2</span> 天");
    // seven day cells with desktop's zh aria labels
    expect(html).toContain('data-testid="signin-day-3"');
    expect(html).toContain('data-status="2"');
    expect(html).toContain("第 3 天，今日可签到，1,000 积分");
    expect(html).toContain('aria-current="date"');
    expect(html).toContain('data-testid="signin-day-reward-7"');
    // claimable = black mavis button with 签到得 <points> and the credits glyph
    expect(html).toContain("signin-claim-button");
    expect(html).toContain('aria-label="签到得 1,000"');
    expect(html).toContain("签到得");
    // bonus badge from today's bonus_points
    expect(html).toContain('data-testid="signin-bonus"');
    expect(html).toContain("额外");
    // credits info tooltip trigger
    expect(html).toContain('aria-label="关于签到积分"');
    // connectors + rings
    expect(html).toContain("signin-connector");
    expect(html).toContain("stroke-border_accent");
    expect(html).toContain("stroke-border_default");
  });

  it("renders the claimed-today state as the disabled desktop button", () => {
    const html = renderCard({ panel: CLAIMED_PANEL });
    expect(html).toContain("今日已签到");
    expect(html).toContain("bg-bg_interaction_primary_inactive");
    expect(html).not.toContain("signin-claim-button");
    expect(html).toContain(">3</span> 天");
  });

  it("marks the claim-loading state with 签到中…", () => {
    const html = renderCard({ panel: PANEL, claiming: true });
    expect(html).toContain("签到中…");
    expect(html).toContain("webui-signin-claim-spinner");
  });

  it("renders the unavailable state when nothing is claimable", () => {
    const noClaim = {
      scene: SigninPanelScene.Completed,
      days: PANEL.days.map((day) =>
        day.status === SigninDayStatus.Claimable
          ? { ...day, status: SigninDayStatus.Disabled }
          : day,
      ),
    };
    const html = renderCard({ panel: noClaim });
    expect(html).toContain("暂不可签到");
    expect(html).toContain('aria-label="暂不可签到"');
  });
});
