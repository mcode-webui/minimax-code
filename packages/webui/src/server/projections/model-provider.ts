// The webui's projection of the runtime's provider rows.
//
// The runtime's capability declares this read as `readonly Record<string,
// unknown>[]`; `ModelProviderView` in `local-runtime-v2`'s model-system
// contracts is where the real fields live, and `process-local-application.ts`'s
// `toProviderRecord` is what puts `configRevision` and names-only
// `headerNames` on them. The wire contract promises `WebuiModelProviderView`,
// so this module is the seam that makes that promise true.
//
// Nothing here is a cast: every field is read through a type guard, so a host
// that stops sending one produces a row with that field absent rather than a
// payload the browser believes. The model rows are kept whole, because a
// reorder or a toggle re-sends them and a projection that dropped a field would
// silently erase that model's configuration.
//
// Raw saved credential values are not among the fields read: the runtime sends
// `hasApiKey` and a masked key, and the editor reconstructs a saved header row
// from its name.

import type {
  WebuiModelCacheStatus,
  WebuiModelProviderModelEntry,
  WebuiModelProviderView,
} from "../../shared/contracts/models.js";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const asStrings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
const asNumbers = (value: unknown): readonly number[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : undefined;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asRecords = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    : [];

/** `{ field }` when the field was present, `{}` when it was not. */
function present<T>(field: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [field]: value };
}

function toStatus(value: unknown): WebuiModelCacheStatus | undefined {
  const record = asRecord(value);
  const state = asString(record?.state);
  if (!record || state === undefined) return undefined;
  return {
    state,
    ...present("lastTestedAt", asNumber(record.lastTestedAt)),
    ...present("lastErrorCode", asString(record.lastErrorCode)),
    ...present("lastErrorMessage", asString(record.lastErrorMessage)),
  };
}

function toModalities(
  value: unknown,
): { readonly input?: readonly string[]; readonly output?: readonly string[] } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    ...present("input", asStrings(record.input)),
    ...present("output", asStrings(record.output)),
  };
}

function toThinkingConfig(
  value: unknown,
): WebuiModelProviderModelEntry["thinkingConfig"] {
  const record = asRecord(value);
  const mode = asString(record?.mode);
  if (
    !record ||
    (mode !== "switchable" && mode !== "forced_on" && mode !== "forced_off" && mode !== "hidden")
  )
    return undefined;
  const defaultValue = asString(record.default_value);
  return {
    mode,
    ...(defaultValue === "true" || defaultValue === "false"
      ? { default_value: defaultValue }
      : {}),
  };
}

/**
 * One model row. The identity fields a write needs are required by the DTO, so
 * a row that lost them is reported with an empty string rather than dropped —
 * a dropped row would look like the model was removed.
 */
export function toWebuiModelProviderModelEntry(
  row: Record<string, unknown>,
): WebuiModelProviderModelEntry {
  const modelId = asString(row.modelId) ?? "";
  const configurationSource = asString(row.configurationSource);
  const contextWindowOptionHints = asRecord(row.contextWindowOptionHints);
  const thinking = asRecord(row.thinking);
  return {
    providerId: asString(row.providerId) ?? "",
    modelId,
    modelConfigId: asString(row.modelConfigId) ?? modelId,
    displayName: asString(row.displayName) ?? modelId,
    enabled: asBoolean(row.enabled) ?? true,
    selected: asBoolean(row.selected) ?? false,
    ...(configurationSource === "manual" || configurationSource === "discovered"
      ? { configurationSource }
      : {}),
    ...present("contextLimit", asNumber(row.contextLimit)),
    ...present("defaultContextLimit", asNumber(row.defaultContextLimit)),
    ...(thinking ? { thinking: { ...present("effort", asString(thinking.effort)) } } : {}),
    ...present("contextWindowOptions", asNumbers(row.contextWindowOptions)),
    ...(contextWindowOptionHints
      ? {
          contextWindowOptionHints: Object.fromEntries(
            Object.entries(contextWindowOptionHints).filter(
              (entry): entry is [string, "higher_usage"] => entry[1] === "higher_usage",
            ),
          ),
        }
      : {}),
    ...present("maxOutputTokens", asNumber(row.maxOutputTokens)),
    ...present("effortOptions", asStrings(row.effortOptions)),
    ...present("defaultEffort", asString(row.defaultEffort)),
    ...present("supportedVariants", asStrings(row.supportedVariants)),
    ...present("thinkingConfig", toThinkingConfig(row.thinkingConfig)),
    ...present("variant", asString(row.variant)),
    ...present("providerSource", asString(row.providerSource)),
    ...present("providerKind", asString(row.providerKind)),
    ...present("providerName", asString(row.providerName)),
    ...present("apiFormat", asString(row.apiFormat)),
    ...present("modalities", toModalities(row.modalities)),
    ...present("status", toStatus(row.status)),
  };
}

/**
 * One provider row. `headerNames` and `configRevision` are the two fields the
 * editor and the candidate write depend on, and they are exactly the two the
 * old browser reads got wrong.
 */
export function toWebuiModelProviderView(row: Record<string, unknown>): WebuiModelProviderView {
  const name = asString(row.name) ?? "";
  return {
    providerId: asString(row.providerId) ?? "",
    name,
    source: asString(row.source) ?? "",
    kind: asString(row.kind) ?? "custom",
    enabled: asBoolean(row.enabled) ?? true,
    hasApiKey: asBoolean(row.hasApiKey) ?? false,
    models: asRecords(row.models).map(toWebuiModelProviderModelEntry),
    ...present("baseUrl", asString(row.baseUrl)),
    ...present("apiFormat", asString(row.apiFormat)),
    ...present("maskedApiKey", asString(row.maskedApiKey)),
    ...present("headerNames", asStrings(row.headerNames)),
    ...present("configRevision", asString(row.configRevision)),
    ...present("status", toStatus(row.status)),
  };
}

/** The list read the `listUserModelProviders` binding returns. */
export function toWebuiModelProviderViews(
  rows: readonly Record<string, unknown>[],
): readonly WebuiModelProviderView[] {
  return rows.map(toWebuiModelProviderView);
}
