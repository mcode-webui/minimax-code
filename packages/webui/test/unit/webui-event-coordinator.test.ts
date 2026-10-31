// The event coordinator's routing guard.
//
// `thread_goal.updated` declares its session id inside `goal` rather than at
// the payload top level. The effect reducer's own session guard carries a
// nested-goal fallback for that, but the coordinator — the thing that decides
// whether an event is delivered at all — read the top level only, so every
// such event was dropped before the reducer could see it. The symptom was a
// goal banner frozen on whatever `getGoal()` returned when the session opened.
//
// This is the deterministic half of that fix; the browser half lives in
// `test/browser/workspace-progress-live.spec.mjs`.

import { describe, expect, it } from "vitest";

import { createWebuiEventCoordinator } from "../../src/client/features/turn/application/event-coordinator.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiStreamLeaseController } from "../../src/client/features/turn/application/stream-lease-controller.js";
import { createWebuiSessionActivityController } from "../../src/client/features/sessions/application/session-activity-controller.js";
import { createWebuiGoalSessionOwners } from "../../src/client/features/goal/application/goal-session-owners.js";

function coordinator() {
  const store = createWebuiSessionStore();
  const leases = createWebuiStreamLeaseController(store);
  const activity = createWebuiSessionActivityController(store);
  // The permanent goal route, installed exactly as the assembly installs it: the
  // owner is the application's, so a goal event commits with nothing registered.
  const goals = createWebuiGoalSessionOwners({ store });
  const facts: unknown[] = [];
  const events = createWebuiEventCoordinator({
    store,
    leases,
    activity,
    routes: {
      setGoal: (sessionId, goal) => goals.owner(sessionId).applyGoal(goal),
      refreshGoal: (sessionId) => goals.owner(sessionId).refreshGoal(),
      invalidatePending: () => undefined,
      refreshPending: () => undefined,
      attachStream: () => undefined,
      channelReady: () => undefined,
      workspaceGitChanged: () => undefined,
      sessionFact: (fact) => facts.push(fact),
    },
  });
  return { store, events, goals, facts };
}

const event = (type: string, payload: Record<string, unknown>) =>
  ({ type, payload, timestamp: 1, source: "synthetic" }) as never;

describe("the coordinator routes by the id an event actually carries", () => {
  it("delivers a thread_goal.updated whose id is nested inside goal", () => {
    const { store, events } = coordinator();

    events.handleEvent(
      event("thread_goal.updated", {
        goal: {
          sessionId: "A",
          goalId: "g1",
          objective: "生产形态目标",
          status: "complete",
          tokensUsed: 1,
          turnsUsed: 1,
          timeUsedSeconds: 1,
          updatedAt: 1,
        },
      }),
    );

    expect(store.readSession("A").goal?.objective).toBe("生产形态目标");
  });

  it("still drops an event that names no session anywhere", () => {
    const { store, events } = coordinator();

    events.handleEvent(event("thread_goal.updated", { goal: { goalId: "g1" } }));

    expect(store.getSnapshot().sessions.size).toBe(0);
  });

  it("applies an event to the session it names, not to another", () => {
    const { store, events } = coordinator();

    events.handleEvent(
      event("thread_goal.updated", {
        goal: { sessionId: "B", goalId: "g1", objective: "B 的目标", status: "active", updatedAt: 1 },
      }),
    );

    // Background sessions keep updating: the coordinator routes by the id the
    // event carries, so B gets the goal and A is untouched.
    expect(store.readSession("B").goal?.objective).toBe("B 的目标");
    expect(store.readSession("A").goal).toBeUndefined();
  });
});

describe("V36 · session lifecycle facts from other clients reach this page", () => {
  it("routes every lifecycle event to the sessions owner, not to a turn effect", () => {
    // The runtime publishes these for every client, so this window went stale
    // whenever another one — or the CLI — created, renamed or hid a session. The
    // events were not ignored loudly; they fell through the effect reducer's
    // default branch and vanished, which is why the rail kept showing what it had
    // last loaded until the window was reloaded.
    const cases: readonly [string, Record<string, unknown>, { readonly kind: string }][] = [
      ["session.created", { title: "新会话" }, { kind: "created" }],
      ["session.title_updated", { title: "改过的名字" }, { kind: "renamed" }],
      ["session.renamed", { title: "CLI 起的名字" }, { kind: "renamed" }],
      ["session.model_updated", { model: "gpt-5" }, { kind: "re-modelled" }],
      ["session.interaction_mode.changed", { mode: "plan" }, { kind: "interaction-mode" }],
      ["session.visibility_updated", { hidden: true }, { kind: "visibility" }],
      ["session.pinned_updated", { pinned: true }, { kind: "pinned" }],
      ["session.deleted", {}, { kind: "deleted" }],
    ];

    for (const [type, payload, expected] of cases) {
      const harness = coordinator();
      harness.events.handleEvent(event(type, { sessionId: "session-a", ...payload }));
      expect(harness.facts, type).toHaveLength(1);
      expect((harness.facts[0] as { kind: string }).kind, type).toBe(expected.kind);
      expect((harness.facts[0] as { sessionId: string }).sessionId, type).toBe("session-a");
    }
  });

  it("does not invent a rename from an event that carries no title", () => {
    // "The title changed" without a new title says nothing about what to. Guessing
    // would replace a real session name with a blank one.
    const harness = coordinator();
    harness.events.handleEvent(event("session.title_updated", { sessionId: "session-a" }));

    expect(harness.facts).toHaveLength(0);
  });

  it("does not guess a visibility from an event that carries no flag", () => {
    const harness = coordinator();
    harness.events.handleEvent(event("session.visibility_updated", { sessionId: "session-a" }));

    expect(harness.facts).toHaveLength(0);
  });

  it("leaves turn effects on their own path", () => {
    // The lifecycle branch is for catalogue facts only: an ordinary turn event
    // still has to reach the per-session effect reducer, not be swallowed as an
    // unrecognised lifecycle type.
    const harness = coordinator();
    harness.store.updateSession("session-a", (current) => ({ ...current, sending: false }));
    harness.events.handleEvent(event("session.finish", { sessionId: "session-a", turnId: "t1" }));

    expect(harness.facts).toHaveLength(0);
    expect(harness.store.readSession("session-a").sending).toBe(false);
  });
});
