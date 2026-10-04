/**
 * Composer-side model picker. Mirrors the desktop's two-column popover:
 *
 *   ┌─ models ──────────┬─ detail ──────────────────┐
 *   │ ● MiniMax-M3       │ 上下文窗口                 │
 *   │   MiniMax-M2.7-…   │ 512K                      │
 *   │   MiniMax-M2.7     │ 1M                    ✓   │
 *   │   OpenCode Go      ├─ 推理等级                 │
 *   │                    │ default                   │
 *   └────────────────────┴───────────────────────────┘
 *
 * Model choices and their settings share a compact vertical menu. Selecting a
 * model closes the menu; changing thinking or context immediately commits the
 * focused model's draft through the same `selectModel` operation.
 *
 * The model column is grouped by provider: each group renders a plain provider
 * name above its rows — no nested menu, no second level. Grouping follows the
 * catalog's own order, so the first provider listed stays on top.
 *
 * Drafts live in a `useState` map keyed by `providerId/modelId/variant` so a
 * setting remains responsive while the runtime refreshes its model catalog.
 * The runtime projection is the source of truth after the menu is reopened.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { WebuiIconChevronDown } from "../icons.js";
import { ToggleSwitch } from "./ToggleSwitch.js";
import type {
  WebuiModelPickerDraft,
  WebuiModelPickerEntry,
} from "../contracts.js";
import { evaluateOutsideClose } from "../projection/outside-close.js";
import {
  filterModelGroups,
  isSearchEmpty,
} from "../projection/model-picker-search.js";
import {
  orderModelGroups,
  readFavoriteModels,
  toggleFavoriteId,
  writeFavoriteModels,
} from "../projection/model-favorites.js";
import {
  isPreview,
  rowHasFlyout,
  type CascadeTier,
} from "../projection/model-picker-cascade.js";
import {
  MODEL_FLYOUT_HOVER_DELAY_MS,
  hoverArrival,
} from "../projection/model-picker-hover.js";
import {
  ModelSettingsFlyout,
  type FlyoutAnchor,
} from "./ModelSettingsFlyout.js";

// Re-export so existing importers keep their import path stable.
export type { WebuiModelPickerDraft, WebuiModelPickerEntry };

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
   * once for the composer's brain trigger — deriving it a second time here
   * would give two places to disagree about whether this model has a depth
   * scale, and the disagreement would show as a chip claiming a level the
   * brain beside it says nothing about.
   */
  readonly triggerLevel?: string;
}

export interface WebuiModelProviderGroup {
  /**
   * Stable identity for the group: the provider id, or `FAVORITES_SECTION_ID`
   * for the starred section. This is what React keys on and what the search
   * filter keeps order by — NOT `label`, because two providers are free to
   * share a display name and keying on it would make the second one a
   * duplicate-key render.
   */
  readonly id: string;
  readonly label: string;
  readonly models: readonly WebuiModelPickerEntry[];
}

/** Group label: the provider's display name, falling back to its id. */
function providerGroupLabel(model: WebuiModelPickerEntry): string {
  const name = model.providerName?.trim();
  return name || model.providerId;
}

/**
 * Groups by provider, keeping the catalog's own order — the same grouping the
 * TUI picker applies (see `packages/tui/src/tui/features/model/picker.ts`).
 *
 * Buckets on `providerId` and carries the display name alongside, rather than
 * bucketing on the name itself. Same visible result for the ordinary case
 * where every provider has a distinct name, and the right result for the
 * case where two do not.
 */
export function groupModelsByProvider(
  models: readonly WebuiModelPickerEntry[],
): readonly WebuiModelProviderGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, WebuiModelPickerEntry[]>();
  const labels = new Map<string, string>();
  for (const model of models) {
    const id = model.providerId;
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.push(model);
      continue;
    }
    buckets.set(id, [model]);
    labels.set(id, providerGroupLabel(model));
    order.push(id);
  }
  return order.map((id) => ({
    id,
    label: labels.get(id) ?? id,
    models: buckets.get(id) ?? [],
  }));
}

/**
 * The stable identity of one row: `providerId/modelId/variant`.
 *
 * The variant is part of the key because the picker lists the same model
 * twice when it offers an off/on pair, and a star on one of them is a
 * statement about that row, not about the model name.
 */
export function modelKey(model: WebuiModelPickerEntry): string {
  return `${model.providerId}/${model.modelId}/${model.variant ?? ""}`;
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function resolveEffortOptions(
  model: WebuiModelPickerEntry,
): readonly string[] {
  const explicit = model.effortOptions ?? [];
  if (explicit.length > 0) {
    return explicit.includes("default") ? explicit : ["default", ...explicit];
  }
  // The runtime reports switchable thinking via `thinkingConfig.mode` +
  // `supportedVariants`. Treat any model that supports both an empty and a
  // non-empty variant as a binary "off / on" toggle so the picker still
  // surfaces the control without the runtime having to fill `effortOptions`.
  if (model.thinkingConfig?.mode === "switchable") {
    const variants = model.supportedVariants ?? [];
    const hasOff = variants.includes("") || variants.includes("none-thinking");
    const hasOn = variants.some((variant) => variant && variant !== "none-thinking");
    // `default_value` is the runtime's own statement that this model has a
    // thinking switch, and it reaches the client on `thinkingConfig` even when
    // the variant list does not. Trusting it means the brain icon does not
    // depend on a second field arriving intact.
    const declaredSwitch = model.thinkingConfig?.default_value !== undefined;
    if ((hasOff && hasOn) || declaredSwitch) return ["off", "on"];
  }
  return [];
}

function resolveCurrentEffort(model: WebuiModelPickerEntry): string | undefined {
  const options = resolveEffortOptions(model);
  if (options.length === 0) return undefined;
  const thinking = model.thinking?.effort?.trim();
  if (thinking && options.includes(thinking)) return thinking;
  if (options.includes("default")) return "default";
  const defaultEffort = model.defaultEffort?.trim();
  if (defaultEffort && options.includes(defaultEffort)) return defaultEffort;
  return model.variant === "thinking"
    ? options.includes("on")
      ? "on"
      : options[0]
    : options[0];
}

function resolveThinkingMode(
  model: WebuiModelPickerEntry,
): "switchable" | "forced_on" | "forced_off" | undefined {
  return model.thinkingConfig?.mode as
    | "switchable"
    | "forced_on"
    | "forced_off"
    | undefined;
}

export function variantForEffort(
  model: WebuiModelPickerEntry,
  effort: string,
): string | undefined {
  const options = resolveEffortOptions(model);
  if (options.length === 0) return undefined;
  const thinkingOn = options.includes("on");
  if (thinkingOn && (effort === "on" || effort === "off")) {
    return effort === "on" ? "thinking" : "";
  }
  // Multi-level efforts (low/high/max, …) are not part of the wire variant;
  // their value is carried by the thinking.effort selection instead.
  return undefined;
}

/**
 * The model column. A group header is a line of text, not an option: it lives
 * inside a `role="group"`, which carries the name through `aria-label`, so the
 * visible text is hidden from assistive technology.
 *
 * The star is a SIBLING of the option button, never a child. A button inside
 * the option button would be invalid nesting, would make the option's own
 * click handler fire when the star was pressed, and would leave a keyboard
 * user unable to reach the star at all. The row is therefore a wrapper that
 * owns the layout, and the option keeps the width it had before.
 */
export function WebuiModelMenuList({
  groups,
  selected,
  focusedKey,
  favoriteKeys,
  onFocus,
  onHoverIntent,
  onHoverLeave,
  onSelect,
  onToggleFavorite,
  onRowMount,
}: {
  readonly groups: readonly WebuiModelProviderGroup[];
  readonly selected: WebuiModelPickerEntry | undefined;
  readonly focusedKey: string | undefined;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly onFocus: (key: string) => void;
  /**
   * The pointer ARRIVED on this row. Opens the fly-out if the pointer rests.
   *
   * Separate from `onFocus` on purpose, and the split is the whole point:
   * `onFocus` is the row's highlight, which is the list answering "where is
   * the pointer" and has to be instant, while this is the list CLAIMING
   * something about the row. A claim that fires on contact makes sweeping the
   * pointer down a list throw a panel after every row it crosses.
   *
   * Optional so a caller that renders rows without a cascade (the search tests
   * do) does not have to pass a no-op.
   */
  readonly onHoverIntent?: (key: string) => void;
  /**
   * The pointer LEFT this row. Cancels a pending open and nothing else: the
   * panel is itself a hover region, and the pointer is usually on its way into
   * it, so an open panel is left standing.
   */
  readonly onHoverLeave?: (key: string) => void;
  readonly onSelect: (model: WebuiModelPickerEntry) => void;
  readonly onToggleFavorite: (key: string) => void;
  /**
   * Report each row's element so the caller can anchor the fly-out to it.
   *
   * A callback ref rather than a prop-drilled map: the rows mount and unmount
   * as the list filters, and an element the caller cannot measure is a fly-out
   * with nothing to point at.
   */
  readonly onRowMount?: (key: string, element: HTMLElement | null) => void;
}): ReactElement {
  return (
    <div role="listbox" aria-label="Model" className="webui-model-menu-list">
      {groups.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={group.label}
          className="webui-model-menu-group"
        >
          <div className="webui-model-group-header" aria-hidden="true">
            {group.label}
          </div>
          {group.models.map((model) => {
            const key = modelKey(model);
            const isSelected = selected ? modelKey(selected) === key : false;
            const isFocused = focusedKey === key;
            const isFavorite = favoriteKeys.has(key);
            const name =
              model.displayName ??
              `${model.providerId}/${model.modelId}`;
            return (
              <div
                key={key}
                className="webui-model-option-row"
                ref={(element) => onRowMount?.(key, element)}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-focused={isFocused ? "true" : "false"}
                  className="webui-model-option"
                  onMouseEnter={() => {
                    onHoverIntent?.(key);
                    onFocus(key);
                  }}
                  onMouseLeave={() => onHoverLeave?.(key)}
                  onFocus={() => onFocus(key)}
                  onClick={() => onSelect(model)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {name}
                  </span>
                  {isSelected ? (
                    <span
                      aria-hidden="true"
                      className="webui-model-option-tick"
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-pressed={isFavorite}
                  aria-label={`${isFavorite ? "取消收藏" : "收藏"} ${name}`}
                  title={isFavorite ? "取消收藏" : "收藏"}
                  className="webui-model-option-star"
                  data-webui-model-star="true"
                  onClick={() => onToggleFavorite(key)}
                >
                  <span aria-hidden="true">{isFavorite ? "★" : "☆"}</span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function WebuiModelPicker({
  models,
  selected,
  onSelect,
  onSettingChange,
  triggerLabel,
  triggerLevel,
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [tier, setTier] = useState<CascadeTier>("list");
  const [query, setQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<readonly string[]>([]);
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, WebuiModelPickerDraft>>
  >({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * Every mounted row, so the fly-out can measure the one it is anchored to.
   *
   * A ref map rather than React state: the fly-out re-measures on scroll, and
   * a scroll must not re-render the whole list just to update a rectangle.
   */
  const rowElements = useRef(new Map<string, HTMLElement>());
  /**
   * The pending fly-out, if the pointer is resting on a row.
   *
   * Held in a ref rather than state because it is not something to render: it
   * exists only so that leaving the row, taking the interaction elsewhere, or
   * closing the menu can call it off before it pays out. A `setTimeout` id in
   * state would re-render the whole list every time the pointer moved.
   */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The catalogue a timer callback resolves its row against.
   *
   * The callback closes over the render that created it, so a plain `models`
   * lookup would resolve the row against whatever the catalogue was when the
   * pointer ARRIVED — up to `MODEL_FLYOUT_HOVER_DELAY_MS` stale, and the
   * runtime refreshes that catalogue underneath an open menu on its own.
   */
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const triggerId = useId();
  const menuId = useId();
  const searchId = useId();

  /**
   * Call off a hover that has not been paid for yet.
   *
   * Every path that takes the interaction away from the rows — leaving a row,
   * the search box taking focus, a keystroke re-filtering the list, Escape, the
   * menu closing — routes through here, so a panel cannot open for a pointer
   * that is no longer on the row that asked for it.
   */
  const clearPendingHover = () => {
    if (hoverTimer.current === null) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  /**
   * Put the fly-out away, and forget which row it was describing.
   *
   * Used when the interaction moves somewhere that is not a row. The row is
   * forgotten along with the panel because a remembered row with no panel is
   * what makes the NEXT panel describe a model the user has not gone back to.
   */
  const retractFlyout = () => {
    clearPendingHover();
    setTier("list");
    setFocusedKey(undefined);
  };

  // Keep the local mirror through model-catalog refreshes while the menu is
  // open; each setting change is also committed immediately to the runtime.
  // Drop the mirror on close so reopening always starts from persisted state.
  useEffect(() => {
    if (open) return;
    setDrafts({});
  }, [open]);

  // The query does not survive a close. A picker that reopens still filtered
  // to three rows from a search the user has forgotten they typed reads as a
  // catalogue that lost models, which is a scarier bug than the one the reset
  // avoids.
  useEffect(() => {
    if (open) return;
    setQuery("");
  }, [open]);

  // Reopening starts at the list tier. A picker that reopens one tier deep into
  // a fly-out for a row the user has not re-hovered would be showing controls
  // with no row to explain them.
  useEffect(() => {
    if (open) return;
    retractFlyout();
  }, [open]);

  // A hover still waiting out its delay when the menu goes away must not open a
  // panel on a picker that is no longer showing. Separate from the effect above
  // because that one is about the tier a REOPEN starts at.
  useEffect(() => clearPendingHover, []);

  // Read the stars when the menu OPENS rather than on mount: the store is the
  // only writer, and re-reading on open is what makes a star applied in
  // another tab of the same picker show up. Reading during the first render
  // would also mean a server render and a client render disagreed.
  useEffect(() => {
    if (!open) return;
    setFavoriteIds(readFavoriteModels());
  }, [open]);

  const handleToggleFavorite = (key: string) => {
    setFavoriteIds((current) => {
      const next = toggleFavoriteId(current, key);
      writeFavoriteModels(next);
      return next;
    });
  };

  // Close on outside pointerdown.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: PointerEvent) => {
      if (!rootRef.current) return;
      const insideContainer = rootRef.current.contains(event.target as Node);
      // The four-surface outside-close policy lives in
      // `projection/outside-close.ts`; ModelPicker's per-surface variant
      // subscribes to `pointerdown` only (no keydown listener). Routing
      // through `evaluateOutsideClose` keeps the four call sites
      // consistent without changing the original close semantics.
      if (
        evaluateOutsideClose({
          surface: "modelPicker",
          kind: "pointerdown",
          insideContainer,
        }) === "close"
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  const focusedModel = useMemo<WebuiModelPickerEntry | undefined>(() => {
    const key = focusedKey ?? (selected ? modelKey(selected) : undefined);
    if (!key) return undefined;
    return models.find((model) => modelKey(model) === key) ?? selected;
  }, [focusedKey, models, selected]);

  const focusedKeyString = focusedModel ? modelKey(focusedModel) : "";
  const focusedDraft: WebuiModelPickerDraft =
    focusedModel ? (drafts[focusedKeyString] ?? {}) : {};

  const handleSelectModel = (model: WebuiModelPickerEntry) => {
    const draft = drafts[modelKey(model)] ?? {};
    onSelect(model, draft);
    // A click means "this is the one", and it finishes. The settings are a
    // hover away — hovering the row is a second away from here, and the row the
    // pointer is on is the one being clicked — so there is nothing left to
    // visit, and keeping the menu open would strand the user on a surface they
    // have already answered.
    setOpen(false);
    setFocusedKey(undefined);
  };

  /**
   * Open the fly-out for whichever row the pointer is on.
   *
   * Only for a row that HAS something to configure. Hovering a model with
   * nothing to configure must not summon an empty panel — a fly-out with no
   * controls in it is a worse answer than no fly-out, and there is nothing to
   * learn from it. `rowHasFlyout` is the "does this model have settings" test,
   * kept separate from `rowClickOutcome` because a click no longer varies by
   * model while the fly-out still does.
   *
   * Also the landing place for the keyboard, which reaches here directly and so
   * opens the panel without waiting out a hover delay: arrowing into a row is a
   * decision, not a pass over it.
   */
  const handleHoverRow = (key: string) => {
    // Whatever hover was pending is this one now, whether it came from the
    // pointer's delay or from the keyboard.
    clearPendingHover();
    const model = modelsRef.current.find((entry) => modelKey(entry) === key);
    if (!model) return;
    setFocusedKey(key);
    // A row with nothing to configure retracts the fly-out rather than
    // leaving the previous row's panel up: the panel would then describe a
    // model the pointer has already left.
    setTier(rowHasFlyout(model) ? "settings" : "list");
  };

  /**
   * The pointer arrived on a row. Open its panel only if the pointer rests.
   *
   * The rules are in `hoverArrival`; the two things worth reading here are why
   * the retract happens NOW rather than after the delay, and why the highlight
   * is not part of this. The retract is immediate because the highlight moves
   * on this very mouse event (the list calls `onFocus` alongside this), so a
   * panel left standing would re-anchor itself to the row the pointer has only
   * just passed over — the old model's settings, sliding onto a new model,
   * before the user has read either.
   */
  const handleHoverIntent = (key: string) => {
    const model = modelsRef.current.find((entry) => modelKey(entry) === key);
    const arrival = hoverArrival({
      key,
      focusedKey,
      tier,
      hasFlyout: rowHasFlyout(model),
    });
    // The panel already describes this row — the pointer has just crossed back
    // out of it. Retracting here closes the panel under the pointer.
    if (arrival === "keep-open") return;
    clearPendingHover();
    setTier("list");
    if (arrival === "retract-only") return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      handleHoverRow(key);
    }, MODEL_FLYOUT_HOVER_DELAY_MS);
  };

  /**
   * The pointer left a row. Cancel the pending open, leave an open panel.
   *
   * The asymmetry is the point, not an oversight: the panel is a hover region
   * of its own, and leaving a row is the normal first step of moving INTO it.
   * A panel that retracts on that crossing cannot be clicked, which is the
   * whole reason the fly-out exists. The panel does still go when the pointer
   * arrives on another row, when the search box takes over, and on Escape.
   */
  const handleHoverLeave = () => {
    clearPendingHover();
  };

  // Escape backs out ONE tier: the first press retracts the fly-out and leaves
  // the list, the second closes the menu. Handled here rather than through the
  // outside-close policy table because that table answers "does this surface
  // dismiss", and the fly-out is INSIDE the picker's container — it is a tier
  // of one surface, not a surface of its own.
  const handleRetract = () => {
    // Escape is an answer, so a hover still counting down is a hover the user
    // has already made irrelevant.
    clearPendingHover();
    setTier((current) => {
      if (current === "settings") {
        setFocusedKey(undefined);
        return "list";
      }
      setOpen(false);
      return "list";
    });
  };

  const selectedKeyString = selected ? modelKey(selected) : undefined;
  // Whether the fly-out describes a model other than the active one. It changes
  // what the panel SHOWS and nothing about what it lets the user do: a click
  // inside the fly-out is how that row gets picked, so gating the controls on it
  // made the panel a dead end that could only be read — the user had to click
  // the row first to unlock it, which is the step the fly-out exists to save.
  const flyoutIsPreview = isPreview(focusedKeyString, selectedKeyString);
  const flyoutAnchor =
    focusedKeyString && tier === "settings"
      ? (() => {
          const element = rowElements.current.get(focusedKeyString);
          if (!element) return undefined;
          return { rect: element.getBoundingClientRect(), element };
        })()
      : undefined;

  // Order matters and is deliberate: filter FIRST, then hoist. Hoisting on the
  // unfiltered list would keep a starred model visible while the user is
  // searching for something else, which is the one thing a search must not do.
  // The other order would also mean the favourites section is rebuilt on every
  // keystroke even when no star is in the result set.
  const groupedModels = useMemo(() => {
    const grouped = groupModelsByProvider(models);
    const filtered = filterModelGroups(grouped, query);
    return orderModelGroups(filtered, favoriteIds, "收藏", modelKey);
  }, [models, query, favoriteIds]);

  /**
   * Move the focused row by `delta` through the VISIBLE rows, and return where
   * focus ended up.
   *
   * Exists because the menu no longer autofocuses its search field. The arrows
   * used to work by virtue of that field holding focus; without an explicit
   * handler here, dropping the autofocus would have silently taken the keyboard
   * with it, which is the trade this change must not make.
   *
   * Walks `groupedModels` rather than the raw catalogue, so a row the search
   * filter has hidden is not a row the arrow keys can land on. The first
   * ArrowDown from nothing focused enters at the top, which is what someone
   * opening a picker and pressing Down expects.
   *
   * Lands through the same `handleHoverRow` the pointer uses. Arrowing and
   * hovering are the same act — "this row is the one I am looking at" — and
   * routing them separately is how a keyboard user ends up unable to see the
   * settings a mouse user sees on the same row.
   */
  const moveFocusedRow = (delta: number) => {
    const keys = groupedModels.flatMap((group) => group.models.map(modelKey));
    if (keys.length === 0) return;
    const current = focusedKeyString ? keys.indexOf(focusedKeyString) : -1;
    // From nothing focused, Down enters at the top and Up at the bottom, so
    // both keys are useful from the start rather than one of them doing
    // nothing.
    const next = current === -1
      ? (delta > 0 ? 0 : keys.length - 1)
      : Math.min(keys.length - 1, Math.max(0, current + delta));
    const key = keys[next];
    if (key === undefined) return;
    handleHoverRow(key);
    rowElements.current.get(key)?.scrollIntoView({ block: "nearest" });
  };

  const favoriteKeys = useMemo(
    () => new Set(favoriteIds),
    [favoriteIds],
  );
  const searchIsEmpty = isSearchEmpty(groupedModels, query, models.length);

  const triggerText =
    selected?.displayName ??
    (selected ? `${selected.providerId}/${selected.modelId}` : undefined) ??
    triggerLabel ??
    "Model";

  const focusedEffort = (() => {
    if (!focusedModel) return undefined;
    if (focusedDraft.thinkingEffort !== undefined) {
      if (focusedDraft.thinkingEffort !== null)
        return focusedDraft.thinkingEffort;
      return "default";
    }
    if (focusedDraft.variant !== undefined) {
      // The user has committed an "off" draft → variant === "" → effort "off".
      return focusedDraft.variant === "thinking" ? "on" : "off";
    }
    return resolveCurrentEffort(focusedModel);
  })();

  const focusedContextLimit = (() => {
    if (!focusedModel) return undefined;
    if (focusedDraft.contextLimit !== undefined)
      return focusedDraft.contextLimit;
    return focusedModel.contextLimit;
  })();

  const focusedEffortOptions = focusedModel
    ? resolveEffortOptions(focusedModel)
    : [];
  const focusedContextOptions = focusedModel?.contextWindowOptions ?? [];

  /**
   * Commit a thinking option, in whichever shape that option implies.
   *
   * "default" RESETS the effort to the model's configured default (null, not
   * the empty string — the wire distinguishes them), "on"/"off" flip the wire
   * VARIANT rather than recording a level, and a depth level records itself.
   * Splitting these three is the reason the option is reported verbatim by the
   * fly-out instead of being pre-mapped there.
   *
   * It SELECTS the model. Same reasoning as `handleContextChange`: the fly-out
   * belongs to a row, so choosing a level inside it is a statement about that
   * row. Unlike a window, though, a level is a mid-visit edit — the user may
   * still want a window next, and this panel is flat precisely so both fit in
   * one visit — so the menu stays open and the row carries the tick.
   */
  const handleThinkingChange = (option: string) => {
    if (!focusedModel) return;
    const variant = variantForEffort(focusedModel, option);
    const draft: WebuiModelPickerDraft = {
      ...focusedDraft,
      ...(variant !== undefined ? { variant } : {}),
      ...(option === "default"
        ? { thinkingEffort: null }
        : option === "off" || option === "on"
          ? {}
          : { thinkingEffort: option }),
    };
    setDrafts((current) => ({ ...current, [focusedKeyString]: draft }));
    onSettingChange(focusedModel, draft);
    onSelect(focusedModel, draft);
  };

  /**
   * Commit a context window. This CLOSES: picking a window is the commitment
   * that completes the selection, where a level is a mid-visit edit.
   *
   * It also SELECTS the model. The fly-out belongs to a row, and choosing an
   * option inside it is a statement about that row — a user who picks "1M" next
   * to M3 has chosen M3, and leaving the row unselected while closing the menu
   * made the action read as "changed a setting" and left the tick beside a
   * model they had just picked out of step. The row click is the same two calls
   * in a different order, so both routes to a finished selection look alike.
   */
  const handleContextChange = (value: number) => {
    if (!focusedModel) return;
    const draft: WebuiModelPickerDraft = {
      ...focusedDraft,
      contextLimit: value,
    };
    setDrafts((current) => ({ ...current, [focusedKeyString]: draft }));
    onSettingChange(focusedModel, draft);
    onSelect(focusedModel, draft);
    setOpen(false);
    setFocusedKey(undefined);
  };

  return (
    <div
      ref={rootRef}
      className="webui-model-selector"
      data-webui-model-selector="true"
    >
      <button
        type="button"
        id={triggerId}
        className="webui-model-selector-trigger"
        aria-label="Model"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={models.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-baseline gap-[6px]">
          <span className="min-w-0 truncate whitespace-nowrap">
            {triggerText}
          </span>
          {/*
            The level, named where the model is named. A depth scale has a
            POSITION to state and the brain's on/off colour cannot state one, so
            the word rides the model name in the muted colour instead of a
            second copy of it sitting two controls away. The name truncates and
            this does not: a long provider-prefixed name losing its tail is
            fine, a level word half-clipped is not.
          */}
          {triggerLevel ? (
            <span
              className="shrink-0 text-icon_default_tertiary"
              data-webui-model-chip-level="true"
            >
              {triggerLevel}
            </span>
          ) : null}
        </span>
        <WebuiIconChevronDown className="flex-shrink-0 text-icon_default_tertiary" />
      </button>
      {open ? (
        <div
          role="dialog"
          id={menuId}
          aria-labelledby={triggerId}
          data-webui-model-menu="true"
          data-webui-model-tier={tier}
          className="webui-model-menu webui-model-menu--cascade"
          onKeyDown={(event) => {
            // The fly-out stops propagation on its own Escape, so reaching here
            // means focus is on the list: one more press closes the menu.
            if (event.key === "Escape") handleRetract();
          }}
        >
          <div className="webui-model-menu-column">
            <div className="webui-model-menu-search">
              <label className="webui-model-search-field" htmlFor={searchId}>
                <span className="sr-only">搜索模型</span>
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  placeholder="搜索模型…"
                  aria-label="搜索模型"
                  className="webui-model-search-input"
                  data-webui-model-search="true"
                  onChange={(event) => {
                    // A keystroke re-filters the list, and the row the open
                    // panel was anchored to may be one of the rows that just
                    // went. Its element unmounts, the anchor stops resolving,
                    // and the panel is left describing a model the user can no
                    // longer see. The search box taking the interaction is the
                    // same act either way: nothing here is a row the pointer
                    // is on.
                    retractFlyout();
                    setQuery(event.currentTarget.value);
                  }}
                  onFocus={() => {
                    // Focusing the search box is the user asking a different
                    // question, and the fly-out is the answer to the previous
                    // one. Left up it covers the very results the search was
                    // opened to read.
                    retractFlyout();
                  }}
                  onKeyDown={(event) => {
                    // The menu opens WITHOUT focus, so the search field is
                    // reachable by Tab rather than by autofocus — and autofocus
                    // is what it used to do. Focusing the field on open is wrong
                    // for a menu whose first job is picking from a short list:
                    // it drops a caret and a blinking cursor into a text box
                    // nobody asked to type in, and typing then filters the list
                    // by accident.
                    //
                    // "No autofocus" must not mean "no keyboard", so the arrows
                    // that used to work by virtue of the field holding focus now
                    // work here explicitly. Caret movement inside the field is
                    // left alone: this is a single-line search box, and stealing
                    // Left/Right would break editing a query.
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    event.preventDefault();
                    moveFocusedRow(event.key === "ArrowDown" ? 1 : -1);
                  }}
                />
              </label>
            </div>
            {searchIsEmpty ? (
              <div className="webui-model-search-empty">没有匹配的模型</div>
            ) : (
              <WebuiModelMenuList
                groups={groupedModels}
                selected={selected}
                focusedKey={focusedKeyString || undefined}
                favoriteKeys={favoriteKeys}
                onFocus={setFocusedKey}
                onHoverIntent={handleHoverIntent}
                onHoverLeave={handleHoverLeave}
                onSelect={handleSelectModel}
                onToggleFavorite={handleToggleFavorite}
                onRowMount={(key, element) => {
                  if (element) rowElements.current.set(key, element);
                  else rowElements.current.delete(key);
                }}
              />
            )}
          </div>
        </div>
      ) : null}
      {open && tier === "settings" ? (
        <ModelSettingsFlyout
          model={focusedModel}
          effortOptions={focusedEffortOptions}
          contextOptions={focusedContextOptions}
          anchor={flyoutAnchor}
          draft={focusedDraft}
          preview={flyoutIsPreview}
          onThinkingChange={handleThinkingChange}
          onContextChange={handleContextChange}
          onRetract={handleRetract}
        />
      ) : null}
    </div>
  );
}
