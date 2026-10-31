// The submission admission rule.
//
// Every case here is a fact the Composer's `submitWebuiComposerTurn` already decided at `4fce25f2`,
// plus the reservation, which is the one rule that is new. Pinning them is what makes the later switch
// checkable: if the baseline's ordering is wrong here, the cutover would change behaviour while looking
// like a move.

import { describe, expect, it } from "vitest";

import {
  admitWebuiSubmission,
  webuiSubmissionRefusalFor,
} from "../../src/client/features/turn/application/submission-admission.js";
import type {
  WebuiSubmissionAdmission,
  WebuiSubmissionAdmissionState,
} from "../../src/client/features/turn/contracts/submission.js";

/** The shape every case varies from: an idle, fully capable client with a target session. */
const IDLE: WebuiSubmissionAdmissionState = {
  hasSession: true,
  canCreateSession: true,
  canSend: true,
  canEnqueue: true,
  turnLive: false,
  creating: false,
};

const decide = (
  overrides: Partial<WebuiSubmissionAdmissionState>,
): WebuiSubmissionAdmission => admitWebuiSubmission({ ...IDLE, ...overrides });

describe("the admission rule preserves the baseline's order", () => {
  it("refuses an incapable client before it would create anything", () => {
    // `!args.deps.sendMessage && !args.enqueueMessage` was the function's first guard, so a creator
    // alone never rescued a submission that had no way to deliver its message.
    expect(decide({ canSend: false, canEnqueue: false, hasSession: false })).toEqual({
      kind: "unsupported",
      missing: "transport",
    });
    expect(decide({ canSend: false, canEnqueue: false, hasSession: false, creating: true })).toEqual({
      kind: "unsupported",
      missing: "transport",
    });
  });

  it("asks for a session when the home has no creator", () => {
    // The baseline called `onNeedsSession(args.draft)`.
    expect(decide({ hasSession: false, canCreateSession: false })).toEqual({ kind: "needs-session" });
  });

  it("dispatches a home submission that can create its session", () => {
    expect(decide({ hasSession: false })).toEqual({ kind: "dispatching" });
  });

  it("queues onto a live turn without waiting for it to finish", () => {
    expect(decide({ turnLive: true })).toEqual({ kind: "queued" });
  });

  it("is busy on a live turn it cannot queue onto", () => {
    // The baseline dropped this submission silently, after the `sending` branch's early return.
    expect(decide({ turnLive: true, canEnqueue: false })).toEqual({
      kind: "busy",
      reason: "turn-live",
    });
  });

  it("does not treat a queue capability as a dispatch capability", () => {
    // The baseline reached `if (!args.deps.sendMessage) return;` and stopped there silently.
    expect(decide({ canSend: false })).toEqual({ kind: "unsupported", missing: "transport" });
  });
});

describe("D01: single-flight home creation", () => {
  it("classifies the second submission while a creation is in flight as busy", () => {
    // Decided before any wire IO, and the input is untouched: the caller may keep it.
    expect(decide({ hasSession: false, creating: true })).toEqual({ kind: "busy", reason: "creating" });
  });

  it("lets the reservation win over the turn's own state", () => {
    // A creation in flight is not a live turn: nothing has been dispatched yet, so queueing would
    // queue onto a turn that does not exist.
    expect(decide({ turnLive: true, creating: true })).toEqual({ kind: "busy", reason: "creating" });
    expect(decide({ turnLive: false, creating: true })).toEqual({ kind: "busy", reason: "creating" });
  });

  it("returns to dispatching once the creation has settled", () => {
    // The reservation is per attempt, not sticky: the *next* submission may create again.
    expect(decide({ hasSession: false, creating: false })).toEqual({ kind: "dispatching" });
  });
});

describe("the decision vocabulary", () => {
  it("is reachable in exactly the states the contract names", () => {
    const reachable = new Map<string, [WebuiSubmissionAdmission, Partial<WebuiSubmissionAdmissionState>]>([
      ["dispatching", [{ kind: "dispatching" }, {}]],
      ["queued", [{ kind: "queued" }, { turnLive: true }]],
      ["needs-session", [{ kind: "needs-session" }, { hasSession: false, canCreateSession: false }]],
      ["busy", [{ kind: "busy", reason: "creating" }, { creating: true }]],
      ["unsupported", [{ kind: "unsupported", missing: "transport" }, { canSend: false, canEnqueue: false }]],
    ]);
    for (const [decision, [admission, state]] of reachable) {
      expect(decide(state)).toEqual(admission);
    }
    // The two that are attempt outcomes, not admissions, cannot come out of this function.
    const outcomes = ["creation-failed", "failed"] as const;
    for (const outcome of outcomes) {
      const produced: WebuiSubmissionAdmission[] = [
        decide({}),
        decide({ turnLive: true }),
        decide({ hasSession: false, canCreateSession: false }),
        decide({ creating: true }),
        decide({ canSend: false, canEnqueue: false }),
      ];
      expect(produced).not.toContain(outcome);
    }
  });

  it("names a refusal only for the decisions that refuse", () => {
    expect(webuiSubmissionRefusalFor({ kind: "busy", reason: "turn-live" })).toBe("busy");
    expect(webuiSubmissionRefusalFor({ kind: "unsupported", missing: "transport" })).toBe(
      "unsupported",
    );
    expect(webuiSubmissionRefusalFor({ kind: "needs-session" })).toBe("needs-session");
    expect(webuiSubmissionRefusalFor({ kind: "dispatching" })).toBeUndefined();
    expect(webuiSubmissionRefusalFor({ kind: "queued" })).toBeUndefined();
  });
});
