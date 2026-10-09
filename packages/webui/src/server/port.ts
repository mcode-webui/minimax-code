import type { WebuiPluginManagementRequest } from "../shared/plugin-management.js";
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
import type { WebuiModelEntry, WebuiSkillEntry } from "../shared/contracts/models.js";
import type { WebuiVersionInfo } from "../shared/contracts/version.js";
import type { WebuiUsageQuotaResult } from "../shared/contracts/usage-quota.js";
import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "../shared/contracts/account.js";

export type {
  WebuiPluginManagementAction,
  WebuiPluginManagementRequest,
} from "../shared/plugin-management.js";

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
  listVisibleProjects?(request: { readonly limit?: number }): Promise<readonly WebuiProjectRecord[]>;
  listSessions(request: WebuiSessionListRequest): Promise<WebuiSessionPage>;
  getSessionTree(request: WebuiSessionTreeRequest): Promise<WebuiSessionTreePage>;
  archiveSession(request: { readonly id: string; readonly archived?: boolean }): Promise<{ readonly success?: boolean }>;
  deleteSession(request: { readonly id: string }): Promise<{ readonly success?: boolean }>;
  updateSession(request: WebuiUpdateSessionRequest): Promise<WebuiUpdateSessionResult>;
  getSessionForkOptions(request: WebuiGetSessionForkOptionsRequest): Promise<WebuiGetSessionForkOptionsResult>;
  forkSession(request: WebuiForkSessionRequest): Promise<WebuiForkSessionResult>;
  createSession(
    request: WebuiCreateSessionRequest,
  ): Promise<WebuiCreateSessionResult>;
  getSession(
    request: WebuiSessionLookupRequest,
  ): Promise<WebuiSessionLookupResult>;
  getActiveTurn(request: WebuiSessionLookupRequest): Promise<WebuiActiveTurnResult>;
  getMessages(request: WebuiMessagesRequest): Promise<WebuiMessagesResult>;
  /**
   * Both storage layers of a session, verbatim.
   *
   * Deliberately not `getMessages`: that returns a view prepared for
   * rendering, which drops the canonical receipts carried on compaction and
   * fork-origin rows, and a transfer file built from it cannot be read back
   * without losing them.
   */
  exportSessionTransfer(request: { readonly id: string }): Promise<WebuiSessionTransferFile>;
  importSessionTransfer(
    request: WebuiImportSessionTransferRequest,
  ): Promise<WebuiImportSessionTransferResult>;
  getSessionDiff(request: WebuiGetSessionDiffRequest): Promise<WebuiGetSessionDiffResult>;
  getTurnDiff(request: WebuiGetTurnDiffRequest): Promise<WebuiGetTurnDiffResult>;
  revertTurnDiff(request: WebuiRevertTurnDiffRequest): Promise<WebuiRevertTurnDiffResult>;
  reapplyTurnDiff(request: WebuiReapplyTurnDiffRequest): Promise<WebuiReapplyTurnDiffResult>;
  getSessionRewindPreview(request: WebuiGetSessionRewindPreviewRequest): Promise<WebuiGetSessionRewindPreviewResult>;
  rewindSession(request: WebuiRewindSessionRequest): Promise<WebuiRewindSessionResult>;
  editSessionMessage(request: WebuiEditSessionMessageRequest): Promise<WebuiEditSessionMessageResult>;
  isGoalEnabled(): Promise<WebuiGoalEnabledResult>;
  getGoal(request: WebuiGoalSessionRequest): Promise<WebuiGoal | undefined>;
  createGoal(request: WebuiGoalCreateRequest): Promise<WebuiGoal>;
  patchGoal(request: WebuiGoalPatchRequest): Promise<WebuiGoal>;
  clearGoal(request: WebuiGoalSessionRequest): Promise<{ readonly success: boolean }>;
  listWorkspaceFileTree(request: { readonly workspaceDir: string; readonly path?: string }): Promise<readonly WebuiWorkspaceFile[]>;
  readWorkspaceFile(request: { readonly workspaceDir: string; readonly path: string }): Promise<WebuiWorkspaceFileContent>;
  getWorkspaceEnvironment(request: { readonly workspaceDir: string }): Promise<WebuiWorkspaceEnvironment>;
  mutateWorkspaceGit(request: WebuiWorkspaceGitMutationRequest): Promise<Record<string, unknown>>;
  getWorkspaceReviewSummary(request: { readonly workspaceDir: string }): Promise<WebuiWorkspaceReviewSummary>;
  listWorkspaceReviewFileDiffs(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: readonly string[] }): Promise<WebuiWorkspaceReviewDiffs>;
  getWorkspaceReviewFileContent(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }): Promise<WebuiWorkspaceReviewFileContent>;
  searchWorkspaceReviewDiffs(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }): Promise<WebuiWorkspaceReviewSearchResult>;
  readCanvas(request: { readonly sessionId: string }): Promise<WebuiCanvasDocument>;
  applyCanvas(request: { readonly sessionId: string; readonly operation: Record<string, unknown> }): Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
  /**
   * Archive listing for the workspace panel. The runtime owns every
   * hardening decision here (entry ceiling, expansion ratio, path
   * validation); the WebUI only renders what the runtime is willing to name.
   */
  readWorkspaceArchive(request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string }): Promise<WebuiWorkspaceArchiveListing>;
  extractWorkspaceArchive(request: { readonly workspaceDir: string; readonly path: string; readonly destination: string; readonly prefix?: string }): Promise<WebuiWorkspaceArchiveExtractResult>;
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
   * the desktop's `listSkills(agentName, ...)` call shape so the WebUI can
   * populate the popover from the live registry instead of a fixture set.
   * `agentName` is optional: the harness may default to the active agent
   * when the WebUI has no session yet (e.g. the home composer).
   */
  listSkills(request?: {
    readonly agentName?: string;
  }): Promise<{ readonly skills: readonly WebuiSkillEntry[] }>;
  pluginManagement?(request: WebuiPluginManagementRequest): Promise<unknown>;
  getPermissionMode?(): Promise<unknown>;
  setPermissionMode?(request: { readonly mode: "default" | "auto" | "bypassPermissions" }): Promise<unknown>;
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
  createUserModelProvider(request: Record<string, unknown>): Promise<unknown>;
  updateUserModelProvider(request: Record<string, unknown>): Promise<unknown>;
  deleteUserModelProvider(providerId: string): Promise<unknown>;
  testUserModelProvider(request: { readonly providerId: string; readonly apiKey?: string }): Promise<unknown>;
  testUserModel(request: { readonly providerId: string; readonly modelId: string }): Promise<unknown>;
  discoverUserModelsCandidate(request: Record<string, unknown>): Promise<unknown>;
  saveUserModelProviderCandidate(request: Record<string, unknown>): Promise<unknown>;
  listProviderPresets(): Promise<readonly Record<string, unknown>[]>;
  getMiniMaxApiKeyStatus(): Promise<Record<string, unknown>>;
  upsertMiniMaxApiKey(request: { readonly apiKey: string; readonly saveAndUse?: boolean }): Promise<unknown>;
  getCodexOAuthStatus(): Promise<Record<string, unknown>>;
  getMiniMaxModelSource(): Promise<"token_plan" | "minimax_api_key">;
  setMiniMaxModelSource(request: { readonly source: "token_plan" | "minimax_api_key" }): Promise<"token_plan" | "minimax_api_key">;
  testUserModelCandidate(request: { readonly candidate: Record<string, unknown>; readonly modelId: string }): Promise<unknown>;
  revealModelProviderApiKey(request: { readonly providerId: string }): Promise<string>;
  startCodexOAuthLogin(request?: Record<string, unknown>): Promise<unknown>;
  cancelCodexOAuthLogin(request: { readonly loginId: string }): Promise<unknown>;
  refreshModels(): Promise<unknown>;
  /**
   * Release anything the port owns. The service calls this after closing
   * every transport-side resource so the harness can tear itself down in
   * the order step 13 of the assembly checklist requires.
   */
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
/**
   * Account login over the device-authorization flow, and the sign-out that
   * actually removes the credential. See `account-login.ts` for why the
   * session lives server-side; supplied by the assembly alongside the host.
   */
  beginAccountLogin(): Promise<WebuiAccountLoginView>;
  getAccountLoginStatus(): Promise<WebuiAccountLoginView>;
  cancelAccountLogin(): Promise<{ readonly ok: true }>;
  signOutAccount(): Promise<{ readonly status: string; readonly generation: number }>;
  /**
   * Profile-wide `AGENTS.md`, the file Turn assembly already reads through
   * `GlobalInstructions.readForPrompt`. Read-only on the v2 `instructions`
   * capability (`listSources` returns paths, not content), so the WebUI reads
   * and writes the file itself over the same `dataDir` the turn path uses — one
   * file, one writer, no second source of truth.
   */
  getGlobalInstructions?(): Promise<
    import("../client/contracts/settings-port.js").WebuiGlobalInstructionsView
  >;
  /** Writing empty content deletes the file, matching `GlobalInstructions.write`. */
  setGlobalInstructions?(request: {
    readonly content: string;
  }): Promise<import("../client/contracts/settings-port.js").WebuiGlobalInstructionsView>;
  /**
   * Per-agent main memory (`agents/<name>/memory/MEMORY.md`). Summary-only by
   * default; `includeContent` pulls the body, which runs past the 64KB
   * cleanup threshold on a live profile. Writing empty content deletes the
   * file, matching the runtime's write contract.
   */
  getAgentMemory?(request?: {
    readonly includeContent?: boolean;
  }): Promise<import("../client/contracts/settings-port.js").WebuiAgentMemoryView>;
  setAgentMemory?(request: {
    readonly content: string;
  }): Promise<import("../client/contracts/settings-port.js").WebuiAgentMemoryView>;
  /**
   * The `关于你` region of `memory/user.md` — the three fields between the
   * personalization markers. The rest of that file belongs to the memory
   * collector, so a write must never be able to express "replace the file".
   * A file whose markers are only half-present refuses the write rather than
   * guessing where the region ends.
   */
  getUserProfile?(): Promise<import("../client/contracts/settings-port.js").WebuiUserProfileView>;
  setUserProfile?(request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }): Promise<import("../client/contracts/settings-port.js").WebuiUserProfileView>;
  /**
   * The two memory switches. Optional because a host that predates the
   * configuration capability still has to satisfy this port; a missing method
   * is a capability gap, not a boolean value, and the handler reports it as
   * such instead of rendering the panel as "memory is off".
   */
  getMemorySettings?(): Promise<import("../client/contracts/settings-port.js").WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<import("../client/contracts/settings-port.js").WebuiMemorySettingsView>;
  close(): Promise<void>;
}
