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
