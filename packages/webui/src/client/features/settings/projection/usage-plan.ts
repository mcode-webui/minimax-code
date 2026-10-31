// The 用量与模型 page's plan wording.
//
// The plan facts are the account's, not the settings page's: the membership
// answer carries the subscription kind, the tier and the plan name. What is
// here is only the wording the page derives from them.
//
// The rules are the Desktop's, read out of its settings bundle:
//
// - a subscribed account shows its tier, and a tier that is a bare number (a
//   combo id the Desktop resolves through the subscription catalogue) falls
//   back to the generic plan name;
// - an unsubscribed account shows the plan name the membership answer carries;
// - the model-source label depends on the subscription kind: the legacy
//   `token_plan` kind still reads "Token Plan", every other kind reads
//   "M Plan".

/** The plan name a subscribed account shows when its tier is not a display name. */
export const WEBUI_PLAN_NAME = "M Plan";

/** The plan name an unsubscribed account shows when the account reports none. */
export const WEBUI_FREE_PLAN_NAME = "免费版";

/** The wording for an account that is not subscribed to a plan. */
export const WEBUI_NO_PLAN_SUBSCRIBED = "未订阅 M Plan";

/** The legacy subscription kind, whose model source still reads "Token Plan". */
const LEGACY_SUBSCRIPTION_TYPE = "token_plan";

export interface WebuiPlanFacts {
  readonly hasTokenPlan?: boolean;
  readonly tokenPlanTier?: string;
  readonly planName?: string;
  readonly subscriptionType?: string;
}

/**
 * The tier as a display name. A tier that is a bare number is a combo id: the
 * Desktop resolves it through the subscription catalogue and falls back to the
 * generic plan name when it cannot, so this does the same.
 */
export function formatPlanTier(tier: string | undefined): string | undefined {
  const trimmed = tier?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/** Whether the account counts as subscribed, the way the Desktop counts it. */
export function hasWebuiPlan(facts: WebuiPlanFacts): boolean {
  return facts.hasTokenPlan === true || Boolean(facts.tokenPlanTier);
}

/**
 * The plan name the 当前套餐 row shows. A subscribed account shows its tier;
 * an unsubscribed one shows the plan name the account reports.
 */
export function formatPlanName(facts: WebuiPlanFacts): string {
  if (hasWebuiPlan(facts)) return formatPlanTier(facts.tokenPlanTier) ?? WEBUI_PLAN_NAME;
  return facts.planName?.trim() || WEBUI_FREE_PLAN_NAME;
}

/**
 * The label of the model-source pill. The pill names the source in use, and
 * the source's label depends on the subscription kind the account reports.
 */
export function formatPlanSourceLabel(subscriptionType: string | undefined): string {
  return subscriptionType?.trim() === LEGACY_SUBSCRIPTION_TYPE ? "Token Plan" : WEBUI_PLAN_NAME;
}
