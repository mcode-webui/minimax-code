// WebUI client contracts.
//
// Pure type surface for the client. This file owns the wire-facing types the
// client uses to talk to the runtime: session/message shapes the loader
// returns, request types the transport consumes, and the small union shapes
// the runtime protocol returns (transcript items, diff state, questionnaire /
// goal / permission). Nothing in here has runtime side effects; nothing here
// imports React or DOM globals — the type layer is the lowest in the
// dependency direction `main → components → projection → contracts`.

/**
 * The canvas wire contract, declared here rather than in the canvas component
 * because `WebuiTransport` has to name it: a transport method cannot take a
 * type defined in a module that sits above it in the dependency chain.
 *
 * Mirrors the runtime's `CanvasOperationV1` in
 * `packages/local-runtime-v2/src/service/canvas/contracts.ts`. The runtime is
 * the authority — it rejects a reused `operationId` with a different payload,
 * an empty `mutations` array, an `add_file` carrying both or neither file
 * identity, a non-positive width or height, and a non-integer `zIndex`.
 */
export interface CanvasNodeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

/**
 * A node drag, a node resize and a canvas pan all start from one pointer and
 * one gesture, so the marker on the pointerdown target picks the winner once.
 * `add_file` carries exactly one file identity, as the runtime requires.
 */
export type CanvasMutation =
  | { readonly kind: "add_file"; readonly nodeId: string; readonly layout: CanvasNodeLayout; readonly relativePath: string }
  | { readonly kind: "add_file"; readonly nodeId: string; readonly layout: CanvasNodeLayout; readonly assetId: string }
  | { readonly kind: "update_layout"; readonly nodeId: string; readonly layout: CanvasNodeLayout }
  | { readonly kind: "remove_node"; readonly nodeId: string };

export interface CanvasOperation {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly mutations: readonly CanvasMutation[];
}

import type {
  WebuiCanvasDocument,
  WebuiClaimSigninView,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiFileDiffInfoView,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
  WebuiGoalSessionRequest,
  WebuiGoalStatus,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiInteractionReplyResult,
  WebuiModelEntry,
  WebuiPendingPermission,
  WebuiQueueItem,
  WebuiProjectRecord,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireOption,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireStep,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiRuntimeEvent,
  WebuiSigninPanelView,
  WebuiStreamFrame,
  WebuiTerminalFrame,
  WebuiTurnDiffView,
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
  WebuiUpdateSessionRequest,
  WebuiUpdateSessionResult,
  WebuiUsageQuotaResult,
  WebuiVersionInfo,
  WebuiAttachmentInput,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "../server/port.js";

/* Attachment shape — used by the components layer, declared here so the
 * projection layer can return an `attachments` array without importing the
 * React component. The actual component lives at
 * `components/MessageAttachments.tsx`. */

export type WebuiMessageAttachmentType = "image" | "file";

export interface WebuiMessageAttachment {
  id: string;
  type: WebuiMessageAttachmentType;
  file_name: string;
  file_path?: string;
  preview_url?: string;
  desktop_path?: string;
  mime_type?: string;
  file_size?: number;
  /** Pre-resolved absolute URL the WebUI should render. */
  src?: string;
}

/* Model picker types — used by `components/ModelPicker.tsx` and
 * `projection/action-requests.ts`; declared here so the projection layer can
 * compose a selection request without importing the React component. */

export interface WebuiModelPickerEntry {
  readonly providerId: string;
  /** Human-facing provider label; the picker groups rows by it. */
  readonly providerName?: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly variant?: string;
  readonly supportedVariants?: readonly string[];
  readonly effortOptions?: readonly string[];
  readonly defaultEffort?: string;
  readonly contextWindowOptions?: readonly number[];
  readonly contextWindowOptionHints?: Readonly<Record<string, string>>;
  readonly contextLimit?: number;
  readonly thinkingConfig?: { readonly mode?: string };
  readonly thinking?: { readonly effort?: string };
  readonly [key: string]: unknown;
}

export interface WebuiModelPickerDraft {
  readonly variant?: string;
  readonly contextLimit?: number;
  /** null resets to the model's configured default effort. */
  readonly thinkingEffort?: string | null;
}

/* Session & message wire types — the loader shape the transport returns. */

export interface WebuiClientMessage {
  readonly msgId: string;
  readonly parentMsgId?: string;
  readonly turnId?: string;
  readonly queryKey?: string;
  readonly timestamp?: number;
  readonly msgContent?: string;
  readonly msgType?: number;
  readonly role?: string;
  readonly thinkingContent?: string;
  readonly thinkingDurationMs?: number;
  readonly finishReason?: string;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly attachments?: readonly WebuiMessageAttachment[];
  readonly usage?: Record<string, unknown>;
  readonly source?: string;
  readonly kind?: string;
  readonly actions?: {
    readonly fork?: boolean;
    readonly rewind?: boolean;
    readonly edit?: boolean;
  };
  readonly forkOrigin?: Record<string, unknown>;
  readonly originJson?: string;
  readonly communicationInfosJson?: string;
  readonly parts?: readonly Record<string, unknown>[];
  readonly rawJson?: string;
  readonly contextUsage?: Record<string, unknown>;
  readonly fileChanges?: readonly WebuiFileDiffInfoView[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly turnDiffStatus?: string;
  readonly revertedAt?: number;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface WebuiClientSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly sessionKind?: string;
  readonly parentSessionId?: string;
  readonly archived?: boolean;
  readonly status?: unknown;
}

export interface WebuiClientSessionPage {
  readonly sessions: readonly WebuiClientSession[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export type WebuiClientProject = WebuiProjectRecord;

export interface WebuiClientSessionTreeNode {
  readonly session: WebuiClientSession;
  readonly childSessions: readonly WebuiClientSession[];
}

export interface WebuiClientSessionTreePage {
  readonly sessions: readonly WebuiClientSessionTreeNode[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export type WebuiClientSessionTreeLoader = (
  cursor?: string,
) => Promise<WebuiClientSessionTreePage>;

export type WebuiClientSessionLoader = (
  cursor?: string,
) => Promise<WebuiClientSessionPage>;

export interface WebuiActiveTurn {
  readonly turnId: string;
  /**
   * `"compaction"` means the session is busy without producing an assistant
   * transcript, so a transcript client must not attach a stream for it.
   */
  readonly busyReason: "turn" | "compaction";
  readonly locallyOwned: boolean;
}

export interface WebuiActiveTurnRequest {
  readonly id: string;
}

export type WebuiActiveTurnResult = WebuiActiveTurn | undefined;

export interface WebuiClientMessagePage {
  readonly messages?: readonly WebuiClientMessage[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly queryCollapseViews?: readonly WebuiQueryCollapseView[];
  readonly nextCursor?: string;
  readonly hasMore?: boolean;
}

export interface WebuiQueryCollapseView {
  readonly queryKey: string;
  readonly currentTurnId: string;
  /** Runtime reconciliation can require details to stay open, which removes
   *  the outer disclosure control in Desktop. */
  readonly forceExpanded?: boolean;
  readonly processingStartedAtMs: number;
  readonly processingFinishedAtMs?: number;
}

export type WebuiClientMessageLoader = (request: {
  readonly id: string;
  readonly before?: string;
}) => Promise<WebuiClientMessagePage>;

export interface WebuiClientCreateSessionRequest {
  readonly name: string;
  /** Optional: absent means "use the default workspace" (harness resolves it). */
  readonly workspaceDir?: string;
  readonly teamModeOff?: boolean;
}

export interface WebuiClientCreateSessionResult {
  readonly sessionId?: string;
  readonly session?: {
    readonly sessionId?: string;
    readonly workspaceDir?: string;
  };
}

export type WebuiClientSessionCreator = (
  request: WebuiClientCreateSessionRequest,
) => Promise<WebuiClientCreateSessionResult>;

export type WebuiClientMessageSender = (
  request: {
    readonly id: string;
    readonly content: string;
    readonly clientIntent?: string;
    readonly attachments?: readonly WebuiAttachmentInput[];
  },
  onFrame: (frame: WebuiStreamFrame) => void,
) => Promise<void>;

export type WebuiClientMessageEnqueuer = (
  request: WebuiEnqueueMessageRequest,
) => Promise<WebuiEnqueueMessageResult>;

export type WebuiClientSessionResumer = (
  request: {
    readonly id: string;
    readonly afterCursor?: string;
    readonly afterMsgId?: string;
    readonly drainQueued?: boolean;
  },
  onFrame: (frame: WebuiStreamFrame) => void,
) => Promise<void>;

export type WebuiClientEventWatcher = (
  onEvent: (event: WebuiRuntimeEvent) => void,
  /**
   * Fires when the server accepts `watchEvents` and starts pumping it — not
   * when the socket is created and not when the request is written. The
   * runtime's own subscription is established later still, when the server
   * first pulls the event iterator, so this is the right moment to re-read
   * authoritative state and re-probe for a running turn; it is not a
   * barrier that no `session.start` can slip past.
   */
  onReconnect?: () => void,
) => () => void;

/* Transcript & diff view models — projection outputs the components consume. */

export type WebuiTranscriptItem =
  | {
      readonly kind: "user" | "assistant" | "thinking";
      readonly text: string;
      readonly messageId: string;
      /** Turn the message belongs to: the key the runtime accepts for a turn diff. */
      readonly turnId?: string;
      readonly durationMs?: number;
      readonly diff?: WebuiTurnDiffView;
      readonly actions?: { readonly fork?: boolean; readonly rewind?: boolean; readonly edit?: boolean };
      readonly timestamp?: number;
      readonly isGoal?: boolean;
      readonly attachments?: readonly WebuiMessageAttachment[];
      readonly usage?: Record<string, unknown>;
    }
  | {
      readonly kind: "tool";
      readonly messageId: string;
      readonly turnId?: string;
      readonly tools: readonly Record<string, unknown>[];
      readonly diff?: WebuiTurnDiffView;
      readonly actions?: { readonly fork?: boolean; readonly rewind?: boolean; readonly edit?: boolean };
      readonly timestamp?: number;
      readonly isGoal?: boolean;
      readonly usage?: Record<string, unknown>;
    }
  | {
      readonly kind: "questionnaire_response";
      readonly messageId: string;
      readonly turnId?: string;
      readonly summary: import("./projection/message-parts.js").WebuiQuestionnaireResponseSummary;
      readonly timestamp?: number;
    }
  | {
      readonly kind: "activity";
      readonly messageId: string;
      readonly turnId?: string;
      readonly activityType: "cognitive" | "compaction" | "delegation" | "agent_joined" | "asset_list";
      readonly text?: string;
      readonly detail?: Record<string, unknown>;
      readonly timestamp?: number;
    };

/** One Desktop-style thinking/tool segment inside an assistant turn. */
export interface WebuiTranscriptProcessSegment {
  readonly messageId: string;
  readonly thinking?: string;
  readonly thinkingDurationMs?: number;
  readonly tools?: readonly Record<string, unknown>[];
  readonly activityParts?: readonly WebuiTranscriptActivityPart[];
}

export type WebuiTranscriptActivityPart =
  | { readonly type: "thinking"; readonly text: string; readonly durationMs?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "cognitive"; readonly text: string }
  | { readonly type: "compaction"; readonly text: string }
  | { readonly type: "tool"; readonly tool: Record<string, unknown> }
  | { readonly type: "delegation"; readonly message: Record<string, unknown> }
  | { readonly type: "agent_joined"; readonly agent: Record<string, unknown> }
  | { readonly type: "asset_list"; readonly assets: readonly Record<string, unknown>[] };

export interface WebuiDiffState {
  readonly view?: WebuiTurnDiffView;
  readonly unsupported: boolean;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly reviewing: boolean;
}

export type WebuiDiffStateAction =
  | { readonly type: "loaded"; readonly view: WebuiTurnDiffView }
  | { readonly type: "unsupported" }
  | { readonly type: "begin-mutation" }
  | { readonly type: "mutation-succeeded"; readonly view: WebuiTurnDiffView }
  | { readonly type: "mutation-failed" }
  | { readonly type: "toggle-expanded" }
  | { readonly type: "toggle-review" };

/* Model picker & goal projection shapes. */

export interface WebuiModelSelectionRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly contextLimit?: number;
  readonly thinking?: { readonly effort?: string } | null;
  readonly sessionId?: string;
}

/* Scheduled task (cron) wire shapes — v2.
 *
 * Field-for-field copies of the frozen wire contract
 * (`D:\temp\mmx-webui-cron\CONTRACT.md` §2). The panel is a projection of the
 * registry the desktop and the CLI also write to, so a renamed field here would
 * silently write somewhere else instead of failing. Nothing in this block may be
 * renamed, reordered away, or extended: v2 is the single source of truth.
 *
 * Every definition and run is addressed by `cronId`, not by
 * `agentName` + `cronName`. */

export type WebuiCronSchedule =
  | { readonly kind: "recurring"; readonly expression: string; readonly timezone?: string; readonly maxRuns?: number }
  | { readonly kind: "once"; readonly runAtMs: number };

export type WebuiCronSessionTarget =
  | { readonly mode: "new" }
  | { readonly mode: "sessionId"; readonly sessionId?: string };

export interface WebuiCronDefinition {
  readonly cronId: string;
  readonly name: string;
  readonly agentName: string;
  readonly schedule: WebuiCronSchedule;
  readonly enabled: boolean;
  readonly prompt: string;
  readonly sessionTarget: WebuiCronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly nextRunAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deletedAtMs?: number;
}

export type WebuiCronRunStatus = "pending" | "delivered" | "failed";
export type WebuiCronRunTrigger = "manual" | "scheduled";

export interface WebuiCronRun {
  readonly runId: string;
  readonly cronId: string;
  readonly triggerSource: WebuiCronRunTrigger;
  readonly sessionId?: string;
  readonly status: WebuiCronRunStatus;
  readonly createdAtMs: number;
  readonly deliveredAtMs?: number;
  readonly failedAtMs?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface WebuiCronPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiAgentRef {
  readonly agentName: string;
  readonly displayName?: string;
}

/** 幂等：删除不存在的 cronId 返回 { success: false }，不抛错。 */
export interface WebuiCronMutationResult { readonly success: boolean }

export interface WebuiCreateCronDefinitionRequest {
  readonly name: string;
  readonly agentName: string;
  readonly schedule: WebuiCronSchedule;
  readonly prompt: string;
  readonly sessionTarget: WebuiCronSessionTarget;
  readonly enabled?: boolean;
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface WebuiUpdateCronDefinitionRequest {
  readonly cronId: string;
  readonly name?: string;
  readonly schedule?: WebuiCronSchedule;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly sessionTarget?: WebuiCronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
}

/* Request bodies. These name no wire state of their own: they only carry the
 * frozen `cronId` / cursor / limit addressing the operations accept. */

export interface WebuiListAgentsRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WebuiListCronDefinitionsRequest {
  readonly agentName?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WebuiListCronRunsRequest {
  readonly cronId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WebuiCronIdRequest {
  readonly cronId: string;
}

/* Transport — the single bag of methods the foundation app and the
 * composer consume. Every method here was previously an optional prop on
 * `WebuiClientFoundationAppProps`. The optional semantics are preserved:
 *   - `undefined` means "the operation is not wired" (the panel renders
 *     the affected area conditionally).
 *   - Optional fields stay optional. Optional inputs stay optional.
 *   - The transport itself is optional (so a test that renders the
 *     shell with no transport still gets a "no operations" view).
 *
 * No React imports here — this is a pure type that lives in the
 * contracts layer so the props layer (app.tsx) and the transport
 * implementation (transport.ts) both import it without crossing
 * boundaries. */

export interface WebuiTransport {
  readonly version?: () => Promise<WebuiVersionInfo>;
  readonly loadProjects?: () => Promise<readonly WebuiClientProject[]>;
  readonly listArchivedSessions?: () => Promise<WebuiClientSessionPage>;
  readonly loadSessions?: WebuiClientSessionLoader;
  readonly loadSessionTree?: WebuiClientSessionTreeLoader;
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly getSessionDiff?: (
    request: WebuiGetSessionDiffRequest,
  ) => Promise<WebuiGetSessionDiffResult>;
  readonly getTurnDiff?: (
    request: WebuiGetTurnDiffRequest,
  ) => Promise<WebuiGetTurnDiffResult>;
  readonly revertTurnDiff?: (
    request: WebuiRevertTurnDiffRequest,
  ) => Promise<WebuiRevertTurnDiffResult>;
  readonly reapplyTurnDiff?: (
    request: WebuiReapplyTurnDiffRequest,
  ) => Promise<WebuiReapplyTurnDiffResult>;
  readonly getSessionRewindPreview?: (
    request: WebuiGetSessionRewindPreviewRequest,
  ) => Promise<WebuiGetSessionRewindPreviewResult>;
  readonly rewindSession?: (
    request: WebuiRewindSessionRequest,
  ) => Promise<WebuiRewindSessionResult>;
  readonly editSessionMessage?: (
    request: WebuiEditSessionMessageRequest,
  ) => Promise<WebuiEditSessionMessageResult>;
  readonly isGoalEnabled?: () => Promise<WebuiGoalEnabledResult>;
  /**
   * Authoritative active-turn read. Answers "is a turn running, and which
   * one" when the `session.start` event was missed or arrived before the
   * client finished subscribing.
   */
  readonly getActiveTurn?: (
    request: WebuiActiveTurnRequest,
  ) => Promise<WebuiActiveTurnResult>;
  readonly getGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<WebuiGoal | undefined>;
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  readonly clearGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<{ readonly success: boolean }>;
  readonly listWorkspaceFileTree?: (request: {
    readonly workspaceDir: string;
    readonly path?: string;
  }) => Promise<readonly WebuiWorkspaceFile[]>;
  /** One level of the local directory tree. Absent `dir` starts the walk
   * at the server user's home directory. */
  readonly browseWorkspaceDirs?: (request: {
    readonly dir?: string;
  }) => Promise<WebuiWorkspaceDirectoryListing>;
  readonly readWorkspaceFile?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
  }) => Promise<WebuiWorkspaceFileContent>;
  readonly getWorkspaceEnvironment?: (request: {
    readonly workspaceDir: string;
  }) => Promise<WebuiWorkspaceEnvironment>;
  readonly mutateWorkspaceGit?: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;
  readonly getWorkspaceReviewSummary?: (request: { readonly workspaceDir: string }) => Promise<WebuiWorkspaceReviewSummary>;
  readonly listWorkspaceReviewFileDiffs?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: readonly string[] }) => Promise<WebuiWorkspaceReviewDiffs>;
  readonly getWorkspaceReviewFileContent?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) => Promise<WebuiWorkspaceReviewFileContent>;
  readonly searchWorkspaceReviewDiffs?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }) => Promise<WebuiWorkspaceReviewSearchResult>;
  readonly readCanvas?: (request: {
    readonly sessionId: string;
  }) => Promise<WebuiCanvasDocument>;
  readonly applyCanvas?: (request: {
    readonly sessionId: string;
    readonly operation: CanvasOperation;
  }) => Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
  /**
   * The streamable URL of one workspace file, credential included.
   *
   * Provided by the transport rather than assembled by a component: media and
   * HTML previews need a URL the browser fetches directly, and only the
   * transport knows the per-start token. Building it in a component would put
   * the credential in two places and let one of them drift.
   */
  readonly workspaceFileUrl?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
  }) => string;
  readonly readWorkspaceArchive?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }) => Promise<WebuiWorkspaceArchiveListing>;
  readonly extractWorkspaceArchive?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }) => Promise<WebuiWorkspaceArchiveExtractResult>;
  readonly createTerminal?: (request: {
    readonly workspaceDir: string;
  }) => Promise<{ readonly terminalId: string; readonly status: string }>;
  readonly listTerminals?: () => Promise<readonly Record<string, unknown>[]>;
  readonly writeTerminal?: (request: {
    readonly terminalId: string;
    readonly data: string;
  }) => Promise<unknown>;
  readonly disposeTerminal?: (request: {
    readonly terminalId: string;
  }) => Promise<unknown>;
  readonly watchTerminal?: (
    request: { readonly terminalId: string },
    onFrame: (frame: WebuiTerminalFrame) => void,
  ) => () => void;
  readonly createSession?: WebuiClientSessionCreator;
  readonly sendMessage?: WebuiClientMessageSender;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly resumeSession?: WebuiClientSessionResumer;
  readonly watchEvents?: WebuiClientEventWatcher;
  readonly listPendingPermissions?: () => Promise<{
    readonly requests: readonly WebuiPendingPermission[];
  }>;
  readonly getPendingQuestionnaire?: (request: {
    readonly name: string;
    readonly sessionId: string;
  }) => Promise<{ readonly request?: WebuiQuestionnaireRequest }>;
  readonly replyPermission?: (request: {
    readonly name: string;
    readonly requestId: string;
    readonly reply: "allowOnce" | "allowAlways" | "deny";
  }) => Promise<WebuiInteractionReplyResult>;
  readonly replyQuestionnaire?: (request: {
    readonly name: string;
    readonly requestId: string;
    readonly schemaVersion: number;
    readonly answers: readonly WebuiQuestionnaireAnswer[];
  }) => Promise<WebuiInteractionReplyResult>;
  readonly dismissQuestionnaire?: (request: {
    readonly name: string;
    readonly requestId: string;
  }) => Promise<WebuiInteractionReplyResult>;
  readonly abortSession?: (request: {
    readonly id: string;
  }) => Promise<{ readonly success?: boolean }>;
  readonly listQueueMessages?: (request: {
    readonly id: string;
  }) => Promise<{
    readonly items?: readonly WebuiQueueItem[];
    readonly paused?: boolean;
    readonly pendingCount?: number;
  }>;
  readonly deleteQueueItem?: (request: {
    readonly id: string;
    readonly itemId: string;
  }) => Promise<{ readonly item?: WebuiQueueItem }>;
  readonly listModels?: (request?: {
    readonly sessionId?: string;
  }) => Promise<readonly WebuiModelEntry[]>;
  readonly listSkills?: (request?: {
    readonly agentName?: string;
  }) => Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
    }[];
  }>;
  /** Scheduled tasks (v2). Mutations return `success`; the panel re-reads the
   * list afterwards rather than trusting a partial echo of the new state.
   *
   * `listAgents` answers a bare `WebuiAgentRef[]` — the server derives it from
   * the agent names the session list already reports, so there is no paging
   * envelope to unwrap (`server/operation/agents.ts`). */
  readonly listAgents?: (
    request?: WebuiListAgentsRequest,
  ) => Promise<readonly WebuiAgentRef[]>;
  readonly listCronDefinitions?: (
    request?: WebuiListCronDefinitionsRequest,
  ) => Promise<WebuiCronPage<WebuiCronDefinition>>;
  readonly getCronDefinition?: (
    request: WebuiCronIdRequest,
  ) => Promise<WebuiCronDefinition>;
  readonly createCronDefinition?: (
    request: WebuiCreateCronDefinitionRequest,
  ) => Promise<WebuiCronDefinition>;
  readonly updateCronDefinition?: (
    request: WebuiUpdateCronDefinitionRequest,
  ) => Promise<WebuiCronDefinition>;
  // Only delete answers `{ success }`: it is idempotent, so the boolean reports
  // whether a definition was actually there. Create and update hand back the
  // resulting definition and trigger hands back the run it started.
  readonly deleteCronDefinition?: (
    request: WebuiCronIdRequest,
  ) => Promise<WebuiCronMutationResult>;
  readonly triggerCronRun?: (
    request: WebuiCronIdRequest,
  ) => Promise<WebuiCronRun>;
  readonly listCronRuns?: (
    request: WebuiListCronRunsRequest,
  ) => Promise<WebuiCronPage<WebuiCronRun>>;
  readonly pluginManagement?: (request: import("../shared/plugin-management.js").WebuiPluginManagementRequest) => Promise<unknown>;
  readonly getPermissionMode?: () => Promise<unknown>;
  readonly setPermissionMode?: (request: { readonly mode: "default" | "auto" | "bypassPermissions" }) => Promise<unknown>;
  readonly selectModel?: (
    request: WebuiModelSelectionRequest,
  ) => Promise<{ readonly success?: boolean }>;
  readonly getSessionUsage?: (request: {
    readonly id: string;
  }) => Promise<Record<string, unknown>>;
  readonly getUsageQuota?: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<WebuiUsageQuotaResult>;
  readonly getSigninPanel?: () => Promise<WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<WebuiClaimSigninView>;
  readonly getAccountStatus?: (request?: {
    readonly sessionId?: string;
  }) => Promise<Record<string, unknown>>;
  readonly signOut?: () => Promise<{ readonly success?: boolean }>;
  readonly archiveSession?: (request: {
    readonly id: string;
    readonly archived?: boolean;
  }) => Promise<{ readonly success?: boolean }>;
  readonly deleteSession?: (request: {
    readonly id: string;
  }) => Promise<{ readonly success?: boolean }>;
  readonly updateSession?: (
    request: WebuiUpdateSessionRequest,
  ) => Promise<WebuiUpdateSessionResult>;
  readonly getSessionForkOptions?: (
    request: WebuiGetSessionForkOptionsRequest,
  ) => Promise<WebuiGetSessionForkOptionsResult>;
  readonly forkSession?: (
    request: WebuiForkSessionRequest,
  ) => Promise<WebuiForkSessionResult>;
  readonly listUserModelProviders?: () => Promise<readonly Record<string, unknown>[]>;
  readonly createUserModelProvider?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly updateUserModelProvider?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly deleteUserModelProvider?: (providerId: string) => Promise<unknown>;
  readonly testUserModelProvider?: (request: { readonly providerId: string; readonly apiKey?: string }) => Promise<unknown>;
  readonly testUserModel?: (request: {
    readonly providerId: string;
    readonly modelId: string;
  }) => Promise<unknown>;
  readonly discoverUserModelsCandidate?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly saveUserModelProviderCandidate?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly listProviderPresets?: () => Promise<readonly Record<string, unknown>[]>;
  readonly getMiniMaxApiKeyStatus?: () => Promise<Record<string, unknown>>;
  readonly upsertMiniMaxApiKey?: (request: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }) => Promise<unknown>;
  readonly getCodexOAuthStatus?: () => Promise<Record<string, unknown>>;
  readonly getMiniMaxModelSource?: () => Promise<"token_plan" | "minimax_api_key">;
  readonly setMiniMaxModelSource?: (source: "token_plan" | "minimax_api_key") => Promise<"token_plan" | "minimax_api_key">;
  readonly testUserModelCandidate?: (request: { readonly candidate: Record<string, unknown>; readonly modelId: string }) => Promise<unknown>;
  readonly revealModelProviderApiKey?: (request: { readonly providerId: string }) => Promise<string>;
  readonly startCodexOAuthLogin?: (request?: Record<string, unknown>) => Promise<unknown>;
  readonly cancelCodexOAuthLogin?: (request: { readonly loginId: string }) => Promise<unknown>;
  readonly refreshModels?: () => Promise<unknown>;
  readonly runCommand?: (request: {
    readonly command: "help" | "new" | "compact" | "status" | "usage" | "model";
    readonly input?: string;
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  }) => Promise<Record<string, unknown>>;
}

export type {
  WebuiEditSessionMessageRequest,
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiFileDiffInfoView,
  WebuiForkSessionRequest,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
  WebuiGoalSessionRequest,
  WebuiGoalStatus,
  WebuiInteractionReplyResult,
  WebuiModelEntry,
  WebuiPendingPermission,
  WebuiQueueItem,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireOption,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireStep,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiRuntimeEvent,
  WebuiStreamFrame,
  WebuiTerminalFrame,
  WebuiTurnDiffView,
  };
