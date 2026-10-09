// The exact surface of the runtime `cliService` the WebUI talks to, and the
// harness host handle the runtime assembly hands to the adapter.
//
// The host shape is structural so the WebUI does not need to bundle the whole
// harness layer to type-check; the runtime assembly passes the host directly at
// process start. `WebuiRuntimeCliService` is exported as the single source of
// truth so the assembly layer can type its `cliService?: WebuiRuntimeCliService`
// slot without re-spelling it.

import type {
  WebuiSessionListRequest,
  WebuiSessionPage,
  WebuiSessionTreeRequest,
  WebuiSessionTreePage,
  WebuiProjectRecord,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
} from "../../shared/contracts/session.js";
import type {
  WebuiSendMessageRequest,
  WebuiSendMessageResult,
  WebuiResumeSessionRequest,
  WebuiStreamResult,
  WebuiRuntimeEvent,
} from "../../shared/contracts/stream.js";
import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../../shared/contracts/queue.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireAnswer,
  WebuiInteractionReplyResult,
  WebuiPermissionDecision,
} from "../../shared/contracts/interactions.js";
import type {
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceGitMutationRequest,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";
import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../shared/contracts/goal.js";
import type {
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
} from "../../shared/contracts/personalization.js";

/**
 * The exact surface of the runtime `cliService` the WebUI talks to. The
 * runtime harness is responsible for satisfying this shape; the WebUI's only
 * job is to forward requests here. Methods optional on the live cliService
 * stay optional here too — `createHarnessPortFromHost` projects them back
 * with `requireCliService` so every wire-error is a single, uniform
 * `runtime host does not expose the CLI service` message.
 *
 * Exported as the single source of truth so the assembly layer can type its
 * `cliService?: WebuiRuntimeCliService` slot without re-spelling it.
 */
export interface WebuiRuntimeCliService {
  listVisibleProjects?(limit?: number): Promise<readonly WebuiProjectRecord[]>;
  listSessions(
    request: WebuiSessionListRequest,
    context?: Record<string, never>,
  ): Promise<WebuiSessionPage>;
  pluginManagement(request: import("../../server/port.js").WebuiPluginManagementRequest): Promise<unknown>;
  getSessionTree(
    request: WebuiSessionTreeRequest,
    context?: Record<string, never>,
  ): Promise<WebuiSessionTreePage>;
  archiveSession(
    request: { readonly id: string; readonly archived?: boolean },
    context?: Record<string, never>,
  ): Promise<{ readonly success?: boolean }>;
  deleteSession(
    request: { readonly id: string },
    context?: Record<string, never>,
  ): Promise<{ readonly success?: boolean }>;
  updateSession(
    request: import("../../shared/contracts/session.js").WebuiUpdateSessionRequest,
    context?: Record<string, never>,
  ): Promise<import("../../shared/contracts/session.js").WebuiUpdateSessionResult>;
  getSessionForkOptions(
    request: WebuiGetSessionForkOptionsRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetSessionForkOptionsResult>;
  forkSession(
    request: WebuiForkSessionRequest,
    context?: Record<string, never>,
  ): Promise<WebuiForkSessionResult>;
  createSession(
    request: WebuiCreateSessionRequest,
    context?: Record<string, never>,
  ): Promise<WebuiCreateSessionResult>;
  getSession(
    request: import("../../shared/contracts/session.js").WebuiSessionLookupRequest,
    context?: Record<string, never>,
  ): Promise<import("../../shared/contracts/session.js").WebuiSessionLookupResult>;
  getMessages(
    request: import("../../shared/contracts/messages.js").WebuiMessagesRequest,
    context?: Record<string, never>,
  ): Promise<import("../../shared/contracts/messages.js").WebuiMessagesResult>;
  exportSessionTransfer(sessionId: string): Promise<import("../../shared/contracts/session.js").WebuiSessionTransferFile>;
  importSessionTransfer(
    request: import("../../shared/contracts/session.js").WebuiImportSessionTransferRequest,
  ): Promise<import("../../shared/contracts/session.js").WebuiImportSessionTransferResult>;
  getSessionDiff(
    request: WebuiGetSessionDiffRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetSessionDiffResult>;
  getTurnDiff(
    request: WebuiGetTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetTurnDiffResult>;
  revertTurnDiff(
    request: WebuiRevertTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<WebuiRevertTurnDiffResult>;
  reapplyTurnDiff(
    request: WebuiReapplyTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<WebuiReapplyTurnDiffResult>;
  getSessionRewindPreview(
    request: WebuiGetSessionRewindPreviewRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetSessionRewindPreviewResult>;
  rewindSession(
    request: WebuiRewindSessionRequest,
    context?: Record<string, never>,
  ): Promise<WebuiRewindSessionResult>;
  editSessionMessage(
    request: WebuiEditSessionMessageRequest,
    context?: Record<string, never>,
  ): Promise<WebuiEditSessionMessageResult>;
  getActiveTurn(
    sessionId: string,
  ): Promise<import("../../shared/contracts/session.js").WebuiActiveTurn | undefined>;
  isGoalEnabled(): boolean;
  getGoal(sessionId: string): Promise<WebuiGoal | undefined>;
  createGoal(request: WebuiGoalCreateRequest): Promise<WebuiGoal>;
  patchGoal(
    sessionId: string,
    patch: Omit<WebuiGoalPatchRequest, "sessionId">,
  ): Promise<WebuiGoal>;
  clearGoal(sessionId: string): Promise<boolean>;
  listWorkspaceFileTree?(request: { readonly workspaceDir: string; readonly path?: string }): Promise<readonly WebuiWorkspaceFile[]>;
  readWorkspaceFile?(request: { readonly workspaceDir: string; readonly path: string }): Promise<WebuiWorkspaceFileContent>;
  searchWorkspaceFiles?(input: { readonly workspaceDir: string; readonly query: string; readonly limit: number }): Promise<readonly string[]>;
  /**
   * Archive listing and extraction are served by this package
   * (`./workspace-archive.ts`, Node built-ins only) rather than by the runtime,
   * so these two stay optional: a host that has a richer implementation of its
   * own still wins, and a host that has none gets the WebUI's reader instead of
   * an error the panel can only show.
   */
  readWorkspaceArchive?(request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string }): Promise<WebuiWorkspaceArchiveListing>;
  extractWorkspaceArchive?(request: { readonly workspaceDir: string; readonly path: string; readonly destination: string; readonly prefix?: string }): Promise<WebuiWorkspaceArchiveExtractResult>;
  getWorkspaceGitEnvironment?(workspaceDir: string): Promise<{ readonly metadata: Record<string, unknown>; readonly changes: Record<string, unknown> }>;
  mutateWorkspaceGit?(request: WebuiWorkspaceGitMutationRequest): Promise<Record<string, unknown>>;
  getWorkspaceReviewSummary?(workspaceDir: string): Promise<WebuiWorkspaceReviewSummary>;
  listWorkspaceReviewFileDiffs?(input: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: string[] }): Promise<WebuiWorkspaceReviewDiffs>;
  getWorkspaceReviewFileContent?(input: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }): Promise<WebuiWorkspaceReviewFileContent>;
  searchWorkspaceReviewDiffs?(input: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }): Promise<WebuiWorkspaceReviewSearchResult>;
  readCanvas?(request: { readonly sessionId: string }): Promise<WebuiCanvasDocument>;
  applyCanvas?(request: { readonly sessionId: string; readonly operation: Record<string, unknown> }): Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
  sendMessage(
    request: WebuiSendMessageRequest,
    context?: { readonly signal?: AbortSignal },
  ): Promise<WebuiSendMessageResult>;
  enqueueMessage(
    request: WebuiEnqueueMessageRequest,
    context?: { readonly signal?: AbortSignal },
  ): Promise<WebuiEnqueueMessageResult>;
  resumeSession(
    request: WebuiResumeSessionRequest,
    context?: { readonly signal?: AbortSignal },
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
    readonly reply: number;
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
   * The cliService returns the harness `SkillInfo[]`; the host then projects
   * it down to `WebuiSkillEntry[]` for the WebUI client. The structural type
   * spells out the wider shape (incl. `displayDescription` for i18n) so the
   * field-selection logic in `listSkills()` below type-checks.
   */
  listSkills(request?: {
    readonly agentName?: string;
  }): Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly displayDescription?: string;
    }[];
  }>;
  getPermissionMode(): Promise<unknown>;
  setPermissionMode(request: {
    readonly mode: "default" | "auto" | "bypassPermissions";
  }): Promise<unknown>;
  getGlobalInstructions(): Promise<WebuiGlobalInstructionsView>;
  setGlobalInstructions(request: {
    readonly content: string;
  }): Promise<WebuiGlobalInstructionsView>;
  getAgentMemory(request?: { readonly includeContent?: boolean }): Promise<import("../../shared/contracts/personalization.js").WebuiAgentMemoryView>;
  setAgentMemory(request: {
    readonly content: string;
  }): Promise<import("../../shared/contracts/personalization.js").WebuiAgentMemoryView>;
  getUserProfile(): Promise<import("../../shared/contracts/personalization.js").WebuiUserProfileView>;
  setUserProfile(request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }): Promise<import("../../shared/contracts/personalization.js").WebuiUserProfileView>;
  /**
   * Optional on purpose: a host without the configuration capability still has
   * to type-check. The handlers below fail closed with one clear message rather
   * than crashing on `undefined` — a missing method is not the same statement as
   * `enabled: false`.
   */
  getMemorySettings?(): Promise<import("../../shared/contracts/personalization.js").WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<import("../../shared/contracts/personalization.js").WebuiMemorySettingsView>;
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
  deleteUserModelProvider(request: { readonly providerId: string }): Promise<unknown>;
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
   * Compaction is opt-in on the live harness: the `CliService` exposes it
   * only when the host has a meaningful reducer, and the WebUI surface
   * surfaces `runtime host does not expose requestCompaction` for any host
   * that omits it. The runner's `/compact` path therefore can't assume the
   * method always exists, which is why the port's `requestCompaction` is
   * a required harness-port method: the assembly is responsible for
   * projecting an `optional` cliService hook into a `required` port entry,
   * and failing closed otherwise. See `createHarnessPortFromHost` for the
   * nested-guard pattern that turns that `?` into a clear error.
   */
  requestCompaction?(request: {
    readonly name: string;
    readonly id: string;
    readonly reason: "ui_request";
    readonly customInstructions?: string;
  }): Promise<Record<string, unknown>>;
}

export interface WebuiRuntimeHostHandle {
  readonly apiHost: { close(): Promise<void> };
  readonly appVersion?: string;
  readonly dataDir?: string;
  readonly invalidateAuth?: () => void;
  /**
   * Cloud quota for the usage panel. Backed by `usage-quota.ts`, not the
   * harness — the assembly supplies the client alongside the host.
   */
  readonly getUsageQuota?: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<import("../../shared/contracts/usage-quota.js").WebuiUsageQuotaResult>;
  /**
   * Daily check-in status/claim. Backed by `check-in.ts` (cloud), supplied
   * by the assembly alongside the host.
   */
  readonly getSigninPanel?: () => Promise<import("../../shared/contracts/account.js").WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<import("../../shared/contracts/account.js").WebuiClaimSigninView>;
  /**
   * Account login (device authorization) and real sign-out. Supplied by the
   * assembly from its `MCodeOAuthCore` — the same credential store the quota
   * lease reads — so a login completed in the browser is the same credential
   * the terminal client uses, and a sign-out actually removes it.
   */
  readonly beginAccountLogin?: () => Promise<import("../../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly getAccountLoginStatus?: () => Promise<import("../../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly cancelAccountLogin?: () => Promise<void>;
  readonly signOutAccount?: () => Promise<{ readonly status: string; readonly generation: number }>;
  /**
   * Source of every harness command the WebUI maps to operations. Owned by
   * the runtime host; the WebUI only needs the structural shape to forward.
   */
  readonly cliService?: WebuiRuntimeCliService;
}
