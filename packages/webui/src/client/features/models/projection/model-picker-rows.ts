// How the model catalogue becomes groups.
//
// The picker renders the catalogue; it does not decide what a group IS. Grouping
// by provider, and the key that names one model, are catalogue facts, so they
// live here with the rest of the Models projection.
//
// There is nothing else: no shortlist is hoisted above the providers, and no
// filter narrows them. Both used to be here — a favourites section and a search
// filter — and both are gone, because both moved rows under the pointer. A
// shortlist that is re-ordered by the act of starring a model re-orders the
// list the user is starring in, and a filter that rebuilds the list on every
// keystroke moves the row a click was aimed at. The catalogue's own order is
// the one order nothing else can disturb.

import type {
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
} from "../contracts/model-view.js";

/** Group label: the provider's display name, falling back to its id. */
export function providerGroupLabel(model: WebuiModelPickerEntry): string {
  const name = model.providerName?.trim();
  return name || model.providerId;
}

/**
 * Groups by provider, keeping the catalog's own order — the same grouping the
 * TUI picker applies (see `packages/tui/src/tui/features/model/picker.ts`).
 *
 * Buckets on `providerId` and carries the display name alongside, rather than
 * bucketing on the name itself. Same visible result for the ordinary case
 * where every provider has a distinct name, and the right result for the
 * case where two do not.
 */
export function groupModelsByProvider(
  models: readonly WebuiModelPickerEntry[],
): readonly WebuiModelProviderGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, WebuiModelPickerEntry[]>();
  const labels = new Map<string, string>();
  for (const model of models) {
    const id = model.providerId;
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.push(model);
      continue;
    }
    buckets.set(id, [model]);
    labels.set(id, providerGroupLabel(model));
    order.push(id);
  }
  return order.map((id) => ({
    id,
    label: labels.get(id) ?? id,
    models: buckets.get(id) ?? [],
  }));
}

/**
 * The stable identity of one model: `providerId/modelId/variant`.
 *
 * The variant is part of the key because one model offering an off/on pair is
 * two rows, and a change made to one of them is a statement about that row
 * rather than about the model name.
 */
export function modelKey(model: WebuiModelPickerEntry): string {
  return `${model.providerId}/${model.modelId}/${model.variant ?? ""}`;
}
