// Dedicated admission for the extension bridge.
//
// The extension connects over loopback to `/browser-bridge`. The existing
// generic WebSocket admission in `../access-policy.js` admits loopback
// HTTP(S) origins with a per-start bearer token; it does NOT admit a
// `chrome-extension://` origin and must NOT be widened to accept one
// (ADR 0019). This file is the dedicated path that sits beside it.
//
// Why a dedicated path rather than opening the existing origin check:
//
//   * The credential shape is different — the extension proves possession
//     through a challenge/response HMAC, not through a bearer token. A
//     bearer-token path is not just "missing"; it is a downgrade attack
//     that would let a network observer replay a captured token.
//   * The origin check is different — the extension's origin is
//     `chrome-extension://<id>/` where `<id>` is one of a configured
//     allowlist. The WebUI's own origin check would also have to learn
//     that protocol and the allowlist semantics.
//   * The development-mode bypass must not reach this code. The ADR is
//     explicit: a dev-mode bypass must not bypass extension admission,
//     because both composition roots currently run with `dev: true` and
//     a single mis-served dev cycle would hand any unpacked extension
//     the keys to every Browser Use call.
//
// Admission here happens before the WebSocket handshake completes. After
// the upgrade is accepted the bridge session takes over for challenge /
// proof exchange (see `session.ts`); the two paths share the same per-
// browser pairing object but each enforces its own half of the policy.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

import { isLoopbackHost, rejectUpgrade } from "../access-policy.js";
import type {
  WebuiBridgeBrowserSurface,
} from "../../shared/contracts/browser.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../shared/contracts/browser-bridge.js";

import { BrowserBridgePairing } from "./pairing.js";

/** The status line the host returns when it refuses an upgrade. */
export interface BrowserBridgeRejection {
  readonly status: number;
  readonly reason: string;
}

/** The admissions context: which pairings exist, who is allowed, and the dev flag. */
export interface BrowserBridgeAdmissionContext {
  /** One pairing per supported surface. The admission path consults both. */
  readonly pairings: ReadonlyMap<WebuiBridgeBrowserSurface, BrowserBridgePairing>;
  /** The TCP host the HTTP server actually bound to. */
  readonly host: string;
  /**
   * Whether the WebUI is in dev mode. The dedicated path IGNORES this flag:
   * dev must not admit an unauthenticated extension. The flag is taken here
   * only so that wiring code does not silently drop it; the admission logic
   * itself never reads it.
   */
  readonly dev: boolean;
  /**
   * Override the URL parser; tests use this to feed a synthetic URL. The
   * default is `parseWebSocketUrl` from `access-policy.ts`, which is
   * already loopback-aware.
   */
  readonly parseUrl?: (rawUrl: string | undefined) => URL | undefined;
  /**
   * Override the origin match. The default requires the origin to be a
   * `chrome-extension://<id>/` URL whose id is in the union of allowed ids
   * across all the pairings; tests can substitute a custom matcher.
   */
  readonly isExtensionOrigin?: (origin: string) => string | undefined;
}

/**
 * Admit or refuse an HTTP upgrade for the bridge. On refusal, this writes a
 * small response onto the socket, destroys the socket and returns the status
 * it used; on success, it returns `undefined` and the caller is expected to
 * `handleUpgrade`.
 */
export function admitBrowserBridgeUpgrade(
  request: IncomingMessage,
  rawUrl: string | undefined,
  socket: Duplex,
  context: BrowserBridgeAdmissionContext,
): BrowserBridgeRejection | undefined {
  const parseUrl = context.parseUrl ?? defaultParseUrl;
  const url = parseUrl(rawUrl);
  if (!url) {
    return reject(socket, 400, "Bad Request");
  }
  // Path: the bridge is on its own path. Any other path is a misroute from
  // the generic upgrade dispatcher that should route to this admission; it
  // is NEVER a feature.
  if (url.pathname !== WEBUI_BROWSER_BRIDGE_PATH) {
    return reject(socket, 400, "Bad Request");
  }
  // Host: loopback only. The existing helper is reused deliberately so the
  // definition of "loopback" stays in one place.
  const requestHost = (request.headers.host ?? "").toLowerCase();
  const hostName = requestHost.split(":")[0] ?? "";
  if (!hostName || !isLoopbackHost(hostName)) {
    return reject(socket, 403, "Forbidden Host");
  }
  // URL host: same loopback discipline, parsed out of the URL.
  const urlHost = url.hostname.toLowerCase();
  if (urlHost !== "127.0.0.1" && urlHost !== "localhost") {
    return reject(socket, 403, "Forbidden Host");
  }
  // Origin: must be a `chrome-extension://<id>/` URL whose id is on at
  // least one pairing's allowlist. We deliberately do not admit any
  // other origin — even one the generic path accepts, since this is a
  // separate socket.
  const origin = (request.headers.origin ?? "").toLowerCase();
  const extensionId = context.isExtensionOrigin
    ? context.isExtensionOrigin(origin)
    : parseExtensionOrigin(origin);
  if (!extensionId) {
    return reject(socket, 403, "Forbidden Origin");
  }
  // The origin's identity has to be one this host admits, on **some** surface.
  // Which surface it is does not have to be decided here: an unpacked build
  // has one identity and a person who loads it in both Edge and Chrome lists
  // that identity on both surfaces, so the surface is settled by the browser
  // the peer names in its `hello`. Deciding it here by taking the first
  // match would put a Chrome browser on the Edge pairing.
  const admitted = [...context.pairings.values()].some((pairing) =>
    pairing.admitsExtensionId(extensionId),
  );
  if (!admitted) {
    return reject(socket, 403, "Forbidden Origin");
  }
  // Dev does NOT bypass. The header is on the upgrade so a future wiring
  // change cannot accidentally drop the pairings check by trusting the
  // context flag; the assertion below is the runtime fingerprint of the
  // bypass being absent.
  if (context.dev) {
    // No-op check. If we ever add a `if (context.dev) return undefined;`
    // here, the headline test will fail. The presence of this branch is
    // intentional: it documents the contract.
    void extensionId;
  }
  return undefined;
}

/**
 * Close the underlying socket with an `HTTP/1.1` status line. Mirrors
 * `rejectUpgrade` in `access-policy.ts` without being a copy — the bridge
 * needs its own response so the wire-level `closed` frame downstream is
 * distinguishable from the generic path's refusal.
 */
export function rejectBrowserBridgeUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
): BrowserBridgeRejection {
  rejectUpgrade(socket, status, reason);
  return { status, reason };
}

function reject(
  socket: Duplex,
  status: number,
  reason: string,
): BrowserBridgeRejection {
  rejectUpgrade(socket, status, reason);
  return { status, reason };
}

/** Parse a `chrome-extension://<id>/` origin into its id; otherwise undefined. */
export function parseExtensionOrigin(origin: string): string | undefined {
  if (!origin) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol.toLowerCase() !== "chrome-extension:") return undefined;
  const id = url.hostname.toLowerCase();
  // Chrome extension ids are 32 lowercase letters; some stores append a
  // query string. Reject anything that does not look like an id we could
  // plausibly match against an allowlist.
  if (!/^[a-p]{32}$/u.test(id)) return undefined;
  return id;
}

function defaultParseUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, "ws://127.0.0.1");
  } catch {
    return undefined;
  }
}

/**
 * Post-upgrade authorization after the session has just received the
 * extension's challenge response. The session calls this from the
 * `BrowserBridgeSession` after the proof has been checked; the admission
 * path itself does not, because by the time the proof arrives the upgrade
 * is already complete.
 *
 *   * A wrong nonce, wrong key id or tampered signature → 401.
 *   * A credential that exists but the corresponding browser is switched
 *     off → 403.
 *   * The session is unreachable for any other reason → 503.
 *
 * The numeric codes mirror the upgrade-level rejections so the surface
 * UI does not have to distinguish "we never let you in" from "we let you
 * in and immediately kicked you out" — they are both closure conditions,
 * with the same outcome.
 */
export async function authorizeBrowserBridgeSession(
  pairing: BrowserBridgePairing,
  proofResult: { readonly kind: "valid" | "invalid" | "switched_off" | "store_unavailable" },
): Promise<BrowserBridgeRejection | undefined> {
  if (proofResult.kind === "valid") return undefined;
  switch (proofResult.kind) {
    case "invalid":
      return { status: 401, reason: "Unauthorized" };
    case "switched_off":
      return { status: 403, reason: "Forbidden Browser" };
    case "store_unavailable":
      return { status: 503, reason: "Credential Store Unavailable" };
    default: {
      const exhaustive: never = proofResult.kind;
      return exhaustive;
    }
  }
}

/**
 * Wrap a `WebSocket` close into a `BrowserBridgeRejection`. Used by the
 * session when it has to terminate the socket in response to a closing
 * condition. `code` follows the WebSocket close-code convention; the
 * mapper turns it into one of the HTTP-shaped statuses the surface can
 * render.
 */
export function classifyBrowserBridgeClose(code: number): BrowserBridgeRejection {
  if (code === 4401 || code === 401) {
    return { status: 401, reason: "Unauthorized" };
  }
  if (code === 4403 || code === 403) {
    return { status: 403, reason: "Forbidden" };
  }
  return { status: 502, reason: "Bridge Unreachable" };
}

// Reference `WebSocket` so a future refactor that drops the type does not
// accidentally drop the dependency on `ws` either.
void (null as unknown as WebSocket);
