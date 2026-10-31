// Goal capability port.
//
// The goal entity: its enablement probe, its read, and create / patch / clear. With
// the entity projection, the status and version, and the version fence in this
// business, the operations that move it are this business's too — not the
// interaction coordinator's, whose third duty they used to be.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type { WebuiGoal, WebuiGoalCreateRequest, WebuiGoalEnabledResult, WebuiGoalPatchRequest, WebuiGoalSessionRequest } from "../../../../shared/contracts/goal.js";

/** The goal operations exposed to presentation through the application owner. */
export interface WebuiGoalCommands {
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  readonly clearGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<{ readonly success: boolean }>;
}

export interface GoalPort {
  readonly isGoalEnabled?: () => Promise<WebuiGoalEnabledResult>;
  readonly getGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<WebuiGoal | undefined>;
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  readonly clearGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<{ readonly success: boolean }>;
}
