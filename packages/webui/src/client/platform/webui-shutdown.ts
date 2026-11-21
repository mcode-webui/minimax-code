// Asking the local WebUI server to stop.
//
// Responsibility: this is **browser infrastructure IO**. It posts the request
// the shutdown route answers and reports what the server said; it decides
// nothing about the user's intent -- the confirmation that precedes it lives
// with the menu that offers it.
//
// The origin and the token are the ones the transfer routes use: both are
// served by the same listener the socket was opened against, so the answer is
// read from the injected runtime config rather than restated here.

import { readWebuiSessionTransferTarget } from "./session-transfer-target.js";

export interface WebuiShutdownOptions {
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly origin?: string;
  readonly token?: string;
}

export type WebuiShutdownReceipt =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "not-connected" }
  | { readonly kind: "unknown" };

// This bounds how long the confirmation stays busy, not how long the
// server may take to stop. Aborting cannot revoke an already sent request.
const SHUTDOWN_RECEIPT_TIMEOUT_MS = 5_000;

export async function requestWebuiShutdown(
  options: WebuiShutdownOptions = {},
): Promise<WebuiShutdownReceipt> {
  // Presence is checked, not truthiness: an injected empty token is a valid
  // dev target, and falling back to the global for it would silently ignore
  // the caller's origin.
  const target =
    options.origin !== undefined && options.token !== undefined
      ? { origin: options.origin, token: options.token }
      : readWebuiSessionTransferTarget();
  if (!target) return { kind: "not-connected" };

  const query = new URLSearchParams({ token: target.token });
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(
      `${target.origin}/webui-shutdown?${query.toString()}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(SHUTDOWN_RECEIPT_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      // A gateway failure or timeout can happen after the origin received
      // the POST. Only an explicit client rejection is definitive.
      return response.status >= 400 && response.status < 500 && response.status !== 408
        ? { kind: "refused", status: response.status }
        : { kind: "unknown" };
    }

    // A proxy or stale page can answer 200 without accepting the request.
    // The host's receipt also does not claim the process has stopped yet.
    const body: unknown = await response.json();
    if (
      typeof body === "object" && body !== null &&
      "ok" in body && body.ok === true &&
      "closing" in body && body.closing === true
    ) {
      return { kind: "accepted" };
    }
  } catch {
    // A network failure, timeout or unreadable reply proves neither that
    // the request was rejected nor that the service stopped. No auto-retry.
  }
  return { kind: "unknown" };
}
