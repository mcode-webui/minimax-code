/**
 * The starred-model set behind the selector's favourites section, and the
 * pure toggle arithmetic behind it.
 *
 * Why localStorage and not the runtime: a star is a reading preference about
 * THIS browser's list, not a fact about the account. Putting it on the wire
 * would make it a per-account field that a model picker cannot express and
 * that nothing else reads. It is also versioned, because a key whose stored
 * shape can change must be able to move its version rather than be guessed at
 * on read.
 *
 * The toggle is a pure function in its own right rather than a line inside
 * the click handler, so the suite can drive the ORDER it returns — the star
 * has to become the last-touched entry, because that order is what the
 * favourites section falls back to when labels tie.
 *
 * Ported from `webapp/lib/model-favorites.ts` in the other WebUI
 * implementation. The storage accessor follows this repository's
 * `browserStorage()` convention (`team-mode.ts`) rather than reaching for
 * `window` directly, so a server render cannot touch it.
 */
import type { WebuiModelProviderGroup } from "../contracts/model-view.js";

/** The storage key. The `v1` is load-bearing: see the file comment. */
export const MODEL_FAVORITES_KEY = "webui:model-favorites:v1";

/** The section id the favourites list renders under. */
export const FAVORITES_SECTION_ID = "__favorites";

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/** A stored id list, guarded against a hand-edited or truncated value. */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Add or remove one id, returning the NEW list.
 *
 * Starring appends (so the array doubles as most-recent-first) and unstarring
 * removes every copy of the id — a hand-edited store can carry a duplicate,
 * and leaving one behind would render a model the user believes they
 * unstarred.
 */
export function toggleFavoriteId(
  current: readonly string[],
  modelId: string,
): string[] {
  const id = modelId.trim();
  if (!id) return [...current];
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  return [...current, id];
}

/** The persisted set, or empty when the store is absent or unreadable. */
export function readFavoriteModels(): string[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(MODEL_FAVORITES_KEY);
    if (!raw) return [];
    return toIdList(JSON.parse(raw));
  } catch {
    // A store written by an older build, or by a user with devtools open,
    // must not be able to take the selector down on open.
    return [];
  }
}

/** Persist the set. A store that refuses the write is not worth an error. */
export function writeFavoriteModels(ids: readonly string[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(toIdList(ids)));
  } catch {
    // Private-mode and quota-exceeded both land here. The star still works
    // for this session; only the persistence is lost.
  }
}

/**
 * Repeat the starred models in a section of their own, ABOVE the providers.
 *
 * The starred models are NOT taken out of the groups they came from. That was
 * the previous behaviour and it was wrong in a way that only showed up once
 * two models from one provider were starred: hoisting emptied the provider
 * group, so starring M3 made the MiniMax group stop listing M3, and the picker
 * was quietly offering a smaller catalogue than it had a minute ago. A star is
 * a reading preference — a shortcut — and a shortcut that deletes the long way
 * round is not a shortcut.
 *
 * So each model is listed twice: once under the provider that owns it, which is
 * the catalogue's own truth, and once at the top, which is the shortlist. The
 * repeated rows carry the provider they came from in `modelOriginLabels`, so
 * the second listing explains itself.
 *
 * Order is the STORE order, not the catalogue order and not an alphabetical
 * sort. `toggleFavoriteId` appends, so the persisted array is already
 * most-recently-starred-first, and that is the order a person rebuilding a
 * shortlist expects to read it back in.
 *
 * DEVIATION from the source module, recorded because it is a real difference
 * and not an oversight: the source sorted the section by display name, after
 * forcing the built-in MiniMax models to the top on the grounds that the
 * account's own plan meters them. This repository has no such built-in
 * provider id to test for — `providerId` arrives free-form from the runtime
 * (see `groupModelsByProvider`'s own fallback to the raw id), so the source's
 * `minimax_api` prefix test cannot be reproduced without inventing a constant
 * the wire does not promise. Sorting by a provider identity this stack cannot
 * verify would be a guess presented as a rule, so the store order stands on
 * its own instead.
 *
 * With nothing starred the input comes back unchanged (same group objects,
 * same order) — the common case must not allocate a section nobody sees.
 *
 * Re-applying this to its own output is safe: the favourites section is
 * rebuilt from its own members rather than dropped or duplicated, and a group
 * that is already the favourites section does not re-label its own rows. The
 * picker filters the raw grouping and orders that, but a function that quietly
 * eats its own section on a second pass is a trap for the next caller.
 *
 * `favoritesLabel` and `idOf` are injected because the caller owns the row's
 * identity: this module deals in opaque strings and never has to agree with
 * `ModelPicker`'s own key format.
 */
export function orderModelGroups(
  groups: readonly WebuiModelProviderGroup[],
  favoriteIds: readonly string[],
  favoritesLabel: string,
  idOf: (model: WebuiModelProviderGroup["models"][number]) => string,
): readonly WebuiModelProviderGroup[] {
  if (favoriteIds.length === 0) return groups;

  // Walk the store, not the groups: the store is what fixes the section's
  // order, and a model the store names but the catalogue no longer carries
  // simply contributes nothing rather than resurrecting a stale row.
  //
  // A provider group always wins over a section that merely repeats it, so
  // re-applying this to its own output keeps finding the real origin.
  const byId = new Map<
    string,
    { readonly model: WebuiModelProviderGroup["models"][number]; readonly from: string }
  >();
  for (const group of groups) {
    const repeats = group.id === FAVORITES_SECTION_ID;
    for (const model of group.models) {
      const id = idOf(model);
      if (!repeats && byId.has(id)) continue;
      byId.set(id, { model, from: group.id });
    }
  }
  // Labels a previous pass already established, so a model whose provider group
  // is no longer in the list at all — a search that filtered it out, say —
  // keeps saying where it came from instead of going blank.
  const carried = groups.find(
    (group) => group.id === FAVORITES_SECTION_ID,
  )?.modelOriginLabels;

  const starred: WebuiModelProviderGroup["models"][number][] = [];
  const originLabels: Record<string, string> = {};
  for (const id of favoriteIds) {
    const found = byId.get(id);
    if (!found) continue;
    starred.push(found.model);
    const from = groups.find((group) => group.id === found.from);
    const label = from && from.id !== FAVORITES_SECTION_ID ? from.label : carried?.[id];
    if (label) originLabels[id] = label;
  }
  if (starred.length === 0) return groups;

  // Any section already in the input is rebuilt above, so it is dropped from
  // the passthrough. Nothing else removes it now that starred models stay where
  // they are, and a second section headed 收藏 would list the shortlist twice.
  const providers = groups.filter((group) => group.id !== FAVORITES_SECTION_ID);
  return [
    {
      id: FAVORITES_SECTION_ID,
      label: favoritesLabel,
      models: starred,
      modelOriginLabels: originLabels,
    },
    ...providers,
  ];
}
