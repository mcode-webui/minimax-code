// The interaction coordinator's policy.
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
} from "../../src/client/features/interactions/application/interaction-coordinator.js";
import { webuiAnswersEndTurn } from "../../src/client/features/interactions/projection/questionnaire-state.js";
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
  } as never;
}

/**
 * `turn`'s published stream-phase commands, as this suite hands them in. The four
 * transitions are no longer sink callbacks: prohibition 1 is about writers,
 * and these are turn's state, so the flow invokes turn's named commands and the
 * sink carries only this business's own projection writes.
 */
function streams(): NonNullable<Parameters<typeof createWebuiInteractionCoordinator>[0]["streams"]> {
  return {
    markStreamPhase: vi.fn(),
    startStreaming: vi.fn(),
    endStreaming: vi.fn(),
    awaitInteraction: vi.fn(),
    settleStoppedStream: vi.fn(),
  } as never;
}

function coordinator(port: Record<string, unknown>, s = sink(), st = streams()) {
  const pendingVersionRef = { current: 0 };
  return {
    s,
    st,
    pendingVersionRef,
    c: createWebuiInteractionCoordinator({
      port: port as never,
      sink: s,
      streams: st,
      sessionId: "s1",
      agentName: "fallback-agent",
      pendingVersionRef,
    }),
  };
}

describe("plan-review workflow ownership", () => {
  it("submits the plan decision through the application and clears the shared questionnaire projection", async () => {
    const request = questionnaire({ requester: { agentName: "reviewer" } }) as WebuiQuestionnaireRequest;
    const replyQuestionnaire = vi.fn(async () => ({ ok: true as const }));
    const { c, s, st, pendingVersionRef } = coordinator({ replyQuestionnaire });
    const workflow = createWebuiPlanReviewWorkflow({ answerQuestionnaire: c.answerQuestionnaire });
    await workflow.answerPlanBuild(request);
    expect(replyQuestionnaire).toHaveBeenCalledWith({
      name: "reviewer",
      requestId: "q-1",
      schemaVersion: 3,
      answers: [{ stepId: "plan-review", selectedOptionIds: ["approve"], selectedOther: false }],
    });
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
    expect(st.markStreamPhase).toHaveBeenCalledOnce();
    expect(pendingVersionRef.current).toBe(2);
  });

  it("does not let a pending refresh revive the questionnaire after plan execution", async () => {
    const request = questionnaire({ id: "plan-q" }) as WebuiQuestionnaireRequest;
    let resolveRefresh: (value: { request: WebuiQuestionnaireRequest }) => void = () => {};
    const { c, s, st } = coordinator({
      getPendingQuestionnaire: () => new Promise((resolve) => { resolveRefresh = resolve; }),
      replyQuestionnaire: async () => ({ ok: true as const }),
    });
    const refresh = c.refresh();
    const workflow = createWebuiPlanReviewWorkflow({ answerQuestionnaire: c.answerQuestionnaire });
    await workflow.answerPlanBuild(request);
    resolveRefresh({ request });
    await refresh;
    expect(s.applyQuestionnaire).toHaveBeenCalledTimes(1);
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
    expect(st.markStreamPhase).toHaveBeenCalledOnce();
  });

  it("keeps the pending questionnaire when the runtime rejects the plan decision", async () => {
    const request = questionnaire() as WebuiQuestionnaireRequest;
    const { c, s, st } = coordinator({ replyQuestionnaire: async () => ({ ok: false }) });
    const workflow = createWebuiPlanReviewWorkflow({
      answerQuestionnaire: c.answerQuestionnaire,
    });
    await expect(workflow.answerPlanBuild(request)).rejects.toThrow("The questionnaire was not accepted");
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
  });

  it("reports an unavailable questionnaire capability instead of accepting a no-op", async () => {
    const { c, s, st } = coordinator({});
    const workflow = createWebuiPlanReviewWorkflow({
      answerQuestionnaire: c.answerQuestionnaire,
    });
    await expect(workflow.answerPlanBuild(questionnaire() as WebuiQuestionnaireRequest))
      .rejects.toThrow("Questionnaire replies are unavailable");
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — permission replies", () => {
  it("applies an accepted reply: drops the request and resumes the turn", async () => {
    const replyPermission = vi.fn().mockResolvedValue({ success: true });
    const { c, s, st } = coordinator({ replyPermission });
    await expect(c.replyPermission(permission(), "allowOnce")).resolves.toEqual({
      ok: true,
    });
    expect(replyPermission).toHaveBeenCalledWith({
      name: "mavis",
      requestId: "req-1",
      reply: "allowOnce",
    });
    expect(s.removePendingPermission).toHaveBeenCalledWith("req-1");
    expect(st.startStreaming).toHaveBeenCalledTimes(1);
  });

  it("reports a reply the server no longer holds, and changes nothing", async () => {
    const { c, s, st } = coordinator({
      replyPermission: vi.fn().mockResolvedValue({ success: false }),
    });
    const outcome = await c.replyPermission(permission(), "deny");
    expect(outcome).toEqual({
      ok: false,
      error: "The permission request was no longer pending",
    });
    expect(s.removePendingPermission).not.toHaveBeenCalled();
    expect(st.startStreaming).not.toHaveBeenCalled();
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
    const { c, s, st } = coordinator({});
    await expect(c.replyPermission(permission(), "allowOnce")).resolves.toEqual({
      ok: true,
    });
    expect(s.removePendingPermission).not.toHaveBeenCalled();
  });
});

describe("interaction coordinator — questionnaire replies", () => {
  it("answers with the requester's name, clears it, and applies the phase decision itself", async () => {
    const replyQuestionnaire = vi.fn().mockResolvedValue({ ok: true });
    const { c, s, st } = coordinator({ replyQuestionnaire });
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
    // The answers→phase rule moved into the flow with the transition: a
        // skip ends the turn, an answer resumes it.
        expect(st.markStreamPhase).toHaveBeenCalledWith(
          webuiAnswersEndTurn(answers) ? "idle" : "streaming",
        );
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
    const { c, s, st } = coordinator({
      replyQuestionnaire: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(
      c.answerQuestionnaire(questionnaire(), [] as never),
    ).resolves.toEqual({ ok: false, error: "The questionnaire was not accepted" });
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
    expect(st.markStreamPhase).not.toHaveBeenCalled();
  });

  it("dismisses without resuming the turn", async () => {
    const dismissQuestionnaire = vi.fn().mockResolvedValue({ ok: true });
    const { c, s, st } = coordinator({ dismissQuestionnaire });
    await expect(c.dismissQuestionnaire(questionnaire())).resolves.toEqual({
      ok: true,
    });
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
    expect(st.endStreaming).toHaveBeenCalledTimes(1);
    expect(st.markStreamPhase).not.toHaveBeenCalled();
  });

  it("reports a dismissal the server refused", async () => {
    const { c, s, st } = coordinator({
      dismissQuestionnaire: vi.fn().mockResolvedValue({ ok: false }),
    });
    await expect(c.dismissQuestionnaire(questionnaire())).resolves.toEqual({
      ok: false,
      error: "The questionnaire could not be dismissed",
    });
    expect(s.applyQuestionnaire).not.toHaveBeenCalled();
  });
});

// The goal write path and its fence used to be tested here; the duty moved to
// `goal-coordinator.ts` and its six cases moved with it to
// `goal-coordinator.test.ts`, which also asserts the two fences are independent.
// Nothing about the goal duty is left to test through this owner.

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
    const { c, s, st } = coordinator({ listPendingPermissions, getPendingQuestionnaire });
    await expect(c.refresh()).resolves.toEqual({ ok: true });
    expect(s.replacePendingPermissions).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "mine" }),
    ]);
    expect(st.awaitInteraction).toHaveBeenCalledTimes(1);
  });

  it("does not await when nothing is pending", async () => {
    const { c, s, st } = coordinator({
      listPendingPermissions: vi.fn().mockResolvedValue({ requests: [] }),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
    });
    await c.refresh();
    expect(st.awaitInteraction).not.toHaveBeenCalled();
    expect(s.applyQuestionnaire).toHaveBeenCalledWith(undefined);
  });

  it("carries a failed re-read back as a message instead of writing state", async () => {
    const { c, s, st } = coordinator({
      listPendingPermissions: vi.fn().mockRejectedValue(new Error("offline")),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
    });
    await expect(c.refresh()).resolves.toEqual({ ok: false, error: "offline" });
    expect(s.replacePendingPermissions).not.toHaveBeenCalled();
  });

  it("does not restore a permission snapshot after an accepted reply", async () => {
    let release!: (value: unknown) => void;
    const staleRead = new Promise((resolve) => { release = resolve; });
    const { c, s, st } = coordinator({
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
    const { c, s, st } = coordinator({});
    await expect(c.refresh()).resolves.toEqual({ ok: true });
    expect(s.replacePendingPermissions).not.toHaveBeenCalled();
  });
});

/**
 * Prohibition 1 is asserted rather than described: an owner may invoke another
 * business's published command and may not be handed that business's state
 * writers. The four stream-phase transitions are `turn`'s state, so the shape is
 * checked in both directions — the sink type cannot carry one, and the
 * transitions are reached through the command view by name.
 */
describe("prohibition 1: the interaction owner holds no stream writer", () => {
  type StreamMemberInSink = Extract<
    keyof WebuiInteractionSink,
    | "awaitInteraction"
    | "startStreaming"
    | "resumeAfterPermission"
    | "endStreaming"
    | "afterQuestionnaireAnswer"
    | "afterQuestionnaireDismiss"
    | "markStreamPhase"
  >;
  type OnlyTrue<T extends true> = T;

  it("cannot be typed: the sink has no stream member at all", () => {
    const narrow: OnlyTrue<StreamMemberInSink extends never ? true : never> = true;
    expect(narrow).toBe(true);
  });

  it("cannot be reached at runtime: the transition goes through turn's command", async () => {
    const { c, s, st } = coordinator(
      { replyPermission: vi.fn().mockResolvedValue({ success: true }) },
      sink(),
      streams() as never,
    );
    await c.replyPermission(
      { requestId: "r1", agentName: "mavis", sessionId: "s1" } as never,
      "allowOnce",
    );
    expect(st.startStreaming).toHaveBeenCalledTimes(1);
    for (const member of ["startStreaming", "endStreaming", "markStreamPhase", "awaitInteraction"]) {
      expect(s).not.toHaveProperty(member);
    }
  });

  it("still writes only this business's own projection state", async () => {
    // The counterweight: narrowing the sink must not have removed a write this
    // business legitimately owns.
    const { c, s, st } = coordinator({
      listPendingPermissions: vi.fn().mockResolvedValue({ requests: [] }),
      getPendingQuestionnaire: vi.fn().mockResolvedValue({ request: undefined }),
    });
    await c.refresh();
    expect(s.replacePendingPermissions).toHaveBeenCalledTimes(1);
    expect(s.applyQuestionnaire).toHaveBeenCalledTimes(1);
  });
});
