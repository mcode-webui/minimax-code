// The models workflow owner.
//
// One owner for the model catalogue, the selection, and the provider list and
// presets. These states and their commands used to be published by
// `settings-workflows.ts`, which owned none of them: the model catalogue query
// state, the selection command state, the thinking state and the provider list
// are this owner's, and the provider form's commands are `models'` while
// `settings` renders the page. The two owners hold their own state and their own
// snapshot.
//
// Keyed resources own request identities and commit fences. This owner projects
// their values into its own snapshot and owns one identity-epoch subscription.
//
// One call crosses a boundary: writing a provider key is `models`' command, but
// the api-key *status* it invalidates is `settings`' read, so this owner invokes
// that owner's published command (`refreshApiKeyStatus`) rather than keeping a
// second copy of the read. Nothing else crosses: both counters stay inside the
// owner that owns the state they describe.
//
// Framework-free: no React, no DOM, no storage.

import type { WebuiIdentityEpochs } from "../../../application/identity-epochs.js";
import {
  runWebuiMutation,
  type WebuiMutationOutcome,
  createWebuiKeyedResource,
  idleWebuiResourceState,
  serializeWebuiResourceKey,
  type WebuiResourceKey,
  type WebuiResourceState,
} from "../../../conversation/request-freshness.js";
import type { ModelsPort } from "../contracts/provider-port.js";
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelEntry,
  WebuiModelProviderModelEntry,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "../../../../shared/contracts/models.js";
import { createWebuiSnapshotStore } from "../../../application/snapshot-store.js";
import {
  decodeWebuiProviderDiscoveryOutcome,
  decodeWebuiProviderSaveOutcome,
  decodeWebuiProviderTestOutcome,
  type WebuiProviderDiscoveryOutcome,
  type WebuiProviderSaveOutcome,
  type WebuiProviderTestOutcome,
} from "../contracts/provider-outcome.js";

/** The provider half of the port. */
export type WebuiModelsPortSlice = Pick<
  ModelsPort,
  | "listModels"
  | "selectModel"
  | "listUserModelProviders"
  | "createUserModelProvider"
  | "updateUserModelProvider"
  | "deleteUserModelProvider"
  | "testUserModelProvider"
  | "testUserModel"
  | "discoverUserModelsCandidate"
  | "saveUserModelProviderCandidate"
  | "listProviderPresets"
  | "upsertMiniMaxApiKey"
  | "testUserModelCandidate"
  | "revealModelProviderApiKey"
  | "refreshModels"
>;

export interface WebuiModelsWorkflowsState {
  /** Bumps when the model list must be re-read (a provider or a selection changed). */
  readonly modelsRevision: number;
  readonly models: WebuiResourceState<readonly WebuiModelEntry[]>;
  readonly providers: WebuiResourceState<readonly WebuiModelProviderView[]>;
  readonly presets: WebuiResourceState<readonly Record<string, unknown>[]>;
}

export const initialWebuiModelsWorkflowsState: WebuiModelsWorkflowsState = {
  modelsRevision: 0,
  models: idleWebuiResourceState(),
  providers: idleWebuiResourceState(),
  presets: idleWebuiResourceState(),
};

export interface WebuiModelsWorkflows {
  readonly getSnapshot: () => WebuiModelsWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;

  readonly canReadModels: boolean;
  readonly canSelectModel: boolean;
  readonly canManageProviders: boolean;
  readonly canReadPresets: boolean;
  readonly canUpsertApiKey: boolean;

  /**
   * Read the catalogue for one context **and show it**: the foreground read a
   * view asks for when the user arrives at a session.
   */
  readonly loadModels: (sessionId?: string) => Promise<void>;
  /**
   * Read the catalogue for one context without changing which one is shown.
   *
   * The distinction is the whole point: several readers acquire this resource —
   * a background fact about some session, a post-write refresh — and acquisition
   * must never decide what the visible reader is looking at. A background read
   * for session B used to select B, so refreshing one view changed another's.
   */
  readonly acquireModels: (sessionId?: string) => Promise<void>;
  /** Point the shown catalogue at a context, without issuing a read. */
  readonly selectCatalogue: (sessionId?: string) => void;
  /**
   * One context's catalogue, read from the entry that belongs to it.
   *
   * The snapshot shows the catalogue that is SELECTED, which is a different
   * fact from "the catalogue of the session on screen". A view that renders the
   * selected one has to trust that the selection followed it, and when it did
   * not, the view rendered another session's models — or none, because the
   * rebind had not been read yet. Asking for a session's own entry removes the
   * question: the key carries the session, so one session's catalogue can never
   * be rendered as another's.
   *
   * The last good answer stands in while the next read is in flight, so a
   * caller that renders this value does not empty the list for the length of a
   * round trip.
   */
  readonly readModelsFor: (
    sessionId?: string,
  ) => WebuiResourceState<readonly WebuiModelEntry[]>;
  readonly releaseSession: (sessionId: string) => void;
  readonly selectModel: (request: {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
    readonly sessionId?: string;
  }) => Promise<void>;

  readonly loadProviders: () => Promise<void>;
  /**
   * Turn one of a provider's models on or off.
   *
   * Semantic intent, not a replacement array. The caller says *what the user
   * meant*; this owner captures it, applies it to the projection it is currently
   * holding for that provider, and serializes the write behind any other pending
   * change to the same provider. The version this replaces took a whole model
   * array built from rendered props, so a toggle could resurrect a list that was
   * already stale and a later reload could not tell which edits were newer.
   */
  readonly setProviderModelEnabled: (intent: {
    readonly providerId: string;
    readonly modelId: string;
    readonly enabled: boolean;
  }) => Promise<WebuiMutationOutcome<void>>;
  /**
   * Reorder one provider's models to the given identities.
   *
   * Ordered identities rather than a reordered array of rows: the owner resolves
   * them against its current pending projection, and an identity it no longer
   * holds is ignored instead of being dropped silently from the write.
   */
  readonly reorderProviderModels: (intent: {
    readonly providerId: string;
    readonly orderedModelIds: readonly string[];
  }) => Promise<WebuiMutationOutcome<void>>;
  readonly createProvider: (
    body: WebuiCreateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly updateProvider: (
    body: WebuiUpdateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly deleteProvider: (providerId: string) => Promise<unknown>;
  readonly testProvider: (body: {
    readonly providerId: string;
    readonly apiKey?: string;
  }) => Promise<unknown>;
  readonly testModel: (body: {
    readonly providerId: string;
    readonly modelId: string;
  }) => Promise<unknown>;
  /**
   * Each returns the operation's *typed outcome*, decoded once here.
   *
   * These used to answer with whatever the runtime's result type was, and every
   * caller cast it to a record and picked fields out — which put the same
   * "what counts as success, and what does a refusal say" decision in each
   * surface that made one. `decodeWebuiProvider*Outcome` owns it now, and the
   * three answers are distinguishable without a cast: success, a refusal with
   * the runtime's own code, or a revision conflict, which is a stale base rather
   * than a rejected request and wants the opposite follow-up.
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
  readonly revealApiKey: (providerId: string) => Promise<string>;
  readonly loadPresets: () => Promise<void>;
  readonly upsertApiKey: (body: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }) => Promise<unknown>;
  readonly refreshModels: () => Promise<unknown>;
  /**
   * Fences the owner: every keyed resource stops committing and stops
   * scheduling. A remount builds a fresh owner rather than reactivating
   * this one.
   */
  readonly dispose: () => void;
}

export function createWebuiModelsWorkflows(deps: {
  readonly port: WebuiModelsPortSlice;
  /** `settings`' api-key status read, invoked after `upsertApiKey` writes. */
  readonly refreshApiKeyStatus: () => Promise<void>;
  /**
   * The application's opaque generation context. A provider or
   * credential write changes what the catalogue means, so the answers computed
   * under the previous generation are retired here rather than by each reader.
   */
  readonly identityEpochs?: WebuiIdentityEpochs;
}): WebuiModelsWorkflows {
  const { port, refreshApiKeyStatus } = deps;
  const afterConfigurationWrite = (): void => {
    deps.identityEpochs?.advance("configuration");
  };
  const afterCredentialWrite = (): void => {
    deps.identityEpochs?.advance("credentials");
    deps.identityEpochs?.advance("configuration");
  };
  // The keyed resources. Identity is storage identity: each answer
  // lives under a key that carries every response-affecting input, so a late
  // answer for one context lands in *its own* entry instead of overwriting the
  // context the user is looking at — the defect the old destination field had.
  //
  //   * the catalogue is keyed by the session/agent context it was asked for and
  //     by the opaque credential/config generations it was computed under;
  //   * the provider list is keyed by the configuration generation;
  //   * the presets are global, so their key is empty.
  const catalogue = createWebuiKeyedResource<readonly WebuiModelEntry[]>();
  const providerList = createWebuiKeyedResource<readonly WebuiModelProviderView[]>();
  const presetList = createWebuiKeyedResource<readonly Record<string, unknown>[]>();
  const PRESETS_KEY: WebuiResourceKey = {};
  /**
   * The last good catalogue per key.
   *
   * A read replaces its entry with a loading state, and a catalogue that empties
   * itself while it reloads is what made the picker look like it had no models:
   * the chip fell back to the literal "Model" and the trigger went inert, and a
   * page reload was the only thing that brought the list back. The last answer
   * for the SAME key is the best known answer while the next one is in flight,
   * so it is kept here and projected in its place.
   *
   * The key carries the credential and configuration generations, so an epoch
   * advance changes the key and the retained answer is not reused under it.
   */
  const retainedCatalogues = new Map<string, readonly WebuiModelEntry[]>();
  // Which catalogue key the snapshot shows. Switching it is not a re-key of the
  // stored answers: they stay under the keys they were read for.
  let shownCatalogueKey: WebuiResourceKey = {};
  /** The context the shown catalogue belongs to, for a later acquisition. */
  let shownSessionId: string | undefined;

  const providerKey = (): WebuiResourceKey => ({
    configuration: deps.identityEpochs?.configuration().token ?? null,
  });
  const catalogueKeyFor = (sessionId?: string): WebuiResourceKey => ({
    sessionId: sessionId ?? null,
    credentials: deps.identityEpochs?.credentials().token ?? null,
    configuration: deps.identityEpochs?.configuration().token ?? null,
  });

  /**
   * Which keys each opaque generation is responsible for.
   *
   * The generation is bound to the keys it *participates in*, not to the whole
   * resource: advancing the credential generation retires the catalogue answers
   * computed under it, while the provider list — which carries only the
   * configuration token — and the globally-keyed presets are left alone. Binding
   * one key therefore never invalidates another, which is the property that keeps
   * an epoch advance from disturbing an unrelated selected key.
   *
   * Each binding watches *its own* generation only: the epoch module publishes
   * every advance on one subscription, so the listener drops the ones that named
   * a different generation. Without that filter a credential write would retire
   * answers that only ever carried the configuration token.
   */
  const catalogueKeys = new Map<string, WebuiResourceKey>();
  const providerKeys = new Map<string, WebuiResourceKey>();
  const releasedSessions = new Set<string>();
  const bindCatalogueEpochs = (key: WebuiResourceKey): void => {
    catalogueKeys.set(serializeWebuiResourceKey(key), key);
  };

  // The owner's own snapshot: the projection below writes it, the React binding
  // subscribes to it. It holds no answer of its own — the keyed resources do.
  let state: WebuiModelsWorkflowsState = initialWebuiModelsWorkflowsState;
  let disposed = false;
  const listeners = new Set<() => void>();
  const getSnapshot = (): WebuiModelsWorkflowsState => state;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const set = (
    update: (current: WebuiModelsWorkflowsState) => WebuiModelsWorkflowsState,
  ): void => {
    if (disposed) return;
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const markModels = (): void => {
    set((current) => ({ ...current, modelsRevision: current.modelsRevision + 1 }));
  };

  /**
   * Retires the catalogue answer the owner is showing. A provider or credential
   * write changes what the catalogue means, so a read that started before it must
   * not land as current — the freshness revision moves first, and the next read
   * is scheduled under the new generation's key.
   */
  const invalidateCatalogue = (): void => {
    catalogue.invalidate(shownCatalogueKey);
  };

  /**
   * The catalogue as a reader should see it: the entry's own state, with the
   * last good value standing in while a read is in flight.
   *
   * The state stays honest — a read that is running still reads as running, and
   * a failure still reads as a failure — but the VALUE it carries is the last
   * answer rather than nothing. A reader that renders the value keeps showing
   * the models it had while the next answer is on its way, instead of emptying
   * the list for the length of a round trip.
   */
  const retainedCatalogue = (
    key: WebuiResourceKey,
    entry: WebuiResourceState<readonly WebuiModelEntry[]> | undefined,
  ): WebuiResourceState<readonly WebuiModelEntry[]> | undefined => {
    if (!entry) return undefined;
    const serialized = serializeWebuiResourceKey(key);
    if (entry.status === "ready" && entry.value) {
      retainedCatalogues.set(serialized, entry.value);
      return entry;
    }
    const retained = retainedCatalogues.get(serialized);
    if (!retained) return entry;
    return { ...entry, value: retained };
  };

  /**
   * The snapshot is a projection of the keyed entries, not a second store: it
   * shows the entry for the key that is currently selected and the entries for
   * the provider and preset keys. A commit for another key changes that key's
   * entry and leaves this projection alone.
   */
  const project = (): void => {
    set((current) => ({
      ...current,
      models:
        retainedCatalogue(shownCatalogueKey, catalogue.read(shownCatalogueKey)) ??
        idleWebuiResourceState(),
      providers: providerList.read(providerKey()) ?? idleWebuiResourceState(),
      presets: presetList.read(PRESETS_KEY) ?? idleWebuiResourceState(),
    }));
  };
  catalogue.subscribe(project);
  providerList.subscribe(project);
  presetList.subscribe(project);
  const stopEpochs = deps.identityEpochs?.subscribe((advanced) => {
    // One owner subscription, not one new subscription per periodic read. Only
    // resources composing the advanced epoch retire; presets stay untouched.
    for (const [serialized, key] of catalogueKeys) {
      if (!(advanced.key in key)) continue;
      catalogueKeys.delete(serialized);
      catalogue.release(key);
    }
    if (advanced.key === "configuration") {
      for (const key of providerKeys.values()) providerList.release(key);
      providerKeys.clear();
    }
    shownCatalogueKey = catalogueKeyFor(shownSessionId);
    bindCatalogueEpochs(shownCatalogueKey);
    project();
  });

  /** A capability the runtime does not expose is reported, never a success. */
  const unavailable = (
    field: "models" | "providers" | "presets",
    error: string,
  ): void => {
    set((current) => ({ ...current, [field]: { status: "error", error } }));
  };

  /**
   * Point the shown catalogue at a context.
   *
   * Selection is a view decision, so it is its own command: the generations are
   * bound to the key that is shown, and a later epoch advance retires exactly that
   * answer while an unrelated key stays untouched.
   */
  const selectCatalogue = (sessionId?: string): void => {
    if (disposed) return;
    shownSessionId = sessionId;
    shownCatalogueKey = catalogueKeyFor(sessionId);
    bindCatalogueEpochs(shownCatalogueKey);
    project();
  };

  /**
   * One context's catalogue, read from the entry that belongs to it.
   *
   * The entry is keyed by the session, so this is the answer FOR that session
   * rather than the answer that happens to be shown.
   */
  const readModelsFor = (
    sessionId?: string,
  ): WebuiResourceState<readonly WebuiModelEntry[]> => {
    const key = catalogueKeyFor(sessionId);
    return retainedCatalogue(key, catalogue.read(key)) ?? idleWebuiResourceState();
  };

  /**
   * Read one context's catalogue without selecting it.
   *
   * The answer lands under its own key, so a caller asking about session B gets
   * B's catalogue without B becoming what session A's view renders.
   */
  const acquireModels = async (sessionId?: string): Promise<void> => {
    if (disposed || (sessionId !== undefined && releasedSessions.has(sessionId))) return;
    if (!port.listModels) {
      unavailable("models", "当前运行时不支持模型列表。");
      return;
    }
    const key = catalogueKeyFor(sessionId);
    // Bound for the same reason the shown key is: a credential or configuration
    // advance retires this answer too, and only the keys that carry that epoch.
    bindCatalogueEpochs(key);
    await catalogue.load(key, () => port.listModels!(sessionId ? { sessionId } : undefined));
  };

  /** The foreground read: show this context's catalogue and read it. */
  const loadModels = async (sessionId?: string): Promise<void> => {
    if (disposed || (sessionId !== undefined && releasedSessions.has(sessionId))) return;
    if (!port.listModels) {
      unavailable("models", "当前运行时不支持模型列表。");
      return;
    }
    selectCatalogue(sessionId);
    await catalogue.load(shownCatalogueKey, () =>
      port.listModels!(sessionId ? { sessionId } : undefined),
    );
  };

  const selectModel = async (request: {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
    readonly sessionId?: string;
  }): Promise<void> => {
    if (!port.selectModel) throw new Error("当前运行时不支持模型切换。");
    // The answer's own `success` flag is the runtime's verdict, and a refused
    // selection must not read as one that landed: the composer's raw-prop version
    // checked it, and moving the call here moves the check with it.
    const answer = await port.selectModel(request);
    if (answer?.success === false) throw new Error("The model could not be selected");
    // The selection is a property of the model list: re-read so the marked row
    // follows, and bump this owner's revision so its readers refresh.
    await loadModels(request.sessionId);
    markModels();
  };

  const loadProviders = async (): Promise<void> => {
    if (disposed) return;
    if (!port.listUserModelProviders) {
      unavailable("providers", "当前运行时不支持自定义提供商。");
      return;
    }
    // Read, compose, then commit — one publication. Awaiting a plain load first would commit
    // the server's list on its own, and every subscriber would see this owner's newer intent
    // replaced by an answer that predates it for the length of a round trip.
    const key = providerKey();
    providerKeys.set(serializeWebuiResourceKey(key), key);
    const token = providerList.capture(key);
    let answer: readonly WebuiModelProviderView[];
    try {
      answer = await port.listUserModelProviders();
    } catch (reason) {
      providerList.commit(token, {
        status: "error",
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return;
    }
    // A successful read is the committed baseline: it is what a known rejection restores, and
    // what an intent composes against when nothing is pending.
    for (const provider of answer) {
      committedModels.set(provider.providerId, provider.models);
    }
    providerList.commit(token, { status: "ready", value: shownRows(answer) });
  };

  /** A provider mutation refreshes the provider list and marks models stale. */
  const afterProviderMutation = async (): Promise<void> => {
    markModels();
    invalidateCatalogue();
    // The write landed, so answers computed under the previous configuration are
    // no longer current. Advancing after the mutation — never before — is what
    // keeps a failed write from retiring answers that are still true.
    afterConfigurationWrite();
    await loadProviders();
  };

  /**
   * What this owner currently intends for each provider's model list.
   *
   * The pending projection is the owner's, not a rendered prop's: an intent
   * captured while an earlier write is still in flight composes with that
   * intent, which is what stops a slow response from erasing a newer local
   * decision.
   */
  const pendingModels = new Map<string, readonly WebuiModelProviderModelEntry[]>();
  /** One write chain per provider; different providers stay independent. */
  const providerWriteChains = new Map<string, Promise<unknown>>();
  /** The last value the runtime confirmed, per provider, for a known rejection. */
  const committedModels = new Map<string, readonly WebuiModelProviderModelEntry[]>();

  const modelsOfProvider = (providerId: string): readonly WebuiModelProviderModelEntry[] | undefined =>
    pendingModels.get(providerId) ??
    committedModels.get(providerId) ??
    providerList.read(providerKey())?.value?.find((provider) => provider.providerId === providerId)?.models;

  /** One provider's list replaced, leaving its neighbours alone. */
  const withProviderModels = (
    providers: readonly WebuiModelProviderView[],
    providerId: string,
    models: readonly WebuiModelProviderModelEntry[],
  ): readonly WebuiModelProviderView[] =>
    providers.map((provider) =>
      provider.providerId === providerId ? { ...provider, models } : provider,
    );

  /**
   * The rows as this owner shows them: an answer with the intents it has not retired applied.
   *
   * Composed *before* the commit rather than after it. The commit is what notifies, so a
   * subscriber shown the server's baseline first has seen the obsolete list, however briefly,
   * and then sees the intent come back — a public state that says the change was lost and then
   * that it was not. Composition happens first; there is one publication.
   */
  const shownRows = (
    providers: readonly WebuiModelProviderView[],
  ): readonly WebuiModelProviderView[] => {
    let shown = providers;
    for (const [id, models] of pendingModels) shown = withProviderModels(shown, id, models);
    return shown;
  };

  /**
   * Show one provider's restored list together with the intents this owner still holds.
   *
   * The list it sits in is passed in rather than re-read: freshness has already advanced by
   * the time the intent is shown (the write retired the reads that started before it), and a
   * read taken after that advance describes a state this write is replacing. The projection is
   * where a surface reads the value, so the commit still goes through the resource and the
   * next successful read is still the truth.
   */
  const showProviderModels = (
    providers: readonly WebuiModelProviderView[],
    providerId: string,
    models: readonly WebuiModelProviderModelEntry[],
  ): void => {
    providerList.commit(providerList.capture(providerKey()), {
      status: "ready",
      value: shownRows(withProviderModels(providers, providerId, models)),
    });
  };

  /** The provider rows this owner is currently projecting, if it has any. */
  const projectedProviders = (): readonly WebuiModelProviderView[] | undefined =>
    providerList.read(providerKey())?.value;

  /**
   * Apply one captured intent against the current pending projection and write it.
   *
   * The projection is read *inside* the serialized step, so two intents captured
   * in either order compose, and the write always carries the owner's latest
   * intent for that provider rather than whichever array a caller happened to hold.
   */
  const writeProviderIntent = (
    providerId: string,
    transform: (
      current: readonly WebuiModelProviderModelEntry[],
    ) => readonly WebuiModelProviderModelEntry[] | undefined,
  ): Promise<WebuiMutationOutcome<void>> => {
    const update = port.updateUserModelProvider;
    if (!update) {
      return Promise.resolve({
        status: "failed",
        category: "refused",
        error: new Error("当前运行时不支持自定义提供商。"),
      });
    }

    // Captured and published *now*, before the write queue is consulted: what the user
    // asked for is the owner's current intent the moment they ask for it. Composing the
    // intent inside the serialized step instead meant a second toggle waited behind the
    // first write — one write in flight, the display still showing the old list for the
    // second change, and a user watching their own edit not appear.
    const current = modelsOfProvider(providerId);
    if (!current) {
      return Promise.resolve({
        status: "failed",
        category: "refused",
        error: new Error("提供商当前不可用，无法修改其模型。"),
      });
    }
    const intent = transform(current);
    if (!intent) return Promise.resolve({ status: "settled", value: undefined });
    pendingModels.set(providerId, intent);
    // The rows the intent is shown in, taken before freshness advances: a read taken
    // after the retire would be describing the state this write replaces.
    const providers = projectedProviders() ?? [];
    // A read that started before this write described a state this write is replacing,
    // so its answer must not land on top: freshness advances first, then the intent is
    // shown.
    providerList.invalidate(providerKey());
    if (providers.length > 0) showProviderModels(providers, providerId, intent);

    const run = async (): Promise<WebuiMutationOutcome<void>> => {
      // What this write carries is the intent at the moment the queue reaches it, so an
      // intent captured while an earlier write was in flight is the one sent — not the
      // one that happened to be current when the command was issued.
      const sent = pendingModels.get(providerId) ?? intent;
      const outcome = await runWebuiMutation<void>(async () => {
        await update({
          providerId,
          models: sent.map((model) => ({
            modelId: model.modelId,
            ...(model.enabled === undefined ? {} : { enabled: model.enabled }),
          })) as WebuiUpdateUserModelProviderRequest["models"],
        });
      });
      if (outcome.status === "settled") {
        committedModels.set(providerId, sent);
        // Only this intent is retired: a newer one captured while the write was in
        // flight is what the owner will send next, and dropping it here is exactly how
        // an earlier answer erased a later decision.
        if (pendingModels.get(providerId) === sent) pendingModels.delete(providerId);
        // The reload is the truth; a refusal or an unknown outcome is not. A refresh
        // that fails is not a failed write, so it cannot turn a settled mutation into
        // a rejection.
        await loadProviders().catch(() => undefined);
        await loadModels().catch(() => undefined);
        return outcome;
      }
      if (outcome.category === "refused" || outcome.category === "conflict") {
        // The runtime decided, so this intent is wrong: drop it and put the last
        // committed value back rather than leaving a change on screen that did not
        // happen.
        if (pendingModels.get(providerId) === sent) pendingModels.delete(providerId);
        const committed = committedModels.get(providerId);
        const rows = projectedProviders();
        // Intents this owner still holds are not this provider's refusal: `showProviderModels`
        // publishes the restored baseline and them together, in one state.
        if (committed && rows) showProviderModels(rows, providerId, committed);
        else await loadProviders().catch(() => undefined);
        return outcome;
      }
      // Transport failure, timeout or a lost response: the write may or may not have
      // landed, so the answer is reconciled by reading rather than by retrying the
      // mutation. The read is the reconcile — it is not permission to overwrite the
      // intent with it: the owner still holds what it will send next, and a display
      // showing the server's answer while the intent differs is the contradiction this
      // protocol exists to remove.
      // The reload already publishes the answer composed with what is still intended.
      await loadProviders().catch(() => undefined);
      return outcome;
    };
    const previous = providerWriteChains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(run);
    providerWriteChains.set(
      providerId,
      queued.catch(() => undefined),
    );
    return queued;
  };

  const setProviderModelEnabled = (intent: {
    readonly providerId: string;
    readonly modelId: string;
    readonly enabled: boolean;
  }): Promise<WebuiMutationOutcome<void>> =>
    writeProviderIntent(intent.providerId, (current) =>
      current.map((model) =>
        model.modelId === intent.modelId ? { ...model, enabled: intent.enabled } : model,
      ),
    );

  const reorderProviderModels = (intent: {
    readonly providerId: string;
    readonly orderedModelIds: readonly string[];
  }): Promise<WebuiMutationOutcome<void>> =>
    writeProviderIntent(intent.providerId, (current) => {
      const byId = new Map(current.map((model) => [model.modelId, model]));
      const ordered = intent.orderedModelIds
        .map((modelId) => byId.get(modelId))
        .filter((model): model is WebuiModelProviderModelEntry => model !== undefined);
      if (ordered.length !== current.length) return undefined;
      return ordered;
    });

  const createProvider = async (body: WebuiCreateUserModelProviderRequest): Promise<unknown> => {
    if (!port.createUserModelProvider) throw new Error("当前运行时不支持自定义提供商。");
    const result = await port.createUserModelProvider(body);
    await afterProviderMutation();
    return result;
  };

  const updateProvider = async (body: WebuiUpdateUserModelProviderRequest): Promise<unknown> => {
    if (!port.updateUserModelProvider) throw new Error("当前运行时不支持自定义提供商。");
    try {
      const result = await port.updateUserModelProvider(body);
      await afterProviderMutation();
      return result;
    } catch (reason) {
      // Undo an optimistic patch by re-reading the truth.
      await loadProviders();
      throw reason;
    }
  };

  const deleteProvider = async (providerId: string): Promise<unknown> => {
    if (!port.deleteUserModelProvider) throw new Error("当前运行时不支持自定义提供商。");
    const result = await port.deleteUserModelProvider(providerId);
    await afterProviderMutation();
    return result;
  };

  const testProvider = async (body: {
    readonly providerId: string;
    readonly apiKey?: string;
  }): Promise<unknown> => {
    if (!port.testUserModelProvider) throw new Error("当前运行时不支持提供商连通性测试。");
    return port.testUserModelProvider(body);
  };

  const testModel = async (body: {
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<unknown> => {
    if (!port.testUserModel) throw new Error("当前运行时不支持模型测试。");
    return port.testUserModel(body);
  };

  const discoverCandidate = async (
    body: WebuiDiscoverUserModelsCandidateRequest,
  ): Promise<WebuiProviderDiscoveryOutcome> => {
    if (!port.discoverUserModelsCandidate) throw new Error("当前运行时不支持模型发现。");
    return decodeWebuiProviderDiscoveryOutcome(await port.discoverUserModelsCandidate(body));
  };

  const saveCandidate = async (
    body: WebuiSaveUserModelProviderCandidateRequest,
  ): Promise<WebuiProviderSaveOutcome> => {
    if (!port.saveUserModelProviderCandidate) throw new Error("当前运行时不支持保存提供商。");
    const result = decodeWebuiProviderSaveOutcome(
      await port.saveUserModelProviderCandidate(body),
    );
    // Only a save that actually committed changes the catalogue. Invalidation is
    // not "the request was made": a refusal or a conflict leaves the provider
    // list exactly as it was, and refreshing it would make a failed save look
    // like it had taken effect.
    if (result.outcome === "success") await afterProviderMutation();
    return result;
  };

  const testCandidate = async (
    body: WebuiTestUserModelCandidateRequest,
  ): Promise<WebuiProviderTestOutcome> => {
    if (!port.testUserModelCandidate) throw new Error("当前运行时不支持模型测试。");
    return decodeWebuiProviderTestOutcome(await port.testUserModelCandidate(body));
  };

  const revealApiKey = async (providerId: string): Promise<string> => {
    if (!port.revealModelProviderApiKey) throw new Error("当前运行时不支持查看密钥。");
    return port.revealModelProviderApiKey({ providerId });
  };

  const loadPresets = async (): Promise<void> => {
    if (!port.listProviderPresets) {
      unavailable("presets", "当前运行时不支持提供商预设。");
      return;
    }
    await presetList.load(PRESETS_KEY, () => port.listProviderPresets!());
  };

  const upsertApiKey = async (body: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<unknown> => {
    if (!port.upsertMiniMaxApiKey) throw new Error("当前运行时不支持保存 API key。");
    const result = await port.upsertMiniMaxApiKey(body);
    markModels();
    invalidateCatalogue();
    // A credential write retires both generations: the credential changed, and
    // the catalogue it unlocks may have too.
    afterCredentialWrite();
    // The api-key *status* read is `settings`', so this owner calls that
    // owner's published command instead of holding a second copy of the read.
    await refreshApiKeyStatus();
    return result;
  };

  const refreshModels = async (): Promise<unknown> => {
    if (!port.refreshModels) throw new Error("当前运行时不支持刷新模型。");
    const result = await port.refreshModels();
    // A refresh is acquisition, not selection: the user did not ask to look at a
    // different context by asking for fresher data.
    await acquireModels(shownSessionId);
    return result;
  };

  return {
    getSnapshot,
    subscribe,
    canReadModels: port.listModels !== undefined,
    canSelectModel: port.selectModel !== undefined,
    canManageProviders: port.listUserModelProviders !== undefined,
    canReadPresets: port.listProviderPresets !== undefined,
    canUpsertApiKey: port.upsertMiniMaxApiKey !== undefined,
    loadModels,
    acquireModels,
    selectCatalogue,
    readModelsFor,
    setProviderModelEnabled,
    reorderProviderModels,
    selectModel,
    loadProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    testModel,
    discoverCandidate,
    saveCandidate,
    testCandidate,
    revealApiKey,
    loadPresets,
    upsertApiKey,
    refreshModels,
    releaseSession: (sessionId: string) => {
      for (const [serialized, key] of catalogueKeys) {
        if (key.sessionId !== sessionId) continue;
        catalogueKeys.delete(serialized); catalogue.release(key);
        // The retained answer belongs to the released session, so it goes with it:
        // a released session's models must not be projected for anyone.
        retainedCatalogues.delete(serialized);
      }
      releasedSessions.add(sessionId);
      project();
    },
    dispose: () => {
      disposed = true;
      stopEpochs?.();
      catalogueKeys.clear(); providerKeys.clear(); releasedSessions.clear();
      retainedCatalogues.clear();
      listeners.clear();
      catalogue.dispose();
      providerList.dispose();
      presetList.dispose();
    },
  };
}
