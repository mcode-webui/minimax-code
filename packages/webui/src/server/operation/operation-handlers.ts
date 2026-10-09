import { runWebuiCommand } from "../../runtime/commands/runner.js";
import type { WebuiHarnessPort } from "../../runtime/port.js";
import { listWorkspaceDirectories } from "./workspace.js";
import {
  projectContextSnapshot,
  projectSessionStream,
  projectUsage,
} from "../projections/index.js";
import type {
  WebuiOperationHandler,
  WebuiOperationValidation,
} from "./operation-contract.js";
import type { WebuiTerminalManager } from "../terminal.js";

type OperationModule = typeof import("./operations.js");
type OperationDescriptorName = Exclude<
  Extract<keyof OperationModule, `${string}Operation`>,
  "registerOperation"
>;
type OperationBody<DescriptorName extends OperationDescriptorName> =
  OperationModule[DescriptorName] extends {
    readonly validate: (body: unknown) => WebuiOperationValidation<infer Body>;
  }
    ? Body
    : never;

export type WebuiOperationPort = Pick<
  WebuiHarnessPort,
  | "version"
  | "listSessions"
  | "listVisibleProjects"
  | "getSessionTree"
  | "archiveSession"
  | "deleteSession"
  | "updateSession"
  | "getSessionForkOptions"
  | "forkSession"
  | "createSession"
  | "getSession"
  | "getMessages"
  | "getSessionDiff"
  | "getTurnDiff"
  | "revertTurnDiff"
  | "reapplyTurnDiff"
  | "getSessionRewindPreview"
  | "rewindSession"
  | "editSessionMessage"
  | "isGoalEnabled"
  | "getGoal"
  | "getActiveTurn"
  | "createGoal"
  | "patchGoal"
  | "clearGoal"
  | "listWorkspaceFileTree"
  | "readWorkspaceFile"
  | "getWorkspaceEnvironment"
  | "mutateWorkspaceGit"
  | "getWorkspaceReviewSummary"
  | "listWorkspaceReviewFileDiffs"
  | "getWorkspaceReviewFileContent"
  | "searchWorkspaceReviewDiffs"
  | "readCanvas"
  | "applyCanvas"
  | "readWorkspaceArchive"
  | "extractWorkspaceArchive"
  | "sendMessage"
  | "enqueueMessage"
  | "resumeSession"
  | "watchEvents"
  | "listPendingPermissions"
  | "getPendingQuestionnaire"
  | "replyPermission"
  | "replyQuestionnaire"
  | "dismissQuestionnaire"
  | "abortSession"
  | "listQueueMessages"
  | "deleteQueueItem"
  | "listModels"
  | "selectModel"
  | "listSkills"
  | "pluginManagement"
  | "getPermissionMode"
  | "setPermissionMode"
  | "getSessionUsage"
  | "getUsageQuota"
  | "getSigninPanel"
  | "claimSignin"
  | "beginAccountLogin"
  | "getAccountLoginStatus"
  | "cancelAccountLogin"
  | "signOutAccount"
  | "getAccountStatus"
  | "listUserModelProviders"
  | "createUserModelProvider"
  | "updateUserModelProvider"
  | "deleteUserModelProvider"
  | "testUserModelProvider"
  | "testUserModel"
  | "discoverUserModelsCandidate"
  | "saveUserModelProviderCandidate"
  | "listProviderPresets"
  | "getMiniMaxApiKeyStatus"
  | "upsertMiniMaxApiKey"
  | "getCodexOAuthStatus"
  | "getMiniMaxModelSource"
  | "setMiniMaxModelSource"
  | "testUserModelCandidate"
  | "revealModelProviderApiKey"
  | "startCodexOAuthLogin"
  | "cancelCodexOAuthLogin"
  | "refreshModels"
  | "requestCompaction"
  | "invalidateAuth"
  | "getGlobalInstructions"
  | "setGlobalInstructions"
  | "getAgentMemory"
  | "setAgentMemory"
  | "getUserProfile"
  | "setUserProfile"
  | "getMemorySettings"
  | "setMemorySettings"
>;

export type WebuiOperationHandlers = {
  [DescriptorName in OperationDescriptorName as DescriptorName extends `${infer Name}Operation`
    ? Name
    : never]: WebuiOperationHandler<OperationBody<DescriptorName>, unknown>;
};

export function createOperationHandlers(
  port: WebuiOperationPort,
  terminal?: WebuiTerminalManager,
): WebuiOperationHandlers {
  const handlers: WebuiOperationHandlers = {
    createSession: async (_context, body) => ({
      body: await port.createSession(body),
    }),
    listWorkspaceFileTree: async (_context, body) => ({
      body: await port.listWorkspaceFileTree(body),
    }),
    // Server-local, not a harness port call: the browser cannot hand the
    // WebUI an absolute path, so the picker asks this process — which
    // already serves this machine's files, git and terminals — to name
    // the candidates.
    browseWorkspaceDirs: async (_context, body) => ({
      body: listWorkspaceDirectories(body.dir),
    }),
    readWorkspaceFile: async (_context, body) => ({
      body: await port.readWorkspaceFile(body),
    }),
    readCanvas: async (_context, body) => ({
      body: await port.readCanvas(body),
    }),
    applyCanvas: async (_context, body) => ({
      body: await port.applyCanvas(body),
    }),
    readWorkspaceArchive: async (_context, body) => ({
      body: await port.readWorkspaceArchive(body),
    }),
    extractWorkspaceArchive: async (_context, body) => ({
      body: await port.extractWorkspaceArchive(body),
    }),
    getWorkspaceEnvironment: async (_context, body) => ({
      body: await port.getWorkspaceEnvironment(body),
    }),
    mutateWorkspaceGit: async (_context, body) => ({
      body: await port.mutateWorkspaceGit(body),
    }),
    getWorkspaceReviewSummary: async (_context, body) => ({ body: await port.getWorkspaceReviewSummary(body) }),
    listWorkspaceReviewFileDiffs: async (_context, body) => ({ body: await port.listWorkspaceReviewFileDiffs(body) }),
    getWorkspaceReviewFileContent: async (_context, body) => ({ body: await port.getWorkspaceReviewFileContent(body) }),
    searchWorkspaceReviewDiffs: async (_context, body) => ({ body: await port.searchWorkspaceReviewDiffs(body) }),
    createTerminal: async (_context, body) => ({
      body: terminal!.create(String((body as Record<string, unknown>).workspaceDir ?? process.cwd())),
    }),
    listTerminals: async () => ({
      body: terminal!.list() as readonly { readonly terminalId: string; readonly status: "running" | "exited"; readonly output: string }[],
    }),
    writeTerminal: async (_context, body) => ({
      body: terminal!.write(String(body.terminalId), String(body.data ?? "")),
    }),
    resizeTerminal: async (_context, body) => {
      const value = body as Record<string, unknown>;
      return { body: terminal!.resize(String(value.terminalId), Number(value.cols), Number(value.rows)) };
    },
    disposeTerminal: async (_context, body) => ({
      body: terminal!.dispose(String((body as Record<string, unknown>).terminalId)),
    }),
    watchTerminal: (_context, body) => ({
      stream: {
        ok: true,
        source: terminal!.watch(
          String((body as Record<string, unknown>).terminalId),
          _context.signal,
        ) as unknown as AsyncIterable<Record<string, unknown>>,
      },
    }),
    archiveSession: async (_context, body) => ({ body: await port.archiveSession(body) }),
    deleteSession: async (_context, body) => ({ body: await port.deleteSession(body) }),
    updateSession: async (_context, body) => ({ body: await port.updateSession(body) }),
    getSessionForkOptions: async (_context, body) => ({ body: await port.getSessionForkOptions(body) }),
    forkSession: async (_context, body) => ({ body: await port.forkSession(body) }),
    abortSession: async (_context, body) => ({ body: await port.abortSession(body) }),
    listQueueMessages: async (_context, body) => ({ body: await port.listQueueMessages(body) }),
    deleteQueueItem: async (_context, body) => ({ body: await port.deleteQueueItem(body) }),
    listModels: async (_context, body) => ({ body: await port.listModels(body) }),
    selectModel: async (_context, body) => ({ body: await port.selectModel(body) }),
    listSkills: async (_context, body) => ({ body: await port.listSkills(body) }),
    pluginManagement: async (_context, body) => {
      if (!port.pluginManagement) throw new Error("runtime host does not expose plugin management");
      return { body: await port.pluginManagement(body) };
    },
    getPermissionMode: async () => {
      if (!port.getPermissionMode) throw new Error("runtime host does not expose permission mode reads");
      return { body: await port.getPermissionMode() };
    },
    setPermissionMode: async (_context, body) => {
      if (!port.setPermissionMode) throw new Error("runtime host does not expose permission mode updates");
      return { body: await port.setPermissionMode(body) };
    },
    getGlobalInstructions: async () => {
      if (!port.getGlobalInstructions) throw new Error("runtime host does not expose global instructions reads");
      return { body: await port.getGlobalInstructions() };
    },
    setGlobalInstructions: async (_context, body) => {
      if (!port.setGlobalInstructions) throw new Error("runtime host does not expose global instructions updates");
      return { body: await port.setGlobalInstructions(body) };
    },
    getAgentMemory: async (_context, body) => {
      if (!port.getAgentMemory) throw new Error("runtime host does not expose agent memory reads");
      return { body: await port.getAgentMemory(body) };
    },
    setAgentMemory: async (_context, body) => {
      if (!port.setAgentMemory) throw new Error("runtime host does not expose agent memory updates");
      return { body: await port.setAgentMemory(body) };
    },
    getUserProfile: async () => {
      if (!port.getUserProfile) throw new Error("runtime host does not expose user profile reads");
      return { body: await port.getUserProfile() };
    },
    setUserProfile: async (_context, body) => {
      if (!port.setUserProfile) throw new Error("runtime host does not expose user profile updates");
      return { body: await port.setUserProfile(body) };
    },
    getMemorySettings: async () => {
      if (!port.getMemorySettings) throw new Error("runtime host does not expose memory settings");
      return { body: await port.getMemorySettings() };
    },
    setMemorySettings: async (_context, body) => {
      if (!port.setMemorySettings) throw new Error("runtime host does not expose memory settings updates");
      return { body: await port.setMemorySettings(body) };
    },
    getSessionUsage: async (_context, body) => ({ body: await port.getSessionUsage(body) }),
    getUsageQuota: async (_context, body) => ({ body: await port.getUsageQuota(body) }),
    getSigninPanel: async () => ({ body: await port.getSigninPanel() }),
    beginAccountLogin: async () => ({ body: await port.beginAccountLogin() }),
    getAccountLoginStatus: async () => ({ body: await port.getAccountLoginStatus() }),
    cancelAccountLogin: async () => ({ body: await port.cancelAccountLogin() }),
    claimSignin: async () => ({ body: await port.claimSignin() }),
    getAccountStatus: async (_context, body) => ({ body: await port.getAccountStatus(body) }),
    listUserModelProviders: async () => ({ body: await port.listUserModelProviders() }),
    createUserModelProvider: async (_context, body) => ({ body: await port.createUserModelProvider(body) }),
    updateUserModelProvider: async (_context, body) => ({ body: await port.updateUserModelProvider(body) }),
    deleteUserModelProvider: async (_context, body) => ({ body: await port.deleteUserModelProvider((body as Record<string, unknown>).providerId as string) }),
    testUserModelProvider: async (_context, body) => ({ body: await port.testUserModelProvider(body) }),
    testUserModel: async (_context, body) => ({ body: await port.testUserModel(body) }),
    discoverUserModelsCandidate: async (_context, body) => ({ body: await port.discoverUserModelsCandidate(body) }),
    saveUserModelProviderCandidate: async (_context, body) => ({ body: await port.saveUserModelProviderCandidate(body) }),
    listProviderPresets: async () => ({ body: await port.listProviderPresets() }),
    getMiniMaxApiKeyStatus: async () => ({ body: await port.getMiniMaxApiKeyStatus() }),
    upsertMiniMaxApiKey: async (_context, body) => ({ body: await port.upsertMiniMaxApiKey(body) }),
    getCodexOAuthStatus: async () => ({ body: await port.getCodexOAuthStatus() }),
    getMiniMaxModelSource: async () => ({ body: await port.getMiniMaxModelSource() }),
    setMiniMaxModelSource: async (_context, body) => ({ body: await port.setMiniMaxModelSource(body) }),
    testUserModelCandidate: async (_context, body) => ({ body: await port.testUserModelCandidate(body as { candidate: Record<string, unknown>; modelId: string }) }),
    revealModelProviderApiKey: async (_context, body) => ({ body: await port.revealModelProviderApiKey(body) }),
    startCodexOAuthLogin: async (_context, body) => ({ body: await port.startCodexOAuthLogin(body) }),
    cancelCodexOAuthLogin: async (_context, body) => ({ body: await port.cancelCodexOAuthLogin(body) }),
    refreshModels: async () => ({ body: await port.refreshModels() }),
    runCommand: async (_context, body) => ({ body: await runWebuiCommand(port, body) }),
    signOut: async () => {
      // The real sign-out removes the credential (revoke + wipe). The
      // invalidation-only path remains as a fallback for hosts assembled
      // before `signOutAccount` existed; on those, sign-out degrades to the
      // historical behaviour instead of failing the operation.
      if (port.signOutAccount) await port.signOutAccount();
      else await port.invalidateAuth();
      return { body: { success: true as const } };
    },
    watchEvents: (context) => ({
      stream: { ok: true, source: port.watchEvents(context.signal) },
    }),
    listPendingPermissions: async () => ({ body: await port.listPendingPermissions() }),
    getPendingQuestionnaire: async (_context, body) => ({ body: await port.getPendingQuestionnaire(body) }),
    replyPermission: async (_context, body) => ({ body: await port.replyPermission(body) }),
    replyQuestionnaire: async (_context, body) => ({ body: await port.replyQuestionnaire(body) }),
    dismissQuestionnaire: async (_context, body) => ({ body: await port.dismissQuestionnaire(body) }),
    version: () => ({ body: port.version() }),
    getSession: async (_context, body) => ({ body: await port.getSession(body) }),
    getMessages: async (_context, body) => {
      const result = await port.getMessages(body);
      const messages = result.messages ?? [];
      const turnId =
        [...messages].reverse().find((message) => message.turnId)?.turnId ?? "";
      return {
        body: {
          ...result,
          contextSnapshot: projectContextSnapshot({
            active: false,
            messages: messages.map((message) => ({
              kind: message.kind,
              timestamp: message.timestamp,
              rawJson: JSON.stringify(message),
            })),
          }) as unknown as Record<string, unknown>,
          usage: projectUsage(messages, turnId),
        },
      };
    },
    getSessionDiff: async (_context, body) => ({ body: await port.getSessionDiff(body) }),
    getTurnDiff: async (_context, body) => ({ body: await port.getTurnDiff(body) }),
    revertTurnDiff: async (_context, body) => ({ body: await port.revertTurnDiff(body) }),
    reapplyTurnDiff: async (_context, body) => ({ body: await port.reapplyTurnDiff(body) }),
    getSessionRewindPreview: async (_context, body) => ({ body: await port.getSessionRewindPreview(body) }),
    rewindSession: async (_context, body) => ({ body: await port.rewindSession(body) }),
    editSessionMessage: async (_context, body) => ({ body: await port.editSessionMessage(body) }),
    isGoalEnabled: async () => ({ body: await port.isGoalEnabled() }),
    getGoal: async (_context, body) => ({ body: await port.getGoal(body) }),
    getActiveTurn: async (_context, body) => ({ body: await port.getActiveTurn(body) }),
    createGoal: async (_context, body) => ({ body: await port.createGoal(body) }),
    patchGoal: async (_context, body) => ({ body: await port.patchGoal(body) }),
    clearGoal: async (_context, body) => ({ body: await port.clearGoal(body) }),
    listSessions: async (_context, body) => ({ body: await port.listSessions(body) }),
    listVisibleProjects: async (_context, body) => {
      if (!port.listVisibleProjects) throw new Error("runtime host does not expose project listing");
      return { body: await port.listVisibleProjects(body) };
    },
    getSessionTree: async (_context, body) => ({ body: await port.getSessionTree(body) }),
    sendMessage: async (context, body) => {
      const stream = await port.sendMessage(body, context.signal);
      return {
        stream: stream.ok
          ? { ...stream, source: projectSessionStream(stream.source) }
          : stream,
      };
    },
    enqueueMessage: async (_context, body) => ({ body: await port.enqueueMessage(body) }),
    resumeSession: async (context, body) => {
      const stream = await port.resumeSession(body, context.signal);
      return {
        stream: stream.ok
          ? { ...stream, source: projectSessionStream(stream.source) }
          : stream,
      };
    },
  };

  return handlers;
}
