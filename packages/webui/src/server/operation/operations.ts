import { versionOperation, listSessionsOperation, listVisibleProjectsOperation, getSessionTreeOperation, createSessionOperation, getSessionOperation, getActiveTurnOperation } from "./session.js";
import { listWorkspaceFileTreeOperation, browseWorkspaceDirsOperation, readWorkspaceFileOperation, getWorkspaceEnvironmentOperation, mutateWorkspaceGitOperation, getWorkspaceReviewSummaryOperation, listWorkspaceReviewFileDiffsOperation, getWorkspaceReviewFileContentOperation, searchWorkspaceReviewDiffsOperation, readCanvasOperation, applyCanvasOperation, readWorkspaceArchiveOperation, extractWorkspaceArchiveOperation, createTerminalOperation, listTerminalsOperation, writeTerminalOperation, resizeTerminalOperation, disposeTerminalOperation, watchTerminalOperation } from "./workspace.js";
import { getMessagesOperation, getSessionDiffOperation, getTurnDiffOperation, revertTurnDiffOperation, reapplyTurnDiffOperation, getSessionRewindPreviewOperation, rewindSessionOperation, editSessionMessageOperation } from "./messages.js";
import { isGoalEnabledOperation, getGoalOperation, createGoalOperation, patchGoalOperation, clearGoalOperation } from "./goal.js";
import { sendMessageOperation, enqueueMessageOperation, resumeSessionOperation } from "./interaction.js";
import { watchEventsOperation, listPendingPermissionsOperation, getPendingQuestionnaireOperation, replyPermissionOperation, replyQuestionnaireOperation, dismissQuestionnaireOperation } from "./questionnaire.js";
import { abortSessionOperation, listQueueMessagesOperation, deleteQueueItemOperation, listModelsOperation, listSkillsOperation, selectModelOperation, getSessionUsageOperation, getUsageQuotaOperation, getAccountStatusOperation } from "./queue.js";
import { pluginManagementOperation } from "./plugin-management.js";
import { getPermissionModeOperation, setPermissionModeOperation } from "./permission-mode.js";
import { getGlobalInstructionsOperation, setGlobalInstructionsOperation } from "./personalization.js";
import { getAgentMemoryOperation, setAgentMemoryOperation } from "./agent-memory.js";
import { getUserProfileOperation, setUserProfileOperation } from "./user-profile.js";
import { getMemorySettingsOperation, setMemorySettingsOperation } from "./memory-settings.js";
import { archiveSessionOperation, deleteSessionOperation, updateSessionOperation, getSessionForkOptionsOperation, forkSessionOperation, listUserModelProvidersOperation, createUserModelProviderOperation, updateUserModelProviderOperation, deleteUserModelProviderOperation, testUserModelProviderOperation, testUserModelOperation, discoverUserModelsCandidateOperation, saveUserModelProviderCandidateOperation, listProviderPresetsOperation, getMiniMaxApiKeyStatusOperation, upsertMiniMaxApiKeyOperation, getCodexOAuthStatusOperation, getMiniMaxModelSourceOperation, setMiniMaxModelSourceOperation, testUserModelCandidateOperation, revealModelProviderApiKeyOperation, startCodexOAuthLoginOperation, cancelCodexOAuthLoginOperation, refreshModelsOperation, runCommandOperation, getSigninPanelOperation, claimSigninOperation, signOutOperation, beginAccountLoginOperation, getAccountLoginStatusOperation, cancelAccountLoginOperation } from "./provider.js";
export { versionOperation, listSessionsOperation, listVisibleProjectsOperation, getSessionTreeOperation, createSessionOperation, getSessionOperation, getActiveTurnOperation } from "./session.js";
export { listWorkspaceFileTreeOperation, browseWorkspaceDirsOperation, readWorkspaceFileOperation, getWorkspaceEnvironmentOperation, mutateWorkspaceGitOperation, getWorkspaceReviewSummaryOperation, listWorkspaceReviewFileDiffsOperation, getWorkspaceReviewFileContentOperation, searchWorkspaceReviewDiffsOperation, readCanvasOperation, applyCanvasOperation, readWorkspaceArchiveOperation, extractWorkspaceArchiveOperation, createTerminalOperation, listTerminalsOperation, writeTerminalOperation, resizeTerminalOperation, disposeTerminalOperation, watchTerminalOperation } from "./workspace.js";
export { getMessagesOperation, getSessionDiffOperation, getTurnDiffOperation, revertTurnDiffOperation, reapplyTurnDiffOperation, getSessionRewindPreviewOperation, rewindSessionOperation, editSessionMessageOperation } from "./messages.js";
export { isGoalEnabledOperation, getGoalOperation, createGoalOperation, patchGoalOperation, clearGoalOperation } from "./goal.js";
export { sendMessageOperation, enqueueMessageOperation, resumeSessionOperation } from "./interaction.js";
export { watchEventsOperation, listPendingPermissionsOperation, getPendingQuestionnaireOperation, replyPermissionOperation, replyQuestionnaireOperation, dismissQuestionnaireOperation } from "./questionnaire.js";
export { abortSessionOperation, listQueueMessagesOperation, deleteQueueItemOperation, listModelsOperation, listSkillsOperation, selectModelOperation, getSessionUsageOperation, getUsageQuotaOperation, getAccountStatusOperation } from "./queue.js";
export { pluginManagementOperation } from "./plugin-management.js";
export { getPermissionModeOperation, setPermissionModeOperation } from "./permission-mode.js";
export { getGlobalInstructionsOperation, setGlobalInstructionsOperation } from "./personalization.js";
export { getAgentMemoryOperation, setAgentMemoryOperation } from "./agent-memory.js";
export { getUserProfileOperation, setUserProfileOperation } from "./user-profile.js";
export { getMemorySettingsOperation, setMemorySettingsOperation } from "./memory-settings.js";
export { archiveSessionOperation, deleteSessionOperation, updateSessionOperation, getSessionForkOptionsOperation, forkSessionOperation, listUserModelProvidersOperation, createUserModelProviderOperation, updateUserModelProviderOperation, deleteUserModelProviderOperation, testUserModelProviderOperation, testUserModelOperation, discoverUserModelsCandidateOperation, saveUserModelProviderCandidateOperation, listProviderPresetsOperation, getMiniMaxApiKeyStatusOperation, upsertMiniMaxApiKeyOperation, getCodexOAuthStatusOperation, getMiniMaxModelSourceOperation, setMiniMaxModelSourceOperation, testUserModelCandidateOperation, revealModelProviderApiKeyOperation, startCodexOAuthLoginOperation, cancelCodexOAuthLoginOperation, refreshModelsOperation, runCommandOperation, getSigninPanelOperation, claimSigninOperation, signOutOperation, beginAccountLoginOperation, getAccountLoginStatusOperation, cancelAccountLoginOperation } from "./provider.js";
import {
  createBindingEntries,
  type WebuiOperationPort,
} from "./bind-handlers.js";
import { createWorkspaceHandlerEntries } from "./handlers/workspace.js";
import { createTerminalHandlerEntries } from "./handlers/terminal.js";
import { createCommandHandlerEntries } from "./handlers/commands.js";
import { createAccountHandlerEntries } from "./handlers/account.js";
import { createStreamHandlerEntries } from "./handlers/stream.js";
import { createMessageHandlerEntries } from "./handlers/messages.js";
import type {
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationRegistration,
} from "./operation-contract.js";
import type { WebuiTerminalManager } from "../terminal.js";
export type {
  WebuiOperation,
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationRegistration,
  WebuiOperationResult,
} from "./operation-contract.js";

/**
 * Builds the operation registry: 86 statically declared bindings plus the 13
 * operations that keep dedicated handlers.
 *
 * The registration order below is observable on the wire and must not change;
 * each call site is kept in the position the old handler map used. The map is
 * built once so a lookup miss (a name with neither a binding nor a dedicated
 * handler) fails loudly at assembly instead of silently dropping an operation.
 */
export function createOperationRegistry(
  port: WebuiOperationPort,
  terminal?: WebuiTerminalManager,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const registry = new Map<string, WebuiOperationRegistryEntry>();
  const entries = new Map<string, WebuiOperationRegistryEntry>([
    ...createBindingEntries(port),
    ...createWorkspaceHandlerEntries(),
    ...createCommandHandlerEntries(port),
    ...createAccountHandlerEntries(port),
    ...createStreamHandlerEntries(port),
    ...createMessageHandlerEntries(port),
    ...(terminal ? createTerminalHandlerEntries(terminal) : []),
  ]);
  const entry = (name: string): WebuiOperationRegistryEntry => {
    const found = entries.get(name);
    if (!found) throw new Error(`operation ${name} has no handler`);
    return found;
  };
  registerOperation(registry, entry("createSession"));
  registerOperation(registry, entry("listWorkspaceFileTree"));
  registerOperation(registry, entry("browseWorkspaceDirs"));
  registerOperation(registry, entry("readWorkspaceFile"));
  registerOperation(registry, entry("readCanvas"));
  registerOperation(registry, entry("applyCanvas"));
  registerOperation(registry, entry("readWorkspaceArchive"));
  registerOperation(registry, entry("extractWorkspaceArchive"));
  registerOperation(registry, entry("getWorkspaceEnvironment"));
  registerOperation(registry, entry("mutateWorkspaceGit"));
  registerOperation(registry, entry("getWorkspaceReviewSummary"));
  registerOperation(registry, entry("listWorkspaceReviewFileDiffs"));
  registerOperation(registry, entry("getWorkspaceReviewFileContent"));
  registerOperation(registry, entry("searchWorkspaceReviewDiffs"));
  // The terminal adapter is a real second surface (the PTY bridge the WebUI
  // shares with the desktop); it's a separate runtime from the harness port
  // and only the WebuiService wires one in. When none is supplied, the six
  // terminal operations stay unregistered so an inbound frame becomes an
  // `unknown_operation` error instead of a "method is not a function" runtime
  // explosion — same wire contract a cold-started TUI emits before its PTY
  // bridge comes up.
  //
  // Wire-error contract for the 18 previously-gated operations
  // -------------------------------------------------------
  // Before batch C the registry construction was guarded by six capability
  // groups that depended on optional port methods (`if (port.getSessionDiff
  // && port.getTurnDiff && ...)`, etc.). A host that lacked one of those
  // optional methods ended up with an operation that was *not in the
  // registry*. The dispatcher in `operation-dispatch.ts` looks the registry
  // up first, so the error code on the wire was `unknown_operation`
  // ("unknown operation: getSessionDiff"), with code `unknown_operation`,
  // and the handler never ran.
  //
  // Batch C removed the six capability gates. Those 18 operations now
  // register unconditionally, every WebuiHarnessPort implementor must
  // supply the matching methods (the type-checked port guarantees it),
  // and the dispatcher's lookup never misses. When the harness is honest
  // about a missing capability — e.g. `cliService.getSessionDiff` is
  // undefined and the host's nested guard throws "session diff is
  // unavailable" — that throw propagates through the handler's try/catch,
  // which forwards it as an error frame with code `harness_error`. The
  // old "X is unavailable" `Promise.reject` forwarders from `service.ts`
  // (18 of them) were deleted in batch C because they were unreachable:
  // any operation that reached them would have been unregistered and
  // short-circuited by the registry lookup; they only ever ran under the
  // wrong code path (`registry.get(x) ?? <forwarder>`), which the new
  // type-checked seam makes impossible.
  if (terminal) {
    registerOperation(registry, entry("createTerminal"));
    registerOperation(registry, entry("listTerminals"));
    registerOperation(registry, entry("writeTerminal"));
    registerOperation(registry, entry("resizeTerminal"));
    registerOperation(registry, entry("disposeTerminal"));
    registerOperation(registry, entry("watchTerminal"));
  }
  registerOperation(registry, entry("archiveSession"));
  registerOperation(registry, entry("deleteSession"));
  registerOperation(registry, entry("updateSession"));
  registerOperation(registry, entry("getSessionForkOptions"));
  registerOperation(registry, entry("forkSession"));
  registerOperation(registry, entry("abortSession"));
  registerOperation(registry, entry("listQueueMessages"));
  registerOperation(registry, entry("deleteQueueItem"));
  registerOperation(registry, entry("listModels"));
  registerOperation(registry, entry("selectModel"));
  registerOperation(registry, entry("listSkills"));
  registerOperation(registry, entry("pluginManagement"));
  registerOperation(registry, entry("getPermissionMode"));
  registerOperation(registry, entry("setPermissionMode"));
  registerOperation(registry, entry("getGlobalInstructions"));
  registerOperation(registry, entry("setGlobalInstructions"));
  registerOperation(registry, entry("getAgentMemory"));
  registerOperation(registry, entry("setAgentMemory"));
  registerOperation(registry, entry("getUserProfile"));
  registerOperation(registry, entry("setUserProfile"));
  registerOperation(registry, entry("getMemorySettings"));
  registerOperation(registry, entry("setMemorySettings"));
  registerOperation(registry, entry("getSessionUsage"));
  registerOperation(registry, entry("getUsageQuota"));
  registerOperation(registry, entry("getSigninPanel"));
  registerOperation(registry, entry("claimSignin"));
  registerOperation(registry, entry("beginAccountLogin"));
  registerOperation(registry, entry("getAccountLoginStatus"));
  registerOperation(registry, entry("cancelAccountLogin"));
  registerOperation(registry, entry("getAccountStatus"));
  registerOperation(registry, entry("listUserModelProviders"));
  registerOperation(registry, entry("createUserModelProvider"));
  registerOperation(registry, entry("updateUserModelProvider"));
  registerOperation(registry, entry("deleteUserModelProvider"));
  registerOperation(registry, entry("testUserModelProvider"));
  registerOperation(registry, entry("testUserModel"));
  registerOperation(registry, entry("discoverUserModelsCandidate"));
  registerOperation(registry, entry("saveUserModelProviderCandidate"));
  registerOperation(registry, entry("listProviderPresets"));
  registerOperation(registry, entry("getMiniMaxApiKeyStatus"));
  registerOperation(registry, entry("upsertMiniMaxApiKey"));
  registerOperation(registry, entry("getCodexOAuthStatus"));
  registerOperation(registry, entry("getMiniMaxModelSource"));
  registerOperation(registry, entry("setMiniMaxModelSource"));
  registerOperation(registry, entry("testUserModelCandidate"));
  registerOperation(registry, entry("revealModelProviderApiKey"));
  registerOperation(registry, entry("startCodexOAuthLogin"));
  registerOperation(registry, entry("cancelCodexOAuthLogin"));
  registerOperation(registry, entry("refreshModels"));
  registerOperation(registry, entry("runCommand"));
  registerOperation(registry, entry("signOut"));
  registerOperation(registry, entry("watchEvents"));
  registerOperation(registry, entry("listPendingPermissions"));
  registerOperation(registry, entry("getPendingQuestionnaire"));
  registerOperation(registry, entry("replyPermission"));
  registerOperation(registry, entry("replyQuestionnaire"));
  registerOperation(registry, entry("dismissQuestionnaire"));
  registerOperation(registry, entry("version"));
  registerOperation(registry, entry("getSession"));
  registerOperation(registry, entry("getActiveTurn"));
  registerOperation(registry, entry("getMessages"));
  registerOperation(registry, entry("getSessionDiff"));
  registerOperation(registry, entry("getTurnDiff"));
  registerOperation(registry, entry("revertTurnDiff"));
  registerOperation(registry, entry("reapplyTurnDiff"));
  registerOperation(registry, entry("getSessionRewindPreview"));
  registerOperation(registry, entry("rewindSession"));
  registerOperation(registry, entry("editSessionMessage"));
  registerOperation(registry, entry("isGoalEnabled"));
  registerOperation(registry, entry("getGoal"));
  registerOperation(registry, entry("createGoal"));
  registerOperation(registry, entry("patchGoal"));
  registerOperation(registry, entry("clearGoal"));
  registerOperation(registry, entry("listSessions"));
  registerOperation(registry, entry("listVisibleProjects"));
  registerOperation(registry, entry("getSessionTree"));
  registerOperation(registry, entry("sendMessage"));
  registerOperation(registry, entry("enqueueMessage"));
  registerOperation(registry, entry("resumeSession"));
  return registry;
}

/**
 * Registers one operation. Throws if the operation is missing a
 * `validate` function or the validator rejects everything by default;
 * fail-closed at registration time so the service never accepts a
 * request whose body it cannot structurally verify.
 */
export function registerOperation<Body, ResultBody = Body>(
  registry: Map<string, WebuiOperationRegistryEntry>,
  registration: WebuiOperationRegistration<Body, ResultBody>,
): void {
  const { operation, handle } = registration;
  if (typeof operation.validate !== "function")
    throw new Error(
      `operation ${operation.name} has no body validator; refusing to register`,
    );
  registry.set(operation.name, {
    operation,
    handle: handle as WebuiOperationHandler<unknown>,
  });
}
