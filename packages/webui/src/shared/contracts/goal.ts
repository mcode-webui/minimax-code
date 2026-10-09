// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiGoalStatus` | Goal lifecycle state (active/paused/blocked/complete/budget_limited/usage_limited). | Runtime goal records `getGoal`/`createGoal`/`patchGoal` (`runtime/harness/execution.ts`; CliService). | `client/projection/goal-state.ts`; `client/components/GoalBanner.tsx`. |
// | `WebuiGoalWaitReason` | Why an active goal is waiting (questionnaire/permission/plan/...). | Runtime goal `executionWait` (`runtime/harness/execution.ts` `getGoal`). | unverified — nested in `WebuiGoal.executionWait`; no direct importer. |
// | `WebuiGoal` | The session's durable goal record. | Runtime `getGoal`/`createGoal`/`patchGoal`. | `client/contracts/interaction-port.ts`; `client/projection/goal-state.ts`; `client/projection/effect-reducer.ts`; `client/components/GoalBanner.tsx`; `client/components/SessionComposer.tsx`. |
// | `WebuiGoalSessionRequest` | Request naming the session whose goal is read. | Browser `client/transport.ts` (`getGoal`). | `client/contracts/interaction-port.ts`; `client/components/SessionComposer.tsx`; runtime `getGoal`. |
// | `WebuiGoalCreateRequest` | Request to create a goal (sessionId, objective, budget). | Browser `client/transport.ts` (`createGoal`), built in `client/projection/composer-state.ts`. | `client/contracts/interaction-port.ts`; runtime `createGoal`; `server/operation/goal.ts`. |
// | `WebuiGoalPatchRequest` | Request to patch a goal's status/objective/budget. | Browser `client/transport.ts` (`patchGoal`), built in `composer-state.ts`/`goal-state.ts`. | `client/contracts/interaction-port.ts`; runtime `patchGoal`; `server/operation/goal.ts`. |
// | `WebuiGoalEnabledResult` | Whether the goal capability is enabled. | Runtime `isGoalEnabled` (`runtime/harness/execution.ts`, wraps the CliService boolean as `{ enabled }`). | `client/contracts/interaction-port.ts`; `client/transport.ts`; `client/components/SessionComposer.tsx`. |
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
