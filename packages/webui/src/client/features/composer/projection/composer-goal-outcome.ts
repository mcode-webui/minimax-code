/**
 * Whether the composer keeps goal mode on after a goal submission.
 *
 * The rule was one ternary inside the component's submit path:
 * `setGoalMode(nextGoal.status !== "complete")`. It reads as an accident of the
 * expression until you notice what it means — a goal the server finished with is
 * over, so the composer leaves goal mode; a goal that is active, blocked, paused
 * or usage-limited is still the session's standing goal, so goal mode stays on
 * and the next draft belongs to that goal. Only `complete` ends it.
 *
 * Extracting it makes the rule nameable and testable, and keeps the component
 * reading as orchestration: submit, apply the answer, and let the answer decide
 * the mode.
 */

import type { WebuiGoal } from "../../../../shared/contracts/goal.js";

export function readWebuiComposerGoalModeAfterSubmit(goal: Pick<WebuiGoal, "status">): boolean {
  return goal.status !== "complete";
}
