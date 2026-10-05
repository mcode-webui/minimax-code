// AccountLoginDialog — the browser's device-authorization login.
//
// The WebUI previously had no login at all: it served whatever credential the
// terminal client had written, and 退出登录 did not remove it, so neither
// signing in nor switching accounts was possible without leaving the
// browser. This dialog is the missing surface for both rows of the roadmap's
// 登录与账号 group:
//
//   * 登录方式 — the device-authorization flow the terminal client uses,
//     rendered for the browser: a user code, the page to enter it on, and a
//     poll until the server observes the credential.
//   * 登出·账号切换 — the same dialog is the switch entry: already signed in,
//     it offers 切换账号, which signs the current account out for real and
//     starts a fresh device flow in one place.
//
// Split in two so the node suite can cover every phase without a DOM: the
// `AccountLoginPanel` is a pure view over an injected phase (the suite's
// `renderToStaticMarkup` convention), and the dialog owns the effects —
// start on open, poll while pending, stop on close.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { WebuiAccountLoginView } from "../../server/port.js";

/** Everything the panel can show, derived (not fetched). */
export type WebuiAccountLoginPhase =
  | { readonly kind: "loading" }
  | {
      readonly kind: "pending";
      readonly userCode?: string;
      readonly verificationUri?: string;
      readonly verificationUriComplete?: string;
    }
  | { readonly kind: "authenticated" }
  | { readonly kind: "error"; readonly error: string };

/**
 * Derive the view phase from a server answer. `idle` with no attempt means
 * the dialog just started (or the host has no session); a `pending` answer
 * without a prompt yet is the network being slower than the first reply —
 * the panel says 等待设备码 rather than guessing a code.
 */
export function deriveWebuiAccountLoginPhase(
  view: WebuiAccountLoginView | undefined,
): WebuiAccountLoginPhase {
  if (!view) return { kind: "loading" };
  switch (view.state) {
    case "authenticated":
      return { kind: "authenticated" };
    case "error":
      return { kind: "error", error: view.error };
    case "pending":
      return {
        kind: "pending",
        userCode: view.prompt?.userCode,
        verificationUri: view.prompt?.verificationUri,
        verificationUriComplete: view.prompt?.verificationUriComplete,
      };
    default:
      return { kind: "loading" };
  }
}

export function AccountLoginPanel({
  phase,
  onRetry,
  onCancel,
  onSwitch,
  onClose,
}: {
  readonly phase: WebuiAccountLoginPhase;
  /** Error → start a fresh device flow. */
  readonly onRetry: () => void;
  /** Pending → cancel the in-flight attempt. */
  readonly onCancel: () => void;
  /** Authenticated → sign out, then start a fresh device flow. */
  readonly onSwitch: () => void;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <div
      className="webui-account-login"
      role="dialog"
      aria-modal="true"
      aria-label="账号登录"
      data-testid="account-login-dialog"
      data-webui-account-login-phase={phase.kind}
    >
      <header className="webui-account-login-header">
        <strong>账号登录</strong>
        <button
          type="button"
          aria-label="关闭登录"
          data-testid="account-login-close"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {phase.kind === "loading" ? (
        <p className="webui-account-login-status" data-testid="account-login-status">
          正在获取登录码…
        </p>
      ) : null}
      {phase.kind === "pending" ? (
        <div className="webui-account-login-body">
          {phase.userCode ? (
            <>
              <p className="webui-account-login-hint">在打开的页面中输入以下代码</p>
              <p
                className="webui-account-login-code"
                data-testid="account-login-code"
                aria-label="设备登录码"
              >
                {phase.userCode}
              </p>
            </>
          ) : (
            <p className="webui-account-login-status" data-testid="account-login-status">
              等待设备码…
            </p>
          )}
          {phase.verificationUri ? (
            <a
              className="webui-account-login-uri"
              data-testid="account-login-uri"
              href={phase.verificationUriComplete ?? phase.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              打开授权页面
            </a>
          ) : null}
          <p className="webui-account-login-status" data-testid="account-login-status">
            等待授权中…完成页面上的登录后会自动继续
          </p>
          <div className="webui-account-login-actions">
            <button
              type="button"
              className="webui-button-secondary"
              data-testid="account-login-cancel"
              onClick={onCancel}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      {phase.kind === "authenticated" ? (
        <div className="webui-account-login-body">
          <p className="webui-account-login-status" data-testid="account-login-status">
            已登录。切换账号会先退出当前账号，再开始新的登录。
          </p>
          <div className="webui-account-login-actions">
            <button
              type="button"
              className="webui-button-secondary"
              data-testid="account-login-switch"
              onClick={onSwitch}
            >
              切换账号
            </button>
          </div>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <div className="webui-account-login-body">
          <p className="webui-account-login-status" data-testid="account-login-status">
            登录未完成：{phase.error}
          </p>
          <div className="webui-account-login-actions">
            <button
              type="button"
              className="webui-button-primary"
              data-testid="account-login-retry"
              onClick={onRetry}
            >
              重新获取登录码
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AccountLoginDialog({
  open,
  onClose,
  onAuthenticated,
  beginAccountLogin,
  getAccountLoginStatus,
  cancelAccountLogin,
  signOut,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Fires once per transition into the authenticated state, so the host can
   *  refresh whatever account surfaces it shows. */
  readonly onAuthenticated?: () => void;
  readonly beginAccountLogin?: () => Promise<WebuiAccountLoginView>;
  readonly getAccountLoginStatus?: () => Promise<WebuiAccountLoginView>;
  readonly cancelAccountLogin?: () => Promise<{ readonly ok: true }>;
  readonly signOut?: () => Promise<{ readonly success?: boolean }>;
}): ReactElement | null {
  const [phase, setPhase] = useState<WebuiAccountLoginPhase>({ kind: "loading" });
  const authenticatedNotifiedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // Reset per open: a closed dialog forgets the previous attempt's state,
    // and the authenticated notification must fire again next time.
    authenticatedNotifiedRef.current = false;
    let cancelled = false;
    setPhase({ kind: "loading" });
    const start = () => {
      if (!beginAccountLogin) {
        setPhase({ kind: "error", error: "当前服务未提供账号登录" });
        return;
      }
      void beginAccountLogin()
        .then((view) => {
          if (!cancelled) setPhase(deriveWebuiAccountLoginPhase(view));
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setPhase({
              kind: "error",
              error: error instanceof Error ? error.message : String(error),
            });
        });
    };
    start();
    // Poll while the dialog is open: the credential lands on the server, and
    // only the server can see the authorization complete.
    const timer = window.setInterval(() => {
      if (!getAccountLoginStatus) return;
      void getAccountLoginStatus()
        .then((view) => {
          if (cancelled) return;
          const next = deriveWebuiAccountLoginPhase(view);
          // The first reply may still be `loading` while the attempt starts;
          // never walk a live phase back to loading — only forward matters.
          setPhase((current) =>
            next.kind === "loading" && current.kind !== "loading" ? current : next,
          );
          if (next.kind === "authenticated" && !authenticatedNotifiedRef.current) {
            authenticatedNotifiedRef.current = true;
            onAuthenticated?.();
          }
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `phase` is deliberately not a dependency: the poll closure reading it
    // would restart the interval on every poll's own setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, beginAccountLogin, getAccountLoginStatus]);

  if (!open) return null;
  const dialog = (
    <div
      className="webui-account-login-mask"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <AccountLoginPanel
        phase={phase}
        onRetry={() => {
          setPhase({ kind: "loading" });
          void beginAccountLogin?.()
            .then((view) => setPhase(deriveWebuiAccountLoginPhase(view)))
            .catch((error: unknown) =>
              setPhase({
                kind: "error",
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }}
        onCancel={() => {
          void cancelAccountLogin?.().catch(() => undefined);
          onClose();
        }}
        onSwitch={() => {
          // The real switch: sign out (revoke + wipe) and immediately start
          // a fresh device flow, in the same surface.
          setPhase({ kind: "loading" });
          void signOut?.()
            .then(() => beginAccountLogin?.())
            .then((view) => {
              if (view) setPhase(deriveWebuiAccountLoginPhase(view));
            })
            .catch((error: unknown) =>
              setPhase({
                kind: "error",
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }}
        onClose={onClose}
      />
    </div>
  );
  return typeof document !== "undefined"
    ? createPortal(dialog, document.body)
    : dialog;
}
