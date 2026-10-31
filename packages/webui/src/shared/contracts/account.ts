import type { ClaimSigninData, SigninPanel } from "@mavis/shared/daily-signin";

// The check-in wire types are the shared validators' own types — the same
// `@mavis/shared/daily-signin` module the TUI uses as well (the webui
// panel renders them directly, so there is no second shape to drift).
//
// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiSigninPanelView` | The daily check-in panel (streak, today's status, claimability). | Runtime `getSigninPanel` (`runtime/harness/account.ts`; host `getSigninPanel`, the shared `SigninPanel`). | `client/features/account/contracts/account-port.ts`; `client/features/account/ui/UserMenuSignin.tsx`. |
// | `WebuiClaimSigninView` | The result of claiming today's check-in. | Runtime `claimSignin` (`runtime/harness/account.ts`; host `claimSignin`). | `client/features/account/contracts/account-port.ts`; `client/features/account/ui/UserMenuSignin.tsx`. |
// | `WebuiAccountLoginPromptView` | The device-authorization prompt (code, verification URI, expiry) the login dialog shows. | Runtime `beginAccountLogin` / `getAccountLoginStatus` (`runtime/harness/account.ts`; host OAuth core). | unverified — nested in `WebuiAccountLoginView.prompt`; no direct importer. |
// | `WebuiAccountLoginView` | One answer for both account questions: idle / pending(+prompt) / authenticated / error. | Runtime `beginAccountLogin` / `getAccountLoginStatus`. | `client/features/account/contracts/account-port.ts`; `client/features/account/ui/AccountLoginDialog.tsx`; `server/operation/provider.ts` (response type). |
export type WebuiSigninPanelView = SigninPanel;
export type WebuiClaimSigninView = ClaimSigninData;

/** The device-authorization prompt the browser shows: a code to enter and
 *  the page to enter it on. Same fields the terminal client prints. */
export interface WebuiAccountLoginPromptView {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  /** Unix ms, derived from the prompt's `expiresInSec`; the dialog counts
   *  down against it and offers a fresh code when it passes. */
  readonly expiresAtMs: number;
}

/**
 * One answer for both account questions the browser asks: is a login
 * attempt running (with its prompt), and is the account signed in —
 * `authenticated` covers a login this process started AND one made in the
 * terminal client, because the credential store is shared.
 */
export type WebuiAccountLoginView =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly prompt?: WebuiAccountLoginPromptView }
  | { readonly state: "authenticated" }
  | { readonly state: "error"; readonly error: string };
