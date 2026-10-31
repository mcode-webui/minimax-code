// Which phase the account login flow is in.
//
// Carved out of `components/account/AccountLoginDialog.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **2 declarations**, 1 function, 1 type and constant they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

import type { WebuiAccountLoginView } from "../../../../shared/contracts/account.js";

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
