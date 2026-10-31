// The goal coordinator.
//
// The goal duty moved out of `interaction-coordinator.ts` at this carve, and the
// two things this file has to establish are that the duty still behaves exactly
// as it did (the six cases below are the ones that lived in the interaction
// suite, moved with the code) and that the two fences are now **independently**
// enforced — a goal write cannot fence a pending read and a pending reply cannot
// fence a goal read.
//
// The independence assertions are not decoration. Both fences are the same
// mechanism (capture before the read, compare after), and the failure they guard
// against is a shared counter: one cell between two duties would make every
// unrelated interaction invalidate every in-flight goal read and vice versa,
// which produces dropped answers with no error anywhere.

import { describe, expect, it, vi } from "vitest";

import {
  createWebuiGoalCoordinator,
  type WebuiGoalSink,
} from "../../src/client/features/goal/application/goal-coordinator.js";
import { createWebuiInteractionCoordinator } from "../../src/client/features/interactions/application/interaction-coordinator.js";

function goalSink(): WebuiGoalSink & Record<string, unknown> {
  return { applyGoal: vi.fn(), afterGoalReRead: vi.fn() } as never;
}

function coordinator(
  port: Record<string, unknown> = {},
  sink = goalSink(),
): {
  readonly c: ReturnType<typeof createWebuiGoalCoordinator>;
  readonly s: WebuiGoalSink & Record<string, unknown>;
  readonly goalVersionRef: { current: number };
} {
  const goalVersionRef = { current: 0 };
  return {
    s: sink,
    goalVersionRef,
    c: createWebuiGoalCoordinator({
      port: port as never,
      sink,
      goalVersionRef,
      sessionId: "s1",
    }),
  };
}

describe("goal coordinator — the write path and its fence", () => {
  it("bumps the version on every write and writes through the sink", () => {
    const { c, s, goalVersionRef } = coordinator();
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
    const { c, s } = coordinator();
    await expect(c.refreshGoal()).resolves.toEqual({ ok: true });
    expect(s.applyGoal).not.toHaveBeenCalled();
  });
});

describe("the two fences are independent", () => {
  function both() {
    const goalVersionRef = { current: 0 };
    const pendingVersionRef = { current: 0 };
    const goal = createWebuiGoalCoordinator({
      port: { getGoal: vi.fn().mockResolvedValue({ status: "active" }) } as never,
      sink: goalSink(),
      goalVersionRef,
      sessionId: "s1",
    });
    const interactions = createWebuiInteractionCoordinator({
      port: {
        replyPermission: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      sink: {
        replacePendingPermissions: vi.fn(),
        removePendingPermission: vi.fn(),
        applyQuestionnaire: vi.fn(),
      } as never,
      // The four transitions left `sink` for turn's published stream-phase commands
      // (prohibition 1 is about writers); this suite still handed them in as sink members.
      streams: {
        awaitInteraction: vi.fn(),
        resumeAfterPermission: vi.fn(),
        afterQuestionnaireAnswer: vi.fn(),
        afterQuestionnaireDismiss: vi.fn(),
      } as never,
      sessionId: "s1",
      agentName: "mavis",
      pendingVersionRef,
    });
    return { goal, interactions, goalVersionRef, pendingVersionRef };
  }

  it("a goal write does not bump the pending cell", async () => {
    const { goal, interactions, goalVersionRef, pendingVersionRef } = both();
    const before = pendingVersionRef.current;
    goal.applyGoal({ status: "active" } as never);
    await goal.refreshGoal();
    expect(goalVersionRef.current).toBeGreaterThan(0);
    expect(pendingVersionRef.current).toBe(before);
    // And the pending duty still works against its own cell.
    interactions.invalidatePendingReads();
    expect(pendingVersionRef.current).toBe(before + 1);
  });

  it("a pending reply does not bump the goal cell", async () => {
    const { goal, interactions, goalVersionRef, pendingVersionRef } = both();
    const before = goalVersionRef.current;
    await interactions.replyPermission(
      { requestId: "r1", agentName: "mavis", sessionId: "s1" } as never,
      "allowOnce",
    );
    expect(pendingVersionRef.current).toBeGreaterThan(0);
    expect(goalVersionRef.current).toBe(before);
  });

  it("the interaction owner no longer carries the goal duty at all", () => {
    const { interactions } = both();
    // Removing the duty meant removing its surface: a leftover `applyGoal` or
    // `refreshGoal` here would be a second writer of goal state, which is the
    // shape prohibition 1 forbids rather than a tidiness question.
    expect(interactions).not.toHaveProperty("applyGoal");
    expect(interactions).not.toHaveProperty("refreshGoal");
    expect(interactions).not.toHaveProperty("goalVersion");
  });
});

/**
 * The write commands' failure recovery. Publishing `patchGoal`/`clearGoal` put
 * them on the versioned write path, so what happens when they fail is now this
 * owner's behaviour rather than the caller's.
 */
describe("goal coordinator — the published writes recover without applying", () => {
  it("a patch that rejects applies nothing and bumps nothing", async () => {
    const { c, s, goalVersionRef } = coordinator({
      patchGoal: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(
      c.patchGoal!({ sessionId: "s1", objective: "next" } as never),
    ).rejects.toThrow("offline");
    expect(s.applyGoal).not.toHaveBeenCalled();
    expect(goalVersionRef.current).toBe(0);
  });

  it("a patch that lands applies the returned goal, so the fence covers it", async () => {
    const next = { status: "active", objective: "next" };
    const { c, s, goalVersionRef } = coordinator({
      patchGoal: vi.fn().mockResolvedValue(next),
    });
    await expect(
      c.patchGoal!({ sessionId: "s1", objective: "next" } as never),
    ).resolves.toEqual(next);
    expect(s.applyGoal).toHaveBeenCalledWith(next);
    // The write went through the versioned path: a read already in flight
    // captured the older version and will now stand down.
    expect(goalVersionRef.current).toBe(1);
  });

  it("a clear the server refuses applies nothing", async () => {
    const { c, s, goalVersionRef } = coordinator({
      clearGoal: vi.fn().mockResolvedValue({ success: false }),
    });
    await expect(c.clearGoal!({ sessionId: "s1" } as never)).resolves.toEqual({
      success: false,
    });
    expect(s.applyGoal).not.toHaveBeenCalled();
    expect(goalVersionRef.current).toBe(0);
  });

  it("a clear that lands applies undefined", async () => {
    const { c, s } = coordinator({
      clearGoal: vi.fn().mockResolvedValue({ success: true }),
    });
    await c.clearGoal!({ sessionId: "s1" } as never);
    expect(s.applyGoal).toHaveBeenCalledWith(undefined);
  });

  it("does not publish a write the host does not wire", () => {
    // Optionality preserved where it was: a host with no patch capability gets no
    // command, so the caller's "not wired" branch behaves as it did against the
    // port rather than calling a function that silently does nothing.
    const { c } = coordinator();
    expect(c.patchGoal).toBeUndefined();
    expect(c.clearGoal).toBeUndefined();
    expect(c.isGoalEnabled).toBeUndefined();
  });
});
