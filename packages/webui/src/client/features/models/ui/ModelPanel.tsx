// The panel's FIRST state: the model in use, and its thinking scale.
//
//   ┌───────────────────────────────┐
//   │            高          ↺      │
//   │      GPT-6 Luna  ›            │
//   │  上下文窗口  200K   1M   ✓    │
//   │  ●━━━●━━━◉━━━━○━━━━○           │
//   └───────────────────────────────┘
//
// It shows ONE model, because that is the question the panel is opened to
// answer: which model, and how hard. The other models are one click away — the
// model name opens the list state of this same panel, so there is never a
// second popup to dismiss and never a hover to wait out.
//
// The level word names the position the thumb is on, the reset puts the level
// back where the engine decides it, and the context window appears only for a
// model that has windows to choose from.

import { useState, type ReactElement } from "react";
import { IconRefresh } from "@tabler/icons-react";

import { WebuiIconChevronRight } from "../../../shell/icons.js";
import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts/model-view.js";
import {
  currentEffortValue,
  effortResetOption,
  effortScaleFor,
  isBinaryEffort,
} from "../projection/effort-scale.js";
import { effortLabel } from "../projection/thinking-control.public.js";
import { WebuiModelEffortSlider } from "./ModelEffortSlider.js";

/** The window's size, as it is written on the button: `200K`, `1M`. */
export function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export interface WebuiModelPanelProps {
  /** The model in use. */
  readonly model: WebuiModelPickerEntry | undefined;
  /** The settings being edited, when they differ from the model's own. */
  readonly draft: WebuiModelPickerDraft;
  /** Open the list state of this panel. */
  readonly onOpenList: () => void;
  /** Commit a level. */
  readonly onEffortChange: (option: string) => void;
  /** Put the level back where the engine decides it. */
  readonly onResetEffort: () => void;
  /** Commit a context window. */
  readonly onContextLimitChange: (contextLimit: number) => void;
}

export function WebuiModelPanel({
  model,
  draft,
  onOpenList,
  onEffortChange,
  onResetEffort,
  onContextLimitChange,
}: WebuiModelPanelProps): ReactElement {
  const [previewLevel, setPreviewLevel] = useState<string | undefined>();
  const scale = effortScaleFor(model);
  const currentLevel = currentEffortValue(model, draft);
  const level = previewLevel ?? currentLevel;
  const levelLabel = scale.disabled ? "" : effortLabel(level);
  const contextOptions = model?.contextWindowOptions ?? [];
  const recordedContext =
    draft.contextLimit ?? model?.contextLimit;
  const modelName =
    model?.displayName ??
    (model ? `${model.providerId}/${model.modelId}` : "未选择模型");
  // The reset is only meaningful where there is something to reset: a level
  // that already sits where the reset would put it has nothing to put back.
  const canReset = !scale.disabled && level !== effortResetOption(model);

  return (
    <div className="webui-model-panel" data-webui-model-panel="true">
      <div className="webui-model-panel-head">
        <span
          className="webui-model-panel-level"
          data-ultra={level === "max" ? "true" : "false"}
          data-webui-model-panel-level="true"
        >
          {levelLabel}
        </span>
        <button
          type="button"
          className="webui-model-panel-reset"
          data-webui-model-panel-reset="true"
          aria-label="重置思考等级"
          title="重置思考等级"
          disabled={!canReset}
          onClick={onResetEffort}
        >
          <IconRefresh aria-hidden="true" size={16} stroke={1.4} />
        </button>
      </div>

      <button
        type="button"
        className="webui-model-panel-model"
        data-webui-model-panel-model="true"
        onClick={onOpenList}
      >
        <span className="webui-model-panel-model-name">{modelName}</span>
        <WebuiIconChevronRight className="webui-model-panel-model-chevron" />
      </button>

      {contextOptions.length > 0 ? (
        <div
          className="webui-model-panel-context"
          data-webui-model-panel-context="true"
        >
          <span className="webui-model-panel-context-label">上下文窗口</span>
          {contextOptions.map((value) => {
            const active =
              typeof recordedContext === "number" &&
              recordedContext === value;
            // The catalog's word for a window that bills as the heavier
            // choice. The hint is keyed by the option's own value, so it can
            // only ever annotate a size the row already shows — and a model
            // whose catalog states none renders the size alone.
            const higherUsage =
              model?.contextWindowOptionHints?.[String(value)] ===
              "higher_usage";
            return (
              <button
                key={String(value)}
                type="button"
                className={`webui-model-panel-context-option ${active ? "is-active" : ""}`}
                data-webui-model-context-option={String(value)}
                onClick={() => onContextLimitChange(value)}
              >
                {formatContextWindow(value)}
                {higherUsage ? (
                  <span className="webui-model-panel-context-option-hint">
                    较高用量
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <WebuiModelEffortSlider
        scale={scale}
        value={currentLevel}
        binary={isBinaryEffort(model)}
        onCommit={onEffortChange}
        onPreviewChange={setPreviewLevel}
      />
    </div>
  );
}
