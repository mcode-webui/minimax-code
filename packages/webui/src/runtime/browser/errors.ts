// The browser runtime's failure type.
//
// The browser paths fail for reasons the client and the Agent's tools must be
// able to tell apart: the surface is switched off, the target moved on, the
// command was malformed, the provider could not be reached, the operation ran
// out of time, the pairing was refused. A single generic failure would make a
// caller retry the wrong thing — retrying a stale target is pointless, and
// retrying a malformed command is worse than pointless.
//
// The code travels on the wire unchanged, so the vocabulary stays in the
// shared contract module rather than here.

import type { WebuiBrowserError, WebuiBrowserErrorCode } from "../../shared/contracts/browser.js";

/**
 * A browser operation that failed with a code the caller can act on.
 *
 * `retryable` is part of the error rather than derived by the caller: only the
 * path that failed knows whether the failure was transient.
 */
export class WebuiBrowserOperationError extends Error {
  readonly code: WebuiBrowserErrorCode;
  readonly retryable: boolean;

  constructor(error: WebuiBrowserError) {
    super(error.message);
    this.name = "WebuiBrowserOperationError";
    this.code = error.code;
    this.retryable = error.retryable;
  }

  toBrowserError(): WebuiBrowserError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Builds the error for a code, with the retryability that code implies. */
export function browserOperationError(
  code: WebuiBrowserErrorCode,
  message: string,
  retryable = false,
): WebuiBrowserOperationError {
  return new WebuiBrowserOperationError({ code, message, retryable });
}
