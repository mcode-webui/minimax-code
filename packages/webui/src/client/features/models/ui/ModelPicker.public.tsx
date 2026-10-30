/**
 * Composer-side model picker: ONE popup with TWO states.
 *
 *   ┌─ panel ──────────────┐      ┌─ list ─────────────────┐
 *   │            高    ↺    │      │ 选择模型                │
 *   │      GPT-6 Luna  ›    │  →   │ ── OpenAI ──            │
 *   │  ●━━━●━━━◉━━━○━━━○     │  ←   │   GPT-6.1 Sol            │
 *   └───────────────────────┘      │   GPT-6 Luna        ✓    │
 *                                  └─────────────────────────┘
 *
 * The two states are the same popup with its content swapped, not a popup
 * beside a popup. That is the fix for the picker feeling broken: the cascade
 * had two popups, each with the shared skeleton's own dismissal listener, so a
 * pointerdown on a model row was claimed by the fly-out first — it retracted a
 * layer, the DOM was rebuilt, and the click landed on whatever had taken the
 * row's place. The user saw a control that did nothing, and the only thing
 * that brought it back was a reload.
 *
 * One popup means one dismissal, one Escape ladder and one place the list can
 * be: the state that swaps content cannot be reordered under the pointer,
 * because the content is a snapshot taken when the popup opened.
 *
 * The chip names the model and its level. The panel owns the level: it is the
 * one place a thinking level is set, and it is set by a slider whose stops are
 * the model's own.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";

import { WebuiIconChevronDown, WebuiIconModel } from "../../../shell/icons.js";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
} from "../contracts/model-view.js";
import { resolveModelDraftSelection } from "../projection/model-draft.js";
import { effortResetOption } from "../projection/effort-scale.js";
import { groupModelsByProvider } from "../projection/model-picker-rows.js";
import { WebuiModelListPanel } from "./ModelListPanel.js";
import { WebuiModelPanel } from "./ModelPanel.js";

// Re-export so existing importers keep their import path stable.
export type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
  WebuiModelProviderGroup,
};

export interface ModelPickerProps {
  readonly models: readonly WebuiModelPickerEntry[];
  readonly selected: WebuiModelPickerEntry | undefined;
  readonly onSelect: (
    model: WebuiModelPickerEntry,
    draft: WebuiModelPickerDraft,
  ) => void;
  readonly onSettingChange: (
    model: WebuiModelPickerEntry,
    draft: WebuiModelPickerDraft,
  ) => void;
  readonly triggerLabel?: string;
  /**
   * The thinking level the chip names beside the model, or `undefined`.
   *
   * Passed in rather than derived here because "which shape is this model's
   * thinking" is a fact about the model CONTRACT, and it is already resolved
   * once for the composer's chip — deriving it a second time here would give
   * two places to disagree about whether this model has a depth scale, and the
   * disagreement would show as a chip claiming a level the panel says nothing
   * about.
   */
  readonly triggerLevel?: string;
}

/** Which of the popup's two states is on screen. */
type PickerView = "panel" | "list";

export function WebuiModelPicker({
  models,
  selected,
  onSelect,
  onSettingChange,
  triggerLabel,
  triggerLevel,
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("panel");
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);
  /**
   * The catalogue as it was when the popup opened.
   *
   * A snapshot, not a live projection: the catalogue is re-read in the
   * background, and a list that re-orders while it is open moves the row a
   * pointer was on. The snapshot is taken when the popup opens and released
   * when it closes.
   */
  const [groups, setGroups] = useState<readonly WebuiModelProviderGroup[]>([]);
  /** The settings being edited, when they differ from the model's own. */
  const [draft, setDraft] = useState<WebuiModelPickerDraft>({});
  const triggerId = useId();
  const escapeRef = useRef(false);

  const close = useCallback(() => {
    setOpen(false);
    // The dropdown keeps this popup mounted while its exit animation runs.
    // Preserve the current view during that window; resetting to the panel
    // here makes an outside dismissal flash the first-level content before
    // the popup disappears. `handleOpen` starts the next visit at the panel.
    setIsViewTransitioning(false);
    setDraft({});
  }, []);

  const handleOpen = useCallback(() => {
    setGroups(groupModelsByProvider(models));
    setView("panel");
    setIsViewTransitioning(false);
    setOpen(true);
  }, [models]);

  /**
   * One dismissal, two answers.
   *
   * A press outside ends the visit; an Escape walks back one step, from the
   * list to the panel and from the panel to nothing. The ladder is inside ONE
   * popup, so there is no second listener that could answer the same key
   * first.
   */
  const handleDismiss = useCallback(() => {
    // The Escape is consumed here, whatever this dismissal answers: a mark
    // left behind would make the NEXT press outside look like an Escape, and
    // the list would step back to the panel instead of closing.
    const wasEscape = escapeRef.current;
    escapeRef.current = false;
    if (wasEscape && view === "list") {
      setView("panel");
      setIsViewTransitioning(true);
      return;
    }
    close();
  }, [close, view]);

  /**
   * Commit a level.
   *
   * ONE write: the model in use is re-selected with the new level, which is
   * the same `selectModel` the model list uses. The old cascade fired that
   * write twice — once as a settings change and once as a selection — and two
   * answers to one press is how a panel ends up showing a level nobody chose.
   */
  const handleEffortChange = useCallback(
    (option: string) => {
      if (!selected) return;
      const resolution = resolveModelDraftSelection({
        model: selected,
        draft,
        change: { kind: "thinking", option },
      });
      setDraft(resolution.draft);
      onSettingChange(selected, resolution.draft);
    },
    [draft, onSettingChange, selected],
  );

  /**
   * Put the level back where it rests by default.
   *
   * The default is a position, not the absence of one: a depth scale returns
   * to "the engine decides", and a switch returns to the position the runtime
   * itself declares. Committing "default" to a switch would move nothing —
   * the switch's state is the variant, and the default stop is not one of its
   * two.
   */
  const handleResetEffort = useCallback(() => {
    if (!selected) return;
    const resolution = resolveModelDraftSelection({
      model: selected,
      draft,
      change: { kind: "thinking", option: effortResetOption(selected) },
    });
    setDraft(resolution.draft);
    onSettingChange(selected, resolution.draft);
  }, [draft, onSettingChange, selected]);

  /**
   * Commit a context window.
   *
   * A window is a commitment rather than a level: it ends the visit, the same
   * way it did in the fly-out, so a user who picks a window is not left
   * wondering whether it took.
   */
  const handleContextLimitChange = useCallback(
    (contextLimit: number) => {
      if (!selected) return;
      const resolution = resolveModelDraftSelection({
        model: selected,
        draft,
        change: { kind: "context", value: contextLimit },
      });
      setDraft(resolution.draft);
      onSettingChange(selected, resolution.draft);
      close();
    },
    [close, draft, onSettingChange, selected],
  );

  /** Choose a model from the list. */
  const handleSelectModel = useCallback(
    (model: WebuiModelPickerEntry) => {
      const resolution = resolveModelDraftSelection({
        model,
        draft: {},
        change: { kind: "select" },
      });
      setDraft(resolution.draft);
      onSelect(model, resolution.draft);
      close();
    },
    [close, onSelect],
  );

  const triggerText =
    selected?.displayName ??
    (selected ? `${selected.providerId}/${selected.modelId}` : undefined) ??
    triggerLabel ??
    "Model";

  const popup = useMemo(() => {
    if (view === "list") {
      return (
        <WebuiModelListPanel
          groups={groups}
          selected={selected}
          onSelect={handleSelectModel}
        />
      );
    }
    return (
      <WebuiModelPanel
        model={selected}
        draft={draft}
        onOpenList={() => {
          setView("list");
          setIsViewTransitioning(true);
        }}
        onEffortChange={handleEffortChange}
        onResetEffort={handleResetEffort}
        onContextLimitChange={handleContextLimitChange}
      />
    );
  }, [
    draft,
    groups,
    handleContextLimitChange,
    handleEffortChange,
    handleResetEffort,
    handleSelectModel,
    selected,
    view,
  ]);

  return (
    <div className="webui-model-selector" data-webui-model-selector="true">
      <WebuiDropdown
        open={open}
        onOpen={handleOpen}
        onClose={handleDismiss}
        // Managed (ADR 0028 § Overlay coordination). The popup keeps its ladder of
        // its own, and the ladder is driven by the event rather than by a route of
        // its own: a dismissal aimed at this layer arrives as `request-close`, and
        // the layer reads the event to decide whether that press was the Escape key
        // (walk back one step) or a press outside (end the visit).
        managed
        managedLayerId="model-picker"
        onManagedRoute={(route, event) => {
          if (route !== "request-close") return;
          if (event?.kind === "escape" && view === "list") {
            // One step back: the list returns to the panel without closing.
            setView("panel");
            setIsViewTransitioning(true);
            return;
          }
          // The panel is the last step, and a press outside skips the ladder.
          escapeRef.current = false;
          close();
        }}
        role="dialog"
        // The panel is named by the control that opens it, which is the same
        // one the skeleton's trigger props name — `id` below is this id, so
        // there is one id and not two that could disagree.
        labelledBy={triggerId}
        // Above the trigger, centred on it, twelve pixels of air: where
        // the panel has always opened. `flip` opens it downwards when there is
        // no room above, so a trigger near the top of the window still shows
        // its panel.
        side="top"
        align="center"
        offset={12}
        placementKey={view}
        collision="flip"
        className="webui-model-menu"
        popupDataAttributes={{
          "data-webui-model-menu": "true",
          "data-webui-model-view": view,
          "data-webui-model-transitioning": isViewTransitioning
            ? "true"
            : "false",
        }}
        trigger={(triggerProps) => {
          // The popup is measured against this button by default, and every
          // trigger prop is spread onto it: they are all DOM attributes, or
          // the ref the skeleton focuses when Escape closes the menu.
          const buttonProps = triggerProps;
          return (
            <button
              type="button"
              {...buttonProps}
              id={triggerId}
              className="webui-model-selector-trigger"
              aria-label="Model"
              // The trigger's narrow form is a glyph, so the model it stands
              // for has to stay reachable: the hover affordance carries the
              // name the visible label would have carried (ADR 0025).
              title={selected ? triggerText : undefined}
            >
              <span className="webui-model-trigger-icon">
                <WebuiIconModel />
              </span>
              <span className="flex min-w-0 items-baseline gap-[6px]">
                <span className="webui-model-trigger-label min-w-0 truncate whitespace-nowrap">
                  {triggerText}
                </span>
                {/*
                  The level, named where the model is named. A depth scale has a
                  POSITION to state and a colour cannot state one, so the word
                  rides the model name in the muted colour instead of a second
                  copy of it sitting two controls away. The name truncates and
                  this does not: a long provider-prefixed name losing its tail is
                  fine, a level word half-clipped is not.
                */}
                {triggerLevel ? (
                  <span
                    className="shrink-0 text-icon_default_tertiary"
                    data-ultra={triggerLevel === "Ultra" ? "true" : "false"}
                    data-webui-model-chip-level="true"
                  >
                    {triggerLevel}
                  </span>
                ) : null}
              </span>
              <WebuiIconChevronDown className="webui-model-trigger-chevron flex-shrink-0 text-icon_default_tertiary" />
            </button>
          );
        }}
      >
        <div
          className="webui-model-popup"
          data-webui-model-popup="true"
        >
          {popup}
        </div>
      </WebuiDropdown>
    </div>
  );
}
