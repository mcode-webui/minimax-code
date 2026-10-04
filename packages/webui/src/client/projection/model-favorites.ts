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
import type { WebuiModelProviderGroup } from "../components/ModelPicker.js";

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
 * Hoist starred models into a section of their own, above the providers.
 *
 * The starred models are REMOVED from the provider groups they came from, so
 * a starred model is listed once and once only — a model appearing both at the
 * top and under its provider would make "starred" mean nothing. A group left
 * with no models is dropped rather than rendered as an empty header.
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
 * rebuilt from its own members rather than dropped or duplicated. The picker
 * filters the raw grouping and orders that, but a function that quietly eats
 * its own section on a second pass is a trap for the next caller.
 *
 * `favoritesLabel` and `idOf` are injected because the caller owns the row's
 * identity: this module deals in opaque strings and never has to agree with
 * `ModelPicker`'s own key format.
 *
 * `sectionId` is the one parameter that looks redundant — the favourites
 * section obviously wants the favourites id — and it exists so a SECOND
 * hoisted section can reuse this. 「最近使用」 hoists the same way, and two
 * sections sharing one id would be two React keys on the same string, which
 * renders as a duplicated or vanished row rather than an error.
 */
export function orderModelGroups(
  groups: readonly WebuiModelProviderGroup[],
  favoriteIds: readonly string[],
  favoritesLabel: string,
  idOf: (model: WebuiModelProviderGroup["models"][number]) => string,
  sectionId: string = FAVORITES_SECTION_ID,
): readonly WebuiModelProviderGroup[] {
  if (favoriteIds.length === 0) return groups;
  const starredIds = new Set(favoriteIds);

  // Walk the store, not the groups: the store is what fixes the section's
  // order, and a model the store names but the catalogue no longer carries
  // simply contributes nothing rather than resurrecting a stale row.
  const byId = new Map<string, WebuiModelProviderGroup["models"][number]>();
  for (const group of groups) {
    for (const model of group.models) byId.set(idOf(model), model);
  }
  const starred = favoriteIds
    .map((id) => byId.get(id))
    .filter((model): model is WebuiModelProviderGroup["models"][number] =>
      Boolean(model),
    );
  if (starred.length === 0) return groups;

  const hoisted = new Set(starred.map((model) => idOf(model)));
  const rest = groups
    .map((group) => {
      const models = group.models.filter((model) => !hoisted.has(idOf(model)));
      return models.length === group.models.length ? group : { ...group, models };
    })
    .filter((group) => group.models.length > 0);

  return [
    { id: sectionId, label: favoritesLabel, models: starred },
    ...rest,
  ];
}
