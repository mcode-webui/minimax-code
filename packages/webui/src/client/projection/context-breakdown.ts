/**
 * The context-window panel's breakdown rows (roadmap H, 模型与用量).
 *
 * Extracted from `SessionComposer.tsx#ContextUsageIndicator` so the suite can
 * drive THIS code. The arithmetic used to live inline in the component, and a
 * rule this load-bearing — what to draw when the engine said nothing — is not
 * one to leave unexercised.
 *
 * Ported from `webapp/lib/context-breakdown.ts` in the other WebUI
 * implementation, re-shaped onto this repository's wire type: the runtime sends
 * `usage.components` as an ARRAY of `{ kind, tokens }` with SCREAMING_SNAKE
 * kinds, where the source sent a `Record<lowerCamelKey, number>`. The rule is
 * the same; the lookup is a `find` instead of a property read.
 *
 * The rule, and why it is not negotiable:
 *
 *   **The breakdown is never invented.** A category the engine did not report
 *   prints a dash, not `0.0%`. `0` and "we were not told" are different facts:
 *   drawing zero claims the engine reported the category and found it empty,
 *   which is a claim this process does not get to make on the engine's behalf.
 *   So the rows list all six whether or not figures arrived, and `null` stays
 *   `null` all the way to the DOM. When the engine starts sending every
 *   category, the same six rows fill in with no change here.
 *
 * The order is the reference's, and it is FIXED. The previous implementation
 * sorted rows by token count descending, which meant the list re-ordered itself
 * as the conversation filled up — a user reading the panel could not find the
 * row they had just looked at. Colour is keyed to the category for the same
 * reason: the old palette was indexed by sort position, so a category changed
 * colour as its neighbours moved.
 */

/**
 * The category order the reference draws, top to bottom.
 *
 * This is the `kind` order the engine's own payload uses, so the panel and the
 * wire format cannot disagree about what "first" means.
 *
 * `shade` is an opacity multiplier over the single accent swatch rather than a
 * six-colour palette: the desktop's own swatches are too small in the reference
 * screenshot to sample a distinct colour from, so the palette is kept and only
 * the ORDER was taken from the screenshot. Indexing it here — rather than at
 * the call site — is what makes a category's colour a property of the category.
 */
export const CONTEXT_BREAKDOWN_CATEGORIES = [
  { kind: "MESSAGES", label: "消息", shade: 1 },
  { kind: "TOOLS", label: "工具", shade: 0.82 },
  { kind: "MEMORY", label: "记忆", shade: 0.68 },
  { kind: "SKILLS", label: "技能", shade: 0.54 },
  { kind: "OTHER", label: "其他", shade: 0.4 },
  { kind: "SYSTEM_PROMPT", label: "系统提示词", shade: 0.26 },
] as const;

export type ContextBreakdownKind =
  (typeof CONTEXT_BREAKDOWN_CATEGORIES)[number]["kind"];

export interface ContextBreakdownRow {
  readonly kind: string;
  readonly label: string;
  readonly shade: number;
  /**
   * The engine's token count for this category, or `null` when the engine said
   * nothing about it. `null` and `0` are different facts and stay different all
   * the way to the DOM.
   */
  readonly tokens: number | null;
  /**
   * Share of the used window, or `null` when it cannot be computed — either
   * the engine never reported the category, or it reported one but `total` is
   * 0, so every share would be a division by zero.
   */
  readonly percent: number | null;
}

/** The place a drawable row's swatch takes its opacity. */
export const UNREPORTED_SHADE = 0.2;

/**
 * A context-window percentage, the way the panel prints it.
 *
 *   p ≤ 0      → "0%"        (no usage reported yet)
 *   0 < p < 1  → "<1%"       (used > 0 but rounds to 0; never collapse to "0%")
 *   1 ≤ p < 10 → "3.5%"      (1-decimal place, matches server-side rounding)
 *   p ≥ 10     → "47%"       (integer; sub-percent digits are noise)
 *
 * The intermediate band shows real precision instead of two-decimal noise like
 * "3.4567%", and the `<1%` band is the one that matters most: a session that
 * has started but is still under a tenth of a percent would otherwise print
 * "0%", which reads as "nothing has happened yet".
 */
export function formatPercent(percent: number): string {
  if (percent <= 0) return "0%";
  if (percent < 1) return "<1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/**
 * The breakdown rows to draw: always all six, in the reference's order.
 *
 * A `kind` the runtime sends that is not one of the six is NOT drawn. The
 * alternative — folding it into `OTHER` — would put a figure on the "其他" row
 * that no longer adds up to the numbers printed above it, which is worse than
 * a row being absent. This is a forward-compatibility decision, not an
 * oversight: a new engine category is a wire change that wants a decision here
 * rather than a silent merge.
 */
export function contextBreakdownRows(
  components: unknown,
  total: number,
): ContextBreakdownRow[] {
  const reported = new Map<string, number>();
  if (Array.isArray(components)) {
    for (const entry of components) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.kind !== "string") continue;
      const tokens = item.tokens;
      if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
      // A repeated kind sums rather than overwrites: the wire is an array, so
      // two entries of the same kind are a legitimate split, and taking the
      // last one would silently drop tokens off the total.
      reported.set(
        item.kind,
        (reported.get(item.kind) ?? 0) + Math.max(0, tokens),
      );
    }
  }
  const denominator = total > 0 ? total : 0;
  return CONTEXT_BREAKDOWN_CATEGORIES.map((category) => {
    const tokens = reported.get(category.kind);
    if (tokens === undefined) {
      return { ...category, tokens: null, percent: null };
    }
    return {
      ...category,
      tokens,
      percent: denominator > 0 ? (tokens / denominator) * 100 : null,
    };
  });
}

/**
 * The rows that can draw a share of the bar, in the same fixed order.
 *
 * The bar is a width, so an unreported row contributes nothing to it — which
 * is why this is a filter over `contextBreakdownRows` rather than a second,
 * separately-derived list that could disagree with it.
 */
export function drawableBreakdownRows(
  rows: readonly ContextBreakdownRow[],
): ContextBreakdownRow[] {
  return rows.filter((row) => row.tokens !== null);
}

/**
 * The label a row prints in its share slot: the figure, or a dash.
 *
 * The dash is the whole point of the module. It claims only what is true —
 * nothing arrived — where `0.0%` would claim the engine reported the category
 * and found it empty.
 */
export function breakdownShareLabel(row: ContextBreakdownRow): string {
  return row.percent === null ? "—" : formatPercent(row.percent);
}

/** Swatch props for one row, so the call site cannot drift from the order. */
export function breakdownSwatchStyle(
  row: ContextBreakdownRow,
): { readonly opacity: number } {
  return { opacity: row.tokens === null ? UNREPORTED_SHADE : row.shade };
}
