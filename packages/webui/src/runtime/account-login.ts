// Account login session — the WebUI's device-authorization login, owned by
// the server because the credential store lives there.
//
// The WebUI previously had no login at all: it served whatever OAuth
// credential `mcode login` (or the desktop) had already written, and its
// 退出登录 only cleared projections — the credential survived and the next
// lease refresh signed the process right back in. Signing in and switching
// accounts were therefore both impossible without leaving the browser.
//
// This module wraps one `MCodeOAuthCore` (the assembly already builds it for
// quota leases) with the request/reply shape the browser needs:
//
//   * `begin()` starts (or re-attaches to) a device-authorization login and
//     resolves with the prompt — the user code and verification URL the user
//     opens — without waiting for the human to authorize. The core already
//     dedupes concurrent `login()` calls on its own `loginPromise`, so a
//     second `begin()` while one is running re-attaches instead of racing.
//   * `status()` folds three sources into one answer: the settled outcome of
//     the last login attempt, the in-flight prompt, and — with no attempt
//     this process started — the core's persisted state (a TUI login counts).
//   * `cancel()` aborts an in-flight attempt; the credential is untouched.
//
// The prompt itself arrives on the core's `onDeviceAuthorization` callback,
// one HTTP round trip into the login. `begin()` waits briefly for it so the
// first reply usually carries the code; if the network is slow the caller
// sees `pending` without a prompt and the next `status()` poll picks it up.

import type {
  AuthStatusSnapshot,
  DeviceAuthorizationPrompt,
} from "@mavis/oauth-core";

/** The minimal core surface this session needs — the assembly passes its
 * live `MCodeOAuthCore`; tests pass a fake. */
export interface WebuiAccountLoginCore {
  login(options: {
    onDeviceAuthorization?: (authorization: DeviceAuthorizationPrompt) => void;
  }): Promise<{ readonly status: "authenticated"; readonly generation: number }>;
  cancelLogin(): Promise<void>;
  getStatus(): Promise<AuthStatusSnapshot>;
}

export interface WebuiAccountLoginPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAtMs: number;
}

export type WebuiAccountLoginState =
  | { readonly state: "idle" }
  | {
      readonly state: "pending";
      readonly prompt?: WebuiAccountLoginPrompt;
    }
  | { readonly state: "authenticated" }
  | { readonly state: "error"; readonly error: string };

const PROMPT_CAPTURE_TIMEOUT_MS = 5_000;

export interface WebuiAccountLoginSession {
  begin(): Promise<WebuiAccountLoginState>;
  status(): Promise<WebuiAccountLoginState>;
  cancel(): Promise<void>;
}

export function createWebuiAccountLoginSession(
  core: WebuiAccountLoginCore,
  now: () => number = Date.now,
): WebuiAccountLoginSession {
  let prompt: WebuiAccountLoginPrompt | undefined;
  let running = false;
  let cancelled = false;
  let outcome: WebuiAccountLoginState | undefined;

  const start = (): Promise<WebuiAccountLoginState> => {
    running = true;
    cancelled = false;
    prompt = undefined;
    outcome = undefined;
    // Resolves on the first prompt, or early if the attempt settles (or
    // fails) before the device code even arrived — the caller then sees the
    // same state the next `status()` poll would have reported.
    return new Promise<WebuiAccountLoginState>((resolve) => {
      let settled = false;
      const settle = (state: WebuiAccountLoginState) => {
        if (settled) return;
        settled = true;
        resolve(state);
      };
      const timer = setTimeout(
        () => settle({ state: "pending" }),
        PROMPT_CAPTURE_TIMEOUT_MS,
      );
      void core
        .login({
          onDeviceAuthorization: (authorization) => {
            prompt = {
              userCode: authorization.userCode,
              verificationUri: authorization.verificationUri,
              ...(authorization.verificationUriComplete
                ? { verificationUriComplete: authorization.verificationUriComplete }
                : {}),
              expiresAtMs: now() + authorization.expiresInSec * 1_000,
            };
            clearTimeout(timer);
            settle({ state: "pending", prompt });
          },
        })
        .then(() => {
          outcome = { state: "authenticated" };
          clearTimeout(timer);
          settle(outcome);
        })
        .catch((error: unknown) => {
          // A cancelled attempt is the user's own action, not a failure to
          // show; the settled state goes back to whatever the store says.
          outcome = cancelled
            ? undefined
            : {
                state: "error",
                error: error instanceof Error ? error.message : String(error),
              };
          clearTimeout(timer);
          settle(outcome ?? { state: "idle" });
        })
        .finally(() => {
          running = false;
        });
    });
  };

  return {
    begin: () => (running ? Promise.resolve({ state: "pending" as const, prompt }) : start()),
    status: async () => {
      if (outcome) return outcome;
      if (running) return { state: "pending", prompt };
      // No attempt this process started: the persisted state is the truth,
      // and a login made in the terminal client counts here too.
      try {
        const snapshot = await core.getStatus();
        return snapshot.status === "authenticated"
          ? { state: "authenticated" }
          : { state: "idle" };
      } catch {
        return { state: "idle" };
      }
    },
    cancel: async () => {
      if (!running) return;
      cancelled = true;
      await core.cancelLogin().catch(() => undefined);
      running = false;
      prompt = undefined;
      outcome = undefined;
    },
  };
}
