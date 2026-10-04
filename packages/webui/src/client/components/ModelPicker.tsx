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

function resolveEffortOptions(
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
    const hasOff = variants.includes("");
    const hasOn = variants.some((variant) => Boolean(variant));
    if (hasOff && hasOn) return ["off", "on"];
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

function variantForEffort(
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
  onSelect,
  onToggleFavorite,
}: {
  readonly groups: readonly WebuiModelProviderGroup[];
  readonly selected: WebuiModelPickerEntry | undefined;
  readonly focusedKey: string | undefined;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly onFocus: (key: string) => void;
  readonly onSelect: (model: WebuiModelPickerEntry) => void;
  readonly onToggleFavorite: (key: string) => void;
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
              <div key={key} className="webui-model-option-row">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-focused={isFocused ? "true" : "false"}
                  className="webui-model-option"
                  onMouseEnter={() => onFocus(key)}
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
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<readonly string[]>([]);
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, WebuiModelPickerDraft>>
  >({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const searchId = useId();

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

  const updateFocusedDraft = (patch: Partial<WebuiModelPickerDraft>) => {
    if (!focusedModel) return;
    const next: WebuiModelPickerDraft = {
      ...drafts[focusedKeyString],
      ...patch,
    };
    setDrafts((current) => ({ ...current, [focusedKeyString]: next }));
    onSettingChange(focusedModel, next);
  };

  const handleSelectModel = (model: WebuiModelPickerEntry) => {
    const draft = drafts[modelKey(model)] ?? {};
    setOpen(false);
    setFocusedKey(undefined);
    onSelect(model, draft);
  };

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
        <span className="min-w-0 max-w-[220px] truncate whitespace-nowrap">
          {triggerText}
        </span>
        <WebuiIconChevronDown className="flex-shrink-0 text-icon_default_tertiary" />
      </button>
      {open ? (
        <div
          role="dialog"
          id={menuId}
          aria-labelledby={triggerId}
          data-webui-model-menu="true"
          className="webui-model-menu webui-model-menu--two-column"
        >
          <div className="webui-model-menu-column">
            <div className="webui-model-menu-search">
              <label className="webui-model-search-field" htmlFor={searchId}>
                <span className="sr-only">搜索模型</span>
                <input
                  id={searchId}
                  type="search"
                  autoFocus
                  value={query}
                  placeholder="搜索模型…"
                  aria-label="搜索模型"
                  className="webui-model-search-input"
                  data-webui-model-search="true"
                  onChange={(event) => setQuery(event.currentTarget.value)}
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
                onSelect={handleSelectModel}
                onToggleFavorite={handleToggleFavorite}
              />
            )}
          </div>
          <div className="webui-model-menu-detail" aria-live="polite">
            {focusedModel ? (
              <>
                {focusedEffortOptions.length > 0 ? (
                  <div className="webui-model-detail-row webui-model-setting-effort">
                    <span className="webui-model-detail-label">推理等级</span>
                    {focusedEffortOptions.length === 2 &&
                    focusedEffortOptions.includes("off") &&
                    focusedEffortOptions.includes("on") &&
                    resolveThinkingMode(focusedModel) === "switchable" ? (
                      <ToggleSwitch
                        checked={focusedEffort === "on"}
                        label="推理等级"
                        data-webui-model-thinking-toggle="true"
                        className="webui-model-thinking-toggle"
                        onChange={() => {
                          if (!focusedModel) return;
                          const next = focusedEffort === "on" ? "off" : "on";
                          const variant = variantForEffort(focusedModel, next);
                          updateFocusedDraft({
                            ...(variant !== undefined ? { variant } : {}),
                          });
                        }}
                      />
                    ) : (
                      <div
                        role="radiogroup"
                        aria-label="推理等级"
                        className="webui-model-effort-group"
                      >
                        {focusedEffortOptions.map((option) => {
                          const active = focusedEffort === option;
                          return (
                            <button
                              key={option}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              className="webui-model-effort-option"
                              onClick={() => {
                                if (!focusedModel) return;
                                const variant = variantForEffort(
                                  focusedModel,
                                  option,
                                );
                                updateFocusedDraft({
                                  ...(variant !== undefined ? { variant } : {}),
                                  ...(option === "default"
                                    ? { thinkingEffort: null }
                                    : option === "off" || option === "on"
                                      ? {}
                                      : { thinkingEffort: option }),
                                });
                              }}
                            >
                              {option}
                              {active ? (
                                <span aria-hidden="true" className="webui-model-context-tick">✓</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
                {focusedContextOptions.length > 0 ? (
                  <div className="webui-model-detail-row webui-model-setting-context">
                    <span className="webui-model-detail-label">上下文窗口</span>
                    <div
                      role="radiogroup"
                      aria-label="上下文窗口"
                      className="webui-model-context-group"
                    >
                      {focusedContextOptions.map((value) => {
                        const active = focusedContextLimit === value;
                        const hint =
                          focusedModel.contextWindowOptionHints?.[
                            String(value)
                          ];
                        return (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={`webui-model-context-option ${active ? "is-active" : ""}`}
                            onClick={() => {
                              if (!focusedModel) return;
                              updateFocusedDraft({ contextLimit: value });
                            }}
                          >
                            <span className="webui-model-context-value">
                              {formatContextWindow(value)}
                            </span>
                            {hint === "higher_usage" ? (
                              <span className="webui-model-context-hint">
                                用量较高
                              </span>
                            ) : null}
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
                  </div>
                ) : null}
                {focusedEffortOptions.length === 0 &&
                focusedContextOptions.length === 0 ? (
                  <div className="webui-model-detail-empty">
                    <div className="webui-model-detail-empty-title">
                      {focusedModel.displayName ?? focusedModel.modelId}
                    </div>
                    <div className="webui-model-detail-empty-hint">
                      这个模型没有可调设置。
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="webui-model-detail-empty">选择一个模型查看设置</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
