// Wires the harness layer to the WebUI service.
//
// The harness port's `version()` reads the version that the runtime host was
// started with (`appVersion`). The host itself is owned by the runtime
// package, not by the WebUI, so this module is a thin adapter: it accepts
// a host, extracts the version, and exposes the close hook on the harness
// port so the service can shut down the host in the order step 13 of the
// assembly checklist requires.
//
// The host shape is structural so the WebUI does not need to bundle the
// whole harness layer to type-check; the runtime assembly passes the host
// directly at process start.

import { posix as pathPosix } from "node:path";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  readAgentMemory,
  readGlobalInstructions,
  readUserProfile,
  writeAgentMemory,
  writeGlobalInstructions,
  writeUserProfile,
  WEBUI_DEFAULT_AGENT_NAME,
} from "./profile-files.js";
import { WEBUI_PROTOCOL_VERSION } from "./envelope.js";
import {
  extractWorkspaceArchiveDirectory,
  readWorkspaceArchiveListing,
} from "./workspace-archive.js";
import type { WebuiScheduledTaskRuntime } from "./scheduled-task-scheduler.js";
import type {
  WebuiHarnessPort,
  WebuiSessionListRequest,
  WebuiSessionPage,
  WebuiSessionTreeRequest,
  WebuiSessionTreePage,
  WebuiProjectRecord,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiVersionInfo,
  WebuiSendMessageRequest,
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiSendMessageResult,
  WebuiResumeSessionRequest,
  WebuiStreamResult,
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireAnswer,
  WebuiRuntimeEvent,
  WebuiInteractionReplyResult,
  WebuiPermissionDecision,
  WebuiQueueItem,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceGitMutationRequest,
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
  WebuiCanvasDocument,
  WebuiModelEntry,
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
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "./port.js";
import type {
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
} from "../client/contracts.js";

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
  pluginManagement(request: import("./port.js").WebuiPluginManagementRequest): Promise<unknown>;
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
    request: import("./port.js").WebuiUpdateSessionRequest,
    context?: Record<string, never>,
  ): Promise<import("./port.js").WebuiUpdateSessionResult>;
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
    request: import("./port.js").WebuiSessionLookupRequest,
    context?: Record<string, never>,
  ): Promise<import("./port.js").WebuiSessionLookupResult>;
  getMessages(
    request: import("./port.js").WebuiMessagesRequest,
    context?: Record<string, never>,
  ): Promise<import("./port.js").WebuiMessagesResult>;
  exportSessionTransfer(sessionId: string): Promise<import("./port.js").WebuiSessionTransferFile>;
  importSessionTransfer(
    request: import("./port.js").WebuiImportSessionTransferRequest,
  ): Promise<import("./port.js").WebuiImportSessionTransferResult>;
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
  ): Promise<import("./port.js").WebuiActiveTurn | undefined>;
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
  getAgentMemory(request?: { readonly includeContent?: boolean }): Promise<import("../client/contracts.js").WebuiAgentMemoryView>;
  setAgentMemory(request: {
    readonly content: string;
  }): Promise<import("../client/contracts.js").WebuiAgentMemoryView>;
  getUserProfile(): Promise<import("../client/contracts.js").WebuiUserProfileView>;
  setUserProfile(request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }): Promise<import("../client/contracts.js").WebuiUserProfileView>;
  /**
   * Optional on purpose, like the scheduled-task block above: a host without
   * the configuration capability still has to type-check. The handlers below
   * fail closed with one clear message rather than crashing on `undefined` —
   * a missing method is not the same statement as `enabled: false`.
   */
  getMemorySettings?(): Promise<import("../client/contracts.js").WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<import("../client/contracts.js").WebuiMemorySettingsView>;
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
  }) => Promise<import("./port.js").WebuiUsageQuotaResult>;
  /**
   * Daily check-in status/claim. Backed by `check-in.ts` (cloud), supplied
   * by the assembly alongside the host.
   */
  readonly getSigninPanel?: () => Promise<import("./port.js").WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<import("./port.js").WebuiClaimSigninView>;
  /**
   * Account login (device authorization) and real sign-out. Supplied by the
   * assembly from its `MCodeOAuthCore` — the same credential store the quota
   * lease reads — so a login completed in the browser is the same credential
   * the terminal client uses, and a sign-out actually removes it.
   */
  readonly beginAccountLogin?: () => Promise<import("./port.js").WebuiAccountLoginView>;
  readonly getAccountLoginStatus?: () => Promise<import("./port.js").WebuiAccountLoginView>;
  readonly cancelAccountLogin?: () => Promise<void>;
  readonly signOutAccount?: () => Promise<{ readonly status: string; readonly generation: number }>;
  /**
   * Source of every harness command the WebUI maps to operations. Owned by
   * the runtime host; the WebUI only needs the structural shape to forward.
   */
  readonly cliService?: WebuiRuntimeCliService;
  /**
   * Scheduled tasks, when the host carries a runtime for them. Optional on
   * purpose: a host that predates this surface still type-checks, and every
   * scheduled-task method below fails closed with one clear message instead of
   * crashing on an undefined call. The WebUI's own service supplies its local
   * runtime rather than routing through here — see `service.ts`.
   */
  readonly scheduledTasks?: WebuiScheduledTaskRuntime;
}

/**
 * Builds the harness port over the runtime host returned by the harness
 * layer. Closes the host on `port.close()` so the service can rely on
 * the port alone to tear the runtime down.
 */
export function createHarnessPortFromHost(
  handle: WebuiRuntimeHostHandle,
): WebuiHarnessPort {
  const host = handle;
  const version: WebuiVersionInfo = {
    version: host.appVersion ?? "unknown",
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    ...(host.dataDir ? { dataDir: host.dataDir } : {}),
  };
  let closed = false;
  return {
    version() {
      return version;
    },
    async invalidateAuth() {
      host.invalidateAuth?.();
    },
    async listSessions(request) {
      return requireCliService(host).listSessions(request, {});
    },
    async listVisibleProjects(request) {
      const service = requireCliService(host);
      if (!service.listVisibleProjects) throw new Error("runtime host does not expose project listing");
      return service.listVisibleProjects(request.limit ?? 100);
    },
    async getSessionTree(request) {
      return requireCliService(host).getSessionTree(request, {});
    },
    async archiveSession(request) {
      return requireCliService(host).archiveSession(request, {});
    },
    async deleteSession(request) {
      return requireCliService(host).deleteSession(request, {});
    },
    async updateSession(request) {
      return requireCliService(host).updateSession(request, {});
    },
    async getSessionForkOptions(request) {
      return requireCliService(host).getSessionForkOptions(request, {});
    },
    async forkSession(request) {
      return requireCliService(host).forkSession(request, {});
    },
    async createSession(request) {
      return requireCliService(host).createSession(request, {});
    },
    async getSession(request) {
      return requireCliService(host).getSession(request, {});
    },
    async getMessages(request) {
      return requireCliService(host).getMessages(request, {});
    },
    async exportSessionTransfer(request) {
      return requireCliService(host).exportSessionTransfer(request.id);
    },
    async importSessionTransfer(request) {
      return requireCliService(host).importSessionTransfer(request);
    },
    async getSessionDiff(request) {
      return requireCliService(host).getSessionDiff(request, {});
    },
    async getTurnDiff(request) {
      return requireCliService(host).getTurnDiff(request, {});
    },
    async revertTurnDiff(request) {
      return requireCliService(host).revertTurnDiff(request, {});
    },
    async reapplyTurnDiff(request) {
      return requireCliService(host).reapplyTurnDiff(request, {});
    },
    async getSessionRewindPreview(request) {
      return requireCliService(host).getSessionRewindPreview(request, {});
    },
    async rewindSession(request) {
      return requireCliService(host).rewindSession(request, {});
    },
    async editSessionMessage(request) {
      return requireCliService(host).editSessionMessage(request, {});
    },
    async isGoalEnabled() {
      return { enabled: requireCliService(host).isGoalEnabled() };
    },
    async getActiveTurn(request) {
      return requireCliService(host).getActiveTurn(request.id);
    },
    async getGoal(request) {
      return requireCliService(host).getGoal(request.sessionId);
    },
    async createGoal(request) {
      return requireCliService(host).createGoal(request);
    },
    async patchGoal(request) {
      const { sessionId, ...patch } = request;
      return requireCliService(host).patchGoal(sessionId, patch);
    },
    async clearGoal(request) {
      return { success: await requireCliService(host).clearGoal(request.sessionId) };
    },
    // Scheduled tasks. The capability probe answers instead of throwing, so a
    // client can ask "can this host do scheduled tasks at all?" and render the
    // reason; the other five are operations, and an operation that cannot be
    // served reports the same reason as a `harness_error`.
    async listScheduledTasks(request) {
      return requireScheduledTasks(host).listScheduledTasks(request);
    },
    async createScheduledTask(request) {
      return requireScheduledTasks(host).createScheduledTask(request);
    },
    async updateScheduledTask(request) {
      return requireScheduledTasks(host).updateScheduledTask(request);
    },
    async deleteScheduledTask(request) {
      return requireScheduledTasks(host).deleteScheduledTask(request);
    },
    async triggerScheduledTaskNow(request) {
      return requireScheduledTasks(host).triggerScheduledTaskNow(request);
    },
    async getScheduledTaskCapability() {
      return host.scheduledTasks
        ? host.scheduledTasks.getScheduledTaskCapability()
        : {
            available: false,
            // No implementation answered, which is a different fact from "our
            // own implementation is unavailable". See
            // `WebuiScheduledTaskCapabilitySource`.
            source: "none" as const,
            reason:
              "scheduled tasks are not available: this host exposes no scheduled-task runtime",
          };
    },
    async listWorkspaceFileTree(request) {
      const tree = await requireCliService(host).listWorkspaceFileTree!(request) as readonly WebuiWorkspaceFile[];
      // The runtime reports names and shape but no file facts, while the port
      // contract now promises `size` and `modifiedAt` for the panel's metadata
      // column. Statted here because this is the one place that sees both the
      // tree and the filesystem — extending the runtime would put the change
      // outside this package, and a tree that silently omits the fields would
      // leave the column blank rather than failing loudly.
      return Promise.all(tree.map(async (entry) => {
        if (entry.type === "directory") return entry;
        try {
          const stats = await stat(path.join(request.workspaceDir, entry.path));
          return { ...entry, size: stats.size, modifiedAt: stats.mtimeMs };
        } catch {
          // A file that vanished or is unreadable keeps its entry and loses
          // only the metadata; dropping it from the tree would be a lie.
          return entry;
        }
      }));
    },
    // Both operations are served by this package now, so the optional runtime
    // hook is a preference rather than a requirement: a host that implements
    // one keeps it, and a host that implements neither lands on
    // `./workspace-archive.ts` instead of the "capability not connected yet"
    // error this pair used to throw. The built-in reader owns the hardening
    // (path validation, entry ceiling, expansion ratio), which is the reason it
    // is not left to a runtime that may not have shipped one.
    async readWorkspaceArchive(request) {
      const cliService = requireCliService(host);
      if (cliService.readWorkspaceArchive) return cliService.readWorkspaceArchive(request);
      return readWorkspaceArchiveListing(request);
    },
    async extractWorkspaceArchive(request) {
      const cliService = requireCliService(host);
      if (cliService.extractWorkspaceArchive) return cliService.extractWorkspaceArchive(request);
      return extractWorkspaceArchiveDirectory(request);
    },
    async readWorkspaceFile(request) {
      const cliService = requireCliService(host);
      const result = await cliService.readWorkspaceFile!(request) as WebuiWorkspaceFileContent;
      if (
        result.type !== "binary" ||
        result.error !== "Path traversal denied" ||
        request.path.includes("/") ||
        request.path.includes("\\") ||
        !cliService.searchWorkspaceFiles
      ) return result;

      // Assistant replies sometimes link only a basename (for example,
      // `SessionComposer.tsx`) even when the file lives in a nested package.
      // Resolve only an exact, unique basename; never guess among duplicates.
      try {
        const matches = await cliService.searchWorkspaceFiles({
          workspaceDir: request.workspaceDir,
          query: request.path,
          limit: 100,
        });
        const exactMatches = matches.filter((candidate) => pathPosix.basename(candidate.replace(/\\/gu, "/")) === request.path);
        const [exactMatch] = exactMatches;
        if (exactMatches.length === 1 && exactMatch) {
          const resolved = await cliService.readWorkspaceFile!({
            ...request,
            path: exactMatch,
          }) as WebuiWorkspaceFileContent;
          return { ...resolved, resolvedPath: exactMatch };
        }
        return {
          type: "text",
          content: "",
          error: exactMatches.length > 1
            ? `工作区中有多个名为 ${request.path} 的文件，请使用完整相对路径。`
            : `工作区中没有找到 ${request.path}。`,
        };
      } catch {
        return result;
      }
    },
    async getWorkspaceEnvironment(request) {
      const cliService = requireCliService(host);
      if (!cliService.getWorkspaceGitEnvironment)
        throw new Error("runtime host does not expose Workspace git state");
      const { metadata, changes } = await cliService.getWorkspaceGitEnvironment(request.workspaceDir);
      return {
        isGitRepo: changes.isGitRepo === true || metadata.isGitRepo === true,
        ...(typeof metadata.branch === "string" ? { branch: metadata.branch } : {}),
        changedFiles: typeof changes.changedFiles === "number" ? changes.changedFiles : 0,
        insertions: typeof changes.insertions === "number" ? changes.insertions : 0,
        deletions: typeof changes.deletions === "number" ? changes.deletions : 0,
        lineStatsStatus: changes.lineStatsStatus === "ready" || changes.lineStatsStatus === "partial" ? changes.lineStatsStatus : "skipped",
        ...(typeof metadata.canPush === "boolean" ? { canPush: metadata.canPush } : {}),
        ...(typeof metadata.hasRemote === "boolean" ? { hasRemote: metadata.hasRemote } : {}),
        ...(typeof metadata.hasUpstream === "boolean" ? { hasUpstream: metadata.hasUpstream } : {}),
        ...(typeof changes.error === "string" ? { changesError: changes.error } : {}),
        ...(typeof metadata.error === "string" ? { metadataError: metadata.error } : {}),
      } as WebuiWorkspaceEnvironment;
    },
    async mutateWorkspaceGit(request) {
      const cliService = requireCliService(host);
      if (!cliService.mutateWorkspaceGit)
        throw new Error("runtime host does not expose Workspace git mutations");
      return cliService.mutateWorkspaceGit(request);
    },
    async getWorkspaceReviewSummary(request) {
      const cliService = requireCliService(host);
      if (!cliService.getWorkspaceReviewSummary) throw new Error("runtime host does not expose Workspace review summaries");
      return cliService.getWorkspaceReviewSummary(request.workspaceDir) as Promise<WebuiWorkspaceReviewSummary>;
    },
    async listWorkspaceReviewFileDiffs(request) {
      const cliService = requireCliService(host);
      if (!cliService.listWorkspaceReviewFileDiffs) throw new Error("runtime host does not expose Workspace review file diffs");
      return cliService.listWorkspaceReviewFileDiffs({ ...request, fileIds: [...request.fileIds] }) as Promise<WebuiWorkspaceReviewDiffs>;
    },
    async getWorkspaceReviewFileContent(request) {
      const cliService = requireCliService(host);
      if (!cliService.getWorkspaceReviewFileContent) throw new Error("runtime host does not expose Workspace review file content");
      return cliService.getWorkspaceReviewFileContent(request) as Promise<WebuiWorkspaceReviewFileContent>;
    },
    async searchWorkspaceReviewDiffs(request) {
      const cliService = requireCliService(host);
      if (!cliService.searchWorkspaceReviewDiffs) throw new Error("runtime host does not expose Workspace review search");
      return cliService.searchWorkspaceReviewDiffs(request) as Promise<WebuiWorkspaceReviewSearchResult>;
    },
    async readCanvas(request) {
      return requireCliService(host).readCanvas!(request) as Promise<WebuiCanvasDocument>;
    },
    async applyCanvas(request) {
      return requireCliService(host).applyCanvas!(request as never) as Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
    },
    async sendMessage(request, signal) {
      return requireCliService(host).sendMessage(request, signal ? { signal } : {});
    },
    async enqueueMessage(request) {
      return requireCliService(host).enqueueMessage(request, {});
    },
    async resumeSession(request, signal) {
      return requireCliService(host).resumeSession(request, signal ? { signal } : {});
    },
    watchEvents(signal) {
      return requireCliService(host).watchEvents(signal);
    },
    async listPendingPermissions() {
      return requireCliService(host).listPendingPermissions();
    },
    async getPendingQuestionnaire(request) {
      const service = requireCliService(host);
      const first = await service.getPendingQuestionnaire(request);
      if (first.request || !request.sessionId) return first;
      // The runtime keys pending interactions by the agent that OWNS the
      // session, but `listSessions` / `getSessionTree` echo back the `name`
      // they were queried with rather than the session's real agent — so the
      // same session lists under both "main" and "mavis" with whichever name
      // was passed, and a client that trusts that echo asks the wrong agent's
      // queue and reads a well-formed empty response as "nothing pending".
      // That is exactly how the plan card went missing: plan mode is raised by
      // the chat agent, and this client asks under the default agent name.
      // Resolve the authoritative name through `getSession`, which does return
      // it, and ask once more. Reached only on an empty result, and a second
      // empty result is still reported as empty rather than papered over.
      const resolved = await service.getSession({ id: request.sessionId }, {});
      const agentName = resolved.session?.agentName;
      if (!agentName || agentName === request.name) return first;
      return service.getPendingQuestionnaire({
        name: agentName,
        sessionId: request.sessionId,
      });
    },
    async replyPermission(request) {
      return requireCliService(host).replyPermission({
        name: request.name,
        requestId: request.requestId,
        reply: permissionReplyValue(request.reply),
      });
    },
    async replyQuestionnaire(request) {
      return requireCliService(host).replyQuestionnaire(request);
    },
    async dismissQuestionnaire(request) {
      return requireCliService(host).dismissQuestionnaire(request);
    },
    async abortSession(request) {
      return requireCliService(host).abortSession(request);
    },
    async listQueueMessages(request) {
      return requireCliService(host).listQueueMessages(request);
    },
    async deleteQueueItem(request) {
      return requireCliService(host).deleteQueueItem(request);
    },
    async listModels(request) {
      return requireCliService(host).listModels(request);
    },
    async selectModel(request) {
      return requireCliService(host).selectModel(request);
    },
    async listSkills(request) {
      // cliService.listSkills returns the full `SkillInfo[]` shape; map it
      // down to the WebUI's minimal projection. `displayDescription` and
      // i18n keys win over the raw `description` so the popover matches the
      // desktop's translated copy.
      const result = await requireCliService(host).listSkills(request ?? {});
      return {
        skills: result.skills.map((skill) => ({
          name: skill.name,
          displayName: skill.displayName ?? skill.name,
          description:
            skill.displayDescription ?? skill.description ?? "",
        })),
      };
    },
    async pluginManagement(request) {
      return requireCliService(host).pluginManagement(request);
    },
    async getPermissionMode() {
      return requireCliService(host).getPermissionMode();
    },
    async setPermissionMode(request) {
      return requireCliService(host).setPermissionMode(request);
    },
    async getGlobalInstructions() {
      return readGlobalInstructions(requireDataDir(host));
    },
    async setGlobalInstructions(request) {
      return writeGlobalInstructions(requireDataDir(host), request.content);
    },
    async getAgentMemory(request) {
      return readAgentMemory(
        requireDataDir(host),
        WEBUI_DEFAULT_AGENT_NAME,
        { includeContent: request?.includeContent === true },
      );
    },
    async setAgentMemory(request) {
      return writeAgentMemory(
        requireDataDir(host),
        WEBUI_DEFAULT_AGENT_NAME,
        request.content,
      );
    },
    async getUserProfile() {
      return readUserProfile(requireDataDir(host));
    },
    async setUserProfile(request) {
      return writeUserProfile(requireDataDir(host), {
        nickname: request.nickname,
        occupation: request.occupation,
        moreAbout: request.moreAbout,
      });
    },
    async getMemorySettings() {
      return requireMemorySettings(host).get();
    },
    async setMemorySettings(request) {
      return requireMemorySettings(host).set(request);
    },
    async getSessionUsage(request) {
      return requireCliService(host).getSessionUsage(request);
    },
    async getUsageQuota(request) {
      if (!host.getUsageQuota)
        throw new Error("runtime host does not expose the usage quota client");
      return host.getUsageQuota(request ?? {});
    },
    async getSigninPanel() {
      if (!host.getSigninPanel)
        throw new Error("runtime host does not expose the daily check-in client");
      return host.getSigninPanel();
    },
    async claimSignin() {
      if (!host.claimSignin)
        throw new Error("runtime host does not expose the daily check-in client");
      return host.claimSignin();
    },
    async beginAccountLogin() {
      if (!host.beginAccountLogin)
        throw new Error("runtime host does not expose account login");
      return host.beginAccountLogin();
    },
    async getAccountLoginStatus() {
      if (!host.getAccountLoginStatus)
        throw new Error("runtime host does not expose account login");
      return host.getAccountLoginStatus();
    },
    async cancelAccountLogin() {
      if (!host.cancelAccountLogin)
        throw new Error("runtime host does not expose account login");
      await host.cancelAccountLogin();
      return { ok: true as const };
    },
    async signOutAccount() {
      if (!host.signOutAccount)
        throw new Error("runtime host does not expose account sign-out");
      return host.signOutAccount();
    },
    async getAccountStatus(request) {
      return requireCliService(host).getAccountStatus(request);
    },
    async listUserModelProviders() {
      return requireCliService(host).listUserModelProviders();
    },
    async createUserModelProvider(request) {
      return requireCliService(host).createUserModelProvider(request);
    },
    async updateUserModelProvider(request) {
      return requireCliService(host).updateUserModelProvider(request);
    },
    async deleteUserModelProvider(providerId) {
      return requireCliService(host).deleteUserModelProvider({ providerId });
    },
    async testUserModelProvider(request) {
      return requireCliService(host).testUserModelProvider(request);
    },
    async getMiniMaxModelSource() { return requireCliService(host).getMiniMaxModelSource(); },
    async setMiniMaxModelSource(request) { return requireCliService(host).setMiniMaxModelSource(request); },
    async testUserModelCandidate(request) { return requireCliService(host).testUserModelCandidate(request); },
    async revealModelProviderApiKey(request) { return requireCliService(host).revealModelProviderApiKey(request); },
    async startCodexOAuthLogin(request) { return requireCliService(host).startCodexOAuthLogin(request); },
    async cancelCodexOAuthLogin(request) { return requireCliService(host).cancelCodexOAuthLogin(request); },
    async refreshModels() { return requireCliService(host).refreshModels(); },
    async testUserModel(request) {
      return requireCliService(host).testUserModel({ providerId: request.providerId, modelId: request.modelId });
    },
    async discoverUserModelsCandidate(request) {
      return requireCliService(host).discoverUserModelsCandidate(request);
    },
    async saveUserModelProviderCandidate(request) {
      return requireCliService(host).saveUserModelProviderCandidate(request);
    },
    async listProviderPresets() {
      return requireCliService(host).listProviderPresets();
    },
    async getMiniMaxApiKeyStatus() {
      return requireCliService(host).getMiniMaxApiKeyStatus();
    },
    async upsertMiniMaxApiKey(request) {
      return requireCliService(host).upsertMiniMaxApiKey(request);
    },
    async getCodexOAuthStatus() {
      return requireCliService(host).getCodexOAuthStatus();
    },
    async requestCompaction(request) {
      // `cliService.requestCompaction` is optional on the harness. The
      // outer `cliService` guard stays even though the rest of the harness
      // port now goes through `requireCliService`: this is the one method
      // that the runner explicitly drives, so the failure message has to
      // be specific (the `/compact` slash command tells the user the host
      // does not support conversation compaction; folding the two errors
      // into one would only mention the CLI service).
      if (!host.cliService)
        throw new Error("runtime host does not expose the CLI service");
      if (!host.cliService.requestCompaction)
        throw new Error("runtime host does not expose requestCompaction");
      return host.cliService.requestCompaction(request);
    },
    async close() {
      if (closed) return;
      closed = true;
      await host.apiHost.close();
    },
  };
}

/**
 * Resolve the runtime host's `cliService` slot. Every harness port method
 * that has no equivalent on the auth/quota/check-in side flows through this
 * helper so the failure message is the same as it was before the batch-C
 * seam work.
 */
/**
 * Resolve the host's scheduled-task runtime, or fail closed. The message is
 * the one the capability probe reports, so a client that asked first and a
 * client that called blind see the same reason.
 */
function requireScheduledTasks(
  host: WebuiRuntimeHostHandle,
): WebuiScheduledTaskRuntime {
  const runtime = host.scheduledTasks;
  if (!runtime)
    throw new Error(
      "scheduled tasks are not available: this host exposes no scheduled-task runtime",
    );
  return runtime;
}

function requireCliService(host: WebuiRuntimeHostHandle): WebuiRuntimeCliService {
  if (!host.cliService)
    throw new Error("runtime host does not expose the CLI service");
  return host.cliService;
}

function requireDataDir(host: WebuiRuntimeHostHandle): string {
  if (!host.dataDir)
    throw new Error("runtime host does not expose a data directory");
  return host.dataDir;
}

/**
 * The memory switches reach the shared config through the runtime's own
 * `configuration` capability, so the whitelist and the mask hazard stay where
 * they already live — the WebUI only forwards two booleans.
 */
function requireMemorySettings(host: WebuiRuntimeHostHandle): {
  get(): Promise<WebuiMemorySettingsView>;
  set(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<WebuiMemorySettingsView>;
} {
  const cliService = requireCliService(host);
  const { getMemorySettings, setMemorySettings } = cliService;
  if (!getMemorySettings || !setMemorySettings)
    throw new Error("runtime host does not expose memory settings");
  return {
    get: () => getMemorySettings.call(cliService),
    set: (request) => setMemorySettings.call(cliService, request),
  };
}

function permissionReplyValue(reply: WebuiPermissionDecision): number {
  switch (reply) {
    case "allowOnce":
      return 0;
    case "allowAlways":
      return 1;
    case "deny":
      return 2;
  }
}
