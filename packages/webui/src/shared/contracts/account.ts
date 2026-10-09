import type { ClaimSigninData, SigninPanel } from "@mavis/shared/daily-signin";

// The check-in wire types are the shared validators' own types — the same
// `@mavis/shared/daily-signin` module the TUI and the desktop use (the webui
// panel renders them directly, so there is no second shape to drift).
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
