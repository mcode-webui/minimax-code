// Which phase the account login page is in.
//
// The Desktop's login page is a state machine of its own: signed out, opening
// the browser, waiting for the authorization, failed. This module derives
// those states from the server's answer so the page renders a phase rather
// than reading the answer's shape.
//
// It is a separate derivation from `login-phase.ts` on purpose. The compact
// sign-in dialog and the page are two different surfaces over one answer: the
// dialog opens a flow the moment it appears, so "idle" is a state it passes
// through and never rests in, while the page waits for the user to ask for a
// sign-in — so "idle" is the page's own resting state, and it means the
// account is signed out.

import type { WebuiAccountLoginView } from "../../../../shared/contracts/account.js";

/** Everything the login page can show, derived (not fetched). */
export type WebuiAccountLoginPagePhase =
  /** Nobody is signed in; the page offers the sign-in. */
  | { readonly kind: "signed-out" }
  /** A device flow is running and the code has not arrived yet. */
  | { readonly kind: "opening" }
  /** A device code is waiting; the authorization page can be opened. */
  | {
      readonly kind: "awaiting";
      readonly verificationUri: string;
    }
  /** The account is signed in. */
  | { readonly kind: "authenticated" }
  /** The attempt failed. */
  | { readonly kind: "error"; readonly error: string };

/**
 * Derive the page's phase from the server's answer.
 *
 * `undefined` means the answer has not arrived yet. It reads as "signed out"
 * because that is the state the page rests in, and the page disables its call
 * to action until the answer lands — a page that offered a sign-in before it
 * knew whether one was needed would offer a second sign-in to somebody who is
 * already signed in.
 */
export function deriveWebuiAccountLoginPagePhase(
  view: WebuiAccountLoginView | undefined,
): WebuiAccountLoginPagePhase {
  if (!view) return { kind: "signed-out" };
  switch (view.state) {
    case "authenticated":
      return { kind: "authenticated" };
    case "error":
      return { kind: "error", error: view.error };
    case "pending": {
      // The complete URL carries the code, so it is the one to open; the bare
      // verification URL asks for the code to be typed in.
      const uri = view.prompt?.verificationUriComplete ?? view.prompt?.verificationUri;
      return uri ? { kind: "awaiting", verificationUri: uri } : { kind: "opening" };
    }
    default:
      return { kind: "signed-out" };
  }
}
