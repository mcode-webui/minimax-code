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

export function createWebuiCredential(): WebuiCredential {
  return { token: randomUUID() };
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