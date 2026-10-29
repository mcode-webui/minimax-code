// The binding mechanism: the port view, the capability groups, the declaration
// helper and the executor.
//
// Split out of `bind-handlers.ts` because the two halves change for
// different reasons and are verified differently: this half is generic — it
// holds no operation name and no runtime method name of its own — while the
// roster next door is a 93-row table of concrete declarations that changes with
// the wire surface. A reviewer reading a table row should not have to hold the
// executor's erasure in mind, and a change to the executor should not touch a
// file whose diff is otherwise a list of operations.
//
// `bind-handlers.ts` re-exports everything here, so the registry, the dedicated
// handlers and the tests keep their import path.
import type { WebuiHarnessPort } from "../../runtime/port.js";
import type { OperationSpec } from "../../shared/operation-names.js";
import {
  WebuiCapabilityUnavailableError,
  WebuiErrorCode,
} from "../../shared/envelope.js";
import type {
  WebuiOperationContext,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "./operation-contract.js";

type Callable = (...args: never[]) => unknown;

/**
 * The runtime port the operation registry binds against: the harness seam's
 * capability methods plus the assembly-supplied ones (usage, check-in, auth
 * invalidation, compaction). This is the same `Pick` view the old forwarding
 * handler map derived from `WebuiHarnessPort`; it lives here now because the
 * registry, the typed bindings and the dedicated handlers all materialise
 * against it.
 */
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
  | "listCronTasks"
  | "createCronTask"
  | "updateCronTask"
  | "deleteCronTask"
  | "runCronTaskNow"
  | "listCronTaskRuns"
  | "pluginManagement"
  | "getPermissionMode"
  | "setPermissionMode"
  | "getSessionUsage"
  | "getUsageQuota"
  | "getCreditFallback"
  | "setCreditFallback"
  | "listResetCards"
  | "useResetCard"
  | "queryResetCardFlows"
  | "getAccountUsageSummary"
  | "getAccountProfile"
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
  | "getGlobalInstructions"
  | "setGlobalInstructions"
  | "getAgentMemory"
  | "setAgentMemory"
  | "getUserProfile"
  | "setUserProfile"
  | "getMemorySettings"
  | "setMemorySettings"
  | "listMiniApps"
  | "openMiniApp"
  | "stopMiniApp"
  | "runMiniAppAgentTurn"
  | "answerMiniAppAgentQuestion"
  | "replyMiniAppAgentPermission"
  | "openMiniAppAgentSession"
  | "panelOpenedMiniAppAgentSession"
  | "panelClosedMiniAppAgentSession"
  | "listMiniAppAgentModels"
  | "listMiniAppAgentAgents"
  | "listMiniAppAgentSessions"
  | "readMiniAppAgentSession"
  | "createMiniAppAgentSession"
  | "runCommand"
>;

export type MethodKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Callable ? K : never;
}[keyof T];

/**
 * Runtime capability groups: a `Pick` view of the harness port by capability
 * domain. These are type-only views; the runtime value is the single
 * `WebuiHarnessPort` object the registry is built against.
 * `testUserModelCandidate` remains a record at this seam because its validator
 * only establishes that the wire body is a record. The runtime adapter owns
 * conversion to the narrower harness method input.
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
  /**
   * Scheduled tasks (ADR 0027). One group for the six members the panel needs, so the tickets that
   * add the mutations extend a group that already exists rather than inventing a second seam.
   */
  readonly scheduling: Pick<
    WebuiHarnessPort,
    | "listCronTasks"
    | "createCronTask"
    | "updateCronTask"
    | "deleteCronTask"
    | "runCronTaskNow"
    | "listCronTaskRuns"
  >;
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
    | "getCreditFallback"
    | "setCreditFallback"
    | "listResetCards"
    | "useResetCard"
    | "queryResetCardFlows"
    | "getAccountUsageSummary"
    | "getAccountProfile"
    | "getSigninPanel"
    | "claimSignin"
    | "getAccountStatus"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
  >;
  readonly providers: Pick<
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
    >;
}

export type RuntimeMethod<
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
  K extends MethodKeys<RuntimeGroups[G]> & keyof WebuiOperationPort,
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

/**
 * The default policy for a capability that the port type requires.
 *
 * Both branches name the same stable code, so the refusal survives the trip to
 * the browser as "this host cannot answer this operation" rather than as an
 * unlabelled `Error` whose only distinguishing feature was its English text. A
 * client that cannot tell an absent capability from a failing one has one option
 * — show an error and retry — which is wrong in both directions: it nags about a
 * feature that will never appear, and it hides the retry for one that would have
 * worked.
 */
function requiredPolicy(method: PropertyKey): MissingPolicy {
  const message = `port.${String(method)} is not a function`;
  return {
    absent: { kind: "TypeError", message },
    nonCallable: { kind: "TypeError", message },
  };
}

/** The guard policy an optional capability uses when it is missing. */
export function optionalPolicy(method: string, message: string): MissingPolicy {
  return {
    absent: { kind: "Error", message },
    nonCallable: { kind: "TypeError", message: `port.${method} is not a function` },
  };
}

/** Declares a binding. Fixes group, then method, then operation name. */
export function bind<G extends keyof RuntimeGroups>(group: G) {
  return <K extends MethodKeys<RuntimeGroups[G]> & keyof WebuiOperationPort>(method: K) =>
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
  K extends MethodKeys<RuntimeGroups[G]> & keyof WebuiOperationPort,
>(
  binding: WebuiOperationBinding<N, G, K>,
  port: WebuiOperationPort,
): WebuiOperationRegistryEntry {
  const method = binding.method;
  return {
    operation: binding.operation,
    handle: async (context, body) => {
      const args = binding.args(body as never, context);
      const capability = port[method];
      if (typeof capability !== "function") {
        const policy =
          capability === undefined ? binding.missing.absent : binding.missing.nonCallable;
        // The code is what tells a client this host cannot answer at all, as
        // opposed to one that answered and failed. The error class still
        // reproduces exactly what the policy declared, because some callers
        // distinguish a missing capability by `TypeError` today.
        throw policy.kind === "Error"
          ? new WebuiCapabilityUnavailableError(policy.message)
          : Object.assign(new TypeError(policy.message), {
              code: WebuiErrorCode.capabilityUnavailable,
            });
      }
      // The binding carries the method key and its parameter tuple together;
      // restore that exact indexed signature after the runtime presence check.
      const callable = capability as RuntimeMethod<G, K>;
      const value = await callable.apply(port, args);
      return { body: binding.result(value as never) };
    },
  };
}
