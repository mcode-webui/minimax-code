/**
 * The `yy` / `x-timestamp` / `x-signature` triple the first-party MiniMax
 * endpoints expect.
 *
 * These are wire-protocol constants, not credentials: they tag a request as a
 * first-party client, and authorization is the `Authorization: Bearer` header.
 * The inline salt is shared across every first-party client, so changing it
 * requires a coordinated server-side rollout.
 *
 * The triple was built inline in three places — the matrix quota POST, the
 * matrix account-identity GET and the daily check-in request — with the salt
 * copied out three times and `md5` declared privately in two files. The three
 * call sites agree on the rule; what differs is only the body they sign, and
 * `body` covers all three: a JSON payload, nothing at all, or a body the
 * check-in route already reduced.
 */
import { createHash } from "node:crypto";

/** The `x-signature` salt every first-party client sends. */
const FIRST_PARTY_SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

export function md5Hex(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/**
 * Sign one request.
 *
 * `body` is the exact string sent as the request body, and its absence is
 * signed as `""` — except in `yy`, which signs the literal `{}` a bodyless
 * request still carries server-side. That asymmetry is the protocol's, not a
 * choice here, and it is why the two derived values take the same input.
 */
export function webuiFirstPartySignatureHeaders(input: {
  readonly pathWithSearch: string;
  readonly nowMs: number;
  readonly body?: string;
}): {
  readonly yy: string;
  readonly "x-timestamp": string;
  readonly "x-signature": string;
} {
  const body = input.body ?? "";
  const yyBody = input.body ?? "{}";
  const second = Math.floor(input.nowMs / 1_000);
  return {
    yy: md5Hex(
      `${encodeURIComponent(input.pathWithSearch)}_${yyBody}${md5Hex(String(input.nowMs))}ooui`,
    ),
    "x-timestamp": String(second),
    "x-signature": md5Hex(`${second}${FIRST_PARTY_SIGNATURE_SALT}${body}`),
  };
}
