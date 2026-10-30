import type {
  GlobalEvent,
  GlobalThreadGoal,
} from "@mavis/shared/global-events";
import type { ThreadGoalAttachment, ThreadGoalPatchInput } from "@mavis/goal";
import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from "@mavis/shared/questionnaire";
import type { LocalSkillService } from "@mavis/local-runtime";
import type { LocalMcpPublicFacade } from "../../service/mcp/index.js";
import type {
  ListInstalledPluginsInput as ListInstalledPluginsReq,
  ListInstalledPluginsResult as ListInstalledPluginsResp,
  ListMarketplacePluginsInput as ListMarketplacePluginsReq,
  ListMarketplacePluginsResult as ListMarketplacePluginsResp,
  PreviewGithubPluginInput as PreviewGithubPluginReq,
  PreviewGithubPluginResult as PreviewGithubPluginResp,
  ImportGithubPluginInput as ImportGithubPluginReq,
  ImportGithubPluginResult as ImportGithubPluginResp,
  ListRuntimeSkillsInput as ListRuntimeSkillsReq,
  ListRuntimeSkillsResult as ListRuntimeSkillsResp,
  MutatePluginInput as MutatePluginReq,
  MutatePluginResult as MutatePluginResp,
} from "@mavis/protocol/local";
import type { MiniAppSurfaceSummary } from "@mavis/shared/miniapp-surface";
import type {
  MiniAppAgentAgents,
  MiniAppAgentModels,
  MiniAppAgentModelSelection,
  MiniAppAgentPermissionDecision,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
  MiniAppAgentSessionContext,
  MiniAppAgentSessions,
} from "../../service/miniapp/index.js";
import type { SessionReportManifest } from "../../service/session-system/index.js";
import type { WorkspaceReviewFileContent, WorkspaceReviewFileDiff, WorkspaceReviewSearchResult, WorkspaceReviewSummary } from "../../service/workspace/contracts.js";
import type {
  ByokProviderPresetView,
  CodexOAuthStartResult,
  CodexOAuthLoginOptions,
  CodexOAuthStatus,
  UserModelInputView,
  UserModelProviderCandidateView,
} from "../../service/model-system/index.js";

/** Trusted tab identity the Host resolved for a Mini App Agent call; never page-supplied. */
export interface ProcessLocalMiniAppAgentCaller {
  readonly pluginId: string;
  readonly runId: string;
  readonly hostSessionId?: string;
}

export type ProcessLocalModelInput = Omit<UserModelInputView, "modalities"> & {
  modalities?: { input?: readonly string[]; output?: readonly string[] };
};

export interface ProcessLocalMiniAppLaunch {
  readonly miniApp: MiniAppSurfaceSummary;
  /** Main-process-only launch coordinates. Never forward this object to a renderer. */
  readonly launch: {
    readonly origin: string;
    readonly surfacePath: string;
    readonly runId: string;
    /**
     * The credential the Mini App's own guard demands. Server-only, like the rest of this object: the
     * proxy injects it, and no renderer and no published view ever carries it.
     */
    readonly credential: string;
  };
}

/** Host-owned presentation capability used by the Agent MiniApp control tool. */
export interface MiniAppPresenter {
  open(input: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** Closes every managed native surface for one plugin after its runtime has stopped. */
  close(input: { readonly pluginId: string }): Promise<void>;
}

type LocalRuntimeBackgroundTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled"
  | "lost";

interface LocalRuntimeBackgroundTaskView {
  readonly taskId: string;
  readonly kind: "bash" | "subagent" | "workflow" | "custom";
  readonly status: LocalRuntimeBackgroundTaskStatus;
  readonly ownerSessionId: string;
  readonly description?: string;
  /** Persisted execution metadata, including the full Bash command when available. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly deliveredAt?: number;
  readonly lastError?: { readonly message: string };
}

interface LocalRuntimeBackgroundTaskQuery {
  readonly ownerSessionId: string;
  readonly statuses?: readonly LocalRuntimeBackgroundTaskStatus[];
  readonly kinds?: readonly LocalRuntimeBackgroundTaskView["kind"][];
  readonly undeliveredOnly?: boolean;
  readonly limit?: number;
}

/** Internal peripheral Application surface consumed by process-local delivery. */
export interface LocalRuntimeApplication {
  readonly events: {
    watch(signal?: AbortSignal): AsyncGenerator<GlobalEvent>;
  };
  readonly usage?: {
    watchCommits(signal?: AbortSignal): AsyncGenerator<string>;
  };
  readonly skills: Pick<
    LocalSkillService,
    | "listSkills"
    | "setSkillEnabled"
    | "deleteSkill"
    | "createSkill"
    | "getSkill"
    | "listSkillHub"
    | "installSkill"
  > & {
    listRuntimeSkills(
      req: ListRuntimeSkillsReq,
    ): Promise<ListRuntimeSkillsResp>;
  };
  readonly plugins: {
    refresh(): Promise<void>;
    listMarketplacePlugins(
      req: ListMarketplacePluginsReq,
    ): Promise<ListMarketplacePluginsResp>;
    listInstalledPlugins(
      req: ListInstalledPluginsReq,
    ): Promise<ListInstalledPluginsResp>;
    previewGithubPlugin(req: PreviewGithubPluginReq): Promise<PreviewGithubPluginResp>;
    importGithubPlugin(req: ImportGithubPluginReq): Promise<ImportGithubPluginResp>;
    installPlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    uninstallPlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    enablePlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    disablePlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
  };
  readonly miniApps?: {
    list(): Promise<{ readonly miniApps: readonly MiniAppSurfaceSummary[] }>;
    /**
     * The same rows, including a package that is installed but disabled.
     *
     * `list` answers what the runtime can start; this answers what is installed,
     * with `enabled` on each row, so a management surface can offer to turn a
     * disabled Mini App back on. Kept apart rather than folded into `list` so no
     * existing consumer starts seeing packages it cannot start.
     */
    listInstalled(): Promise<{ readonly miniApps: readonly MiniAppSurfaceSummary[] }>;
    open(input: {
      readonly pluginId: string;
      readonly signal?: AbortSignal;
    }): Promise<ProcessLocalMiniAppLaunch>;
    stop(input: {
      readonly pluginId: string;
      readonly signal?: AbortSignal;
    }): Promise<void>;
  };
  /**
   * Page-path entry for the Mini App Agent API. The Host resolves `caller` from the tab that sent
   * the request; the page payload never carries identity. `runId` is the launch `runId` (= process
   * generation) and must match a registered arena; `hostSessionId` is the chat session the tab is
   * bound to, when any.
   */
  readonly miniAppAgent?: {
    run(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly text: string;
      readonly sessionId?: string;
      /** Only with a new session: the agent it is created for. */
      readonly agent?: string;
      /** Switches the session to this model before the turn. */
      readonly model?: MiniAppAgentModelSelection;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
    }): Promise<MiniAppAgentRunResult>;
    models(input: { readonly caller: ProcessLocalMiniAppAgentCaller }): Promise<MiniAppAgentModels>;
    agents(input: { readonly caller: ProcessLocalMiniAppAgentCaller }): Promise<MiniAppAgentAgents>;
    sessions(input: { readonly caller: ProcessLocalMiniAppAgentCaller }): Promise<MiniAppAgentSessions>;
    session(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly sessionId?: string;
    }): Promise<MiniAppAgentSessionContext | undefined>;
    /** Creates a session bound like a first `run` would, without running a turn. */
    create(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly agent?: string;
    }): Promise<{ readonly sessionId: string }>;
    reply(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly sessionId: string;
      readonly requestId: string;
      readonly decision: MiniAppAgentPermissionDecision;
    }): Promise<void>;
    answer(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly sessionId: string;
      readonly requestId: string;
      readonly answers: readonly AskQuestionnaireReplyAnswer[];
      /** Switches the session to this model before the continuation turn. */
      readonly model?: MiniAppAgentModelSelection;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
    }): Promise<MiniAppAgentRunResult>;
    /** Ownership + host check for showing a Mini App session in the host chat's side panel. */
    open(input: {
      readonly caller: ProcessLocalMiniAppAgentCaller;
      readonly sessionId: string;
    }): Promise<{ readonly sessionId: string; readonly hostSessionId: string }>;
    /** Host reports the side panel now shows / no longer shows a Mini App session (after its UI accepted). */
    panelOpened(input: {
      readonly sessionId: string;
      readonly hostSessionId: string;
    }): Promise<void>;
    panelClosed(input: {
      readonly sessionId: string;
      readonly hostSessionId: string;
    }): Promise<void>;
  };
  readonly goals?: {
    isEnabled(): boolean;
    get(sessionId: string): Promise<(GlobalThreadGoal & { readonly objectiveResources?: readonly ThreadGoalAttachment[] }) | undefined>;
    create(input: {
      sessionId: string;
      objective: string;
      tokenBudget?: number | null;
      kickoffAttachments?: readonly ThreadGoalAttachment[];
      objectiveResources?: readonly ThreadGoalAttachment[];
      requireKickoffAdmission?: boolean;
    }): Promise<GlobalThreadGoal & { readonly objectiveResources?: readonly ThreadGoalAttachment[] }>;
    patch(
      sessionId: string,
      patch: Pick<ThreadGoalPatchInput, "status" | "objective" | "tokenBudget" | "objectiveResources" | "expectedGoalId" | "rejectIfUpdatedAtChangedFrom">,
    ): Promise<GlobalThreadGoal & { readonly objectiveResources?: readonly ThreadGoalAttachment[] }>;
    clear(sessionId: string): Promise<boolean>;
  };
  readonly mcp?: Pick<
    LocalMcpPublicFacade,
    | "listLocalMcpServers"
    | "listMcpCapabilities"
    | "configureSessionServers"
    | "clearSessionServers"
    | "inspectProjectMcp"
  >;
  readonly questionnaires?: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    getLatestPlanReview(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    reply(input: {
      agentName: string;
      requestId: string;
      answers: AskQuestionnaireReplyAnswer[];
      submittedAt: number;
    }): Promise<{
      ok: true;
      requestId: string;
      sessionId: string;
      agentName?: string;
      answeredAt: number;
    }>;
    dismiss(input: { agentName: string; requestId: string }): Promise<{
      ok: true;
      requestId: string;
      sessionId: string;
      agentName?: string;
      dismissedAt: number;
    }>;
  };
  readonly plan?: {
    isEntryEnabled(): boolean;
  };
  readonly backgroundTasks?: {
    list(
      input: LocalRuntimeBackgroundTaskQuery,
    ): Promise<readonly LocalRuntimeBackgroundTaskView[]>;
  };
  readonly workspace?: {
    readonly git: {
      getMetadata(workspaceDir: string): Promise<Record<string, unknown>>;
      getChanges?(workspaceDir: string, mode: "fast" | "full"): Promise<Record<string, unknown>>;
      commit?(workspaceDir: string, message: string, includeUnstaged?: boolean): Promise<Record<string, unknown>>;
      commitAndPush?(workspaceDir: string, message: string, includeUnstaged?: boolean): Promise<Record<string, unknown>>;
      push?(workspaceDir: string): Promise<Record<string, unknown>>;
      getReviewLink?(
        workspaceDir: string,
        branch: string,
      ): Promise<Record<string, unknown> | undefined>;
      /** The workspace's branches. The remote branch list is opt-in. */
      getBranches?(
        workspaceDir: string,
        includeRemote?: boolean,
      ): Promise<Record<string, unknown>>;
      /** The branches plus the worktrees that carry them. */
      getBranchPicker?(workspaceDir: string): Promise<Record<string, unknown>>;
      /** The branch a fresh workspace would start from. */
      getDefaultBranch?(workspaceDir: string): Promise<Record<string, unknown>>;
      /** Whether the workspace is a git repository at all. */
      probe?(workspaceDir: string): Promise<Record<string, unknown>>;
      /** The worktrees of the workspace. */
      listWorktrees?(workspaceDir: string): Promise<Record<string, unknown>>;
      checkout?(workspaceDir: string, branch: string): Promise<Record<string, unknown>>;
      getReviewSummary?(workspaceDir: string, source: { readonly type: "workspace" }): Promise<WorkspaceReviewSummary>;
      listReviewFileDiffs?(workspaceDir: string, source: { readonly type: "workspace" }, request: { readonly reviewSnapshotId: string; readonly fileIds?: string[] }): Promise<{ readonly reviewSnapshotId: string; readonly diffs: readonly WorkspaceReviewFileDiff[] }>;
      getReviewFileContent?(workspaceDir: string, source: { readonly type: "workspace" }, request: { readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }): Promise<WorkspaceReviewFileContent>;
      searchReviewDiffs?(workspaceDir: string, source: { readonly type: "workspace" }, request: { readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }): Promise<WorkspaceReviewSearchResult>;
    };
    listFileTree?(input: {
      workspaceDir: string;
      path?: string;
      signal?: AbortSignal;
    }): Promise<readonly unknown[]>;
    searchFiles?(input: {
      workspaceDir: string;
      query: string;
      limit: number;
      signal?: AbortSignal;
    }): Promise<readonly string[]>;
  };
  readonly permissions?: {
    listPending(input?: {
      signal?: AbortSignal;
    }): Promise<readonly LocalRuntimePendingPermission[]>;
    reply(input: {
      requestIds: readonly string[];
      decision: "allowAlways" | "allowOnce" | "deny";
    }): Promise<{ processed: readonly string[]; skipped: readonly string[] }>;
  };
  readonly account?: {
    getStatus(input?: {
      sessionId?: string;
      model?: string;
    }): Promise<Record<string, unknown>>;
  };
  readonly diagnostics?: {
    getRuntimeSnapshot(): Promise<Record<string, unknown>>;
    collectSessionReport?(sessionId: string): Promise<SessionReportManifest>;
  };
  readonly instructions?: {
    listSources(input: {
      workspaceDir: string;
    }): Promise<
      readonly { readonly scope: "global" | "project"; readonly path: string }[]
    >;
  };
  readonly configuration?: {
    getPermissionMode(): Promise<unknown>;
    setPermissionMode(input: {
      mode: "default" | "acceptEdits" | "bypassPermissions" | "auto" | "off";
    }): Promise<unknown>;
    /**
     * The two long-term-memory switches, read and written as their own
     * narrow surface rather than as a general config patch.
     *
     * Optional because a host that predates this surface still has to
     * type-check, and every consumer must fail closed with one clear
     * message instead of crashing on an absent method — the same rule the
     * permission-mode pair already follows. Callers must not treat a missing
     * method as "off": absence means "this host cannot answer", which is a
     * different statement from either boolean value.
     */
    getMemorySettings?(): Promise<{
      enabled: boolean;
      proactive: boolean;
    }>;
    setMemorySettings?(input: {
      enabled?: boolean;
      proactive?: boolean;
    }): Promise<{ enabled: boolean; proactive: boolean }>;
    /**
     * The four browser authorization switches, read and written as their own
     * narrow surface.
     *
     * They are four booleans rather than one because they are four different
     * grants: launching an isolated browser, reaching the person's Edge,
     * reaching the person's Chrome, and letting a caller send every DevTools
     * command instead of the restricted set. A single switch would make it
     * impossible to allow one without allowing the rest.
     *
     * Optional on the same terms as the memory pair, and read with the same
     * rule: an absent method means "this host cannot answer", never "off".
     */
    getBrowserAuthorization?(): Promise<{
      isolatedChromium: boolean;
      edge: boolean;
      chrome: boolean;
      fullCdp: boolean;
    }>;
    setBrowserAuthorization?(input: {
      isolatedChromium?: boolean;
      edge?: boolean;
      chrome?: boolean;
      fullCdp?: boolean;
    }): Promise<{
      isolatedChromium: boolean;
      edge: boolean;
      chrome: boolean;
      fullCdp: boolean;
    }>;
  };
  readonly models?: {
    list(input?: { sessionId?: string }): Promise<readonly unknown[]>;
    select(input: {
      providerId: string;
      modelId: string;
      variant?: string;
      /** Pick a context window size (in tokens) from the model's
       *  `contextWindowOptions`. Persisted so the next `listModels` call
       *  reflects the choice on the `contextLimit` field. */
      contextLimit?: number;
      sessionId?: string;
    }): Promise<boolean>;
    /** Adds or removes a model favorite; absent when the host has no preference store. */
    setFavorite?(input: {
      providerId: string;
      modelId: string;
      favorite: boolean;
    }): Promise<boolean>;
  };
  readonly modelProviders?: {
    listProviderPresets(): Promise<readonly ByokProviderPresetView[]>;
    getCodexOAuthStatus(): Promise<CodexOAuthStatus>;
    startCodexOAuthLogin(
      options?: CodexOAuthLoginOptions,
    ): Promise<CodexOAuthStartResult>;
    cancelCodexOAuthLogin(loginId: string): Promise<CodexOAuthStatus>;
    listUser(): Promise<readonly Record<string, unknown>[]>;
    getMiniMaxApiKeyStatus(): Promise<Record<string, unknown>>;
    getMiniMaxModelSource(): Promise<"token_plan" | "minimax_api_key">;
    setMiniMaxModelSource(input: {
      source: "token_plan" | "minimax_api_key";
    }): Promise<"token_plan" | "minimax_api_key">;
    upsertMiniMaxApiKey(input: {
      apiKey: string;
      saveAndUse?: boolean;
    }): Promise<unknown>;
    create(input: {
      name?: string;
      baseUrl: string;
      apiKey: string;
      apiFormat?: string;
      headers?: Record<string, string>;
      models?: readonly ProcessLocalModelInput[];
      saveAndUse?: boolean;
    }): Promise<unknown>;
    discoverCandidate(input: { baseUrl: string } & (
      | { providerId: string; expectedRevision: string }
      | { name: string; apiKey: string; apiFormat: string }
    )): Promise<readonly { modelId: string; displayName?: string }[]>;
    saveCandidate(input: {
      candidate: {
        providerId?: string;
        expectedRevision?: string;
        name?: string;
        baseUrl: string;
        apiKey?: string;
        apiFormat?: string;
        headers?: Record<string, string>;
        removeHeaders?: string[];
        models?: readonly ProcessLocalModelInput[];
      };
      modelId?: string;
      saveAndUse?: boolean;
      skipConnectionTest?: boolean;
    }): Promise<{
      success: boolean;
      status?: Record<string, unknown>;
      provider?: Record<string, unknown>;
    }>;
    update(input: {
      providerId: string;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      apiFormat?: string;
      headers?: Record<string, string>;
      removeHeaders?: string[];
      enabled?: boolean;
      models?: readonly ProcessLocalModelInput[];
      saveAndUse?: boolean;
    }): Promise<unknown>;
    delete(input: { providerId: string }): Promise<void>;
    testProvider(input: { providerId: string; apiKey?: string }): Promise<unknown>;
    testUserModelCandidate(input: { candidate: UserModelProviderCandidateView; modelId: string }): Promise<unknown>;
    revealModelProviderApiKey(input: { providerId: string }): string;
    refreshModels(): Promise<unknown>;
    testModel(input: { providerId: string; modelId: string }): Promise<unknown>;
  };
}

export interface LocalRuntimePendingPermission {
  readonly requestId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly ruleContents: readonly string[];
  readonly toolInput?: string;
  readonly toolDescription?: string;
  readonly reason: string;
  readonly allowAlwaysSupported: boolean;
  readonly createdAt: number;
}
