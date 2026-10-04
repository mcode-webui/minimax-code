import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  groupModelsByProvider,
  WebuiModelMenuList,
  WebuiModelPicker,
} from "../../src/client/components/ModelPicker.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts.js";

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
        focusedKey: undefined,
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
