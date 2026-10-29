// The domain method table: every capability the browser client can ask the host
// for, joined to the wire.
//
// The wire lifecycle mechanics — one socket per request, the unary deadline,
// the stream's `[DONE]` settlement, the terminal watch, the events socket —
// live in `./wire.js` and take the operation as a parameter. What stays here is
// the mapping from a capability method to the operation it travels as, and every
// one of those names comes from the canonical identifiers in
// `../../shared/operation-names.js` rather than a string literal: the server
// names its handlers from that same table, so a rename on the wire side cannot
// leave a method pointing at an operation that no longer exists while every gate
// stays green.

import type { WebuiClientMessagePage } from "../features/transcript/contracts/message-view.js";
import type {
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
  WebuiClientProject,
} from "../features/sessions/contracts/session-view.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import {
  ABORT_SESSION_OPERATION_NAME,
  APPLY_CANVAS_OPERATION_NAME,
  ARCHIVE_SESSION_OPERATION_NAME,
  BEGIN_ACCOUNT_LOGIN_OPERATION_NAME,
  BROWSE_WORKSPACE_DIRS_OPERATION_NAME,
  CANCEL_ACCOUNT_LOGIN_OPERATION_NAME,
  CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME,
  CLAIM_SIGNIN_OPERATION_NAME,
  CLEAR_GOAL_OPERATION_NAME,
  CREATE_GOAL_OPERATION_NAME,
  CREATE_SESSION_OPERATION_NAME,
  CREATE_TERMINAL_OPERATION_NAME,
  CREATE_USER_MODEL_PROVIDER_OPERATION_NAME,
  DELETE_QUEUE_ITEM_OPERATION_NAME,
  DELETE_SESSION_OPERATION_NAME,
  DELETE_USER_MODEL_PROVIDER_OPERATION_NAME,
  DISMISS_QUESTIONNAIRE_OPERATION_NAME,
  DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME,
  DISPOSE_TERMINAL_OPERATION_NAME,
  EDIT_SESSION_MESSAGE_OPERATION_NAME,
  ENQUEUE_MESSAGE_OPERATION_NAME,
  EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME,
  FORK_SESSION_OPERATION_NAME,
  GET_ACCOUNT_LOGIN_STATUS_OPERATION_NAME,
  GET_ACCOUNT_STATUS_OPERATION_NAME,
  GET_ACTIVE_TURN_OPERATION_NAME,
  GET_AGENT_MEMORY_OPERATION_NAME,
  GET_CODEX_OAUTH_STATUS_OPERATION_NAME,
  GET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
  GET_GOAL_OPERATION_NAME,
  GET_MEMORY_SETTINGS_OPERATION_NAME,
  GET_MESSAGES_OPERATION_NAME,
  GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME,
  GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME,
  GET_PENDING_QUESTIONNAIRE_OPERATION_NAME,
  GET_PERMISSION_MODE_OPERATION_NAME,
  GET_SESSION_DIFF_OPERATION_NAME,
  GET_SESSION_FORK_OPTIONS_OPERATION_NAME,
  GET_SESSION_REWIND_PREVIEW_OPERATION_NAME,
  GET_SESSION_TREE_OPERATION_NAME,
  GET_SESSION_USAGE_OPERATION_NAME,
  GET_SIGNIN_PANEL_OPERATION_NAME,
  GET_TURN_DIFF_OPERATION_NAME,
  GET_USAGE_QUOTA_OPERATION_NAME,
  GET_CREDIT_FALLBACK_OPERATION_NAME,
  SET_CREDIT_FALLBACK_OPERATION_NAME,
  LIST_RESET_CARDS_OPERATION_NAME,
  USE_RESET_CARD_OPERATION_NAME,
  QUERY_RESET_CARD_FLOWS_OPERATION_NAME,
  GET_ACCOUNT_USAGE_SUMMARY_OPERATION_NAME,
  GET_ACCOUNT_PROFILE_OPERATION_NAME,
  GET_USER_PROFILE_OPERATION_NAME,
  GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME,
  GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME,
  GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME,
  IS_GOAL_ENABLED_OPERATION_NAME,
  LIST_MODELS_OPERATION_NAME,
  LIST_PENDING_PERMISSIONS_OPERATION_NAME,
  LIST_PROVIDER_PRESETS_OPERATION_NAME,
  LIST_QUEUE_MESSAGES_OPERATION_NAME,
  LIST_SESSIONS_OPERATION_NAME,
  CREATE_CRON_TASK_OPERATION_NAME,
  DELETE_CRON_TASK_OPERATION_NAME,
  LIST_CRON_TASK_RUNS_OPERATION_NAME,
  LIST_CRON_TASKS_OPERATION_NAME,
  RUN_CRON_TASK_NOW_OPERATION_NAME,
  LIST_SKILLS_OPERATION_NAME,
  UPDATE_CRON_TASK_OPERATION_NAME,
  LIST_TERMINALS_OPERATION_NAME,
  LIST_USER_MODEL_PROVIDERS_OPERATION_NAME,
  LIST_VISIBLE_PROJECTS_OPERATION_NAME,
  LIST_WORKSPACE_FILE_TREE_OPERATION_NAME,
  LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME,
  MUTATE_WORKSPACE_GIT_OPERATION_NAME,
  PATCH_GOAL_OPERATION_NAME,
  PLUGIN_MANAGEMENT_OPERATION_NAME,
  READ_CANVAS_OPERATION_NAME,
  READ_WORKSPACE_ARCHIVE_OPERATION_NAME,
  READ_WORKSPACE_FILE_OPERATION_NAME,
  REAPPLY_TURN_DIFF_OPERATION_NAME,
  REFRESH_MODELS_OPERATION_NAME,
  REPLY_PERMISSION_OPERATION_NAME,
  REPLY_QUESTIONNAIRE_OPERATION_NAME,
  RESIZE_TERMINAL_OPERATION_NAME,
  RESUME_SESSION_OPERATION_NAME,
  REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME,
  REVERT_TURN_DIFF_OPERATION_NAME,
  REWIND_SESSION_OPERATION_NAME,
  RUN_COMMAND_OPERATION_NAME,
  SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME,
  SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME,
  SELECT_MODEL_OPERATION_NAME,
  SEND_MESSAGE_OPERATION_NAME,
  SET_AGENT_MEMORY_OPERATION_NAME,
  SET_GLOBAL_INSTRUCTIONS_OPERATION_NAME,
  SET_MEMORY_SETTINGS_OPERATION_NAME,
  SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME,
  SET_PERMISSION_MODE_OPERATION_NAME,
  SET_USER_PROFILE_OPERATION_NAME,
  SIGN_OUT_OPERATION_NAME,
  START_CODEX_OAUTH_LOGIN_OPERATION_NAME,
  TEST_USER_MODEL_CANDIDATE_OPERATION_NAME,
  TEST_USER_MODEL_OPERATION_NAME,
  TEST_USER_MODEL_PROVIDER_OPERATION_NAME,
  UPDATE_SESSION_OPERATION_NAME,
  UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME,
  UPSERT_MINIMAX_API_KEY_OPERATION_NAME,
  VERSION_OPERATION_NAME,
  WATCH_TERMINAL_OPERATION_NAME,
  WRITE_TERMINAL_OPERATION_NAME,
  GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  LIST_BROWSER_TARGETS_OPERATION_NAME,
  SELECT_BROWSER_TARGET_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
  CLOSE_BROWSER_WEB_TAB_OPERATION_NAME,
  OPEN_BROWSER_WEB_TAB_OPERATION_NAME,
  LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
  LIST_MINI_APPS_OPERATION_NAME,
  OPEN_MINI_APP_OPERATION_NAME,
  STOP_MINI_APP_OPERATION_NAME,
  WATCH_MINI_APP_PRESENTATION_OPERATION_NAME,
  WATCH_MINI_APP_PRESENTER_OPERATION_NAME,
  WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME,
  MINI_APP_AGENT_CALL_OPERATION_NAME,
} from "../../shared/operation-names.js";
import { createWebuiWire, type WebuiWireOptions } from "./wire.js";

export type { WebuiClientEventWatcher, WebuiClientRuntimeEvent, WebuiSocket } from "./event-channel.js";

/** The wire's options are this transport's options: there is one socket contract. */
export type WebuiTransportOptions = WebuiWireOptions;

export function createWebuiTransport(options: WebuiTransportOptions): Required<WebuiTransport> {
  /* The `Required<WebuiTransport>` return type together with the
   * `satisfies Required<WebuiTransport>` clause on the literal below forces
   * the wire contract and the implementation to stay in lock-step: a
   * missing member, a typo'd key, or a signature drift on either side
   * breaks the build. The `Required` qualifier is scoped to this
   * implementation boundary; the `WebuiTransport` capability contract
   * consumed by components keeps its optional semantics. */
  const {
    request,
    stream,
    watchTerminal,
    watchBrowserFrames,
    watchBrowserWebTabs,
    watchMiniAppPresentation,
    watchMiniAppPresenter,
    watchMiniAppAgentTurn,
    workspaceFileUrl,
    miniappStandaloneUrl,
    watchEvents,
  } = createWebuiWire(options);

  return {
    version: () => request(VERSION_OPERATION_NAME, undefined),
    loadProjects: () =>
      request(LIST_VISIBLE_PROJECTS_OPERATION_NAME, { limit: 100 }),
    loadSessions: (cursor) =>
      request(LIST_SESSIONS_OPERATION_NAME, {
        name: "main",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      }),
    loadSessionTree: (cursor) =>
      request(GET_SESSION_TREE_OPERATION_NAME, {
        name: "main",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      }),
    listArchivedSessions: () =>
      request(LIST_SESSIONS_OPERATION_NAME, {
        name: "main",
        includeArchived: true,
        onlyArchived: true,
      }),
    archiveSession: (body) => request(ARCHIVE_SESSION_OPERATION_NAME, body),
    deleteSession: (body) => request(DELETE_SESSION_OPERATION_NAME, body),
    updateSession: (body) => request(UPDATE_SESSION_OPERATION_NAME, body),
    getSessionForkOptions: (body) => request(GET_SESSION_FORK_OPTIONS_OPERATION_NAME, body),
    forkSession: (body) => request(FORK_SESSION_OPERATION_NAME, body),
    loadMessages: ({ id, before }) =>
      request(GET_MESSAGES_OPERATION_NAME, {
        id,
        ...(before ? { before } : {}),
      }),
    getSessionDiff: (body) => request(GET_SESSION_DIFF_OPERATION_NAME, body),
    getTurnDiff: (body) => request(GET_TURN_DIFF_OPERATION_NAME, body),
    revertTurnDiff: (body) => request(REVERT_TURN_DIFF_OPERATION_NAME, body),
    reapplyTurnDiff: (body) => request(REAPPLY_TURN_DIFF_OPERATION_NAME, body),
    getSessionRewindPreview: (body) => request(GET_SESSION_REWIND_PREVIEW_OPERATION_NAME, body),
    rewindSession: (body) => request(REWIND_SESSION_OPERATION_NAME, body),
    editSessionMessage: (body) => request(EDIT_SESSION_MESSAGE_OPERATION_NAME, body),
    isGoalEnabled: () => request(IS_GOAL_ENABLED_OPERATION_NAME, undefined),
    getActiveTurn: (body) => request(GET_ACTIVE_TURN_OPERATION_NAME, body),
    getGoal: (body) => request(GET_GOAL_OPERATION_NAME, body),
    createGoal: (body) => request(CREATE_GOAL_OPERATION_NAME, body),
    patchGoal: (body) => request(PATCH_GOAL_OPERATION_NAME, body),
    clearGoal: (body) => request(CLEAR_GOAL_OPERATION_NAME, body),
    listWorkspaceFileTree: (body) => request(LIST_WORKSPACE_FILE_TREE_OPERATION_NAME, body),
    browseWorkspaceDirs: (body) => request(BROWSE_WORKSPACE_DIRS_OPERATION_NAME, body),
    readWorkspaceFile: (body) => request(READ_WORKSPACE_FILE_OPERATION_NAME, body),
    getWorkspaceEnvironment: (body) => request(GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME, body),
    mutateWorkspaceGit: (body) => request(MUTATE_WORKSPACE_GIT_OPERATION_NAME, body),
    getWorkspaceReviewSummary: (body) => request(GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME, body),
    listWorkspaceReviewFileDiffs: (body) =>
      request(LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME, body),
    getWorkspaceReviewFileContent: (body) =>
      request(GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME, body),
    searchWorkspaceReviewDiffs: (body) => request(SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME, body),
    readCanvas: (body) => request(READ_CANVAS_OPERATION_NAME, body),
    // The operation's declared request is its validator's output
    // (`Record<string, unknown>`), while the client holds the concrete
    // `CanvasOperation`. The boundary restates the pair as the plain records
    // the wire actually carries rather than casting the concrete type away.
    applyCanvas: (body) =>
      request(APPLY_CANVAS_OPERATION_NAME, {
        sessionId: body.sessionId,
        operation: {...body.operation},
      }),
    workspaceFileUrl,
    readWorkspaceArchive: (body) => request(READ_WORKSPACE_ARCHIVE_OPERATION_NAME, body),
    extractWorkspaceArchive: (body) => request(EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME, body),
    createTerminal: (body) => request(CREATE_TERMINAL_OPERATION_NAME, body),
    listTerminals: () => request(LIST_TERMINALS_OPERATION_NAME, {}),
    writeTerminal: (body) => request(WRITE_TERMINAL_OPERATION_NAME, body),
    // Same reason as `applyCanvas`: the declared request is the validator's
    // `Record<string, unknown>` and the terminal size is a flat record.
    resizeTerminal: (body) => request(RESIZE_TERMINAL_OPERATION_NAME, {...body}),
    disposeTerminal: (body) => request(DISPOSE_TERMINAL_OPERATION_NAME, body),
    watchTerminal: (body, onFrame) => watchTerminal(WATCH_TERMINAL_OPERATION_NAME, body, onFrame),
    getBrowserAuthorization: () => request(GET_BROWSER_AUTHORIZATION_OPERATION_NAME, {}),
    setBrowserAuthorization: (body) => request(SET_BROWSER_AUTHORIZATION_OPERATION_NAME, body),
    listBrowserTargets: (body) => request(LIST_BROWSER_TARGETS_OPERATION_NAME, body),
    selectBrowserTarget: (body) => request(SELECT_BROWSER_TARGET_OPERATION_NAME, body),
    // The run is an envelope field on the wire, not part of the command: the
    // runtime validates the command shape and knows nothing about which run sent
    // it. The panel's `runId` is therefore folded in here, where the boundary
    // between the port's request and the operation's body already lives.
    sendBrowserInput: (body) =>
      request(SEND_BROWSER_INPUT_OPERATION_NAME, {
        ...body.command,
        ...(body.runId ? { runId: body.runId } : {}),
      }, { reuseConnection: true }),
    sendBrowserCommand: (body) => request(SEND_BROWSER_COMMAND_OPERATION_NAME, body),
    watchBrowserFrames: (body, onFrame) =>
      watchBrowserFrames(WATCH_BROWSER_FRAMES_OPERATION_NAME, body, onFrame),
    watchBrowserWebTabs: (body, onSnapshot) =>
      watchBrowserWebTabs(WATCH_BROWSER_WEB_TABS_OPERATION_NAME, body, onSnapshot),
    openBrowserWebTab: (body) => request(OPEN_BROWSER_WEB_TAB_OPERATION_NAME, body),
    closeBrowserWebTab: (body) => request(CLOSE_BROWSER_WEB_TAB_OPERATION_NAME, body),
    listBrowserCapabilities: () => request(LIST_BROWSER_CAPABILITIES_OPERATION_NAME, {}),
    getBrowserInstallationKey: (body) =>
      request(GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME, body),
    listMiniApps: () => request(LIST_MINI_APPS_OPERATION_NAME, undefined),
    openMiniApp: (body) => request(OPEN_MINI_APP_OPERATION_NAME, body),
    stopMiniApp: (body) => request(STOP_MINI_APP_OPERATION_NAME, body),
    watchMiniAppPresentation: (body, onFrame, onFailure) =>
      watchMiniAppPresentation(WATCH_MINI_APP_PRESENTATION_OPERATION_NAME, body, onFrame, onFailure),
    watchMiniAppPresenter: (onFrame, onFailure) =>
      watchMiniAppPresenter(WATCH_MINI_APP_PRESENTER_OPERATION_NAME, onFrame, onFailure),
    watchMiniAppAgentTurn: (body, onFrame, onFailure) =>
      watchMiniAppAgentTurn(WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME, body, onFrame, onFailure),
    miniAppAgentCall: (body) => request(MINI_APP_AGENT_CALL_OPERATION_NAME, body),
    miniappStandaloneUrl,
    createSession: (body) => request(CREATE_SESSION_OPERATION_NAME, body),
    sendMessage: (body, onFrame, onDelivery) =>
      stream(SEND_MESSAGE_OPERATION_NAME, body, onFrame, onDelivery),
    enqueueMessage: (body) => request(ENQUEUE_MESSAGE_OPERATION_NAME, body),
    resumeSession: (body, onFrame, onDelivery) =>
      stream(RESUME_SESSION_OPERATION_NAME, body, onFrame, onDelivery),
    watchEvents,
    listPendingPermissions: () => request(LIST_PENDING_PERMISSIONS_OPERATION_NAME, {}),
    getPendingQuestionnaire: (body) => request(GET_PENDING_QUESTIONNAIRE_OPERATION_NAME, body),
    replyPermission: (body) => request(REPLY_PERMISSION_OPERATION_NAME, body),
    replyQuestionnaire: (body) => request(REPLY_QUESTIONNAIRE_OPERATION_NAME, body),
    dismissQuestionnaire: (body) => request(DISMISS_QUESTIONNAIRE_OPERATION_NAME, body),
    abortSession: (body) => request(ABORT_SESSION_OPERATION_NAME, body),
    listQueueMessages: (body) => request(LIST_QUEUE_MESSAGES_OPERATION_NAME, body),
    deleteQueueItem: (body) => request(DELETE_QUEUE_ITEM_OPERATION_NAME, body),
    listModels: (body) => request(LIST_MODELS_OPERATION_NAME, body ?? {}),
    listSkills: (body) => request(LIST_SKILLS_OPERATION_NAME, body ?? {}),
    pluginManagement: (body) => request(PLUGIN_MANAGEMENT_OPERATION_NAME, body),
    listCronTasks: (body) => request(LIST_CRON_TASKS_OPERATION_NAME, body ?? {}),
    createCronTask: (body) => request(CREATE_CRON_TASK_OPERATION_NAME, body),
    updateCronTask: (body) => request(UPDATE_CRON_TASK_OPERATION_NAME, body),
    deleteCronTask: (body) => request(DELETE_CRON_TASK_OPERATION_NAME, body),
    runCronTaskNow: (body) => request(RUN_CRON_TASK_NOW_OPERATION_NAME, body),
    listCronTaskRuns: (body) => request(LIST_CRON_TASK_RUNS_OPERATION_NAME, body),
    getPermissionMode: () => request(GET_PERMISSION_MODE_OPERATION_NAME, {}),
    setPermissionMode: (body) => request(SET_PERMISSION_MODE_OPERATION_NAME, body),
    getGlobalInstructions: () => request(GET_GLOBAL_INSTRUCTIONS_OPERATION_NAME, {}),
    setGlobalInstructions: (body) => request(SET_GLOBAL_INSTRUCTIONS_OPERATION_NAME, body),
    getAgentMemory: (body) => request(GET_AGENT_MEMORY_OPERATION_NAME, body ?? {}),
    setAgentMemory: (body) => request(SET_AGENT_MEMORY_OPERATION_NAME, body),
    getUserProfile: () => request(GET_USER_PROFILE_OPERATION_NAME, undefined),
    setUserProfile: (body) => request(SET_USER_PROFILE_OPERATION_NAME, body),
    getMemorySettings: () => request(GET_MEMORY_SETTINGS_OPERATION_NAME, undefined),
    setMemorySettings: (body) => request(SET_MEMORY_SETTINGS_OPERATION_NAME, body),
    selectModel: (body) => request(SELECT_MODEL_OPERATION_NAME, body),
    getSessionUsage: (body) => request(GET_SESSION_USAGE_OPERATION_NAME, body),
    getUsageQuota: (body) => request(GET_USAGE_QUOTA_OPERATION_NAME, body ?? {}),
    getCreditFallback: () => request(GET_CREDIT_FALLBACK_OPERATION_NAME, {}),
    setCreditFallback: (body) => request(SET_CREDIT_FALLBACK_OPERATION_NAME, body),
    listResetCards: (body) => request(LIST_RESET_CARDS_OPERATION_NAME, body ?? {}),
    useResetCard: (body) => request(USE_RESET_CARD_OPERATION_NAME, body ?? {}),
    queryResetCardFlows: (body) =>
      request(QUERY_RESET_CARD_FLOWS_OPERATION_NAME, body ?? {}),
    getAccountUsageSummary: () => request(GET_ACCOUNT_USAGE_SUMMARY_OPERATION_NAME, {}),
    getAccountProfile: () => request(GET_ACCOUNT_PROFILE_OPERATION_NAME, {}),
    getSigninPanel: () => request(GET_SIGNIN_PANEL_OPERATION_NAME, {}),
    claimSignin: () => request(CLAIM_SIGNIN_OPERATION_NAME, {}),
    getAccountStatus: (body) => request(GET_ACCOUNT_STATUS_OPERATION_NAME, body ?? {}),
    listUserModelProviders: () => request(LIST_USER_MODEL_PROVIDERS_OPERATION_NAME, undefined),
    createUserModelProvider: (body) => request(CREATE_USER_MODEL_PROVIDER_OPERATION_NAME, body),
    updateUserModelProvider: (body) => request(UPDATE_USER_MODEL_PROVIDER_OPERATION_NAME, body),
    deleteUserModelProvider: (providerId) =>
      request(DELETE_USER_MODEL_PROVIDER_OPERATION_NAME, { providerId }),
    testUserModelProvider: (body) => request(TEST_USER_MODEL_PROVIDER_OPERATION_NAME, body),
    testUserModel: (body) => request(TEST_USER_MODEL_OPERATION_NAME, body),
    discoverUserModelsCandidate: (body) =>
      request(DISCOVER_USER_MODELS_CANDIDATE_OPERATION_NAME, body),
    saveUserModelProviderCandidate: (body) =>
      request(SAVE_USER_MODEL_PROVIDER_CANDIDATE_OPERATION_NAME, body),
    listProviderPresets: () => request(LIST_PROVIDER_PRESETS_OPERATION_NAME, undefined),
    getMiniMaxApiKeyStatus: () => request(GET_MINIMAX_API_KEY_STATUS_OPERATION_NAME, undefined),
    upsertMiniMaxApiKey: (body) => request(UPSERT_MINIMAX_API_KEY_OPERATION_NAME, body),
    getCodexOAuthStatus: () => request(GET_CODEX_OAUTH_STATUS_OPERATION_NAME, undefined),
    getMiniMaxModelSource: () => request(GET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, undefined),
    setMiniMaxModelSource: (source) => request(SET_MINIMAX_MODEL_SOURCE_OPERATION_NAME, { source }),
    testUserModelCandidate: (body) => request(TEST_USER_MODEL_CANDIDATE_OPERATION_NAME, body),
    revealModelProviderApiKey: (body) => request(REVEAL_MODEL_PROVIDER_API_KEY_OPERATION_NAME, body),
    startCodexOAuthLogin: (body) => request(START_CODEX_OAUTH_LOGIN_OPERATION_NAME, body ?? {}),
    cancelCodexOAuthLogin: (body) => request(CANCEL_CODEX_OAUTH_LOGIN_OPERATION_NAME, body),
    refreshModels: () => request(REFRESH_MODELS_OPERATION_NAME, undefined),
    signOut: () => request(SIGN_OUT_OPERATION_NAME, {}),
    beginAccountLogin: () => request(BEGIN_ACCOUNT_LOGIN_OPERATION_NAME, {}),
    getAccountLoginStatus: () => request(GET_ACCOUNT_LOGIN_STATUS_OPERATION_NAME, {}),
    cancelAccountLogin: () => request(CANCEL_ACCOUNT_LOGIN_OPERATION_NAME, {}),
    runCommand: (body) => request(RUN_COMMAND_OPERATION_NAME, body),
  } satisfies Required<WebuiTransport>;
}
