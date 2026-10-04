/**
 * The model picker's settings fly-out. ONE tier.
 *
 * Hovering a model row flies out a surface carrying the thinking control and
 * the context window's sizes, and the sizes are IN PLACE in that surface. The
 * earlier shape put them one tier deeper, behind a collapsed row that restated
 * the current value and carried a chevron — and that was one affordance too
 * many in each direction. The fly-out already says which model it describes, so
 * a row restating the current value, an arrow over it, and then a separate
 * panel carrying the same values are three ways to answer one question; and the
 * third of them was a floating panel landing back on top of the model list it
 * was describing, so choosing a window meant covering the rows to choose a
 * different model from.
 *
 * The list IS the answer: every size the model offers is readable as the
 * fly-out opens, the recorded one carries the ✓, and a previewed model carries
 * none — the record belongs to the ACTIVE model, so there is nothing to mark.
 *
 * Why a fly-out rather than the permanent right column this replaced: the
 * reference reserves no width for settings, and a column puts one model's
 * controls on screen permanently — next to a row the user could have simply
 * clicked. The old panel also rendered the same controls twice, once editable
 * in the column and once read-only in a panel-bottom area, and two renderings
 * of "which level is this model on" is a contradiction waiting to happen rather
 * than a second view.
 *
 * The container is an `aria-live="polite"` region so a keyboard user hears the
 * controls appear. When a model has nothing to describe, the empty state prints
 * the MODEL NAME before the sentence — announcing the bare sentence would leave
 * a screen-reader user asking which model it was about.
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ToggleSwitch } from "./ToggleSwitch.js";
import {
  flyoutStyle,
  positionFlyout,
  type FlyoutRect,
} from "../projection/flyout-position.js";
import { resolveThinkingVerdict } from "../projection/thinking-control.js";
import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts.js";

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** A measured anchor, in viewport space. */
export interface FlyoutAnchor {
  readonly rect: FlyoutRect;
  readonly element: HTMLElement;
}

/**
 * Measure an anchor and keep the placement in sync with both of them.
 *
 * The SURFACE is measured rather than declared. It used to be two constants,
 * and a constant is only right while the surface's contents are fixed — but the
 * context sizes are listed inline now, so the surface is as tall as the model
 * happens to have options: a model with four sizes is a different height from
 * one with two, and neither matches the number a constant froze at. A clamp
 * computed against a stale height lets the bottom of the list fall off screen,
 * which is how a model with a long option list loses its own options.
 *
 * `ResizeObserver` on the surface is what keeps that honest as the fly-out
 * follows the cursor from one model to the next. Re-measuring on scroll and
 * resize is still needed because the anchor is a row inside a scrolling list: a
 * placement computed once would leave the fly-out pointing at wherever the row
 * used to be. `getBoundingClientRect` is viewport-space, which is what
 * `positionFlyout` takes, and is also why the surface is `fixed` — an
 * `absolute` fly-out would be clipped by the list's own `overflow-y: auto`.
 */
function useFlyoutPlacement(
  anchor: FlyoutAnchor | undefined,
  surfaceRef: RefObject<HTMLElement | null>,
): { readonly position: "fixed"; readonly left: string; readonly top: string } | undefined {
  const [style, setStyle] = useState<
    { readonly position: "fixed"; readonly left: string; readonly top: string } | undefined
  >(undefined);

  const measure = useCallback(() => {
    const surface = surfaceRef.current;
    if (!anchor || !surface) {
      setStyle(undefined);
      return;
    }
    // Measured BEFORE the placement style is applied, so this is the surface's
    // natural size. That is the size the clamp arithmetic needs, and applying
    // it cannot change it back.
    const rect = surface.getBoundingClientRect();
    setStyle(
      flyoutStyle(
        positionFlyout({
          anchor: anchor.element.getBoundingClientRect(),
          surface: { width: rect.width, height: rect.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      ),
    );
  }, [anchor, surfaceRef]);

  useLayoutEffect(() => {
    measure();
    const surface = surfaceRef.current;
    if (!anchor || !surface) return undefined;
    // Following the cursor from row to row changes the surface's HEIGHT without
    // changing the anchor, so the observer is on the surface, not the anchor.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(surface);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, measure, surfaceRef]);

  return style;
}

export interface ModelSettingsFlyoutProps {
  readonly model: WebuiModelPickerEntry | undefined;
  /**
   * The thinking options, already resolved by the caller.
   *
   * Passed in rather than derived here on purpose: resolution is a fact about
   * the model CONTRACT (a `switchable` thinking config with both an empty and a
   * non-empty variant is a binary on/off, per `resolveEffortOptions` in
   * `ModelPicker.tsx`), and the fly-out is presentation. Re-deriving it here
   * would give the two places to disagree about when a model is binary.
   */
  readonly effortOptions: readonly string[];
  /** The context window's options, already resolved by the caller. */
  readonly contextOptions: readonly number[];
  readonly anchor: FlyoutAnchor | undefined;
  readonly draft: WebuiModelPickerDraft;
  /**
   * True while the described model is not the active one.
   *
   * Carried on the surface as state, NOT as a gate. Every control here is a way
   * of picking the row this panel describes, so disabling them until the row was
   * already picked made the panel read-only for exactly the case it was opened
   * for: the user hovering a model they had not yet chosen, to see what it
   * offers. They had to click the row first to unlock it, and then the fly-out
   * had saved them nothing over editing the panel's own column.
   */
  readonly preview: boolean;
  /**
   * Commit a thinking change, carrying the chosen option VERBATIM.
   *
   * "default", "on" and a depth level are three different shapes of commit —
   * one resets the effort to the model's configured default, one flips the
   * wire variant, one records a level — and which shape applies is a fact about
   * the model contract, not about how the control is drawn. So the fly-out
   * reports the option and `ModelPicker` does the mapping.
   *
   * Records and LEAVES the surface open: a level and a window are meant to be
   * adjusted in one visit, and closing here would make that impossible.
   */
  readonly onThinkingChange: (option: string) => void;
  /**
   * Commit a context window. Choosing a window is a COMMITMENT rather than a
   * mid-visit edit, so this is where the selection completes — the caller
   * closes the picker, unlike `onThinkingChange`.
   */
  readonly onContextChange: (value: number) => void;
  /** Escape from inside the fly-out: retract the tier, keep the list. */
  readonly onRetract: () => void;
}

export function ModelSettingsFlyout({
  model,
  effortOptions,
  contextOptions,
  anchor,
  draft,
  preview,
  onThinkingChange,
  onContextChange,
  onRetract,
}: ModelSettingsFlyoutProps): ReactElement | null {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const style = useFlyoutPlacement(anchor, surfaceRef);

  if (!model) return null;

  const isBinary =
    effortOptions.length === 2 &&
    effortOptions.includes("off") &&
    effortOptions.includes("on");

  // A recorded level the target model does not advertise highlights NOTHING.
  // Silently falling back to "default" would pretend the engine default is
  // picked, which is the same anti-stale rule the row badge applies.
  const recordedEffort = draft.thinkingEffort;
  const currentEffort = (() => {
    if (recordedEffort === undefined) return "default";
    if (recordedEffort === null) return "default";
    return effortOptions.includes(recordedEffort) ? recordedEffort : undefined;
  })();

  // One verdict, read from the field that carries it and shared with the
  // composer's brain trigger. This used to re-derive it locally from the
  // recorded effort alone, which never changes for a two-state model — the
  // switch commits a VARIANT — so this toggle sat off no matter what the
  // composer said. Two controls answering "is thinking on" from two different
  // fields is how the toolbar and the fly-out end up disagreeing.
  //
  // `null` is a stated choice ("engine decides"), so the draft's own value wins
  // over the model's whenever it is anything but `undefined`.
  const draftEffort =
    draft.thinkingEffort !== undefined
      ? draft.thinkingEffort
      : (model.thinking?.effort ?? null);
  const stateVariant = draft.variant !== undefined ? draft.variant : model.variant;
  const thinkingOn =
    resolveThinkingVerdict(effortOptions, {
      ...(stateVariant !== undefined ? { variant: stateVariant } : {}),
      thinkingEffort: draftEffort,
    }) === true;

  // The recorded window, and only when the model actually offers it. A recorded
  // value the target model does not advertise highlights NOTHING — silently
  // falling back to the first option would put a ✓ on a size the model does not
  // have, which is the same anti-stale rule the thinking row applies.
  const currentWindow = (() => {
    const recorded = draft.contextLimit ?? model.contextLimit;
    return typeof recorded === "number" && contextOptions.includes(recorded)
      ? recorded
      : undefined;
  })();

  return (
    <div
      ref={surfaceRef}
      className="webui-model-flyout"
      data-webui-model-flyout="tier-one"
      data-webui-model-preview={preview ? "true" : "false"}
      style={style}
      role="dialog"
      aria-label={`${model.displayName ?? model.modelId} 的设置`}
      aria-live="polite"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Back to the list. There is no tier left to retract, so the whole
          // fly-out goes and the list keeps its position — a second press can
          // still close the menu from where the user built it up.
          event.stopPropagation();
          onRetract();
        }
      }}
    >
      {effortOptions.length > 0 ? (
        <div className="webui-model-detail-row webui-model-setting-effort">
          <span className="webui-model-detail-label">推理等级</span>
          {isBinary ? (
            <ToggleSwitch
              checked={thinkingOn}
              label="推理等级"
              data-webui-model-thinking-toggle="true"
              className="webui-model-thinking-toggle"
              onChange={() => onThinkingChange(thinkingOn ? "off" : "on")}
            />
          ) : (
            <div
              role="radiogroup"
              aria-label="推理等级"
              className="webui-model-effort-group"
            >
              {effortOptions.map((option) => {
                const active = currentEffort === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className="webui-model-effort-option"
                    onClick={() => onThinkingChange(option)}
                  >
                    {option}
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="webui-model-context-tick"
                      >
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {contextOptions.length > 0 ? (
        <div className="webui-model-detail-row webui-model-setting-context">
          <span className="webui-model-detail-label">上下文窗口</span>
          {/*
            The sizes, in place. NOT a collapsed row that opens a second
            fly-out: the surface already says which model it describes, so a
            row restating the current value, a chevron over it, and then a
            panel carrying the same sizes were three ways to answer one
            question — and the panel was a floating surface landing back over
            the model list it was describing.
          */}
          <div
            role="listbox"
            aria-label="上下文窗口"
            className="webui-model-context-group"
          >
            {contextOptions.map((value) => {
              const selected = currentWindow === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`webui-model-context-option ${selected ? "is-active" : ""}`}
                  data-webui-model-context-option={String(value)}
                  onClick={() => onContextChange(value)}
                >
                  <span className="webui-model-context-value">
                    {formatContextWindow(value)}
                  </span>
                  {model.contextWindowOptionHints?.[String(value)] === "higher_usage" ? (
                    <span className="webui-model-context-hint">用量较高</span>
                  ) : null}
                  {selected ? (
                    <span
                      aria-hidden="true"
                      className="webui-model-context-tick"
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {effortOptions.length === 0 && contextOptions.length === 0 ? (
        <div className="webui-model-detail-empty">
          <div className="webui-model-detail-empty-title">
            {model.displayName ?? model.modelId}
          </div>
          <div className="webui-model-detail-empty-hint">
            这个模型没有可调设置。
          </div>
        </div>
      ) : null}
    </div>
  );
}
