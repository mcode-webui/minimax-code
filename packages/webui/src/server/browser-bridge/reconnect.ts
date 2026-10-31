// Reconnect policy for the extension bridge.
//
// The ADR pins two schedules. The first is the **operation deadline** — when an
// in-flight command is racing against a disappearing socket, retry with a fixed
// exponential backoff (250ms, 500ms, 1s, 2s, 4s, capped at 5s, with jitter)
// for at most 15 seconds. When that deadline expires, fail the operation
// explicitly and *do not* replay it: execution is uncertain and silent replay
// is exactly the failure mode the ADR forbids.
//
// The second is **background reconnect** — when the bridge is silent but the
// browser's switch remains on, keep trying to reconnect with exponential
// backoff capped at 30 seconds, until the extension returns or the user turns
// the switch off. The schedule itself is the same shape as the operation
// schedule: doubling with a cap, plus a jitter to spread reconnects when many
// servers come up at once.

/** The delay steps the operation deadline retries through, in milliseconds. */
export const WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/** The cap on any single retry delay during the operation deadline. */
export const WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS = 5_000;

/** The total time an in-flight operation may spend retrying the bridge. */
export const WEBUI_BRIDGE_OPERATION_RECONNECT_TOTAL_MS = 15_000;

/** The cap on any single delay between background reconnect attempts. */
export const WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS = 30_000;

/** The factor applied as full jitter (0..1 of the computed delay). */
const JITTER_FRACTION = 0.2;

/**
 * The delay, in milliseconds, before the next retry during an in-flight
 * operation. `attempt` is the zero-based retry index: `0` returns the first
 * step, `1` the second, and so on. Beyond the table the delay is the cap.
 *
 * A small random jitter is added (or subtracted) so a fleet of bridges coming
 * back online together do not hammer the host in lockstep. The result is
 * never negative and never below the smallest step in the table.
 */
export function bridgeOperationReconnectDelayMs(attempt: number): number {
  if (attempt < 0) attempt = 0;
  const base = attempt < WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS.length
    ? WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS[attempt]!
    : WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS;
  return applyJitter(base, base);
}

/**
 * The delay, in milliseconds, between background reconnect attempts when the
 * extension is silent but the browser switch is on. Each attempt doubles the
 * prior delay up to {@link WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS}.
 */
export function bridgeBackgroundReconnectDelayMs(attempt: number): number {
  if (attempt < 0) attempt = 0;
  const base = Math.min(
    Math.max(WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS[0]!, 250) * Math.pow(2, attempt),
    WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS,
  );
  return applyJitter(base, WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS);
}

/**
 * Apply full jitter to a delay: the result is `base ± fraction * base`. Clamped
 * to `[lowerBound, cap]` so the delay never goes below the table's smallest
 * step nor above the cap.
 */
function applyJitter(base: number, cap: number): number {
  const lowerBound = WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS[0]!;
  const jitter = base * JITTER_FRACTION;
  const offset = (Math.random() * 2 - 1) * jitter;
  const delayed = Math.round(base + offset);
  if (delayed < lowerBound) return lowerBound;
  if (delayed > cap) return cap;
  return delayed;
}

export interface BridgeOperationRetryOptions {
  /** Total wall-clock budget; retries cease when this elapses. */
  readonly deadlineMs: number;
  /** Whether the operation has been cancelled by the caller. */
  readonly isCancelled?: () => boolean;
  /** Sleep function; tests inject a deterministic sleeper. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Returns the current wall-clock in milliseconds. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run an operation against the bridge with bounded retry. The provided
 * `attempt` receives the zero-based attempt index; it must resolve on
 * success and reject on a transient failure. On a terminal failure (e.g. the
 * extension explicitly refused this command) it should resolve with a
 * marker rather than retrying.
 *
 * The wrapper does not invent retries when the caller says the error is
 * terminal; it gives up immediately and lets the caller decide what to do.
 */
export async function withBridgeOperationRetry<T>(
  attempt: (index: number) => Promise<BridgeOperationAttempt<T>>,
  options: BridgeOperationRetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const start = now();
  let index = 0;
  // First try: no delay. A fresh connection should not pay a 250ms tax.
  while (true) {
    if (options.isCancelled?.()) {
      throw new BridgeOperationError("cancelled", "operation cancelled by caller");
    }
    const elapsed = now() - start;
    if (elapsed >= options.deadlineMs && index > 0) {
      throw new BridgeOperationError(
        "timeout",
        `bridge operation deadline ${options.deadlineMs}ms exceeded`,
      );
    }
    const result = await attempt(index);
    if (result.kind === "success") return result.value;
    if (result.kind === "terminal") throw new BridgeOperationError(result.reason, result.message);
    // kind === "transient" — loop to next attempt.
    const remaining = options.deadlineMs - (now() - start);
    if (remaining <= 0) {
      throw new BridgeOperationError(
        "timeout",
        `bridge operation deadline ${options.deadlineMs}ms exceeded`,
      );
    }
    const delay = Math.min(bridgeOperationReconnectDelayMs(index), remaining);
    await sleep(delay);
    index += 1;
  }
}

/** One attempt's outcome. */
export type BridgeOperationAttempt<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "transient"; readonly message: string }
  | { readonly kind: "terminal"; readonly reason: "refused" | "cancelled" | "unknown"; readonly message: string };

/** The error {@link withBridgeOperationRetry} throws when retry is exhausted or cancelled. */
export class BridgeOperationError extends Error {
  constructor(
    public readonly kind: "timeout" | "refused" | "cancelled" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "BridgeOperationError";
  }
}
