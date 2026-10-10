/**
 * The model picker's search arithmetic (roadmap H, 模型搜索).
 *
 * Pure functions on purpose: the search box is a filter over a catalogue the
 * runtime refreshes underneath us, and the rules below — fuzzy matching, a
 * provider-name hit keeping the whole group, group order surviving the
 * filter — are the ones most likely to rot if they only exist inside a
 * component. Each rule is pinned by a named test in
 * `test/unit/model-picker-search.test.ts`.
 *
 * This is a port of `webapp/lib/model-groups.ts#filterModelGroups` from the
 * other WebUI implementation, re-shaped onto this repository's entry type
 * (`WebuiModelPickerEntry`: `modelId`/`displayName` rather than `id`/`label`).
 * The matching rules are unchanged; only the field names moved.
 */
import type {
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
} from "../contracts/model-view.js";

/**
 * Lowercase and drop everything that is not a letter or a digit.
 *
 * Both sides of a comparison go through this, which is what makes `glm5.3`,
 * `glm-5.3` and `GLM 5.3` the same query. Separators are the difference
 * between a model id and the way a user remembers it, so they cannot be
 * allowed to decide whether a model is found.
 */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * True when every character of `needle` appears in `haystack` in order,
 * not necessarily adjacent.
 *
 * A substring test is not enough: the catalogue is full of ids like
 * `minimax_api/MiniMax-M3` and `glm-5.3`, and nobody types the provider
 * prefix or remembers the exact casing. `mm3` and `glm53` are what a user
 * actually writes, and neither is a substring of anything.
 *
 * There is deliberately no special case for a one-character query, and the
 * reason is worth recording because it looks like a gap. For a single
 * character "appears in order" and "appears at all" are the SAME predicate —
 * there is nothing to be stricter about. An earlier draft of the source
 * module added a "one character must match contiguously" branch; it was a
 * no-op, and the test written to pin it passed for an unrelated reason (the
 * fixture happened to contain no such character at all). So `a` matches
 * every model whose name contains an `a`, which is what typing one
 * character has always meant everywhere else in the product.
 */
export function fuzzyMatches(haystack: string, needle: string): boolean {
  const q = normalizeForMatch(needle);
  if (!q) return true;
  const h = normalizeForMatch(haystack);
  let at = 0;
  for (const ch of h) {
    if (ch === q[at]) at += 1;
    if (at === q.length) return true;
  }
  return false;
}

/**
 * Every string a model row can be found by.
 *
 * `modelId` and `displayName` are both listed because users copy ids off logs
 * and read names off the screen; both have to land. The provider prefix is
 * included via the group's own match rather than here, so that a model is
 * not found merely because its provider happens to contain the query.
 */
function rowHaystack(model: WebuiModelPickerEntry): string {
  return `${model.displayName ?? ""} ${model.modelId}`;
}

/**
 * Narrow provider groups to the models a search query matches.
 *
 * The rules, each of which a test pins:
 *
 *   - An empty (or whitespace-only) query returns the INPUT array by
 *     reference. A fresh array re-renders the whole list on every open; the
 *     identity is what lets the caller skip the work.
 *   - A model matches on its display name OR its id, fuzzily.
 *   - A group whose PROVIDER label matches keeps ALL of its models. Typing a
 *     provider name and getting one of its twenty models is the surprise
 *     this avoids — the user named the provider, so the provider's models
 *     are the answer.
 *   - A group with no matching model is dropped rather than rendered as an
 *     empty header; an empty provider header is a dead end.
 *   - Group order and within-group model order survive. That order is the
 *     runtime's own catalogue ordering and is meaningful; a filter that
 *     re-sorted it would silently reshuffle the list being read. Starring is
 *     the one thing that DOES reorder, and it does so afterwards, in
 *     `orderModelGroups`.
 */
export function filterModelGroups(
  groups: readonly WebuiModelProviderGroup[],
  query: string,
): readonly WebuiModelProviderGroup[] {
  if (!query.trim()) return groups;
  const kept: WebuiModelProviderGroup[] = [];
  for (const group of groups) {
    if (fuzzyMatches(group.label, query)) {
      kept.push(group);
      continue;
    }
    const models = group.models.filter((model) =>
      fuzzyMatches(rowHaystack(model), query),
    );
    if (models.length > 0) kept.push({ ...group, models });
  }
  return kept;
}

/**
 * True when the picker should render its "no match" line.
 *
 * Separate from `filterModelGroups` so the component does not have to
 * re-derive emptiness from an array whose emptiness can also come from an
 * empty catalogue. A picker that has never loaded a model must not claim
 * the user searched for something and found nothing.
 */
export function isSearchEmpty(
  groups: readonly WebuiModelProviderGroup[],
  query: string,
  catalogueSize: number,
): boolean {
  if (catalogueSize === 0) return false;
  if (!query.trim()) return false;
  return groups.length === 0;
}
