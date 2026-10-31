// The goal owner, keyed by session.
//
// Two properties are the reason this moved out of the composer, and both are
// asserted here rather than assumed:
//
//   * the fence belongs to the session whose goal it orders, so a write to one
//     session cannot fence a read of another;
//   * the owner exists whether or not a view is mounted, so an event route can
//     commit through it.

import { describe, expect, it, vi } from "vitest";

import { createWebuiGoalSessionOwners } from "../../src/client/features/goal/application/goal-session-owners.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import type { WebuiGoal } from "../../src/shared/contracts/goal.js";

const goal = (objective: string): WebuiGoal =>
  ({ goalId: `g-${objective}`, objective, status: "active", updatedAt: 1 }) as unknown as WebuiGoal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("goal owners are keyed by session", () => {
  it("creates one owner per session and keeps it", () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({ store });

    const a = owners.owner("A");
    expect(owners.owner("A")).toBe(a);
    expect(owners.owner("B")).not.toBe(a);
    expect(owners.sessions()).toEqual(["A", "B"]);
  });

  it("writes through the store's goal slice and nothing else", () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({ store });

    owners.owner("A").applyGoal(goal("A 的目标"));

    expect(store.readSession("A").goal?.objective).toBe("A 的目标");
    expect(store.readSession("B").goal).toBeUndefined();
  });

  it("does not let one session's write fence another session's read", async () => {
    // The defect this exists for: one cell for the whole application, so a goal
    // write for A retired a read that was in flight for B.
    const pendingA = deferred<WebuiGoal>();
    const pendingB = deferred<WebuiGoal>();
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({
      store,
      port: {
        getGoal: ({ sessionId }: { readonly sessionId: string }) =>
          sessionId === "A" ? pendingA.promise : pendingB.promise,
      } as never,
    });

    const readA = owners.owner("A").refreshGoal();
    const readB = owners.owner("B").refreshGoal();
    // A write lands on B while A's read is still in flight.
    owners.owner("B").applyGoal(goal("B 的新目标"));

    pendingA.resolve(goal("A 的答案"));
    await expect(readA).resolves.toEqual({ ok: true });
    // A's own read is unaffected by B's write.
    expect(store.readSession("A").goal?.objective).toBe("A 的答案");

    pendingB.resolve(goal("B 的旧答案"));
    await readB;
    // B's read was superseded by B's write, and is dropped.
    expect(store.readSession("B").goal?.objective).toBe("B 的新目标");
  });

  it("tells view reactions about a landed re-read, and stops when they leave", async () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({
      store,
      port: { getGoal: async () => goal("A 的目标") } as never,
    });
    const seen: Array<string | undefined> = [];
    const stop = owners.subscribe("A", (next) => seen.push(next?.objective));

    await owners.owner("A").refreshGoal();
    expect(seen).toEqual(["A 的目标"]);

    stop();
    await owners.owner("A").refreshGoal();
    expect(seen).toEqual(["A 的目标"]);
  });

  it("drops a session's owner and its reactions on purge", () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({ store });
    const listener = vi.fn();
    owners.subscribe("A", listener);
    owners.owner("A");

    owners.purge("A");

    expect(owners.sessions()).toEqual([]);
    // A fresh owner is a fresh fence, and the old reaction is gone.
    owners.owner("A").applyGoal(goal("after purge"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops committing once disposed", () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiGoalSessionOwners({ store });
    const owner = owners.owner("A");
    owners.dispose();

    owner.applyGoal(goal("late"));

    expect(store.readSession("A").goal).toBeUndefined();
    expect(owners.isDisposed()).toBe(true);
  });
});
