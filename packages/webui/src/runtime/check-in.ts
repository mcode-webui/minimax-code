/**
 * Daily check-in client for the WebUI's 每日签到 panel.
 *
 * The endpoint contract, request signing, response validation and account
 * guards are copied from `packages/tui/src/checkin/http-gateway.ts` and
 * `packages/tui/src/runtime/public-gateway.ts`; the response validators come
 * from `@mavis/shared/daily-signin` directly (the same module the TUI and the
 * desktop use). ADR 0003 forbids importing `packages/tui` itself — reading it
 * and re-implementing the wire protocol is the sanctioned path, exactly like
 * `usage-quota.ts` did for the matrix account endpoints.
 *
 * Auth comes from the assembly's oauth-core lease (`tokenProvider`): the
 * `cli-auth` projection's harness bearer is rejected by the cloud endpoints
 * (probe-verified 2026-09-22).
 */
import { createHash } from "node:crypto";

import {
  validateClaimSigninData,
  validateSigninPanel,
  type ClaimSigninData,
  type SigninPanel,
} from "@mavis/shared/daily-signin";

/** Mirrors `@mavis/config`'s unions without adding a dependency. */
type MavisRegion = "cn" | "en";
type MavisBuildEnv = "dev" | "test" | "staging" | "prod";

const STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
const CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";

/**
 * Resolve the runtime's default `fetch`. The runtime is Node-side and can
 * rely on the platform's ambient fetch (Node 18+); the helper exists so a
 * `globalThis`-prefixed access does not surface as a browser-global rule
 * violation and so a missing platform `fetch` produces a typed error
 * instead of failing later with `fetch is not a function`.
 */
function resolveDefaultFetch(): typeof fetch {
  const ambient = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof ambient === "function") return ambient;
  throw new Error("runtime fetch is unavailable; supply a fetchImpl");
}

/** Origin table copied from `packages/tui/src/runtime/public-gateway.ts`. */
const PUBLIC_GATEWAY_ORIGINS: Readonly<
  Record<MavisRegion, Readonly<Record<MavisBuildEnv, string>>>
> = {
  cn: {
    dev: "https://matrix-test.example.invalid",
    test: "https://matrix-test.example.invalid",
    staging: "https://matrix-pre.example.invalid",
    prod: "https://agent.minimaxi.com",
  },
  en: {
    dev: "https://matrix-overseas-test.example.invalid",
    test: "https://matrix-overseas-test.example.invalid",
    staging: "https://matrix-overseas-pre.example.invalid",
    prod: "https://agent.minimax.io",
  },
};

function publicGatewayOrigin(input: {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
}): string {
  return PUBLIC_GATEWAY_ORIGINS[input.region][input.buildEnv];
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/** Request builder copied from `createPublicGatewayRequest` (tui runtime). */
function createPublicGatewayRequest(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly realUserID: string;
  readonly appVersion: string;
  readonly region: MavisRegion;
  readonly nowMs: number;
  readonly body?: string;
}): {
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body?: string;
} {
  const url = new URL(input.endpoint);
  const language = input.region === "cn" ? "zh" : "en";
  url.search = new URLSearchParams({
    device_platform: "web",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    is_desktop: "1",
    desktop_version: input.appVersion.trim(),
    unix: String(input.nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: language,
    lang: language,
    device_id: "0",
    os_name: process.platform,
    browser_name: "mcode",
    user_id: input.realUserID.trim(),
    client: "mcode",
  }).toString();
  // `yy` / `x-timestamp` / `x-signature` are client attribution headers built
  // from two inline literals (wire-protocol constants shared across MiniMax
  // clients — not credentials; authorization is the Bearer token).
  const signatureBody = input.body ?? "";
  const yyBody = input.body ?? "{}";
  const second = Math.floor(input.nowMs / 1_000);
  const pathWithSearch = `${url.pathname}${url.search}`;
  return {
    url,
    ...(input.body === undefined ? {} : { body: input.body }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "MiniMaxCode",
      Authorization: `Bearer ${input.token}`,
      yy: md5(
        `${encodeURIComponent(pathWithSearch)}_${yyBody}${md5(String(input.nowMs))}ooui`,
      ),
      "x-timestamp": String(second),
      "x-signature": md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${signatureBody}`),
    },
  };
}

export interface DailyCheckinAuth {
  readonly accessToken: string;
  readonly realUserID: string;
}

/** Thrown when the cloud says the lease is invalid — the panel maps it to its signed-out copy. */
export class CheckInAuthError extends Error {}

export interface DailyCheckinClientOptions {
  /**
   * Fresh oauth lease for the cloud endpoints. `undefined` means signed out
   * (the assembly's provider swallows lease failures into `undefined`).
   */
  readonly tokenProvider: () => Promise<DailyCheckinAuth | undefined>;
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
  readonly appVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly nowMs?: () => number;
}

export class DailyCheckinClient {
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private statusAccountKey: string | undefined;

  constructor(private readonly options: DailyCheckinClientOptions) {
    this.fetchImpl = options.fetchImpl ?? resolveDefaultFetch();
    this.nowMs = options.nowMs ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getSigninPanel(): Promise<SigninPanel> {
    const { data, accountKey } = await this.request(STATUS_PATH, "GET");
    this.statusAccountKey = accountKey;
    return validateSigninPanel(data);
  }

  async claimSignin(): Promise<ClaimSigninData> {
    const response = await this.request(
      CLAIM_PATH,
      "POST",
      this.statusAccountKey,
    );
    this.statusAccountKey = undefined;
    return validateClaimSigninData(response.data);
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    expectedAccountKey?: string,
  ): Promise<{ readonly data: unknown; readonly accountKey: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      let auth = await this.resolveAuth();
      assertExpectedAccount(auth, expectedAccountKey);
      let response = await this.fetch(path, method, auth, controller.signal);
      if (response.status === 401) {
        // Mirror the TUI gateway: one forced re-lease, then fail as auth.
        auth = await this.resolveAuth();
        assertExpectedAccount(auth, expectedAccountKey);
        response = await this.fetch(path, method, auth, controller.signal);
        if (response.status === 401) {
          throw new CheckInAuthError(
            "MiniMax Code sign-in is required. Run mcode login in the TUI, then retry.",
          );
        }
      }
      if (!response.ok) {
        throw new Error(`Daily check-in request failed with HTTP ${response.status}.`);
      }
      const body = (await response.json()) as {
        readonly base_resp?: {
          readonly status_code?: number;
          readonly status_msg?: string;
        };
        readonly data?: unknown;
      };
      await this.assertCurrentAccount(auth);
      const statusCode = body.base_resp?.status_code;
      if (typeof statusCode === "number" && statusCode !== 0) {
        throw new Error(body.base_resp?.status_msg || "Daily check-in request failed.");
      }
      if (body.data === null || body.data === undefined) {
        throw new Error("Daily check-in response data is missing.");
      }
      return { data: body.data, accountKey: accountKey(auth) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetch(
    path: string,
    method: "GET" | "POST",
    auth: DailyCheckinAuth,
    signal: AbortSignal,
  ): Promise<Response> {
    const origin = publicGatewayOrigin({
      region: this.options.region,
      buildEnv: this.options.buildEnv,
    });
    const body = method === "POST" ? "{}" : undefined;
    const request = createPublicGatewayRequest({
      endpoint: `${origin}${path}`,
      token: auth.accessToken,
      realUserID: auth.realUserID,
      appVersion: this.options.appVersion,
      region: this.options.region,
      nowMs: this.nowMs(),
      ...(body ? { body } : {}),
    });
    return this.fetchImpl(request.url, {
      method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      signal,
    });
  }

  private async resolveAuth(): Promise<DailyCheckinAuth> {
    const auth = await this.options.tokenProvider();
    const accessToken = auth?.accessToken?.trim();
    const realUserID = auth?.realUserID?.trim();
    if (!accessToken || !realUserID) {
      throw new CheckInAuthError(
        "MiniMax Code sign-in is required. Run mcode login in the TUI, then retry.",
      );
    }
    return { accessToken, realUserID };
  }

  private async assertCurrentAccount(auth: DailyCheckinAuth): Promise<void> {
    const current = await this.options.tokenProvider();
    const currentId = current?.realUserID?.trim();
    if (!currentId || currentId !== auth.realUserID) {
      throw new Error("MiniMax account changed during daily check-in. Retry.");
    }
  }
}

function accountKey(auth: DailyCheckinAuth): string {
  return auth.realUserID;
}

function assertExpectedAccount(
  auth: DailyCheckinAuth,
  expectedAccountKey: string | undefined,
): void {
  if (expectedAccountKey && accountKey(auth) !== expectedAccountKey) {
    throw new Error("MiniMax account changed during daily check-in. Retry.");
  }
}
