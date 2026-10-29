import type {
  SessionLookupInput as GetSessionReq,
  SessionLookupResult as GetSessionResp,
  SessionTreeInput as GetSessionTreeReq,
  SessionTreePage as GetSessionTreeResp,
  ListSessionsInput as ListSessionsReq,
  SessionPage as ListSessionsResp,
} from "../application/session/query-contract.js";
import type {
  AbortSessionInput as AbortSessionReq,
  AbortSessionResult as AbortSessionResp,
  ArchiveSessionInput as ArchiveSessionReq,
  ArchiveSessionResult as ArchiveSessionResp,
  CreateSessionInput as CreateSessionReq,
  CreateSessionResult as CreateSessionResp,
  DeleteSessionInput as DeleteSessionReq,
  DeleteSessionResult as DeleteSessionResp,
  DeleteQueueItemInput as DeleteQueueItemReq,
  DeleteQueueItemResult as DeleteQueueItemResp,
  EditSessionMessageInput as EditSessionMessageReq,
  EditSessionMessageResult as EditSessionMessageResp,
  EnqueueMessageInput as EnqueueMessageReq,
  EnqueueMessageResult as EnqueueMessageResp,
  ForkSessionInput as ForkSessionReq,
  ForkSessionResult as ForkSessionResp,
  GetLatestPlanReviewInput as GetLatestPlanReviewReq,
  GetMessagesInput as GetMessagesReq,
  GetMessagesResult as GetMessagesResp,
  GetSessionDiffInput as GetSessionDiffReq,
  GetSessionDiffResult as GetSessionDiffResp,
  GetTurnDiffInput as GetTurnDiffReq,
  GetTurnDiffResult as GetTurnDiffResp,
  GetQuestionnaireResult as GetQuestionnaireResp,
  GetPendingQuestionnaireInput as GetPendingQuestionnaireReq,
  GetPendingQuestionnaireResult as GetPendingQuestionnaireResp,
  GetPeekContextInput as GetPeekContextReq,
  GetPeekContextResult as GetPeekContextResp,
  GetQueueItemInput as GetQueueItemReq,
  GetQueueItemResult as GetQueueItemResp,
  GetSessionForkOptionsInput as GetSessionForkOptionsReq,
  GetSessionForkOptionsResult as GetSessionForkOptionsResp,
  GetSessionUsageInput as GetSessionUsageReq,
  GetSessionUsageResult as GetSessionUsageResp,
  SessionTokenUsageSummaryView,
  GetSessionRewindPreviewInput as GetSessionRewindPreviewReq,
  GetSessionRewindPreviewResult as GetSessionRewindPreviewResp,
  ListSessionInputSummariesInput as ListSessionInputSummariesReq,
  ListSessionInputSummariesResult as ListSessionInputSummariesResp,
  ListQueueMessagesInput as ListQueueMessagesReq,
  ListQueueMessagesResult as ListQueueMessagesResp,
  ListPendingPermissionsInput as ListPendingPermissionsReq,
  ListPendingPermissionsResult as ListPendingPermissionsResp,
  ListInstalledPluginsInput as ListInstalledPluginsReq,
  ListInstalledPluginsResult as ListInstalledPluginsResp,
  ListMarketplacePluginsInput as ListMarketplacePluginsReq,
  ListMarketplacePluginsResult as ListMarketplacePluginsResp,
  ReorderQueueInput as ReorderQueueReq,
  ReorderQueueResult as ReorderQueueResp,
  RewindSessionInput as RewindSessionReq,
  RewindSessionResult as RewindSessionResp,
  RevertTurnDiffInput as RevertTurnDiffReq,
  RevertTurnDiffResult as RevertTurnDiffResp,
  ReapplyTurnDiffInput as ReapplyTurnDiffReq,
  ReapplyTurnDiffResult as ReapplyTurnDiffResp,
  RequestCompactionInput as RequestCompactionReq,
  RequestCompactionResult as RequestCompactionResp,
  MutatePluginInput as MutatePluginReq,
  MutatePluginResult as MutatePluginResp,
  ReplyPermissionInput as ReplyPermissionReq,
  ReplyPermissionResult as ReplyPermissionResp,
  ReplyQuestionnaireInput as ReplyQuestionnaireReq,
  ReplyQuestionnaireResult as ReplyQuestionnaireResp,
  DismissQuestionnaireInput as DismissQuestionnaireReq,
  DismissQuestionnaireResult as DismissQuestionnaireResp,
  ResumeSessionInput as ResumeSessionReq,
  SteerSessionInput as SteerSessionReq,
  SteerSessionResult as SteerSessionResp,
  SessionStreamErrorBody,
  SessionStreamFrameView,
  UpdateQueueItemInput as UpdateQueueItemReq,
  UpdateQueueItemResult as UpdateQueueItemResp,
  UpdateSessionInput as UpdateSessionReq,
  UpdateSessionResult as UpdateSessionResp,
} from "@mavis/protocol/local";
import {
  PermissionReply,
  QuestionnairePurpose,
  QuestionnaireSelectionMode,
  QuestionnaireStatus,
} from "@mavis/protocol/local";
import type { ConversationSteerInput } from "@mavis/conversation-contract";
import type {
  ProcessLocalContext,
  ProcessLocalStreamResult,
} from "@mavis/conversation-contract";

import type {
  ConversationApplication,
  ConversationSendMessageRequest,
  ConversationSendOptions,
} from "../application/conversation/conversation-application.js";
import type { RuntimeApplications } from "../application/initialize.js";
import type {
  ImportSessionTransferRequest as ImportSessionTransferReq,
  ImportSessionTransferResult as ImportSessionTransferResp,
  SessionTransferFile,
} from "../application/session/transfer-application.js";
import type { LocalRuntimeApplication } from "../application/session/process-local-application-contract.js";
import type {
  CreateCronDefinitionCommand,
  CronDefinitionView,
  CronPage,
  CronRunView,
  CronService,
  DeleteCronDefinitionCommand,
  ListCronDefinitionsQuery,
  ListCronRunsQuery,
  UpdateCronDefinitionCommand,
} from "../service/cron/index.js";
import type { CliManagementApplication } from "../application/cli-management-application.js";

export interface CliServiceOptions {
  readonly applications: RuntimeApplications;
  readonly application: LocalRuntimeApplication;
  readonly conversation: ConversationApplication;
  readonly management: CliManagementApplication;
  /**
   * The v2 Cron service.
   *
   * Absent on a host composed without an owned Scheduler, which is why every cron member below
   * fails closed with one message instead of assuming it. The WebUI reaches scheduled tasks
   * through this member and never through cron orchestration.
   */
  readonly cron?: CronService;
}

export type CliSendMessageReq = ConversationSendMessageRequest;
export type CliSendMessageOptions = ConversationSendOptions;

/** The runtime's Mini App Agent application, named once so the facade's signatures derive from it. */
type MiniAppAgentCapability = NonNullable<LocalRuntimeApplication["miniAppAgent"]>;

/** In-process CLI entry point: call local Application directly, without HTTP or RPC envelopes. */
export class CliService {
  constructor(private readonly options: CliServiceOptions) {}

  listSessions(
    req: ListSessionsReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ListSessionsResp> {
    return this.options.applications.session.query.listSessions(ctx, req);
  }

  listVisibleProjects(limit = 100) {
    return this.options.applications.session.query.listVisibleProjects(limit);
  }

  createSession(
    req: CreateSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<CreateSessionResp> {
    if (req.workspaceDir?.trim()) {
      return this.options.applications.session.lifecycle.createExplicitWorkspaceSession(
        ctx,
        req,
      );
    }
    return this.options.applications.session.lifecycle.createSession(ctx, req);
  }

  configureSessionMcpServers(
    req: Parameters<
      NonNullable<LocalRuntimeApplication["mcp"]>["configureSessionServers"]
    >[0],
  ): Promise<void> {
    return this.requireCapability("mcp", "MCP").configureSessionServers(req);
  }

  async inspectProjectMcp(sessionId: string) {
    return this.requireCapability("mcp", "MCP").inspectProjectMcp(
      await this.projectMcpContext(sessionId),
    );
  }

  private async projectMcpContext(sessionId: string) {
    const result = await this.getSession({ id: sessionId });
    const workspaceRoot = result.session?.workspaceDir;
    if (!workspaceRoot)
      throw new Error("Session has no workspace for project MCP.");
    return { sessionId, workspaceRoot };
  }

  /** The Mini App listing the catalogue and the picker both read. */
  listMiniApps() {
    return this.requireCapability("miniApps", "Mini App").list();
  }

  /**
   * Every installed Mini App, enabled or not.
   *
   * The management read: `listMiniApps` answers what this host can start, and a
   * disabled package is installed but not startable. A surface that shows the
   * installed set — and offers to enable one of them — needs this one.
   */
  listInstalledMiniApps() {
    return this.requireCapability("miniApps", "Mini App").listInstalled();
  }

  /**
   * Starts a Mini App and, when this host has a presenter, shows it. A forwarding call only: the
   * application owns the lifecycle, and `launch` is server-only coordinates the caller must not forward
   * to a renderer.
   */
  openMiniApp(input: { readonly pluginId: string; readonly signal?: AbortSignal }) {
    return this.requireCapability("miniApps", "Mini App").open(input);
  }

  stopMiniApp(input: { readonly pluginId: string; readonly signal?: AbortSignal }) {
    return this.requireCapability("miniApps", "Mini App").stop(input);
  }

  /**
   * The Mini App Agent API, as the page bridge's host half reaches it.
   *
   * A forwarding facade only: the application (`miniAppAgent`) already owns arena policy,
   * per-plugin concurrency, session ownership and the turn algorithm, and every one of these
   * methods is one call into it. What the caller must not do is spell identity — `caller` is the
   * `{ pluginId, runId, hostSessionId }` the Host resolved from the view it framed, and `runId` is
   * the launch's own process generation, because that is what the registered arena is keyed on.
   *
   * The refusal is the runtime's own `MiniAppAgentError`; mapping it to a renderer-safe failure
   * code belongs to the layer that speaks to a page, not here.
   */
  private miniAppAgent() {
    return this.requireCapability("miniAppAgent", "Mini App Agent");
  }

  /** One `run` turn. Events arrive only when the caller passes `onEvent`. */
  runMiniAppAgentTurn(input: Parameters<MiniAppAgentCapability["run"]>[0]) {
    return this.miniAppAgent().run(input);
  }

  /** The continuation turn a questionnaire answer starts; followed like `run`. */
  answerMiniAppAgentQuestion(input: Parameters<MiniAppAgentCapability["answer"]>[0]) {
    return this.miniAppAgent().answer(input);
  }

  /** Decides one pending permission ask: `allowOnce` or `deny`, never a global rule. */
  replyMiniAppAgentPermission(input: Parameters<MiniAppAgentCapability["reply"]>[0]) {
    return this.miniAppAgent().reply(input);
  }

  /** Ownership check for showing one of the plugin's sessions in the host's chat surface. */
  openMiniAppAgentSession(input: Parameters<MiniAppAgentCapability["open"]>[0]) {
    return this.miniAppAgent().open(input);
  }

  /** The host's UI now shows that session, so its asks are answerable. Idempotent. */
  panelOpenedMiniAppAgentSession(
    input: Parameters<MiniAppAgentCapability["panelOpened"]>[0],
  ) {
    return this.miniAppAgent().panelOpened(input);
  }

  /** The host's UI stopped showing it. Idempotent. */
  panelClosedMiniAppAgentSession(
    input: Parameters<MiniAppAgentCapability["panelClosed"]>[0],
  ) {
    return this.miniAppAgent().panelClosed(input);
  }

  /** The enabled models a run may switch to, the default, and a page's host model. */
  listMiniAppAgentModels(input: Parameters<MiniAppAgentCapability["models"]>[0]) {
    return this.miniAppAgent().models(input);
  }

  /** The agents a new Mini App session may be created for. */
  listMiniAppAgentAgents(input: Parameters<MiniAppAgentCapability["agents"]>[0]) {
    return this.miniAppAgent().agents(input);
  }

  listMiniAppAgentSessions(input: Parameters<MiniAppAgentCapability["sessions"]>[0]) {
    return this.miniAppAgent().sessions(input);
  }

  readMiniAppAgentSession(input: Parameters<MiniAppAgentCapability["session"]>[0]) {
    return this.miniAppAgent().session(input);
  }

  /** A session without a turn; `runMiniAppAgentTurn({ sessionId })` continues it. */
  createMiniAppAgentSession(input: Parameters<MiniAppAgentCapability["create"]>[0]) {
    return this.miniAppAgent().create(input);
  }

  clearSessionMcpServers(sessionId: string): Promise<void> {
    return this.requireCapability("mcp", "MCP").clearSessionServers(sessionId);
  }

  getSession(
    req: GetSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionResp> {
    return this.options.applications.session.query.getSession(ctx, req);
  }

  getSessionTree(
    req: GetSessionTreeReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionTreeResp> {
    return this.options.applications.session.query.getSessionTree(ctx, req);
  }

  updateSession(
    req: UpdateSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<UpdateSessionResp> {
    return this.options.applications.session.lifecycle.updateSession(ctx, req);
  }

  archiveSession(
    req: ArchiveSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ArchiveSessionResp> {
    return this.options.applications.session.lifecycle.archiveSession(ctx, req);
  }

  async deleteSession(
    req: DeleteSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<DeleteSessionResp> {
    return this.options.applications.session.lifecycle.deleteSession(ctx, req);
  }

  getMessages(
    req: GetMessagesReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetMessagesResp> {
    return this.options.applications.session.content.getMessages(ctx, req);
  }

  getSessionDiff(
    req: GetSessionDiffReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionDiffResp> {
    return this.options.applications.session.diff.getSessionDiff(ctx, req);
  }

  getTurnDiff(
    req: GetTurnDiffReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetTurnDiffResp> {
    return this.options.applications.session.diff.getTurnDiff(ctx, req);
  }

  revertTurnDiff(
    req: RevertTurnDiffReq,
    ctx: ProcessLocalContext = {},
  ): Promise<RevertTurnDiffResp> {
    return this.options.applications.session.diff.revertTurnDiff(ctx, req);
  }

  reapplyTurnDiff(
    req: ReapplyTurnDiffReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ReapplyTurnDiffResp> {
    return this.options.applications.session.diff.reapplyTurnDiff(ctx, req);
  }

  listSessionInputSummaries(
    req: ListSessionInputSummariesReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ListSessionInputSummariesResp> {
    return this.options.applications.session.content.listSessionInputSummaries(
      ctx,
      req,
    );
  }

  getSessionForkOptions(
    req: GetSessionForkOptionsReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionForkOptionsResp> {
    return this.options.applications.session.conversationMutation.getSessionForkOptions(
      ctx,
      req,
    );
  }

  forkSession(
    req: ForkSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ForkSessionResp> {
    return this.options.applications.session.conversationMutation.forkSession(
      ctx,
      req,
    );
  }

  /**
   * Both storage layers of a session, in a form `importSessionTransfer` can
   * read back. Not the same thing as `getMessages`: that one returns a view
   * prepared for rendering, which drops the canonical receipts on compaction
   * and fork-origin rows.
   */
  exportSessionTransfer(sessionId: string): Promise<SessionTransferFile> {
    return this.options.applications.session.transfer.read(sessionId);
  }

  importSessionTransfer(
    req: ImportSessionTransferReq,
  ): Promise<ImportSessionTransferResp> {
    return this.options.applications.session.transfer.write(req);
  }

  getSessionRewindPreview(
    req: GetSessionRewindPreviewReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionRewindPreviewResp> {
    return this.options.applications.session.conversationMutation.getSessionRewindPreview(
      ctx,
      req,
    );
  }

  rewindSession(
    req: RewindSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<RewindSessionResp> {
    return this.options.applications.session.conversationMutation.rewindSession(
      ctx,
      req,
    );
  }

  editSessionMessage(
    req: EditSessionMessageReq,
    ctx: ProcessLocalContext = {},
  ): Promise<EditSessionMessageResp> {
    return this.options.applications.session.conversationMutation.editSessionMessage(
      ctx,
      req,
    );
  }

  getSessionUsage(
    req: GetSessionUsageReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetSessionUsageResp> {
    return this.options.applications.session.content.getSessionUsage(ctx, req);
  }

  getSessionUsageSummary(
    req: GetSessionUsageReq,
    ctx: ProcessLocalContext = {},
  ): Promise<SessionTokenUsageSummaryView> {
    return this.options.applications.session.content.getSessionUsageSummary(
      ctx,
      req,
    );
  }

  getPeekContext(
    req: GetPeekContextReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetPeekContextResp> {
    return this.options.applications.session.content.getPeekContext(ctx, req);
  }

  sendMessage(
    req: CliSendMessageReq,
    ctx: ProcessLocalContext = {},
    options?: CliSendMessageOptions,
  ): Promise<
    ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
  > {
    return options
      ? this.options.conversation.sendMessage(ctx, req, options)
      : this.options.conversation.sendMessage(ctx, req);
  }

  resumeSession(
    req: ResumeSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<
    ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
  > {
    return this.options.conversation.resumeSession(ctx, req);
  }

  abortSession(
    req: AbortSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<AbortSessionResp> {
    return this.options.conversation.abortSession(ctx, req);
  }

  steerSession(
    req: SteerSessionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<SteerSessionResp> {
    return this.options.conversation.steerSession(ctx, req);
  }

  enqueueMessage(
    req: EnqueueMessageReq,
    ctx: ProcessLocalContext = {},
  ): Promise<EnqueueMessageResp> {
    return this.options.conversation.enqueueMessage(ctx, req);
  }

  requestCompaction(
    req: RequestCompactionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<RequestCompactionResp> {
    return this.options.conversation.requestCompaction(ctx, req);
  }

  async getPendingQuestionnaire(
    req: GetPendingQuestionnaireReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetPendingQuestionnaireResp> {
    void ctx;
    const questionnaires = this.requireQuestionnaires();
    const request = await questionnaires.getPending({
      agentName: req.name,
      sessionId: req.sessionId,
    });
    return request ? { request: toQuestionnaireRequestView(request) } : {};
  }

  async getLatestPlanReview(
    req: GetLatestPlanReviewReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetQuestionnaireResp> {
    void ctx;
    const request = await this.requireQuestionnaires().getLatestPlanReview({
      agentName: req.name,
      sessionId: req.sessionId,
    });
    return request ? { request: toQuestionnaireRequestView(request) } : {};
  }

  getPlanModeCapabilities(): { readonly entryEnabled: boolean } {
    return {
      entryEnabled: this.requireCapability("plan", "Plan").isEntryEnabled(),
    };
  }

  async replyQuestionnaire(
    req: ReplyQuestionnaireReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ReplyQuestionnaireResp> {
    void ctx;
    return this.requireQuestionnaires().reply({
      agentName: req.name,
      requestId: req.requestId,
      answers: req.answers.map((answer) => ({
        stepId: answer.stepId,
        selectedOptionIds: answer.selectedOptionIds ?? [],
        selectedOther: answer.selectedOther === true,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        ...(answer.skipped === true ? { skipped: true } : {}),
      })),
      submittedAt: req.submittedAt ?? Date.now(),
    });
  }

  dismissQuestionnaire(
    req: DismissQuestionnaireReq,
    ctx: ProcessLocalContext = {},
  ): Promise<DismissQuestionnaireResp> {
    void ctx;
    return this.requireQuestionnaires().dismiss({
      agentName: req.name,
      requestId: req.requestId,
    });
  }

  async listPendingPermissions(
    req: ListPendingPermissionsReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ListPendingPermissionsResp> {
    void req;
    void ctx;
    const requests = await this.requirePermissions().listPending();
    return {
      requests: requests.map((request) => ({
        requestId: request.requestId,
        sessionId: request.sessionId,
        agentName: request.agentName,
        toolName: request.toolName,
        ruleContents: [...request.ruleContents],
        ...(request.toolInput !== undefined
          ? { toolInput: request.toolInput }
          : {}),
        ...(request.toolDescription !== undefined
          ? { toolDescription: request.toolDescription }
          : {}),
        reason: request.reason,
        allowAlwaysSupported: request.allowAlwaysSupported,
        createdAt: request.createdAt,
      })),
    };
  }

  async replyPermission(
    req: ReplyPermissionReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ReplyPermissionResp> {
    void ctx;
    const result = await this.requirePermissions().reply({
      requestIds: [req.requestId],
      decision: toPermissionDecision(req.reply),
    });
    return { success: result.processed.includes(req.requestId) };
  }

  listQueueMessages(
    req: ListQueueMessagesReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ListQueueMessagesResp> {
    return this.options.applications.queue.listQueueMessages(ctx, req);
  }

  getQueueItem(
    req: GetQueueItemReq,
    ctx: ProcessLocalContext = {},
  ): Promise<GetQueueItemResp> {
    return this.options.applications.queue.getQueueItem(ctx, req);
  }

  updateQueueItem(
    req: UpdateQueueItemReq,
    ctx: ProcessLocalContext = {},
  ): Promise<UpdateQueueItemResp> {
    return this.options.applications.queue.updateQueueItem(ctx, req);
  }

  reorderQueue(
    req: ReorderQueueReq,
    ctx: ProcessLocalContext = {},
  ): Promise<ReorderQueueResp> {
    return this.options.applications.queue.reorderQueue(ctx, req);
  }

  deleteQueueItem(
    req: DeleteQueueItemReq,
    ctx: ProcessLocalContext = {},
  ): Promise<DeleteQueueItemResp> {
    return this.options.applications.queue.deleteQueueItem(ctx, req);
  }

  steer(input: ConversationSteerInput) {
    return this.options.conversation.steer(input);
  }

  getActiveTurn(sessionId: string) {
    return this.options.conversation.getActiveTurn(sessionId);
  }

  watchEvents(signal?: AbortSignal) {
    return this.options.application.events.watch(signal);
  }

  watchSessionUsageCommits(signal?: AbortSignal): AsyncGenerator<string> {
    return this.requireCapability("usage", "Usage").watchCommits(signal);
  }

  isGoalEnabled(): boolean {
    return this.requireCapability("goals", "Goal").isEnabled();
  }

  getGoal(sessionId: string) {
    return this.requireCapability("goals", "Goal").get(sessionId);
  }

  createGoal(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["goals"]>["create"]
    >[0],
  ) {
    return this.requireCapability("goals", "Goal").create(input);
  }

  patchGoal(
    sessionId: string,
    patch: Parameters<
      NonNullable<LocalRuntimeApplication["goals"]>["patch"]
    >[1],
  ) {
    return this.requireCapability("goals", "Goal").patch(sessionId, patch);
  }

  clearGoal(sessionId: string) {
    return this.requireCapability("goals", "Goal").clear(sessionId);
  }

  getWorkspaceGitMetadata(workspaceDir: string) {
    return this.requireCapability("workspace", "Workspace").git.getMetadata(
      workspaceDir,
    );
  }

  getWorkspaceReviewSummary(workspaceDir: string) {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (!git.getReviewSummary)
      throw new Error("Runtime does not expose Workspace review summaries.");
    return git.getReviewSummary(workspaceDir, { type: "workspace" });
  }

  listWorkspaceReviewFileDiffs(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    fileIds?: string[];
  }) {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (!git.listReviewFileDiffs)
      throw new Error("Runtime does not expose Workspace review file diffs.");
    return git.listReviewFileDiffs(
      input.workspaceDir,
      { type: "workspace" },
      {
        reviewSnapshotId: input.reviewSnapshotId,
        ...(input.fileIds ? { fileIds: input.fileIds } : {}),
      },
    );
  }

  getWorkspaceReviewFileContent(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    fileId: string;
    side: "old" | "new";
  }) {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (!git.getReviewFileContent)
      throw new Error("Runtime does not expose Workspace review file content.");
    return git.getReviewFileContent(
      input.workspaceDir,
      { type: "workspace" },
      {
        reviewSnapshotId: input.reviewSnapshotId,
        fileId: input.fileId,
        side: input.side,
      },
    );
  }

  searchWorkspaceReviewDiffs(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    query: string;
    includeUntrackedFiles: boolean;
    pageIndex?: number;
    pageSize?: number;
  }) {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (!git.searchReviewDiffs)
      throw new Error("Runtime does not expose Workspace review search.");
    return git.searchReviewDiffs(
      input.workspaceDir,
      { type: "workspace" },
      {
        reviewSnapshotId: input.reviewSnapshotId,
        query: input.query,
        includeUntrackedFiles: input.includeUntrackedFiles,
        ...(input.pageIndex !== undefined
          ? { pageIndex: input.pageIndex }
          : {}),
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      },
    );
  }

  async getWorkspaceGitEnvironment(workspaceDir: string) {
    const git = this.requireCapability("workspace", "Workspace").git;
    const [metadata, changes] = await Promise.all([
      git.getMetadata(workspaceDir),
      git.getChanges
        ? git.getChanges(workspaceDir, "full")
        : Promise.resolve({ isGitRepo: false }),
    ]);
    return { metadata, changes };
  }

  mutateWorkspaceGit(input: {
    workspaceDir: string;
    action: "commit" | "commitAndPush" | "push";
    message?: string;
  }) {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (input.action === "push") {
      if (!git.push)
        throw new Error("Runtime does not expose Workspace git push.");
      return git.push(input.workspaceDir);
    }
    if (!input.message?.trim())
      throw new Error("A commit message is required.");
    if (input.action === "commitAndPush") {
      if (!git.commitAndPush)
        throw new Error("Runtime does not expose Workspace git commitAndPush.");
      return git.commitAndPush(input.workspaceDir, input.message.trim(), true);
    }
    if (!git.commit)
      throw new Error("Runtime does not expose Workspace git commit.");
    return git.commit(input.workspaceDir, input.message.trim(), true);
  }

  /**
   * Reads the review link recorded for a workspace branch.
   *
   * Resolves to `undefined` when the runtime predates the capability, so a
   * caller can treat "not supported" and "nothing recorded" alike — both mean
   * there is no review to show.
   */
  getWorkspaceReviewLink(
    workspaceDir: string,
    branch: string,
  ): Promise<Record<string, unknown> | undefined> {
    const git = this.requireCapability("workspace", "Workspace").git;
    if (!git.getReviewLink) return Promise.resolve(undefined);
    return git.getReviewLink(workspaceDir, branch);
  }

  listWorkspaceFileTree(
    input: Parameters<
      NonNullable<
        NonNullable<LocalRuntimeApplication["workspace"]>["listFileTree"]
      >
    >[0],
  ) {
    const listFileTree = this.requireCapability(
      "workspace",
      "Workspace",
    ).listFileTree;
    if (!listFileTree)
      throw new Error("Runtime does not expose Workspace file-tree reads.");
    return listFileTree(input);
  }

  searchWorkspaceFiles(
    input: Parameters<
      NonNullable<
        NonNullable<LocalRuntimeApplication["workspace"]>["searchFiles"]
      >
    >[0],
  ) {
    const searchFiles = this.requireCapability(
      "workspace",
      "Workspace",
    ).searchFiles;
    if (!searchFiles)
      throw new Error("Runtime does not expose Workspace file search.");
    return searchFiles(input);
  }

  readWorkspaceFile(input: { workspaceDir: string; path: string }) {
    return this.options.management.readWorkspaceFile(input);
  }

  readCanvas(input: { sessionId: string }) {
    return this.options.management.readCanvas(input);
  }

  applyCanvas(input: Parameters<CliManagementApplication["applyCanvas"]>[0]) {
    return this.options.management.applyCanvas(input);
  }

  getAccountStatus(
    input?: Parameters<
      NonNullable<LocalRuntimeApplication["account"]>["getStatus"]
    >[0],
  ) {
    return this.requireCapability("account", "Account").getStatus(input);
  }

  getRuntimeDiagnostics() {
    return this.requireCapability(
      "diagnostics",
      "Diagnostics",
    ).getRuntimeSnapshot();
  }

  collectSessionReport(sessionId: string) {
    const diagnostics = this.requireCapability("diagnostics", "Diagnostics");
    if (!diagnostics.collectSessionReport) {
      throw new Error("Runtime does not expose Session report diagnostics.");
    }
    return diagnostics.collectSessionReport(sessionId);
  }

  getInstructionSources(input: { workspaceDir: string }) {
    return this.requireCapability("instructions", "Instructions").listSources(
      input,
    );
  }

  refreshPlugins(): Promise<void> {
    return this.options.application.plugins.refresh();
  }

  listMarketplacePlugins(
    req: ListMarketplacePluginsReq,
  ): Promise<ListMarketplacePluginsResp> {
    return this.options.application.plugins.listMarketplacePlugins(req);
  }

  listInstalledPlugins(
    req: ListInstalledPluginsReq,
  ): Promise<ListInstalledPluginsResp> {
    return this.options.application.plugins.listInstalledPlugins(req);
  }

  installPlugin(req: MutatePluginReq): Promise<MutatePluginResp> {
    return this.options.application.plugins.installPlugin(req);
  }

  enablePlugin(req: MutatePluginReq): Promise<MutatePluginResp> {
    return this.options.application.plugins.enablePlugin(req);
  }

  disablePlugin(req: MutatePluginReq): Promise<MutatePluginResp> {
    return this.options.application.plugins.disablePlugin(req);
  }

  uninstallPlugin(req: MutatePluginReq): Promise<MutatePluginResp> {
    return this.options.application.plugins.uninstallPlugin(req);
  }

  pluginManagement(
    request: Parameters<CliManagementApplication["pluginManagement"]>[0],
  ) {
    return this.options.management.pluginManagement(request);
  }

  getPermissionMode() {
    return this.requireCapability(
      "configuration",
      "Configuration",
    ).getPermissionMode();
  }

  setPermissionMode(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["configuration"]>["setPermissionMode"]
    >[0],
  ) {
    return this.requireCapability(
      "configuration",
      "Configuration",
    ).setPermissionMode(input);
  }

  /**
   * The memory switches are optional on the capability, so a host that
   * predates the surface must produce one clear failure here rather than a
   * `TypeError` from calling `undefined`. Absence means "this host cannot
   * answer" — it is deliberately not reported as a boolean value, because
   * `false` would read as "the user turned memory off".
   */
  getMemorySettings(): Promise<{ enabled: boolean; proactive: boolean }> {
    const configuration = this.requireCapability("configuration", "Configuration");
    if (!configuration.getMemorySettings)
      throw new Error("Runtime host does not expose memory settings");
    return configuration.getMemorySettings();
  }

  setMemorySettings(
    input: Parameters<
      NonNullable<
        NonNullable<LocalRuntimeApplication["configuration"]>["setMemorySettings"]
      >
    >[0],
  ): Promise<{ enabled: boolean; proactive: boolean }> {
    const configuration = this.requireCapability("configuration", "Configuration");
    if (!configuration.setMemorySettings)
      throw new Error("Runtime host does not expose memory settings");
    return configuration.setMemorySettings(input);
  }

  /**
   * The browser authorization switches, optional on the capability for the same
   * reason the memory pair is: a host that predates the surface has to fail
   * closed with one clear message rather than crash on an absent method.
   */
  getBrowserAuthorization(): Promise<{
    isolatedChromium: boolean;
    edge: boolean;
    chrome: boolean;
    fullCdp: boolean;
  }> {
    const configuration = this.requireCapability("configuration", "Configuration");
    if (!configuration.getBrowserAuthorization)
      throw new Error("Runtime host does not expose browser authorization");
    return configuration.getBrowserAuthorization();
  }

  setBrowserAuthorization(
    input: Parameters<
      NonNullable<
        NonNullable<LocalRuntimeApplication["configuration"]>["setBrowserAuthorization"]
      >
    >[0],
  ): Promise<{
    isolatedChromium: boolean;
    edge: boolean;
    chrome: boolean;
    fullCdp: boolean;
  }> {
    const configuration = this.requireCapability("configuration", "Configuration");
    if (!configuration.setBrowserAuthorization)
      throw new Error("Runtime host does not expose browser authorization");
    return configuration.setBrowserAuthorization(input);
  }

  listModels(
    input?: Parameters<
      NonNullable<LocalRuntimeApplication["models"]>["list"]
    >[0],
  ) {
    return this.requireCapability("models", "Model").list(input);
  }

  selectModel(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["models"]>["select"]
    >[0],
  ) {
    return this.requireCapability("models", "Model").select(input);
  }

  /** Resolves false when the host has no model-favorite store. */
  async setModelFavorite(
    input: Parameters<
      NonNullable<
        NonNullable<LocalRuntimeApplication["models"]>["setFavorite"]
      >
    >[0],
  ): Promise<boolean> {
    const models = this.requireCapability("models", "Model");
    if (!models.setFavorite) return false;
    return models.setFavorite(input);
  }

  listUserModelProviders() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).listUser();
  }

  listProviderPresets() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).listProviderPresets();
  }

  getCodexOAuthStatus() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).getCodexOAuthStatus();
  }

  startCodexOAuthLogin(
    options?: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["startCodexOAuthLogin"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).startCodexOAuthLogin(options);
  }
  cancelCodexOAuthLogin(loginId: string) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).cancelCodexOAuthLogin(loginId);
  }

  getMiniMaxApiKeyStatus() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).getMiniMaxApiKeyStatus();
  }

  getMiniMaxModelSource() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).getMiniMaxModelSource();
  }

  setMiniMaxModelSource(
    input: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["setMiniMaxModelSource"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).setMiniMaxModelSource(input);
  }

  upsertMiniMaxApiKey(
    input: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["upsertMiniMaxApiKey"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).upsertMiniMaxApiKey(input);
  }

  createUserModelProvider(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["create"]
    >[0],
  ) {
    return this.requireCapability("modelProviders", "Model Provider").create(
      input,
    );
  }

  discoverUserModelsCandidate(
    input: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["discoverCandidate"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).discoverCandidate(input);
  }

  saveUserModelProviderCandidate(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["saveCandidate"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).saveCandidate(input);
  }

  updateUserModelProvider(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["update"]
    >[0],
  ) {
    return this.requireCapability("modelProviders", "Model Provider").update(
      input,
    );
  }

  deleteUserModelProvider(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["delete"]
    >[0],
  ) {
    return this.requireCapability("modelProviders", "Model Provider").delete(
      input,
    );
  }

  testUserModelProvider(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["testProvider"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).testProvider(input);
  }

  testUserModelCandidate(
    input: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["testUserModelCandidate"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).testUserModelCandidate(input);
  }

  revealModelProviderApiKey(
    input: Parameters<
      NonNullable<
        LocalRuntimeApplication["modelProviders"]
      >["revealModelProviderApiKey"]
    >[0],
  ) {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).revealModelProviderApiKey(input);
  }

  refreshModels() {
    return this.requireCapability(
      "modelProviders",
      "Model Provider",
    ).refreshModels();
  }

  testUserModel(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["modelProviders"]>["testModel"]
    >[0],
  ) {
    return this.requireCapability("modelProviders", "Model Provider").testModel(
      input,
    );
  }

  listSkills(
    input: Parameters<LocalRuntimeApplication["skills"]["listSkills"]>[0],
  ) {
    return this.options.application.skills.listSkills(input);
  }

  listRuntimeSkills(
    input: Parameters<
      LocalRuntimeApplication["skills"]["listRuntimeSkills"]
    >[0],
  ) {
    return this.options.application.skills.listRuntimeSkills(input);
  }

  listBackgroundTasks(
    input: Parameters<
      NonNullable<LocalRuntimeApplication["backgroundTasks"]>["list"]
    >[0],
  ): ReturnType<
    NonNullable<LocalRuntimeApplication["backgroundTasks"]>["list"]
  > {
    return this.requireCapability("backgroundTasks", "Background Task").list(
      input,
    );
  }

  async listMcpServers(input: { keyword?: string; sessionId?: string }) {
    const mcp = this.requireCapability("mcp", "MCP");
    const context = input.sessionId
      ? await this.projectMcpContext(input.sessionId)
      : undefined;
    return mcp.listMcpCapabilities
      ? mcp.listMcpCapabilities({ keyword: input.keyword, context })
      : mcp.listLocalMcpServers(input);
  }

  /**
   * The six scheduled-task members.
   *
   * Each one forwards to the v2 Cron service and does nothing else: the service already owns
   * definition storage, the scheduler arming and the run queue, and a second layer of decisions
   * here would be a second authority over them. A host composed without a Scheduler has no Cron
   * service, and every member then fails with the same sentence rather than acting on an
   * undefined.
   */
  listCronTasks(query: ListCronDefinitionsQuery = {}): CronPage<CronDefinitionView> {
    return this.requireCron().listDefinitions(query);
  }

  createCronTask(command: CreateCronDefinitionCommand): Promise<CronDefinitionView> {
    return this.requireCron().createDefinition(command);
  }

  updateCronTask(command: UpdateCronDefinitionCommand): Promise<CronDefinitionView> {
    return this.requireCron().updateDefinition(command);
  }

  async deleteCronTask(command: DeleteCronDefinitionCommand): Promise<void> {
    await this.requireCron().deleteDefinition(command);
  }

  runCronTaskNow(cronId: string): Promise<CronRunView> {
    return this.requireCron().triggerManualRun(cronId);
  }

  listCronTaskRuns(query: ListCronRunsQuery): CronPage<CronRunView> {
    return this.requireCron().listRuns(query);
  }

  private requireCron(): CronService {
    const cron = this.options.cron;
    if (!cron) throw new Error("Runtime does not expose the Cron service.");
    return cron;
  }

  private requireQuestionnaires(): NonNullable<
    LocalRuntimeApplication["questionnaires"]
  > {
    const questionnaires = this.options.application.questionnaires;
    if (!questionnaires)
      throw new Error("Runtime does not expose Questionnaire Application.");
    return questionnaires;
  }

  private requirePermissions(): NonNullable<
    LocalRuntimeApplication["permissions"]
  > {
    const permissions = this.options.application.permissions;
    if (!permissions)
      throw new Error("Runtime does not expose Permission Application.");
    return permissions;
  }

  private requireCapability<Key extends keyof LocalRuntimeApplication>(
    key: Key,
    label: string,
  ): NonNullable<LocalRuntimeApplication[Key]> {
    const capability = this.options.application[key];
    if (!capability)
      throw new Error(`Runtime does not expose ${label} Application.`);
    return capability as NonNullable<LocalRuntimeApplication[Key]>;
  }
}

function toPermissionDecision(
  reply: ReplyPermissionReq["reply"],
): "allowAlways" | "allowOnce" | "deny" {
  switch (reply) {
    case PermissionReply.AllowOnce:
      return "allowOnce";
    case PermissionReply.AllowAlways:
      return "allowAlways";
    case PermissionReply.Deny:
      return "deny";
    default:
      throw new Error(`Unsupported permission reply: ${String(reply)}`);
  }
}

type QuestionnaireApplicationRequest = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<LocalRuntimeApplication["questionnaires"]>["getPending"]
    >
  >
>;

type QuestionnaireRequestView = NonNullable<
  GetPendingQuestionnaireResp["request"]
>;

function toQuestionnaireRequestView(
  request: QuestionnaireApplicationRequest,
): QuestionnaireRequestView {
  return {
    schemaVersion: request.schemaVersion,
    id: request.id,
    ...(request.title ? { title: request.title } : {}),
    ...(request.tool
      ? {
          tool: {
            messageId: request.tool.message_id,
            callId: request.tool.call_id,
          },
        }
      : {}),
    ...(request.requester ? { requester: { ...request.requester } } : {}),
    presentation: { ...request.presentation },
    steps: request.steps.map(toQuestionnaireStepView),
    ...(request.expiresAt !== undefined
      ? { expiresAt: request.expiresAt }
      : {}),
    ...(request.purpose === "goal"
      ? { purpose: QuestionnairePurpose.Goal }
      : {}),
    ...(request.status
      ? { status: toQuestionnaireStatus(request.status) }
      : {}),
    ...(request.createdAt !== undefined
      ? { createdAt: request.createdAt }
      : {}),
    mode: request.mode ?? "questionnaire",
    ...(request.modePayload
      ? { modePayload: toQuestionnaireModePayloadView(request.modePayload) }
      : {}),
  };
}

function toQuestionnaireStepView(
  step: QuestionnaireApplicationRequest["steps"][number],
): QuestionnaireRequestView["steps"][number] {
  return {
    ...step,
    selectionMode:
      step.selectionMode === "multiple"
        ? QuestionnaireSelectionMode.Multiple
        : QuestionnaireSelectionMode.Single,
    options: step.options.map((option) => ({
      ...option,
      ...(option.image ? { image: { ...option.image } } : {}),
    })),
    ...(step.image ? { image: { ...step.image } } : {}),
  };
}

function toQuestionnaireModePayloadView(
  modePayload: NonNullable<QuestionnaireApplicationRequest["modePayload"]>,
): NonNullable<QuestionnaireRequestView["modePayload"]> {
  return {
    ...modePayload,
    ...(modePayload.planReview
      ? { planReview: { ...modePayload.planReview } }
      : {}),
  };
}

function toQuestionnaireStatus(
  status: "pending" | "answered" | "expired" | "superseded" | "dismissed",
): (typeof QuestionnaireStatus)[keyof typeof QuestionnaireStatus] {
  switch (status) {
    case "pending":
      return QuestionnaireStatus.Pending;
    case "answered":
      return QuestionnaireStatus.Answered;
    case "expired":
      return QuestionnaireStatus.Expired;
    case "superseded":
      return QuestionnaireStatus.Superseded;
    case "dismissed":
      return QuestionnaireStatus.Dismissed;
  }
}
