// The account workflow owner.
//
// One owner for everything the account surfaces read and write: the account
// record, the usage quota, the daily check-in panel and claim, the device
// login flow — including its **poll** — and sign-out. The two problems this
// closes:
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

import type { WebuiIdentityEpochs } from "../../../application/identity-epochs.js";
import type { AccountPort } from "../contracts/account-port.js";
import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "../../../../shared/contracts/account.js";
import type {
  WebuiResetCardFlowView,
  WebuiResetCardOutcome,
  WebuiResetCardView,
} from "../../../../shared/contracts/account-billing.js";
import type {
  WebuiAccountProfileView,
  WebuiUsageSummaryView,
} from "../../../../shared/contracts/account-usage.js";
import type { WebuiUsageQuotaResult } from "../../../../shared/contracts/usage-quota.js";
import { SigninPanelScene, type SigninDayItem } from "@mavis/shared/daily-signin";

/** The transport methods this owner drives. Absent means "not wired". */
export type WebuiAccountPortSlice = Pick<
  AccountPort,
  | "getAccountStatus"
  | "getUsageQuota"
  | "getCreditFallback"
  | "setCreditFallback"
  | "listResetCards"
  | "useResetCard"
  | "queryResetCardFlows"
  | "getAccountUsageSummary"
  | "getAccountProfile"
  | "getSigninPanel"
  | "claimSignin"
  | "beginAccountLogin"
  | "getAccountLoginStatus"
  | "cancelAccountLogin"
  | "signOut"
  | "getMiniMaxApiKeyStatus"
  | "getCodexOAuthStatus"
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

/**
 * The credit-fallback switch of the usage-and-model page: whether chat usage
 * may spend credits once the plan quota is exhausted.
 *
 * `enabled` is absent until the account API has produced a verdict, and
 * `resolved` says whether it did. A signed-out account leaves it unresolved
 * rather than reporting "off": the row hides itself in that case, and a switch
 * that says "off" would claim a setting the account does not have.
 */
export interface WebuiCreditFallbackState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly enabled?: boolean;
  readonly resolved: boolean;
  /** True while a write is in flight; the switch is disabled meanwhile. */
  readonly saving: boolean;
  readonly error?: string;
}

/**
 * One credential-status read. `error` carries the unavailable message too: an
 * un-wired capability and a failed read are both "no answer", and the surface
 * that renders them already distinguishes the two by their text.
 */
export interface WebuiAccountCredentialStatusState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly value?: Record<string, unknown>;
  readonly error?: string;
}

/**
 * The account page's calendar: the lifetime token usage the account page's
 * three headline numbers and its heat map are drawn from.
 */
export interface WebuiAccountUsageSummaryState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly summary?: WebuiUsageSummaryView;
  readonly error?: string;
}

/**
 * The account page's profile: the display name, the avatar, the contact the
 * account page shows and the registration time the heat map's first column
 * depends on.
 */
export interface WebuiAccountProfileState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly profile?: WebuiAccountProfileView;
  readonly error?: string;
}

export interface WebuiAccountWorkflowsState {
  readonly account: WebuiAccountRecordState;
  readonly apiKeyStatus: WebuiAccountCredentialStatusState;
  readonly codexOAuth: WebuiAccountCredentialStatusState;
  readonly usage: WebuiUsageQuotaState;
  readonly usageSummary: WebuiAccountUsageSummaryState;
  readonly profile: WebuiAccountProfileState;
  readonly creditFallback: WebuiCreditFallbackState;
  readonly resetCards: WebuiResetCardState;
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

export const initialWebuiAccountCredentialStatusState: WebuiAccountCredentialStatusState =
  { status: "idle" };

export const initialWebuiCreditFallbackState: WebuiCreditFallbackState = {
  status: "idle",
  resolved: false,
  saving: false,
};

export const initialWebuiAccountUsageSummaryState: WebuiAccountUsageSummaryState = {
  status: "idle",
};

export const initialWebuiAccountProfileState: WebuiAccountProfileState = {
  status: "idle",
};

/**
 * The redemption phase. The names and the order are the Desktop's: the phase
 * decides which status line the card panel shows and which actions it offers,
 * so a phase that is not listed here has no meaning to copy.
 */
export type WebuiResetCardPhase =
  | "idle"
  | "using"
  | "refreshing"
  | "success"
  | "replayed"
  | "unavailable"
  | "offline"
  | "retryable"
  | "busy"
  | "unknown"
  | "refresh_failed";

/** One paged list — the cards or the history. */
export interface WebuiResetCardPageState<T = WebuiResetCardView> {
  readonly items: readonly T[];
  readonly page: number;
  readonly loading: boolean;
  readonly error?: string;
  readonly hasMore: boolean;
  /** True when a "load more" failed, so the retry belongs to that button. */
  readonly retryMore: boolean;
}

/**
 * The reset-card state: the card list, the history and the phase of the last
 * redemption.
 *
 * The redemption answer is not a boolean. The account API distinguishes "the
 * quota was reset" from "this card was already used", "this card expired" and
 * "the request may or may not have gone through", and the last one must not be
 * reported as a failure — the card may well have been spent.
 */
export interface WebuiResetCardState {
  readonly cards: WebuiResetCardPageState;
  readonly total: number;
  readonly history: WebuiResetCardPageState<WebuiResetCardFlowView>;
  readonly phase: WebuiResetCardPhase;
  readonly error?: string;
  readonly selected?: WebuiResetCardView;
  readonly dialogOpen: boolean;
  readonly historyOpen: boolean;
}

export const initialWebuiResetCardPageState: WebuiResetCardPageState = {
  items: [],
  page: 0,
  loading: false,
  hasMore: true,
  retryMore: false,
};

export const initialWebuiResetCardState: WebuiResetCardState = {
  cards: initialWebuiResetCardPageState,
  total: 0,
  history: { ...initialWebuiResetCardPageState, items: [] as readonly WebuiResetCardFlowView[] },
  phase: "idle",
  dialogOpen: false,
  historyOpen: false,
};

/**
 * The history window the Desktop asks for: the last 30 days. The account API
 * takes the lower bound as a timestamp, so the window is computed per read.
 */
export const WEBUI_RESET_CARD_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** The page size the Desktop uses for both the card list and the history. */
const RESET_CARD_PAGE_SIZE = 20;

export const initialWebuiAccountWorkflowsState: WebuiAccountWorkflowsState = {
  account: initialWebuiAccountRecordState,
  apiKeyStatus: initialWebuiAccountCredentialStatusState,
  codexOAuth: initialWebuiAccountCredentialStatusState,
  usage: initialWebuiUsageQuotaState,
  usageSummary: initialWebuiAccountUsageSummaryState,
  profile: initialWebuiAccountProfileState,
  creditFallback: initialWebuiCreditFallbackState,
  resetCards: initialWebuiResetCardState,
  signin: initialWebuiSigninState,
  login: initialWebuiAccountLoginState,
  signOut: initialWebuiAccountSignOutState,
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Coerce a sign-in panel off the wire before it reaches the state.
 *
 * The transport resolves the server body verbatim (`resolve(frame.body as T)`
 * in `client/platform/transport.ts`), and the sign-in view reads `panel.days`
 * with no guard — the shared streak helper does `[...days].sort(...)`. A body
 * that is not a panel — `{}`, a server error envelope, anything without
 * `days` — therefore threw `days is not iterable` and took the entire app
 * tree into the error boundary.
 *
 * The server does validate (`validateSigninPanel` throws `Invalid sign-in
 * panel`), so this is defence at the boundary rather than a known live shape.
 * It is here because the blast radius is the whole UI, not one row: a
 * malformed panel must degrade to an empty seven-day strip, never to a blank
 * page.
 */
function normalizeSigninPanel(value: unknown): WebuiSigninPanelView {
  const raw = value as { scene?: unknown; days?: unknown } | null;
  const days = Array.isArray(raw?.days)
    ? raw.days.filter(
        (day): day is SigninDayItem =>
          Boolean(day) &&
          typeof day === "object" &&
          typeof (day as { day_no?: unknown }).day_no === "number",
      )
    : [];
  return {
    scene:
      typeof raw?.scene === "number"
        ? (raw.scene as SigninPanelScene)
        : SigninPanelScene.Unknown,
    days,
  };
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
  readonly loadUsage: (forceRefresh?: boolean) => Promise<boolean>;
  /**
   * Read the account page's calendar. A superseded answer is dropped, like
   * every other read this owner drives.
   */
  readonly loadAccountUsageSummary: () => Promise<void>;
  /** Read the account page's profile. */
  readonly loadAccountProfile: () => Promise<void>;
  /**
   * Read the credit-fallback switch. A superseded answer is dropped, like
   * every other read this owner drives.
   */
  readonly loadCreditFallback: () => Promise<void>;
  /**
   * Turn the credit fallback on or off. The state the switch ends up in is
   * the account API's own verdict, not the requested value — the Desktop
   * re-reads the flag from the response for the same reason.
   */
  readonly setCreditFallback: (enabled: boolean) => Promise<void>;

  /**
   * The reset cards are a plan feature: the Desktop only offers them to a
   * subscribed account, and so does this owner.
   */
  readonly canUseResetCards: boolean;
  /** Read the first page of the account's redeemable reset cards. */
  readonly loadResetCards: () => Promise<boolean>;
  /** Read the next page of the card list. */
  readonly loadMoreResetCards: () => Promise<boolean>;
  /** Open the history panel and read its first page. */
  readonly openResetCardHistory: () => Promise<boolean>;
  /** Read the next page of the history. */
  readonly loadMoreResetCardHistory: () => Promise<boolean>;
  /** Close the history panel. */
  readonly closeResetCardHistory: () => void;
  /** Choose the card the confirmation panel is about. */
  readonly selectResetCard: (card: WebuiResetCardView) => void;
  /** Drop the chosen card without redeeming it. */
  readonly clearResetCardSelection: () => void;
  /**
   * Redeem the chosen card. The phase it ends in is the account API's verdict,
   * not a success flag: an answer that cannot be trusted becomes `unknown`, and
   * the card stays selected so the user can retry the same card.
   */
  readonly redeemResetCard: () => Promise<void>;

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

  readonly canReadApiKeyStatus: boolean;
  readonly canReadCodexOAuth: boolean;
  /** Read the MiniMax API key status. A superseded answer is dropped. */
  readonly loadApiKeyStatus: () => Promise<void>;
  /** Read the Codex OAuth status once. */
  readonly loadCodexOAuthStatus: () => Promise<void>;
  /**
   * Poll the Codex OAuth status while a login surface needs it, and stop when the
   * last holder releases. The timer lives here so a hidden or remounted surface
   * cannot leave a second one behind.
   */
  readonly acquireCodexOAuthPolling: () => () => void;

  /**
   * Terminal teardown: every timer this owner runs stops and a late answer can no
   * longer commit. The application is replaced per mount, so an owner that kept
   * polling after its mount went away would be a leak.
   */
  readonly dispose: () => void;

  /** Sign out, then refresh the account and usage answers. */
  readonly signOutAccount: () => Promise<void>;
  /** Clear the recorded sign-out error once the surface is dismissed. */
  readonly clearSignOutError: () => void;
}

export function createWebuiAccountWorkflows(deps: {
  readonly port: WebuiAccountPortSlice;
  /**
   * The application's opaque generation context. Sign-in, sign-out, a claim and
   * an authoritative status answer that reports a different identity all retire
   * the answers computed under the previous credential generation.
   */
  readonly identityEpochs?: WebuiIdentityEpochs;
}): WebuiAccountWorkflows {
  const { port } = deps;
  /** Called after the credential facts changed; never before they did. */
  const afterCredentialChange = (): void => {
    deps.identityEpochs?.advance("credentials");
  };
  /**
   * The credential-relevant projection of one status answer: only the fields
   * that say *who* the browser is signed in as. An answer that repeats them is
   * not a reconciliation and must not retire anything — otherwise every poll
   * would invalidate the answers it just read.
   */
  const credentialFingerprint = (
    value: Record<string, unknown> | undefined,
  ): string =>
    JSON.stringify([
      value?.signedIn ?? null,
      value?.accountId ?? value?.account_id ?? null,
      value?.plan ?? null,
    ]);
  let lastCredentialFingerprint: string | undefined;
  let disposed = false;
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

  /**
   * The credential-status loader. Both reads share it: one version key each, so a
   * superseded answer is dropped instead of overwriting a newer one.
   */
  const loadCredentialStatus = async (
    key: "apiKeyStatus" | "codexOAuth",
    read: (() => Promise<Record<string, unknown>>) | undefined,
    unavailableMessage: string,
  ): Promise<void> => {
    if (!read) {
      set((current) => ({
        ...current,
        [key]: { status: "error", error: unavailableMessage },
      }));
      return;
    }
    if (disposed) return;
    const version = bump(key);
    set((current) => ({
      ...current,
      [key]: { ...current[key], status: "loading" },
    }));
    try {
      const value = await read();
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({ ...current, [key]: { status: "ready", value } }));
    } catch (error) {
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        [key]: { status: "error", error: message(error) },
      }));
    }
  };

  /** The Codex OAuth status poll: one timer for the whole owner, however many
   *  surfaces hold an interest, and no timer at all while nobody does. */
  let codexPollTimer: ReturnType<typeof setInterval> | undefined;
  let codexPollHolders = 0;
  const stopCodexPolling = (): void => {
    if (codexPollTimer === undefined) return;
    clearInterval(codexPollTimer);
    codexPollTimer = undefined;
  };

  let loginTimer: ReturnType<typeof setInterval> | undefined;

  const acquireCodexOAuthPolling = (): (() => void) => {
    if (disposed) return () => undefined;
    codexPollHolders += 1;
    if (codexPollTimer === undefined && port.getCodexOAuthStatus) {
      void loadCredentialStatus(
        "codexOAuth",
        port.getCodexOAuthStatus,
        "当前运行时不支持 Codex 登录状态。",
      );
      codexPollTimer = setInterval(() => {
        void loadCredentialStatus(
          "codexOAuth",
          port.getCodexOAuthStatus,
          "当前运行时不支持 Codex 登录状态。",
        );
      }, 1000);
    }
    return () => {
      codexPollHolders = Math.max(0, codexPollHolders - 1);
      if (codexPollHolders === 0) stopCodexPolling();
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopLoginPolling();
    stopCodexPolling();
    codexPollHolders = 0;
    listeners.clear();
  };

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
    if (view.state === "authenticated") {
      stopLoginPolling();
      // Sign-in completed: the credential generation moves, so answers captured
      // while signed out cannot commit afterwards.
      afterCredentialChange();
    }
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
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({ ...current, account: { status: "ready", value } }));
      // Authoritative reconciliation: the runtime is the credential authority,
      // so an answer that reports a *different* identity advances the epoch. The
      // first answer establishes the baseline instead of retiring everything.
      const fingerprint = credentialFingerprint(value);
      if (lastCredentialFingerprint !== undefined && fingerprint !== lastCredentialFingerprint) {
        afterCredentialChange();
      }
      lastCredentialFingerprint = fingerprint;
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        account: { ...current.account, status: "error", error: message(reason) },
      }));
    }
  };

  /**
   * The account page's two reads. They are separate because the page renders
   * them separately: a failed calendar must not hide the profile, and a failed
   * profile must not hide the calendar.
   */
  const loadAccountPageRead = async <T>(
    key: "usageSummary" | "profile",
    field: "summary" | "profile",
    read: (() => Promise<T>) | undefined,
    unavailableMessage: string,
  ): Promise<void> => {
    if (!read) {
      set((current) => ({
        ...current,
        [key]: { status: "error", error: unavailableMessage },
      }));
      return;
    }
    const version = bump(key);
    set((current) => ({
      ...current,
      [key]: { ...current[key], status: "loading" },
    }));
    try {
      const value = await read();
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        [key]: { status: "ready", [field]: value },
      }));
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        [key]: { status: "error", error: message(reason) },
      }));
    }
  };

  const loadAccountUsageSummary = async (): Promise<void> => {
    await loadAccountPageRead(
      "usageSummary",
      "summary",
      port.getAccountUsageSummary,
      "当前运行时不支持用量统计。",
    );
  };

  const loadAccountProfile = async (): Promise<void> => {
    await loadAccountPageRead(
      "profile",
      "profile",
      port.getAccountProfile,
      "当前运行时不支持账户资料。",
    );
  };

  const loadCreditFallback = async (): Promise<void> => {
    const read = port.getCreditFallback;
    const key = "creditFallback";
    const version = bump(key);
    if (!read) {
      set((current) => ({
        ...current,
        creditFallback: { status: "idle", resolved: false, saving: false },
      }));
      return;
    }
    set((current) => ({
      ...current,
      creditFallback: { ...current.creditFallback, status: "loading" },
    }));
    try {
      const view = await read();
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        creditFallback: {
          status: "ready",
          resolved: view.resolved,
          ...(view.enabled !== undefined ? { enabled: view.enabled } : {}),
          saving: false,
        },
      }));
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        creditFallback: {
          status: "error",
          resolved: false,
          saving: false,
          error: message(reason),
        },
      }));
    }
  };

  const setCreditFallback = async (enabled: boolean): Promise<void> => {
    const write = port.setCreditFallback;
    if (!write) return;
    const key = "creditFallback";
    const version = bump(key);
    set((current) => ({
      ...current,
      creditFallback: { ...current.creditFallback, saving: true, error: undefined },
    }));
    try {
      const view = await write({ enabled });
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        creditFallback: {
          status: "ready",
          resolved: view.resolved,
          ...(view.enabled !== undefined ? { enabled: view.enabled } : {}),
          saving: false,
        },
      }));
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        creditFallback: {
          ...current.creditFallback,
          saving: false,
          error: message(reason),
        },
      }));
    }
  };

  const loadResetCards = async (): Promise<boolean> => loadResetCardPage("cards", 1);

  const loadMoreResetCards = async (): Promise<boolean> => {
    const page = state.resetCards.cards;
    if (!page.hasMore || page.loading) return false;
    return loadResetCardPage("cards", page.page + 1, true);
  };

  const openResetCardHistory = async (): Promise<boolean> => {
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, historyOpen: true },
    }));
    return loadResetCardPage("history", 1);
  };

  const loadMoreResetCardHistory = async (): Promise<boolean> => {
    const page = state.resetCards.history;
    if (!page.hasMore || page.loading) return false;
    return loadResetCardPage("history", page.page + 1, true);
  };

  const closeResetCardHistory = (): void => {
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, historyOpen: false },
    }));
  };

  const selectResetCard = (card: WebuiResetCardView): void => {
    set((current) => ({
      ...current,
      resetCards: {
        ...current.resetCards,
        selected: card,
        phase: "idle",
        error: undefined,
      },
    }));
  };

  const clearResetCardSelection = (): void => {
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, selected: undefined },
    }));
  };

  /**
   * Redeems the chosen card.
   *
   * The order of the checks is the Desktop's: the card has to still be on the
   * list and unexpired, the account has to be online, and only then is the
   * request sent. The answer is mapped to a phase rather than to a boolean, so
   * "could not tell" stays a phase the user can retry from instead of becoming
   * a failure that pretends the card is untouched.
   */
  const redeemResetCard = async (): Promise<void> => {
    const read = port.useResetCard;
    const selected = state.resetCards.selected;
    if (!read || !selected) return;
    if (!isOnline()) {
      set((current) => ({
        ...current,
        resetCards: { ...current.resetCards, phase: "offline", error: undefined },
      }));
      return;
    }
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, phase: "using", error: undefined },
    }));
    let outcome: WebuiResetCardOutcome;
    try {
      const result = await read({
        ...(selected.sourceType !== undefined ? { sourceType: selected.sourceType } : {}),
        ...(selected.outBizNo !== undefined ? { outBizNo: selected.outBizNo } : {}),
      });
      outcome = result.outcome;
    } catch (reason) {
      set((current) => ({
        ...current,
        resetCards: { ...current.resetCards, phase: "unknown", error: message(reason) },
      }));
      return;
    }
    if (outcome === "SUCCESS" || outcome === "REPLAYED") {
      const redeemedPhase: WebuiResetCardPhase =
        outcome === "SUCCESS" ? "success" : "replayed";
      set((current) => ({
        ...current,
        resetCards: {
          ...current.resetCards,
          phase: redeemedPhase,
          selected: undefined,
        },
      }));
      await refreshAfterRedemption(redeemedPhase);
      return;
    }
    if (outcome === "EXPIRED" || outcome === "NOT_FOUND") {
      set((current) => ({
        ...current,
        resetCards: { ...current.resetCards, phase: "unavailable", selected: undefined },
      }));
      await loadResetCards();
      return;
    }
    const phase: WebuiResetCardPhase =
      outcome === "RETRYABLE_FAIL" ? "retryable" : outcome === "LOCK_BUSY" ? "busy" : "unknown";
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, phase },
    }));
  };

  /**
   * After a redemption the account's quota, its cards and its history have all
   * moved. The Desktop reads all three again and restores the redemption's own
   * phase when the refresh succeeded, so a successful reset does not leave the
   * panel saying "refreshing" forever.
   */
  const refreshAfterRedemption = async (
    redeemedPhase: WebuiResetCardPhase,
  ): Promise<void> => {
    set((current) => ({
      ...current,
      resetCards: { ...current.resetCards, phase: "refreshing" },
    }));
    const results = await Promise.all([
      loadUsage(true),
      loadResetCards(),
      // The Desktop re-reads the history only when the history panel is open;
      // a closed panel has nothing to show and no reason to ask.
      state.resetCards.historyOpen ? loadResetCardPage("history", 1) : Promise.resolve(true),
    ]);
    const refreshed = results.every(Boolean);
    set((current) => ({
      ...current,
      resetCards: {
        ...current.resetCards,
        phase: refreshed ? redeemedPhase : "refresh_failed",
      },
    }));
  };

  /**
   * Reads one page of the card list or of the history. A failed "load more"
   * keeps the rows it already has and marks the retry on that button, so a
   * failed page does not wipe the list the user is reading.
   */
  const loadResetCardPage = async (
    kind: "cards" | "history",
    page: number,
    isMore = false,
  ): Promise<boolean> => {
    const key = `resetCards.${kind}`;
    const version = bump(key);
    set((current) => ({
      ...current,
      resetCards: {
        ...current.resetCards,
        [kind]: {
          ...current.resetCards[kind],
          loading: true,
          error: undefined,
          retryMore: isMore,
        },
      },
    }));
    try {
      if (kind === "cards") {
        const read = port.listResetCards;
        if (!read) {
          set((current) => ({
            ...current,
            resetCards: {
              ...current.resetCards,
              cards: { ...current.resetCards.cards, loading: false, hasMore: false },
            },
          }));
          return false;
        }
        const result = await read({ page, size: RESET_CARD_PAGE_SIZE });
        if (disposed || !isCurrent(key, version)) return false;
        set((current) => ({
          ...current,
          resetCards: {
            ...current.resetCards,
            total: result.total,
            cards: {
              items: isMore
                ? mergeResetCards(current.resetCards.cards.items, result.cards)
                : result.cards,
              page,
              loading: false,
              hasMore: result.cards.length > 0 && RESET_CARD_PAGE_SIZE * page < result.total,
              retryMore: false,
            },
          },
        }));
        return true;
      }
      const read = port.queryResetCardFlows;
      if (!read) {
        set((current) => ({
          ...current,
          resetCards: {
            ...current.resetCards,
            history: { ...current.resetCards.history, loading: false, hasMore: false },
          },
        }));
        return false;
      }
      const result = await read({
        page,
        size: RESET_CARD_PAGE_SIZE,
        createTimeMs: Date.now() - WEBUI_RESET_CARD_HISTORY_WINDOW_MS,
      });
      if (disposed || !isCurrent(key, version)) return false;
      set((current) => ({
        ...current,
        resetCards: {
          ...current.resetCards,
          history: {
            items: isMore
              ? mergeResetCardFlows(current.resetCards.history.items, result.flows)
              : result.flows,
            page,
            loading: false,
            hasMore: result.flows.length > 0,
            retryMore: false,
          },
        },
      }));
      return true;
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return false;
      set((current) => ({
        ...current,
        resetCards: {
          ...current.resetCards,
          [kind]: {
            ...current.resetCards[kind],
            loading: false,
            error: message(reason),
            retryMore: isMore,
          },
        },
      }));
      return false;
    }
  };

  /**
   * Reads the usage quota. The answer is `true` when the read produced a
   * result: the reset-card refresh needs to know whether the quota actually
   * moved, not merely whether the call returned.
   */
  const loadUsage = async (forceRefresh = false): Promise<boolean> => {
    const read = port.getUsageQuota;
    const key = "usage";
    const version = bump(key);
    if (!read) {
      set((current) => ({ ...current, usage: { status: "idle" } }));
      return false;
    }
    set((current) => ({ ...current, usage: { ...current.usage, status: "loading" } }));
    try {
      const result = await read(forceRefresh ? { forceRefresh: true } : undefined);
      if (disposed || !isCurrent(key, version)) return false;
      set((current) => ({ ...current, usage: { status: "ready", result } }));
      return true;
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return false;
      set((current) => ({ ...current, usage: { status: "error", error: message(reason) } }));
      return false;
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
      if (disposed || !isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        signin: { ...current.signin, loading: false, panel: normalizeSigninPanel(panel), error: undefined },
      }));
    } catch (reason) {
      if (disposed || !isCurrent(key, version)) return;
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
      // A claim changes the account's credential facts, so it retires the
      // answers computed under the previous generation.
      afterCredentialChange();
      set((current) => ({
        ...current,
        signin: {
          ...current.signin,
          claiming: false,
          panel: normalizeSigninPanel(result.panel),
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
      // The account that just left owned the previous credential generation:
      // retire it before the re-reads, so an answer still in flight for the old
      // identity cannot land as current.
      lastCredentialFingerprint = undefined;
      afterCredentialChange();
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
    canReadApiKeyStatus: port.getMiniMaxApiKeyStatus !== undefined,
    canReadCodexOAuth: port.getCodexOAuthStatus !== undefined,
    // The reset cards are a plan feature: the Desktop only offers them to a
    // subscribed account. The answer follows the usage read, so it is a getter
    // rather than a value captured when the owner was built.
    get canUseResetCards(): boolean {
      const result = state.usage.result;
      return (
        port.listResetCards !== undefined &&
        result !== undefined &&
        result.signedIn === true &&
        result.hasTokenPlan === true
      );
    },
    loadApiKeyStatus: () =>
      loadCredentialStatus(
        "apiKeyStatus",
        port.getMiniMaxApiKeyStatus,
        "MiniMax API key status unavailable",
      ),
    loadCodexOAuthStatus: () =>
      loadCredentialStatus(
        "codexOAuth",
        port.getCodexOAuthStatus,
        "当前运行时不支持 Codex 登录状态。",
      ),
    acquireCodexOAuthPolling,
    dispose,
    loadAccount,
    loadUsage,
    loadAccountUsageSummary,
    loadAccountProfile,
    loadCreditFallback,
    setCreditFallback,
    loadResetCards,
    loadMoreResetCards,
    openResetCardHistory,
    loadMoreResetCardHistory,
    closeResetCardHistory,
    selectResetCard,
    clearResetCardSelection,
    redeemResetCard,
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

/**
 * Whether the browser believes it is online. The Desktop reads the same
 * `navigator.onLine` flag and refuses to redeem a card while it is false, so
 * the failure is reported as "offline" rather than as a request error. A host
 * without a `navigator` (a server render, a unit test) is treated as online:
 * the request itself is the real check.
 */
function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/**
 * Merges a page into the list it extends. A card that is already on the list
 * is replaced by the newer copy, so a card the account re-issued does not
 * appear twice.
 */
function mergeResetCards(
  existing: readonly WebuiResetCardView[],
  incoming: readonly WebuiResetCardView[],
): readonly WebuiResetCardView[] {
  return [
    ...new Map([...existing, ...incoming].map((card) => [card.cardId, card])).values(),
  ];
}

/** Merges a history page into the list it extends, the same way. */
function mergeResetCardFlows(
  existing: readonly WebuiResetCardFlowView[],
  incoming: readonly WebuiResetCardFlowView[],
): readonly WebuiResetCardFlowView[] {
  return [
    ...new Map(
      [...existing, ...incoming].map((flow) => [
        `${flow.cardId}\u0000${flow.eventType}\u0000${flow.createTimeMs ?? ""}\u0000${flow.sourceType ?? ""}`,
        flow,
      ]),
    ).values(),
  ];
}
