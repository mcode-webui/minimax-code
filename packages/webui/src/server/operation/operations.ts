import { versionOperation, listSessionsOperation, listVisibleProjectsOperation, getSessionTreeOperation, createSessionOperation, getSessionOperation, getActiveTurnOperation } from "./session.js";
import { listWorkspaceFileTreeOperation, browseWorkspaceDirsOperation, readWorkspaceFileOperation, getWorkspaceEnvironmentOperation, mutateWorkspaceGitOperation, getWorkspaceReviewSummaryOperation, listWorkspaceReviewFileDiffsOperation, getWorkspaceReviewFileContentOperation, searchWorkspaceReviewDiffsOperation, readCanvasOperation, applyCanvasOperation, readWorkspaceArchiveOperation, extractWorkspaceArchiveOperation, createTerminalOperation, listTerminalsOperation, writeTerminalOperation, resizeTerminalOperation, disposeTerminalOperation, watchTerminalOperation } from "./workspace.js";
import { getMessagesOperation, getSessionDiffOperation, getTurnDiffOperation, revertTurnDiffOperation, reapplyTurnDiffOperation, getSessionRewindPreviewOperation, rewindSessionOperation, editSessionMessageOperation } from "./messages.js";
import { isGoalEnabledOperation, getGoalOperation, createGoalOperation, patchGoalOperation, clearGoalOperation } from "./goal.js";
import { listCronsOperation, createCronOperation, updateCronOperation, deleteCronOperation, triggerCronOperation } from "./cron.js";
import { sendMessageOperation, enqueueMessageOperation, resumeSessionOperation } from "./interaction.js";
import { watchEventsOperation, listPendingPermissionsOperation, getPendingQuestionnaireOperation, replyPermissionOperation, replyQuestionnaireOperation, dismissQuestionnaireOperation } from "./questionnaire.js";
import { abortSessionOperation, listQueueMessagesOperation, deleteQueueItemOperation, listModelsOperation, listSkillsOperation, selectModelOperation, getSessionUsageOperation, getUsageQuotaOperation, getAccountStatusOperation } from "./queue.js";
import { pluginManagementOperation } from "./plugin-management.js";
import { getPermissionModeOperation, setPermissionModeOperation } from "./permission-mode.js";
import { archiveSessionOperation, deleteSessionOperation, updateSessionOperation, getSessionForkOptionsOperation, forkSessionOperation, listUserModelProvidersOperation, createUserModelProviderOperation, updateUserModelProviderOperation, deleteUserModelProviderOperation, testUserModelProviderOperation, testUserModelOperation, discoverUserModelsCandidateOperation, saveUserModelProviderCandidateOperation, listProviderPresetsOperation, getMiniMaxApiKeyStatusOperation, upsertMiniMaxApiKeyOperation, getCodexOAuthStatusOperation, getMiniMaxModelSourceOperation, setMiniMaxModelSourceOperation, testUserModelCandidateOperation, revealModelProviderApiKeyOperation, startCodexOAuthLoginOperation, cancelCodexOAuthLoginOperation, refreshModelsOperation, runCommandOperation, getSigninPanelOperation, claimSigninOperation, signOutOperation } from "./provider.js";
export { versionOperation, listSessionsOperation, listVisibleProjectsOperation, getSessionTreeOperation, createSessionOperation, getSessionOperation, getActiveTurnOperation } from "./session.js";
export { listWorkspaceFileTreeOperation, browseWorkspaceDirsOperation, readWorkspaceFileOperation, getWorkspaceEnvironmentOperation, mutateWorkspaceGitOperation, getWorkspaceReviewSummaryOperation, listWorkspaceReviewFileDiffsOperation, getWorkspaceReviewFileContentOperation, searchWorkspaceReviewDiffsOperation, readCanvasOperation, applyCanvasOperation, readWorkspaceArchiveOperation, extractWorkspaceArchiveOperation, createTerminalOperation, listTerminalsOperation, writeTerminalOperation, resizeTerminalOperation, disposeTerminalOperation, watchTerminalOperation } from "./workspace.js";
export { getMessagesOperation, getSessionDiffOperation, getTurnDiffOperation, revertTurnDiffOperation, reapplyTurnDiffOperation, getSessionRewindPreviewOperation, rewindSessionOperation, editSessionMessageOperation } from "./messages.js";
export { isGoalEnabledOperation, getGoalOperation, createGoalOperation, patchGoalOperation, clearGoalOperation } from "./goal.js";
export { listCronsOperation, createCronOperation, updateCronOperation, deleteCronOperation, triggerCronOperation } from "./cron.js";
export { sendMessageOperation, enqueueMessageOperation, resumeSessionOperation } from "./interaction.js";
export { watchEventsOperation, listPendingPermissionsOperation, getPendingQuestionnaireOperation, replyPermissionOperation, replyQuestionnaireOperation, dismissQuestionnaireOperation } from "./questionnaire.js";
export { abortSessionOperation, listQueueMessagesOperation, deleteQueueItemOperation, listModelsOperation, listSkillsOperation, selectModelOperation, getSessionUsageOperation, getUsageQuotaOperation, getAccountStatusOperation } from "./queue.js";
export { pluginManagementOperation } from "./plugin-management.js";
export { getPermissionModeOperation, setPermissionModeOperation } from "./permission-mode.js";
export { archiveSessionOperation, deleteSessionOperation, updateSessionOperation, getSessionForkOptionsOperation, forkSessionOperation, listUserModelProvidersOperation, createUserModelProviderOperation, updateUserModelProviderOperation, deleteUserModelProviderOperation, testUserModelProviderOperation, testUserModelOperation, discoverUserModelsCandidateOperation, saveUserModelProviderCandidateOperation, listProviderPresetsOperation, getMiniMaxApiKeyStatusOperation, upsertMiniMaxApiKeyOperation, getCodexOAuthStatusOperation, getMiniMaxModelSourceOperation, setMiniMaxModelSourceOperation, testUserModelCandidateOperation, revealModelProviderApiKeyOperation, startCodexOAuthLoginOperation, cancelCodexOAuthLoginOperation, refreshModelsOperation, runCommandOperation, getSigninPanelOperation, claimSigninOperation, signOutOperation } from "./provider.js";
import { createOperationHandlers, type WebuiOperationPort } from "./operation-handlers.js";
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

export function createOperationRegistry(
  port: WebuiOperationPort,
  terminal?: WebuiTerminalManager,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const registry = new Map<string, WebuiOperationRegistryEntry>();
  const handlers = createOperationHandlers(port, terminal);
  registerOperation(registry, {
    operation: createSessionOperation,
    handle: handlers.createSession,
  });
  registerOperation(registry, { operation: listWorkspaceFileTreeOperation, handle: handlers.listWorkspaceFileTree });
  registerOperation(registry, { operation: browseWorkspaceDirsOperation, handle: handlers.browseWorkspaceDirs });
  registerOperation(registry, { operation: readWorkspaceFileOperation, handle: handlers.readWorkspaceFile });
  registerOperation(registry, { operation: readCanvasOperation, handle: handlers.readCanvas });
  registerOperation(registry, { operation: applyCanvasOperation, handle: handlers.applyCanvas });
  registerOperation(registry, { operation: readWorkspaceArchiveOperation, handle: handlers.readWorkspaceArchive });
  registerOperation(registry, { operation: extractWorkspaceArchiveOperation, handle: handlers.extractWorkspaceArchive });
  registerOperation(registry, { operation: getWorkspaceEnvironmentOperation, handle: handlers.getWorkspaceEnvironment });
  registerOperation(registry, { operation: mutateWorkspaceGitOperation, handle: handlers.mutateWorkspaceGit });
  registerOperation(registry, { operation: getWorkspaceReviewSummaryOperation, handle: handlers.getWorkspaceReviewSummary });
  registerOperation(registry, { operation: listWorkspaceReviewFileDiffsOperation, handle: handlers.listWorkspaceReviewFileDiffs });
  registerOperation(registry, { operation: getWorkspaceReviewFileContentOperation, handle: handlers.getWorkspaceReviewFileContent });
  registerOperation(registry, { operation: searchWorkspaceReviewDiffsOperation, handle: handlers.searchWorkspaceReviewDiffs });
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
    registerOperation(registry, { operation: createTerminalOperation, handle: handlers.createTerminal });
    registerOperation(registry, { operation: listTerminalsOperation, handle: handlers.listTerminals });
    registerOperation(registry, { operation: writeTerminalOperation, handle: handlers.writeTerminal });
    registerOperation(registry, { operation: resizeTerminalOperation, handle: handlers.resizeTerminal });
    registerOperation(registry, { operation: disposeTerminalOperation, handle: handlers.disposeTerminal });
    registerOperation(registry, { operation: watchTerminalOperation, handle: handlers.watchTerminal });
  }
  registerOperation(registry, { operation: archiveSessionOperation, handle: handlers.archiveSession });
  registerOperation(registry, { operation: deleteSessionOperation, handle: handlers.deleteSession });
  registerOperation(registry, { operation: updateSessionOperation, handle: handlers.updateSession });
  registerOperation(registry, { operation: getSessionForkOptionsOperation, handle: handlers.getSessionForkOptions });
  registerOperation(registry, { operation: forkSessionOperation, handle: handlers.forkSession });
  registerOperation(registry, { operation: abortSessionOperation, handle: handlers.abortSession });
  registerOperation(registry, { operation: listQueueMessagesOperation, handle: handlers.listQueueMessages });
  registerOperation(registry, { operation: deleteQueueItemOperation, handle: handlers.deleteQueueItem });
  registerOperation(registry, { operation: listModelsOperation, handle: handlers.listModels });
  registerOperation(registry, { operation: selectModelOperation, handle: handlers.selectModel });
  registerOperation(registry, { operation: listSkillsOperation, handle: handlers.listSkills });
  registerOperation(registry, { operation: pluginManagementOperation, handle: handlers.pluginManagement });
  registerOperation(registry, { operation: getPermissionModeOperation, handle: handlers.getPermissionMode });
  registerOperation(registry, { operation: setPermissionModeOperation, handle: handlers.setPermissionMode });
  registerOperation(registry, { operation: getSessionUsageOperation, handle: handlers.getSessionUsage });
  registerOperation(registry, { operation: getUsageQuotaOperation, handle: handlers.getUsageQuota });
  registerOperation(registry, { operation: getSigninPanelOperation, handle: handlers.getSigninPanel });
  registerOperation(registry, { operation: claimSigninOperation, handle: handlers.claimSignin });
  registerOperation(registry, { operation: getAccountStatusOperation, handle: handlers.getAccountStatus });
  registerOperation(registry, { operation: listUserModelProvidersOperation, handle: handlers.listUserModelProviders });
  registerOperation(registry, { operation: createUserModelProviderOperation, handle: handlers.createUserModelProvider });
  registerOperation(registry, { operation: updateUserModelProviderOperation, handle: handlers.updateUserModelProvider });
  registerOperation(registry, { operation: deleteUserModelProviderOperation, handle: handlers.deleteUserModelProvider });
  registerOperation(registry, { operation: testUserModelProviderOperation, handle: handlers.testUserModelProvider });
  registerOperation(registry, { operation: testUserModelOperation, handle: handlers.testUserModel });
  registerOperation(registry, { operation: discoverUserModelsCandidateOperation, handle: handlers.discoverUserModelsCandidate });
  registerOperation(registry, { operation: saveUserModelProviderCandidateOperation, handle: handlers.saveUserModelProviderCandidate });
  registerOperation(registry, { operation: listProviderPresetsOperation, handle: handlers.listProviderPresets });
  registerOperation(registry, { operation: getMiniMaxApiKeyStatusOperation, handle: handlers.getMiniMaxApiKeyStatus });
  registerOperation(registry, { operation: upsertMiniMaxApiKeyOperation, handle: handlers.upsertMiniMaxApiKey });
  registerOperation(registry, { operation: getCodexOAuthStatusOperation, handle: handlers.getCodexOAuthStatus });
  registerOperation(registry, { operation: getMiniMaxModelSourceOperation, handle: handlers.getMiniMaxModelSource });
  registerOperation(registry, { operation: setMiniMaxModelSourceOperation, handle: handlers.setMiniMaxModelSource });
  registerOperation(registry, { operation: testUserModelCandidateOperation, handle: handlers.testUserModelCandidate });
  registerOperation(registry, { operation: revealModelProviderApiKeyOperation, handle: handlers.revealModelProviderApiKey });
  registerOperation(registry, { operation: startCodexOAuthLoginOperation, handle: handlers.startCodexOAuthLogin });
  registerOperation(registry, { operation: cancelCodexOAuthLoginOperation, handle: handlers.cancelCodexOAuthLogin });
  registerOperation(registry, { operation: refreshModelsOperation, handle: handlers.refreshModels });
  registerOperation(registry, { operation: runCommandOperation, handle: handlers.runCommand });
  registerOperation(registry, { operation: signOutOperation, handle: handlers.signOut });
  registerOperation(registry, { operation: watchEventsOperation, handle: handlers.watchEvents });
  registerOperation(registry, { operation: listPendingPermissionsOperation, handle: handlers.listPendingPermissions });
  registerOperation(registry, { operation: getPendingQuestionnaireOperation, handle: handlers.getPendingQuestionnaire });
  registerOperation(registry, { operation: replyPermissionOperation, handle: handlers.replyPermission });
  registerOperation(registry, { operation: replyQuestionnaireOperation, handle: handlers.replyQuestionnaire });
  registerOperation(registry, { operation: dismissQuestionnaireOperation, handle: handlers.dismissQuestionnaire });
  registerOperation(registry, { operation: versionOperation, handle: handlers.version });
  registerOperation(registry, { operation: getSessionOperation, handle: handlers.getSession });
  registerOperation(registry, { operation: getActiveTurnOperation, handle: handlers.getActiveTurn });
  registerOperation(registry, { operation: getMessagesOperation, handle: handlers.getMessages });
  registerOperation(registry, { operation: getSessionDiffOperation, handle: handlers.getSessionDiff });
  registerOperation(registry, { operation: getTurnDiffOperation, handle: handlers.getTurnDiff });
  registerOperation(registry, { operation: revertTurnDiffOperation, handle: handlers.revertTurnDiff });
  registerOperation(registry, { operation: reapplyTurnDiffOperation, handle: handlers.reapplyTurnDiff });
  registerOperation(registry, { operation: getSessionRewindPreviewOperation, handle: handlers.getSessionRewindPreview });
  registerOperation(registry, { operation: rewindSessionOperation, handle: handlers.rewindSession });
  registerOperation(registry, { operation: editSessionMessageOperation, handle: handlers.editSessionMessage });
  registerOperation(registry, { operation: isGoalEnabledOperation, handle: handlers.isGoalEnabled });
  registerOperation(registry, { operation: getGoalOperation, handle: handlers.getGoal });
  registerOperation(registry, { operation: createGoalOperation, handle: handlers.createGoal });
  registerOperation(registry, { operation: patchGoalOperation, handle: handlers.patchGoal });
  registerOperation(registry, { operation: clearGoalOperation, handle: handlers.clearGoal });
  registerOperation(registry, { operation: listCronsOperation, handle: handlers.listCrons });
  registerOperation(registry, { operation: createCronOperation, handle: handlers.createCron });
  registerOperation(registry, { operation: updateCronOperation, handle: handlers.updateCron });
  registerOperation(registry, { operation: deleteCronOperation, handle: handlers.deleteCron });
  registerOperation(registry, { operation: triggerCronOperation, handle: handlers.triggerCron });
  registerOperation(registry, { operation: listSessionsOperation, handle: handlers.listSessions });
  registerOperation(registry, { operation: listVisibleProjectsOperation, handle: handlers.listVisibleProjects });
  registerOperation(registry, { operation: getSessionTreeOperation, handle: handlers.getSessionTree });
  registerOperation(registry, { operation: sendMessageOperation, handle: handlers.sendMessage });
  registerOperation(registry, { operation: enqueueMessageOperation, handle: handlers.enqueueMessage });
  registerOperation(registry, { operation: resumeSessionOperation, handle: handlers.resumeSession });
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
