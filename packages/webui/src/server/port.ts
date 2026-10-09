import type { ClaimSigninData, SigninPanel } from "@mavis/shared/daily-signin";
import type { WebuiPluginManagementRequest } from "../shared/plugin-management.js";

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

export interface WebuiVersionInfo {
  readonly version: string;
  readonly protocolVersion: number;
  readonly dataDir?: string;
}

export interface WebuiSessionListRequest {
  readonly name: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
  readonly includeHidden?: boolean;
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export interface WebuiSessionListItem {
  readonly sessionId: string;
  readonly agentName: string;
  readonly sessionType?: string;
  readonly archived?: boolean;
  readonly status?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly workspaceDir?: string;
  readonly frameworkType?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly visibility?: string;
  readonly sessionKind?: string;
  readonly title?: string;
  readonly parentSessionId?: string;
  readonly purpose?: string;
}

export interface WebuiSessionPage {
  readonly sessions: readonly WebuiSessionListItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiProjectRecord {
  readonly projectId: number;
  readonly projectKind: "default" | "workspace";
  readonly workspaceDir: string | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly orderIndex: number;
  readonly recentAtMs: number | null;
  readonly latestActivityAtMs: number;
  readonly sessionCount: number;
}

export interface WebuiSessionTreeRequest {
  readonly name: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
  readonly includeHidden?: boolean;
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export interface WebuiSessionTreeNode {
  readonly session: WebuiSessionListItem;
  readonly childSessions: readonly WebuiSessionListItem[];
}

export interface WebuiSessionTreePage {
  readonly sessions: readonly WebuiSessionTreeNode[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiSessionLookupRequest {
  readonly id: string;
}

/**
 * Authoritative active-turn probe. `busyReason: "compaction"` means the
 * session is busy but is not producing an assistant transcript, so callers
 * that need a message stream must not attach on that alone.
 */
export interface WebuiActiveTurn {
  readonly turnId: string;
  readonly busyReason: "turn" | "compaction";
  readonly locallyOwned: boolean;
}

export type WebuiActiveTurnResult = WebuiActiveTurn | undefined;

export interface WebuiActiveTurnRequest {
  readonly id: string;
}
export interface WebuiSessionInfo {
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly title?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly workspaceDir?: string;
  readonly [key: string]: unknown;
}
export interface WebuiSessionLookupResult {
  readonly session?: WebuiSessionInfo;
}
export interface WebuiUpdateSessionRequest {
  readonly id: string;
  readonly title?: string;
}
export interface WebuiUpdateSessionResult {
  readonly session?: WebuiSessionInfo;
}
export interface WebuiForkSessionRequest {
  readonly id: string;
  readonly clientRequestId: string;
  readonly title?: string;
  readonly useSuggestedTitle: boolean;
  readonly createIsolatedWorktree: boolean;
}
export interface WebuiGetSessionForkOptionsRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
}
export interface WebuiGetSessionForkOptionsResult {
  readonly canFork: boolean;
  readonly unavailableReason?: string;
  readonly suggestedTitle?: string;
  readonly nextForkOrdinal?: number;
  readonly sourceTitle?: string;
  readonly worktreeVisible: boolean;
  readonly worktreeEligible: boolean;
  readonly worktreeUnavailableReason?: string;
}
export interface WebuiForkSessionResult {
  readonly session?: WebuiSessionInfo;
  readonly sourceDisplayMessageId?: string;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
}
export interface WebuiCreateSessionRequest {
  readonly name: string;
  /** Optional: absent means "use the default workspace" (harness resolves it). */
  readonly workspaceDir?: string;
  readonly teamModeOff?: boolean;
}

/**
 * A session in the shape that survives a round trip.
 *
 * Both layers are present because neither is recoverable from the other: the
 * canonical layer is what the model reads on the next turn, the display layer
 * is what the user reads. A file carrying only one of them imports as a
 * conversation that is half-gone.
 */
export interface WebuiSessionTransferFile {
  readonly format: string;
  readonly exportedAt: string;
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  };
  readonly canonical: {
    readonly envelopes: readonly {
      readonly message_id: string;
      readonly turn_id: string;
      readonly message: unknown;
    }[];
    /**
     * Compaction snapshots the active file is chained to.
     *
     * Not optional history, and the reason this field exists in the type at
     * all. Each generation's file names its parent by
     * `(generation, compactionId)`, and the import scanner walks the whole
     * lineage before it accepts anything -- a file carrying only the active
     * generation dies with `parent-snapshot-missing` the moment the session
     * has ever been compacted. Nothing is lost today because the route
     * serialises the runtime's value verbatim, but a type that omits the
     * field is a type that permits the next refactor to rebuild the payload
     * without it, and that refactor passes every test in this repository.
     */
    readonly snapshots: readonly {
      readonly generation: number;
      readonly fileName: string;
      readonly revision: string;
      readonly records: readonly {
        readonly message_id: string;
        readonly turn_id: string;
        readonly message: unknown;
      }[];
    }[];
    readonly generation: number;
    readonly revision: string;
  };
  readonly display: {
    readonly messages: readonly Record<string, unknown>[];
  };
}

export interface WebuiImportSessionTransferRequest {
  /** The session the caller just created to receive the history. */
  readonly targetSessionId: string;
  /** Informational lineage only; never trusted for anything else. */
  readonly sourceSessionId?: string;
  /** Untrusted. The runtime validates the whole payload before writing. */
  readonly file: unknown;
}

export interface WebuiImportSessionTransferResult {
  readonly sessionId: string;
  readonly canonicalMessages: number;
  readonly displayMessages: number;
  readonly revision: string;
}export interface WebuiCreateSessionResult {
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly session?: WebuiSessionInfo;
}
export interface WebuiMessage {
  readonly msgId: string;
  readonly parentMsgId?: string;
  readonly timestamp?: number;
  readonly msgContent?: string;
  readonly msgType?: number;
  readonly role?: string;
  readonly thinkingContent?: string;
  readonly thinkingDurationMs?: number;
  readonly finishReason?: string;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly source?: string;
  readonly kind?: string;
  readonly turnId?: string;
  readonly [key: string]: unknown;
}
export interface WebuiMessagesRequest {
  readonly id: string;
  readonly limit?: number;
  readonly before?: string;
  readonly includeAttachmentReadUrls?: boolean;
}
export interface WebuiMessagesResult {
  readonly messages?: readonly WebuiMessage[];
  readonly nextCursor?: string;
  readonly lastMsgId?: string;
  readonly hasMore?: boolean;
  readonly todosJson?: string;
  readonly queryCollapseViews?: readonly Record<string, unknown>[];
  readonly turnResults?: readonly Record<string, unknown>[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly usage?: Record<string, unknown>;
}

export interface WebuiFileDiffInfoView {
  readonly file: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: string;
  readonly diff?: string;
  readonly patch?: Record<string, unknown>;
}

export interface WebuiTurnDiffView {
  readonly fileChanges?: readonly WebuiFileDiffInfoView[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly status?: string;
  readonly revertedAt?: number;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
}

export interface WebuiGetSessionDiffRequest {
  readonly id: string;
  readonly messageId?: string;
}

export interface WebuiGetSessionDiffResult {
  readonly diffs?: readonly WebuiFileDiffInfoView[];
  readonly changeSetId?: string;
}

export interface WebuiGetTurnDiffRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
}

export interface WebuiGetTurnDiffResult extends WebuiTurnDiffView {}

export interface WebuiRevertTurnDiffRequest extends WebuiGetTurnDiffRequest {}
export interface WebuiRevertTurnDiffResult {
  readonly success?: boolean;
  readonly error?: string;
  readonly turnDiff?: WebuiTurnDiffView;
}

export interface WebuiReapplyTurnDiffRequest extends WebuiGetTurnDiffRequest {}
export interface WebuiReapplyTurnDiffResult extends WebuiTurnDiffView {
  readonly success: boolean;
  readonly error?: string;
}

export interface WebuiGetSessionForkOptionsRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
}

export interface WebuiGetSessionForkOptionsResult {
  readonly canFork: boolean;
  readonly unavailableReason?: string;
  readonly suggestedTitle?: string;
  readonly nextForkOrdinal?: number;
  readonly sourceTitle?: string;
  readonly worktreeVisible: boolean;
  readonly worktreeEligible: boolean;
  readonly worktreeUnavailableReason?: string;
}

export interface WebuiForkSessionRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
  readonly clientRequestId: string;
  readonly title?: string;
  readonly useSuggestedTitle: boolean;
  readonly createIsolatedWorktree: boolean;
}

export interface WebuiForkSessionResult {
  readonly session?: WebuiSessionInfo;
  readonly forkOriginMessageId?: string;
  readonly sourceDisplayMessageId?: string;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
}

export interface WebuiGetSessionRewindPreviewRequest {
  readonly id: string;
  readonly userMessageId: string;
}

export interface WebuiRewindPreviewFile {
  readonly filePath: string;
  readonly action: string;
  readonly skipped: boolean;
}

export interface WebuiRewindPreviewTurn {
  readonly turnId: string;
  readonly files: readonly WebuiRewindPreviewFile[];
}

export interface WebuiGetSessionRewindPreviewResult {
  readonly turns: readonly WebuiRewindPreviewTurn[];
}

export interface WebuiRewindSessionRequest {
  readonly id: string;
  readonly userMessageId: string;
  readonly clientRequestId: string;
  readonly rewindTurnDiff?: boolean;
}

export interface WebuiRewindSessionResult {
  readonly rewound: boolean;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
  readonly deletedMessageIds?: readonly string[];
  readonly turnDiffRewind?: {
    readonly status: string;
    readonly revertedTurnIds?: readonly string[];
    readonly errorCode?: string;
  };
}

export interface WebuiEditSessionMessageRequest {
  readonly id: string;
  readonly userMessageId: string;
  readonly clientRequestId: string;
  readonly content: string;
  readonly attachments?: readonly Record<string, unknown>[];
  readonly rewindTurnDiff?: boolean;
}

export interface WebuiEditSessionMessageResult {
  readonly rewound: boolean;
  readonly turnId?: string;
  readonly userMessageId?: string;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
  readonly deletedMessageIds?: readonly string[];
}

export type WebuiGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete"
  | "budget_limited"
  | "usage_limited";

export type WebuiGoalWaitReason =
  | "questionnaire"
  | "permission"
  | "plan"
  | "required_background"
  | "automation_owner_conflict"
  | "dependency_unavailable"
  | "verification"
  | "unknown";
export interface WebuiGoal {
  readonly goalId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: WebuiGoalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tokensUsed: number;
  readonly turnsUsed: number;
  readonly timeUsedSeconds: number;
  readonly tokenBudget: number | null;
  readonly statusReason: string | null;
  readonly hasKickoffAttachments?: boolean;
  readonly executionWait?: {
    readonly reason: WebuiGoalWaitReason;
    readonly sinceMs: number;
  } | null;
}

export interface WebuiGoalSessionRequest {
  readonly sessionId: string;
}

export interface WebuiGoalCreateRequest {
  readonly sessionId: string;
  readonly objective: string;
  readonly tokenBudget?: number | null;
}

export interface WebuiGoalPatchRequest {
  readonly sessionId: string;
  readonly status?: WebuiGoalStatus;
  readonly objective?: string;
  readonly tokenBudget?: number | null;
}

export interface WebuiGoalEnabledResult {
  readonly enabled: boolean;
}

export interface WebuiWorkspaceFile {
  readonly path: string;
  readonly name: string;
  readonly type?: string;
  /** Bytes. Absent for directories and for runtimes that do not stat. */
  readonly size?: number;
  /** Epoch milliseconds of the last modification. Same absence rule as `size`. */
  readonly modifiedAt?: number;
  readonly children?: readonly WebuiWorkspaceFile[];
}

export interface WebuiWorkspaceFileContent {
  readonly type: "text" | "binary";
  readonly content: string;
  readonly resolvedPath?: string;
  readonly mimeType?: string;
  readonly previewDataUrl?: string;
  readonly error?: string;
}

export interface WebuiWorkspaceDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

/**
 * One entry inside an archive listed by `readWorkspaceArchive`. `path` is
 * the archive-internal POSIX path, never a host path: nothing in this shape
 * may be handed to the filesystem without re-validating it against the
 * extraction root.
 */
export interface WebuiArchiveEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size?: number;
}

export interface WebuiWorkspaceArchiveListing {
  readonly archivePath: string;
  /** Only the entries directly under `prefix`, or under the archive root. */
  readonly entries: readonly WebuiArchiveEntry[];
  /** Total entries in the archive, which may exceed `entries.length`. */
  readonly totalEntries: number;
  /** True when the listing was cut off before covering the whole archive. */
  readonly truncated: boolean;
}

export interface WebuiWorkspaceArchiveExtractResult {
  readonly archivePath: string;
  readonly destination: string;
  readonly writtenFiles: number;
  /** Set when the archive carried more entries than the hard ceiling allows. */
  readonly truncated?: boolean;
}

/**
 * One level of the local directory tree, for the composer's project
 * picker. A browser cannot hand the WebUI an absolute path — the File
 * System Access API returns a bare directory name, and `File.path` only
 * exists inside Electron — so the server enumerates the candidates and
 * the browser picks from what the server reports.
 */
export interface WebuiWorkspaceDirectoryListing {
  readonly dir: string;
  /** Absent at the filesystem root, where there is nowhere to go up. */
  readonly parent?: string;
  readonly entries: readonly WebuiWorkspaceDirectoryEntry[];
  /** True when `dir` held more directories than one listing carries. */
  readonly truncated: boolean;
}

/**
 * The small, session-scoped projection used by the Desktop environment
 * section. Keep the runtime's snapshot ids and file-level details private;
 * the browser only needs the state that controls visibility and actions.
 */
export interface WebuiWorkspaceEnvironment {
  readonly isGitRepo: boolean;
  readonly branch?: string;
  readonly changedFiles: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly lineStatsStatus: "ready" | "partial" | "skipped";
  readonly canPush?: boolean;
  readonly hasRemote?: boolean;
  readonly hasUpstream?: boolean;
  readonly changesError?: string;
  readonly metadataError?: string;
}

export type WebuiWorkspaceGitMutation =
  | "commit"
  | "commitAndPush"
  | "push";

export interface WebuiWorkspaceGitMutationRequest {
  readonly workspaceDir: string;
  readonly action: WebuiWorkspaceGitMutation;
  readonly message?: string;
}

export interface WebuiWorkspaceReviewFile {
  readonly fileId: string; readonly path: string; readonly originalPath?: string;
  readonly status: string; readonly type?: "text" | "binary";
  readonly additions: number; readonly deletions: number;
}
export interface WebuiWorkspaceReviewSummary {
  readonly repositoryId: string; readonly reviewSnapshotId: string;
  readonly files: readonly WebuiWorkspaceReviewFile[];
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
}
export interface WebuiWorkspaceReviewFileDiff {
  readonly fileId: string; readonly errorCode?: string; readonly error?: string;
  readonly diff?: { readonly type: "text" | "binary"; readonly content: string; readonly diff?: string; readonly previewState?: string };
}
export interface WebuiWorkspaceReviewDiffs {
  readonly reviewSnapshotId: string; readonly diffs: readonly WebuiWorkspaceReviewFileDiff[];
}
export interface WebuiWorkspaceReviewFileContent {
  readonly fileId: string; readonly path: string; readonly side: "old" | "new";
  readonly type: "text" | "binary"; readonly content?: string; readonly error?: string; readonly errorCode?: string;
}
export interface WebuiWorkspaceReviewSearchResult {
  readonly reviewSnapshotId: string;
  readonly matchedFiles: readonly { readonly fileId: string; readonly path: string; readonly matchCount: number }[];
  readonly totalMatches: number; readonly totalMatchedFiles: number; readonly pageIndex: number; readonly pageSize: number;
  readonly matchesBeforePage: number; readonly hasPreviousPage: boolean; readonly hasNextPage: boolean;
}

export interface WebuiCanvasDocument {
  readonly schemaVersion: number;
  readonly canvasId: string;
  readonly sessionId: string;
  readonly changeSeq: number;
  readonly nodes: readonly Record<string, unknown>[];
  readonly updatedAtMs: number;
}

export interface WebuiTerminalFrame {
  readonly terminalId: string;
  readonly data: string;
  readonly exited: boolean;
}

/** Deliberately small WebUI-owned shape; the browser does not import the harness contract. */
export interface WebuiSendMessageRequest {
  readonly id: string;
  readonly content?: string;
  readonly turnId?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
}

export interface WebuiEnqueueMessageRequest {
  readonly id: string;
  readonly content: string;
  readonly model?: Record<string, unknown>;
  readonly clientRequestId?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
}

export interface WebuiAttachmentInput {
  readonly meta?: {
    readonly attachmentType?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
  };
  readonly local?: {
    readonly assetId?: string;
    readonly filePath?: string;
    readonly dataUrl?: string;
    readonly desktopPath?: string;
  };
}

export interface WebuiEnqueueMessageResult {
  readonly itemId?: string;
  readonly status?: string;
  readonly position?: number;
}

/**
 * Wire shape for `resumeSession` on the WebUI envelope. The harness
 * `ResumeSessionInput` is what the runtime layer ultimately consumes; this
 * type is a deliberately narrow projection so the browser can ask for a
 * resume without importing the harness contract.
 */
export interface WebuiResumeSessionRequest {
  readonly id: string;
  /** Resume from the stream cursor the client last advanced past. */
  readonly afterCursor?: string;
  /** Resume from after a specific persisted message id, when known. */
  readonly afterMsgId?: string;
  /** Drain any queued turns after the resume point. */
  readonly drainQueued?: boolean;
}

export interface WebuiPendingPermission {
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

export interface WebuiQuestionnaireOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface WebuiQuestionnaireStep {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly description?: string;
  readonly selectionMode: number;
  readonly options?: readonly WebuiQuestionnaireOption[];
  readonly allowOther: boolean;
  readonly otherPlaceholder: string;
  readonly required: boolean;
}

export interface WebuiQuestionnaireRequest {
  readonly schemaVersion: number;
  readonly id: string;
  readonly title?: string;
  readonly requester?: {
    readonly sessionId: string;
    readonly runId?: string;
    readonly toolCallId?: string;
    readonly agentName?: string;
  };
  readonly presentation: {
    readonly replaceComposer: boolean;
    readonly showProgress: boolean;
    readonly allowBackNavigation: boolean;
  };
  readonly steps: readonly WebuiQuestionnaireStep[];
  readonly expiresAt?: number;
  readonly status?: number;
  readonly createdAt?: number;
  readonly mode?: string;
  readonly purpose?: number;
  /**
   * The message that raised this request. The plan card is rendered as a
   * message in the transcript, so it needs the id of the turn message to
   * anchor itself to — the desktop attaches it as that message's footer.
   */
  readonly tool?: {
    readonly messageId: string;
    readonly callId: string;
  };
  /**
   * Mode-specific request body. The runtime attaches the plan file to a plan
   * request so the plan card can render its own preview and decision UI
   * instead of the generic questionnaire. `cli-service.ts` copies
   * `planReview` through verbatim, so it is already on the wire.
   */
  readonly modePayload?: {
    readonly featureKey?: string;
    readonly planReview?: {
      readonly markdown: string;
      readonly path: string;
    };
  };
}

export interface WebuiQuestionnaireAnswer {
  readonly stepId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly selectedOther?: boolean;
  readonly otherText?: string;
  readonly skipped?: boolean;
}

export type WebuiPermissionDecision = "allowOnce" | "allowAlways" | "deny";

export interface WebuiRuntimeEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
  readonly source: string;
}

export type WebuiWatchEventsResult =
  | {
      readonly ok: true;
      readonly source:
        AsyncIterable<WebuiRuntimeEvent> | Iterable<WebuiRuntimeEvent>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };

export interface WebuiStreamFrame {
  readonly cursor?: string;
  readonly eventJson?: string;
  readonly dataJson?: string;
  readonly messageActionDeltas?: readonly Record<string, unknown>[];
  readonly projection?: unknown;
}

/**
 * Result envelope shared between `sendMessage` and `resumeSession`: the
 * harness session-stream contract returns an iterable source on success or
 * a structured error body on failure. The wire envelope (`event` frames
 * over a WebSocket) is the same in both cases — see the brief's "two
 * facts that make this ticket small".
 */
export type WebuiStreamResult =
  | {
      readonly ok: true;
      readonly source:
        AsyncIterable<WebuiStreamFrame> | Iterable<WebuiStreamFrame>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };

/** `sendMessage` returns the same shape as a resume — kept as an alias. */
export type WebuiSendMessageResult = WebuiStreamResult;

export interface WebuiInteractionReplyResult {
  readonly success?: boolean;
  readonly ok?: boolean;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly answeredAt?: number;
  readonly dismissedAt?: number;
}

export interface WebuiQueueItem {
  readonly itemId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly content?: string;
  readonly source?: string;
  readonly failedReason?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface WebuiModelEntry {
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Which upstream serves this model: a first-party provider, the user's own
   * MiniMax API key, or a provider the user configured themselves.
   *
   * The runtime has always sent this; the port just never declared it, so the
   * client could not tell a model the account's plan meters from one another
   * account bills. `isTokenPlanModel` reads it to decide whether the plan
   * figures belong beside a given model.
   */
  readonly providerSource?: "provider" | "minimax_api" | "custom_provider";
  readonly displayName?: string;
  readonly selected?: boolean;
  readonly enabled?: boolean;
  readonly variant?: string;
  readonly effortOptions?: readonly string[];
  readonly defaultEffort?: string;
  readonly contextWindowOptions?: readonly number[];
  readonly contextWindowOptionHints?: Readonly<Record<string, string>>;
  readonly contextLimit?: number;
  /**
   * The runtime's thinking contract. `default_value` is what marks a
   * `switchable` model as having an on/off thinking switch, and the client's
   * `resolveEffortOptions` reads it to decide whether to draw the brain.
   */
  readonly thinkingConfig?: {
    readonly mode?: string;
    readonly default_value?: "true" | "false";
  };
  readonly thinking?: { readonly effort?: string };
  readonly providerName?: string;
  readonly status?: {
    readonly state?: string;
    readonly lastErrorMessage?: string;
  };
  readonly [key: string]: unknown;
}

/**
 * Minimal skill projection the WebUI composer needs to populate the slash
 * palette. Mirrors the desktop's `listSkills(agentName, ...)` call shape;
 * the harness returns whatever subset of `SkillInfo` it needs, and the
 * client only depends on these three fields to render the popover row.
 */
export interface WebuiSkillEntry {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}

export interface WebuiRunCommandRequest {
  readonly command: "help" | "new" | "compact" | "status" | "usage" | "model";
  readonly input?: string;
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly workspaceDir?: string;
}

export type WebuiRunCommandResult =
  | { readonly handled: true; readonly output: string; readonly data?: unknown }
  | { readonly handled: true; readonly output?: undefined; readonly data: unknown };

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
    import("../client/contracts.js").WebuiGlobalInstructionsView
  >;
  /** Writing empty content deletes the file, matching `GlobalInstructions.write`. */
  setGlobalInstructions?(request: {
    readonly content: string;
  }): Promise<import("../client/contracts.js").WebuiGlobalInstructionsView>;
  /**
   * Per-agent main memory (`agents/<name>/memory/MEMORY.md`). Summary-only by
   * default; `includeContent` pulls the body, which runs past the 64KB
   * cleanup threshold on a live profile. Writing empty content deletes the
   * file, matching the runtime's write contract.
   */
  getAgentMemory?(request?: {
    readonly includeContent?: boolean;
  }): Promise<import("../client/contracts.js").WebuiAgentMemoryView>;
  setAgentMemory?(request: {
    readonly content: string;
  }): Promise<import("../client/contracts.js").WebuiAgentMemoryView>;
  /**
   * The `关于你` region of `memory/user.md` — the three fields between the
   * personalization markers. The rest of that file belongs to the memory
   * collector, so a write must never be able to express "replace the file".
   * A file whose markers are only half-present refuses the write rather than
   * guessing where the region ends.
   */
  getUserProfile?(): Promise<import("../client/contracts.js").WebuiUserProfileView>;
  setUserProfile?(request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }): Promise<import("../client/contracts.js").WebuiUserProfileView>;
  /**
   * The two memory switches. Optional because a host that predates the
   * configuration capability still has to satisfy this port; a missing method
   * is a capability gap, not a boolean value, and the handler reports it as
   * such instead of rendering the panel as "memory is off".
   */
  getMemorySettings?(): Promise<import("../client/contracts.js").WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<import("../client/contracts.js").WebuiMemorySettingsView>;
  close(): Promise<void>;
}

/** One percentage window (5-hour / weekly) of the token-plan quota. */
export interface WebuiUsageQuotaWindowView {
  /** Used percent, 0-100, already rounded; absent when unlimited or unknown. */
  readonly usedPercent?: number;
  /** Total percent for the window (the API reports `100%`); drives 总额 X%. */
  readonly totalPercent?: number;
  readonly resetAtMs?: number;
  readonly unlimited: boolean;
}

/** The video quota is count-based (`used/total`), not percentage-based. */
export interface WebuiUsageQuotaVideoView {
  readonly usedCount?: number;
  readonly totalCount?: number;
  readonly resetAtMs?: number;
  readonly unlimited: boolean;
}

export interface WebuiUsageQuotaView {
  readonly fiveHour: WebuiUsageQuotaWindowView;
  readonly weekly: WebuiUsageQuotaWindowView;
  readonly video?: WebuiUsageQuotaVideoView;
}

export type WebuiUsageQuotaResult =
  | { readonly signedIn: false }
  | {
      readonly signedIn: true;
      readonly hasTokenPlan?: boolean;
      /** Raw credit balance as the account API reports it (string or numeric string). */
      readonly creditBalance?: string;
      readonly tokenPlanTier?: string;
      readonly tokenPlanExpiresAt?: number;
      readonly upgradeAction?: string;
      readonly willRenewal?: boolean;
      readonly purchasedCredits?: string;
      readonly freeCredits?: string;
      readonly quota?: WebuiUsageQuotaView;
    };

// The check-in wire types are the shared validators' own types — the same
// `@mavis/shared/daily-signin` module the TUI and the desktop use (the webui
// panel renders them directly, so there is no second shape to drift).
export type WebuiSigninPanelView = SigninPanel;
export type WebuiClaimSigninView = ClaimSigninData;

/** The device-authorization prompt the browser shows: a code to enter and
 *  the page to enter it on. Same fields the terminal client prints. */
export interface WebuiAccountLoginPromptView {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  /** Unix ms, derived from the prompt's `expiresInSec`; the dialog counts
   *  down against it and offers a fresh code when it passes. */
  readonly expiresAtMs: number;
}

/**
 * One answer for both account questions the browser asks: is a login
 * attempt running (with its prompt), and is the account signed in —
 * `authenticated` covers a login this process started AND one made in the
 * terminal client, because the credential store is shared.
 */
export type WebuiAccountLoginView =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly prompt?: WebuiAccountLoginPromptView }
  | { readonly state: "authenticated" }
  | { readonly state: "error"; readonly error: string };
