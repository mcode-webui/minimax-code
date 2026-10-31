/**
 * The pairing pipeline's credential.
 *
 * The claim under test is the bearer the archon_biz pairing requests are signed with: the
 * service's **OAuth lease**, the same one the quota and the daily check-in sign with.
 *
 * The regression this pins is specific. The pairing client used to read the *legacy cli-auth
 * projection* on disk, which is the older store and is empty on an installation that only ever
 * logged in through OAuth. The pairing request was then unsigned and the panel answered
 * "no user JWT available" — the same dead end Desktop's own main process is in under Shared
 * OAuth, where it deliberately fails closed on the legacy SSO token projection.
 *
 * Three things are asserted:
 *
 *   * the lease signs the request, in the `token` header the server actually reads and in the
 *     `Authorization` header it reads one day;
 *   * the account id travels in the `user_id` common-param, because the server cross-checks it
 *     against the token's own subject;
 *   * a host without a credential fails **before** the request goes out — no unsigned request,
 *     and no pairing code that was never issued.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebuiRemoteControl } from "../../src/runtime/remote-control/owner.js";
import { RemoteControlCredentialSource } from "../../src/runtime/remote-control/pairing.js";

const dataDirs: string[] = [];

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "webui-rc-credential-"));
  dataDirs.push(dir);
  return dir;
}

/** A CLI service with an idle event stream. */
function cliServiceStub() {
  return {
    watchEvents: async function* watchEvents() {
      await new Promise<void>(() => {});
    },
  };
}

/** One captured HTTP request. */
interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Writes the legacy cli-auth projection — the older store, with its own scope file.
 */
function writeLegacyProjection(
  dir: string,
  credential: { readonly accessToken: string; readonly realUserID: string },
): void {
  const scope = { version: 1, region: "cn", buildEnv: "prod" };
  const scopeDir = path.join(dir, "cli-auth", "prod", "cn");
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    path.join(scopeDir, "cli-auth.scope.json"),
    JSON.stringify(scope),
    "utf8",
  );
  writeFileSync(
    path.join(scopeDir, "local-runtime.auth.json"),
    JSON.stringify({ version: 1, auth: credential }),
    "utf8",
  );
}

describe("the remote-control pairing credential", () => {
  it("signs the pairing request with the service's OAuth lease", async () => {
    const dir = dataDir();
    const requests: CapturedRequest[] = [];
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: cliServiceStub() as never,
        dataDir: dir,
        getAuthCredential: async () => ({
          accessToken: "lease-token",
          realUserID: "4242",
        }),
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ pairing_code: "1234", expires_in_s: 300 });
      }) as unknown as typeof fetch,
    });

    const result = await controller.connect({ requestCode: true });

    expect(result.phase).toBe("pairing");
    expect(result.pairingCode).toBe("1234");

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/minimax-cloud/api/v1/remote-control/pairing/code");
    // The server reads `token`; `Authorization` rides along for the day it adopts it.
    expect(request.headers.token).toBe("lease-token");
    expect(request.headers.Authorization).toBe("Bearer lease-token");
    // The account id is a cross-check, not a decoration.
    expect(request.url).toContain("user_id=4242");
  });

  it("takes the bearer from the lease, not from the legacy projection", async () => {
    const dir = dataDir();
    writeLegacyProjection(dir, { accessToken: "projection-token", realUserID: "99" });
    const requests: CapturedRequest[] = [];
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: cliServiceStub() as never,
        dataDir: dir,
        getAuthCredential: async () => ({
          accessToken: "lease-token",
          realUserID: "4242",
        }),
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ pairing_code: "1234", expires_in_s: 300 });
      }) as unknown as typeof fetch,
    });

    await controller.connect({ requestCode: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.token).toBe("lease-token");
    expect(requests[0]!.url).toContain("user_id=4242");
    expect(requests[0]!.url).not.toContain("user_id=99");
  });

  it("keeps the bearer when a renewal fails", async () => {
    // A renewal that fails is not a sign-out. The bearer is a lease: clearing
    // the good token would turn a transient failure into "no user JWT
    // available", and the bridge's pairing poll treats that answer as fatal —
    // it tears the pairing session down, stranding a phone that was about to
    // bind.
    let reads = 0;
    const failures: string[] = [];
    const source = new RemoteControlCredentialSource(
      async () => {
        reads += 1;
        return reads === 1 ? { accessToken: "lease-token", realUserID: "4242" } : undefined;
      },
      (message) => failures.push(message),
    );

    await source.refresh();
    expect(source.token).toBe("lease-token");
    expect(source.userId).toBe("4242");

    await source.refresh();
    expect(source.token).toBe("lease-token");
    expect(source.userId).toBe("4242");
    expect(failures).toHaveLength(1);
  });

  it("fails before the request goes out when nobody is signed in", async () => {
    const dir = dataDir();
    const requests: CapturedRequest[] = [];
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: cliServiceStub() as never,
        dataDir: dir,
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ pairing_code: "1234", expires_in_s: 300 });
      }) as unknown as typeof fetch,
    });

    const result = await controller.connect({ requestCode: true });

    // No pairing code was issued, and no unsigned request was made.
    expect(result.phase).toBe("error");
    expect(result.pairingCode).toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
