import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { WebuiModelListPanel } from "../../src/client/features/models/ui/ModelListPanel.js";
import { WebuiModelPicker } from "../../src/client/features/models/ui/ModelPicker.public.js";
import {
  groupModelsByProvider,
  modelKey,
} from "../../src/client/features/models/projection/model-picker-rows.js";
import type { WebuiModelPickerEntry } from "../../src/client/features/models/contracts/model-view.js";

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

  it("keys a group by its provider id, never by its label", () => {
    // Two providers are free to share a display name, and keying on it would
    // make the second one a duplicate-key render.
    const groups = groupModelsByProvider([
      entry("minimax", "M3", "Same Name"),
      entry("deepseek", "v4", "Same Name"),
    ]);

    expect(groups.map((group) => group.id)).toEqual(["minimax", "deepseek"]);
    expect(groups.map((group) => group.label)).toEqual(["Same Name", "Same Name"]);
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

  it("names the model and its level on the chip", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiModelPicker, {
        models: [entry("minimax", "M3", "MiniMax")],
        selected: entry("minimax", "M3", "MiniMax"),
        triggerLevel: "高",
        onSelect: () => undefined,
        onSettingChange: () => undefined,
      }),
    );

    expect(html).toContain("M3");
    expect(html).toContain('data-webui-model-chip-level="true"');
    expect(html).toContain("高");
  });

  it("renders a provider name above each group of options", () => {
    const minimax = entry("minimax", "M3", "MiniMax");
    const groups = groupModelsByProvider([
      minimax,
      entry("minimax", "M2.7", "MiniMax"),
      entry("deepseek", "v4", "DeepSeek"),
    ]);
    const html = renderToStaticMarkup(
      createElement(WebuiModelListPanel, {
        groups,
        selected: minimax,
        onSelect: () => undefined,
        onBack: () => undefined,
      }),
    );

    // One header per provider, carrying the provider name and, under it, the
    // provider id it answers to…
    expect(html).toContain(
      '<span class="webui-model-list-group-name">MiniMax</span>',
    );
    expect(html).toContain(
      '<span class="webui-model-list-group-subtitle">minimax</span>',
    );
    expect(html).toContain(
      '<span class="webui-model-list-group-name">DeepSeek</span>',
    );
    expect(html).toContain(
      '<span class="webui-model-list-group-subtitle">deepseek</span>',
    );
    // …and the rows stay in catalog order, under their own provider.
    expect(html.match(/webui-model-list-row-name/gu)).toHaveLength(3);
    expect(html.indexOf("M3")).toBeLessThan(html.indexOf("M2.7"));
    expect(html.indexOf("M2.7")).toBeLessThan(html.indexOf("DeepSeek"));
  });

  it("marks the model in use with the tick, and only that one", () => {
    const minimax = entry("minimax", "M3", "MiniMax");
    const html = renderToStaticMarkup(
      createElement(WebuiModelListPanel, {
        groups: groupModelsByProvider([
          minimax,
          entry("minimax", "M2.7", "MiniMax"),
        ]),
        selected: minimax,
        onSelect: () => undefined,
        onBack: () => undefined,
      }),
    );

    expect(html.match(/webui-model-list-row-check/gu)).toHaveLength(1);
    // The row is the shared selectable-row: its selected state is `aria-pressed`.
    expect(html).toContain(`aria-pressed="true"`);
    expect(html).toContain(`data-webui-model-list-row="${modelKey(minimax)}"`);
  });
});
