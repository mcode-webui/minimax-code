// The panel's SECOND state: the catalogue, grouped by provider.
//
//   ┌───────────────────────────────┐
//   │ 选择模型                    ‹  │
//   │ OpenAI                        │
//   │ openai                        │
//   │   GPT-6.1 Sol                  │
//   │   GPT-6 Astra                  │
//   │   GPT-6 Luna              ✓    │
//   │ Anthropic                     │
//   │ anthropic                     │
//   │   Claude …                     │
//   └───────────────────────────────┘
//
// It is the same popup as the panel state, with its content swapped, not a
// second popup beside the first. That is the whole reason the picker works:
// two popups meant two dismissal listeners racing for the same pointerdown,
// and the one that won retracted a layer before the click landed — which is
// what made a model row feel unclickable.
//
// The list is the catalogue in the catalogue's own order, grouped by provider.
// Nothing is hoisted above the providers and nothing is filtered out of them,
// so the row a pointer is on stays the row it was on.

import type { ReactElement } from "react";

import { WebuiIconCheck } from "../../../shell/icons.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";
import type {
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
} from "../contracts/model-view.js";
import { modelKey } from "../projection/model-picker-rows.js";

export interface WebuiModelListPanelProps {
  readonly groups: readonly WebuiModelProviderGroup[];
  /** The model in use, which carries the tick. */
  readonly selected: WebuiModelPickerEntry | undefined;
  /** Choose a model. */
  readonly onSelect: (model: WebuiModelPickerEntry) => void;
  /** Retained for callers that provide the legacy secondary-panel action. */
  readonly onBack?: () => void;
}

export function WebuiModelListPanel({
  groups,
  selected,
  onSelect,
}: WebuiModelListPanelProps): ReactElement {
  const selectedKey = selected ? modelKey(selected) : undefined;
  return (
    <WebuiStack gap="medium" className="webui-model-list" data-webui-model-list="true">
      <div className="webui-model-list-head">
        <span className="webui-model-list-title">选择模型</span>
      </div>
      <WebuiStack gap="medium" className="webui-model-list-groups">
        {groups.length === 0 ? (
          <p className="webui-model-list-empty">没有可用模型</p>
        ) : null}
        {groups.map((group) => (
          <WebuiStack
            gap="tight"
            key={group.id}
            className="webui-model-list-group"
            data-webui-model-list-group={group.id}
          >
            <WebuiStack as="div" gap="micro" align="start" className="webui-model-list-group-header">
              <span className="webui-model-list-group-name">{group.label}</span>
              <span className="webui-model-list-group-subtitle">{group.id}</span>
            </WebuiStack>
            {group.models.map((model) => {
              const active = modelKey(model) === selectedKey;
              return (
                <WebuiButton
                  variant="selectable-row"
                  size="regular"
                  key={modelKey(model)}
                  className={`webui-model-list-row ${active ? "is-active" : ""}`}
                  data-webui-model-list-row={modelKey(model)}
                  aria-pressed={active}
                  onClick={() => onSelect(model)}
                >
                  <span className="webui-model-list-row-name">
                    {model.displayName ?? model.modelId}
                  </span>
                  {active ? (
                    <span className="webui-model-list-row-check">
                      <WebuiIconCheck />
                    </span>
                  ) : null}
                </WebuiButton>
              );
            })}
          </WebuiStack>
        ))}
      </WebuiStack>
    </WebuiStack>
  );
}
