// The 用量与模型 page's plan wording.
//
// The plan facts are the account's, not the settings page's: the membership
// answer carries the subscription kind, the tier and the plan name. What is
// here is only the wording the page derives from them.
//
// The rules:
//
// - a subscribed account shows its tier; the current M Plan levels (Go /
//   Explore / Build) pass through as the membership answer reports them, the
//   pre-upgrade identifiers (starter / plus / max / ultra / plus极速版) get
//   their product display names, and any other reported tier name passes
//   through. A numeric combo id falls back to the generic name of its kind;
// - an unsubscribed account shows the plan name the membership answer carries;
// - the generic name and the model-source label both depend on the subscription
//   kind: the legacy `token_plan` kind reads "Token Plan", every other kind
//   reads "M Plan".

/** The plan name a subscribed account shows when its tier is not a display name. */
export const WEBUI_PLAN_NAME = "M Plan";

/** The plan name an unsubscribed account shows when the account reports none. */
export const WEBUI_FREE_PLAN_NAME = "免费版";

/** The wording for an account that is not subscribed to a plan. */
export const WEBUI_NO_PLAN_SUBSCRIBED = "未订阅 M Plan";

/** The legacy subscription kind, whose wording still reads "Token Plan". */
const LEGACY_SUBSCRIPTION_TYPE = "token_plan";

/** The name the pre-upgrade `token_plan` subscription reads. */
const LEGACY_PLAN_NAME = "Token Plan";

/**
 * The pre-upgrade tier identifiers, as the old accounts report them, and the
 * display names the product uses for them. Any other value is the account's own
 * plan name and passes through unchanged: the M Plan levels (Go / Explore /
 * Build) and the probe-seen "Max Plan" all read as reported.
 */
const LEGACY_PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  starter: "Starter",
  plus: "Plus",
  max: "Max",
  ultra: "Ultra",
  plus极速版: "Plus 极速版",
};

export interface WebuiPlanFacts {
  readonly hasTokenPlan?: boolean;
  readonly tokenPlanTier?: string;
  readonly planName?: string;
  readonly subscriptionType?: string;
}

/**
 * The tier as a display name. A bare numeric combo id uses the generic plan name.
 */
export function formatPlanTier(tier: string | undefined): string | undefined {
  const trimmed = tier?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The plan name the UI shows for a reported identifier. A known pre-upgrade
 * identifier (plus / max / ultra / starter / plus极速版, any casing or spacing)
 * gets the product's display name; every other value is already a name the
 * account chose to report, so it passes through.
 */
function formatPlanDisplayName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const key = trimmed.toLowerCase().replace(/\s+/gu, "");
  return LEGACY_PLAN_DISPLAY_NAMES[key] ?? trimmed;
}

/** Whether the account counts as subscribed. */
export function hasWebuiPlan(facts: WebuiPlanFacts): boolean {
  return facts.hasTokenPlan === true || Boolean(facts.tokenPlanTier);
}

/**
 * The generic plan name for a subscribed account whose tier is a combo id.
 * The subscription kind decides it: a pre-upgrade `token_plan` account reads
 * "Token Plan", every other kind reads "M Plan".
 */
export function formatGenericPlanName(subscriptionType: string | undefined): string {
  return subscriptionType?.trim() === LEGACY_SUBSCRIPTION_TYPE ? LEGACY_PLAN_NAME : WEBUI_PLAN_NAME;
}

/**
 * The plan name the 当前套餐 row shows. A subscribed account shows its tier,
 * then the plan name it reports; an unsubscribed one shows the plan name.
 */
export function formatPlanName(facts: WebuiPlanFacts): string {
  const tier = formatPlanTier(facts.tokenPlanTier);
  if (tier) return formatPlanDisplayName(tier)!;
  const named = formatPlanDisplayName(facts.planName);
  if (hasWebuiPlan(facts)) return named ?? formatGenericPlanName(facts.subscriptionType);
  return named ?? WEBUI_FREE_PLAN_NAME;
}

/**
 * The label of the model-source pill. The pill names the source in use, and
 * the source's label depends on the subscription kind the account reports.
 */
export function formatPlanSourceLabel(subscriptionType: string | undefined): string {
  return formatGenericPlanName(subscriptionType);
}
