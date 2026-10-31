// AccountLoginDialog — the browser's device-authorization login.
//
// The WebUI previously had no login at all: it served whatever credential the
// terminal client had written, and 退出登录 did not remove it, so neither
// signing in nor switching accounts was possible without leaving the
// browser. This dialog is the missing surface for both:
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
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "../bindings/use-account-workflows.public.js";
import { deriveWebuiAccountLoginPhase } from "../application/login-phase.js";
import type { WebuiAccountLoginPhase } from "../application/login-phase.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiDialog } from "../../../ui/dialog.js";

export function AccountLoginPanel({
  phase,
  onRetry,
  onCancel,
  onSwitch,
}: {
  readonly phase: WebuiAccountLoginPhase;
  /** Error → start a fresh device flow. */
  readonly onRetry: () => void;
  /** Pending → cancel the in-flight attempt. */
  readonly onCancel: () => void;
  /** Authenticated → sign out, then start a fresh device flow. */
  readonly onSwitch: () => void;
}): ReactElement {
  return (
    <div className="webui-account-login-content">
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
            <WebuiButton variant="grouped" size="pill" data-testid="account-login-cancel"
              onClick={onCancel}
            >
              取消
            </WebuiButton>
          </div>
        </div>
      ) : null}
      {phase.kind === "authenticated" ? (
        <div className="webui-account-login-body">
          <p className="webui-account-login-status" data-testid="account-login-status">
            已登录。切换账号会先退出当前账号，再开始新的登录。
          </p>
          <div className="webui-account-login-actions">
            <WebuiButton variant="grouped" size="pill" data-testid="account-login-switch"
              onClick={onSwitch}
            >
              切换账号
            </WebuiButton>
          </div>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <div className="webui-account-login-body">
          <p className="webui-account-login-status" data-testid="account-login-status">
            登录未完成：{phase.error}
          </p>
          <div className="webui-account-login-actions">
            <WebuiButton variant="accent" size="action" data-testid="account-login-retry"
              onClick={onRetry}
            >
              重新获取登录码
            </WebuiButton>
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
  const { dom } = useWebuiBrowserCapabilities();
  // The device flow — begin, poll and cancel — belongs to the application
  // account owner. This dialog is a view over its snapshot: it submits commands
  // and renders `login.view`; it owns no interval.
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
  const portalTarget = dom.portalTarget();
  return (
      <WebuiDialog
        id="account-login"
        title="账号登录"
        onClose={onClose}
        dismissOnEscape
        width="compact"
        portalTarget={portalTarget}
        testId="account-login-dialog"
        closeLabel="关闭登录"
        closeTestId="account-login-close"
        dataAttributes={{ "data-webui-account-login-phase": phase.kind }}
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
      />
      </WebuiDialog>
  );
}
