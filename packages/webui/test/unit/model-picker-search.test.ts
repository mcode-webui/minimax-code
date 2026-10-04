// The model picker's search box and starred section (roadmap H, 模型搜索).
//
// The suite drives the PRODUCT functions in `projection/model-picker-search.ts`
// and `projection/model-favorites.ts`, not copies of them. An earlier revision
// of the source implementation kept a hand-written mirror of the grouping loop
// in the test file, and that mirror stayed green through a regression in the
// exact place the test claimed to defend — the product code is imported here so
// that cannot happen again.
//
// The rendered assertions cover `WebuiModelMenuList` directly. The picker's
// menu starts closed and `renderToStaticMarkup` cannot open it, so the search
// INPUT is pinned by the pure functions and by typecheck rather than by a
// rendered assertion; that boundary is deliberate and is not covered elsewhere.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  groupModelsByProvider,
  modelKey,
  WebuiModelMenuList,
} from "../../src/client/components/ModelPicker.js";
import {
  filterModelGroups,
  fuzzyMatches,
  isSearchEmpty,
} from "../../src/client/projection/model-picker-search.js";
import {
  FAVORITES_SECTION_ID,
  orderModelGroups,
  readFavoriteModels,
  toggleFavoriteId,
  writeFavoriteModels,
} from "../../src/client/projection/model-favorites.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts.js";

function entry(
  providerId: string,
  modelId: string,
  displayName?: string,
): WebuiModelPickerEntry {
  return {
    providerId,
    modelId,
    displayName: displayName ?? modelId,
  };
}

function grouped(...models: WebuiModelPickerEntry[]) {
  return groupModelsByProvider(models);
}

const CATALOGUE: readonly WebuiModelPickerEntry[] = [
  entry("minimax_api", "MiniMax-M3", "MiniMax-M3"),
  entry("minimax_api", "MiniMax-M2.7", "MiniMax-M2.7"),
  entry("zai", "glm-5.3", "GLM 5.3"),
  entry("zai", "glm-4.6", "GLM 4.6"),
  entry("openai_compat", "gpt-5", "GPT-5"),
];

describe("model picker search — matching", () => {
  it("treats an empty needle as matching everything", () => {
    expect(fuzzyMatches("anything", "")).toBe(true);
    expect(fuzzyMatches("anything", "   ")).toBe(true);
  });

  it("matches characters in order but not adjacently", () => {
    // `mm3` is what somebody actually types; it is not a substring of
    // `MiniMax-M3`, and a substring test would report the model as missing.
    expect(fuzzyMatches("MiniMax-M3", "mm3")).toBe(true);
    expect("MiniMax-M3".includes("mm3")).toBe(false);
  });

  it("ignores separators and case, so three spellings are one query", () => {
    expect(fuzzyMatches("GLM 5.3", "glm5.3")).toBe(true);
    expect(fuzzyMatches("GLM 5.3", "GLM-5.3")).toBe(true);
    expect(fuzzyMatches("glm-5.3", "glm 5 3")).toBe(true);
  });

  it("rejects a needle whose characters are out of order", () => {
    expect(fuzzyMatches("MiniMax-M3", "3mm")).toBe(false);
  });

  it("has no special case for a one-character query", () => {
    // For one character "in order" and "anywhere" are the same predicate.
    // A stricter branch here was a no-op in the source module, so this pins
    // the behaviour that typing one letter behaves like everywhere else.
    expect(fuzzyMatches("GLM 5.3", "g")).toBe(true);
    expect(fuzzyMatches("GLM 5.3", "z")).toBe(false);
  });
});

describe("model picker search — filtering groups", () => {
  it("returns the INPUT array by reference for a blank query", () => {
    // The identity is what lets the caller skip the work; a fresh array would
    // re-render the whole list on every open.
    const groups = grouped(...CATALOGUE);
    expect(filterModelGroups(groups, "")).toBe(groups);
    expect(filterModelGroups(groups, "   ")).toBe(groups);
  });

  it("finds a model by its id even when its display name differs", () => {
    const groups = grouped(...CATALOGUE);
    const kept = filterModelGroups(groups, "m2.7");
    expect(kept.flatMap((group) => group.models.map((m) => m.modelId))).toEqual([
      "MiniMax-M2.7",
    ]);
  });

  it("keeps ALL of a provider's models when the provider name matches", () => {
    // Typing a provider name and getting one of its twenty models is the
    // surprise this rule exists to avoid: the user named the provider.
    const kept = filterModelGroups(grouped(...CATALOGUE), "zai");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.models.map((m) => m.modelId)).toEqual(["glm-5.3", "glm-4.6"]);
  });

  it("drops a group with no matching model instead of leaving an empty header", () => {
    const kept = filterModelGroups(grouped(...CATALOGUE), "gpt");
    expect(kept.map((group) => group.id)).toEqual(["openai_compat"]);
  });

  it("preserves group order and within-group order", () => {
    // The catalogue order is meaningful; a filter that re-sorted it would
    // silently reshuffle the list being read.
    //
    // The query is "5" rather than a letter, because these fixtures carry no
    // provider NAMES — `groupModelsByProvider` falls back to the provider id,
    // and a one-letter query would fuzzily match `openai_compat` and keep that
    // whole group through the provider-name rule instead of through filtering.
    const kept = filterModelGroups(grouped(...CATALOGUE), "5");
    expect(kept.map((group) => group.id)).toEqual(["zai", "openai_compat"]);
    expect(kept[0]?.models.map((m) => m.modelId)).toEqual(["glm-5.3"]);
    expect(kept[1]?.models.map((m) => m.modelId)).toEqual(["gpt-5"]);
  });

  it("keeps a whole group when the query matches its provider ID", () => {
    // The same rule, reached through the fallback label. A provider id is what
    // a user copies off a config file, so it has to be findable too.
    const kept = filterModelGroups(grouped(...CATALOGUE), "openai");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.models.map((m) => m.modelId)).toEqual(["gpt-5"]);
  });

  it("reports no-match only for a real search over a loaded catalogue", () => {
    // Three states stay distinguishable: never loaded, not searching, and
    // searching with nothing found. Collapsing the first into the third
    // would claim the catalogue lost its models.
    expect(isSearchEmpty([], "zzz", 0)).toBe(false);
    expect(isSearchEmpty([], "", 5)).toBe(false);
    expect(isSearchEmpty([], "zzz", 5)).toBe(true);
  });
});

describe("model picker favourites — the toggle", () => {
  it("appends on star, so the array doubles as most-recent-first", () => {
    expect(toggleFavoriteId([], "a")).toEqual(["a"]);
    expect(toggleFavoriteId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes on unstar, and removes EVERY copy of a duplicated id", () => {
    // A hand-edited store can carry a duplicate; leaving one behind would
    // render a model the user believes they unstarred.
    expect(toggleFavoriteId(["a", "a", "b"], "a")).toEqual(["b"]);
  });

  it("ignores a blank id rather than storing an unreachable row", () => {
    expect(toggleFavoriteId(["a"], "   ")).toEqual(["a"]);
  });

  it("trims the id it is given", () => {
    expect(toggleFavoriteId([], "  a  ")).toEqual(["a"]);
    expect(toggleFavoriteId(["a"], "  a  ")).toEqual([]);
  });

  it("never mutates the array it was handed", () => {
    const current = ["a"];
    toggleFavoriteId(current, "b");
    expect(current).toEqual(["a"]);
  });
});

describe("model picker favourites — the hoisted section", () => {
  it("returns the input unchanged when nothing is starred", () => {
    // The common case must not allocate a section nobody sees.
    const groups = grouped(...CATALOGUE);
    expect(orderModelGroups(groups, [], "收藏", modelKey)).toBe(groups);
  });

  it("hoists a starred model into its own section above the providers", () => {
    const kept = orderModelGroups(
      grouped(...CATALOGUE),
      ["zai/glm-5.3/"],
      "收藏",
      modelKey,
    );
    expect(kept[0]?.id).toBe(FAVORITES_SECTION_ID);
    expect(kept[0]?.label).toBe("收藏");
    expect(kept[0]?.models.map((m) => m.modelId)).toEqual(["glm-5.3"]);
  });

  it("leaves a starred model where the catalogue put it", () => {
    // The reported defect, and it only shows up once two models from one
    // provider are starred: hoisting emptied the provider group, so starring
    // M3 made MiniMax stop listing M3 and the picker quietly offered a smaller
    // catalogue than it had a minute ago. A star is a shortcut, and a shortcut
    // that deletes the long way round is not a shortcut.
    const kept = orderModelGroups(
      grouped(...CATALOGUE),
      ["zai/glm-5.3/"],
      "收藏",
      modelKey,
    );
    const zai = kept.find((group) => group.id === "zai");
    expect(zai?.models.map((m) => m.modelId)).toEqual(["glm-5.3", "glm-4.6"]);
    // Listed twice on purpose: once as the catalogue has it, once as a
    // shortlist. Which is why the repeated row has to say where it came from.
    const all = kept.flatMap((group) => group.models.map((m) => m.modelId));
    expect(all.filter((id) => id === "glm-5.3")).toHaveLength(2);
  });

  it("carries the provider onto every repeated row", () => {
    // Eight names from five providers say nothing about which vendor each one
    // is; a shortlist is how you compare, and comparison needs the vendor.
    const kept = orderModelGroups(
      grouped(...CATALOGUE),
      ["zai/glm-5.3/", "openai_compat/gpt-5/"],
      "收藏",
      modelKey,
    );
    // The group LABEL, not the id — that is the word the group header above the
    // provider's own rows is already using, and a label the reader cannot match
    // to a header is not information.
    expect(kept[0]?.modelOriginLabels).toEqual({
      "zai/glm-5.3/": "zai",
      "openai_compat/gpt-5/": "openai_compat",
    });
    expect(
      orderModelGroups(
        grouped({ ...entry("zai", "glm-5.3"), providerName: "Zhipu AI Coding Plan" }),
        ["zai/glm-5.3/"],
        "收藏",
        modelKey,
      )[0]?.modelOriginLabels,
    ).toEqual({ "zai/glm-5.3/": "Zhipu AI Coding Plan" });
    // …and the provider's own rows carry no label: the group header above them
    // already says it, and saying it twice is noise.
    expect(kept[1]?.modelOriginLabels).toBeUndefined();
  });

  it("never empties a provider group, so never drops one", () => {
    const kept = orderModelGroups(
      grouped(entry("zai", "glm-5.3"), entry("zai", "glm-4.6")),
      ["zai/glm-5.3/", "zai/glm-4.6/"],
      "收藏",
      modelKey,
    );
    expect(kept.map((group) => group.id)).toEqual([
      FAVORITES_SECTION_ID,
      "zai",
    ]);
    expect(kept[1]?.models).toHaveLength(2);
  });

  it("orders the section by the store, not by the catalogue", () => {
    // `toggleFavoriteId` appends, so the persisted array is already
    // most-recent-first and that is the order a person rebuilds a shortlist
    // expecting to read it back in.
    const kept = orderModelGroups(
      grouped(...CATALOGUE),
      ["openai_compat/gpt-5/", "zai/glm-5.3/"],
      "收藏",
      modelKey,
    );
    expect(kept[0]?.models.map((m) => m.modelId)).toEqual([
      "gpt-5",
      "glm-5.3",
    ]);
  });

  it("is safe to re-apply to its own output", () => {
    // A function that quietly eats its own section on a second pass is a trap
    // for the next caller: every starred model would drop on the floor. The
    // origin labels have to survive the pass too — the repeated rows are the
    // ones carrying them, so a second run that resolves every model against the
    // section it just built would strip the provider off all of them.
    const once = orderModelGroups(
      grouped(...CATALOGUE),
      ["zai/glm-5.3/", "openai_compat/gpt-5/"],
      "收藏",
      modelKey,
    );
    const twice = orderModelGroups(
      once,
      ["zai/glm-5.3/", "openai_compat/gpt-5/"],
      "收藏",
      modelKey,
    );
    expect(twice[0]?.id).toBe(FAVORITES_SECTION_ID);
    expect(twice[0]?.models.map((m) => m.modelId)).toEqual([
      "glm-5.3",
      "gpt-5",
    ]);
    expect(twice[0]?.modelOriginLabels).toEqual({
      "zai/glm-5.3/": "zai",
      "openai_compat/gpt-5/": "openai_compat",
    });
    expect(
      twice.flatMap((group) => group.models.map((m) => m.modelId)),
    ).toEqual([
      "glm-5.3",
      "gpt-5",
      "MiniMax-M3",
      "MiniMax-M2.7",
      "glm-5.3",
      "glm-4.6",
      "gpt-5",
    ]);
  });

  it("ignores a starred id the catalogue no longer carries", () => {
    // The store outlives any single catalogue refresh; a model the runtime
    // dropped must not be resurrected as a dead row.
    const groups = grouped(entry("zai", "glm-5.3"));
    expect(orderModelGroups(groups, ["zai/gone/"], "收藏", modelKey)).toBe(groups);
  });

  it("keeps the variant in a row's identity, so a star is about that row", () => {
    // The picker lists the same model twice when it offers an off/on pair.
    const thinking = entry("minimax_api", "MiniMax-M3");
    const plain = { ...entry("minimax_api", "MiniMax-M3"), variant: "" };
    const starred = { ...entry("minimax_api", "MiniMax-M3"), variant: "thinking" };
    const kept = orderModelGroups(
      groupModelsByProvider([thinking, plain, starred]),
      [`minimax_api/MiniMax-M3/thinking`],
      "收藏",
      modelKey,
    );
    expect(kept[0]?.models).toHaveLength(1);
    expect(kept[0]?.models[0]?.variant).toBe("thinking");
  });
});

describe("model picker favourites — persistence", () => {
  it("reads empty when the store is unavailable, without throwing", () => {
    // This suite runs in the `node` environment, so there is no localStorage
    // at all — which is exactly the branch a server render takes.
    expect(readFavoriteModels()).toEqual([]);
    expect(() => writeFavoriteModels(["a"])).not.toThrow();
  });
});

describe("model picker — the star is a sibling of the option", () => {
  const html = renderToStaticMarkup(
    createElement(WebuiModelMenuList, {
      groups: grouped(entry("zai", "glm-5.3", "GLM 5.3")),
      selected: undefined,
      focusedRowId: undefined,
      favoriteKeys: new Set(["zai/glm-5.3/"]),
      onFocus: () => undefined,
      onSelect: () => undefined,
      onToggleFavorite: () => undefined,
    }),
  );

  it("renders a star control carrying its pressed state", () => {
    expect(html).toContain('data-webui-model-star="true"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("keeps the star OUT of the option button", () => {
    // A button nested in the option button is invalid markup, would fire the
    // option's own click handler, and would be unreachable by keyboard. The
    // row wrapper exists for exactly this.
    const optionOpen = html.indexOf('role="option"');
    const optionClose = html.indexOf("</button>", optionOpen);
    const star = html.indexOf('data-webui-model-star="true"');
    expect(optionOpen).toBeGreaterThan(-1);
    expect(star).toBeGreaterThan(optionClose);
  });

  it("gives the star its own accessible name", () => {
    expect(html).toContain('aria-label="取消收藏 GLM 5.3"');
  });
});
