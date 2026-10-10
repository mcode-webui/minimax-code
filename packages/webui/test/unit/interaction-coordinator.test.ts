// The interaction coordinator's policy (plan §7.1
// `client/application/interaction-coordinator.ts`).
//
// These pin the decisions the composer used to make inline: what counts as an
// accepted reply, what state transition follows it, which permissions a re-read
// keeps, and that a failure leaves state untouched and comes back as a message
// the caller can show. The wiring — transport, store writes, stream phase — is
// scripted, so a failure here is a policy failure and not a wiring one.

import { describe, expect, it, vi } from "vitest";

import {
  createWebuiInteractionCoordinator,
  createWebuiPlanReviewWorkflow,
  type WebuiInteractionSink,
} from "../../src/client/application/interaction-coordinator.js";
import type { WebuiPendingPermission, WebuiQuestionnaireRequest } from "../../src/shared/contracts/interactions.js";

const permission = (
  overrides: Partial<WebuiPendingPermission> = {},
): WebuiPendingPermission =>
  ({
    requestId: "req-1",
    sessionId: "s1",
    agentName: "mavis",
    ...overrides,
  }) as WebuiPendingPermission;

const questionnaire = (overrides: Record<string, unknown> = {}) =>
  ({ id: "q-1", schemaVersion: 3, ...overrides }) as never;

function sink(): WebuiInteractionSink & Record<string, unknown> {
  return {
    replacePendingPermissions: vi.fn(),
    removePendingPermission: vi.fn(),
    applyQuestionnaire: vi.fn(),
    awaitInteraction: vi.fn(),
    resumeAfterPermission: vi.fn(),
    afterQuestionnaireAnswer: vi.fn(),
    afterQuestionnaireDismiss: vi.fn(),
    applyGoal: vi.fn(),
    afterGoalReRead: vi.fn(),
  } as never;
}

function coordinator(port: Record<string, unknown>, s = sink()) {
  const goalVersionRef = { current: 0 };
  const pendingVersionRef = { current: 0 };
  return {
    s,
    goalVersionRef,
    c: createWebuiInteractionCoordinator({
      port: port as never,
      sink: s,
      sessionId: "s1",
      agentName: "fallback-agent",
      goalVersionRef,
      pendingVersionRef,
    }),
  };
}

describe("plan-review workflow ownership", () => {
  it("submits the plan decision through the application and clears the shared questionnaire projection", async () => {
    const request = questionnaire({ requester: { agentName: "reviewer" } }) as WebuiQuestionnaireRequest;
    const replyQuestionnaire = vi.fn(async () => ({ ok: true as const }));
    const clearQuestionnaire = vi.fn();
    const workflow = createWebuiPlanReviewWorkflow({ replyQuestionnaire, clearQuestionnaire });
    await workflow.answerPlanBuild(request);
    expect(replyQuestionnaire).toHaveBeenCalledWith({
      name: "reviewer",
      requestId: "q-1",
      schemaVersion: 3,
      answers: [{ stepId: "plan-review", selectedOptionIds: ["approve"], selectedOther: false }],
    });
    expect(clearQuestionnaire).toHaveBeenCalledOnce();
  });

  it("keeps the pending questionnaire when the runtime rejects the plan decision", async () => {
    const request = questionnaire() as WebuiQuestionnaireRequest;
    const clearQuestionnaire = vi.fn();
    const workflow = createWebuiPlanReviewWorkflow({
      replyQuestionnaire: async () => ({ ok: false }),
      clearQuestionnaire,
    });
    await expect(workflow.answerPlanBuild(request)).rejects.toThrow("The plan decision was not accepted");
    expect(clearQuestionnaire).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — permission replies", () => {
  it("applies an accepted reply: drops the request and resumes the turn", async () => {
    const replyPermission = vi.fn().mockResolvedValue({ success: true });
    const { c, s } = coordinator({ replyPermission });
    await expect(c.replyPermission(permission(), "allowOnce")).resolves.toEqual({
      ok: true,
    });
    expect(replyPermission).toHaveBeenCalledWith({
      name: "mavis",
      requestId: "req-1",
      reply: "allowOnce",
    });
    expect(s.removePendingPermission).toHaveBeenCalledWith("req-1");
    expect(s.resumeAfterPermission).toHaveBeenCalledTimes(1);
  });

  it("reports a reply the server no longer holds, and changes nothing", async () => {
    const { c, s } = coordinator({
      replyPermission: vi.fn().mockResolvedValue({ success: false }),
    });
    const outcome = await c.replyPermission(permission(), "deny");
    expect(outcome).toEqual({
      ok: false,
      error: "The permission request was no longer pending",
    });
    expect(s.removePendingPermission).not.toHaveBeenCalled();
    expect(s.resumeAfterPermission).not.toHaveBeenCalled();
  });

  it("carries a thrown transport failure back as a message", async () => {
    const { c } = coordinator({
      replyPermission: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    await expect(c.replyPermission(permission(), "deny")).resolves.toEqual({
      ok: false,
      error: "socket closed",
    });
  });

  it("is a no-op when the capability is not wired", async () => {
    const { c, s } = coordinator({});
    await expect(c.replyPermission(permission(), "allowOnce")).resolves.toEqual({
      ok: true,
    });
    expect(s.removePendingPermission).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — questionnaire replies", () => {
  it("answers with the requester's name, clears it and hands the phase decision over", async () => {
    const replyQuestionnaire = vi.fn().mockResolvedValue({ ok: true });
    const { c, s } = coordinator({ replyQuestionnaire });
    const answers = [{ questionId: "a", value: "yes" }] as never;
    await expect(
      c.answerQuestionnaire(questionnaire({ requester: { agentName: "other" } }), answers),
    ).resolves.toEqual({ ok: true });
    expect(replyQuestionnaire).toHaveBeenCalledWith({
      name: "other",
      requestId: "q-1",
      schemaVersion: 3,
      answers,
    });
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
    // The skip/answer distinction is the sink's, not this owner's.
    expect(s.afterQuestionnaireAnswer).toHaveBeenCalledWith(answers);
  });

  it("falls back to the coordinator's agent name when the request names none", async () => {
    const replyQuestionnaire = vi.fn().mockResolvedValue({ ok: true });
    const { c } = coordinator({ replyQuestionnaire });
    await c.answerQuestionnaire(questionnaire(), [] as never);
    expect(replyQuestionnaire).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fallback-agent" }),
    );
  });

  it("rejects a questionnaire the server did not accept", async () => {
    const { c, s } = coordinator({
      replyQuestionnaire: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(
      c.answerQuestionnaire(questionnaire(), [] as never),
    ).resolves.toEqual({ ok: false, error: "The questionnaire was not accepted" });
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
    expect(s.afterQuestionnaireAnswer).not.toHaveBeenCalled();
  });

  it("dismisses without resuming the turn", async () => {
    const dismissQuestionnaire = vi.fn().mockResolvedValue({ ok: true });
    const { c, s } = coordinator({ dismissQuestionnaire });
    await expect(c.dismissQuestionnaire(questionnaire())).resolves.toEqual({
      ok: true,
    });
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
    expect(s.afterQuestionnaireDismiss).toHaveBeenCalledTimes(1);
    expect(s.afterQuestionnaireAnswer).not.toHaveBeenCalled();
  });

  it("reports a dismissal the server refused", async () => {
    const { c, s } = coordinator({
      dismissQuestionnaire: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(c.dismissQuestionnaire(questionnaire())).resolves.toEqual({
      ok: false,
      error: "The questionnaire could not be dismissed",
    });
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — the goal write path and its guards", () => {
  it("bumps the version on every write and writes through the sink", () => {
    const { c, s, goalVersionRef } = coordinator({});
    c.applyGoal({ status: "active" } as never);
    c.applyGoal(undefined);
    expect(goalVersionRef.current).toBe(2);
    expect(c.goalVersion()).toBe(2);
    expect(s.applyGoal).toHaveBeenNthCalledWith(1, { status: "active" });
    expect(s.applyGoal).toHaveBeenNthCalledWith(2, undefined);
  });

  it("applies a steering re-read and lets the caller reconcile view state", async () => {
    const goal = { status: "active" };
    const { c, s } = coordinator({ getGoal: vi.fn().mockResolvedValue(goal) });
    await expect(c.refreshGoal()).resolves.toEqual({ ok: true });
    expect(s.applyGoal).toHaveBeenCalledWith(goal);
    expect(s.afterGoalReRead).toHaveBeenCalledWith(goal);
  });

  it("stands down when a newer write landed while the read was in flight", async () => {
    let release!: (goal: unknown) => void;
    const inFlightRead = new Promise((resolve) => {
      release = resolve;
    });
    const { c, s, goalVersionRef } = coordinator({
      getGoal: vi.fn().mockReturnValue(inFlightRead),
    });
    const reRead = c.refreshGoal();
    // A `thread_goal.*` event lands while the read is in flight, writing a newer
    // goal. The answer on its way back is stale.
    goalVersionRef.current += 1;
    release({ status: "complete" });
    await expect(reRead).resolves.toEqual({ ok: true });
    expect(s.applyGoal).not.toHaveBeenCalled();
    expect(s.afterGoalReRead).not.toHaveBeenCalled();
  });

  it("commits only the newest of overlapping goal reads", async () => {
    const releases: ((goal: unknown) => void)[] = [];
    const { c, s } = coordinator({
      getGoal: vi.fn(() => new Promise((resolve) => releases.push(resolve))),
    });
    const older = c.refreshGoal();
    const newer = c.refreshGoal();
    releases[1]!({ status: "new" });
    await newer;
    releases[0]!({ status: "old" });
    await older;
    expect(s.applyGoal).toHaveBeenCalledTimes(1);
    expect(s.applyGoal).toHaveBeenCalledWith({ status: "new" });
  });

  it("carries a failed re-read back as a message", async () => {
    const { c, s } = coordinator({
      getGoal: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(c.refreshGoal()).resolves.toEqual({ ok: false, error: "offline" });
    expect(s.applyGoal).not.toHaveBeenCalled();
  });

  it("is a no-op without a goal read", async () => {
    const { c, s } = coordinator({});
    await expect(c.refreshGoal()).resolves.toEqual({ ok: true });
    expect(s.applyGoal).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — the authoritative re-read", () => {
  it("keeps only this session's permissions and awaits when either is pending", async () => {
    const listPendingPermissions = vi.fn().mockResolvedValue({
      requests: [
        permission({ requestId: "mine", sessionId: "s1" }),
        permission({ requestId: "theirs", sessionId: "s2" }),
      ],
    });
    const getPendingQuestionnaire = vi
      .fn()
      .mockResolvedValue({ request: undefined });
    const { c, s } = coordinator({ listPendingPermissions, getPendingQuestionnaire });
    await expect(c.refresh()).resolves.toEqual({ ok: true });
    expect(s.replacePendingPermissions).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "mine" }),
    ]);
    expect(s.awaitInteraction).toHaveBeenCalledTimes(1);
  });

  it("does not await when nothing is pending", async () => {
    const { c, s } = coordinator({
      listPendingPermissions: vi.fn().mockResolvedValue({ requests: [] }),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
    });
    await c.refresh();
    expect(s.awaitInteraction).not.toHaveBeenCalled();
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
  });

  it("carries a failed re-read back as a message instead of writing state", async () => {
    const { c, s } = coordinator({
      listPendingPermissions: vi.fn().mockRejectedValue(new Error("offline")),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
    });
    await expect(c.refresh()).resolves.toEqual({ ok: false, error: "offline" });
    expect(s.replacePendingPermissions).not.toHaveBeenCalled();
  });

  it("does not restore a permission snapshot after an accepted reply", async () => {
    let release!: (value: unknown) => void;
    const staleRead = new Promise((resolve) => { release = resolve; });
    const { c, s } = coordinator({
      listPendingPermissions: vi.fn().mockReturnValue(staleRead),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
      replyPermission: vi.fn().mockResolvedValue({ success: true }),
    });
    const refresh = c.refresh();
    await c.replyPermission(permission(), "allowOnce");
    release({ requests: [permission()] });
    await refresh;
    expect(s.removePendingPermission).toHaveBeenCalledWith("req-1");
    expect(s.replacePendingPermissions).not.toHaveBeenCalled();
  });

  it("is a no-op when neither read is wired", async () => {
    const { c, s } = coordinator({});
    await expect(c.refresh()).resolves.toEqual({ ok: true });
    expect(s.replacePendingPermissions).not.toHaveBeenCalled();
  });
});
