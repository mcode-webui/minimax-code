// The synthetic transcript message a goal event produces.
//
// The conversation substrate's effect reducer is its only reader, and it may not
// import another business's private projection; the goal banner keeps the
// projection it actually renders (status copy, patch builders, duration).
//
// Why not `features/goal/contracts/`, which is where a business publishes what
// other businesses read: this function asks the kind registry which event types
// carry an objective (`./event-kinds.ts`, layer `view`), and a contracts module
// may import `shared` only. Its output shape is the substrate's own
// `WebuiStreamMessage`, which is a `view`-layer type for the same reason. The
// goal+interaction registry already lives in this directory for that same
// constraint, so the mapping between the two sits beside it.
//
// The body is the declaration as it stood, unchanged.

import type { WebuiGoal } from "../../../shared/contracts/goal.js";
import type { WebuiStreamMessage } from "../../features/turn/projection/stream-state.js";
import { WEBUI_GOAL_OBJECTIVE_EVENT_TYPES } from "./event-kinds.js";

/**
 * Build a synthetic transcript message for one of the
 * `thread_goal.{objective_updated,objective_steering,updated}` events. The
 * effect reducer upserts the result by id (`thread-goal-${goal.goalId}`) so
 * subsequent updates replace the bubble in place rather than appending.
 */
export function projectWebuiThreadGoalMessage(
  eventType: string,
  goal: WebuiGoal,
): WebuiStreamMessage | undefined {
  // The kinds that carry an objective come from the registry; the three literals
  // that used to live here were a second place to teach a verb.
  if (!WEBUI_GOAL_OBJECTIVE_EVENT_TYPES.includes(eventType)) return undefined;
  return {
    id: `thread-goal-${goal.goalId}`,
    answer: goal.objective,
    thinking: "",
    role: "user",
    timestamp: goal.updatedAt,
    isGoal: true,
  };
}
