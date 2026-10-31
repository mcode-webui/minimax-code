// What a provider operation can answer.
//
// The three operations the provider editor drives — test a candidate, discover
// the models an endpoint offers, save the provider — all answer with what the
// runtime's own result type happened to be, and the editor read them by casting
// to a record and picking fields out of it. That put three separate decisions in
// the editor: what counts as success, what a refusal says, and what a revision
// conflict means. Two of them were the same decision, written twice, and neither
// was checked by anything.
//
// This is the decision, once, as a type the editor can branch on. The three
// outcomes are the three that need different follow-up:
//
// - `success` — the operation did what it was asked. Only then may the editor
//   mark the draft tested or close the form.
// - `refusal` — the runtime answered and said no. The reason is the runtime's to
//   word, and the code is stable, so a surface can distinguish "this key is
//   wrong" from "this model does not exist" without matching on English.
// - `conflict` — someone else moved the provider's revision since this editor
//   read it. Nothing is wrong with the draft; the editor's *base* is stale, and
//   retrying unchanged would overwrite someone else's edit. That is why it is
//   not a refusal: the two want opposite behaviour, and folding them together is
//  how a stale save looked like a rejected one.
//
// `code` is deliberately open. The named codes are what this build emits, not
// what a runtime may emit: an unfamiliar code is still a refusal, and the editor
// shows the runtime's own message rather than inventing one.

import type { WebuiWireErrorCode } from "../../../../shared/envelope.js";

/** One model the runtime reports for a provider or a discovery. */
export interface WebuiProviderModelRef {
  readonly modelId: string;
  /** Any further field the runtime sent, preserved rather than dropped. */
  readonly [key: string]: unknown;
}

/** The provider cache status a test or a save reports back. */
export interface WebuiProviderCacheStatus {
  readonly state?: string;
  readonly lastErrorMessage?: string;
  /** Any further field the runtime sent. */
  readonly [key: string]: unknown;
}

interface WebuiProviderOutcomeFields {
  /**
   * Whatever else the runtime sent, kept.
   *
   * Extension fields are not noise here: the editor passes a candidate through
   * to a save, and a runtime field this build has not named yet still belongs to
   * the answer. Decoding to a closed shape would silently drop it, and the next
   * runtime version would appear to lose data rather than add it.
   */
  readonly [key: string]: unknown;
}

export type WebuiProviderTestOutcome = WebuiProviderOutcomeFields &
  (
    | { readonly outcome: "success"; readonly models: readonly WebuiProviderModelRef[] }
    | { readonly outcome: "refusal"; readonly code: WebuiWireErrorCode; readonly message: string }
    | { readonly outcome: "conflict"; readonly message: string }
  );

export type WebuiProviderDiscoveryOutcome = WebuiProviderOutcomeFields &
  (
    | { readonly outcome: "success"; readonly models: readonly WebuiProviderModelRef[] }
    | { readonly outcome: "refusal"; readonly code: WebuiWireErrorCode; readonly message: string }
    | { readonly outcome: "conflict"; readonly message: string }
  );

export type WebuiProviderSaveOutcome = WebuiProviderOutcomeFields &
  (
    | { readonly outcome: "success"; readonly providerId?: string; readonly status?: WebuiProviderCacheStatus }
    | { readonly outcome: "refusal"; readonly code: WebuiWireErrorCode; readonly message: string }
    | { readonly outcome: "conflict"; readonly message: string }
  );

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The message a refusal carries.
 *
 * Read from the runtime's own words wherever it put them. A test that answered
 * with a cache status has the reason on that status; one that did not has it at
 * the top. Defaulting to a generic "连接失败" for a runtime that did say why
 * would throw away the only useful part of the answer.
 */
function refusalMessage(value: unknown, fallback: string): string {
  const status = record(record(value).status);
  if (typeof status.lastErrorMessage === "string" && status.lastErrorMessage) {
    return status.lastErrorMessage;
  }
  const direct = record(value).message ?? record(value).error;
  if (typeof direct === "string" && direct) return direct;
  return fallback;
}

function refusalCode(value: unknown): WebuiWireErrorCode {
  const code = record(value).code;
  return typeof code === "string" && code ? code : "harness_error";
}

/**
 * Did this answer report that the revision it was built on is no longer current?
 *
 * The three shapes that say so are checked together because the operations do
 * not agree on one: a save reports `skippedTest` with a status, a discovery
 * reports a code. Treating "some of those" as a conflict would leave the editor
 * showing a refusal for what is really a stale base.
 */
function isRevisionConflict(value: unknown): boolean {
  const source = record(value);
  const status = record(source.status);
  // The three operations do not agree on how they say "no": a test answers
  // `ok: false`, a save answers `success: false`. Accepting only one of them
  // turned a save's conflict into a refusal — the one conflation this module
  // exists to remove, and the more expensive one: a stale base is the editor's
  // fault and a rejection is the user's, and they want opposite follow-up.
  const refused = source.ok === false || source.success === false;
  if (!refused) return false;
  return (
    source.code === "revision_conflict" ||
    source.code === "conflict" ||
    status.state === "conflict" ||
    status.state === "stale"
  );
}

function modelRefs(value: unknown): readonly WebuiProviderModelRef[] {
  const source = Array.isArray(value) ? value : record(value).models;
  if (!Array.isArray(source)) return [];
  return source
    .map((entry) => record(entry))
    .filter((entry) => typeof entry.modelId === "string")
    .map((entry) => ({ ...entry, modelId: entry.modelId as string }));
}

const REFUSALS = {
  test: "连接失败",
  discover: "无法获取模型列表",
  save: "保存失败",
} as const;

/** Decode a provider connection test. */
export function decodeWebuiProviderTestOutcome(value: unknown): WebuiProviderTestOutcome {
  const source = record(value);
  if (source.ok !== true) {
    if (isRevisionConflict(value)) {
      return { ...source, outcome: "conflict", message: refusalMessage(value, "提供商已被其他操作更新，请重新打开后再试。") };
    }
    return { ...source, outcome: "refusal", code: refusalCode(value), message: refusalMessage(value, REFUSALS.test) };
  }
  return {
    ...source,
    outcome: "success",
    models: modelRefs(Array.isArray(value) ? value : source.models),
  };
}

/** Decode a model discovery. */
export function decodeWebuiProviderDiscoveryOutcome(
  value: unknown,
): WebuiProviderDiscoveryOutcome {
  const source = record(value);
  if (isRevisionConflict(value)) {
    return { ...source, outcome: "conflict", message: refusalMessage(value, "提供商已被其他操作更新，请重新打开后再试。") };
  }
  if (source.ok === false || Array.isArray(value)) {
    return { ...source, outcome: "refusal", code: refusalCode(value), message: refusalMessage(value, REFUSALS.discover) };
  }
  return { ...source, outcome: "success", models: modelRefs(value) };
}

/** Decode a provider save. */
export function decodeWebuiProviderSaveOutcome(value: unknown): WebuiProviderSaveOutcome {
  const source = record(value);
  if (source.success !== true && source.ok !== true) {
    if (isRevisionConflict(value)) {
      return { ...source, outcome: "conflict", message: refusalMessage(value, "提供商已被其他操作更新，请重新打开后再试。") };
    }
    return { ...source, outcome: "refusal", code: refusalCode(value), message: refusalMessage(value, REFUSALS.save) };
  }
  const status = record(source.status);
  return {
    ...source,
    outcome: "success",
    ...(typeof source.providerId === "string" ? { providerId: source.providerId } : {}),
    ...(Object.keys(status).length > 0 ? { status: status as WebuiProviderCacheStatus } : {}),
  };
}

/**
 * The answer for an operation this build cannot run.
 *
 * A refusal carrying `capability_unavailable`, not `undefined`. The fallback
 * editor used to answer `undefined` and relied on the editor noticing, which
 * meant the "this host does not support it" case and the "the runtime refused"
 * case were the same absence — and the one the user must never retry was the
 * one the UI invited them to retry. The code is the half that distinguishes
 * them.
 */
export function unavailableWebuiProviderOutcome(
  message: string,
): WebuiProviderTestOutcome & WebuiProviderDiscoveryOutcome & WebuiProviderSaveOutcome {
  return { outcome: "refusal", code: "capability_unavailable", message };
}
