// Typed operation bindings and their executor.
//
// A binding is a *statically declared* one-to-one mapping from a wire
// operation to one runtime capability method. Nothing here enumerates runtime
// methods, and no request body can choose a runtime member: the group, the
// method and the operation name are fixed in the declaration before the
// callbacks are checked.
//
// The declaration helper fixes group → method → operation name, then checks
// the argument tuple against that method's parameters and the result mapper
// against the operation's declared response type. A wrong group, a wrong
// method, a wrong argument tuple or a wrong response mapper fails to compile.
// Binding declarations contain no `any`, no type assertions and no non-null
// assertions; the only registry-type erasure lives in `executeBinding`.
//
// The 13 operations that shape a response, degrade when a capability is absent
// or carry a stream/terminal/command shape keep dedicated handlers in
// `./handlers/`; they are not bindings.
import type { WebuiHarnessPort } from "../../runtime/port.js";
import type { OperationSpec } from "../../shared/operation-names.js";
import type {
  WebuiOperationContext,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "./operation-contract.js";
import {
  versionOperation,
  listSessionsOperation,
  listVisibleProjectsOperation,
  getSessionTreeOperation,
  createSessionOperation,
  getSessionOperation,
  getActiveTurnOperation,
} from "./session.js";
import {
  listWorkspaceFileTreeOperation,
  readWorkspaceFileOperation,
  getWorkspaceEnvironmentOperation,
  mutateWorkspaceGitOperation,
  getWorkspaceReviewSummaryOperation,
  listWorkspaceReviewFileDiffsOperation,
  getWorkspaceReviewFileContentOperation,
  searchWorkspaceReviewDiffsOperation,
  readCanvasOperation,
  applyCanvasOperation,
  readWorkspaceArchiveOperation,
  extractWorkspaceArchiveOperation,
} from "./workspace.js";
import {
  getSessionDiffOperation,
  getTurnDiffOperation,
  revertTurnDiffOperation,
  reapplyTurnDiffOperation,
  getSessionRewindPreviewOperation,
  rewindSessionOperation,
  editSessionMessageOperation,
} from "./messages.js";
import {
  isGoalEnabledOperation,
  getGoalOperation,
  createGoalOperation,
  patchGoalOperation,
  clearGoalOperation,
} from "./goal.js";
import { enqueueMessageOperation } from "./interaction.js";
import {
  listPendingPermissionsOperation,
  getPendingQuestionnaireOperation,
  replyPermissionOperation,
  replyQuestionnaireOperation,
  dismissQuestionnaireOperation,
} from "./questionnaire.js";
import {
  abortSessionOperation,
  listQueueMessagesOperation,
  deleteQueueItemOperation,
  listModelsOperation,
  listSkillsOperation,
  selectModelOperation,
  getSessionUsageOperation,
  getUsageQuotaOperation,
  getAccountStatusOperation,
} from "./queue.js";
import { pluginManagementOperation } from "./plugin-management.js";
import {
  getPermissionModeOperation,
  setPermissionModeOperation,
} from "./permission-mode.js";
import {
  getGlobalInstructionsOperation,
  setGlobalInstructionsOperation,
} from "./personalization.js";
import {
  getAgentMemoryOperation,
  setAgentMemoryOperation,
} from "./agent-memory.js";
import { getUserProfileOperation, setUserProfileOperation } from "./user-profile.js";
import {
  getMemorySettingsOperation,
  setMemorySettingsOperation,
} from "./memory-settings.js";
import {
  archiveSessionOperation,
  deleteSessionOperation,
  updateSessionOperation,
  getSessionForkOptionsOperation,
  forkSessionOperation,
  listUserModelProvidersOperation,
  createUserModelProviderOperation,
  updateUserModelProviderOperation,
  deleteUserModelProviderOperation,
  testUserModelProviderOperation,
  testUserModelOperation,
  discoverUserModelsCandidateOperation,
  saveUserModelProviderCandidateOperation,
  listProviderPresetsOperation,
  getMiniMaxApiKeyStatusOperation,
  upsertMiniMaxApiKeyOperation,
  getCodexOAuthStatusOperation,
  getMiniMaxModelSourceOperation,
  setMiniMaxModelSourceOperation,
  testUserModelCandidateOperation,
  revealModelProviderApiKeyOperation,
  startCodexOAuthLoginOperation,
  cancelCodexOAuthLoginOperation,
  refreshModelsOperation,
  getSigninPanelOperation,
  claimSigninOperation,
  beginAccountLoginOperation,
  getAccountLoginStatusOperation,
  cancelAccountLoginOperation,
} from "./provider.js";

type Callable = (...args: never[]) => unknown;

type MethodKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Callable ? K : never;
}[keyof T];

/**
 * Runtime capability groups: a `Pick` view of the harness port by capability
 * domain. These are type-only views; the runtime value is the single
 * `WebuiHarnessPort` object the registry is built against.
 * `testUserModelCandidate` is deliberately widened to accept the validated
 * record — the operation's validator only checks that the frame is a record,
 * so the binding forwards the record honestly and the harness conversion stays
 * inside the runtime adapter.
 */
export interface RuntimeGroups {
  readonly version: Pick<WebuiHarnessPort, "version">;
  readonly sessions: Pick<
    WebuiHarnessPort,
    | "listVisibleProjects"
    | "listSessions"
    | "getSessionTree"
    | "archiveSession"
    | "deleteSession"
    | "updateSession"
    | "getSessionForkOptions"
    | "forkSession"
    | "createSession"
    | "getSession"
    | "getSessionDiff"
    | "getTurnDiff"
    | "revertTurnDiff"
    | "reapplyTurnDiff"
    | "getSessionRewindPreview"
    | "rewindSession"
    | "editSessionMessage"
  >;
  readonly goal: Pick<
    WebuiHarnessPort,
    "isGoalEnabled" | "getGoal" | "createGoal" | "patchGoal" | "clearGoal"
  >;
  readonly workspace: Pick<
    WebuiHarnessPort,
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
  >;
  readonly execution: Pick<
    WebuiHarnessPort,
    | "getActiveTurn"
    | "enqueueMessage"
    | "abortSession"
    | "listQueueMessages"
    | "deleteQueueItem"
  >;
  readonly interactions: Pick<
    WebuiHarnessPort,
    | "listPendingPermissions"
    | "getPendingQuestionnaire"
    | "replyPermission"
    | "replyQuestionnaire"
    | "dismissQuestionnaire"
  >;
  readonly models: Pick<WebuiHarnessPort, "listModels" | "selectModel" | "listSkills">;
  readonly plugins: Pick<WebuiHarnessPort, "pluginManagement">;
  readonly settings: Pick<
    WebuiHarnessPort,
    | "getPermissionMode"
    | "setPermissionMode"
    | "getGlobalInstructions"
    | "setGlobalInstructions"
    | "getAgentMemory"
    | "setAgentMemory"
    | "getUserProfile"
    | "setUserProfile"
    | "getMemorySettings"
    | "setMemorySettings"
  >;
  readonly account: Pick<
    WebuiHarnessPort,
    | "getSessionUsage"
    | "getUsageQuota"
    | "getSigninPanel"
    | "claimSignin"
    | "getAccountStatus"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
  >;
  readonly providers: Omit<
    Pick<
      WebuiHarnessPort,
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
    >,
    "testUserModelCandidate"
  > & {
    /** Accepts the validated record; the adapter performs the conversion. */
    readonly testUserModelCandidate: (
      request: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

type RuntimeMethod<
  G extends keyof RuntimeGroups,
  K extends MethodKeys<RuntimeGroups[G]>,
> = Extract<NonNullable<RuntimeGroups[G][K]>, Callable>;

/** The operation half of a registry entry, checked against the operation spec. */
export interface OperationDescriptor<N extends keyof OperationSpec> {
  readonly name: string;
  readonly validate: (
    raw: unknown,
  ) => WebuiOperationValidation<OperationSpec[N]["request"]>;
  readonly acknowledgesStream?: boolean;
}

/** How a binding reports a capability that is absent or not callable. */
export interface MissingPolicy {
  readonly absent: { readonly kind: "Error" | "TypeError"; readonly message: string };
  readonly nonCallable: { readonly kind: "TypeError"; readonly message: string };
}

export interface WebuiOperationBinding<
  N extends keyof OperationSpec,
  G extends keyof RuntimeGroups,
  K extends MethodKeys<RuntimeGroups[G]>,
> {
  readonly operation: OperationDescriptor<N>;
  readonly group: G;
  readonly method: K;
  readonly args: (
    body: OperationSpec[N]["request"],
    context: WebuiOperationContext,
  ) => Parameters<RuntimeMethod<G, K>>;
  readonly result: (
    value: Awaited<ReturnType<RuntimeMethod<G, K>>>,
  ) => OperationSpec[N]["response"];
  readonly missing: MissingPolicy;
}

/** The default policy for a capability that the port type requires. */
function requiredPolicy(method: PropertyKey): MissingPolicy {
  const message = `port.${String(method)} is not a function`;
  return {
    absent: { kind: "TypeError", message },
    nonCallable: { kind: "TypeError", message },
  };
}

/** The guard policy an optional capability uses when it is missing. */
function optionalPolicy(method: string, message: string): MissingPolicy {
  return {
    absent: { kind: "Error", message },
    nonCallable: { kind: "TypeError", message: `port.${method} is not a function` },
  };
}

/** Declares a binding. Fixes group, then method, then operation name. */
export function bind<G extends keyof RuntimeGroups>(group: G) {
  return <K extends MethodKeys<RuntimeGroups[G]>>(method: K) =>
    <N extends keyof OperationSpec>(operation: N) =>
      (spec: {
        readonly operation: OperationDescriptor<N>;
        readonly args: (
          body: OperationSpec[N]["request"],
          context: WebuiOperationContext,
        ) => Parameters<RuntimeMethod<G, K>>;
        readonly result: (
          value: Awaited<ReturnType<RuntimeMethod<G, K>>>,
        ) => OperationSpec[N]["response"];
        readonly missing?: MissingPolicy;
      }): WebuiOperationBinding<N, G, K> => ({
        operation: spec.operation,
        group,
        method,
        args: spec.args,
        result: spec.result,
        missing: spec.missing ?? requiredPolicy(method),
      });
}

/**
 * The executor. Turns a binding plus the port into a registry entry.
 *
 * This is the one place registry-type erasure is allowed: the binding's
 * statically-known method name indexes the port through a record view. The
 * receiver is preserved by applying the capability to the port itself, absence
 * is checked at invocation time (never at assembly), the declared missing
 * policy reproduces the exact error class and message the previous forwarders
 * used, and an exception thrown by the capability is left unchanged.
 */
export function executeBinding<
  N extends keyof OperationSpec,
  G extends keyof RuntimeGroups,
  K extends MethodKeys<RuntimeGroups[G]>,
>(
  binding: WebuiOperationBinding<N, G, K>,
  port: WebuiHarnessPort,
): WebuiOperationRegistryEntry {
  const capabilities = port as unknown as Readonly<Record<string, unknown>>;
  const method = binding.method as string;
  return {
    operation: binding.operation,
    handle: async (context, body) => {
      const args = binding.args(body as never, context);
      const capability = capabilities[method];
      if (typeof capability !== "function") {
        const policy =
          capability === undefined ? binding.missing.absent : binding.missing.nonCallable;
        throw policy.kind === "Error"
          ? new Error(policy.message)
          : new TypeError(policy.message);
      }
      const invoke = capability as (...callArgs: readonly unknown[]) => unknown;
      const value = await invoke.apply(port, args);
      return { body: binding.result(value as never) };
    },
  };
}

// ---------------------------------------------------------------------------
// Binding declarations — 86 operations (the other 13 keep dedicated handlers)
// ---------------------------------------------------------------------------

const identity = <T>(value: T): T => value;

export const WEBUI_OPERATION_BINDINGS = {
  // version
  version: bind("version")("version")("version")({
    operation: versionOperation,
    args: () => [],
    result: identity,
  }),

  // sessions
  listSessions: bind("sessions")("listSessions")("listSessions")({
    operation: listSessionsOperation,
    args: (body) => [body],
    result: identity,
  }),
  listVisibleProjects: bind("sessions")("listVisibleProjects")("listVisibleProjects")({
    operation: listVisibleProjectsOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "listVisibleProjects",
      "runtime host does not expose project listing",
    ),
  }),
  getSessionTree: bind("sessions")("getSessionTree")("getSessionTree")({
    operation: getSessionTreeOperation,
    args: (body) => [body],
    result: identity,
  }),
  createSession: bind("sessions")("createSession")("createSession")({
    operation: createSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  getSession: bind("sessions")("getSession")("getSession")({
    operation: getSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  getActiveTurn: bind("execution")("getActiveTurn")("getActiveTurn")({
    operation: getActiveTurnOperation,
    args: (body) => [body],
    result: identity,
  }),
  getSessionDiff: bind("sessions")("getSessionDiff")("getSessionDiff")({
    operation: getSessionDiffOperation,
    args: (body) => [body],
    result: identity,
  }),
  getTurnDiff: bind("sessions")("getTurnDiff")("getTurnDiff")({
    operation: getTurnDiffOperation,
    args: (body) => [body],
    result: identity,
  }),
  revertTurnDiff: bind("sessions")("revertTurnDiff")("revertTurnDiff")({
    operation: revertTurnDiffOperation,
    args: (body) => [body],
    result: identity,
  }),
  reapplyTurnDiff: bind("sessions")("reapplyTurnDiff")("reapplyTurnDiff")({
    operation: reapplyTurnDiffOperation,
    args: (body) => [body],
    result: identity,
  }),
  getSessionRewindPreview: bind("sessions")("getSessionRewindPreview")(
    "getSessionRewindPreview",
  )({
    operation: getSessionRewindPreviewOperation,
    args: (body) => [body],
    result: identity,
  }),
  rewindSession: bind("sessions")("rewindSession")("rewindSession")({
    operation: rewindSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  editSessionMessage: bind("sessions")("editSessionMessage")("editSessionMessage")({
    operation: editSessionMessageOperation,
    args: (body) => [body],
    result: identity,
  }),
  archiveSession: bind("sessions")("archiveSession")("archiveSession")({
    operation: archiveSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  deleteSession: bind("sessions")("deleteSession")("deleteSession")({
    operation: deleteSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  updateSession: bind("sessions")("updateSession")("updateSession")({
    operation: updateSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  getSessionForkOptions: bind("sessions")("getSessionForkOptions")(
    "getSessionForkOptions",
  )({
    operation: getSessionForkOptionsOperation,
    args: (body) => [body],
    result: identity,
  }),
  forkSession: bind("sessions")("forkSession")("forkSession")({
    operation: forkSessionOperation,
    args: (body) => [body],
    result: identity,
  }),

  // goal
  isGoalEnabled: bind("goal")("isGoalEnabled")("isGoalEnabled")({
    operation: isGoalEnabledOperation,
    args: () => [],
    result: identity,
  }),
  getGoal: bind("goal")("getGoal")("getGoal")({
    operation: getGoalOperation,
    args: (body) => [body],
    result: identity,
  }),
  createGoal: bind("goal")("createGoal")("createGoal")({
    operation: createGoalOperation,
    args: (body) => [body],
    result: identity,
  }),
  patchGoal: bind("goal")("patchGoal")("patchGoal")({
    operation: patchGoalOperation,
    args: (body) => [body],
    result: identity,
  }),
  clearGoal: bind("goal")("clearGoal")("clearGoal")({
    operation: clearGoalOperation,
    args: (body) => [body],
    result: identity,
  }),

  // workspace
  listWorkspaceFileTree: bind("workspace")("listWorkspaceFileTree")(
    "listWorkspaceFileTree",
  )({
    operation: listWorkspaceFileTreeOperation,
    args: (body) => [body],
    result: identity,
  }),
  readWorkspaceFile: bind("workspace")("readWorkspaceFile")("readWorkspaceFile")({
    operation: readWorkspaceFileOperation,
    args: (body) => [body],
    result: identity,
  }),
  getWorkspaceEnvironment: bind("workspace")("getWorkspaceEnvironment")(
    "getWorkspaceEnvironment",
  )({
    operation: getWorkspaceEnvironmentOperation,
    args: (body) => [body],
    result: identity,
  }),
  mutateWorkspaceGit: bind("workspace")("mutateWorkspaceGit")("mutateWorkspaceGit")({
    operation: mutateWorkspaceGitOperation,
    args: (body) => [body],
    result: identity,
  }),
  getWorkspaceReviewSummary: bind("workspace")("getWorkspaceReviewSummary")(
    "getWorkspaceReviewSummary",
  )({
    operation: getWorkspaceReviewSummaryOperation,
    args: (body) => [body],
    result: identity,
  }),
  listWorkspaceReviewFileDiffs: bind("workspace")("listWorkspaceReviewFileDiffs")(
    "listWorkspaceReviewFileDiffs",
  )({
    operation: listWorkspaceReviewFileDiffsOperation,
    args: (body) => [body],
    result: identity,
  }),
  getWorkspaceReviewFileContent: bind("workspace")("getWorkspaceReviewFileContent")(
    "getWorkspaceReviewFileContent",
  )({
    operation: getWorkspaceReviewFileContentOperation,
    args: (body) => [body],
    result: identity,
  }),
  searchWorkspaceReviewDiffs: bind("workspace")("searchWorkspaceReviewDiffs")(
    "searchWorkspaceReviewDiffs",
  )({
    operation: searchWorkspaceReviewDiffsOperation,
    args: (body) => [body],
    result: identity,
  }),
  readCanvas: bind("workspace")("readCanvas")("readCanvas")({
    operation: readCanvasOperation,
    args: (body) => [body],
    result: identity,
  }),
  applyCanvas: bind("workspace")("applyCanvas")("applyCanvas")({
    operation: applyCanvasOperation,
    args: (body) => [body],
    result: identity,
  }),
  readWorkspaceArchive: bind("workspace")("readWorkspaceArchive")(
    "readWorkspaceArchive",
  )({
    operation: readWorkspaceArchiveOperation,
    args: (body) => [body],
    result: identity,
  }),
  extractWorkspaceArchive: bind("workspace")("extractWorkspaceArchive")(
    "extractWorkspaceArchive",
  )({
    operation: extractWorkspaceArchiveOperation,
    args: (body) => [body],
    result: identity,
  }),

  // execution (non-stream)
  enqueueMessage: bind("execution")("enqueueMessage")("enqueueMessage")({
    operation: enqueueMessageOperation,
    args: (body) => [body],
    result: identity,
  }),
  abortSession: bind("execution")("abortSession")("abortSession")({
    operation: abortSessionOperation,
    args: (body) => [body],
    result: identity,
  }),
  listQueueMessages: bind("execution")("listQueueMessages")("listQueueMessages")({
    operation: listQueueMessagesOperation,
    args: (body) => [body],
    result: identity,
  }),
  deleteQueueItem: bind("execution")("deleteQueueItem")("deleteQueueItem")({
    operation: deleteQueueItemOperation,
    args: (body) => [body],
    result: identity,
  }),

  // interactions
  listPendingPermissions: bind("interactions")("listPendingPermissions")(
    "listPendingPermissions",
  )({
    operation: listPendingPermissionsOperation,
    args: () => [],
    result: identity,
  }),
  getPendingQuestionnaire: bind("interactions")("getPendingQuestionnaire")(
    "getPendingQuestionnaire",
  )({
    operation: getPendingQuestionnaireOperation,
    args: (body) => [body],
    result: identity,
  }),
  replyPermission: bind("interactions")("replyPermission")("replyPermission")({
    operation: replyPermissionOperation,
    args: (body) => [body],
    result: identity,
  }),
  replyQuestionnaire: bind("interactions")("replyQuestionnaire")(
    "replyQuestionnaire",
  )({
    operation: replyQuestionnaireOperation,
    args: (body) => [body],
    result: identity,
  }),
  dismissQuestionnaire: bind("interactions")("dismissQuestionnaire")(
    "dismissQuestionnaire",
  )({
    operation: dismissQuestionnaireOperation,
    args: (body) => [body],
    result: identity,
  }),

  // models
  listModels: bind("models")("listModels")("listModels")({
    operation: listModelsOperation,
    args: (body) => [body],
    result: identity,
  }),
  selectModel: bind("models")("selectModel")("selectModel")({
    operation: selectModelOperation,
    args: (body) => [body],
    result: identity,
  }),
  listSkills: bind("models")("listSkills")("listSkills")({
    operation: listSkillsOperation,
    args: (body) => [body],
    result: identity,
  }),

  // plugins
  pluginManagement: bind("plugins")("pluginManagement")("pluginManagement")({
    operation: pluginManagementOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "pluginManagement",
      "runtime host does not expose plugin management",
    ),
  }),

  // settings
  getPermissionMode: bind("settings")("getPermissionMode")("getPermissionMode")({
    operation: getPermissionModeOperation,
    args: () => [],
    result: identity,
    missing: optionalPolicy(
      "getPermissionMode",
      "runtime host does not expose permission mode reads",
    ),
  }),
  setPermissionMode: bind("settings")("setPermissionMode")("setPermissionMode")({
    operation: setPermissionModeOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "setPermissionMode",
      "runtime host does not expose permission mode updates",
    ),
  }),
  getGlobalInstructions: bind("settings")("getGlobalInstructions")(
    "getGlobalInstructions",
  )({
    operation: getGlobalInstructionsOperation,
    args: () => [],
    result: identity,
    missing: optionalPolicy(
      "getGlobalInstructions",
      "runtime host does not expose global instructions reads",
    ),
  }),
  setGlobalInstructions: bind("settings")("setGlobalInstructions")(
    "setGlobalInstructions",
  )({
    operation: setGlobalInstructionsOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "setGlobalInstructions",
      "runtime host does not expose global instructions updates",
    ),
  }),
  getAgentMemory: bind("settings")("getAgentMemory")("getAgentMemory")({
    operation: getAgentMemoryOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "getAgentMemory",
      "runtime host does not expose agent memory reads",
    ),
  }),
  setAgentMemory: bind("settings")("setAgentMemory")("setAgentMemory")({
    operation: setAgentMemoryOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "setAgentMemory",
      "runtime host does not expose agent memory updates",
    ),
  }),
  getUserProfile: bind("settings")("getUserProfile")("getUserProfile")({
    operation: getUserProfileOperation,
    args: () => [],
    result: identity,
    missing: optionalPolicy(
      "getUserProfile",
      "runtime host does not expose user profile reads",
    ),
  }),
  setUserProfile: bind("settings")("setUserProfile")("setUserProfile")({
    operation: setUserProfileOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "setUserProfile",
      "runtime host does not expose user profile updates",
    ),
  }),
  getMemorySettings: bind("settings")("getMemorySettings")("getMemorySettings")({
    operation: getMemorySettingsOperation,
    args: () => [],
    result: identity,
    missing: optionalPolicy(
      "getMemorySettings",
      "runtime host does not expose memory settings",
    ),
  }),
  setMemorySettings: bind("settings")("setMemorySettings")("setMemorySettings")({
    operation: setMemorySettingsOperation,
    args: (body) => [body],
    result: identity,
    missing: optionalPolicy(
      "setMemorySettings",
      "runtime host does not expose memory settings updates",
    ),
  }),

  // account
  getSessionUsage: bind("account")("getSessionUsage")("getSessionUsage")({
    operation: getSessionUsageOperation,
    args: (body) => [body],
    result: identity,
  }),
  getUsageQuota: bind("account")("getUsageQuota")("getUsageQuota")({
    operation: getUsageQuotaOperation,
    args: (body) => [body],
    result: identity,
  }),
  getSigninPanel: bind("account")("getSigninPanel")("getSigninPanel")({
    operation: getSigninPanelOperation,
    args: () => [],
    result: identity,
  }),
  claimSignin: bind("account")("claimSignin")("claimSignin")({
    operation: claimSigninOperation,
    args: () => [],
    result: identity,
  }),
  getAccountStatus: bind("account")("getAccountStatus")("getAccountStatus")({
    operation: getAccountStatusOperation,
    args: (body) => [body],
    result: identity,
  }),
  beginAccountLogin: bind("account")("beginAccountLogin")("beginAccountLogin")({
    operation: beginAccountLoginOperation,
    args: () => [],
    result: identity,
  }),
  getAccountLoginStatus: bind("account")("getAccountLoginStatus")(
    "getAccountLoginStatus",
  )({
    operation: getAccountLoginStatusOperation,
    args: () => [],
    result: identity,
  }),
  cancelAccountLogin: bind("account")("cancelAccountLogin")("cancelAccountLogin")({
    operation: cancelAccountLoginOperation,
    args: () => [],
    result: identity,
  }),

  // providers
  listUserModelProviders: bind("providers")("listUserModelProviders")(
    "listUserModelProviders",
  )({
    operation: listUserModelProvidersOperation,
    args: () => [],
    result: identity,
  }),
  createUserModelProvider: bind("providers")("createUserModelProvider")(
    "createUserModelProvider",
  )({
    operation: createUserModelProviderOperation,
    args: (body) => [body],
    result: identity,
  }),
  updateUserModelProvider: bind("providers")("updateUserModelProvider")(
    "updateUserModelProvider",
  )({
    operation: updateUserModelProviderOperation,
    args: (body) => [body],
    result: identity,
  }),
  deleteUserModelProvider: bind("providers")("deleteUserModelProvider")(
    "deleteUserModelProvider",
  )({
    operation: deleteUserModelProviderOperation,
    args: (body) => [body.providerId],
    result: identity,
  }),
  testUserModelProvider: bind("providers")("testUserModelProvider")(
    "testUserModelProvider",
  )({
    operation: testUserModelProviderOperation,
    args: (body) => [body],
    result: identity,
  }),
  testUserModel: bind("providers")("testUserModel")("testUserModel")({
    operation: testUserModelOperation,
    args: (body) => [body],
    result: identity,
  }),
  discoverUserModelsCandidate: bind("providers")("discoverUserModelsCandidate")(
    "discoverUserModelsCandidate",
  )({
    operation: discoverUserModelsCandidateOperation,
    args: (body) => [body],
    result: identity,
  }),
  saveUserModelProviderCandidate: bind("providers")("saveUserModelProviderCandidate")(
    "saveUserModelProviderCandidate",
  )({
    operation: saveUserModelProviderCandidateOperation,
    args: (body) => [body],
    result: identity,
  }),
  listProviderPresets: bind("providers")("listProviderPresets")("listProviderPresets")({
    operation: listProviderPresetsOperation,
    args: () => [],
    result: identity,
  }),
  getMiniMaxApiKeyStatus: bind("providers")("getMiniMaxApiKeyStatus")(
    "getMiniMaxApiKeyStatus",
  )({
    operation: getMiniMaxApiKeyStatusOperation,
    args: () => [],
    result: identity,
  }),
  upsertMiniMaxApiKey: bind("providers")("upsertMiniMaxApiKey")("upsertMiniMaxApiKey")({
    operation: upsertMiniMaxApiKeyOperation,
    args: (body) => [body],
    result: identity,
  }),
  getCodexOAuthStatus: bind("providers")("getCodexOAuthStatus")("getCodexOAuthStatus")({
    operation: getCodexOAuthStatusOperation,
    args: () => [],
    result: identity,
  }),
  getMiniMaxModelSource: bind("providers")("getMiniMaxModelSource")(
    "getMiniMaxModelSource",
  )({
    operation: getMiniMaxModelSourceOperation,
    args: () => [],
    result: identity,
  }),
  setMiniMaxModelSource: bind("providers")("setMiniMaxModelSource")(
    "setMiniMaxModelSource",
  )({
    operation: setMiniMaxModelSourceOperation,
    args: (body) => [body],
    result: identity,
  }),
  testUserModelCandidate: bind("providers")("testUserModelCandidate")(
    "testUserModelCandidate",
  )({
    operation: testUserModelCandidateOperation,
    args: (body) => [body],
    result: identity,
  }),
  revealModelProviderApiKey: bind("providers")("revealModelProviderApiKey")(
    "revealModelProviderApiKey",
  )({
    operation: revealModelProviderApiKeyOperation,
    args: (body) => [body],
    result: identity,
  }),
  startCodexOAuthLogin: bind("providers")("startCodexOAuthLogin")(
    "startCodexOAuthLogin",
  )({
    operation: startCodexOAuthLoginOperation,
    args: (body) => [body],
    result: identity,
  }),
  cancelCodexOAuthLogin: bind("providers")("cancelCodexOAuthLogin")(
    "cancelCodexOAuthLogin",
  )({
    operation: cancelCodexOAuthLoginOperation,
    args: (body) => [body],
    result: identity,
  }),
  refreshModels: bind("providers")("refreshModels")("refreshModels")({
    operation: refreshModelsOperation,
    args: () => [],
    result: identity,
  }),
} as const;

/** The operation names that keep dedicated handlers (not bindings). */
export const DEDICATED_OPERATION_NAMES = [
  "browseWorkspaceDirs",
  "createTerminal",
  "listTerminals",
  "writeTerminal",
  "resizeTerminal",
  "disposeTerminal",
  "watchTerminal",
  "runCommand",
  "signOut",
  "watchEvents",
  "getMessages",
  "sendMessage",
  "resumeSession",
] as const;

type AnyBinding = WebuiOperationBinding<
  keyof OperationSpec,
  keyof RuntimeGroups,
  MethodKeys<RuntimeGroups[keyof RuntimeGroups]>
>;

/**
 * Materialises every binding declaration against one port, keyed by operation
 * name. Used by the registry (once it is rewired) and by the wire-compatibility
 * test; kept separate from the executor so the erasure stays in one place.
 */
export function createBindingEntries(
  port: WebuiHarnessPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const entries = new Map<string, WebuiOperationRegistryEntry>();
  for (const [name, binding] of Object.entries(WEBUI_OPERATION_BINDINGS)) {
    entries.set(name, executeBinding(binding as unknown as AnyBinding, port));
  }
  return entries;
}
