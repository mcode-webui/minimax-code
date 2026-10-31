// The settings workflow owner.
//
// One owner for every *settings* surface the browser reads and writes:
// personalization (global instructions, the user profile, agent memory and the
// memory switches), the model source, the api-key status and the Codex OAuth
// status. The model catalogue, the selection and the provider list are `models`'
// (`models-workflows.ts`) — the provider form's commands belong to that business
// while this owner renders the page. The settings dialog and the usage page used
// to hold their own copies of each answer and decide their own error strings;
// here one cache answers both.
//
// Two boundaries are deliberate:
//
//  - **A read reports its own outcome.** Every read below returns the
//    `WebuiResourceLoadOutcome` of *its* request, so a caller learns what it got
//    without re-reading a shared mutable snapshot and hoping it still holds that
//    request's answer. The snapshot remains what a surface *renders*; it is not
//    how a caller discovers its own result.
//  - **A submitted write is a fact, an uncommitted form is not.** A write returns
//    its result to the caller and invalidates exactly the caches it affects. The
//    uncommitted text stays in the component — that is the boundary, not an
//    omission — and the application owns only what was submitted.
//
// The memory panel reads twice, deliberately: a summary (existence, size,
// timestamp) and the body. Those are two request identities, not one overloaded
// value, so a stale body can never be presented as the current summary and the
// two settle independently.
//
// This module is framework-free — no React, no DOM, no storage — so it can be
// unit-tested against a scripted port.

import type { WebuiIdentityEpochs } from "../../../application/identity-epochs.js";
import { createWebuiSnapshotStore } from "../../../application/snapshot-store.js";
import {
  runWebuiMutation,
  createWebuiKeyedResource,
  idleWebuiResourceState,
  webuiResourceMessage,
  type WebuiKeyedResource,
  type WebuiResourceKey,
  type WebuiResourceLoadOutcome,
  type WebuiResourceState,
} from "../../../conversation/request-freshness.js";
import { WebuiErrorCode } from "../../../../shared/envelope.js";
import {
  type SettingsPort,
  type WebuiPermissionMode,
} from "../contracts/settings-port.js";
import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileFields,
  WebuiUserProfileView,
} from "../../../../shared/contracts/personalization.js";

/**
 * The settings half of the port. The provider half this workflow used to consume
 * is `models`' now: `models-workflows.ts` declares `WebuiModelsPortSlice` over
 * the same port, so the two owners no longer share one slice.
 */
export type WebuiSettingsPortSlice = Pick<
  SettingsPort,
  | "getGlobalInstructions"
  | "setGlobalInstructions"
  | "getUserProfile"
  | "setUserProfile"
  | "getAgentMemory"
  | "setAgentMemory"
  | "getMemorySettings"
  | "setMemorySettings"
  | "getMiniMaxApiKeyStatus"
  | "getCodexOAuthStatus"
  | "getMiniMaxModelSource"
  | "setMiniMaxModelSource"
  | "startCodexOAuthLogin"
  | "cancelCodexOAuthLogin"
  | "getPermissionMode"
  | "setPermissionMode"
  | "version"
>;

export type WebuiModelSource = "token_plan" | "minimax_api_key";

/**
 * The preference a runtime answer carries, or `undefined` when it carries none
 * this client can act on. The wire answer may be the bare mode or an object with
 * a `mode` field — `getPermissionMode` returns `unknown`, so the coercion has to
 * happen somewhere, and it happens at the owner rather than in the surface that
 * renders the switch.
 */
export function readWebuiPermissionMode(value: unknown): WebuiPermissionMode | undefined {
  const mode = typeof value === "string"
    ? value
    : value && typeof value === "object" && "mode" in value
      ? (value as { mode?: unknown }).mode
      : undefined;
  return mode === "default" || mode === "auto" || mode === "bypassPermissions"
    ? mode
    : undefined;
}

export interface WebuiSettingsWorkflowsState {
  /** Bumps after any successful settings write, so a reader can refresh. */
  readonly revision: number;
  readonly instructions: WebuiResourceState<WebuiGlobalInstructionsView>;
  readonly profile: WebuiResourceState<WebuiUserProfileView>;
  /**
   * The memory *summary*: existence, size and timestamp, without the body.
   *
   * Separate from `agentMemoryContent` because they are two request identities.
   * One field holding either would let a pending body read report as though the
   * summary had settled, and would make the summary's freshness depend on a read
   * the panel only sometimes makes.
   */
  readonly agentMemorySummary: WebuiResourceState<WebuiAgentMemoryView>;
  /** The memory *body*, read only when the editor is open. */
  readonly agentMemoryContent: WebuiResourceState<WebuiAgentMemoryView>;
  readonly memorySettings: WebuiResourceState<WebuiMemorySettingsView>;
  readonly modelSource: WebuiResourceState<WebuiModelSource>;
  /**
   * The runtime handshake fact (version, protocolVersion, dataDir).
   *
   * It is a `SettingsPort` method like any other, so it is read through this
   * owner rather than invoked by a component: the shell and the surfaces it
   * feeds read `runtimeVersion.value` from the snapshot.
   */
  readonly runtimeVersion: WebuiResourceState<WebuiVersionInfo>;
  /**
   * The permission preference, read from the runtime.
   *
   * It is a cached read like the others, and the surface that renders the switch
   * reads `permissionMode.value` / `.error` off the snapshot instead of holding
   * a copy: one owner, one answer.
   */
  readonly permissionMode: WebuiResourceState<WebuiPermissionMode>;
}

export const initialWebuiSettingsWorkflowsState: WebuiSettingsWorkflowsState = {
  revision: 0,
  instructions: idleWebuiResourceState(),
  profile: idleWebuiResourceState(),
  agentMemorySummary: idleWebuiResourceState(),
  agentMemoryContent: idleWebuiResourceState(),
  memorySettings: idleWebuiResourceState(),
  modelSource: idleWebuiResourceState(),
  runtimeVersion: idleWebuiResourceState(),
  permissionMode: idleWebuiResourceState(),
};

export interface WebuiSettingsWorkflows {
  readonly getSnapshot: () => WebuiSettingsWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;

  readonly canReadInstructions: boolean;
  readonly canWriteInstructions: boolean;
  readonly canReadProfile: boolean;
  readonly canWriteProfile: boolean;
  readonly canReadMemory: boolean;
  readonly canWriteMemory: boolean;
  readonly canReadMemorySettings: boolean;
  readonly canWriteMemorySettings: boolean;
  readonly canStartCodexOAuth: boolean;
  readonly canReadModelSource: boolean;
  readonly canSetModelSource: boolean;
  readonly canReadVersion: boolean;
  readonly canReadPermissionMode: boolean;
  readonly canWritePermissionMode: boolean;

  /**
   * Read the permission preference. The outcome is this request's own: a
   * superseded answer says so instead of the caller re-reading the snapshot and
   * assuming it holds this request's value, and an answer this client cannot act
   * on is reported as an error rather than as a silent absence.
   */
  readonly loadPermissionMode: () => Promise<WebuiResourceLoadOutcome<WebuiPermissionMode>>;
  /** Write; returns the mode the runtime answered with, or fails. */
  readonly savePermissionMode: (mode: WebuiPermissionMode) => Promise<WebuiPermissionMode>;

  /**
   * Read the runtime handshake fact, reporting this request's own outcome.
   */
  readonly loadVersion: () => Promise<WebuiResourceLoadOutcome<WebuiVersionInfo>>;

  readonly loadInstructions: () => Promise<WebuiResourceLoadOutcome<WebuiGlobalInstructionsView>>;
  /** Save; returns the runtime's answer and refreshes the cached read. */
  readonly saveInstructions: (content: string) => Promise<WebuiGlobalInstructionsView>;

  readonly loadProfile: () => Promise<WebuiResourceLoadOutcome<WebuiUserProfileView>>;
  readonly saveProfile: (fields: WebuiUserProfileFields) => Promise<WebuiUserProfileView>;

  /**
   * Read memory. `includeContent` selects which identity is read: the summary and
   * the body are cached under separate keys, so an overlapping pair settles in
   * either order without either being presented as the other.
   */
  readonly loadAgentMemory: (
    includeContent?: boolean,
  ) => Promise<WebuiResourceLoadOutcome<WebuiAgentMemoryView>>;
  readonly saveAgentMemory: (content: string) => Promise<WebuiAgentMemoryView>;

  readonly loadMemorySettings: () => Promise<WebuiResourceLoadOutcome<WebuiMemorySettingsView>>;
  readonly saveMemorySettings: (patch: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }) => Promise<WebuiMemorySettingsView>;

  readonly startCodexOAuth: (body?: Record<string, unknown>) => Promise<unknown>;
  readonly cancelCodexOAuth: (loginId: string) => Promise<unknown>;
  readonly loadModelSource: () => Promise<WebuiResourceLoadOutcome<WebuiModelSource>>;
  readonly setModelSource: (source: WebuiModelSource) => Promise<void>;
  /**
   * Release every cached read.
   *
   * Disposal is what makes a read that never answers distinguishable from one
   * that was superseded: an answer still in flight can no longer commit, and a
   * read issued afterwards reports `disposed` without reaching the transport.
   */
  readonly dispose: () => void;
}

export function createWebuiSettingsWorkflows(deps: {
  readonly port: WebuiSettingsPortSlice;
  /**
   * The application's opaque generation context. An instruction, memory, profile
   * or preference write changes the configuration answers were computed under,
   * so the write advances that generation.
   */
  readonly identityEpochs?: WebuiIdentityEpochs;
}): WebuiSettingsWorkflows {
  const { port } = deps;
  /** Called after a write landed: only a successful write retires answers. */
  const afterConfigurationWrite = (): void => {
    deps.identityEpochs?.advance("configuration");
  };
  // The snapshot is where this owner's answers are *published*, so a surface can
  // render them. The fence belongs to the keyed resources below, which is why
  // this store knows nothing about reads: a read that was superseded reports
  // itself to its caller and never reaches a field.
  const { getSnapshot, subscribe, set } =
    createWebuiSnapshotStore(initialWebuiSettingsWorkflowsState);
  const withResource = <Field extends keyof WebuiSettingsWorkflowsState, T>(
    current: WebuiSettingsWorkflowsState,
    field: Field,
    value: WebuiResourceState<T>,
  ): WebuiSettingsWorkflowsState =>
    ({ ...current, [field]: value }) as WebuiSettingsWorkflowsState;
  const unavailable = <Field extends keyof WebuiSettingsWorkflowsState>(
    field: Field,
    error: string,
  ): void => {
    set((current) => withResource(current, field, { status: "error", error }));
  };

  /**
   * One cached read, keyed by identity.
   *
   * The key is the read's own identity — which resource, and for memory whether
   * the body was asked for — so the body and the summary are separate requests
   * that settle independently instead of two writes into one field. Every read
   * publishes into the snapshot for the surface to render *and* returns the
   * outcome of its own request, which is how a caller stops re-reading the
   * snapshot to find out what it got.
   */
  const readInto = <Field extends keyof WebuiSettingsWorkflowsState, T>(
    field: Field,
    resource: WebuiKeyedResource<T>,
    key: WebuiResourceKey,
    capability: string,
    fetch: () => Promise<T>,
  ): Promise<WebuiResourceLoadOutcome<T>> => {
    resource.subscribe(() => {
      const entry = resource.read(key);
      set((current) => withResource(current, field, entry ?? idleWebuiResourceState()));
    });
    return resource.load(key, fetch).then((outcome) => {
      // A host that says it cannot answer at all is recorded as not supporting
      // the capability, so the surface stops offering a control that would keep
      // refusing. A failure from a supported capability is left alone: that one
      // is worth retrying and must not hide the control.
      if (outcome.status === "failed") markRefused(capability, outcome.error);
      return outcome;
    });
  };

  const instructions = createWebuiKeyedResource<WebuiGlobalInstructionsView>();
  const profile = createWebuiKeyedResource<WebuiUserProfileView>();
  const memorySummary = createWebuiKeyedResource<WebuiAgentMemoryView>();
  const memoryContent = createWebuiKeyedResource<WebuiAgentMemoryView>();
  const memorySettings = createWebuiKeyedResource<WebuiMemorySettingsView>();
  const modelSource = createWebuiKeyedResource<WebuiModelSource>();
  const runtimeVersion = createWebuiKeyedResource<WebuiVersionInfo>();
  const permissionMode = createWebuiKeyedResource<WebuiPermissionMode>();

  /**
   * Which cached reads the configuration generation is responsible for.
   *
   * A settings write advances that generation, so the answers it invalidates are
   * not decided one call site at a time — they are every key this generation
   * participates in. Binding them here means an in-flight read is retired by the
   * write that makes it wrong, and reports `superseded`, instead of landing on
   * top of the value the write just committed.
   *
   * `permissionMode` is deliberately absent. Its write does not advance this
   * generation, and retiring a cached answer on a change that does not affect it
   * would be an invalidation the current behaviour does not have.
   */
  const boundReads: Array<WebuiKeyedResource<unknown>> = [];
  const bindToConfiguration = <T>(resource: WebuiKeyedResource<T>, key: WebuiResourceKey): void => {
    const epochs = deps.identityEpochs;
    if (!epochs) return;
    resource.bindEpoch(
      {
        token: () => epochs.configuration().token,
        subscribe: (listener) =>
          epochs.subscribe((advanced) => {
            if (advanced.key === "configuration") listener();
          }),
      },
      key,
    );
    boundReads.push(resource as WebuiKeyedResource<unknown>);
  };
  bindToConfiguration(instructions, { read: "instructions" });
  bindToConfiguration(profile, { read: "profile" });
  bindToConfiguration(memorySummary, { read: "agentMemory", content: false });
  bindToConfiguration(memoryContent, { read: "agentMemory", content: true });
  bindToConfiguration(memorySettings, { read: "memorySettings" });
  bindToConfiguration(modelSource, { read: "modelSource" });
  bindToConfiguration(runtimeVersion, { read: "version" });

  /**
   * A read whose capability is absent.
   *
   * Reported as a failure carrying this owner's own message, so a caller waiting
   * on the outcome learns the same thing the snapshot shows instead of finding an
   * idle field and inventing its own wording.
   */
  const unsupported = <T>(error: string): Promise<WebuiResourceLoadOutcome<T>> => {
    const reason = new Error(error);
    return Promise.resolve({ status: "failed", error: reason });
  };

  /**
   * Which capabilities this host has told us it does not implement.
   *
   * The reason this exists: `port.getAgentMemory !== undefined` answers "does
   * this client stub have the method", and in the real application the answer is
   * always yes — the transport's table names every operation the protocol
   * defines. Reading that as "the host supports it" is how the 记忆 panel
   * rendered on a host with no memory capability, and how every such host looked
   * identical to one where the feature was present but failing.
   *
   * A host that refuses with `capability_unavailable` is the only thing that can
   * answer the question, so the answer is recorded when one does. It stays
   * recorded: a host does not grow a capability while the page is open, and a
   * control that flickers back on each time the owner is rebuilt is worse than
   * one that stays hidden.
   */
  const refusedCapabilities = new Set<string>();
  const isSupported = (capability: string, present: boolean): boolean =>
    present && !refusedCapabilities.has(capability);

  const markRefused = (capability: string, error: unknown): void => {
    const code = error && typeof error === "object" ? (error as { readonly code?: unknown }).code : undefined;
    if (code === WebuiErrorCode.capabilityUnavailable) refusedCapabilities.add(capability);
  };

  const markRevision = (): void => {
    set((current) => ({ ...current, revision: current.revision + 1 }));
  };

  /** A provider change can add or remove models, so the model list is stale. */


  /**
   * One write chain per resource.
   *
   * Same-resource writes serialize; different resources stay independent. Without
   * this, two saves of one field raced: the later response could land first, and
   * the earlier one then overwrote it with the value the user had already
   * replaced.
   */
  const writeChains = new Map<string, Promise<unknown>>();
  const serializeWrite = <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const previous = writeChains.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    writeChains.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  };

  /** The last value this owner committed for one read, for restoring it. */
  const committed = new Map<string, WebuiResourceState<unknown>>();

  /**
   * One settings write, with the ordering the resource contract requires.
   *
   *   1. **Write-start retirement.** A read that started before this write
   *      describes a state this write is replacing, so its answer must not land
   *      on top: freshness advances first.
   *   2. **Serialize.** Another write to the same resource queues behind this one.
   *   3. **Known success** advances the configuration generation and commits the
   *      runtime's own answer.
   *   4. **Known rejection** leaves the last committed value exactly as it was —
   *      the write did not happen, and showing a change that did not happen is
   *      worse than showing the old one.
   *   5. **Unknown outcome** (a lost response, a timeout) reconciles by re-reading
   *      under the same request identity: the write may have landed, so the only
   *      honest next thing is to find out rather than to retry it blindly.
   */
  const saveWithCommit = <T>(options: {
    readonly name: string;
    readonly resource: WebuiKeyedResource<T>;
    readonly key: WebuiResourceKey;
    readonly write: () => Promise<T>;
    readonly reconcile: () => Promise<unknown>;
    readonly advanceConfiguration?: boolean;
  }): Promise<T> =>
    serializeWrite(options.name, async () => {
      options.resource.invalidate(options.key);
      const outcome = await runWebuiMutation(options.write);
      if (outcome.status === "settled") {
        if (options.advanceConfiguration !== false) afterConfigurationWrite();
        options.resource.commit(options.resource.capture(options.key), {
          status: "ready",
          value: outcome.value,
        });
        committed.set(options.name, { status: "ready", value: outcome.value });
        set((current) => ({ ...current, revision: current.revision + 1 }));
        return outcome.value;
      }
      const error =
        outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      if (outcome.category === "refused" || outcome.category === "conflict") {
        // The runtime answered. The committed value is still the truth, and it is
        // put back explicitly so no surface is left showing the intent.
        const previous = committed.get(options.name);
        if (previous) {
          // Stored by name, restored into the resource that owns that name.
          options.resource.commit(
            options.resource.capture(options.key),
            previous as WebuiResourceState<T>,
          );
        }
        throw error;
      }
      // Unknown: reconcile, then report. Never an automatic retry — a mutation
      // whose response was lost may have taken effect.
      await options.reconcile().catch(() => undefined);
      throw error;
    });

  const loadInstructions = (): Promise<WebuiResourceLoadOutcome<WebuiGlobalInstructionsView>> => {
    if (!port.getGlobalInstructions) {
      unavailable("instructions", "当前运行时不支持自定义指令读写。");
      return unsupported("当前运行时不支持自定义指令读写。");
    }
    return readInto("instructions", instructions, { read: "instructions" }, "instructions", () =>
      port.getGlobalInstructions!(),
    );
  };

  const saveInstructions = (content: string): Promise<WebuiGlobalInstructionsView> => {
    if (!port.setGlobalInstructions) {
      return Promise.reject(new Error("当前运行时不支持自定义指令读写。"));
    }
    return saveWithCommit({
      name: "instructions",
      resource: instructions,
      key: { read: "instructions" },
      write: () => port.setGlobalInstructions!({ content }),
      reconcile: () => loadInstructions(),
    });
  };

  const loadProfile = (): Promise<WebuiResourceLoadOutcome<WebuiUserProfileView>> => {
    if (!port.getUserProfile) {
      unavailable("profile", "当前运行时不支持「关于你」读写。");
      return unsupported("当前运行时不支持「关于你」读写。");
    }
    return readInto("profile", profile, { read: "profile" }, "profile", () => port.getUserProfile!());
  };

  const saveProfile = (fields: WebuiUserProfileFields): Promise<WebuiUserProfileView> => {
    if (!port.setUserProfile) {
      return Promise.reject(new Error("当前运行时不支持「关于你」读写。"));
    }
    return saveWithCommit({
      name: "profile",
      resource: profile,
      key: { read: "profile" },
      write: () => port.setUserProfile!(fields),
      reconcile: () => loadProfile(),
    });
  };

  /**
   * Read memory — summary or body.
   *
   * The two go to different keyed resources, which is the whole point: the panel
   * reads the summary on open and the body only when the editor appears, and an
   * overlapping pair must not have one request's answer presented as the other's.
   * They are published into separate snapshot fields for the same reason.
   */
  const loadAgentMemory = (
    includeContent = false,
  ): Promise<WebuiResourceLoadOutcome<WebuiAgentMemoryView>> => {
    if (!port.getAgentMemory) {
      unavailable(includeContent ? "agentMemoryContent" : "agentMemorySummary", "当前运行时不支持长期记忆读写。");
      return unsupported("当前运行时不支持长期记忆读写。");
    }
    return includeContent
      ? readInto(
          "agentMemoryContent",
          memoryContent,
          { read: "agentMemory", content: true },
          "agentMemory",
          () => port.getAgentMemory!({ includeContent: true }),
        )
      : readInto(
          "agentMemorySummary",
          memorySummary,
          { read: "agentMemory", content: false },
          "agentMemory",
          () => port.getAgentMemory!(),
        );
  };

  const saveAgentMemory = (content: string): Promise<WebuiAgentMemoryView> =>
    // Two request identities are refreshed from one write, so the chain helper's
    // single-resource commit does not fit: the write is serialized and the
    // outcome handled here, with both identities committed from the answer.
    serializeWrite("agentMemory", async () => {
      if (!port.setAgentMemory) throw new Error("当前运行时不支持长期记忆读写。");
      const contentKey = { read: "agentMemory", content: true };
      const summaryKey = { read: "agentMemory", content: false };
      memoryContent.invalidate(contentKey);
      memorySummary.invalidate(summaryKey);
      const outcome = await runWebuiMutation(() => port.setAgentMemory!({ content }));
      if (outcome.status === "settled") {
        const value = outcome.value;
        afterConfigurationWrite();
        // The write answers with the body it committed, so both identities are
        // refreshed from it: a summary still showing the pre-write size would be
        // reporting a file state that no longer exists.
        memoryContent.commit(memoryContent.capture(contentKey), { status: "ready", value });
        memorySummary.commit(memorySummary.capture(summaryKey), {
          status: "ready",
          value: { ...value, content: undefined },
        });
        committed.set("agentMemory", { status: "ready", value });
        set((current) => ({ ...current, revision: current.revision + 1 }));
        return value;
      }
      const error =
        outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      if (outcome.category !== "refused" && outcome.category !== "conflict") {
        await loadAgentMemory(true).catch(() => undefined);
      }
      throw error;
    });

  const loadMemorySettings = (): Promise<WebuiResourceLoadOutcome<WebuiMemorySettingsView>> => {
    if (!port.getMemorySettings) {
      unavailable("memorySettings", "当前运行时不支持记忆开关。");
      return unsupported("当前运行时不支持记忆开关。");
    }
    return readInto("memorySettings", memorySettings, { read: "memorySettings" }, "memorySettings", () =>
      port.getMemorySettings!(),
    );
  };

  const saveMemorySettings = (patch: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<WebuiMemorySettingsView> => {
    if (!port.setMemorySettings) {
      return Promise.reject(new Error("当前运行时不支持记忆开关。"));
    }
    return saveWithCommit({
      name: "memorySettings",
      resource: memorySettings,
      key: { read: "memorySettings" },
      write: () => port.setMemorySettings!(patch),
      reconcile: () => loadMemorySettings(),
    });
  };

  /** A provider mutation refreshes the provider list and marks models stale. */

  const startCodexOAuth = async (body?: Record<string, unknown>): Promise<unknown> => {
    if (!port.startCodexOAuthLogin) throw new Error("当前运行时不支持 Codex 登录。");
    return port.startCodexOAuthLogin(body);
  };

  const cancelCodexOAuth = async (loginId: string): Promise<unknown> => {
    if (!port.cancelCodexOAuthLogin) throw new Error("当前运行时不支持取消 Codex 登录。");
    return port.cancelCodexOAuthLogin({ loginId });
  };

  const loadModelSource = (): Promise<WebuiResourceLoadOutcome<WebuiModelSource>> => {
    if (!port.getMiniMaxModelSource) {
      unavailable("modelSource", "当前运行时不支持模型来源。");
      return unsupported("当前运行时不支持模型来源。");
    }
    return readInto("modelSource", modelSource, { read: "modelSource" }, "modelSource", () =>
      port.getMiniMaxModelSource!(),
    );
  };

  const setModelSource = async (source: WebuiModelSource): Promise<void> => {
    if (!port.setMiniMaxModelSource) {
      throw new Error("当前运行时不支持切换模型来源。");
    }
    await saveWithCommit({
      name: "modelSource",
      resource: modelSource,
      key: { read: "modelSource" },
      write: () => port.setMiniMaxModelSource!(source),
      reconcile: () => loadModelSource(),
    });
  };

  const loadVersion = (): Promise<WebuiResourceLoadOutcome<WebuiVersionInfo>> => {
    const read = port.version;
    if (!read) {
      unavailable("runtimeVersion", "当前运行时不支持版本信息。");
      return unsupported("当前运行时不支持版本信息。");
    }
    return readInto("runtimeVersion", runtimeVersion, { read: "version" }, "version", () => read());
  };

  /**
   * Read the permission preference.
   *
   * The preference is a runtime setting, so the answer is a runtime answer this
   * owner caches — and an answer no client can act on is an error, not an
   * absence: the surface must be able to say "the runtime returned a mode this
   * build does not know" rather than render an empty switch.
   *
   * The write does not advance the configuration epoch. It used to be a raw port
   * call from the composer, so advancing it here would add an invalidation the
   * current behaviour does not have; whether a permission-preference change
   * should retire cached answers is a separate decision with its own evidence.
   */
  const loadPermissionMode = (): Promise<WebuiResourceLoadOutcome<WebuiPermissionMode>> => {
    const read = port.getPermissionMode;
    if (!read) {
      unavailable("permissionMode", "当前运行时不支持授权模式读写。");
      return unsupported("当前运行时不支持授权模式读写。");
    }
    return readInto("permissionMode", permissionMode, { read: "permissionMode" }, "permissionMode", async () => {
      const mode = readWebuiPermissionMode(await read());
      if (!mode) throw new Error("运行时返回了不支持的授权模式");
      return mode;
    });
  };

  const savePermissionMode = (mode: WebuiPermissionMode): Promise<WebuiPermissionMode> =>
    saveWithCommit({
      name: "permissionMode",
      resource: permissionMode,
      key: { read: "permissionMode" },
      write: async () => {
        if (!port.setPermissionMode) throw new Error("当前运行时不支持授权模式读写。");
        const answer = readWebuiPermissionMode(await port.setPermissionMode({ mode }));
        if (!answer) throw new Error("运行时返回了不支持的授权模式");
        return answer;
      },
      reconcile: () => loadPermissionMode(),
      advanceConfiguration: false,
      // The permission preference has its own generation semantics: this write
      // does not advance the configuration epoch, so the commit must not be
      // retired by one. `saveWithCommit` advances it after a settled write; for
      // this resource that advance is harmless (it is not bound to the epoch) and
      // keeps one ordering rule for every settings write.
    });

  return {
    getSnapshot,
    subscribe,
    // Live, not computed once: a capability the host has refused is one this host
    // does not implement, and a surface reading a flag frozen at construction
    // would keep offering a control that has just proved it cannot work.
    get canReadInstructions() { return isSupported("instructions", port.getGlobalInstructions !== undefined); },
    get canWriteInstructions() { return isSupported("instructions", port.setGlobalInstructions !== undefined); },
    get canReadProfile() { return isSupported("profile", port.getUserProfile !== undefined); },
    get canWriteProfile() { return isSupported("profile", port.setUserProfile !== undefined); },
    get canReadMemory() { return isSupported("agentMemory", port.getAgentMemory !== undefined); },
    get canWriteMemory() { return isSupported("agentMemory", port.setAgentMemory !== undefined); },
    get canReadMemorySettings() { return isSupported("memorySettings", port.getMemorySettings !== undefined); },
    get canWriteMemorySettings() { return isSupported("memorySettings", port.setMemorySettings !== undefined); },
    get canStartCodexOAuth() { return isSupported("codexOAuth", port.startCodexOAuthLogin !== undefined); },
    get canReadModelSource() { return isSupported("modelSource", port.getMiniMaxModelSource !== undefined); },
    get canSetModelSource() { return isSupported("modelSource", port.setMiniMaxModelSource !== undefined); },
    get canReadVersion() { return isSupported("version", port.version !== undefined); },
    get canReadPermissionMode() { return isSupported("permissionMode", port.getPermissionMode !== undefined); },
    get canWritePermissionMode() { return isSupported("permissionMode", port.setPermissionMode !== undefined); },
    loadInstructions,
    saveInstructions,
    loadProfile,
    saveProfile,
    loadAgentMemory,
    saveAgentMemory,
    loadMemorySettings,
    saveMemorySettings,
    startCodexOAuth,
    cancelCodexOAuth,
    loadModelSource,
    setModelSource,
    loadPermissionMode,
    savePermissionMode,
    loadVersion,
    dispose: () => {
      // Disposal fences every read: an answer still in flight can no longer
      // commit, and a read started afterwards reports `disposed` without issuing
      // a request. This is the same rule the primitive applies everywhere, not a
      // settings-local variant.
      for (const resource of [
        instructions,
        profile,
        memorySummary,
        memoryContent,
        memorySettings,
        modelSource,
        runtimeVersion,
        permissionMode,
      ]) {
        resource.dispose();
      }
      boundReads.length = 0;
    },
  };
}
