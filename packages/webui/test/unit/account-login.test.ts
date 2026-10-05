// Unit tests for the server-owned account login session and the dialog's
// phase derivation.
//
// Roadmap N (登录与账号): the WebUI had no login at all, and its sign-out
// only cleared projections — the credential survived and the next lease
// refresh signed straight back in. `account-login.ts` is the server half of
// the fix: one session over the shared `MCodeOAuthCore`, answering the
// browser's begin/status/cancel calls. The fake core below stands in for it,
// so these tests pin the session's observable contract:
//
//   * `begin` resolves with the prompt as soon as the core emits it, without
//     waiting for the human to authorize;
//   * a second `begin` while one attempt runs re-attaches (the core dedupes
//     `login()` on its own promise; the session must not start a second);
//   * `status` reports the settled outcome first, the in-flight prompt
//     second, and — with no attempt this process started — the persisted
//     store (a terminal-client login counts);
//   * `cancel` aborts and, when the core then rejects with the cancellation,
//     the session does not report it as a failure.

import { describe, expect, it, vi } from "vitest";

import { createWebuiAccountLoginSession } from "../../src/server/account-login.js";
import { deriveWebuiAccountLoginPhase } from "../../src/client/components/AccountLoginDialog.js";

/** A controllable core: the test decides when the prompt lands and when the
 *  attempt settles, including the cancellation rejection. */
function fakeCore() {
  let loginCalls = 0;
  let authorize: ((authorization: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresInSec: number;
  }) => void) | undefined;
  const settleLogin = () => {};
  const deferred: {
    resolve: (value: { status: "authenticated"; generation: number }) => void;
    reject: (error: Error) => void;
  } = { resolve: () => {}, reject: () => {} };
  const loginPromise = new Promise<{ status: "authenticated"; generation: number }>(
    (resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    },
  );
  const core = {
    login: vi.fn(
      (
        options: {
          onDeviceAuthorization?: (authorization: {
            userCode: string;
            verificationUri: string;
            verificationUriComplete?: string;
            expiresInSec: number;
          }) => void;
        } = {},
      ) => {
        loginCalls += 1;
        authorize = options.onDeviceAuthorization;
        return loginPromise;
      },
    ),
    cancelLogin: vi.fn(async () => {
      deferred.reject(new Error("MCode OAuth device authorization was cancelled."));
    }),
    getStatus: vi.fn(async () => ({ status: "anonymous", generation: 0, scopes: [] })),
    emitPrompt() {
      authorize?.({
        userCode: "ABCD-1234",
        verificationUri: "https://auth.example.invalid/device",
        verificationUriComplete: "https://auth.example.invalid/device?code=ABCD-1234",
        expiresInSec: 600,
      });
    },
    complete() {
      deferred.resolve({ status: "authenticated", generation: 7 });
    },
    loginCalls: () => loginCalls,
  };
  return core;
}

describe("the account login session", () => {
  it("begins with the prompt as soon as the core emits it", async () => {
    const core = fakeCore();
    const session = createWebuiAccountLoginSession(core, () => 1_000);
    const beginning = session.begin();
    core.emitPrompt();
    await expect(beginning).resolves.toEqual({
      state: "pending",
      prompt: {
        userCode: "ABCD-1234",
        verificationUri: "https://auth.example.invalid/device",
        verificationUriComplete: "https://auth.example.invalid/device?code=ABCD-1234",
        // now()=1000 + 600s
        expiresAtMs: 601_000,
      },
    });
  });

  it("re-attaches to a running attempt instead of starting a second", async () => {
    const core = fakeCore();
    const session = createWebuiAccountLoginSession(core, () => 0);
    const beginning = session.begin();
    core.emitPrompt();
    await beginning;
    await expect(session.begin()).resolves.toMatchObject({
      state: "pending",
      prompt: { userCode: "ABCD-1234" },
    });
    expect(core.loginCalls()).toBe(1);
  });

  it("reports the settled outcome, then the persisted store after cancellation", async () => {
    const core = fakeCore();
    const session = createWebuiAccountLoginSession(core, () => 0);
    const beginning = session.begin();
    core.emitPrompt();
    await beginning;

    core.complete();
    // Let the session's then/catch run.
    await vi.waitFor(() =>
      expect(session.status()).resolves.toEqual({ state: "authenticated" }),
    );
  });

  it("treats a cancelled attempt as the user's own action, not a failure", async () => {
    const core = fakeCore();
    const session = createWebuiAccountLoginSession(core, () => 0);
    const beginning = session.begin();
    core.emitPrompt();
    await beginning;

    await session.cancel();
    // The core's login promise now rejects with the cancellation; the
    // session must not surface it as an error.
    await loginPromiseSettles();
    await expect(session.status()).resolves.toEqual({ state: "idle" });
  });

  it("reads the persisted store when this process started nothing", async () => {
    const core = fakeCore();
    core.getStatus.mockResolvedValue({ status: "authenticated", generation: 3, scopes: [] });
    const session = createWebuiAccountLoginSession(core, () => 0);
    await expect(session.status()).resolves.toEqual({ state: "authenticated" });
  });
});

/** Waits until the fake core's login promise has settled (microtask drain). */
async function loginPromiseSettles(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deriveWebuiAccountLoginPhase", () => {
  it("maps every server answer to the view the panel shows", () => {
    expect(deriveWebuiAccountLoginPhase(undefined)).toEqual({ kind: "loading" });
    expect(deriveWebuiAccountLoginPhase({ state: "idle" })).toEqual({ kind: "loading" });
    expect(deriveWebuiAccountLoginPhase({ state: "authenticated" })).toEqual({
      kind: "authenticated",
    });
    expect(deriveWebuiAccountLoginPhase({ state: "error", error: "expired" })).toEqual({
      kind: "error",
      error: "expired",
    });
    expect(
      deriveWebuiAccountLoginPhase({
        state: "pending",
        prompt: {
          userCode: "X",
          verificationUri: "https://x.invalid",
          expiresAtMs: 1,
        },
      }),
    ).toEqual({
      kind: "pending",
      userCode: "X",
      verificationUri: "https://x.invalid",
      verificationUriComplete: undefined,
    });
  });

  it("keeps a prompt-less pending answer honest: waiting, not guessing", () => {
    expect(deriveWebuiAccountLoginPhase({ state: "pending" })).toEqual({
      kind: "pending",
      userCode: undefined,
      verificationUri: undefined,
      verificationUriComplete: undefined,
    });
  });
});
