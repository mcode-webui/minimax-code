// The 用量与模型 page's account-billing surface: the plan name, the credit
// fallback switch and the reset cards.
//
// The Desktop is the behavioural authority for all three. The three facts
// this suite pins down are the ones that were wrong before the port:
//
//  1. the plan name is the account's, not a constant — an M Plan account must
//     not read as a Token Plan account, and only the legacy `token_plan`
//     subscription kind still carries the legacy name;
//  2. the credit fallback is a real read/write pair, not a disabled switch;
//  3. the reset cards are a real list / redeem / history triple, and the
//     redemption answer is a phase rather than a boolean.
//
// The response fixtures are shaped after the Desktop's account client:
// `token_plan_credit` answers with `token_plan_credit_fallback_enabled`, the
// card list answers with `{ cards, total }`, the redemption answers with an
// `outcome`, and the history answers with `{ flows }`.

import { describe, expect, it } from "vitest";

import {
  projectCreditFallback,
  projectResetCardFlows,
  projectResetCardList,
  projectResetCardUse,
  resetCardFlowIdentity,
  resetCardIdentity,
} from "../../src/runtime/reset-card-projection.js";
import {
  formatPlanName,
  formatPlanSourceLabel,
  formatPlanTier,
  hasWebuiPlan,
  WEBUI_FREE_PLAN_NAME,
  WEBUI_PLAN_NAME,
} from "../../src/client/features/settings/projection/usage-plan.js";
import {
  formatResetCardExpiry,
  formatResetCardFlowLabel,
  formatResetCardName,
  formatResetCardStatus,
} from "../../src/client/features/settings/ui/UsageResetCards.js";
import {
  createWebuiAccountWorkflows,
  type WebuiAccountPortSlice,
} from "../../src/client/features/account/application/account-workflows.js";
import {
  getCreditFallbackOperation,
  listResetCardsOperation,
  queryResetCardFlowsOperation,
  setCreditFallbackOperation,
  useResetCardOperation,
} from "../../src/server/operation/account.js";

describe("the plan name is the account's, not a constant", () => {
  it("shows the tier of a subscribed account", () => {
    expect(formatPlanName({ hasTokenPlan: true, tokenPlanTier: "M Plan" })).toBe("M Plan");
    expect(formatPlanName({ hasTokenPlan: true, tokenPlanTier: "Pro" })).toBe("Pro");
  });

  it("falls back to the generic plan name when the tier is a combo id", () => {
    // A numeric tier is a combo id the Desktop resolves through the
    // subscription catalogue; without that catalogue the generic name is the
    // answer, not the raw number.
    expect(formatPlanTier("101004")).toBeUndefined();
    expect(formatPlanName({ hasTokenPlan: true, tokenPlanTier: "101004" })).toBe(WEBUI_PLAN_NAME);
  });

  it("counts a tier without a plan flag as subscribed, the way the Desktop does", () => {
    expect(hasWebuiPlan({ hasTokenPlan: false, tokenPlanTier: "M Plan" })).toBe(true);
    expect(hasWebuiPlan({ hasTokenPlan: false })).toBe(false);
    expect(formatPlanName({ hasTokenPlan: false, tokenPlanTier: "M Plan" })).toBe("M Plan");
  });

  it("shows the account's plan name when the account has no plan", () => {
    expect(formatPlanName({ hasTokenPlan: false, planName: "免费版" })).toBe("免费版");
    expect(formatPlanName({ hasTokenPlan: false })).toBe(WEBUI_FREE_PLAN_NAME);
  });

  it("names the model source by the subscription kind", () => {
    // The legacy subscription still reads "Token Plan"; every other kind —
    // including an account whose kind the API did not report — reads
    // "M Plan".
    expect(formatPlanSourceLabel("token_plan")).toBe("Token Plan");
    expect(formatPlanSourceLabel("mplan")).toBe("M Plan");
    expect(formatPlanSourceLabel("agent_plan")).toBe("M Plan");
    expect(formatPlanSourceLabel(undefined)).toBe("M Plan");
  });
});

describe("the credit fallback projection", () => {
  it("reads the account's verdict", () => {
    expect(projectCreditFallback({ token_plan_credit_fallback_enabled: true })).toEqual({
      enabled: true,
      resolved: true,
    });
    expect(projectCreditFallback({ token_plan_credit_fallback_enabled: false })).toEqual({
      enabled: false,
      resolved: true,
    });
  });

  it("reports an unanswered read as unresolved rather than as off", () => {
    expect(projectCreditFallback({})).toEqual({ resolved: false });
  });
});

describe("the reset-card projection", () => {
  it("reads the card list and its total", () => {
    const result = projectResetCardList({
      cards: [
        {
          card_id: "card-1",
          source_type: "FIVE_HOUR",
          out_biz_no: "biz-1",
          card_name: "5 小时限额",
          create_time: 1_790_000_000_000,
          expire_time: 1_790_003_600_000,
        },
      ],
      total: 1,
    });
    expect(result.total).toBe(1);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      cardId: "card-1",
      name: "5 小时限额",
      sourceType: "FIVE_HOUR",
      outBizNo: "biz-1",
      createTimeMs: 1_790_000_000_000,
      expireTimeMs: 1_790_003_600_000,
    });
  });

  it("reads a card name out of the extra payload", () => {
    const result = projectResetCardList({
      cards: [{ card_id: "card-2", extra: JSON.stringify({ name: "周限额" }) }],
      total: 1,
    });
    expect(result.cards[0]?.name).toBe("周限额");
  });

  it("drops a card without an identity", () => {
    expect(projectResetCardList({ cards: [{ name: "无 id" }], total: 1 }).cards).toEqual([]);
  });

  it("reads the history and keeps the grant/use event", () => {
    const flows = projectResetCardFlows({
      flows: [
        { card_id: "card-1", event_type: "GRANT", create_time: 1_790_000_000_000 },
        { card_id: "card-1", event_type: "USE", create_time: 1_790_000_060_000 },
      ],
    });
    expect(flows.map((flow) => flow.eventType)).toEqual(["GRANT", "USE"]);
  });

  it("reads the redemption outcome and keeps an unknown one unknown", () => {
    expect(projectResetCardUse({ outcome: "SUCCESS" })).toEqual({ outcome: "SUCCESS" });
    expect(projectResetCardUse({ outcome: "LOCK_BUSY" })).toEqual({ outcome: "LOCK_BUSY" });
    expect(projectResetCardUse({ outcome: "SOMETHING_NEW" })).toEqual({ outcome: "UNKNOWN" });
    expect(projectResetCardUse({})).toEqual({ outcome: "UNKNOWN" });
  });

  it("identifies a card by its grant pair, not by its id", () => {
    expect(resetCardIdentity({ sourceType: "FIVE_HOUR", outBizNo: "biz-1" })).toBe(
      JSON.stringify(["FIVE_HOUR", "biz-1"]),
    );
    expect(resetCardFlowIdentity({
      cardId: "card-1",
      eventType: "GRANT",
      createTimeMs: 5,
      sourceType: "FIVE_HOUR",
    })).toBe(JSON.stringify(["card-1", "GRANT", 5, "FIVE_HOUR"]));
  });
});

describe("the reset-card wording", () => {
  it("names a card, falling back to the generic name", () => {
    expect(formatResetCardName({ cardId: "c", name: "周限额" })).toBe("周限额");
    expect(formatResetCardName({ cardId: "c" })).toBe("完全重置");
  });

  it("renders the expiry and the history rows", () => {
    expect(formatResetCardExpiry({ cardId: "c", expireTimeMs: Date.UTC(2026, 9, 20) })).toBe(
      "2026.10.20 到期",
    );
    expect(formatResetCardExpiry({ cardId: "c" })).toBeUndefined();
    expect(formatResetCardFlowLabel({ eventType: "GRANT", name: "完全重置" })).toBe("获得 完全重置");
    expect(formatResetCardFlowLabel({ eventType: "USE", name: "完全重置" })).toBe("使用 完全重置");
  });

  it("gives every redemption phase a status line", () => {
    expect(formatResetCardStatus("idle")).toBeUndefined();
    for (const phase of [
      "using",
      "refreshing",
      "success",
      "replayed",
      "unavailable",
      "offline",
      "retryable",
      "busy",
      "unknown",
      "refresh_failed",
    ] as const) {
      expect(formatResetCardStatus(phase), phase).toBeTruthy();
    }
  });
});

describe("the account owner's credit-fallback commands", () => {
  it("reads the switch and adopts the account's verdict", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        getCreditFallback: async () => ({ enabled: true, resolved: true }),
        setCreditFallback: async () => ({ enabled: false, resolved: true }),
      } as unknown as WebuiAccountPortSlice,
    });
    await workflows.loadCreditFallback();
    expect(workflows.getSnapshot().creditFallback).toMatchObject({
      status: "ready",
      enabled: true,
      resolved: true,
    });
    await workflows.setCreditFallback(false);
    expect(workflows.getSnapshot().creditFallback).toMatchObject({
      enabled: false,
      resolved: true,
    });
  });

  it("keeps the switch unresolved when the read fails", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        getCreditFallback: async () => {
          throw new Error("boom");
        },
      } as unknown as WebuiAccountPortSlice,
    });
    await workflows.loadCreditFallback();
    const state = workflows.getSnapshot().creditFallback;
    expect(state.status).toBe("error");
    expect(state.enabled).toBeUndefined();
    expect(state.resolved).toBe(false);
  });
});

describe("the account owner's reset-card commands", () => {
  const card = {
    cardId: "card-1",
    sourceType: "FIVE_HOUR",
    outBizNo: "biz-1",
    name: "5 小时限额",
  };
  /**
   * A subscribed account. The redemption refresh reads the quota, the cards and
   * the history together, and only a refresh where all three succeeded keeps
   * the redemption's own phase.
   */
  const subscribedQuota = async () => ({ signedIn: true as const, hasTokenPlan: true });

  it("does not offer the cards to an account without a plan", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        listResetCards: async () => ({ cards: [card], total: 1 }),
      } as unknown as WebuiAccountPortSlice,
    });
    expect(workflows.canUseResetCards).toBe(false);
    await workflows.loadResetCards();
    expect(workflows.getSnapshot().resetCards.cards.items).toHaveLength(1);
  });

  it("reads the list and merges a second page without duplicates", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        // The page size is 20, so a total of 21 is what makes a second page
        // exist at all — the same arithmetic the owner's "has more" rule uses.
        listResetCards: async (request: { readonly page?: number }) =>
          request?.page === 2
            ? { cards: [card, { cardId: "card-2" }], total: 21 }
            : { cards: [card], total: 21 },
      } as unknown as WebuiAccountPortSlice,
    });
    await workflows.loadResetCards();
    await workflows.loadMoreResetCards();
    const list = workflows.getSnapshot().resetCards.cards;
    expect(list.items.map((entry) => entry.cardId)).toEqual(["card-1", "card-2"]);
  });

  it("maps a successful redemption to the success phase and re-reads the list", async () => {
    let listReads = 0;
    const workflows = createWebuiAccountWorkflows({
      port: {
        getUsageQuota: subscribedQuota,
        listResetCards: async () => {
          listReads += 1;
          return { cards: [card], total: 1 };
        },
        useResetCard: async () => ({ outcome: "SUCCESS" }),
      } as unknown as WebuiAccountPortSlice,
    });
    workflows.selectResetCard(card);
    await workflows.redeemResetCard();
    expect(workflows.getSnapshot().resetCards.phase).toBe("success");
    expect(workflows.getSnapshot().resetCards.selected).toBeUndefined();
    // The redemption re-reads the list: the spent card is gone from it.
    expect(listReads).toBe(1);
  });

  it("keeps a replayed redemption on its own phase", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        getUsageQuota: subscribedQuota,
        listResetCards: async () => ({ cards: [card], total: 1 }),
        useResetCard: async () => ({ outcome: "REPLAYED" }),
      } as unknown as WebuiAccountPortSlice,
    });
    workflows.selectResetCard(card);
    await workflows.redeemResetCard();
    expect(workflows.getSnapshot().resetCards.phase).toBe("replayed");
  });

  it("reports an expired card as unavailable and re-reads the list", async () => {
    const workflows = createWebuiAccountWorkflows({
      port: {
        getUsageQuota: subscribedQuota,
        listResetCards: async () => ({ cards: [], total: 0 }),
        useResetCard: async () => ({ outcome: "EXPIRED" }),
      } as unknown as WebuiAccountPortSlice,
    });
    workflows.selectResetCard(card);
    await workflows.redeemResetCard();
    expect(workflows.getSnapshot().resetCards.phase).toBe("unavailable");
  });

  it("keeps a retryable failure distinct from an unknown one", async () => {
    const retryable = createWebuiAccountWorkflows({
      port: {
        useResetCard: async () => ({ outcome: "RETRYABLE_FAIL" }),
      } as unknown as WebuiAccountPortSlice,
    });
    retryable.selectResetCard(card);
    await retryable.redeemResetCard();
    expect(retryable.getSnapshot().resetCards.phase).toBe("retryable");

    const unknown = createWebuiAccountWorkflows({
      port: {
        useResetCard: async () => {
          throw new Error("network");
        },
      } as unknown as WebuiAccountPortSlice,
    });
    unknown.selectResetCard(card);
    await unknown.redeemResetCard();
    expect(unknown.getSnapshot().resetCards.phase).toBe("unknown");
    // The card stays selected: an answer that cannot be trusted must not
    // spend the card twice.
    expect(unknown.getSnapshot().resetCards.selected).toBeDefined();
  });

  it("reads the history within the 30-day window", async () => {
    let seen: { readonly createTimeMs?: number } | undefined;
    const workflows = createWebuiAccountWorkflows({
      port: {
        queryResetCardFlows: async (request: { readonly createTimeMs?: number }) => {
          seen = request;
          return { flows: [] };
        },
      } as unknown as WebuiAccountPortSlice,
    });
    await workflows.openResetCardHistory();
    expect(workflows.getSnapshot().resetCards.historyOpen).toBe(true);
    const window = 30 * 24 * 60 * 60 * 1_000;
    expect(seen?.createTimeMs).toBeGreaterThan(Date.now() - window - 10_000);
    expect(seen?.createTimeMs).toBeLessThanOrEqual(Date.now() - window + 10_000);
  });
});

describe("the account-billing operation validators", () => {
  it("requires a boolean for the credit fallback", () => {
    expect(setCreditFallbackOperation.validate({ enabled: true })).toEqual({
      ok: true,
      body: { enabled: true },
    });
    const invalid = setCreditFallbackOperation.validate({ enabled: "yes" });
    expect(invalid.ok).toBe(false);
  });

  it("requires positive integers for the pages", () => {
    expect(listResetCardsOperation.validate({ page: 2, size: 20 })).toEqual({
      ok: true,
      body: { page: 2, size: 20 },
    });
    expect(listResetCardsOperation.validate({ page: 0 }).ok).toBe(false);
    expect(listResetCardsOperation.validate({ size: -1 }).ok).toBe(false);
    expect(queryResetCardFlowsOperation.validate({ createTimeMs: 5 }).ok).toBe(true);
    expect(queryResetCardFlowsOperation.validate({ createTimeMs: "now" }).ok).toBe(false);
  });

  it("accepts an empty body for the credit read and the card redemption", () => {
    expect(getCreditFallbackOperation.validate({}).ok).toBe(true);
    expect(useResetCardOperation.validate({}).ok).toBe(true);
    expect(useResetCardOperation.validate({ sourceType: "FIVE_HOUR" }).ok).toBe(true);
  });
});
