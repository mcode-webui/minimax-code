// Per-start credential generation and validation.
//
// Each service instance generates a fresh token when it starts; a browser
// must present that exact token in the WebSocket URL or the connection is
// refused. The token is opaque to the rest of the service: the goal is to
// stop a neighbouring browser on the same loopback interface from riding
// the connection.
//
// We use Node's `randomUUID` so the token inherits the platform CSPRNG;
// comparing uses a constant-time equality to keep the validation timing
// even whether the guess is right or wrong.

import { randomUUID, timingSafeEqual } from "node:crypto";

export interface WebuiCredential {
  readonly token: string;
}

/**
 * The cookie that carries the per-start credential.
 *
 * The query parameter is the credential's first channel, and it cannot reach
 * the page's own relative requests: a browser that opened
 * `/?token=…` asks for `./client.js` and `./styles.css` without the
 * query, so a page served on a non-loopback interface would load with no
 * script and no styles. The cookie is what those requests carry.
 */
export const WEBUI_CREDENTIAL_COOKIE = "webui_credential";

export function createWebuiCredential(): WebuiCredential {
  return { token: randomUUID() };
}

/**
 * The `Set-Cookie` value that carries the credential.
 *
 * `SameSite=Strict` keeps the cookie away from a request another site
 * made, so the credential is not a cross-site one; `HttpOnly` keeps it out
 * of the page's own script.
 */
export function credentialCookie(token: string): string {
  return `${WEBUI_CREDENTIAL_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/**
 * What a request's cookies say about the credential.
 *
 * Three answers rather than a `string | undefined`, because "no cookie" and
 * "a cookie I cannot decode" are different facts and both callers (HTTP
 * dispatch and the WebSocket upgrade) have to refuse without the parser
 * escaping into them. A cookie header is untrusted input: `decodeURIComponent`
 * throws a `URIError` on `webui_credential=%` or on a truncated UTF-8 escape,
 * and an escaping parser would turn a malformed request into an exception
 * raised from a synchronous upgrade listener or an unawaited promise instead
 * of the 401 the request earns.
 */
export type WebuiCookieCredential =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "presented"; readonly token: string };

/**
 * The credential a request presented in its cookies, if any.
 *
 * Every occurrence of the cookie is considered and the first one that decodes
 * wins: a request may carry more than one cookie of that name — two paths, an
 * earlier and a later start — and a decodable value is a fact about the
 * credential, not noise. When none decodes, the answer is `invalid` rather than
 * `absent`, so a caller can say "your cookie is malformed" instead of claiming
 * nothing was presented.
 */
export function credentialFromCookie(header: string | undefined, cookieName = WEBUI_CREDENTIAL_COOKIE): WebuiCookieCredential {
  if (!header) return { kind: "absent" };
  let malformed = false;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    const token = decodeCookieValue(part.slice(separator + 1).trim());
    if (token !== undefined) return { kind: "presented", token };
    malformed = true;
  }
  return malformed
    ? { kind: "invalid", reason: "the credential cookie is not valid percent-encoded text" }
    : { kind: "absent" };
}

/**
 * One cookie value, decoded, or `undefined` when it is not decodable.
 *
 * The failure is caught here, at the parse, and not at the caller: the cookie
 * is the part of the request an untrusted client chooses, and a parser that
 * throws makes every admission path carry a `try` it does not own.
 */
function decodeCookieValue(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Whether a request presented the credential, in the query or in the cookie.
 */
export function credentialPresented(
  credential: WebuiCredential,
  queryToken: unknown,
  cookieHeader: string | undefined,
): boolean {
  if (credentialMatches(credential, queryToken)) return true;
  const cookie = credentialFromCookie(cookieHeader);
  return cookie.kind === "presented" && credentialMatches(credential, cookie.token);
}

/**
 * Constant-time comparison of two opaque tokens. Returns false when either
 * side is not a string or when their lengths differ. The service refuses
 * the connection in either branch.
 */
export function credentialMatches(
  expected: WebuiCredential,
  presented: unknown,
): boolean {
  if (typeof presented !== "string") return false;
  const expectedBytes = Buffer.from(expected.token, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}
