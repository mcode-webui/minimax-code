// Pure value readers used by the projection layer.
//
// These helpers do the dull work of pulling a typed value out of an
// `unknown`: the wire frames, the persisted JSON, and the message bodies all
// hand the client heterogeneous shapes, and centralising the trim/number/
// boolean coercion keeps the projection files focused on shape instead of
// type narrowing. They are deliberately side-effect free so they can live in
// the same dependency layer as the rest of `contracts/` (no React, no I/O).

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The defaulted pair. `recordValue`/`stringValue` answer "is this one?"; these answer with the
 * empty record or string when it is not, which is the reading the settings and provider surfaces
 * want and used to each declare for themselves (a rule shared across businesses gets one owner).
 */
export function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The first of `keys` that holds a non-empty string.
 *
 * The message bodies name the same field differently depending on which
 * producer wrote them (`msg_id` / `msgId` / `id`), so the projection files read
 * a candidate list rather than one key. The rule — first non-empty wins, and an
 * all-blank field counts as absent — was written out in three files under three
 * signatures before this.
 */
export function stringAmongKeys(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

/** The first of `keys` that holds a finite number. */
export function numberAmongKeys(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Project an unknown error into a human-readable string for the user-facing
 * `refusal` field or for the `interactionError` banner. The original code
 * repeated `error instanceof Error ? error.message : String(error)` in 41
 * places; this is the single convergence point so messages stay consistent
 * and unknown errors still produce something readable.
 */
export function formatWebuiError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * A credit balance, formatted with thousands separators, integer rounding and
 * an em dash when the balance is absent.
 *
 * The API reports `7726.2119999999995` and this renders `7,726`. The rounding is the part that matters: a second copy in
 * the settings panel truncated instead, so the same balance read one credit
 * lower there.
 */
export function formatWebuiCredits(value: string | undefined): string {
  if (value === undefined) return "—";
  const numeric = Number(value.replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || value.trim() === "") return value;
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
