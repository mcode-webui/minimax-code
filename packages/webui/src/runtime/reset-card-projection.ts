// The pure half of the account-billing client: reset-card payloads in, views out.
//
// Split from `runtime/usage-quota.ts` for the same reason the quota projection
// was: field picking over untrusted JSON is the part that can be reasoned
// about without a clock, a fetch or a credential.
//
// The field names come from the Desktop renderer bundle, which is the
// behavioural authority for this surface:
//
// - card: `card_id`, `source_type`, `out_biz_no`, `create_time`, `expire_time`
// - card name: `card_name` | `name` | `title`, or the same keys inside a JSON
//   `extra` string
// - flow: `card_id`, `event_type` (`GRANT` | `USE`), `create_time`, `source_type`
// - credit fallback: `token_plan_credit_fallback_enabled`

import type {
  WebuiCreditFallbackView,
  WebuiResetCardFlowView,
  WebuiResetCardListResult,
  WebuiResetCardOutcome,
  WebuiResetCardUseResult,
  WebuiResetCardView,
} from "../shared/contracts/account-billing.js";
import { asRecord, finiteNumber, readString } from "./usage-quota-projection.js";

/** The name keys a card (or a flow) may carry, in the Desktop's order. */
const NAME_KEYS = ["card_name", "name", "title"] as const;

/** Reads the card list body: `{ cards, total }`. */
export function projectResetCardList(
  body: Record<string, unknown>,
): WebuiResetCardListResult {
  const cards = readArray(body, "cards") ?? [];
  const total = finiteNumber(body.total) ?? finiteNumber(asRecord(body.data)?.total) ?? cards.length;
  return {
    cards: cards
      .map((value) => projectResetCard(asRecord(value)))
      .filter((card): card is WebuiResetCardView => card !== undefined),
    total: Math.max(0, total),
  };
}

/** Reads one card. Cards without an identity are dropped, like the Desktop's. */
export function projectResetCard(
  raw: Record<string, unknown> | undefined,
): WebuiResetCardView | undefined {
  if (!raw) return undefined;
  const cardId = readString(raw, undefined, "card_id");
  if (!cardId) return undefined;
  const name = readCardName(raw);
  const quotaType =
    readString(raw, undefined, "quota_type") ??
    readString(raw, undefined, "type") ??
    readString(raw, undefined, "limit_type");
  const sourceType = readString(raw, undefined, "source_type");
  const outBizNo = readString(raw, undefined, "out_biz_no");
  const createTimeMs = normalizeEpochMs(finiteNumber(raw.create_time));
  const expireTimeMs = normalizeEpochMs(finiteNumber(raw.expire_time));
  return {
    cardId,
    ...(name ? { name } : {}),
    ...(quotaType ? { quotaType } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(outBizNo ? { outBizNo } : {}),
    ...(createTimeMs !== undefined ? { createTimeMs } : {}),
    ...(expireTimeMs !== undefined ? { expireTimeMs } : {}),
  };
}

/** Reads the flow page body: `{ flows }`. */
export function projectResetCardFlows(
  body: Record<string, unknown>,
): readonly WebuiResetCardFlowView[] {
  const flows = readArray(body, "flows") ?? [];
  return flows
    .map((value) => projectResetCardFlow(asRecord(value)))
    .filter((flow): flow is WebuiResetCardFlowView => flow !== undefined);
}

/** Reads one flow record. */
export function projectResetCardFlow(
  raw: Record<string, unknown> | undefined,
): WebuiResetCardFlowView | undefined {
  if (!raw) return undefined;
  const cardId = readString(raw, undefined, "card_id");
  const eventType = readString(raw, undefined, "event_type");
  if (!cardId && !eventType) return undefined;
  const name = readCardName(raw);
  const createTimeMs = normalizeEpochMs(finiteNumber(raw.create_time));
  const sourceType = readString(raw, undefined, "source_type");
  return {
    cardId: cardId ?? "",
    eventType: eventType ?? "",
    ...(name ? { name } : {}),
    ...(createTimeMs !== undefined ? { createTimeMs } : {}),
    ...(sourceType ? { sourceType } : {}),
  };
}

/**
 * Reads the credit-fallback flag. The Desktop keeps `null` for "not resolved"
 * and a boolean for a verdict, so the view carries both.
 */
export function projectCreditFallback(
  body: Record<string, unknown>,
): WebuiCreditFallbackView {
  const value =
    body.token_plan_credit_fallback_enabled ??
    asRecord(body.data)?.token_plan_credit_fallback_enabled;
  return typeof value === "boolean" ? { enabled: value, resolved: true } : { resolved: false };
}

/** Reads the redemption answer: `{ outcome }`. */
export function projectResetCardUse(
  body: Record<string, unknown>,
): WebuiResetCardUseResult {
  const outcome =
    readString(body, undefined, "outcome") ??
    readString(asRecord(body.data), undefined, "outcome");
  return { outcome: toOutcome(outcome) };
}

/**
 * The redemption outcome enum. An unrecognised value is `UNKNOWN` rather than
 * a failure: the Desktop treats "cannot tell" as its own phase and offers the
 * user a retry instead of declaring the card spent.
 */
export function toOutcome(value: string | undefined): WebuiResetCardOutcome {
  switch (value) {
    case "SUCCESS":
    case "REPLAYED":
    case "EXPIRED":
    case "NOT_FOUND":
    case "RETRYABLE_FAIL":
    case "LOCK_BUSY":
      return value;
    default:
      return "UNKNOWN";
  }
}

/**
 * The card identity the Desktop uses to tell two cards apart: the
 * `(source_type, out_biz_no)` pair, not the card id — the same grant can be
 * re-issued under a new card id.
 */
export function resetCardIdentity(card: {
  readonly sourceType?: string;
  readonly outBizNo?: string;
}): string {
  return JSON.stringify([card.sourceType ?? "", card.outBizNo ?? ""]);
}

/** The flow identity the Desktop uses to merge pages without duplicates. */
export function resetCardFlowIdentity(flow: {
  readonly cardId: string;
  readonly eventType: string;
  readonly createTimeMs?: number;
  readonly sourceType?: string;
}): string {
  return JSON.stringify([
    flow.cardId,
    flow.eventType,
    flow.createTimeMs ?? "",
    flow.sourceType ?? "",
  ]);
}

function readCardName(raw: Record<string, unknown>): string | undefined {
  const direct = readFirstName(raw);
  if (direct) return direct;
  const extra = raw.extra;
  if (typeof extra !== "string" || !extra.trim()) return undefined;
  try {
    const parsed = asRecord(JSON.parse(extra));
    return parsed ? readFirstName(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function readFirstName(raw: Record<string, unknown>): string | undefined {
  for (const key of NAME_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Reads a list field. The account API answers these endpoints with the list at
 * the top level; a `data`-wrapped body is accepted as a fallback.
 */
function readArray(body: Record<string, unknown>, key: string): unknown[] | undefined {
  if (Array.isArray(body[key])) return body[key];
  const nested = asRecord(body.data)?.[key];
  return Array.isArray(nested) ? nested : undefined;
}

function normalizeEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  return value < 1e12 ? value * 1_000 : value;
}
