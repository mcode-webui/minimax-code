// Canonical wire operation names plus the complete `OperationSpec` map that
// binds each name to its validated request type and its actual wire response
// body type.
//
// `OperationSpec` is the single declaration point for what an operation
// carries in and what it answers with. The typed bindings in
// `server/operation/bind-handlers.ts` are checked against it, so a binding
// cannot silently disagree with the operation it implements. This file lives in
// `shared/` and therefore imports only shared contracts, never the runtime
// port: the runtime capability interfaces stay independently declared in
// `runtime/port.ts`.
export const VERSION_OPERATION_NAME = "version" as const;
export const LIST_SESSIONS_OPERATION_NAME = "listSessions" as const;
export const LIST_VISIBLE_PROJECTS_OPERATION_NAME = "listVisibleProjects" as const;
export const GET_SESSION_TREE_OPERATION_NAME = "getSessionTree" as const;
export const CREATE_SESSION_OPERATION_NAME = "createSession" as const;
export const GET_SESSION_OPERATION_NAME = "getSession" as const;
export const GET_ACTIVE_TURN_OPERATION_NAME = "getActiveTurn" as const;
export const GET_MESSAGES_OPERATION_NAME = "getMessages" as const;
export const GET_SESSION_DIFF_OPERATION_NAME = "getSessionDiff" as const;
export const GET_TURN_DIFF_OPERATION_NAME = "getTurnDiff" as const;
export const REVERT_TURN_DIFF_OPERATION_NAME = "revertTurnDiff" as const;
export const REAPPLY_TURN_DIFF_OPERATION_NAME = "reapplyTurnDiff" as const;
export const GET_SESSION_REWIND_PREVIEW_OPERATION_NAME = "getSessionRewindPreview" as const;
export const REWIND_SESSION_OPERATION_NAME = "rewindSession" as const;
export const EDIT_SESSION_MESSAGE_OPERATION_NAME = "editSessionMessage" as const;
export const IS_GOAL_ENABLED_OPERATION_NAME = "isGoalEnabled" as const;
export const GET_GOAL_OPERATION_NAME = "getGoal" as const;
export const CREATE_GOAL_OPERATION_NAME = "createGoal" as const;
export const PATCH_GOAL_OPERATION_NAME = "patchGoal" as const;
export const CLEAR_GOAL_OPERATION_NAME = "clearGoal" as const;
export const LIST_WORKSPACE_FILE_TREE_OPERATION_NAME = "listWorkspaceFileTree" as const;
export const BROWSE_WORKSPACE_DIRS_OPERATION_NAME = "browseWorkspaceDirs" as const;
export const READ_WORKSPACE_FILE_OPERATION_NAME = "readWorkspaceFile" as const;
export const GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME = "getWorkspaceEnvironment" as const;
export const MUTATE_WORKSPACE_GIT_OPERATION_NAME = "mutateWorkspaceGit" as const;
export const GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME = "getWorkspaceReviewSummary" as const;
export const LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME = "listWorkspaceReviewFileDiffs" as const;
export const GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME = "getWorkspaceReviewFileContent" as const;
export const SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME = "searchWorkspaceReviewDiffs" as const;
export const READ_CANVAS_OPERATION_NAME = "readCanvas" as const;
export const APPLY_CANVAS_OPERATION_NAME = "applyCanvas" as const;
export const READ_WORKSPACE_ARCHIVE_OPERATION_NAME = "readWorkspaceArchive" as const;
export const EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME = "extractWorkspaceArchive" as const;
export const CREATE_TERMINAL_OPERATION_NAME = "createTerminal" as const;
export const LIST_TERMINALS_OPERATION_NAME = "listTerminals" as const;
export const WRITE_TERMINAL_OPERATION_NAME = "writeTerminal" as const;
export const RESIZE_TERMINAL_OPERATION_NAME = "resizeTerminal" as const;
export const DISPOSE_TERMINAL_OPERATION_NAME = "disposeTerminal" as const;
export const WATCH_TERMINAL_OPERATION_NAME = "watchTerminal" as const;
export const SEND_MESSAGE_OPERATION_NAME = "sendMessage" as const;
export const ENQUEUE_MESSAGE_OPERATION_NAME = "enqueueMessage" as const;
export const RESUME_SESSION_OPERATION_NAME = "resumeSession" as const;
export const WATCH_EVENTS_OPERATION_NAME = "watchEvents" as const;
export const LIST_PENDING_PERMISSIONS_OPERATION_NAME =
  "listPendingPermissions" as const;
export const GET_PENDING_QUESTIONNAIRE_OPERATION_NAME =
  "getPendingQuestionnaire" as const;
export const REPLY_PERMISSION_OPERATION_NAME = "replyPermission" as const;
export const REPLY_QUESTIONNAIRE_OPERATION_NAME = "replyQuestionnaire" as const;
export const DISMISS_QUESTIONNAIRE_OPERATION_NAME = "dismissQuestionnaire" as const;
export const ABORT_SESSION_OPERATION_NAME = "abortSession" as const;
export const LIST_QUEUE_MESSAGES_OPERATION_NAME = "listQueueMessages" as const;
export const DELETE_QUEUE_ITEM_OPERATION_NAME = "deleteQueueItem" as const;
export const LIST_MODELS_OPERATION_NAME = "listModels" as const;
export const SELECT_MODEL_OPERATION_NAME = "selectModel" as const;
export const LIST_SKILLS_OPERATION_NAME = "listSkills" as const;
export const PLUGIN_MANAGEMENT_OPERATION_NAME = "pluginManagement" as const;
export const GET_PERMISSION_MODE_OPERATION_NAME = "getPermissionMode" as const;
export const SET_PERMISSION_MODE_OPERATION_NAME = "setPermissionMode" as const;
export const GET_SESSION_USAGE_OPERATION_NAME = "getSessionUsage" as const;
export const GET_USAGE_QUOTA_OPERATION_NAME = "getUsageQuota" as const;
export const GET_SIGNIN_PANEL_OPERATION_NAME = "getSigninPanel" as const;
export const CLAIM_SIGNIN_OPERATION_NAME = "claimSignin" as const;
export const GET_ACCOUNT_STATUS_OPERATION_NAME = "getAccountStatus" as const;
export const BEGIN_ACCOUNT_LOGIN_OPERATION_NAME = "beginAccountLogin" as const;
export const GET_ACCOUNT_LOGIN_STATUS_OPERATION_NAME = "getAccountLoginStatus" as const;
export const CANCEL_ACCOUNT_LOGIN_OPERATION_NAME = "cancelAccountLogin" as const;
export const RUN_COMMAND_OPERATION_NAME = "runCommand" as const;
export const SIGN_OUT_OPERATION_NAME = "signOut" as const;
export const ARCHIVE_SESSION_OPERATION_NAME = "archiveSession" as const;
export const DELETE_SESSION_OPERATION_NAME = "deleteSession" as const;
export const UPDATE_SESSION_OPERATION_NAME = "updateSession" as const;
export const GET_SESSION_FORK_OPTIONS_OPERATION_NAME = "getSessionForkOptions" as const;
export const FORK_SESSION_OPERATION_NAME = "forkSession" as const;
export const LIST_USER_MODEL_PROVIDERS_OPERATION_NAME = "listUserModelProviders" as const;
export const CREATE_USER_MODEL_PROVIDER_OPERATION_NAME = "createUserModelProvider" as const;
export const UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME = "updateUserModelProvider" as const;
export const DELETE_USER_MODEL_PROVIDER_OPERATION_NAME = "deleteUserModelProvider" as const;
export const TEST_USER_MODEL_PROVIDER_OPERATION_NAME = "testUserModelProvider" as const;
export const TEST_USER_MODEL_OPERATION_NAME = "testUserModel" as const;
export const DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME = "discoverUserModelsCandidate" as const;
export const SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME = "saveUserModelProviderCandidate" as const;
export const LIST_PROVIDER_PRESETS_OPERATION_NAME = "listProviderPresets" as const;
export const GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME = "getMiniMaxApiKeyStatus" as const;
export const UPSERT_MINIMAX_API_KEY_OPERATION_NAME = "upsertMiniMaxApiKey" as const;
export const GET_CODEX_OAUTH_STATUS_OPERATION_NAME = "getCodexOAuthStatus" as const;
export const GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME = "getMiniMaxModelSource" as const;
export const SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME = "setMiniMaxModelSource" as const;
export const TEST_USER_MODEL_CANDIDATE_OPERATION_NAME = "testUserModelCandidate" as const;
export const REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME = "revealModelProviderApiKey" as const;
export const START_CODEX_OAUTH_LOGIN_OPERATION_NAME = "startCodexOAuthLogin" as const;
export const CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME = "cancelCodexOAuthLogin" as const;
export const REFRESH_MODELS_OPERATION_NAME = "refreshModels" as const;
export const GET_GLOBAL_INSTRUCTIONS_OPERATION_NAME = "getGlobalInstructions" as const;
export const SET_GLOBAL_INSTRUCTIONS_OPERATION_NAME = "setGlobalInstructions" as const;
export const GET_AGENT_MEMORY_OPERATION_NAME = "getAgentMemory" as const;
export const SET_AGENT_MEMORY_OPERATION_NAME = "setAgentMemory" as const;
export const GET_USER_PROFILE_OPERATION_NAME = "getUserProfile" as const;
export const SET_USER_PROFILE_OPERATION_NAME = "setUserProfile" as const;
export const GET_MEMORY_SETTINGS_OPERATION_NAME = "getMemorySettings" as const;
export const SET_MEMORY_SETTINGS_OPERATION_NAME = "setMemorySettings" as const;

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
  WebuiSessionTreePage,
  WebuiSessionTreeRequest,
  WebuiUpdateSessionRequest,
  WebuiUpdateSessionResult,
} from "./contracts/session.js";
import type {
  WebuiMessagesRequest,
  WebuiMessagesResult,
} from "./contracts/messages.js";
import type {
  WebuiResumeSessionRequest,
  WebuiSendMessageRequest,
  WebuiSendMessageResult,
  WebuiStreamResult,
  WebuiWatchEventsResult,
} from "./contracts/stream.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
} from "./contracts/goal.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiPermissionDecision,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "./contracts/interactions.js";
import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "./contracts/queue.js";
import type {
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "./contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "./contracts/review.js";
import type { WebuiCanvasDocument } from "./contracts/canvas.js";
import type { WebuiModelEntry, WebuiSkillEntry } from "./contracts/models.js";
import type { WebuiVersionInfo } from "./contracts/version.js";
import type { WebuiUsageQuotaResult } from "./contracts/usage-quota.js";
import type {
  WebuiAccountLoginView,
  WebuiClaimSigninView,
  WebuiSigninPanelView,
} from "./contracts/account.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileView,
} from "./contracts/personalization.js";
import type {
  WebuiRunCommandRequest,
  WebuiRunCommandResult,
} from "./contracts/terminal.js";
import type { WebuiPluginManagementRequest } from "./plugin-management.js";

/**
 * The complete operation table: every wire operation name mapped to the
 * request type its validator produces and the response body type it actually
 * answers with.
 *
 * `request` is the *validated* body — what the operation's validator hands to
 * the handler, not the raw frame. Where a validator only checks that the frame
 * is a record and forwards it (for example `testUserModelCandidate`), the
 * request type says so honestly (`Record<string, unknown>`) rather than
 * pretending a narrower shape was verified; the runtime adapter keeps the
 * conversion.
 *
 * `response` is the body the handler sends back, i.e. the unwrapped
 * `WebuiOperationResult.body`, never the frame envelope.
 */
export interface OperationSpec {
  version: { request: undefined; response: WebuiVersionInfo };
  listSessions: { request: WebuiSessionListRequest; response: WebuiSessionPage };
  listVisibleProjects: {
    request: { readonly limit?: number };
    response: readonly WebuiProjectRecord[];
  };
  getSessionTree: {
    request: WebuiSessionTreeRequest;
    response: WebuiSessionTreePage;
  };
  createSession: {
    request: WebuiCreateSessionRequest;
    response: WebuiCreateSessionResult;
  };
  getSession: {
    request: WebuiSessionLookupRequest;
    response: WebuiSessionLookupResult;
  };
  getActiveTurn: {
    request: WebuiSessionLookupRequest;
    response: WebuiActiveTurnResult;
  };
  getMessages: { request: WebuiMessagesRequest; response: WebuiMessagesResult };
  getSessionDiff: {
    request: WebuiGetSessionDiffRequest;
    response: WebuiGetSessionDiffResult;
  };
  getTurnDiff: {
    request: WebuiGetTurnDiffRequest;
    response: WebuiGetTurnDiffResult;
  };
  revertTurnDiff: {
    request: WebuiRevertTurnDiffRequest;
    response: WebuiRevertTurnDiffResult;
  };
  reapplyTurnDiff: {
    request: WebuiReapplyTurnDiffRequest;
    response: WebuiReapplyTurnDiffResult;
  };
  getSessionRewindPreview: {
    request: WebuiGetSessionRewindPreviewRequest;
    response: WebuiGetSessionRewindPreviewResult;
  };
  rewindSession: {
    request: WebuiRewindSessionRequest;
    response: WebuiRewindSessionResult;
  };
  editSessionMessage: {
    request: WebuiEditSessionMessageRequest;
    response: WebuiEditSessionMessageResult;
  };
  isGoalEnabled: { request: undefined; response: WebuiGoalEnabledResult };
  getGoal: { request: { readonly sessionId: string }; response: WebuiGoal | undefined };
  createGoal: { request: WebuiGoalCreateRequest; response: WebuiGoal };
  patchGoal: { request: WebuiGoalPatchRequest; response: WebuiGoal };
  clearGoal: {
    request: { readonly sessionId: string };
    response: { readonly success: boolean };
  };
  listWorkspaceFileTree: {
    request: { readonly workspaceDir: string; readonly path?: string };
    response: readonly WebuiWorkspaceFile[];
  };
  browseWorkspaceDirs: {
    request: { readonly dir?: string };
    response: WebuiWorkspaceDirectoryListing;
  };
  readWorkspaceFile: {
    request: { readonly workspaceDir: string; readonly path: string };
    response: WebuiWorkspaceFileContent;
  };
  getWorkspaceEnvironment: {
    request: { readonly workspaceDir: string };
    response: WebuiWorkspaceEnvironment;
  };
  mutateWorkspaceGit: {
    request: WebuiWorkspaceGitMutationRequest;
    response: Record<string, unknown>;
  };
  getWorkspaceReviewSummary: {
    request: { readonly workspaceDir: string };
    response: WebuiWorkspaceReviewSummary;
  };
  listWorkspaceReviewFileDiffs: {
    request: {
      readonly workspaceDir: string;
      readonly reviewSnapshotId: string;
      readonly fileIds: readonly string[];
    };
    response: WebuiWorkspaceReviewDiffs;
  };
  getWorkspaceReviewFileContent: {
    request: {
      readonly workspaceDir: string;
      readonly reviewSnapshotId: string;
      readonly fileId: string;
      readonly side: "old" | "new";
    };
    response: WebuiWorkspaceReviewFileContent;
  };
  searchWorkspaceReviewDiffs: {
    request: {
      readonly workspaceDir: string;
      readonly reviewSnapshotId: string;
      readonly query: string;
      readonly includeUntrackedFiles: boolean;
      readonly pageIndex?: number;
      readonly pageSize?: number;
    };
    response: WebuiWorkspaceReviewSearchResult;
  };
  readCanvas: {
    request: { readonly sessionId: string };
    response: WebuiCanvasDocument;
  };
  applyCanvas: {
    request: { readonly sessionId: string; readonly operation: Record<string, unknown> };
    response: { readonly operationId: string; readonly document: WebuiCanvasDocument };
  };
  readWorkspaceArchive: {
    request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string };
    response: WebuiWorkspaceArchiveListing;
  };
  extractWorkspaceArchive: {
    request: {
      readonly workspaceDir: string;
      readonly path: string;
      readonly destination: string;
      readonly prefix?: string;
    };
    response: WebuiWorkspaceArchiveExtractResult;
  };
  createTerminal: {
    request: Record<string, unknown>;
    response: { readonly terminalId: string; readonly status: "running" };
  };
  listTerminals: {
    request: Record<string, never>;
    response: readonly {
      readonly terminalId: string;
      readonly status: "running" | "exited";
      readonly output: string;
    }[];
  };
  writeTerminal: { request: Record<string, unknown>; response: { readonly success: true } };
  resizeTerminal: { request: Record<string, unknown>; response: { readonly success: true } };
  disposeTerminal: { request: Record<string, unknown>; response: { readonly success: true } };
  watchTerminal: { request: Record<string, unknown>; response: WebuiTerminalStreamEnvelope };
  sendMessage: {
    request: WebuiSendMessageRequest;
    response: WebuiSendMessageStreamEnvelope;
  };
  enqueueMessage: {
    request: WebuiEnqueueMessageRequest;
    response: WebuiEnqueueMessageResult;
  };
  resumeSession: {
    request: WebuiResumeSessionRequest;
    response: WebuiResumeStreamEnvelope;
  };
  watchEvents: { request: Record<string, unknown>; response: WebuiWatchEventsResult };
  listPendingPermissions: {
    request: Record<string, unknown>;
    response: { readonly requests: readonly WebuiPendingPermission[] };
  };
  getPendingQuestionnaire: {
    request: { readonly name: string; readonly sessionId: string };
    response: { readonly request?: WebuiQuestionnaireRequest };
  };
  replyPermission: {
    request: {
      readonly name: string;
      readonly requestId: string;
      readonly reply: WebuiPermissionDecision;
    };
    response: WebuiInteractionReplyResult;
  };
  replyQuestionnaire: {
    request: {
      readonly name: string;
      readonly requestId: string;
      readonly schemaVersion: number;
      readonly answers: readonly WebuiQuestionnaireAnswer[];
    };
    response: WebuiInteractionReplyResult;
  };
  dismissQuestionnaire: {
    request: { readonly name: string; readonly requestId: string };
    response: WebuiInteractionReplyResult;
  };
  abortSession: {
    request: { readonly id: string };
    response: { readonly success?: boolean };
  };
  listQueueMessages: {
    request: { readonly id: string };
    response: {
      readonly items?: readonly WebuiQueueItem[];
      readonly paused?: boolean;
      readonly pendingCount?: number;
    };
  };
  deleteQueueItem: {
    request: { readonly id: string; readonly itemId: string };
    response: { readonly item?: WebuiQueueItem };
  };
  listModels: {
    request: { readonly sessionId?: string };
    response: readonly WebuiModelEntry[];
  };
  selectModel: {
    request: {
      readonly providerId: string;
      readonly modelId: string;
      readonly variant?: string;
      readonly contextLimit?: number;
      readonly thinking?: { readonly effort?: string } | null;
      readonly sessionId?: string;
    };
    response: { readonly success?: boolean };
  };
  listSkills: {
    request: { readonly agentName?: string };
    response: { readonly skills: readonly WebuiSkillEntry[] };
  };
  pluginManagement: {
    request: WebuiPluginManagementRequest;
    response: unknown;
  };
  getPermissionMode: { request: Record<string, never>; response: unknown };
  setPermissionMode: {
    request: { readonly mode: "default" | "auto" | "bypassPermissions" };
    response: unknown;
  };
  getSessionUsage: { request: { readonly id: string }; response: Record<string, unknown> };
  getUsageQuota: {
    request: { readonly forceRefresh?: boolean };
    response: WebuiUsageQuotaResult;
  };
  getSigninPanel: { request: Record<string, never>; response: WebuiSigninPanelView };
  claimSignin: { request: Record<string, never>; response: WebuiClaimSigninView };
  getAccountStatus: {
    request: { readonly sessionId?: string };
    response: Record<string, unknown>;
  };
  beginAccountLogin: { request: Record<string, never>; response: WebuiAccountLoginView };
  getAccountLoginStatus: { request: Record<string, never>; response: WebuiAccountLoginView };
  cancelAccountLogin: { request: Record<string, never>; response: { readonly ok: true } };
  runCommand: { request: WebuiRunCommandRequest; response: WebuiRunCommandResult };
  signOut: { request: Record<string, never>; response: { readonly success: true } };
  archiveSession: {
    request: { readonly id: string; readonly archived?: boolean };
    response: { readonly success?: boolean };
  };
  deleteSession: { request: { readonly id: string }; response: { readonly success?: boolean } };
  updateSession: {
    request: WebuiUpdateSessionRequest;
    response: WebuiUpdateSessionResult;
  };
  getSessionForkOptions: {
    request: WebuiGetSessionForkOptionsRequest;
    response: WebuiGetSessionForkOptionsResult;
  };
  forkSession: { request: WebuiForkSessionRequest; response: WebuiForkSessionResult };
  listUserModelProviders: {
    request: undefined;
    response: readonly Record<string, unknown>[];
  };
  createUserModelProvider: { request: Record<string, unknown>; response: unknown };
  updateUserModelProvider: { request: Record<string, unknown>; response: unknown };
  deleteUserModelProvider: { request: { readonly providerId: string }; response: unknown };
  testUserModelProvider: {
    request: { readonly providerId: string; readonly apiKey?: string };
    response: unknown;
  };
  testUserModel: {
    request: { readonly providerId: string; readonly modelId: string };
    response: unknown;
  };
  discoverUserModelsCandidate: { request: Record<string, unknown>; response: unknown };
  saveUserModelProviderCandidate: { request: Record<string, unknown>; response: unknown };
  listProviderPresets: { request: undefined; response: readonly Record<string, unknown>[] };
  getMiniMaxApiKeyStatus: { request: undefined; response: Record<string, unknown> };
  upsertMiniMaxApiKey: {
    request: { readonly apiKey: string; readonly saveAndUse?: boolean };
    response: unknown;
  };
  getCodexOAuthStatus: { request: undefined; response: Record<string, unknown> };
  getMiniMaxModelSource: {
    request: undefined;
    response: "token_plan" | "minimax_api_key";
  };
  setMiniMaxModelSource: {
    request: { readonly source: "token_plan" | "minimax_api_key" };
    response: "token_plan" | "minimax_api_key";
  };
  testUserModelCandidate: { request: Record<string, unknown>; response: unknown };
  revealModelProviderApiKey: { request: { readonly providerId: string }; response: string };
  startCodexOAuthLogin: { request: Record<string, unknown>; response: unknown };
  cancelCodexOAuthLogin: { request: { readonly loginId: string }; response: unknown };
  refreshModels: { request: undefined; response: unknown };
  getGlobalInstructions: {
    request: Record<string, never>;
    response: WebuiGlobalInstructionsView;
  };
  setGlobalInstructions: {
    request: { readonly content: string };
    response: WebuiGlobalInstructionsView;
  };
  getAgentMemory: {
    request: { readonly includeContent?: boolean; readonly agentName?: string };
    response: WebuiAgentMemoryView;
  };
  setAgentMemory: {
    request: { readonly content: string; readonly agentName?: string };
    response: WebuiAgentMemoryView;
  };
  getUserProfile: { request: undefined; response: WebuiUserProfileView };
  setUserProfile: {
    request: {
      readonly nickname: string;
      readonly occupation: string;
      readonly moreAbout: string;
    };
    response: WebuiUserProfileView;
  };
  getMemorySettings: { request: undefined; response: WebuiMemorySettingsView };
  setMemorySettings: {
    request: { readonly enabled?: boolean; readonly proactive?: boolean };
    response: WebuiMemorySettingsView;
  };
}

/** The `{ stream }` envelope for the terminal watcher stream. */
export interface WebuiTerminalStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<Record<string, unknown>>;
  };
}

/** The `{ stream }` envelope for a `sendMessage`/`resumeSession` result. */
export interface WebuiSendMessageStreamEnvelope {
  readonly stream: WebuiSendMessageResult;
}

export interface WebuiResumeStreamEnvelope {
  readonly stream: WebuiStreamResult;
}
