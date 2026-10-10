import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  groupModelsByProvider,
  modelIdentity,
  modelKey,
  reconcileFocusedRow,
  rowIdOf,
  WebuiModelMenuList,
  WebuiModelPicker,
} from "../../src/client/components/ModelPicker.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts/model-view.js";

function entry(
  providerId: string,
  modelId: string,
  providerName?: string,
): WebuiModelPickerEntry {
  return {
    providerId,
    modelId,
    displayName: modelId,
    ...(providerName ? { providerName } : {}),
  };
}

describe("model picker — provider grouping", () => {
  it("groups by provider name in catalog order and keeps each group's order", () => {
    const groups = groupModelsByProvider([
      entry("minimax", "M3", "MiniMax"),
      entry("minimax", "M2.7", "MiniMax"),
      entry("deepseek", "v4", "DeepSeek"),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["MiniMax", "DeepSeek"]);
    expect(groups[0]?.models.map((model) => model.modelId)).toEqual([
      "M3",
      "M2.7",
    ]);
    expect(groups[1]?.models.map((model) => model.modelId)).toEqual(["v4"]);
  });

  it("falls back to providerId when the catalog carries no provider name", () => {
    const groups = groupModelsByProvider([
      entry("minimax", "M3"),
      entry("minimax", "M2.7", "   "),
      entry("deepseek", "v4"),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["minimax", "deepseek"]);
    expect(groups[0]?.models).toHaveLength(2);
  });

  it("returns no groups for an empty catalog", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });

  it("keeps the trigger closed until the user opens it", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiModelPicker, {
        models: [entry("minimax", "M3", "MiniMax")],
        selected: undefined,
        onSelect: () => undefined,
        onSettingChange: () => undefined,
      }),
    );

    expect(html).not.toContain('data-webui-model-menu="true"');
    expect(html).toContain("Model");
  });

  it("renders a provider name above each group of options", () => {
    const minimax = entry("minimax", "M3", "MiniMax");
    const groups = groupModelsByProvider([
      minimax,
      entry("minimax", "M2.7", "MiniMax"),
      entry("deepseek", "v4", "DeepSeek"),
    ]);
    const html = renderToStaticMarkup(
      createElement(WebuiModelMenuList, {
        groups,
        selected: minimax,
        focusedRowId: undefined,
        favoriteKeys: new Set<string>(),
        onFocus: () => undefined,
        onSelect: () => undefined,
        onToggleFavorite: () => undefined,
      }),
    );

    // One header per provider, carrying the provider name as text…
    expect(html).toContain(
      '<div class="webui-model-group-header" aria-hidden="true">MiniMax</div>',
    );
    expect(html).toContain(
      '<div class="webui-model-group-header" aria-hidden="true">DeepSeek</div>',
    );
    // …and the same name as the accessible label of the group that owns it.
    expect(html).toContain('role="group" aria-label="MiniMax"');
    expect(html).toContain('role="group" aria-label="DeepSeek"');
    // Options stay `option`s inside their group, in catalog order.
    expect(html.match(/role="option"/gu)).toHaveLength(3);
    expect(html.indexOf("M3")).toBeLessThan(html.indexOf("M2.7"));
    expect(html.indexOf("M2.7")).toBeLessThan(html.indexOf("DeepSeek"));
    expect(html).toContain('aria-selected="true"');
  });
});

// A row's ID is built from the model and the group rendering it, so it is
// re-derived on every commit — including the one the fly-out's own thinking
// switch makes, which flips the variant and so renames the row the panel is
// anchored to. Held as a promise rather than re-derived, the ID names a row
// nobody renders: the highlight goes dark and the fly-out cannot measure, so it
// drops out of the flow it was pinned to. These pin the re-derivation.
describe("model picker — a row's identity survives the row's own settings", () => {
  function variantEntry(
    modelId: string,
    variant?: string,
    providerId = "minimax",
  ): WebuiModelPickerEntry {
    return {
      providerId,
      modelId,
      displayName: modelId,
      ...(variant === undefined ? {} : { variant }),
    };
  }

  it("strips the variant, which is the part the row's own switch rewrites", () => {
    // `variantForEffort` answers "thinking" and "" for the two states, so this
    // is the exact rewrite a press of the switch performs.
    expect(modelIdentity("minimax/M3/thinking")).toBe("minimax/M3");
    expect(modelIdentity("minimax/M3/")).toBe("minimax/M3");
    // A key with no variant to strip is its own identity rather than truncated.
    expect(modelIdentity("M3")).toBe("M3");
  });

  it("hands back the very same row while that row is still on screen", () => {
    // Referential stability, not merely equality: a fresh object every render
    // would rebuild the fly-out's anchor resolver and re-subscribe its scroll
    // and resize listeners on every render.
    const groups = groupModelsByProvider([variantEntry("M3", "thinking")]);
    const focused = { key: "minimax/M3/thinking", rowId: rowIdOf("minimax", "minimax/M3/thinking") };

    expect(reconcileFocusedRow(focused, groups)).toBe(focused);
  });

  it("re-points the row that switching its own thinking off renamed", () => {
    // The whole bug in one step: the catalogue said `thinking`, the switch said
    // "", and the row the panel described went out from under it.
    const before = groupModelsByProvider([variantEntry("M3", "thinking")]);
    const focused = { key: "minimax/M3/thinking", rowId: rowIdOf("minimax", "minimax/M3/thinking") };
    const after = groupModelsByProvider([variantEntry("M3")]);

    expect(rowIdOf("minimax", "minimax/M3/thinking")).not.toBe(
      rowIdOf("minimax", "minimax/M3/"),
    );
    expect(reconcileFocusedRow(focused, before)).toBe(focused);

    const next = reconcileFocusedRow(focused, after);
    expect(next?.rowId).toBe(rowIdOf("minimax", "minimax/M3/"));
    expect(next?.key).toBe("minimax/M3/");
    // …and the ID it hands back names a row that is actually rendered, which is
    // the whole point: it is what the fly-out looks the element up by.
    expect(
      after
        .flatMap((group) => group.models)
        .some((model) => rowIdOf("minimax", modelKey(model)) === next?.rowId),
    ).toBe(true);
  });

  it("prefers the same model re-homed into another group over a different variant", () => {
    // Both are the same model, so both are plausible answers; the exact one is
    // not, because the user was on THAT line.
    const focused = { key: "minimax/M3/thinking", rowId: rowIdOf("old", "minimax/M3/thinking") };
    const groups = groupModelsByProvider([
      variantEntry("M3"),
      variantEntry("M3", "thinking"),
    ]);

    const next = reconcileFocusedRow(focused, groups);
    expect(next?.rowId).toBe(rowIdOf("minimax", "minimax/M3/thinking"));
  });

  it("leaves the row alone when that row is genuinely gone", () => {
    // A search keystroke removes rows and retracts the panel itself. Pointing
    // the panel at a DIFFERENT row to cover for the missing one would move it
    // onto a line the pointer never reached.
    const focused = { key: "minimax/M3/thinking", rowId: rowIdOf("minimax", "minimax/M3/thinking") };
    const groups = groupModelsByProvider([variantEntry("M2.7")]);

    expect(reconcileFocusedRow(focused, groups)).toBe(focused);
  });

  it("has nothing to reconcile without a focused row", () => {
    expect(reconcileFocusedRow(undefined, groupModelsByProvider([variantEntry("M3")]))).toBeUndefined();
    expect(reconcileFocusedRow(undefined, [])).toBeUndefined();
  });
});
