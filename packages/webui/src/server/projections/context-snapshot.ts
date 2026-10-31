export interface WebuiContextSnapshotResponse {
  readonly status: "loading" | "empty" | "stale" | "live";
  readonly compaction?: {
    readonly state: "never" | "running" | "completed" | "failed";
    readonly lastAt?: number;
  };
  readonly usage?: Record<string, unknown>;
  readonly window?: number;
  readonly usedTokens?: number;
  readonly compactionThresholdTokens?: number;
}

export function projectContextSnapshot(input: {
  readonly messages: readonly { readonly kind?: string; readonly timestamp?: number; readonly rawJson?: string }[];
  readonly active: boolean;
}): WebuiContextSnapshotResponse {
  let compaction: WebuiContextSnapshotResponse["compaction"];
  let usage: Record<string, unknown> | undefined;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    if (!compaction) compaction = projectCompactionMessage(message);
    if (!usage && message.rawJson) usage = readUsage(message.rawJson);
    if (compaction && usage) break;
  }
  if (!usage) return { status: input.active ? "loading" : "empty", ...(compaction ? { compaction } : {}) };
  // The runtime protocol's names, not invented ones. `total_tokens` is what the
  // turn CONSUMED against `context_window`, which is what the readout's
  // percentage is; the wire has no separate "used" field to prefer.
  //
  // BOTH spellings are read, because the two names arrive from two different
  // places and neither one is wrong on its own: the runtime protocol fixes
  // `total_tokens` / `context_window` (`agent-core/src/protocol/agent-message.ts`),
  // and the persisted session message carries the same two numbers under the
  // camelCase names its own view uses (`totalTokens` / `contextWindow`).
  // Reading only the snake_case pair is what made a RELOADED session show no
  // context readout at all: the page answered with a usage record, every
  // field of it under a name this projection did not look at, and the panel
  // had nothing to draw.
  const window = numberValue(usage.context_window) ?? numberValue(usage.contextWindow);
  const usedTokens = numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens);
  return {
    status: input.active ? "stale" : "live",
    // The snapshot publishes the protocol's names whatever the record it was
    // read from spelled them, so the client reads ONE shape and the two
    // spellings cannot drift apart again.
    usage: normalisedUsage(usage, usedTokens, window),
    ...(window === undefined ? {} : { window }),
    ...(usedTokens === undefined ? {} : { usedTokens }),
    compaction: compaction ?? { state: "never" },
  };
}

/**
 * The usage record with the protocol's names spelled out.
 *
 * The record's own fields are kept: the breakdown reads `components` off it,
 * and a record that carried them must not lose them to a rename.
 */
function normalisedUsage(
  usage: Record<string, unknown>,
  usedTokens: number | undefined,
  window: number | undefined,
): Record<string, unknown> {
  return {
    ...usage,
    ...(usedTokens === undefined ? {} : { total_tokens: usedTokens }),
    ...(window === undefined ? {} : { context_window: window }),
  };
}

function projectCompactionMessage(message: { readonly kind?: string; readonly timestamp?: number }) {
  const states = { compaction_start: "running", compaction: "completed", compaction_failed: "failed" } as const;
  const state = message.kind ? states[message.kind as keyof typeof states] : undefined;
  return state ? { state, ...(message.timestamp === undefined ? {} : { lastAt: message.timestamp }) } : undefined;
}

function readUsage(rawJson: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(rawJson);
    if (!isRecord(value)) return undefined;
    // The persisted shape is `usage`, with the field names the runtime
    // protocol fixes: `total_tokens` / `context_window`
    // (`agent-core/src/protocol/agent-message.ts`). Reading `contextUsage` /
    // `context_usage` here instead matched nothing in the database — which is
    // what made the composer's context readout render nowhere at all, with no
    // error to point at it.
    return isRecord(value.usage) ? value.usage : undefined;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

