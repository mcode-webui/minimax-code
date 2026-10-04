/**
 * The recently-used model set behind the selector's 「最近使用」 section.
 *
 * A star is a deliberate shortlist a user curates; this is the opposite thing —
 * a record of what actually got picked, so the next time they open the picker
 * the model they use is already at the top. Without it the same user has to
 * find their model again in provider order on every single session, which is
 * the friction a model selector is supposed to remove rather than impose.
 *
 * localStorage for the same reason as `model-favorites.ts`: this is a habit
 * about THIS browser, not a fact about the account. Same `v1`-suffixed key
 * convention, same `browserStorage()` accessor, same refusal to let a bad
 * store take the selector down.
 *
 * The ordering rule is the whole point, so it is a pure function the suite can
 * drive. Most-recent-first, bounded, and re-picking a model MOVES it rather
 * than duplicating it — a list where the same model appears twice is a list
 * whose length no longer means "how many models have I used".
 */

import type {
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
} from "../components/ModelPicker.js";
import { orderModelGroups } from "./model-favorites.js";

/** The storage key. The `v1` is load-bearing: see `model-favorites.ts`. */
export const MODEL_RECENTS_KEY = "webui:model-recents:v1";

/** The section id the recents list renders under. */
export const RECENTS_SECTION_ID = "__recents";

/**
 * How many models the section keeps.
 *
 * A shortlist, not a history: the point is that the top entry is the model
 * used a moment ago, and that only stays true while the section is short
 * enough to scan. Ten is where it stops being a shortcut and starts being
 * the catalogue again.
 */
export const RECENTS_LIMIT = 10;

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
 * Record one pick, returning the NEW list, most recent first.
 *
 * Re-picking moves the id to the front instead of appending a second copy.
 * The cap is applied after the move, so the model just used is never the one
 * evicted.
 */
export function recordRecentModel(
  current: readonly string[],
  modelId: string,
): string[] {
  const id = modelId.trim();
  if (!id) return toIdList(current).slice(0, RECENTS_LIMIT);
  return [id, ...toIdList(current).filter((entry) => entry !== id)].slice(
    0,
    RECENTS_LIMIT,
  );
}

/** The persisted set, or empty when the store is absent or unreadable. */
export function readRecentModels(): string[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(MODEL_RECENTS_KEY);
    if (!raw) return [];
    return toIdList(JSON.parse(raw));
  } catch {
    // A store written by another version, or one the user cleared. A selector
    // that cannot read its recents must still open.
    return [];
  }
}

/** Persist the set. A store that refuses the write is not worth an error. */
export function writeRecentModels(ids: readonly string[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(MODEL_RECENTS_KEY, JSON.stringify(toIdList(ids)));
  } catch {
    // Private-mode and quota-exceeded both land here. The pick still applies to
    // the live session; only the memory of it is lost.
  }
}

/**
 * Pull the recents out of the provider groups and put them in their own group.
 *
 * Delegates to the favourites' own `orderModelGroups` rather than repeating
 * it. The two sections have the same contract by construction — a model
 * appears ONCE, a group emptied by the move is dropped, a model the store
 * names but the catalogue no longer carries contributes nothing — and two
 * implementations of "hoist a set of ids into a section" is one of them
 * eventually not matching the other.
 *
 * Ordering is fixed by the caller: recents first, then whatever
 * `orderModelGroups` produced, so the most recently used model is the first
 * row in the menu.
 */
export function hoistRecentModels(
  groups: readonly WebuiModelProviderGroup[],
  recentIds: readonly string[],
  idOf: (model: WebuiModelPickerEntry) => string,
): readonly WebuiModelProviderGroup[] {
  if (recentIds.length === 0) return groups;
  const hoisted = orderModelGroups(groups, recentIds, "最近使用", idOf, RECENTS_SECTION_ID);
  if (hoisted.length === 0 || hoisted[0]?.id !== RECENTS_SECTION_ID) return groups;
  // `orderModelGroups` has ALREADY moved the section to the front and pulled
  // its members out of their provider groups, so the remainder is simply
  // everything after it. Rebuilding the tail by calling it again with an empty
  // id list would return the INPUT groups untouched — putting the hoisted
  // models back under their providers, which is the duplicate this section
  // exists to avoid.
  return hoisted;
}
