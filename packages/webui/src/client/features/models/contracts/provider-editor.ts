// The provider editor's published surface.
//
// The editor's *policy* lives in `features/models/application/provider-editor.ts`;
// these are its public shapes, and they live in `contracts/` because the surface
// they publish is read by three roles that may not import an application module:
// the Models binding that owns the instance, the Settings UI that hosts it above
// the custom-tab conditional, and the panel that renders it. `contracts/` is the
// leaf every one of them may depend on.

import type {
  WebuiProviderDiscoveryOutcome,
  WebuiProviderSaveOutcome,
  WebuiProviderTestOutcome,
} from "./provider-outcome.js";
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "../../../../shared/contracts/models.js";

/**
 * One editable header row. The read carries header *names* only, so a saved row
 * starts blank and keeps whatever is stored unless its row is renamed or removed
 * (`persistedName` is the name it was seeded from). Declared here rather than in
 * the projection that consumes it: this is the shape the editor publishes, and a
 * contract cannot import a projection.
 */
export interface ProviderHeaderDraft {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly persistedName?: string;
}

/**
 * The API formats the runtime accepts, in the order Desktop's form offers them.
 *
 * A mirror of `MODEL_PROVIDER_APIS` in `local-runtime-v2`'s model-system
 * identity module. The runtime validates the field on write and refuses an
 * unknown value, so the form offers exactly the values it will accept; a saved
 * provider carrying a format this build does not know keeps its value (the form
 * adds it to the options rather than silently rewriting it).
 */
export const WEBUI_MODEL_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
] as const;

/**
 * The attachment modalities the form offers, in Desktop's own order.
 *
 * `text` is deliberately absent: every model takes text, so the runtime adds it
 * back (Desktop does the same in its own normalization) and the user only picks
 * what is on top of text.
 */
export const WEBUI_MODEL_ATTACHMENT_MODALITIES = ["image", "pdf", "video", "audio"] as const;

/**
 * One editable model row.
 *
 * Desktop's form is a list of model cards, not one textarea of ids: every model
 * carries its own context window, output budget, reasoning levels and supported
 * attachments, and the write sends one entry per card. The two limits stay as
 * typed text (the inputs are free-typed) and the levels as the list the user
 * picked; the editor normalizes both when it builds the candidate.
 */
export interface ProviderModelDraft {
  readonly id: string;
  readonly modelId: string;
  /** The name the model is shown under; Desktop keeps the saved one and falls back to the id. */
  readonly displayName: string;
  /** The context window, as typed. Digits only; empty means "the runtime decides". */
  readonly contextLimit: string;
  /** The output budget, as typed. Digits only; empty means "the runtime decides". */
  readonly maxOutputTokens: string;
  readonly effortOptions: readonly string[];
  /** The attachment modalities the user picked, without the implicit `text`. */
  readonly modalities: readonly string[];
  /** `discovered` for a model the endpoint listed; absent for a hand-written one. */
  readonly configurationSource?: "discovered";
  /** The message of a failed connection test for this row. */
  readonly error?: string;
  /** Whether this row passed a connection test against the current draft. */
  readonly tested: boolean;
}

/** The fields one model row accepts. Absent fields keep their current value. */
export interface ProviderModelPatch {
  readonly modelId?: string;
  readonly displayName?: string;
  readonly contextLimit?: string;
  readonly maxOutputTokens?: string;
  readonly effortOptions?: readonly string[];
  readonly modalities?: readonly string[];
}

/**
 * The Models commands the editor drives. Structurally the provider CRUD members
 * of the models workflow, so the composition passes the workflow itself rather
 * than a second hand-built object.
 */
export interface WebuiProviderEditorCommands {
  readonly canManageProviders: boolean;
  readonly revealApiKey: (providerId: string) => Promise<string>;
  readonly createProvider: (
    body: WebuiCreateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly updateProvider: (
    body: WebuiUpdateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly deleteProvider: (providerId: string) => Promise<unknown>;
  /**
   * Each answers with its typed outcome.
   *
   * They used to answer `unknown`, which is why this editor cast the result to a
   * record and picked fields out of it — putting "what counts as success" and
   * "what does a refusal say" in the surface, once per operation, unchecked. The
   * decision lives in `provider-outcome.ts` now and the editor branches on it.
   */
  readonly discoverCandidate: (
    body: WebuiDiscoverUserModelsCandidateRequest,
  ) => Promise<WebuiProviderDiscoveryOutcome>;
  readonly saveCandidate: (
    body: WebuiSaveUserModelProviderCandidateRequest,
  ) => Promise<WebuiProviderSaveOutcome>;
  readonly testCandidate: (
    body: WebuiTestUserModelCandidateRequest,
  ) => Promise<WebuiProviderTestOutcome>;
}

export interface WebuiProviderEditorSnapshot {
  readonly open: boolean;
  readonly editingProviderId?: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiFormat: string;
  /** The editable model rows, in the order they will be written. */
  readonly models: readonly ProviderModelDraft[];
  readonly headers: readonly ProviderHeaderDraft[];
  readonly skipConnectionTest: boolean;
  /** True while an operation is in flight; the form disables its controls on it. */
  readonly busy: boolean;
  readonly pending?: "test" | "discover" | "save" | "delete" | "open";
  readonly error?: string;
  /** Whether the *current* draft passed a connection test. */
  readonly tested: boolean;
  readonly canManageProviders: boolean;
  /** Whether discovery can be offered — it can, on a new provider and on a saved one. */
  readonly canDiscover: boolean;
  /** The revision a write must carry; absent for a new provider. */
  readonly configRevision?: string;
}

export interface WebuiProviderEditorOptions {
  readonly commands: WebuiProviderEditorCommands;
  /** Called with the error the panel shows; absent reports nothing to the host. */
  readonly onError?: (message: string | undefined) => void;
}

export interface WebuiProviderEditor {
  readonly getSnapshot: () => WebuiProviderEditorSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Start a new provider: a blank draft, no identity, no revision. */
  readonly openNew: () => void;
  /**
   * Edit a saved provider. The draft starts from the view, the engine field
   * carries the revision the write must present, and the connection test state
   * starts unproven — a saved provider has not been tested *in this draft*.
   */
  readonly openExisting: (provider: import("../../../../shared/contracts/models.js").WebuiModelProviderView) => Promise<void>;
  readonly changeField: (
    field: "name" | "baseUrl" | "apiKey" | "apiFormat",
    value: string,
  ) => void;
  /** Append a blank model row. */
  readonly addModel: () => void;
  /** Drop a model row and everything the write would have carried for it. */
  readonly removeModel: (id: string) => void;
  /** Drop every model row — what picking another preset does. */
  readonly clearModels: () => void;
  /** Change one model row's fields. */
  readonly changeModel: (id: string, patch: ProviderModelPatch) => void;
  readonly setHeaders: (rows: readonly ProviderHeaderDraft[]) => void;
  readonly addHeader: () => void;
  readonly removeHeader: (id: string) => void;
  readonly setSkipConnectionTest: (skip: boolean) => void;
  /**
   * Test every model row that carries an id, one call per row — the shape
   * Desktop's form has when each card owns its own connectivity probe.
   */
  readonly test: () => Promise<void>;
  /** Test one model row and report the answer on that row. */
  readonly testModel: (id: string) => Promise<void>;
  readonly discover: () => Promise<void>;
  readonly save: () => Promise<void>;
  readonly remove: () => Promise<void>;
  /**
   * End the form view. The draft is kept (the parent's tab-switch behaviour),
   * transient operation feedback is reset, and late completions are fenced.
   */
  readonly close: () => void;
  /** Clear the current error (a caller that routes it elsewhere). */
  readonly clearError: () => void;
  /**
   * Dispose the editor (leaving the Usage category or closing Settings). The
   * credential-bearing fields are cleared and every late completion is fenced; a
   * mutation already on its way still settles, in the workflow that owns it.
   */
  readonly dispose: () => void;
}
