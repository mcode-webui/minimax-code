/**
 * 「最近使用」 — the recently-used section behind the model selector.
 *
 * The rules worth pinning are the ORDER ones. A recents list whose order is
 * wrong is worse than no recents list: it puts a model the user abandoned
 * above the one they just picked, and the section then actively misleads.
 */
import { describe, expect, it } from "vitest";

import {
  hoistRecentModels,
  RECENTS_LIMIT,
  RECENTS_SECTION_ID,
  recordRecentModel,
} from "../../src/client/projection/model-recents.js";
import { modelKey } from "../../src/client/components/ModelPicker.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts.js";

function entry(providerId: string, modelId: string): WebuiModelPickerEntry {
  return { providerId, modelId, displayName: modelId };
}

function groups(models: readonly WebuiModelPickerEntry[]) {
  const byProvider = new Map<string, WebuiModelPickerEntry[]>();
  for (const model of models) {
    const bucket = byProvider.get(model.providerId) ?? [];
    bucket.push(model);
    byProvider.set(model.providerId, bucket);
  }
  return [...byProvider].map(([id, list]) => ({
    id,
    label: id,
    models: list,
  }));
}

describe("recents — the order the section renders in", () => {
  // `modelKey` is `providerId/modelId/variant` with a trailing slash, so every
  // id here carries its empty variant. Writing the two-segment form looks
  // right and silently matches nothing — a store full of ids that hoist no
  // rows at all.
  it("puts the model just picked at the front", () => {
    expect(recordRecentModel([], "a/M3/")).toEqual(["a/M3/"]);
    expect(recordRecentModel(["a/M3/"], "a/M2.7/")).toEqual(["a/M2.7/", "a/M3/"]);
  });

  it("moves a re-picked model rather than listing it twice", () => {
    // A duplicate is not just untidy: it makes the section's length stop
    // meaning "how many models have I used", and the star beside each copy
    // then applies to a row the user cannot tell apart.
    const once = recordRecentModel(["a/M3/", "a/M2.7/"], "a/M3/");
    expect(once).toEqual(["a/M3/", "a/M2.7/"]);
    expect(once.filter((id) => id === "a/M3/")).toHaveLength(1);
  });

  it("keeps the section a shortlist rather than a history", () => {
    let ids: string[] = [];
    for (let index = 0; index < RECENTS_LIMIT + 5; index += 1) {
      ids = recordRecentModel(ids, `a/M${index}/`);
    }
    expect(ids).toHaveLength(RECENTS_LIMIT);
    // The newest pick is never the one evicted.
    expect(ids[0]).toBe(`a/M${RECENTS_LIMIT + 4}/`);
  });

  it("ignores a blank id rather than storing an unusable row", () => {
    expect(recordRecentModel(["a/M3/"], "   ")).toEqual(["a/M3/"]);
  });
});

describe("recents — how the section is hoisted out of the provider groups", () => {
  const catalogue = groups([
    entry("minimax", "M3"),
    entry("minimax", "M2.7"),
    entry("deepseek", "v4"),
  ]);

  it("returns the groups untouched when nothing has been used", () => {
    expect(hoistRecentModels(catalogue, [], modelKey)).toBe(catalogue);
  });

  it("leads with the recents section, most recent first", () => {
    const result = hoistRecentModels(catalogue, ["deepseek/v4/", "minimax/M3/"], modelKey);
    expect(result[0]?.id).toBe(RECENTS_SECTION_ID);
    expect(result[0]?.label).toBe("最近使用");
    expect(result[0]?.models.map((model) => model.modelId)).toEqual(["v4", "M3"]);
  });

  it("lists a hoisted model once, never again under its provider", () => {
    const result = hoistRecentModels(catalogue, ["minimax/M3/"], modelKey);
    const everyId = result.flatMap((group) => group.models.map(modelKey));
    expect(everyId.filter((id) => id === "minimax/M3/")).toHaveLength(1);
  });

  it("drops a provider group the hoist emptied", () => {
    const only = groups([entry("minimax", "M3")]);
    const result = hoistRecentModels(only, ["minimax/M3/"], modelKey);
    // The recents section plus nothing: an empty "MiniMax" header under it
    // would be a heading with no rows.
    expect(result.map((group) => group.id)).toEqual([RECENTS_SECTION_ID]);
  });

  it("skips a remembered model the catalogue no longer carries", () => {
    // A store written before a model was removed must not resurrect a dead
    // row: a recents entry that selects nothing is a dead end.
    const result = hoistRecentModels(catalogue, ["gone/removed/", "minimax/M3/"], modelKey);
    expect(result[0]?.models.map((model) => model.modelId)).toEqual(["M3"]);
  });

  it("gives the recents section its own id, distinct from favourites", () => {
    // Two sections sharing one id are two React keys on the same string, which
    // renders as a duplicated or vanished row rather than an error.
    expect(RECENTS_SECTION_ID).not.toBe("__favorites");
    const result = hoistRecentModels(catalogue, ["minimax/M3/"], modelKey);
    const ids = result.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
