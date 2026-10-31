// The goal submission.
//
// It owns the create-or-patch decision, and that decision is Goal's: whether a
// session's goal is created or patched follows from the goal the *target* session
// currently holds and whether its owner can patch one. The assembly used to make
// that call inline — `usesPatch`, a re-resolve after creation, and the
// apply-after-create — while assembling the composer's controller.
//
// What the module cannot hold itself arrives as capabilities: the target
// session's goal owner, the task/session creation use case (which is where a
// home submission's session comes from), and the commit that lands a created
// goal on its owner. It reads no store, knows no home key, and performs no IO
// of its own.

import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../../../shared/contracts/goal.js";
import type { WebuiTaskSessionSubmitter } from "../../turn/contracts/submission.js";
import { readWorkspaceDirField } from "../../../projection/common/paths.js";

/** What one target session currently offers for its goal. */
export interface WebuiGoalOwnerCapability {
  /** The goal the session holds today, if any. A goal that can be patched is patched. */
  readonly currentGoal?: WebuiGoal;
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
}

export interface WebuiGoalSubmitArgs {
  /** The session the objective belongs to. Absent means "create the session too". */
  readonly sessionId?: string;
  readonly objective: string;
  /** The goal capability the target session currently offers. */
  readonly capabilityFor: (sessionId: string) => WebuiGoalOwnerCapability;
  /**
   * The task use case the goal path creates through. Same contract as the send
   * path's: it reserves the admission, transfers the home record under its guards
   * and answers whether the created session may be selected.
   */
  readonly submitTask?: WebuiTaskSessionSubmitter;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
  /**
   * Commit a goal this submission *created* onto its session owner. A patch went
   * through the owner already, so it does not need this.
   */
  readonly applyGoal?: (sessionId: string, goal: WebuiGoal) => void;
}

export interface WebuiGoalSubmissionResult {
  readonly goal: WebuiGoal;
  readonly sessionId: string;
}

export async function submitWebuiGoal(
  args: WebuiGoalSubmitArgs,
  onSessionCreated?: (sessionId: string, selected: boolean) => void,
): Promise<WebuiGoalSubmissionResult> {
  const objective = args.objective.trim();
  if (!objective) throw new Error("目标内容不能为空");
  let sessionId = args.sessionId;
  if (!sessionId) {
    const submitTask = args.submitTask;
    if (!submitTask) throw new Error("无法创建目标会话");
    const workspaceDir = readWorkspaceDirField(args.createSessionWorkspaceDir);
    const outcome = await submitTask.submit({
      name: "main",
      ...(workspaceDir === undefined ? {} : { workspaceDir }),
      ...(args.teamModeOff === undefined ? {} : { teamModeOff: args.teamModeOff }),
    });
    // A goal submission refuses rather than creating a second session, and a
    // creation already in flight is the one refusal that is not a failure.
    if (outcome.kind !== "created") {
      if (outcome.kind === "creation-failed") throw new Error(outcome.error);
      throw new Error(
        outcome.kind === "busy" ? "会话正在创建中，请稍后再试。" : "无法创建目标会话",
      );
    }
    sessionId = outcome.sessionId;
    onSessionCreated?.(sessionId, outcome.selected);
  }
  // The decision reads the target's capability *after* any creation, so a session
  // this submission just made (which holds no goal) takes the create branch, while
  // a session that already has a patchable goal takes the patch branch.
  const capability = args.capabilityFor(sessionId);
  if (capability.currentGoal && capability.patchGoal) {
    return { goal: await capability.patchGoal({ sessionId, objective }), sessionId };
  }
  const createGoal =
    capability.createGoal ??
    (async () => {
      throw new Error("当前运行时不支持创建目标");
    });
  const goal = await createGoal({ sessionId, objective });
  args.applyGoal?.(sessionId, goal);
  return { goal, sessionId };
}
