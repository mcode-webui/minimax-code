/**
 * The model picker's settings fly-out.
 *
 * Two tiers share one placement engine. Tier one carries the thinking control
 * and is anchored to a model row; tier two carries the context window's options
 * and is anchored to the context row INSIDE tier one. Both call
 * `useFlyoutPlacement`, which is the whole reason the two cannot disagree about
 * which way they open.
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
} from "react";

import { ToggleSwitch } from "./ToggleSwitch.js";
import {
  flyoutStyle,
  positionFlyout,
  type FlyoutRect,
} from "../projection/flyout-position.js";
import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts.js";

const TIER_ONE_WIDTH = 208;
const TIER_ONE_HEIGHT = 236;
const TIER_TWO_WIDTH = 176;

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
 * Measure an anchor and keep the placement in sync with it.
 *
 * Re-measures on scroll and resize because the anchor is a row inside a
 * scrolling list: a placement computed once would leave the fly-out pointing at
 * wherever the row used to be. `getBoundingClientRect` is viewport-space, which
 * is what `positionFlyout` takes, and is also why the surface is `fixed` — an
 * `absolute` fly-out would be clipped by the list's own `overflow-y: auto`.
 */
function useFlyoutPlacement(
  anchor: FlyoutAnchor | undefined,
  width: number,
  height: number,
): { readonly position: "fixed"; readonly left: string; readonly top: string } | undefined {
  const [style, setStyle] = useState<
    { readonly position: "fixed"; readonly left: string; readonly top: string } | undefined
  >(undefined);

  const measure = useCallback(() => {
    if (!anchor) {
      setStyle(undefined);
      return;
    }
    setStyle(
      flyoutStyle(
        positionFlyout({
          anchor: anchor.element.getBoundingClientRect(),
          surface: { width, height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      ),
    );
  }, [anchor, height, width]);

  useLayoutEffect(() => {
    measure();
    if (!anchor) return undefined;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, measure]);

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
  /** True while the described model is not the active one. */
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
   * Records and LEAVES the surface open: the thinking switch is the first tier
   * and the context window is the second, so closing here would make a level
   * and a window impossible to set in one visit.
   */
  readonly onThinkingChange: (option: string) => void;
  /** Commit a context window. The second tier is where the selection COMPLETES. */
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
  const contextRowRef = useRef<HTMLButtonElement | null>(null);
  const [tierTwoOpen, setTierTwoOpen] = useState(false);
  const [tierTwoAnchor, setTierTwoAnchor] = useState<FlyoutAnchor | undefined>(undefined);

  const style = useFlyoutPlacement(anchor, TIER_ONE_WIDTH, TIER_ONE_HEIGHT);

  // A new row is a new anchor, so the second tier starts closed: leaving it
  // open would show one model's context options beside another model's row.
  useLayoutEffect(() => {
    setTierTwoOpen(false);
    setTierTwoAnchor(undefined);
  }, [anchor]);

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

  const thinkingOn =
    draft.variant !== undefined
      ? draft.variant === "thinking"
      : draft.thinkingEffort === null
        ? false
        : effortOptions.includes("on")
          ? model.thinking?.effort === "on"
          : Boolean(model.thinking?.effort);

  const openTierTwo = () => {
    const element = contextRowRef.current;
    if (!element) return;
    setTierTwoAnchor({ rect: element.getBoundingClientRect(), element });
    setTierTwoOpen(true);
  };

  const closeTierTwo = () => {
    setTierTwoOpen(false);
    setTierTwoAnchor(undefined);
  };

  return (
    <div
      className="webui-model-flyout"
      data-webui-model-flyout="tier-one"
      data-webui-model-preview={preview ? "true" : "false"}
      style={style}
      role="dialog"
      aria-label={`${model.displayName ?? model.modelId} 的设置`}
      aria-live="polite"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Back out ONE tier. The list keeps its position, so a second press
          // can still close the menu from where the user built it up.
          event.stopPropagation();
          closeTierTwo();
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
              disabled={preview}
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
                    disabled={preview}
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
          <button
            ref={contextRowRef}
            type="button"
            disabled={preview}
            aria-expanded={tierTwoOpen}
            aria-haspopup="menu"
            className="webui-model-context-trigger"
            data-webui-model-context-trigger="true"
            onClick={() => (tierTwoOpen ? closeTierTwo() : openTierTwo())}
            onMouseEnter={() => {
              if (!tierTwoOpen) openTierTwo();
            }}
          >
            <span className="webui-model-context-value">
              {formatContextWindow(
                draft.contextLimit ?? model.contextLimit ?? 0,
              )}
            </span>
            <span aria-hidden="true" className="webui-model-context-caret">
              ›
            </span>
          </button>
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
      {tierTwoOpen ? (
        <ContextWindowTier
          anchor={tierTwoAnchor}
          options={contextOptions}
          hints={model.contextWindowOptionHints}
          active={draft.contextLimit}
          preview={preview}
          onRetract={closeTierTwo}
          onPick={(value) => {
            onContextChange(value);
            closeTierTwo();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The second tier: the context window's options, beside the context row.
 *
 * Placed by the SAME `positionFlyout` the first tier uses. That is the point of
 * the shared engine — two copies of the flip/clamp math is how two tiers of one
 * cascade end up opening in different directions.
 */
function ContextWindowTier({
  anchor,
  options,
  hints,
  active,
  preview,
  onRetract,
  onPick,
}: {
  readonly anchor: FlyoutAnchor | undefined;
  readonly options: readonly number[];
  readonly hints: Readonly<Record<string, string>> | undefined;
  readonly active: number | undefined;
  readonly preview: boolean;
  readonly onRetract: () => void;
  readonly onPick: (value: number) => void;
}): ReactElement {
  const style = useFlyoutPlacement(
    anchor,
    TIER_TWO_WIDTH,
    options.length * 32 + 12,
  );
  return (
    <div
      className="webui-model-flyout webui-model-flyout--tier-two"
      data-webui-model-flyout="tier-two"
      style={style}
      role="menu"
      aria-label="上下文窗口"
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "ArrowLeft") {
          event.stopPropagation();
          onRetract();
        }
      }}
    >
      {options.map((value) => {
        const selected = active === value;
        return (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={preview}
            className={`webui-model-context-option ${selected ? "is-active" : ""}`}
            onClick={() => onPick(value)}
          >
            <span className="webui-model-context-value">
              {formatContextWindow(value)}
            </span>
            {hints?.[String(value)] === "higher_usage" ? (
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
  );
}
