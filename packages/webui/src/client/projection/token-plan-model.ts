/**
 * Which models the account's token plan actually pays for.
 *
 * The context panel reports two different things under one surface: how full
 * the model's context window is, and how much of the ACCOUNT's plan is left.
 * The first is a fact about the model in front of you; the second is a fact
 * about one provider's subscription. Putting them together without asking which
 * model is selected prints a Zhipu or OpenAI coding plan's own subscription
 * details next to that provider's context usage, under a heading that says
 * 套餐用量 — a claim about a plan that provider does not sell.
 *
 * The discriminator is the runtime's own `providerSource` enum, not a provider
 * name or an id prefix:
 *
 *   - `provider`         — a first-party provider. For this product that is
 *                          MiniMax's own catalogue, which is what the token plan
 *                          meters.
 *   - `minimax_api`      — MiniMax reached through the user's OWN API key. The
 *                          model names are MiniMax's, but the bill is the key's,
 *                          and the plan figures beside it would be about a spend
 *                          this model is not making.
 *   - `custom_provider`  — a provider the user configured. Another vendor's
 *                          coding plan entirely; its limits are metered by that
 *                          vendor against that subscription.
 *
 * The provider ids are mirrored from `@mavis/config` rather than imported: this
 * client imports no `@mavis/*` module, and the package boundary check enforces
 * that. `token-plan-model.test.ts` asserts the mirror still equals the exported
 * constants, so the copy cannot drift without a test going red.
 */

/** Mirrors `MANAGED_MINIMAX_PROVIDER_ID` in `@mavis/config`. */
export const MANAGED_MINIMAX_PROVIDER_ID = "minimax";
/** Mirrors `MINIMAX_API_PROVIDER_ID` in `@mavis/config`. */
export const MINIMAX_API_PROVIDER_ID = "minimax_api";
/** Mirrors `CUSTOM_PROVIDER_ID_PREFIX` in `@mavis/config`. */
export const CUSTOM_PROVIDER_ID_PREFIX = "custom_provider:";

/** The parts of a model entry this decision reads. */
export interface TokenPlanModelIdentity {
  readonly providerId?: string;
  readonly providerSource?: string;
}

/**
 * Is this model's usage metered by the account's token plan?
 *
 * False for a model the account does not know how to bill, and false for no
 * model at all — the caller is deciding whether to SHOW a section, and a missing
 * model is not a reason to show one.
 */
export function isTokenPlanModel(model: TokenPlanModelIdentity | undefined): boolean {
  if (!model) return false;
  // A custom provider is someone else's product under someone else's plan, so
  // no reading of the account's MiniMax plan describes it. Checked by id rather
  // than by source because a custom provider can arrive declaring either.
  if (model.providerId?.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) return false;
  // The user's own MiniMax key shares the vendor with the plan and none of its
  // accounting, which is exactly the case a vendor-name test would get wrong.
  if (model.providerId === MINIMAX_API_PROVIDER_ID) return false;
  // Declared first-party AND not a custom provider: the runtime's own statement
  // about where the model is served. Falls back to the managed MiniMax id when
  // the source did not arrive, because that is the only first-party provider
  // this product ships and a missing enum is not evidence of anything else.
  if (model.providerSource !== undefined) return model.providerSource === "provider";
  return model.providerId === MANAGED_MINIMAX_PROVIDER_ID;
}
