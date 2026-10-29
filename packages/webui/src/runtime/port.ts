import type {
  MiniAppAgentAgents,
  MiniAppAgentModelSelection,
  MiniAppAgentModels,
  MiniAppAgentPermissionDecision,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
  MiniAppAgentSessionContext,
  MiniAppAgentSessions,
} from "@mavis/shared/miniapp-surface";
import type { AskQuestionnaireReplyAnswer } from "@mavis/shared/questionnaire";
import type { WebuiPluginManagementRequest } from "../shared/plugin-management.js";
import type {
  WebuiRunCommandRequest,
  WebuiRunCommandResult,
} from "../shared/contracts/terminal.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTabOpener,
  WebuiBrowserTargetId,
  WebuiBrowserViewport,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
  WebuiBrowserWebTabOpen,
  WebuiBrowserWebTabClose,
  WebuiBrowserWebTabSnapshot,
} from "../shared/contracts/browser.js";
import type {
  WebuiActiveTurnResult,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiImportSessionTransferRequest,
  WebuiImportSessionTransferResult,
  WebuiProjectRecord,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiSessionListRequest,
  WebuiSessionLookupRequest,
  WebuiSessionLookupResult,
  WebuiSessionPage,
  WebuiSessionTransferFile,
  WebuiSessionTreeRequest,
  WebuiSessionTreePage,
  WebuiUpdateSessionRequest,
  WebuiUpdateSessionResult,
} from "../shared/contracts/session.js";
import type {
  WebuiMessagesRequest,
  WebuiMessagesResult,
} from "../shared/contracts/messages.js";
import type {
  WebuiResumeSessionRequest,
  WebuiRuntimeEvent,
  WebuiSendMessageRequest,
  WebuiSendMessageResult,
  WebuiStreamResult,
} from "../shared/contracts/stream.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
  WebuiGoalSessionRequest,
} from "../shared/contracts/goal.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiPermissionDecision,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../shared/contracts/interactions.js";
import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../shared/contracts/queue.js";
import type {
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../shared/contracts/review.js";
import type { WebuiCanvasDocument } from "../shared/contracts/canvas.js";
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelEntry,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiSkillEntry,
  WebuiUpdateUserModelProviderRequest,
  WebuiTestUserModelCandidateRequest,
} from "../shared/contracts/models.js";
import type { WebuiHostPrerequisiteFacts } from "../shared/capability-manifest.js";
import type {
  WebuiMiniAppList,
  WebuiMiniAppSummary,
} from "../shared/contracts/miniapp.js";
import type { WebuiVersionInfo } from "../shared/contracts/version.js";
import type { WebuiUsageQuotaResult } from "../shared/contracts/usage-quota.js";
import type {
  WebuiCreditFallbackView,
  WebuiResetCardFlowsResult,
  WebuiResetCardListResult,
  WebuiResetCardUseResult,
} from "../shared/contracts/account-billing.js";
import type {
  WebuiAccountProfileView,
  WebuiUsageSummaryView,
} from "../shared/contracts/account-usage.js";
import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "../shared/contracts/account.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileView,
} from "../shared/contracts/personalization.js";

// Harness seam for the WebUI service.
//
// The service uses this port to reach the harness layer; the real
// implementation is wired to the in-process runtime host (ADR 0001) and its
// `CliService` facade. Tests substitute a scripted stand-in so the access
// control, transport, envelope and shutdown story can be exercised without
// owning a real database (ADR 0006).
//
// Keep this projection deliberately owned by WebUI: the browser needs a
// stable wire shape, while the runtime keeps its richer process-local
// contracts private to the harness adapter.

export interface WebuiHarnessPort {
  version(): WebuiVersionInfo;
  listVisibleProjects?(request: {
    readonly limit?: number;
  }): Promise<readonly WebuiProjectRecord[]>;
  listSessions(request: WebuiSessionListRequest): Promise<WebuiSessionPage>;
  getSessionTree(
    request: WebuiSessionTreeRequest,
  ): Promise<WebuiSessionTreePage>;
  archiveSession(request: {
    readonly id: string;
    readonly archived?: boolean;
  }): Promise<{ readonly success?: boolean }>;
  deleteSession(request: {
    readonly id: string;
  }): Promise<{ readonly success?: boolean }>;
  updateSession(
    request: WebuiUpdateSessionRequest,
  ): Promise<WebuiUpdateSessionResult>;
  getSessionForkOptions(
    request: WebuiGetSessionForkOptionsRequest,
  ): Promise<WebuiGetSessionForkOptionsResult>;
  forkSession(
    request: WebuiForkSessionRequest,
  ): Promise<WebuiForkSessionResult>;
  createSession(
    request: WebuiCreateSessionRequest,
  ): Promise<WebuiCreateSessionResult>;
  getSession(
    request: WebuiSessionLookupRequest,
  ): Promise<WebuiSessionLookupResult>;
  getActiveTurn(
    request: WebuiSessionLookupRequest,
  ): Promise<WebuiActiveTurnResult>;
  getMessages(request: WebuiMessagesRequest): Promise<WebuiMessagesResult>;
  /**
   * Both storage layers of a session, verbatim.
   *
   * Deliberately not `getMessages`: that returns a view prepared for
   * rendering, which drops the canonical receipts carried on compaction and
   * fork-origin rows, and a transfer file built from it cannot be read back
   * without losing them.
   */
  exportSessionTransfer(request: {
    readonly id: string;
  }): Promise<WebuiSessionTransferFile>;
  importSessionTransfer(
    request: WebuiImportSessionTransferRequest,
  ): Promise<WebuiImportSessionTransferResult>;
  importSessionTransferWorkflow?(input: {
    readonly file: unknown;
    readonly agentName: string;
    readonly workspaceDir?: string;
  }): Promise<
    | {
        readonly kind: "imported";
        readonly body: {
          readonly sessionId: string;
          readonly canonicalMessages: number;
          readonly displayMessages: number;
          readonly revision: string;
        };
      }
    | { readonly kind: "create-failed" }
    | { readonly kind: "not-transfer-file" }
    | { readonly kind: "import-failed" }
  >;
  getSessionDiff(
    request: WebuiGetSessionDiffRequest,
  ): Promise<WebuiGetSessionDiffResult>;
  getTurnDiff(
    request: WebuiGetTurnDiffRequest,
  ): Promise<WebuiGetTurnDiffResult>;
  revertTurnDiff(
    request: WebuiRevertTurnDiffRequest,
  ): Promise<WebuiRevertTurnDiffResult>;
  reapplyTurnDiff(
    request: WebuiReapplyTurnDiffRequest,
  ): Promise<WebuiReapplyTurnDiffResult>;
  getSessionRewindPreview(
    request: WebuiGetSessionRewindPreviewRequest,
  ): Promise<WebuiGetSessionRewindPreviewResult>;
  rewindSession(
    request: WebuiRewindSessionRequest,
  ): Promise<WebuiRewindSessionResult>;
  editSessionMessage(
    request: WebuiEditSessionMessageRequest,
  ): Promise<WebuiEditSessionMessageResult>;
  isGoalEnabled(): Promise<WebuiGoalEnabledResult>;
  getGoal(request: WebuiGoalSessionRequest): Promise<WebuiGoal | undefined>;
  createGoal(request: WebuiGoalCreateRequest): Promise<WebuiGoal>;
  patchGoal(request: WebuiGoalPatchRequest): Promise<WebuiGoal>;
  clearGoal(
    request: WebuiGoalSessionRequest,
  ): Promise<{ readonly success: boolean }>;
  listWorkspaceFileTree(request: {
    readonly workspaceDir: string;
    readonly path?: string;
  }): Promise<readonly WebuiWorkspaceFile[]>;
  readWorkspaceFile(request: {
    readonly workspaceDir: string;
    readonly path: string;
  }): Promise<WebuiWorkspaceFileContent>;
  getWorkspaceEnvironment(request: {
    readonly workspaceDir: string;
  }): Promise<WebuiWorkspaceEnvironment>;
  mutateWorkspaceGit(
    request: WebuiWorkspaceGitMutationRequest,
  ): Promise<Record<string, unknown>>;
  getWorkspaceReviewSummary(request: {
    readonly workspaceDir: string;
  }): Promise<WebuiWorkspaceReviewSummary>;
  listWorkspaceReviewFileDiffs(request: {
    readonly workspaceDir: string;
    readonly reviewSnapshotId: string;
    readonly fileIds: readonly string[];
  }): Promise<WebuiWorkspaceReviewDiffs>;
  getWorkspaceReviewFileContent(request: {
    readonly workspaceDir: string;
    readonly reviewSnapshotId: string;
    readonly fileId: string;
    readonly side: "old" | "new";
  }): Promise<WebuiWorkspaceReviewFileContent>;
  searchWorkspaceReviewDiffs(request: {
    readonly workspaceDir: string;
    readonly reviewSnapshotId: string;
    readonly query: string;
    readonly includeUntrackedFiles: boolean;
    readonly pageIndex?: number;
    readonly pageSize?: number;
  }): Promise<WebuiWorkspaceReviewSearchResult>;
  readCanvas(request: {
    readonly sessionId: string;
  }): Promise<WebuiCanvasDocument>;
  applyCanvas(request: {
    readonly sessionId: string;
    readonly operation: Record<string, unknown>;
  }): Promise<{
    readonly operationId: string;
    readonly document: WebuiCanvasDocument;
  }>;
  /**
   * Archive listing for the workspace panel. The runtime owns every
   * hardening decision here (entry ceiling, expansion ratio, path
   * validation); the WebUI only renders what the runtime is willing to name.
   */
  readWorkspaceArchive(request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }): Promise<WebuiWorkspaceArchiveListing>;
  extractWorkspaceArchive(request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }): Promise<WebuiWorkspaceArchiveExtractResult>;
  sendMessage(
    request: WebuiSendMessageRequest,
    signal?: AbortSignal,
  ): Promise<WebuiSendMessageResult>;
  enqueueMessage(
    request: WebuiEnqueueMessageRequest,
  ): Promise<WebuiEnqueueMessageResult>;
  /**
   * Resume a session stream from a cursor the client previously advanced
   * past. Returns the same iterable source as `sendMessage` — the harness
   * reuses the session-stream contract for both — so the wire envelope and
   * the reducer can stay unchanged.
   */
  resumeSession(
    request: WebuiResumeSessionRequest,
    signal?: AbortSignal,
  ): Promise<WebuiStreamResult>;
  watchEvents(signal?: AbortSignal): AsyncIterable<WebuiRuntimeEvent>;
  listPendingPermissions(): Promise<{
    readonly requests: readonly WebuiPendingPermission[];
  }>;
  getPendingQuestionnaire(request: {
    readonly name: string;
    readonly sessionId: string;
  }): Promise<{ readonly request?: WebuiQuestionnaireRequest }>;
  replyPermission(request: {
    readonly name: string;
    readonly requestId: string;
    readonly reply: WebuiPermissionDecision;
  }): Promise<WebuiInteractionReplyResult>;
  replyQuestionnaire(request: {
    readonly name: string;
    readonly requestId: string;
    readonly schemaVersion: number;
    readonly answers: readonly WebuiQuestionnaireAnswer[];
  }): Promise<WebuiInteractionReplyResult>;
  dismissQuestionnaire(request: {
    readonly name: string;
    readonly requestId: string;
  }): Promise<WebuiInteractionReplyResult>;
  abortSession(request: {
    readonly id: string;
  }): Promise<{ readonly success?: boolean }>;
  listQueueMessages(request: { readonly id: string }): Promise<{
    readonly items?: readonly WebuiQueueItem[];
    readonly paused?: boolean;
    readonly pendingCount?: number;
  }>;
  deleteQueueItem(request: {
    readonly id: string;
    readonly itemId: string;
  }): Promise<{ readonly item?: WebuiQueueItem }>;
  listModels(request?: {
    readonly sessionId?: string;
  }): Promise<readonly WebuiModelEntry[]>;
  /**
   * Returns the slash-palette skill catalogue for the given agent. Mirrors
   * the `listSkills(agentName, ...)` call shape so the WebUI can
   * populate the popover from the live registry instead of a fixture set.
   * `agentName` is optional: the harness may default to the active agent
   * when the WebUI has no session yet (e.g. the home composer).
   */
  listSkills(request?: {
    readonly agentName?: string;
  }): Promise<{ readonly skills: readonly WebuiSkillEntry[] }>;
  pluginManagement?(request: WebuiPluginManagementRequest): Promise<unknown>;
  getPermissionMode?(): Promise<unknown>;
  setPermissionMode?(request: {
    readonly mode: "default" | "auto" | "bypassPermissions";
  }): Promise<unknown>;
  selectModel(request: {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
    readonly contextLimit?: number;
    readonly thinking?: { readonly effort?: string } | null;
    readonly sessionId?: string;
  }): Promise<{ readonly success?: boolean }>;
  getSessionUsage(request: {
    readonly id: string;
  }): Promise<Record<string, unknown>>;
  getAccountStatus(request?: {
    readonly sessionId?: string;
  }): Promise<Record<string, unknown>>;
  listUserModelProviders(): Promise<readonly Record<string, unknown>[]>;
  createUserModelProvider(
    request: WebuiCreateUserModelProviderRequest,
  ): Promise<unknown>;
  updateUserModelProvider(
    request: WebuiUpdateUserModelProviderRequest,
  ): Promise<unknown>;
  deleteUserModelProvider(providerId: string): Promise<unknown>;
  testUserModelProvider(request: {
    readonly providerId: string;
    readonly apiKey?: string;
  }): Promise<unknown>;
  testUserModel(request: {
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<unknown>;
  discoverUserModelsCandidate(
    request: WebuiDiscoverUserModelsCandidateRequest,
  ): Promise<unknown>;
  saveUserModelProviderCandidate(
    request: WebuiSaveUserModelProviderCandidateRequest,
  ): Promise<unknown>;
  listProviderPresets(): Promise<readonly Record<string, unknown>[]>;
  getMiniMaxApiKeyStatus(): Promise<Record<string, unknown>>;
  upsertMiniMaxApiKey(request: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<unknown>;
  getCodexOAuthStatus(): Promise<Record<string, unknown>>;
  getMiniMaxModelSource(): Promise<"token_plan" | "minimax_api_key">;
  setMiniMaxModelSource(request: {
    readonly source: "token_plan" | "minimax_api_key";
  }): Promise<"token_plan" | "minimax_api_key">;
  /** Wire records are validated only as objects; the harness adapter owns field conversion. */
  /**
   * Which host services this harness actually has behind it.
   *
   * The port says what it can be asked for; this says which of those answers will work. A
   * harness forwards to optional host services, and `requireHostSlot` refuses at invocation —
   * so the fact belongs here, next to the refusal, rather than being inferred from a method's
   * presence.
   */
  readHostPrerequisites?(): WebuiHostPrerequisiteFacts;
  testUserModelCandidate(
    request: WebuiTestUserModelCandidateRequest,
  ): Promise<unknown>;
  revealModelProviderApiKey(request: {
    readonly providerId: string;
  }): Promise<string>;
  startCodexOAuthLogin(request?: Record<string, unknown>): Promise<unknown>;
  cancelCodexOAuthLogin(request: {
    readonly loginId: string;
  }): Promise<unknown>;
  refreshModels(): Promise<unknown>;
  /**
   * Cloud account quota for the user-menu usage panel. Not a harness
   * capability — see `usage-quota.ts`; the assembly supplies the client
   * (so the method is unconditionally present on the port the service
   * binds to, even though the live `CliService` does not own it).
   */
  getUsageQuota(request?: {
    readonly forceRefresh?: boolean;
  }): Promise<WebuiUsageQuotaResult>;
  /**
   * The account-billing surface of the usage-and-model page: whether chat
   * usage may fall back to credits, and the reset cards the account can
   * redeem. Not a harness capability — see `usage-quota.ts`; the assembly
   * supplies the client (so the method is unconditionally present on the port
   * the service binds to, even though the live `CliService` does not own it).
   */
  getCreditFallback(): Promise<WebuiCreditFallbackView>;
  setCreditFallback(request: {
    readonly enabled: boolean;
  }): Promise<WebuiCreditFallbackView>;
  listResetCards(request?: {
    readonly page?: number;
    readonly size?: number;
  }): Promise<WebuiResetCardListResult>;
  useResetCard(request: {
    readonly sourceType?: string;
    readonly outBizNo?: string;
  }): Promise<WebuiResetCardUseResult>;
  queryResetCardFlows(request?: {
    readonly page?: number;
    readonly size?: number;
    readonly createTimeMs?: number;
  }): Promise<WebuiResetCardFlowsResult>;
  /**
   * The account page's calendar: the lifetime token usage and the signed-in
   * account's public profile. Same seam as the account-billing surface above —
   * the assembly supplies the client.
   */
  getAccountUsageSummary(): Promise<WebuiUsageSummaryView>;
  getAccountProfile(): Promise<WebuiAccountProfileView>;
  /**
   * Auth invalidation is owned by the auth context reader, not the
   * harness. The assembly supplies the invalidator alongside the host,
   * so the method is unconditionally present on the port the service
   * binds to.
   */
  invalidateAuth(): Promise<void>;
  /**
   * Request a conversation compaction. Required on the port because the
   * `/compact` slash command always has a wire-level target; the harness
   * may still omit the underlying reducer (see `host.ts`'s nested-guard),
   * in which case the port turns that into a `runtime host does not
   * expose requestCompaction` error instead of letting the caller's
   * Promise.reject materialise later.
   */
  requestCompaction(request: {
    readonly name: string;
    readonly id: string;
    readonly reason: "ui_request";
    readonly customInstructions?: string;
  }): Promise<Record<string, unknown>>;
  /** Daily check-in panel status (cloud check-in API; see `check-in.ts`); supplied by the assembly alongside the host. */
  getSigninPanel(): Promise<WebuiSigninPanelView>;
  claimSignin(): Promise<WebuiClaimSigninView>;
  /**
   * Account login over the device-authorization flow, and the sign-out that
   * actually removes the credential. See `account-login.ts` for why the
   * session lives server-side; supplied by the assembly alongside the host.
   */
  beginAccountLogin(): Promise<WebuiAccountLoginView>;
  getAccountLoginStatus(): Promise<WebuiAccountLoginView>;
  cancelAccountLogin(): Promise<{ readonly ok: true }>;
  signOutAccount(): Promise<{
    readonly status: string;
    readonly generation: number;
  }>;
  /**
   * Profile-wide `AGENTS.md`, the file Turn assembly already reads through
   * `GlobalInstructions.readForPrompt`. Read-only on the v2 `instructions`
   * capability (`listSources` returns paths, not content), so the WebUI reads
   * and writes the file itself over the same `dataDir` the turn path uses — one
   * file, one writer, no second source of truth.
   */
  getGlobalInstructions?(): Promise<WebuiGlobalInstructionsView>;
  /** Writing empty content deletes the file, matching `GlobalInstructions.write`. */
  setGlobalInstructions?(request: {
    readonly content: string;
  }): Promise<WebuiGlobalInstructionsView>;
  /**
   * Per-agent main memory (`agents/<name>/memory/MEMORY.md`). Summary-only by
   * default; `includeContent` pulls the body, which runs past the 64KB
   * cleanup threshold on a live profile. Writing empty content deletes the
   * file, matching the runtime's write contract.
   */
  getAgentMemory?(request?: {
    readonly includeContent?: boolean;
  }): Promise<WebuiAgentMemoryView>;
  setAgentMemory?(request: {
    readonly content: string;
  }): Promise<WebuiAgentMemoryView>;
  /**
   * The `关于你` region of `memory/user.md` — the three fields between the
   * personalization markers. The rest of that file belongs to the memory
   * collector, so a write must never be able to express "replace the file".
   * A file whose markers are only half-present refuses the write rather than
   * guessing where the region ends.
   */
  getUserProfile?(): Promise<WebuiUserProfileView>;
  setUserProfile?(request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }): Promise<WebuiUserProfileView>;
  /**
   * The two memory switches. Optional because a host that predates the
   * configuration capability still has to satisfy this port; a missing method
   * is a capability gap, not a boolean value, and the handler reports it as
   * such instead of rendering the panel as "memory is off".
   */
  getMemorySettings?(): Promise<WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<WebuiMemorySettingsView>;
  /**
   * Interpret one slash command. The interpreter reads several capabilities
   * above (`createSession`, `getSession`, `getSessionUsage`, `listModels`,
   * `selectModel`, `requestCompaction`), so it is a port method rather than a
   * server-side import of the runtime implementation: the layer matrix lets
   * `server` reach `runtime-port` only.
   */
  runCommand(request: WebuiRunCommandRequest): Promise<WebuiRunCommandResult>;
  /**
   * The Mini App catalogue.
   *
   * Optional because the Mini App capability is a cell of the runtime's owner
   * policy: a host whose application was composed without it has no Mini Apps at
   * all, which is a different answer from an empty catalogue. The operations
   * refuse with `capability_unavailable` when these members are absent, rather
   * than reporting "no Mini Apps installed".
   */
  listMiniApps?(): Promise<WebuiMiniAppList>;
  /**
   * Starts one Mini App and hands back its launch coordinates.
   *
   * The result is **server-only**: `launch` carries the Mini App's real origin,
   * the credential its own loopback guard demands and the header that credential
   * is read from. `server/operation/handlers/miniapp.ts` turns it into a proxy
   * and answers the browser with that proxy's URL; nothing in `launch` may be
   * copied into a response. The `signal` is the requesting frame's, so a client
   * that goes away stops waiting on a start.
   */
  openMiniApp?(request: {
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<WebuiMiniAppLaunch>;
  /** Stops one Mini App. The caller closes its proxy. */
  stopMiniApp?(request: {
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /**
   * The Mini App Agent API: what a page's `window.mcode.miniapp.agent` reaches.
   *
   * One capability with nine members, all optional together — a host composed
   * without `miniAppAgent` has none of them, and the operations answer
   * `capability_unavailable` rather than pretending a turn happened. `caller` is
   * always the identity the service resolved for the page: never page-supplied.
   */
  runMiniAppAgentTurn?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly text: string;
    /** Continue one of the plugin's sessions; absent creates one. */
    readonly sessionId?: string;
    /** Only when creating: the agent the session is bound to. */
    readonly agent?: string;
    readonly model?: MiniAppAgentModelSelection;
    readonly signal?: AbortSignal;
    /**
     * The page's event listener, present only when the page asked to observe.
     *
     * The runtime counts a subscribed run as the party able to answer its
     * permission and questionnaire asks, so a call with no listener must arrive
     * with none: attaching one to collect the result would make every ask wait on
     * a page that is not reading.
     */
    readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
  }): Promise<MiniAppAgentRunResult>;
  /** The continuation turn a questionnaire answer starts; followed like a run. */
  answerMiniAppAgentQuestion?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly sessionId: string;
    readonly requestId: string;
    readonly answers: readonly AskQuestionnaireReplyAnswer[];
    readonly model?: MiniAppAgentModelSelection;
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
  }): Promise<MiniAppAgentRunResult>;
  /** Decides one pending permission ask. `allowOnce` or `deny`, never a global rule. */
  replyMiniAppAgentPermission?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: MiniAppAgentPermissionDecision;
  }): Promise<void>;
  /**
   * Proves the plugin owns the session and that the caller has a host session to
   * show it in. Showing it is the UI's act and is reported separately.
   */
  openMiniAppAgentSession?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly sessionId: string;
  }): Promise<{ readonly sessionId: string; readonly hostSessionId: string }>;
  /** The UI now shows that session, so its asks are answerable. Idempotent. */
  panelOpenedMiniAppAgentSession?(input: {
    readonly sessionId: string;
    readonly hostSessionId: string;
  }): Promise<void>;
  /** The UI stopped showing it. Idempotent. */
  panelClosedMiniAppAgentSession?(input: {
    readonly sessionId: string;
    readonly hostSessionId: string;
  }): Promise<void>;
  /** The models a run may switch to, the default, and a page's host model. */
  listMiniAppAgentModels?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
  }): Promise<MiniAppAgentModels>;
  /** The agents a new Mini App session may be created for. */
  listMiniAppAgentAgents?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
  }): Promise<MiniAppAgentAgents>;
  /** The read-only host conversation bound to this page. */
  readMiniAppAgentSession?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly sessionId?: string;
  }): Promise<MiniAppAgentSessionContext | undefined>;
  /** The visible user conversations a Mini App may read. */
  listMiniAppAgentSessions?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
  }): Promise<MiniAppAgentSessions>;
  /** A session without a turn; a `run` naming it continues it. */
  createMiniAppAgentSession?(input: {
    readonly caller: WebuiMiniAppAgentCaller;
    readonly agent?: string;
  }): Promise<{ readonly sessionId: string }>;
  /**
   * Release anything the port owns. The service calls this after closing
   * every transport-side resource so the harness can tear itself down in
   * the required order.
   */
  close(): Promise<void>;
}

/**
 * The refusal a host without the Mini App cell gives, everywhere it is given.
 *
 * Declared beside the capability itself because two layers answer it — the
 * adapter when the runtime's facade has no Mini App application, and the
 * dedicated handlers when the port has no member at all — and one message is
 * what keeps "this host has no Mini Apps" recognisable to a client regardless of
 * which of the two noticed it.
 */
export const MINIAPP_CAPABILITY_ABSENT =
  "runtime host does not expose the Mini App capability";

/**
 * The identity one Mini App page's call runs as.
 *
 * Resolved by the service from the presentation it issued — the plugin, the host
 * session the view belongs to, and the launch's own process generation — and never
 * taken from page content. `runId` is the launch's `runId`: the value the runtime
 * keys a Mini App's registered arena on, so a page caller shares the arena its own
 * process registered.
 */
export interface WebuiMiniAppAgentCaller {
  readonly pluginId: string;
  readonly runId: string;
  /** The session whose view framed the page; absent when the view names none. */
  readonly hostSessionId?: string;
}

/**
 * One Mini App launch, as the runtime hands it over.
 *
 * Declared here rather than in `shared/contracts/` on purpose: `credential` is a
 * live capability, and a shared contract is importable by the browser. Only the
 * server and the runtime may name this type; the wire carries
 * `WebuiMiniAppView`, which cannot express any of it.
 */
export interface WebuiMiniAppLaunch {
  readonly miniApp: WebuiMiniAppSummary;
  readonly launch: {
    /** The Mini App's own loopback origin. Never forwarded to a renderer. */
    readonly origin: string;
    readonly surfacePath: string;
    readonly runId: string;
    /** The credential the Mini App's guard demands. Injected by the proxy. */
    readonly credential: string;
    /**
     * Request header the guard reads it from. Carried with the credential so the
     * server never spells the header name twice, and never spells it differently
     * from the runtime that installed it.
     */
    readonly credentialHeader: string;
  };
}

/**
 * The narrow terminal-process port.
 *
 * The six terminal operations consume this port, not a concrete manager: the
 * registry must not depend on the class that happens to implement it. It lives
 * in this module — the runtime's port surface — because the layer matrix lets
 * `server` reach `runtime-port` and nothing else under `runtime/`, and the
 * service both receives the port and calls `disposeBySession` on shutdown.
 *
 * Every member is synchronous except `watch`, which is the delivery stream: the
 * operation handler drives it and the WebSocket server frames what it yields.
 */
export interface WebuiTerminalProcessPort {
  create(workspaceDir: string, cols?: number, rows?: number, workspaceTabId?: string): {
    readonly terminalId: string;
    readonly status: "running";
  };
  list(): readonly {
    readonly terminalId: string;
    readonly status: "running" | "exited";
    readonly output: string;
    readonly workspaceTabId?: string;
  }[];
  write(terminalId: string, data: string): { readonly success: true };
  resize(
    terminalId: string,
    cols: number,
    rows: number,
  ): { readonly success: true };
  dispose(terminalId: string): { readonly success: true };
  watch(
    terminalId: string,
    signal?: AbortSignal,
  ): AsyncIterable<{
    readonly terminalId: string;
    readonly data: string;
    readonly exited: boolean;
  }>;
  /** Ends every terminal this port owns. The service calls it on shutdown. */
  disposeBySession(): void;
}

/**
 * The narrow browser port.
 *
 * The browser operations consume this port rather than the browser service
 * itself, so the registry that serves them does not depend on the class that
 * happens to implement it. It lives in this module — the runtime's port
 * surface — because the layer matrix lets `server` reach `runtime-port` and
 * nothing else under `runtime/`.
 *
 * `watchFrames` is the delivery stream: the operation handler drives it and
 * the WebSocket server frames what it yields, the same way the terminal's
 * output is framed.
 *
 * Everything that touches a *selection* takes the run it belongs to. The
 * selection is scoped to the run (ADR 0019), so a port method that asked about
 * "the selected target" without naming a run would be asking about a target
 * that may belong to somebody else. `runId` is the Agent session id; the panel
 * sends the active run's, and the panel with no active run sends none.
 */
export interface WebuiBrowserPort {
  /** The four authorization switches, as they stand. */
  getAuthorization(): Promise<WebuiBrowserAuthorization>;
  /**
   * Writes one switch and applies its consequence: a surface that was turned
   * off stops, a surface that was turned on starts.
   */
  setAuthorization(
    input: Partial<WebuiBrowserAuthorization>,
  ): Promise<WebuiBrowserAuthorization>;
  /** Every target of one surface, with this run's selection marked. */
  listTargets(
    surface: WebuiBrowserSurface,
    runId?: string,
  ): Promise<WebuiBrowserTargetList>;
  /** Selects the target one run shows on a surface. */
  selectTarget(
    target: WebuiBrowserTargetId,
    runId?: string,
  ): Promise<WebuiBrowserTargetState>;
  /**
   * Forwards one input command.
   *
   * The command is validated before it is forwarded, and it is bound to the
   * target it was aimed at: an input aimed at a target that has since been
   * replaced is refused rather than delivered to the new page.
   */
  sendInput(
    command: WebuiBrowserInputCommand,
    runId?: string,
  ): Promise<{ readonly accepted: true }>;
  /**
   * Runs one browser command.
   *
   * The runtime decides whether the command is allowed: a restricted
   * browser-tool action, or a raw DevTools command under the Full CDP switch.
   * A command that is neither is refused, never forwarded on the chance that
   * the provider would accept it.
   */
  sendCommand(
    surface: WebuiBrowserSurface,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly accepted: true; readonly result?: unknown }>;
  /**
   * Runs one browser command against the target a **run** selected.
   *
   * The run id is not optional: a command that belongs to a run must act on
   * that run's page, and a selection belonging to somebody else is not a
   * substitute.
   */
  sendCommandToSelection(
    surface: WebuiBrowserSurface,
    runId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly accepted: true; readonly result?: unknown }>;
  /**
   * Runs one browser command against a **named page**.
   *
   * This is what a web tab's toolbar sends. A web tab holds exactly one page,
   * so the tab is addressable and the person pressing back means the page they
   * are looking at — not a run's selection, and not the panel's own cell. The
   * target carries a generation, so a reference recorded before a navigation is
   * refused rather than answered against the page that moved.
   */
  sendCommandToTarget(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
    command: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly result?: unknown }>;
  /**
   * Opens a page and answers with its identity.
   *
   * This is `open_tab` — the same call, the same switch and the same refusal
   * codes as the one a run's browser tools make, which is the whole point:
   * every web tab, the person's and the Agent's alike, is opened through one
   * gate.
   *
   * `opener` says which side asked, because the two sides have different cells:
   * an `agent` opener makes the page the run's selection, and a `person` opener
   * makes it the run's selection only when the run had none — the one bootstrap.
   * The run is optional because the person may have no run in view; absent means
   * the panel's own cell, and the bootstrap applies to it as it does to a run.
   */
  openWebTab(
    runId?: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    opener?: WebuiBrowserTabOpener,
  ): Promise<WebuiBrowserWebTabOpen>;
  /**
   * The live image stream of one **target**.
   *
   * The stream is keyed by the target rather than by the run: the client asks
   * for the page it is showing, so two tabs get their own pictures. The run's
   * selection still decides what the **Agent's** commands act on — the two are
   * different cells and this one does not move the other.
   */
  watchFrames(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
    signal?: AbortSignal,
    viewport?: WebuiBrowserViewport,
  ): AsyncIterable<WebuiBrowserImageFrame>;
  /**
   * Closes the page a web tab is bound to.
   *
   * A tab the person closes does not leave a page behind in the browser, and
   * the runtime's page set follows the strip.
   */
  closeWebTab(target: WebuiBrowserTargetId): Promise<WebuiBrowserWebTabClose>;
  /**
   * The session's web tabs, as a snapshot, on a stream.
   *
   * The runtime owns the record of what the session has open: the strip
   * renders what this publishes rather than keeping a copy of its own, and a
   * snapshot is idempotent, so a client that reconnects reconciles against
   * it instead of drifting.
   */
  watchWebTabs(
    surface: WebuiBrowserSurface,
    runId?: string,
    signal?: AbortSignal,
  ): AsyncIterable<WebuiBrowserWebTabSnapshot>;
  /** What each surface can offer right now. */
  listCapabilities(): Promise<{
    readonly entries: readonly WebuiBrowserCapabilityEntry[];
  }>;
}
