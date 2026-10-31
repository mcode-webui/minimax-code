// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiGoalStatus` | Goal lifecycle state (active/paused/blocked/complete/budget_limited/usage_limited). | Runtime goal records `getGoal`/`createGoal`/`patchGoal` (`runtime/harness/execution.ts`; CliService). | `client/features/goal/projection/goal-state.ts`; `client/features/goal/ui/GoalBanner.public.tsx`. |
// | `WebuiGoalWaitReason` | Why an active goal is waiting (questionnaire/permission/plan/...). | Runtime goal `executionWait` (`runtime/harness/execution.ts` `getGoal`). | unverified — nested in `WebuiGoal.executionWait`; no direct importer. |
// | `WebuiGoal` | The session's durable goal record. | Runtime `getGoal`/`createGoal`/`patchGoal`. | `client/features/goal/contracts/goal-port.ts`; `client/features/goal/projection/goal-state.ts`; `client/features/turn/application/effect-reducer.ts`; `client/features/goal/ui/GoalBanner.public.tsx`; `client/features/composer/ui/WebuiComposer.tsx`. |
// | `WebuiGoalSessionRequest` | Request naming the session whose goal is read. | Browser `client/platform/transport.ts` (`getGoal`). | `client/features/goal/contracts/goal-port.ts`; `client/features/composer/ui/WebuiComposer.tsx`; runtime `getGoal`. |
// | `WebuiGoalCreateRequest` | Request to create a goal (sessionId, objective, budget). | Browser `client/platform/transport.ts` (`createGoal`); the request is assembled in `client/features/composer/ui/WebuiComposer.tsx` and submitted through `client/features/goal/application/goal-submission.ts`. | `client/features/goal/contracts/goal-port.ts`; runtime `createGoal`; `server/operation/goal.ts`. |
// | `WebuiGoalPatchRequest` | Request to patch a goal's status/objective/budget. | Browser `client/platform/transport.ts` (`patchGoal`); assembled in `client/features/composer/ui/WebuiComposer.tsx`, with the status field derived in `client/features/goal/projection/goal-state.ts`. | `client/features/goal/contracts/goal-port.ts`; runtime `patchGoal`; `server/operation/goal.ts`. |
// | `WebuiGoalEnabledResult` | Whether the goal capability is enabled. | Runtime `isGoalEnabled` (`runtime/harness/execution.ts`, wraps the CliService boolean as `{ enabled }`). | `client/features/goal/contracts/goal-port.ts`; `client/platform/transport.ts`; `client/features/composer/ui/WebuiComposer.tsx`. |
export type WebuiGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete"
  | "budget_limited"
  | "usage_limited";

export type WebuiGoalWaitReason =
  | "questionnaire"
  | "permission"
  | "plan"
  | "required_background"
  | "automation_owner_conflict"
  | "dependency_unavailable"
  | "verification"
  | "unknown";
export interface WebuiGoal {
  readonly goalId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: WebuiGoalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tokensUsed: number;
  readonly turnsUsed: number;
  readonly timeUsedSeconds: number;
  readonly tokenBudget: number | null;
  readonly statusReason: string | null;
  readonly hasKickoffAttachments?: boolean;
  readonly executionWait?: {
    readonly reason: WebuiGoalWaitReason;
    readonly sinceMs: number;
  } | null;
}

export interface WebuiGoalSessionRequest {
  readonly sessionId: string;
}

export interface WebuiGoalCreateRequest {
  readonly sessionId: string;
  readonly objective: string;
  readonly tokenBudget?: number | null;
}

export interface WebuiGoalPatchRequest {
  readonly sessionId: string;
  readonly status?: WebuiGoalStatus;
  readonly objective?: string;
  readonly tokenBudget?: number | null;
}

export interface WebuiGoalEnabledResult {
  readonly enabled: boolean;
}
