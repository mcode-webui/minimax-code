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
export const GET_BROWSER_AUTHORIZATION_OPERATION_NAME = "getBrowserAuthorization" as const;
export const SET_BROWSER_AUTHORIZATION_OPERATION_NAME = "setBrowserAuthorization" as const;
export const LIST_BROWSER_TARGETS_OPERATION_NAME = "listBrowserTargets" as const;
export const SELECT_BROWSER_TARGET_OPERATION_NAME = "selectBrowserTarget" as const;
export const SEND_BROWSER_INPUT_OPERATION_NAME = "sendBrowserInput" as const;
export const SEND_BROWSER_COMMAND_OPERATION_NAME = "sendBrowserCommand" as const;
export const WATCH_BROWSER_FRAMES_OPERATION_NAME = "watchBrowserFrames" as const;
/**
 * The stream that publishes the session's web tabs.
 *
 * A snapshot rather than a delta, on a stream of its own: the strip renders
 * what the runtime publishes, and the runtime's record of what is open is the
 * authority — a client that kept its own copy would be a second authority.
 */
export const WATCH_BROWSER_WEB_TABS_OPERATION_NAME = "watchBrowserWebTabs" as const;
/**
 * The unary call that opens a page, the person's way of asking for one.
 *
 * The Agent reaches `open_tab` through its browser tools rather than through
 * this wire, so this operation exists for the new tab page's URL box: a person
 * who types a url asks the runtime for the page exactly as the Agent does, and
 * the answer names the page that was created. The `runId` is optional because
 * the panel is not acting for a run: absent means the panel's own cell.
 */
export const OPEN_BROWSER_WEB_TAB_OPERATION_NAME = "openBrowserWebTab" as const;
/**
 * The operation that closes a web tab.
 *
 * A tab the person closes does not leave a page behind in the browser, and the
 * runtime's page set follows the strip. The request names the **target** the
 * tab is bound to, so the runtime closes the page that tab holds — the client
 * does not have to know which session opened it.
 */
export const CLOSE_BROWSER_WEB_TAB_OPERATION_NAME = "closeBrowserWebTab" as const;
export const LIST_BROWSER_CAPABILITIES_OPERATION_NAME = "listBrowserCapabilities" as const;
/**
 * Reads one browser surface's installation key so the person can copy it.
 *
 * This is the one path by which the installation key leaves the OS secure
 * store, and it is deliberately a separate operation rather than a field on
 * `getBrowserAuthorization`: the key is shown once, on request, and the
 * authorization snapshot stays safe to read at any time.
 */
export const GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME = "getBrowserInstallationKey" as const;
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
// The account-billing surface the Desktop usage-and-model page shows: the
// credit fallback switch and the reset cards (list, redeem, history).
export const GET_CREDIT_FALLBACK_OPERATION_NAME = "getCreditFallback" as const;
export const SET_CREDIT_FALLBACK_OPERATION_NAME = "setCreditFallback" as const;
export const LIST_RESET_CARDS_OPERATION_NAME = "listResetCards" as const;
export const USE_RESET_CARD_OPERATION_NAME = "useResetCard" as const;
export const QUERY_RESET_CARD_FLOWS_OPERATION_NAME = "queryResetCardFlows" as const;
// The account page's calendar and profile: the lifetime token usage and the
// signed-in account's public profile.
export const GET_ACCOUNT_USAGE_SUMMARY_OPERATION_NAME = "getAccountUsageSummary" as const;
export const GET_ACCOUNT_PROFILE_OPERATION_NAME = "getAccountProfile" as const;
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
// The Mini App surface. Four operations over one runtime capability: the
// catalogue, the launch, the stop, and the standalone presentation lease.
// `openMiniApp` answers with a loopback view URL rather than the Mini App's own
// coordinates, so the credential the Mini App's guard demands never leaves the
// server. `watchMiniAppPresentation` is a stream rather than a request because
// its lifetime is the standalone document's, not one round trip's (ADR 0020:
// the lease is released when that client's socket closes).
export const LIST_MINI_APPS_OPERATION_NAME = "listMiniApps" as const;
export const OPEN_MINI_APP_OPERATION_NAME = "openMiniApp" as const;
export const STOP_MINI_APP_OPERATION_NAME = "stopMiniApp" as const;
export const WATCH_MINI_APP_PRESENTATION_OPERATION_NAME = "watchMiniAppPresentation" as const;
export const WATCH_MINI_APP_PRESENTER_OPERATION_NAME = "watchMiniAppPresenter" as const;
/**
 * One followed Mini App turn (`run` / `answer`).
 *
 * A stream because the turn streams: its progress events and its terminal result
 * arrive on one socket, and the socket closing is the only thing that ends a turn
 * nobody settled. `observe` travels in the body because the transport being a
 * stream says nothing about whether the page is listening (see
 * `shared/contracts/miniapp-agent.ts`).
 */
export const WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME = "watchMiniAppAgentTurn" as const;
/**
 * One short Mini App agent call: `models`, `agents`, `create`, `reply`, `open`, the
 * two panel reports, and `cancel`.
 *
 * One operation rather than eight because they share a body, a caller and one
 * refusal envelope, and each answers with the `method` it names. A page's
 * cancellation also belongs here: it is a call naming a request, not a socket
 * being dropped.
 */
export const MINI_APP_AGENT_CALL_OPERATION_NAME = "miniAppAgentCall" as const;
export const LIST_CRON_TASKS_OPERATION_NAME = "listCronTasks" as const;
export const CREATE_CRON_TASK_OPERATION_NAME = "createCronTask" as const;
export const UPDATE_CRON_TASK_OPERATION_NAME = "updateCronTask" as const;
export const DELETE_CRON_TASK_OPERATION_NAME = "deleteCronTask" as const;
export const RUN_CRON_TASK_NOW_OPERATION_NAME = "runCronTaskNow" as const;
export const LIST_CRON_TASK_RUNS_OPERATION_NAME = "listCronTaskRuns" as const;
/**
 * The 接入 IM surface: the IM clients the runtime has bound, and the mutations that bind and
 * unbind them.
 *
 * Desktop's IM client talks to the runtime's channel-bridge routes; the WebUI projects the same
 * five routes (`status`, `connect`, `disconnect`, `config-check`, `message-filter`) as named
 * operations, so the browser never learns a route path.
 */
export const LIST_CHANNEL_STATUS_OPERATION_NAME = "listChannelStatus" as const;
export const CONNECT_CHANNEL_OPERATION_NAME = "connectChannel" as const;
export const DISCONNECT_CHANNEL_OPERATION_NAME = "disconnectChannel" as const;
export const CHECK_CHANNEL_CONFIG_OPERATION_NAME = "checkChannelConfig" as const;
export const GET_CHANNEL_MESSAGE_FILTER_OPERATION_NAME = "getChannelMessageFilter" as const;
export const UPDATE_CHANNEL_MESSAGE_FILTER_OPERATION_NAME = "updateChannelMessageFilter" as const;
/**
 * The 远程控制 surface: the phone link's status, the mutations that open and close it, and the
 * credentials the browser signs and pushes down.
 *
 * `watchRemoteControlStatus` is a stream because the phone link's phase changes on the host: a
 * pairing code expires, a socket drops, the phone asks a permission question. Desktop pushes each
 * of those to the renderer; the WebUI pushes them down one stream so the pairing page shows the
 * live phase without polling.
 */
export const GET_REMOTE_CONTROL_STATUS_OPERATION_NAME = "getRemoteControlStatus" as const;
export const WATCH_REMOTE_CONTROL_STATUS_OPERATION_NAME = "watchRemoteControlStatus" as const;
export const CONNECT_REMOTE_CONTROL_OPERATION_NAME = "connectRemoteControl" as const;
export const DISCONNECT_REMOTE_CONTROL_OPERATION_NAME = "disconnectRemoteControl" as const;
export const APPLY_REMOTE_CONTROL_CREDENTIALS_OPERATION_NAME =
  "applyRemoteControlCredentials" as const;
export const REPORT_REMOTE_CONTROL_BINDING_LOST_OPERATION_NAME =
  "reportRemoteControlBindingLost" as const;
export const GET_REMOTE_CONTROL_PENDING_UNBIND_OPERATION_NAME =
  "getRemoteControlPendingUnbind" as const;
export const RESOLVE_REMOTE_CONTROL_UNBIND_OPERATION_NAME = "resolveRemoteControlUnbind" as const;
export const PUBLISH_REMOTE_CONTROL_COMPOSER_MODE_OPERATION_NAME =
  "publishRemoteControlComposerMode" as const;
/**
 * The SSH surface: the hosts this machine can reach, the projects rooted on them, and the remote
 * terminal.
 *
 * Desktop owns these in its Electron main process (`dist/main/modules/ssh-runtime/`); the WebUI
 * owns them in its loopback service, which is the same host-side position.
 */
export const LIST_SSH_CONNECTIONS_OPERATION_NAME = "listSshConnections" as const;
export const SAVE_SSH_CONNECTION_OPERATION_NAME = "saveSshConnection" as const;
export const SET_SSH_CONNECTION_ENABLED_OPERATION_NAME = "setSshConnectionEnabled" as const;
export const REMOVE_SSH_CONNECTION_OPERATION_NAME = "removeSshConnection" as const;
export const DISCOVER_SSH_HOSTS_OPERATION_NAME = "discoverSshHosts" as const;
export const PROBE_SSH_CONNECTION_OPERATION_NAME = "probeSshConnection" as const;
export const LIST_SSH_DIRECTORIES_OPERATION_NAME = "listSshDirectories" as const;
export const LIST_SSH_PROJECTS_OPERATION_NAME = "listSshProjects" as const;
export const SAVE_SSH_PROJECT_OPERATION_NAME = "saveSshProject" as const;
export const REMOVE_SSH_PROJECT_OPERATION_NAME = "removeSshProject" as const;
export const OPEN_SSH_TERMINAL_OPERATION_NAME = "openSshTerminal" as const;
export const WRITE_SSH_TERMINAL_OPERATION_NAME = "writeSshTerminal" as const;
export const RESIZE_SSH_TERMINAL_OPERATION_NAME = "resizeSshTerminal" as const;
export const CLOSE_SSH_TERMINAL_OPERATION_NAME = "closeSshTerminal" as const;
export const WATCH_SSH_TERMINAL_OPERATION_NAME = "watchSshTerminal" as const;

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
import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelEntry,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiSkillEntry,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "./contracts/models.js";
import type {
  WebuiCronRun,
  WebuiCronRunListRequest,
  WebuiCronRunPage,
  WebuiCronTaskCreateRequest,
  WebuiCronTaskDeleteRequest,
  WebuiCronTaskRunRequest,
  WebuiCronTaskListRequest,
  WebuiCronTaskPage,
  WebuiCronTask,
  WebuiCronTaskUpdateRequest,
} from "./contracts/cron.js";
import type {
  WebuiChannelConfigCheckRequest,
  WebuiChannelConfigCheckResult,
  WebuiChannelConnectRequest,
  WebuiChannelDisconnectRequest,
  WebuiChannelMessageFilter,
  WebuiChannelMessageFilterRequest,
  WebuiChannelOperationResult,
  WebuiChannelStatus,
} from "./contracts/channel.js";
import type {
  WebuiRemoteControlComposerMode,
  WebuiRemoteControlConnectRequest,
  WebuiRemoteControlConnectResult,
  WebuiRemoteControlCredentials,
  WebuiRemoteControlDisconnectRequest,
  WebuiRemoteControlOperationResult,
  WebuiRemoteControlPendingUnbind,
  WebuiRemoteControlStatus,
  WebuiWatchRemoteControlResult,
} from "./contracts/remote-control.js";
import type {
  WebuiSshConnection,
  WebuiSshDiscovery,
  WebuiSshDirectoryEntry,
  WebuiSshListDirectoriesRequest,
  WebuiSshListDirectoriesResult,
  WebuiSshProbeResult,
  WebuiSshProject,
  WebuiSshProjectRequest,
  WebuiSshProjectResult,
  WebuiSshRemoveResult,
  WebuiSshSaveConnectionRequest,
  WebuiSshSaveConnectionResult,
  WebuiSshSetEnabledRequest,
  WebuiSshTerminalSession,
  WebuiSshTerminalStreamResult,
} from "./contracts/ssh.js";
import type { WebuiVersionInfo } from "./contracts/version.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserAuthorizationChange,
  WebuiBrowserCommandRequest,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
  WebuiBrowserWebTabOpen,
  WebuiBrowserWebTabClose,
  WebuiBrowserWebTabSnapshot,
} from "./contracts/browser.js";
import { type WebuiBridgeBrowserSurface } from "./contracts/browser.js";
import type { WebuiUsageQuotaResult } from "./contracts/usage-quota.js";
import type {
  WebuiCreditFallbackView,
  WebuiResetCardFlowsResult,
  WebuiResetCardListResult,
  WebuiResetCardUseResult,
} from "./contracts/account-billing.js";
import type {
  WebuiAccountProfileView,
  WebuiUsageSummaryView,
} from "./contracts/account-usage.js";
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
import type {
  WebuiMiniAppCatalogue,
  WebuiMiniAppPresentationIntent,
  WebuiMiniAppPresentationState,
  WebuiMiniAppView,
} from "./contracts/miniapp.js";
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentCallResponse,
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "./contracts/miniapp-agent.js";

/**
 * The complete operation table: every wire operation name mapped to the
 * request type its validator produces and the response body type it actually
 * answers with.
 *
 * `request` is the *validated* body — what the operation's validator hands to
 * the handler, not the raw frame. Where a validator only checks that the frame
 * is a record and forwards it (for example `writeTerminal`), the request type
 * says so honestly (`Record<string, unknown>`) rather than pretending a narrower
 * shape was verified; the runtime adapter keeps the conversion.
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
    request: { readonly workspaceDir?: string; readonly cols?: number; readonly rows?: number; readonly workspaceTabId?: string };
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
  getBrowserAuthorization: {
    request: Record<string, never>;
    response: WebuiBrowserAuthorization;
  };
  setBrowserAuthorization: {
    request: WebuiBrowserAuthorizationChange;
    response: WebuiBrowserAuthorization;
  };
  listBrowserTargets: {
    request: { readonly surface: WebuiBrowserSurface; readonly runId?: string };
    response: WebuiBrowserTargetList;
  };
  selectBrowserTarget: {
    request: { readonly target: WebuiBrowserTargetId; readonly runId?: string };
    response: WebuiBrowserTargetState;
  };
  sendBrowserInput: {
    request: WebuiBrowserInputCommand & { readonly runId?: string };
    response: { readonly accepted: true };
  };
  sendBrowserCommand: {
    request: WebuiBrowserCommandRequest;
    response: { readonly accepted: true; readonly result?: unknown };
  };
  watchBrowserFrames: {
    request: {
      readonly surface: WebuiBrowserSurface;
      readonly target: WebuiBrowserTargetId;
    };
    response: WebuiBrowserFrameStreamEnvelope;
  };
  watchBrowserWebTabs: {
    request: { readonly surface: WebuiBrowserSurface; readonly runId?: string };
    response: WebuiBrowserWebTabStreamEnvelope;
  };
  watchMiniAppPresenter: {
    request: undefined;
    response: WebuiMiniAppPresenterStreamEnvelope;
  };
  /**
   * A url, and optionally the run the page is opened for. There is no surface:
   * the embedded panel is the isolated Chromium's view, and `open_tab` reads
   * the surface off the run the same way the Agent's path does.
   */
  openBrowserWebTab: {
    request: { readonly url: string; readonly runId?: string };
    response: WebuiBrowserWebTabOpen;
  };
  closeBrowserWebTab: {
    request: { readonly target: WebuiBrowserTargetId };
    response: WebuiBrowserWebTabClose;
  };
  listBrowserCapabilities: {
    request: Record<string, never>;
    response: { readonly entries: readonly WebuiBrowserCapabilityEntry[] };
  };
  getBrowserInstallationKey: {
    request: { readonly surface: WebuiBridgeBrowserSurface };
    /**
     * `present: false` when the surface has no installation key yet — an
     * unprovisioned surface has nothing to copy, and saying so is different
     * from returning an empty string the person would paste.
     */
    response:
      | {
          readonly present: false;
          readonly surface: WebuiBridgeBrowserSurface;
          readonly reason: "not_provisioned";
        }
      | {
          readonly present: true;
          readonly surface: WebuiBridgeBrowserSurface;
          readonly keyId: string;
          readonly key: string;
          readonly fingerprint: string;
        };
  };
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
  getCreditFallback: {
    request: Record<string, never>;
    response: WebuiCreditFallbackView;
  };
  setCreditFallback: {
    request: { readonly enabled: boolean };
    response: WebuiCreditFallbackView;
  };
  listResetCards: {
    request: { readonly page?: number; readonly size?: number };
    response: WebuiResetCardListResult;
  };
  useResetCard: {
    request: { readonly sourceType?: string; readonly outBizNo?: string };
    response: WebuiResetCardUseResult;
  };
  queryResetCardFlows: {
    request: {
      readonly page?: number;
      readonly size?: number;
      readonly createTimeMs?: number;
    };
    response: WebuiResetCardFlowsResult;
  };
  getAccountUsageSummary: {
    request: Record<string, never>;
    response: WebuiUsageSummaryView;
  };
  getAccountProfile: {
    request: Record<string, never>;
    response: WebuiAccountProfileView;
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
    response: readonly WebuiModelProviderView[];
  };
  createUserModelProvider: { request: WebuiCreateUserModelProviderRequest; response: unknown };
  updateUserModelProvider: { request: WebuiUpdateUserModelProviderRequest; response: unknown };
  deleteUserModelProvider: { request: { readonly providerId: string }; response: unknown };
  testUserModelProvider: {
    request: { readonly providerId: string; readonly apiKey?: string };
    response: unknown;
  };
  testUserModel: {
    request: { readonly providerId: string; readonly modelId: string };
    response: unknown;
  };
  discoverUserModelsCandidate: {
    request: WebuiDiscoverUserModelsCandidateRequest;
    response: unknown;
  };
  saveUserModelProviderCandidate: {
    request: WebuiSaveUserModelProviderCandidateRequest;
    response: unknown;
  };
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
  testUserModelCandidate: { request: WebuiTestUserModelCandidateRequest; response: unknown };
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
  /**
   * The Mini App catalogue. A row's `runtime.status` is why this is not just a
   * plugin list: the picker offers "open" or "stop" from it. A row's
   * `detached`/`presentationRevision` are the service's own record, which is why
   * the response is `WebuiMiniAppCatalogue` and not the runtime's
   * `WebuiMiniAppList`.
   */
  listMiniApps: { request: undefined; response: WebuiMiniAppCatalogue };
  /**
   * Starts one Mini App and names where to frame it.
   *
   * The response is the loopback proxy's `viewUrl` and the plugin it belongs to.
   * The Mini App's own origin, surface path and launch credential stay on the
   * server: the proxy is the only thing that sees them, and it injects the
   * credential on the way out.
   */
  openMiniApp: {
    request: { readonly pluginId: string };
    response: WebuiMiniAppView;
  };
  /** Stops one Mini App and closes the proxy that was serving it. */
  stopMiniApp: {
    request: { readonly pluginId: string };
    response: { readonly success: true };
  };
  /**
   * The standalone presentation lease (ADR 0020).
   *
   * A standalone document declares its plugin, its session and its presentation
   * by connecting; the lease lives as long as that socket does, which is what
   * makes `detached` in the catalogue a live fact instead of a constant. It is a
   * stream for exactly that reason: a unary request would settle in milliseconds
   * and release the record with it.
   */
  watchMiniAppPresentation: {
    request: { readonly pluginId: string; readonly sessionId: string };
    response: WebuiMiniAppPresentationStreamEnvelope;
  };
  /**
   * One followed Mini App turn.
   *
   * The body is the page's request plus the identity the host resolved for it; the
   * frames are its progress events and, last, how it settled. A turn's refusal is a
   * frame rather than a wire error, because "the runtime said no" and "the request
   * was malformed" are different answers and only the second one is the wire's.
   */
  watchMiniAppAgentTurn: {
    request: WebuiMiniAppAgentTurnRequest;
    response: WebuiMiniAppAgentTurnStreamEnvelope;
  };
  /** One short Mini App agent call, refusal included in the body. */
  miniAppAgentCall: {
    request: WebuiMiniAppAgentCallRequest;
    response: WebuiMiniAppAgentCallResponse;
  };
  /**
   * The scheduled tasks this host knows about (ADR 0027).
   *
   * The request is a paging cursor and an optional agent filter; the response is the WebUI's own
   * task page, not the runtime's cron view — the adapter converts, and `shared/contracts/cron.ts`
   * is the only shape the browser can name.
   */
  listCronTasks: {
    request: WebuiCronTaskListRequest;
    response: WebuiCronTaskPage;
  };
  /**
   * Creating, editing and deleting a scheduled task (ADR 0027).
   *
   * The response is the definition as the runtime stored it, not the request echoed back: the next
   * fire time and the schedule generation belong to the shared row, and a panel that predicted them
   * would disagree with the host that actually arms the task.
   */
  createCronTask: { request: WebuiCronTaskCreateRequest; response: WebuiCronTask };
  updateCronTask: { request: WebuiCronTaskUpdateRequest; response: WebuiCronTask };
  /** Deletion is a tombstone: the definition leaves the list, its runs stay for history. */
  deleteCronTask: { request: WebuiCronTaskDeleteRequest; response: { readonly success?: boolean } };
  /**
   * Run one task now, and read what happened on earlier runs.
   *
   * `runCronTaskNow` answers with the run it created. It executes in the host that was asked —
   * `claimExecution` is atomic and delivery is idempotent per run id, so a second host on the same
   * data directory cannot execute the same run twice.
   */
  runCronTaskNow: { request: WebuiCronTaskRunRequest; response: WebuiCronRun };
  listCronTaskRuns: { request: WebuiCronRunListRequest; response: WebuiCronRunPage };
  /**
   * The 接入 IM surface.
   *
   * One projection of the runtime's channel-bridge routes. The response is the WebUI's own status
   * shape, not the runtime's route body: the runtime keys clients by name and reports each one's
   * platform, and `shared/contracts/channel.ts` is the only shape the browser may name.
   */
  listChannelStatus: { request: undefined; response: WebuiChannelStatus };
  /**
   * Binding one IM client.
   *
   * `appSecret` travels once, in the request, and is never echoed back: the browser sends it to
   * the host, and the host hands it to the runtime's platform adapter.
   */
  connectChannel: {
    request: WebuiChannelConnectRequest;
    response: WebuiChannelOperationResult;
  };
  disconnectChannel: {
    request: WebuiChannelDisconnectRequest;
    response: WebuiChannelOperationResult;
  };
  /** Whether one agent's IM channel is configured on this host. */
  checkChannelConfig: {
    request: WebuiChannelConfigCheckRequest;
    response: WebuiChannelConfigCheckResult;
  };
  /** How much of a turn the IM client receives: the final result, or the full transcript. */
  getChannelMessageFilter: {
    request: { readonly agent: string };
    response: WebuiChannelMessageFilter;
  };
  updateChannelMessageFilter: {
    request: WebuiChannelMessageFilterRequest;
    response: WebuiChannelMessageFilter;
  };
  /**
   * The 远程控制 surface.
   *
   * The status is the bridge's own snapshot, minus the epochs the browser has no business
   * holding: the phase, the pairing code, its expiry and the pending unbind.
   */
  getRemoteControlStatus: { request: undefined; response: WebuiRemoteControlStatus };
  /**
   * The phone link's live state.
   *
   * A stream, because the phase changes on the host: a pairing code expires, a socket drops, the
   * phone asks a permission question. Desktop pushes each of those to the renderer.
   */
  watchRemoteControlStatus: {
    request: undefined;
    response: WebuiWatchRemoteControlResult;
  };
  connectRemoteControl: {
    request: WebuiRemoteControlConnectRequest;
    response: WebuiRemoteControlConnectResult;
  };
  disconnectRemoteControl: {
    request: WebuiRemoteControlDisconnectRequest;
    response: WebuiRemoteControlOperationResult;
  };
  /**
   * The browser hands down the one-shot ticket it signed.
   *
   * Only the browser can sign `GET /desktop/bindings`: the service holds the socket but not the
   * signing material. So the browser signs and pushes, and the host opens the connection.
   */
  applyRemoteControlCredentials: {
    request: WebuiRemoteControlCredentials;
    response: WebuiRemoteControlOperationResult;
  };
  reportRemoteControlBindingLost: {
    request: undefined;
    response: WebuiRemoteControlOperationResult;
  };
  getRemoteControlPendingUnbind: {
    request: undefined;
    response: WebuiRemoteControlPendingUnbind | null;
  };
  resolveRemoteControlUnbind: {
    request: { readonly requestId: string; readonly confirmed: boolean };
    response: WebuiRemoteControlOperationResult;
  };
  /** The phone set a composer mode on one session. */
  publishRemoteControlComposerMode: {
    request: WebuiRemoteControlComposerMode;
    response: { readonly accepted: boolean };
  };
  /**
   * The SSH surface.
   *
   * The hosts this machine can reach, the projects rooted on them and the remote terminal. The
   * response is the WebUI's own projection; the service's own records stay inside the service.
   */
  listSshConnections: {
    request: undefined;
    response: readonly WebuiSshConnection[];
  };
  /** Saving a host probes it, so the answer carries both the saved host and the probe. */
  saveSshConnection: {
    request: WebuiSshSaveConnectionRequest;
    response: WebuiSshSaveConnectionResult;
  };
  setSshConnectionEnabled: {
    request: WebuiSshSetEnabledRequest;
    response: WebuiSshSaveConnectionResult;
  };
  /** Removing a host takes its projects with it, so the answer names them. */
  removeSshConnection: {
    request: { readonly alias: string };
    response: WebuiSshRemoveResult;
  };
  discoverSshHosts: { request: undefined; response: WebuiSshDiscovery };
  probeSshConnection: {
    request: { readonly alias: string };
    response: WebuiSshProbeResult;
  };
  /** One remote directory, for the project's folder browser. */
  listSshDirectories: {
    request: WebuiSshListDirectoriesRequest;
    response: WebuiSshListDirectoriesResult;
  };
  listSshProjects: { request: undefined; response: readonly WebuiSshProject[] };
  saveSshProject: { request: WebuiSshProjectRequest; response: WebuiSshProjectResult };
  removeSshProject: {
    request: { readonly id: string };
    response: WebuiSshProjectResult;
  };
  openSshTerminal: {
    request: { readonly alias: string; readonly path?: string };
    response: WebuiSshTerminalSession;
  };
  writeSshTerminal: {
    request: { readonly terminalId: string; readonly data: string };
    response: { readonly accepted: boolean };
  };
  resizeSshTerminal: {
    request: { readonly terminalId: string; readonly cols: number; readonly rows: number };
    response: { readonly accepted: boolean };
  };
  closeSshTerminal: {
    request: { readonly terminalId: string };
    response: { readonly accepted: boolean };
  };
  /** The remote terminal's output. */
  watchSshTerminal: {
    request: { readonly terminalId: string };
    response: WebuiSshTerminalStreamResult;
  };
}

/**
 * The operations whose result is a **stream**, not a unary body.
 *
 * Declared once, in the shared contract, so exactly one place decides what the
 * browser's unary request interface may carry and a Node test can check the set
 * against the server's registered stream descriptors. A stream has its own
 * lifecycle — the `[DONE]` settlement and the detach handle in
 * `client/platform/wire.ts`, the attach/resume loops on top of them — so routing
 * one through the unary interface is a mistake rather than a variation, and the
 * type system should say so.
 */
export const WEBUI_STREAM_OPERATION_NAMES = [
  SEND_MESSAGE_OPERATION_NAME,
  RESUME_SESSION_OPERATION_NAME,
  WATCH_EVENTS_OPERATION_NAME,
  WATCH_TERMINAL_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
  WATCH_MINI_APP_PRESENTATION_OPERATION_NAME,
  WATCH_MINI_APP_PRESENTER_OPERATION_NAME,
  WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME,
  WATCH_REMOTE_CONTROL_STATUS_OPERATION_NAME,
  WATCH_SSH_TERMINAL_OPERATION_NAME,
] as const;

export type WebuiStreamOperationName = (typeof WEBUI_STREAM_OPERATION_NAMES)[number];

/**
 * Every operation a unary request can carry: the `OperationSpec` keys minus the
 * streams. `wire.request` is generic over this set, so a caller cannot name an
 * unrelated result type and cannot pass a stream operation at all.
 */
export type WebuiUnaryOperationName = Exclude<keyof OperationSpec, WebuiStreamOperationName>;

/** Narrow a wire operation name to the shared stream family. */
export function isWebuiStreamOperationName(
  name: string,
): name is WebuiStreamOperationName {
  return (WEBUI_STREAM_OPERATION_NAMES as readonly string[]).includes(name);
}

/** The `{ stream }` envelope for the terminal watcher stream. */
export interface WebuiTerminalStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<Record<string, unknown>>;
  };
}

/** The `{ stream }` envelope for the browser image stream. */
export interface WebuiBrowserFrameStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<WebuiBrowserImageFrame>;
  };
}

/** The `{ stream }` envelope for the browser web-tab snapshot stream. */
export interface WebuiBrowserWebTabStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<WebuiBrowserWebTabSnapshot>;
  };
}

/** The client presentation intent stream from the runtime-owned presenter. */
export interface WebuiMiniAppPresenterStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<WebuiMiniAppPresentationIntent>;
  };
}

/**
 * The `{ stream }` envelope for the standalone presentation lease.
 *
 * Named after the operation rather than its frames because the stream's value is
 * its lifetime: one frame says what the lease is, and the socket staying open is
 * what keeps it. A `[DONE]` would mean the presentation ended.
 */
export interface WebuiMiniAppPresentationStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<WebuiMiniAppPresentationState>;
  };
}

/**
 * The `{ stream }` envelope for one followed Mini App turn.
 *
 * Frames are the runtime's own run events, then exactly one settlement: `settled`
 * with the turn's result, or `failure` with a closed failure code. The settlement
 * is the promise's answer, which is why it is a frame of the same stream rather
 * than a second request.
 */
export interface WebuiMiniAppAgentTurnStreamEnvelope {
  readonly stream: {
    readonly ok: true;
    readonly source: AsyncIterable<WebuiMiniAppAgentTurnFrame>;
  };
}

/** The `{ stream }` envelope for a `sendMessage`/`resumeSession` result. */
export interface WebuiSendMessageStreamEnvelope {
  readonly stream: WebuiSendMessageResult;
}

export interface WebuiResumeStreamEnvelope {
  readonly stream: WebuiStreamResult;
}
