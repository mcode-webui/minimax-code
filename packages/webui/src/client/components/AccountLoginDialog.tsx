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

import { useEffect, useRef, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { WebuiAccountLoginView } from "../../shared/contracts/account.js";
import {
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "../bindings/use-query-state.js";

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
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Fires once per transition into the authenticated state, so the host can
   *  refresh whatever account surfaces it shows. */
  readonly onAuthenticated?: () => void;
}): ReactElement | null {
  // The device flow — begin, poll and cancel — belongs to the application
  // account owner (ticket #52). This dialog is a view over its snapshot: it
  // submits commands and renders `login.view`; it owns no interval.
  const workflows = useWebuiAccountWorkflows();
  const snapshot = useWebuiAccountWorkflowsState();
  const phase = deriveWebuiAccountLoginPhase(snapshot.login.view);
  const authenticatedAt = snapshot.login.authenticatedAt;
  const notifiedRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    // A closed dialog forgets the previous attempt's state; the owner is told
    // to begin a fresh flow, and to stop polling when this dialog closes.
    void workflows?.beginLogin();
    return () => {
      workflows?.stopLoginPolling();
    };
  }, [open, workflows]);

  useEffect(() => {
    if (authenticatedAt === undefined) return;
    if (notifiedRef.current === authenticatedAt) return;
    notifiedRef.current = authenticatedAt;
    onAuthenticated?.();
  }, [authenticatedAt, onAuthenticated]);

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
          void workflows?.beginLogin();
        }}
        onCancel={() => {
          void workflows?.cancelLogin();
          onClose();
        }}
        onSwitch={() => {
          // The real switch: sign out (revoke + wipe) and immediately start
          // a fresh device flow, in the same surface.
          void workflows?.switchAccount();
        }}
        onClose={onClose}
      />
    </div>
  );
  return typeof document !== "undefined"
    ? createPortal(dialog, document.body)
    : dialog;
}
