// The Models-owned provider editor.
//
// Models defines the editing policy — identity, draft, candidate construction,
// test validity, pending operation/error state and command outcomes — and the
// binding owns **one instance for a Usage page visit**, above the
// `sourceTab === "custom"` conditional. Those used to live as fourteen `useState`s
// in `UsageModelSettings` handed down to `ProviderFormPanel` as setters, which
// made the parent the editor's storage and the panel the editor's policy.
//
// It is framework-free on purpose: no React, no DOM. The binding supplies the
// command set and renders the snapshot; the editor never writes a cache of its
// own, so a catalogue mutation goes through the Models workflow and the
// invalidation that follows stays the workflow's.
//
// Two fences are the reason this is a module rather than inline handlers:
//
//   * a **draft generation** — a field edit changes what the candidate means, so
//     a test that started before the edit can no longer mark the draft tested;
//   * an **operation generation** — closing the form or disposing the editor
//     fences every late completion, so a save that lands afterwards cannot
//     repopulate a disposed editor.

import type {
  WebuiModelProviderCandidateInput,
  WebuiModelProviderModelEntry,
  WebuiModelProviderView,
  WebuiUserModelInput,
} from "../../../../shared/contracts/models.js";
import { formatWebuiError } from "../../../contracts/value-readers.js";
import { projectProviderHeaders } from "../projection/usage-settings.js";
import type { ProviderHeaderDraft } from "../contracts/provider-editor.js";
import type { WebuiProviderModelRef } from "../contracts/provider-outcome.js";
import {
  WEBUI_MODEL_ATTACHMENT_MODALITIES,
  type ProviderModelDraft,
  type ProviderModelPatch,
} from "../contracts/provider-editor.js";
import type {
  WebuiProviderEditor,
  WebuiProviderEditorCommands,
  WebuiProviderEditorOptions,
  WebuiProviderEditorSnapshot,
} from "../contracts/provider-editor.js";

export type {
  WebuiProviderEditor,
  WebuiProviderEditorCommands,
  WebuiProviderEditorOptions,
  WebuiProviderEditorSnapshot,
} from "../contracts/provider-editor.js";

const EMPTY_DRAFT = {
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "openai-completions",
} as const;

/**
 * A positive whole number, or nothing.
 *
 * The runtime refuses a limit that is not a positive safe integer
 * (`normalizeModelLimit`), so a half-typed number never reaches the wire: an
 * unparsable field means "leave the limit to the runtime", exactly as Desktop's
 * own `n8` does.
 */
function positiveInteger(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Trimmed, non-empty, without duplicates — Desktop's `n4`. */
function trimmedUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * A blank row, with the limits Desktop's form starts a new model with.
 *
 * Desktop seeds a new model with a 256k context window and a 64k output budget
 * so the user sees a number to correct rather than an empty field.
 */
function blankModelDraft(id: string): ProviderModelDraft {
  return {
    id,
    modelId: "",
    displayName: "",
    contextLimit: "256000",
    maxOutputTokens: "64000",
    effortOptions: [],
    modalities: [],
    tested: false,
  };
}

/**
 * A row seeded from a saved model.
 *
 * The limits, the reasoning levels and the attachments come from what that
 * model was stored with, so an edit round-trips them instead of dropping them.
 * A model that was stored without a limit starts with an **empty** field rather
 * than Desktop's default number: writing a limit the user never chose would
 * narrow a model that the runtime had left open.
 */
function modelDraftFromEntry(
  model: WebuiModelProviderModelEntry,
  index: number,
): ProviderModelDraft {
  const modalities = (model.modalities?.input ?? []).filter((modality) =>
    (WEBUI_MODEL_ATTACHMENT_MODALITIES as readonly string[]).includes(modality),
  );
  return {
    id: `${model.providerId || "model"}-${index}`,
    modelId: model.modelId,
    displayName: model.displayName,
    contextLimit: model.contextLimit === undefined ? "" : String(model.contextLimit),
    maxOutputTokens:
      model.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
    effortOptions: [...(model.effortOptions ?? [])],
    modalities,
    ...(model.configurationSource === "discovered"
      ? { configurationSource: "discovered" as const }
      : {}),
    tested: false,
  };
}

export function createWebuiProviderEditor(
  options: WebuiProviderEditorOptions,
): WebuiProviderEditor {
  const { commands } = options;
  const listeners = new Set<() => void>();
  let editingProviderId: string | undefined;
  let configRevision: string | undefined;
  let draft: {
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: string;
  } = { ...EMPTY_DRAFT };
  let models: readonly ProviderModelDraft[] = [];
  let headers: readonly ProviderHeaderDraft[] = [];
  let originalHeaderNames: readonly string[] = [];
  let skipConnectionTest = false;
  let tested = false;
  let pending: WebuiProviderEditorSnapshot["pending"];
  let error: string | undefined;
  let open = false;
  /** Bumped by every edit: a test that started earlier cannot mark this draft tested. */
  let draftGeneration = 0;
  /** Bumped by close/dispose: a completion that lands later writes nothing. */
  let operationGeneration = 0;
  let disposed = false;

  let snapshot: WebuiProviderEditorSnapshot = currentSnapshot();

  function currentSnapshot(): WebuiProviderEditorSnapshot {
    return {
      open,
      ...(editingProviderId === undefined ? {} : { editingProviderId }),
      ...draft,
      models,
      headers,
      skipConnectionTest,
      busy: pending !== undefined,
      ...(pending === undefined ? {} : { pending }),
      ...(error === undefined ? {} : { error }),
      tested,
      canManageProviders: commands.canManageProviders,
      // Discovery is offered in both branches: a saved provider is asked with
      // its identity and revision, a new one with the endpoint and the key it
      // would be created with.
      canDiscover: open,
      ...(configRevision === undefined ? {} : { configRevision }),
    };
  }

  const publish = (): void => {
    if (disposed) return;
    snapshot = currentSnapshot();
    for (const listener of [...listeners]) listener();
  };

  const setError = (message: string | undefined): void => {
    error = message;
    options.onError?.(message);
  };

  const begin = (next: NonNullable<WebuiProviderEditorSnapshot["pending"]>): number => {
    pending = next;
    error = undefined;
    return operationGeneration;
  };
  /**
   * End one operation. A completion that lands after `close`/`dispose` (a stale
   * generation) or after disposal writes nothing at all — not even the error.
   */
  const settle = (generation: number, message?: string): void => {
    if (generation !== operationGeneration || disposed) return;
    pending = undefined;
    if (message !== undefined) setError(message);
    publish();
  };

  /** The candidate the current draft describes, or the reason it cannot be built. */
  const candidate = ():
    | { readonly ok: true; readonly value: WebuiModelProviderCandidateInput }
    | { readonly ok: false; readonly reason: string } => {
    const projection = projectProviderHeaders(headers, originalHeaderNames);
    if (projection.error !== undefined)
      return {
        ok: false,
        reason:
          projection.error === "duplicate-name"
            ? "Header 名称不能重复"
            : "新增 Header 必须填写值",
      };
    return {
      ok: true,
      value: {
        ...(editingProviderId === undefined ? {} : { providerId: editingProviderId }),
        ...(configRevision === undefined ? {} : { expectedRevision: configRevision }),
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey,
        apiFormat: draft.apiFormat,
        ...(projection.headers === undefined ? {} : { headers: projection.headers }),
        ...(projection.removeHeaders === undefined
          ? {}
          : { removeHeaders: projection.removeHeaders }),
        models: modelInputs(),
      },
    };
  };

  const modelInputs = (): readonly WebuiUserModelInput[] =>
    models
      .map(modelInput)
      .filter((model): model is WebuiUserModelInput => model !== undefined);

  /**
   * One model row as the write carries it.
   *
   * Desktop's own `n3`: the id is required, the name falls back to it, the two
   * limits ride along only when they are real positive numbers, the reasoning
   * levels are trimmed and deduplicated, and the attachments are declared with
   * the implicit `text`. `enabled` is deliberately **not** sent — the runtime
   * keeps the stored value when the field is absent, so the list's own
   * enable/disable toggle is not overwritten by an edit of the form.
   */
  const modelInput = (row: ProviderModelDraft): WebuiUserModelInput | undefined => {
    const modelId = row.modelId.trim();
    if (!modelId) return undefined;
    const context = positiveInteger(row.contextLimit);
    const output = positiveInteger(row.maxOutputTokens);
    const effortOptions = trimmedUnique(row.effortOptions);
    const attachments = trimmedUnique(row.modalities).filter((modality) =>
      (WEBUI_MODEL_ATTACHMENT_MODALITIES as readonly string[]).includes(modality),
    );
    return {
      modelId,
      displayName: row.displayName.trim() || modelId,
      ...(row.configurationSource === "discovered"
        ? { configurationSource: row.configurationSource }
        : {}),
      ...(context === undefined && output === undefined
        ? {}
        : {
            limit: {
              ...(context === undefined ? {} : { context }),
              ...(output === undefined ? {} : { output }),
            },
          }),
      ...(effortOptions.length === 0 ? {} : { effortOptions }),
      ...(attachments.length === 0
        ? {}
        : {
            attachment: true,
            modalities: { input: ["text", ...attachments], output: ["text"] },
          }),
    };
  };

  /** The first model row that carries an id, which is what a test or a save targets. */
  const firstModelId = (): string =>
    models.find((row) => row.modelId.trim().length > 0)?.modelId.trim() ?? "";

  /**
   * Drop every probe result.
   *
   * A probe describes the candidate as it was when it ran, so one edit
   * invalidates all of them — the rows carry their own answer, and a stale one
   * would let a save through on the strength of a candidate that no longer
   * exists.
   */
  const invalidateProbes = (): void => {
    tested = false;
    models = models.map((row) =>
      row.tested || row.error !== undefined
        ? { ...row, tested: false, error: undefined }
        : row,
    );
  };

  /**
   * Probe one model row against the current candidate.
   *
   * The answer belongs to the row that was probed: it says which model did not
   * answer, and only a draft this probe described may be marked tested.
   */
  const probeModel = async (id: string): Promise<void> => {
    const modelId = models.find((row) => row.id === id)?.modelId.trim() ?? "";
    if (!modelId) return;
    const built = candidate();
    if (!built.ok) {
      setError(built.reason);
      publish();
      return;
    }
    const generation = begin("test");
    const draftAtStart = draftGeneration;
    publish();
    try {
      // A typed outcome, decoded once by the Models owner. What counts as
      // success and what a refusal says are no longer decided here by picking
      // fields out of a record.
      const result = await commands.testCandidate({ candidate: built.value, modelId });
      if (generation !== operationGeneration || disposed) return;
      if (result.outcome !== "success") {
        models = models.map((row) =>
          row.id === id ? { ...row, error: result.message, tested: false } : row,
        );
        settle(generation, result.message);
        return;
      }
      // Only the draft this probe described may be marked tested.
      const current = draftAtStart === draftGeneration;
      models = models.map((row) =>
        row.id === id ? { ...row, error: undefined, tested: current } : row,
      );
      tested = current && models.every((row) => row.modelId.trim().length === 0 || row.tested);
      settle(generation);
    } catch (reason) {
      const message = formatWebuiError(reason);
      models = models.map((row) =>
        row.id === id ? { ...row, error: message, tested: false } : row,
      );
      settle(generation, message);
    }
  };

  return {
    getSnapshot: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    openNew: () => {
      editingProviderId = undefined;
      configRevision = undefined;
      draft = { ...EMPTY_DRAFT };
      models = [];
      headers = [];
      originalHeaderNames = [];
      skipConnectionTest = false;
      tested = false;
      pending = undefined;
      setError(undefined);
      open = true;
      draftGeneration += 1;
      publish();
    },

    openExisting: async (provider) => {
      editingProviderId = provider.providerId || undefined;
      configRevision = provider.configRevision;
      draft = {
        name: provider.name,
        baseUrl: provider.baseUrl ?? "",
        apiKey: "",
        apiFormat: provider.apiFormat ?? "openai-completions",
      };
      // Every saved model becomes a row of its own, carrying the limits, the
      // reasoning levels and the attachments it was stored with, so an edit
      // round-trips them instead of dropping them on the way back.
      models = provider.models.map((model, index) => modelDraftFromEntry(model, index));
      // Saved rows are names only: a blank value with its persisted name keeps
      // the stored value unless the row is renamed or removed.
      originalHeaderNames = provider.headerNames ?? [];
      headers = originalHeaderNames.map((name, index) => ({
        id: `${provider.providerId || "new"}-${index}`,
        name,
        value: "",
        persistedName: name,
      }));
      skipConnectionTest = false;
      tested = false;
      open = true;
      draftGeneration += 1;
      const generation = begin("open");
      publish();
      try {
        // Reveal-on-open keeps its current permission semantics: the runtime
        // decides whether the value may be read at all.
        const revealed = await commands.revealApiKey(provider.providerId);
        if (generation !== operationGeneration || disposed) return;
        draft = { ...draft, apiKey: revealed };
        tested = false;
      } catch (reason) {
        settle(generation, formatWebuiError(reason));
        return;
      }
      settle(generation);
    },

    changeField: (field, value) => {
      draft = { ...draft, [field]: value };
      // A changed field changes what the candidate means: any earlier probe no
      // longer describes this draft.
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    addModel: () => {
      models = [...models, blankModelDraft(`new-${models.length}-${draftGeneration}`)];
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    removeModel: (id) => {
      models = models.filter((row) => row.id !== id);
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    clearModels: () => {
      models = [];
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    changeModel: (id, patch) => {
      models = models.map((row) =>
        row.id === id
          ? {
              ...row,
              ...(patch.modelId === undefined ? {} : { modelId: patch.modelId }),
              ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
              ...(patch.contextLimit === undefined
                ? {}
                : { contextLimit: patch.contextLimit }),
              ...(patch.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: patch.maxOutputTokens }),
              ...(patch.effortOptions === undefined
                ? {}
                : { effortOptions: [...patch.effortOptions] }),
              ...(patch.modalities === undefined
                ? {}
                : { modalities: [...patch.modalities] }),
            }
          : row,
      );
      // A changed row changes what the candidate means: any earlier probe no
      // longer describes this draft.
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    setHeaders: (rows) => {
      headers = rows;
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    addHeader: () => {
      headers = [...headers, { id: `new-${Date.now()}-${headers.length}`, name: "", value: "" }];
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    removeHeader: (id) => {
      headers = headers.filter((row) => row.id !== id);
      invalidateProbes();
      draftGeneration += 1;
      publish();
    },

    setSkipConnectionTest: (skip) => {
      skipConnectionTest = skip;
      publish();
    },

    test: async () => {
      const rows = models.filter((row) => row.modelId.trim().length > 0);
      if (!rows.length) return;
      // Every row that carries an id is probed, one call per row — the shape
      // Desktop's form has when each card owns its own connectivity probe.
      for (const row of rows) {
        await probeModel(row.id);
      }
    },

    testModel: async (id) => {
      await probeModel(id);
    },

    discover: async () => {
      const baseUrl = draft.baseUrl.trim();
      if (!baseUrl) {
        setError("请先填写接口地址");
        publish();
        return;
      }
      // The runtime's two branches: a saved provider is asked with its identity
      // and revision, a new one with the endpoint, the name and the key it would
      // be created with. Desktop offers discovery in both.
      const savedProviderId = editingProviderId;
      const savedRevision = configRevision;
      const saved = savedProviderId !== undefined && savedRevision !== undefined;
      if (!saved && !draft.apiKey.trim()) {
        setError("请先填写 API Key");
        publish();
        return;
      }
      const generation = begin("discover");
      publish();
      try {
        const result = await commands.discoverCandidate(
          savedProviderId !== undefined && savedRevision !== undefined
            ? {
                providerId: savedProviderId,
                expectedRevision: savedRevision,
                baseUrl,
              }
            : {
                baseUrl,
                name: draft.name.trim(),
                apiKey: draft.apiKey,
                apiFormat: draft.apiFormat,
              },
        );
        if (generation !== operationGeneration || disposed) return;
        if (result.outcome !== "success") {
          settle(generation, result.message);
          return;
        }
        // Every discovered id becomes a row of its own, marked as discovered so
        // the write says where it came from.
        const discovered = result.models
          .map((entry: WebuiProviderModelRef) => entry.modelId)
          .filter((modelId) => modelId.trim().length > 0);
        if (discovered.length) {
          models = discovered.map((modelId, index) => ({
            ...blankModelDraft(`discovered-${index}-${draftGeneration}`),
            modelId,
            configurationSource: "discovered" as const,
          }));
        }
        // A discovery lists what the endpoint offers; it does not prove the
        // endpoint works, so the draft is untested again.
        invalidateProbes();
        settle(generation);
      } catch (reason) {
        settle(generation, formatWebuiError(reason));
      }
    },

    save: async () => {
      if (!tested && !skipConnectionTest) return;
      const built = candidate();
      if (!built.ok) {
        setError(built.reason);
        publish();
        return;
      }
      const generation = begin("save");
      const first = firstModelId();
      publish();
      try {
        const result = await commands.saveCandidate({
          candidate: built.value,
          modelId: first,
          saveAndUse: false,
          skipConnectionTest,
        });
        if (generation !== operationGeneration || disposed) return;
        if (result.outcome !== "success") {
          settle(generation, result.message);
          return;
        }
        // The form view ends on a successful save; the Models workflow owns the
        // catalogue invalidation that follows.
        open = false;
        settle(generation);
        publish();
      } catch (reason) {
        settle(generation, formatWebuiError(reason));
      }
    },

    remove: async () => {
      if (editingProviderId === undefined) return;
      const target = editingProviderId;
      const generation = begin("delete");
      publish();
      try {
        await commands.deleteProvider(target);
        if (generation !== operationGeneration || disposed) return;
        settle(generation);
      } catch (reason) {
        settle(generation, formatWebuiError(reason));
      }
    },

    close: () => {
      open = false;
      pending = undefined;
      operationGeneration += 1;
      setError(undefined);
      publish();
    },

    clearError: () => {
      if (disposed) return;
      setError(undefined);
      publish();
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      open = false;
      pending = undefined;
      operationGeneration += 1;
      // Credential-bearing fields do not outlive the editor.
      draft = { ...draft, apiKey: "" };
      headers = [];
      originalHeaderNames = [];
      // Refresh what a reader sees without notifying: disposal is terminal, so
      // there is no transition for a subscriber to react to.
      snapshot = currentSnapshot();
      listeners.clear();
    },
  };
}
