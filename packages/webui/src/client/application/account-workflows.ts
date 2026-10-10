// The account workflow owner (plan §7.1 `application/account-workflows.ts`;
// §7.6 "Goal"/"Settings" rows; §7.7 stage 5; ticket #52).
//
// One owner for everything the account surfaces read and write: the account
// record, the usage quota, the daily check-in panel and claim, the device
// login flow — including its **poll** — and sign-out. The two problems this
// closes, both named in the ticket:
//
//  1. **Polling with no owner.** The login dialog opened its own interval and
//     cleared it from its own effect cleanup, so "who stops the poll" was an
//     accident of unmount ordering. Here one owner starts the poll when a
//     flow begins and stops it on cancel, on authentication and on dialog
//     close; an abandoned flow cannot leave a timer running.
//
//  2. **An answer produced per component.** The settings dialog and the user
//     menu each fetched the account record and the quota independently, and
//     each decided its own error string. One cache answers both, with a
//     request version per query so a superseded answer is dropped rather than
//     applied over a newer one, and one error field per query.
//
// This module is framework-free — no React, no DOM — so it can be unit-tested
// against a scripted port. The components read its snapshot and submit
// commands; they hold no store writer and call no transport method directly.

import type { AccountPort } from "../contracts/account-port.js";
import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "../../shared/contracts/account.js";
import type { WebuiUsageQuotaResult } from "../../shared/contracts/usage-quota.js";

/** The transport methods this owner drives. Absent means "not wired". */
export type WebuiAccountPortSlice = Pick<
  AccountPort,
  | "getAccountStatus"
  | "getUsageQuota"
  | "getSigninPanel"
  | "claimSignin"
  | "beginAccountLogin"
  | "getAccountLoginStatus"
  | "cancelAccountLogin"
  | "signOut"
>;

/** The poll interval the login dialog used, preserved. */
export const WEBUI_ACCOUNT_LOGIN_POLL_MS = 2_000;

export interface WebuiAccountRecordState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly value?: Record<string, unknown>;
  readonly error?: string;
}

export interface WebuiUsageQuotaState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly result?: WebuiUsageQuotaResult;
  readonly error?: string;
}

export interface WebuiSigninState {
  readonly loading: boolean;
  readonly claiming: boolean;
  readonly panel?: WebuiSigninPanelView;
  readonly error?: string;
  /** The last successful claim, carried so the menu can animate the day. */
  readonly claim?: WebuiClaimSigninView;
}

export interface WebuiAccountLoginState {
  /** The latest server answer; `undefined` until the first attempt answers. */
  readonly view?: WebuiAccountLoginView;
  /** True while the owner is polling the login status. */
  readonly polling: boolean;
  /**
   * Bumped once per transition into `authenticated`. A consumer that refreshes
   * on login keys on it, so it fires exactly once per transition rather than
   * on every poll.
   */
  readonly authenticatedAt?: number;
}

export interface WebuiAccountSignOutState {
  readonly signingOut: boolean;
  readonly error?: string;
}

export interface WebuiAccountWorkflowsState {
  readonly account: WebuiAccountRecordState;
  readonly usage: WebuiUsageQuotaState;
  readonly signin: WebuiSigninState;
  readonly login: WebuiAccountLoginState;
  readonly signOut: WebuiAccountSignOutState;
}

export const initialWebuiAccountRecordState: WebuiAccountRecordState = {
  status: "idle",
};

export const initialWebuiUsageQuotaState: WebuiUsageQuotaState = {
  status: "idle",
};

export const initialWebuiSigninState: WebuiSigninState = {
  loading: false,
  claiming: false,
};

export const initialWebuiAccountLoginState: WebuiAccountLoginState = {
  polling: false,
};

export const initialWebuiAccountSignOutState: WebuiAccountSignOutState = {
  signingOut: false,
};

export const initialWebuiAccountWorkflowsState: WebuiAccountWorkflowsState = {
  account: initialWebuiAccountRecordState,
  usage: initialWebuiUsageQuotaState,
  signin: initialWebuiSigninState,
  login: initialWebuiAccountLoginState,
  signOut: initialWebuiAccountSignOutState,
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface WebuiAccountWorkflows {
  readonly getSnapshot: () => WebuiAccountWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;

  readonly canReadAccount: boolean;
  readonly canReadUsage: boolean;
  readonly canLogin: boolean;
  readonly canReadSignin: boolean;
  readonly canClaimSignin: boolean;
  readonly canSignOut: boolean;

  /** Read the account record. A superseded answer is dropped. */
  readonly loadAccount: (sessionId?: string) => Promise<void>;
  /** Read the usage quota. `forceRefresh` asks the runtime to bypass its cache. */
  readonly loadUsage: (forceRefresh?: boolean) => Promise<void>;

  /** Read the daily check-in panel. */
  readonly loadSigninPanel: () => Promise<void>;
  /** Claim today's check-in; records the result for the menu's animation. */
  readonly claimSignin: () => Promise<void>;

  /** Begin a device-authorization flow and start polling its status. */
  readonly beginLogin: () => Promise<void>;
  /** Cancel the in-flight attempt, stop polling and reset the view to idle. */
  readonly cancelLogin: () => Promise<void>;
  /** Stop polling without cancelling the attempt (the dialog closed). */
  readonly stopLoginPolling: () => void;
  /** Sign out for real, then start a fresh device flow in the same surface. */
  readonly switchAccount: () => Promise<void>;

  /** Sign out, then refresh the account and usage answers. */
  readonly signOutAccount: () => Promise<void>;
  /** Clear the recorded sign-out error once the surface is dismissed. */
  readonly clearSignOutError: () => void;
}

export function createWebuiAccountWorkflows(deps: {
  readonly port: WebuiAccountPortSlice;
}): WebuiAccountWorkflows {
  const { port } = deps;
  let state = initialWebuiAccountWorkflowsState;
  const listeners = new Set<() => void>();
  const versions = new Map<string, number>();
  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    (versions.get(key) ?? 0) === version;

  const set = (
    update: (current: WebuiAccountWorkflowsState) => WebuiAccountWorkflowsState,
  ): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  let loginTimer: ReturnType<typeof setInterval> | undefined;

  const stopLoginPolling = (): void => {
    if (loginTimer === undefined) return;
    clearInterval(loginTimer);
    loginTimer = undefined;
    set((current) =>
      current.login.polling ? { ...current, login: { ...current.login, polling: false } } : current,
    );
  };

  const applyLoginView = (view: WebuiAccountLoginView): void => {
    set((current) => {
      // A poll that answers `idle` while the flow is already live (the network
      // slower than the first reply) must not walk a live phase back to idle;
      // only a forward transition is applied.
      const nextView =
        view.state === "idle" &&
        current.login.view !== undefined &&
        current.login.view.state !== "idle"
          ? current.login.view
          : view;
      const authenticated = nextView.state === "authenticated";
      return {
        ...current,
        login: {
          view: nextView,
          polling: authenticated ? false : current.login.polling,
          ...(authenticated && current.login.view?.state !== "authenticated"
            ? { authenticatedAt: (current.login.authenticatedAt ?? 0) + 1 }
            : current.login.authenticatedAt !== undefined
              ? { authenticatedAt: current.login.authenticatedAt }
              : {}),
        },
      };
    });
    if (view.state === "authenticated") stopLoginPolling();
  };

  const pollLoginStatus = (): void => {
    const read = port.getAccountLoginStatus;
    if (!read) return;
    void read()
      .then((view) => applyLoginView(view))
      .catch(() => undefined);
  };

  const startLoginPolling = (): void => {
    if (loginTimer !== undefined) return;
    if (!port.getAccountLoginStatus) return;
    loginTimer = setInterval(pollLoginStatus, WEBUI_ACCOUNT_LOGIN_POLL_MS);
    set((current) =>
      current.login.polling ? current : { ...current, login: { ...current.login, polling: true } },
    );
  };

  const beginLogin = async (): Promise<void> => {
    stopLoginPolling();
    const begin = port.beginAccountLogin;
    if (!begin) {
      set((current) => ({
        ...current,
        login: { ...current.login, view: { state: "error", error: "当前服务未提供账号登录" } },
      }));
      return;
    }
    set((current) => ({ ...current, login: { ...current.login, view: undefined } }));
    try {
      const view = await begin();
      applyLoginView(view);
      if (view.state === "pending") startLoginPolling();
      return;
    } catch (reason) {
      set((current) => ({
        ...current,
        login: { ...current.login, view: { state: "error", error: message(reason) } },
      }));
    }
  };

  const cancelLogin = async (): Promise<void> => {
    stopLoginPolling();
    try {
      await port.cancelAccountLogin?.();
    } catch {
      // Cancelling is best-effort: the surface closes regardless, and the
      // server-side attempt expires on its own.
    }
    set((current) => ({ ...current, login: { ...current.login, view: { state: "idle" } } }));
  };

  const switchAccount = async (): Promise<void> => {
    stopLoginPolling();
    set((current) => ({ ...current, login: { ...current.login, view: undefined } }));
    try {
      await port.signOut?.();
    } catch (reason) {
      set((current) => ({
        ...current,
        login: { ...current.login, view: { state: "error", error: message(reason) } },
      }));
      return;
    }
    await beginLogin();
  };

  const loadAccount = async (sessionId?: string): Promise<void> => {
    const read = port.getAccountStatus;
    const key = "account";
    const version = bump(key);
    if (!read) {
      set((current) => ({
        ...current,
        account: { status: "error", error: "当前服务未提供账号信息" },
      }));
      return;
    }
    set((current) => ({ ...current, account: { ...current.account, status: "loading" } }));
    try {
      const value = await read(sessionId ? { sessionId } : undefined);
      if (!isCurrent(key, version)) return;
      set((current) => ({ ...current, account: { status: "ready", value } }));
    } catch (reason) {
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        account: { ...current.account, status: "error", error: message(reason) },
      }));
    }
  };

  const loadUsage = async (forceRefresh = false): Promise<void> => {
    const read = port.getUsageQuota;
    const key = "usage";
    const version = bump(key);
    if (!read) {
      set((current) => ({ ...current, usage: { status: "idle" } }));
      return;
    }
    set((current) => ({ ...current, usage: { ...current.usage, status: "loading" } }));
    try {
      const result = await read(forceRefresh ? { forceRefresh: true } : undefined);
      if (!isCurrent(key, version)) return;
      set((current) => ({ ...current, usage: { status: "ready", result } }));
    } catch (reason) {
      if (!isCurrent(key, version)) return;
      set((current) => ({ ...current, usage: { status: "error", error: message(reason) } }));
    }
  };

  const loadSigninPanel = async (): Promise<void> => {
    const read = port.getSigninPanel;
    const key = "signin";
    const version = bump(key);
    if (!read) {
      set((current) => ({
        ...current,
        signin: { ...current.signin, loading: false, error: "签到暂时不可用，请稍后重试" },
      }));
      return;
    }
    set((current) => ({ ...current, signin: { ...current.signin, loading: true, error: undefined } }));
    try {
      const panel = await read();
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        signin: { ...current.signin, loading: false, panel, error: undefined },
      }));
    } catch (reason) {
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        signin: { ...current.signin, loading: false, error: message(reason) },
      }));
    }
  };

  const claimSignin = async (): Promise<void> => {
    const claim = port.claimSignin;
    if (!claim) return;
    set((current) => ({ ...current, signin: { ...current.signin, claiming: true, error: undefined } }));
    try {
      const result = await claim();
      set((current) => ({
        ...current,
        signin: {
          ...current.signin,
          claiming: false,
          panel: result.panel,
          claim: result,
        },
      }));
    } catch (reason) {
      set((current) => ({
        ...current,
        signin: { ...current.signin, claiming: false, error: message(reason) },
      }));
    }
  };

  const signOutAccount = async (): Promise<void> => {
    const signOut = port.signOut;
    if (!signOut) return;
    set((current) => ({ ...current, signOut: { signingOut: true } }));
    try {
      await signOut();
      set((current) => ({ ...current, signOut: { signingOut: false } }));
      // The account and quota answers belong to the account that just left:
      // re-read both so no surface keeps showing the previous identity.
      await Promise.all([loadAccount(), loadUsage(true)]);
    } catch (reason) {
      set((current) => ({ ...current, signOut: { signingOut: false, error: message(reason) } }));
    }
  };

  const clearSignOutError = (): void => {
    set((current) =>
      current.signOut.error === undefined
        ? current
        : { ...current, signOut: { ...current.signOut, error: undefined } },
    );
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canReadAccount: port.getAccountStatus !== undefined,
    canReadUsage: port.getUsageQuota !== undefined,
    canLogin: port.beginAccountLogin !== undefined,
    canReadSignin: port.getSigninPanel !== undefined,
    canClaimSignin: port.claimSignin !== undefined,
    canSignOut: port.signOut !== undefined,
    loadAccount,
    loadUsage,
    loadSigninPanel,
    claimSignin,
    beginLogin,
    cancelLogin,
    stopLoginPolling,
    switchAccount,
    signOutAccount,
    clearSignOutError,
  };
}
