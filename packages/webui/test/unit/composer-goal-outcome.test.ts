// The composer's goal reset rule. Inline it was
// `status !== "complete"`; here it is the named decision with its matrix.

import { describe, expect, it } from "vitest";

import { readWebuiComposerGoalModeAfterSubmit } from "../../src/client/features/composer/projection/composer-goal-outcome.js";

describe("goal mode after a goal submission", () => {
  it("stays on for an active goal", () => {
    expect(readWebuiComposerGoalModeAfterSubmit({ status: "active" })).toBe(true);
  });

  it("stays on for every status the goal contract can report, except complete", () => {
    // The whole `WebuiGoalStatus` union, so a status added later cannot silently
    // fall on the wrong side of this rule: only `complete` ends goal mode.
    const statuses = ["active", "paused", "blocked", "budget_limited", "usage_limited"] as const;
    for (const status of statuses) {
      expect(readWebuiComposerGoalModeAfterSubmit({ status })).toBe(true);
    }
  });

  it("turns off for a completed goal", () => {
    expect(readWebuiComposerGoalModeAfterSubmit({ status: "complete" })).toBe(false);
  });
});
