// AccountLoginPage — the browser's sign-in page.
//
// The Desktop opens a dedicated window for this: a page, not a dialog, with the
// product mark at the top, one call to action, and the legal notice at the
// bottom. The browser's equivalent is a full-viewport surface that takes the
// viewport while it is open, because the flow it drives — a device
// authorization the user completes in another tab — is the one the Desktop's
// window drives.
//
// The page is transcribed from the Desktop's own login page: the same order
// (mark, wordmark, subtitle, call to action, the "the browser did not open"
// assist, the error, the legal notice), the same geometry and the same copy.
// Two things are the browser's own, and both are declared here rather than
// hidden:
//
//   * The Desktop asks the operating system to open the authorization page.
//     A browser may only open a tab from a user gesture, so the call to action
//     reserves the tab in the click itself and sends it to the authorization
//     page once the device code has travelled to the server and back. The
//     Desktop's assist — the copy-the-link row that appears while the code is
//     waiting — is what covers a browser that refuses to open the tab at all.
//   * The Desktop's wordmark is an image; this client draws its own. The
//     mark above it is the same mascot the Desktop shows.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { IconCopy } from "@tabler/icons-react";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "../bindings/use-account-workflows.public.js";
import { deriveWebuiAccountLoginPagePhase } from "../application/login-page-phase.js";
import { webuiAccountLegalLinks } from "../../../../shared/account-legal-links.js";
import type { WebuiAccountScope } from "../../../../shared/account-legal-links.js";
import { WebuiButton } from "../../../ui/button.js";
import { FeedbackAnnouncement, FeedbackError } from "../../../ui/feedback.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";

/** The Desktop's own copy for this page. */
const COPY = {
  subtitle: "登录后即可开始使用",
  waitingSubtitle: "请继续在浏览器中登录",
  signIn: "登录",
  openingBrowser: "正在打开浏览器...",
  waitingAuthorization: "在浏览器中继续",
  cancelLogin: "取消登录",
  browserNotOpened: "浏览器没打开？",
  copyLoginLink: "复制登录链接",
  linkCopied: "已复制",
  copyLinkFailed: "复制链接失败，请重试。",
  agreePrefix: "登录即表示你同意",
  termsOfService: "服务条款",
  and: "和",
  privacyPolicy: "隐私政策",
  openBrowserFailed: "打开浏览器失败，请稍后重试",
  signedIn: "已登录。切换账号会先退出当前账号，再开始新的登录。",
  switchAccount: "切换账号",
} as const;

/** How the page was opened. */
export type WebuiAccountLoginPageMode =
  /** Sign in. An account that is already signed in is offered the switch. */
  | "sign-in"
  /** Sign the current account out first, then sign another one in. */
  | "switch";

type CopyState = "idle" | "success" | "error";

export function AccountLoginPage({
  open,
  mode,
  scope,
  onClose,
  onAuthenticated,
}: {
  readonly open: boolean;
  readonly mode: WebuiAccountLoginPageMode;
  /** The account scope, so the legal notice names the account's own documents. */
  readonly scope?: WebuiAccountScope;
  readonly onClose: () => void;
  /** Fires once per transition into the authenticated state. */
  readonly onAuthenticated?: () => void;
}): ReactElement | null {
  const { dom } = useWebuiBrowserCapabilities();
  const workflows = useWebuiAccountWorkflows();
  const snapshot = useWebuiAccountWorkflowsState();
  const view = snapshot.login.view;
  const phase = deriveWebuiAccountLoginPagePhase(view);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [browserError, setBrowserError] = useState<string | undefined>(undefined);
  // The tab the call to action reserved, and the code it is waiting for.
  const reservedTab = useRef<Window | null>(null);
  const authenticatedAt = snapshot.login.authenticatedAt;
  const notifiedRef = useRef<number | undefined>(undefined);

  const layerId = useDialogLayer({
    id: "account-login-page",
    active: open,
    dismissible: true,
    onClose,
  });

  useEffect(() => {
    if (!open) return;
    setCopyState("idle");
    setBrowserError(undefined);
    if (mode === "switch") {
      // The switch signs the current account out first — for real, so the
      // credential is revoked and gone — and leaves the page on the sign-in it
      // offers every account.
      void workflows?.signOutAccount();
      return;
    }
    // Otherwise the page asks whether an account is signed in, and only offers
    // a sign-in when there is none.
    void workflows?.loadLoginStatus();
  }, [open, mode, workflows]);

  useEffect(() => {
    if (authenticatedAt === undefined) return;
    if (notifiedRef.current === authenticatedAt) return;
    notifiedRef.current = authenticatedAt;
    onAuthenticated?.();
  }, [authenticatedAt, onAuthenticated]);

  // The reserved tab follows the code: when the server answers with one, the
  // tab goes to the authorization page. A tab the browser refused is reported
  // instead, and the assist carries the link.
  useEffect(() => {
    if (phase.kind !== "awaiting") return;
    const tab = reservedTab.current;
    if (!tab) return;
    reservedTab.current = null;
    try {
      tab.location.href = phase.verificationUri;
    } catch {
      setBrowserError(COPY.openBrowserFailed);
    }
  }, [phase]);

  useEffect(() => {
    // beginLogin clears the previous view while its request is in flight.
    // That `undefined` is not a signed-out result: keep the click-reserved tab
    // alive until the request either returns a URL or reports an error.
    if (view === undefined) return;
    if (phase.kind !== "error" && phase.kind !== "signed-out") return;
    // A failed attempt leaves the reserved tab on a blank page.
    const tab = reservedTab.current;
    if (!tab) return;
    reservedTab.current = null;
    tab.close();
  }, [phase, view]);

  const signIn = () => {
    setBrowserError(undefined);
    setCopyState("idle");
    const tab = window.open("", "_blank");
    if (!tab) {
      // The browser refused to open a tab. The attempt still runs, and the
      // assist below carries the link to the page that has to be visited.
      setBrowserError(COPY.openBrowserFailed);
    } else {
      reservedTab.current = tab;
    }
    void workflows?.beginLogin();
  };

  const cancel = () => {
    const tab = reservedTab.current;
    reservedTab.current = null;
    tab?.close();
    void workflows?.cancelLogin();
  };

  const copyLink = async () => {
    if (phase.kind !== "awaiting") return;
    try {
      await navigator.clipboard.writeText(phase.verificationUri);
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
  };

  const links = webuiAccountLegalLinks(scope);
  const portalTarget = dom.portalTarget();
  if (!open || !portalTarget) return null;

  const busy = phase.kind === "opening" || phase.kind === "awaiting";
  const subtitle =
    phase.kind === "opening" || phase.kind === "awaiting"
      ? COPY.waitingSubtitle
      : COPY.subtitle;
  const primaryLabel =
    phase.kind === "opening"
      ? COPY.openingBrowser
      : phase.kind === "awaiting"
        ? COPY.waitingAuthorization
        : COPY.signIn;

  const page = (
    <div
      className="webui-account-login-page"
      data-testid="account-login-page"
      data-webui-account-login-phase={phase.kind}
    >
      <div
        data-testid="desktop-login-hero"
        className="mx-auto flex w-[294px] flex-none flex-col items-center gap-5"
      >
        <img
          src="/assets/img/minimax-octopus-home.png"
          alt=""
          aria-hidden="true"
          className="webui-account-login-logo h-32 w-32"
        />
        <div className="flex w-full flex-col items-center gap-2">
          <h1 className="flex h-8 w-full flex-none items-center justify-center">
            <span className="webui-account-login-wordmark" aria-hidden="true">
              <span>MiniMax</span>
              <span>Code</span>
            </span>
          </h1>
          <p
            className="flex h-[26px] w-full flex-none items-center justify-center whitespace-nowrap text-center text-[16px] leading-[26px] text-text_default_tertiary"
            data-testid="account-login-subtitle"
          >
            {subtitle}
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="h-[100px] min-h-8 shrink" />
      <div className="flex w-full flex-none flex-col items-center px-8">
        {phase.kind === "authenticated" ? (
          <div className="webui-account-login-body">
            <p
              className="text-text_default_tertiary text-center text-sm"
              data-testid="account-login-status"
            >
              {COPY.signedIn}
            </p>
            <div className="webui-account-login-actions">
              <WebuiButton
                variant="grouped"
                size="pill"
                data-testid="account-login-switch"
                onClick={() => {
                  void workflows?.switchAccount();
                }}
              >
                {COPY.switchAccount}
              </WebuiButton>
            </div>
          </div>
        ) : (
          <WebuiButton
            variant="primary"
            size="pill"
            className="webui-account-login-action h-11 w-full max-w-[320px] items-center justify-center"
            data-testid="account-login-sign-in"
            onClick={signIn}
            disabled={busy || view === undefined}
          >
            <span className="webui-account-login-action-label">{primaryLabel}</span>
          </WebuiButton>
        )}
        {busy ? (
          <WebuiButton
            variant="secondary"
            size="pill"
            className="webui-account-login-action mt-3 h-11 w-full max-w-[320px] items-center justify-center"
            data-testid="account-login-cancel"
            onClick={cancel}
          >
            <span className="webui-account-login-action-label">{COPY.cancelLogin}</span>
          </WebuiButton>
        ) : null}
        {phase.kind === "awaiting" ? (
          <div className="mt-4 flex w-full flex-col items-center gap-2 text-center text-xs">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-text_default_tertiary">{COPY.browserNotOpened}</span>
              <WebuiButton
                variant="outline-secondary"
                size="inline"
                className="webui-account-login-assist h-8 items-center gap-1 rounded-full px-3 text-xs"
                data-testid="account-login-copy-link"
                onClick={() => {
                  void copyLink();
                }}
              >
                <IconCopy size={14} className="text-icon_default_secondary" aria-hidden="true" />
                <span>{copyState === "success" ? COPY.linkCopied : COPY.copyLoginLink}</span>
              </WebuiButton>
              {/* The label above changes, and the change is what a reader has
                * to hear. The shared announcement carries it; the button's own
                * label stays a plain label. */}
              {copyState === "success" ? <FeedbackAnnouncement message={COPY.linkCopied} /> : null}
            </div>
            {copyState === "error" ? (
              <FeedbackError
                message={COPY.copyLinkFailed}
                className="webui-account-login-error"
                testId="account-login-copy-error"
              />
            ) : null}
          </div>
        ) : null}
        {phase.kind === "error" ? (
          <FeedbackError
            message={phase.error}
            className="webui-account-login-error"
            testId="account-login-error"
          />
        ) : null}
        {browserError !== undefined ? (
          <FeedbackError
            message={browserError}
            className="webui-account-login-error"
            testId="account-login-browser-error"
          />
        ) : null}
        <div className="mt-[28px] flex h-[28px] w-full max-w-[360px] flex-wrap items-center justify-center gap-x-1 text-center text-[12px] leading-[14px] text-text_default_tertiary">
          <span>{COPY.agreePrefix}</span>
          {links ? (
            <a
              className="text-text_default_secondary"
              href={links.termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="account-login-terms"
            >
              {COPY.termsOfService}
            </a>
          ) : null}
          <span>{COPY.and}</span>
          {links ? (
            <a
              className="text-text_default_secondary"
              href={links.privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="account-login-privacy"
            >
              {COPY.privacyPolicy}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );

  return createPortal(
    <div
      className="webui-account-login-page-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="账号登录"
      data-overlay-layer={layerId}
      data-testid="account-login-page-overlay"
    >
      {page}
    </div>,
    portalTarget,
  );
}
