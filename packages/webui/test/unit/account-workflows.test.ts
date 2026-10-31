// Unit tests for the account workflow owner.
//
// The owner is framework-free, so these run the real decision logic the user
// menu, the login dialog and the settings dialog delegate to: that the login
// poll has exactly one owner and stops when the flow is cancelled, abandoned
// or authenticated, and that a superseded account answer is dropped rather
// than applied over a newer one.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebuiAccountWorkflows } from "../../src/client/features/account/application/account-workflows.js";
import type { WebuiAccountLoginView } from "../../src/shared/contracts/account.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const pending: WebuiAccountLoginView = { state: "pending" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the login poll has one owner", () => {
  it("stops polling when the flow is cancelled", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async (): Promise<WebuiAccountLoginView> => pending);
    const cancel = vi.fn(async () => ({ ok: true as const }));
    const workflows = createWebuiAccountWorkflows({
      port: {
        beginAccountLogin: async () => pending,
        getAccountLoginStatus: status,
        cancelAccountLogin: cancel,
      },
    });

    await workflows.beginLogin();
    expect(workflows.getSnapshot().login.polling).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(status).toHaveBeenCalledTimes(1);

    await workflows.cancelLogin();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workflows.getSnapshot().login.polling).toBe(false);

    // An abandoned login must not keep asking.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(status).toHaveBeenCalledTimes(1);
    expect(workflows.getSnapshot().login.view).toEqual({ state: "idle" });
  });

  it("stops polling when the dialog closes without cancelling", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async (): Promise<WebuiAccountLoginView> => pending);
    const cancel = vi.fn(async () => ({ ok: true as const }));
    const workflows = createWebuiAccountWorkflows({
      port: {
        beginAccountLogin: async () => pending,
        getAccountLoginStatus: status,
        cancelAccountLogin: cancel,
      },
    });

    await workflows.beginLogin();
    workflows.stopLoginPolling();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(status).not.toHaveBeenCalled();
    // Closing the dialog is not a cancel: the server-side attempt lives on.
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops polling once the flow authenticates", async () => {
    vi.useFakeTimers();
    const status = vi.fn(
      async (): Promise<WebuiAccountLoginView> => ({ state: "authenticated" }),
    );
    const workflows = createWebuiAccountWorkflows({
      port: {
        beginAccountLogin: async () => pending,
        getAccountLoginStatus: status,
      },
    });

    await workflows.beginLogin();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(status).toHaveBeenCalledTimes(1);
    expect(workflows.getSnapshot().login.authenticatedAt).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("never walks a live phase back to idle on a slow first reply", async () => {
    vi.useFakeTimers();
    const workflows = createWebuiAccountWorkflows({
      port: {
        beginAccountLogin: async () => pending,
        getAccountLoginStatus: async () => ({ state: "idle" }),
      },
    });

    await workflows.beginLogin();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(workflows.getSnapshot().login.view).toEqual(pending);
  });

  it("reports a missing login capability instead of polling", async () => {
    const workflows = createWebuiAccountWorkflows({ port: {} });
    await workflows.beginLogin();
    expect(workflows.getSnapshot().login.view).toEqual({
      state: "error",
      error: "当前服务未提供账号登录",
    });
    expect(workflows.getSnapshot().login.polling).toBe(false);
  });

  it("signs out before starting a fresh flow when switching accounts", async () => {
    const calls: string[] = [];
    const workflows = createWebuiAccountWorkflows({
      port: {
        signOut: async () => {
          calls.push("signOut");
          return { success: true };
        },
        beginAccountLogin: async () => {
          calls.push("begin");
          return pending;
        },
      },
    });

    await workflows.switchAccount();
    expect(calls).toEqual(["signOut", "begin"]);
    expect(workflows.getSnapshot().login.view).toEqual(pending);
  });
});

describe("the account answer has one owner", () => {
  it("drops a superseded account read", async () => {
    let resolveFirst: (value: Record<string, unknown>) => void = () => undefined;
    let call = 0;
    const workflows = createWebuiAccountWorkflows({
      port: {
        getAccountStatus: () => {
          call += 1;
          if (call === 1) {
            return new Promise<Record<string, unknown>>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve({ nickname: "second" });
        },
      },
    });

    void workflows.loadAccount();
    await workflows.loadAccount();
    resolveFirst({ nickname: "first" });
    await flush();

    expect(workflows.getSnapshot().account.value).toEqual({ nickname: "second" });
    expect(workflows.getSnapshot().account.status).toBe("ready");
  });

  it("records one error for a failed account read", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: { getAccountStatus: async () => Promise.reject(new Error("nope")) },
    });
    await workflows.loadAccount();
    expect(workflows.getSnapshot().account).toEqual({ status: "error", error: "nope" });
  });

  it("re-reads the account and quota after a successful sign-out", async () => {
    const reads: string[] = [];
    const workflows = createWebuiAccountWorkflows({
      port: {
        signOut: async () => ({ success: true }),
        getAccountStatus: async () => {
          reads.push("account");
          return { nickname: "after" };
        },
        getUsageQuota: async () => {
          reads.push("usage");
          return { signedIn: false };
        },
      },
    });

    await workflows.signOutAccount();
    expect(reads).toEqual(["account", "usage"]);
    expect(workflows.getSnapshot().signOut).toEqual({ signingOut: false });
    expect(workflows.getSnapshot().account.value).toEqual({ nickname: "after" });
    expect(workflows.getSnapshot().usage.result).toEqual({ signedIn: false });
  });

  it("records a sign-out failure instead of throwing it at the surface", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: { signOut: async () => Promise.reject(new Error("revoked")) },
    });
    await workflows.signOutAccount();
    expect(workflows.getSnapshot().signOut.error).toBe("revoked");
    expect(workflows.getSnapshot().account.status).toBe("idle");
  });
});

describe("the owner's disposal", () => {
  it("stops every timer it runs", async () => {
    vi.useFakeTimers();
    const loginStatus = vi.fn(async (): Promise<WebuiAccountLoginView> => pending);
    const codexStatus = vi.fn(async () => ({ state: "pending" }));
    const workflows = createWebuiAccountWorkflows({
      port: {
        beginAccountLogin: async () => pending,
        getAccountLoginStatus: loginStatus,
        getCodexOAuthStatus: codexStatus,
      },
    });

    await workflows.beginLogin();
    const release = workflows.acquireCodexOAuthPolling();
    await vi.advanceTimersByTimeAsync(2_000);
    const loginCalls = loginStatus.mock.calls.length;
    const codexCalls = codexStatus.mock.calls.length;
    expect(loginCalls).toBeGreaterThan(0);
    expect(codexCalls).toBeGreaterThan(0);

    workflows.dispose();
    // The release the surface still holds must not restart anything either.
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loginStatus.mock.calls.length).toBe(loginCalls);
    expect(codexStatus.mock.calls.length).toBe(codexCalls);
  });

  it("drops an answer that lands after disposal", async () => {
    let resolveAccount: ((value: Record<string, unknown>) => void) | undefined;
    const workflows = createWebuiAccountWorkflows({
      port: {
        getAccountStatus: () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveAccount = resolve;
          }),
      },
    });

    const read = workflows.loadAccount();
    workflows.dispose();
    resolveAccount?.({ signedIn: true, accountId: "late" });
    await read;

    // A disposed owner commits nothing, so a late answer cannot resurrect state.
    expect(workflows.getSnapshot().account.status).toBe("loading");
  });

  it("refuses a poll interest once disposed", async () => {
    vi.useFakeTimers();
    const codexStatus = vi.fn(async () => ({ state: "pending" }));
    const workflows = createWebuiAccountWorkflows({
      port: { getCodexOAuthStatus: codexStatus },
    });

    workflows.dispose();
    const release = workflows.acquireCodexOAuthPolling();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(codexStatus).not.toHaveBeenCalled();
    release();
  });
});
