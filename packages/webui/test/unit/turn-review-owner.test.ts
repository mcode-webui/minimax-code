// The turn-review owner: one owner for a turn's diff query and its
// revert/reapply, with the surfaces reading it rather than holding their own
// copy.
//
// These cases are the family's verification list: two consumers of one turn, a
// superseded read, an absent capability versus a refused mutation, and the
// mutation announcement the workspace family is invalidated on.

import { describe, expect, it, vi } from "vitest";

import { createWebuiTurnReviewOwner } from "../../src/client/features/review/application/turn-review-owner.js";
import type { WebuiTurnReviewKey } from "../../src/client/features/review/contracts/turn-review.js";
import type {
  WebuiRevertTurnDiffResult,
  WebuiTurnDiffView,
} from "../../src/shared/contracts/session.js";

const key: WebuiTurnReviewKey = { sessionId: "S", turnId: "T1" };

const view = (changeSetId: string, status: WebuiTurnDiffView["status"] = "active"): WebuiTurnDiffView =>
  ({
    changeSetId,
    status,
    canUndo: status === "active",
    canReapply: status === "reverted",
    fileChanges: [{ file: "a.ts", additions: 1, deletions: 0 }],
  }) as WebuiTurnDiffView;

describe("the turn-review owner", () => {
  it("answers two consumers of one turn from one request", async () => {
    const pending: Array<(value: WebuiTurnDiffView) => void> = [];
    const getTurnDiff = vi.fn(
      () => new Promise<WebuiTurnDiffView>((resolve) => pending.push(resolve)),
    );
    const owner = createWebuiTurnReviewOwner({ port: { getTurnDiff } });

    const first = owner.load(key);
    const second = owner.load(key);
    expect(getTurnDiff).toHaveBeenCalledTimes(1);
    pending[0]!(view("c1"));
    await expect(first).resolves.toEqual({ status: "applied" });
    await expect(second).resolves.toEqual({ status: "applied" });
    // The answer belongs to the key, so both readers see the same state.
    expect(owner.read(key).view?.changeSetId).toBe("c1");
  });

  it("queries by turn instead of the group's fallback message id", async () => {
    const getTurnDiff = vi.fn(async () => view("c1"));
    const owner = createWebuiTurnReviewOwner({ port: { getTurnDiff } });

    // A transcript group can start with a different assistant message from the
    // final message that owns the recorded diff. The runtime checks
    // assistantMessageId before turnId, so sending both makes that fallback
    // message id win and returns an empty fileChanges list.
    await owner.load({
      sessionId: "S",
      turnId: "T1",
      assistantMessageId: "first-message-in-group",
    });

    expect(getTurnDiff).toHaveBeenCalledWith({ id: "S", turnId: "T1" });
  });

  it("does not let a superseded read claim the answer that replaced it", async () => {
    const pending: Array<(value: WebuiTurnDiffView) => void> = [];
    const owner = createWebuiTurnReviewOwner({
      port: { getTurnDiff: () => new Promise((resolve) => pending.push(resolve)) },
    });
    const superseded = owner.load(key);
    // Invalidation is the caller's explicit command (a git-changed signal): the
    // answer already in flight can no longer land.
    owner.invalidate(key);
    const current = owner.load(key);
    expect(pending).toHaveLength(2);
    pending[1]!(view("c2"));
    await expect(current).resolves.toEqual({ status: "applied" });
    pending[0]!(view("c1"));
    await expect(superseded).resolves.toEqual({ status: "stale" });
    expect(owner.read(key).view?.changeSetId).toBe("c2");
  });

  it("reports an absent capability and a refused mutation as different things", async () => {
    const withoutCapability = createWebuiTurnReviewOwner({ port: {} });
    await expect(withoutCapability.load(key)).resolves.toEqual({ status: "unsupported" });
    expect(withoutCapability.read(key).unsupported).toBe(true);

    const owner = createWebuiTurnReviewOwner({
      port: {
        getTurnDiff: async () => view("c1"),
        revertTurnDiff: async () => ({ success: false, error: "conflict" }) as WebuiRevertTurnDiffResult,
      },
    });
    await owner.load(key);
    const outcome = await owner.mutate(key, "revert");
    expect(outcome.status).toBe("failed");
    // A refusal is not an absent capability: the card stays interactive and the
    // reason is the runtime's.
    expect(owner.read(key).unsupported).toBe(false);
    expect(owner.read(key).mutationError).toContain("文件又被修改过");
    owner.dismissError(key);
    expect(owner.read(key).mutationError).toBeUndefined();
  });

  it("announces a settled mutation so the workspace family can be invalidated", async () => {
    const announced: string[] = [];
    const owner = createWebuiTurnReviewOwner({
      port: {
        getTurnDiff: async () => view("c1"),
        revertTurnDiff: async () =>
          ({ success: true, turnDiff: view("c1", "reverted") }) as WebuiRevertTurnDiffResult,
      },
    });
    owner.subscribeMutations((mutation) => announced.push(`${mutation.sessionId}:${mutation.action}`));
    await owner.load(key);
    await expect(owner.mutate(key, "revert")).resolves.toEqual({ status: "applied" });
    expect(announced).toEqual(["S:revert"]);
    expect(owner.read(key).view?.status).toBe("reverted");
    // A refused mutation announces nothing: nothing changed for the other family.
    const refusing = createWebuiTurnReviewOwner({
      port: {
        getTurnDiff: async () => view("c1"),
        revertTurnDiff: async () => ({ success: false, error: "conflict" }) as WebuiRevertTurnDiffResult,
      },
    });
    const refusals: string[] = [];
    refusing.subscribeMutations((mutation) => refusals.push(mutation.sessionId));
    await refusing.load(key);
    await refusing.mutate(key, "revert");
    expect(refusals).toEqual([]);
  });
});
