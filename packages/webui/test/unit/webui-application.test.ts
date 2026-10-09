// Unit tests for the application event coordinator and its single lease
// implementation (ticket #45, slice B).
//
// This slice builds `client/application/` but deliberately does NOT wire it into
// the live process-event ingress — the atomic switch happens in a later
// delivery unit. So every case here drives the new layer directly, through
// `createWebuiApplication`, against a fake process-event channel. What it pins
// is exactly the list the ticket names:
//
//   * one channel per application instance, and repeated mount/unmount still
//     yields one;
//   * a throwing listener does not break other subscribers, and unsubscribing
//     does not tear down the shared channel;
//   * the coordinator routes events to the retained activity/effect reducers and
//     executes their effect commands against the store's writers;
//   * a superseded generation's frames produce zero writes;
//   * a late result for a previously selected session is discarded;
//   * lease release on terminal, error and cancellation; resume overflow;
//   * a late completion after disposal writes nothing.

import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiEventEffectsRegistry } from "../../src/client/application/event-effects-registry.js";
import type { WebuiProcessEventChannel } from "../../src/client/application/event-channel.js";
import { createWebuiRequestOwnership } from "../../src/client/application/request-ownership.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";
import type { WebuiClientSessionResumer } from "../../src/client/contracts/execution-port.js";

function event(type: string, payload: Record<string, unknown>): WebuiRuntimeEvent {
  return { type, payload, timestamp: 1, source: "test" };
}

interface FakeChannel {
  readonly channel: WebuiProcessEventChannel;
  readonly emit: (event: WebuiRuntimeEvent) => void;
  readonly ready: () => void;
  readonly listenerCount: () => number;
  readonly closeSpy: ReturnType<typeof vi.fn>;
}

function makeChannel(): FakeChannel {
  const listeners = new Set<(event: WebuiRuntimeEvent) => void>();
  const readyCallbacks = new Set<() => void>();
  const closeSpy = vi.fn();
  const channel: WebuiProcessEventChannel = {
    subscribe: (listener, onReady) => {
      listeners.add(listener);
      if (onReady) readyCallbacks.add(onReady);
      return () => {
        listeners.delete(listener);
        if (onReady) readyCallbacks.delete(onReady);
      };
    },
    close: closeSpy,
  };
  return {
    channel,
    emit: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
    ready: () => {
      for (const onReady of [...readyCallbacks]) onReady();
    },
    listenerCount: () => listeners.size,
    closeSpy,
  };
}

function makeApplication(effects = {}) {
  const channels: FakeChannel[] = [];
  let opened = 0;
  const resumeSession = vi.fn(async () => {}) as unknown as WebuiClientSessionResumer;
  const application = createWebuiApplication({
    openEventChannel: () => {
      opened += 1;
      const fake = makeChannel();
      channels.push(fake);
      return fake.channel;
    },
    effects,
    turns: { resumeSession },
  });
  return { application, channels, opened: () => opened };
}

const frame = (dataJson: string): WebuiStreamFrame => ({ dataJson });

function agentMessageFrame(text: string): WebuiStreamFrame {
  return frame(
    JSON.stringify({ type: 2, agent_message: { msg_id: "m1", msg_content: text } }),
  );
}

describe("the application's single channel", () => {
  it("opens exactly one channel per application instance", () => {
    const first = makeApplication();
    const second = makeApplication();
    expect(first.opened()).toBe(1);
    expect(second.opened()).toBe(1);
    // And the event coordinator is its sole consumer: one listener on the wire.
    expect(first.channels[0]!.listenerCount()).toBe(1);
  });

  it("keeps one channel across repeated mount/unmount", () => {
    const { application, channels, opened } = makeApplication();
    for (let i = 0; i < 5; i += 1) {
      const unsubscribe = application.subscribe(() => undefined);
      unsubscribe();
    }
    // Component subscriptions live on the application, not the raw channel, so
    // they never open another one.
    expect(opened()).toBe(1);
    expect(channels[0]!.listenerCount()).toBe(1);
  });

  it("a throwing listener does not break other subscribers", () => {
    const { application } = makeApplication();
    const healthy = vi.fn();
    application.subscribe(() => {
      throw new Error("listener exploded");
    });
    application.subscribe(healthy);
    application.select("s1");
    expect(healthy).toHaveBeenCalled();
  });

  it("unsubscribing does not tear down the shared channel", () => {
    const { application, channels } = makeApplication();
    const kept = vi.fn();
    const dropped = application.subscribe(() => undefined);
    application.subscribe(kept);
    dropped();
    // A channel event still reaches the remaining subscriber and the channel
    // is never closed by a component unmount.
    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "t1" }));
    expect(kept).toHaveBeenCalled();
    expect(channels[0]!.closeSpy).not.toHaveBeenCalled();
    expect(channels[0]!.listenerCount()).toBe(1);
  });
});

describe("event routing to the retained reducers", () => {
  it("routes activity and executes the effect reducer's commands", () => {
    const { application, channels } = makeApplication();
    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "t1" }));

    const snapshot = application.getSnapshot();
    // Activity reducer (retained, unchanged) marked the session busy.
    expect(snapshot.activity["s1"]?.busy?.turnId).toBe("t1");
    // Effect execution lives in the coordinator: the store's writer recorded
    // sending + the streaming phase.
    expect(application.store.readSession("s1").sending).toBe(true);
    expect(application.store.readSession("s1").stream.phase).toBe("streaming");
  });

  it("runs an injected ready effect when the channel is accepted", () => {
    const channelReady = vi.fn();
    const { channels } = makeApplication({ channelReady });
    expect(channelReady).not.toHaveBeenCalled();
    channels[0]!.ready();
    expect(channelReady).toHaveBeenCalledTimes(1);
  });
});

describe("the single lease and generation fencing", () => {
  it("drops a superseded generation's frames with zero writes", () => {
    const { application } = makeApplication();
    const first = application.leases.claim("s1", "local-send");
    const second = application.leases.claim("s1", "recovered", "t2");

    const before = application.store.readSession("s1").stream;
    application.events.handleStreamFrame({
      sessionId: "s1",
      generation: first,
      frame: agentMessageFrame("stale"),
    });
    // Same object identity: the superseded attempt produced no write at all.
    expect(application.store.readSession("s1").stream).toBe(before);
    expect(application.store.readSession("s1").stream.messages).toHaveLength(0);

    application.events.handleStreamFrame({
      sessionId: "s1",
      generation: second,
      frame: agentMessageFrame("live"),
    });
    expect(application.store.readSession("s1").stream.messages).toHaveLength(1);
  });

  it("releases the lease on terminal, error and cancellation", () => {
    const { application, channels } = makeApplication();
    for (const [type, expected] of [
      ["session.finish", "finished"],
      ["session.error", "error"],
      ["session.abort", "aborted"],
    ] as const) {
      application.leases.claim("s1", "recovered", "t1");
      channels[0]!.emit(event(type, { sessionId: "s1", turnId: "t1" }));
      const stream = application.store.readSession("s1").stream;
      expect(stream.subscription).toBeUndefined();
      expect(stream.status).toBe(expected);
    }

    // Cancellation: an explicit release scoped to the claiming generation.
    const generation = application.leases.claim("s1", "local-send");
    application.leases.release("s1", { generation });
    expect(application.store.readSession("s1").stream.subscription).toBeUndefined();
  });

  it("handles resume overflow by releasing the lease and marking a resync", () => {
    const resumeOverflow = vi.fn();
    const { application } = makeApplication({ resumeOverflow });
    const generation = application.leases.claim("s1", "local-send");

    application.events.handleStreamFrame({
      sessionId: "s1",
      generation,
      frame: frame(JSON.stringify({ type: "resume_overflow" })),
    });

    const stream = application.store.readSession("s1").stream;
    expect(stream.resumeRequired).toBe(true);
    expect(stream.phase).toBe("reconnecting");
    expect(stream.subscription).toBeUndefined();
    expect(resumeOverflow).toHaveBeenCalledWith("s1");
  });
});

describe("the turn coordinator's manual retry", () => {
  function appWithResume(resumeSession: WebuiClientSessionResumer) {
    const fake = makeChannel();
    const application = createWebuiApplication({
      openEventChannel: () => fake.channel,
      turns: { resumeSession },
    });
    return { application, channel: fake };
  }

  function seedRefused(
    application: ReturnType<typeof appWithResume>["application"],
    sessionId: string,
  ): void {
    application.store.updateSession(sessionId, (current) => ({
      ...current,
      stream: {
        ...current.stream,
        phase: "refused",
        refusal: "WebUI connection closed before [DONE]",
        cursor: "c9",
      },
    }));
  }

  it("clears the standing refusal and re-attaches from the recorded cursor", () => {
    const resumeSession = vi.fn(
      () => new Promise<void>(() => {}),
    ) as unknown as WebuiClientSessionResumer;
    const { application } = appWithResume(resumeSession);
    seedRefused(application, "s1");

    void application.turns.retry("s1");

    const stream = application.store.readSession("s1").stream;
    // The attach loop's synchronous prefix: lease claimed, phase streaming, and
    // the old refusal gone rather than lingering under the new attempt.
    expect(stream.phase).toBe("streaming");
    expect(stream.refusal).toBeUndefined();
    expect(stream.transcriptIncomplete).toBe(false);
    expect(stream.subscription?.owner).toBe("recovered");
    expect(resumeSession).toHaveBeenCalledWith(
      { id: "s1", afterCursor: "c9" },
      expect.any(Function),
    );
  });

  it("is one attempt: a still-dead server refuses again through the same path", async () => {
    const resumeSession = vi.fn(async () => {
      throw new Error("connection refused again");
    }) as unknown as WebuiClientSessionResumer;
    const { application } = appWithResume(resumeSession);
    seedRefused(application, "s1");

    await application.turns.retry("s1");

    const stream = application.store.readSession("s1").stream;
    expect(stream.phase).toBe("refused");
    expect(stream.refusal).toBe("connection refused again");
    // The failed attempt leaves no lease behind for the next retry to collide
    // with.
    expect(stream.subscription).toBeUndefined();
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });
});

describe("late results and disposal", () => {
  it("discards a result belonging to a previously selected session", () => {
    let selected = "A";
    const ownership = createWebuiRequestOwnership(() => selected);
    const ticket = ownership.capture("A");

    const applied: string[] = [];
    const settle = ownership.guard(ticket, (value: string) => applied.push(value));

    // The user switches to B before A's request answers.
    selected = "B";
    settle("answer-for-A");
    expect(applied).toEqual([]);

    // Switching back does not resurrect the stale completion either — the guard
    // reads the live selection at completion time.
    selected = "A";
    settle("answer-for-A-late");
    expect(applied).toEqual(["answer-for-A-late"]);
  });

  it("writes nothing after disposal", () => {
    const { application } = makeApplication();
    const generation = application.leases.claim("s1", "local-send");
    const before = application.store.readSession("s1").stream;

    application.dispose();

    application.events.handleStreamFrame({
      sessionId: "s1",
      generation,
      frame: agentMessageFrame("after dispose"),
    });
    application.store.updateSession("s1", (current) => ({
      ...current,
      sending: true,
    }));

    expect(application.store.isDisposed()).toBe(true);
    expect(application.store.readSession("s1").stream).toBe(before);
    expect(application.store.readSession("s1").sending).toBe(false);
  });
});

describe("stage 4 — the four call sites' handling through the coordinator", () => {
  it("claims its own locally sent turn instead of attaching a second stream", () => {
    const attachStream = vi.fn();
    const { application, channels } = makeApplication({ attachStream });
    // A local send claims the lease without a turn id (the stream loop's
    // `claimSubscription("local-send")`), then the runtime publishes
    // `session.start` for our own turn.
    application.leases.claim("s1", "local-send");
    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "t1" }));

    // The lease already covers the turn, so no second stream is opened; the
    // reducer adopts the turn id onto the existing subscription instead.
    expect(attachStream).not.toHaveBeenCalled();
    const stream = application.store.readSession("s1").stream;
    expect(stream.subscription?.turnId).toBe("t1");
    expect(stream.subscription?.owner).toBe("local-send");
    expect(application.store.readSession("s1").sending).toBe(true);
  });

  it("attaches a server-initiated turn the client never started", () => {
    const attachStream = vi.fn();
    const { channels } = makeApplication({ attachStream });
    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "srv-1" }));
    expect(attachStream).toHaveBeenCalledWith("s1", "srv-1", "attach");
  });

  it("asks the active-turn probe to recheck when a session.start names another turn", () => {
    const attachStream = vi.fn();
    const { application, channels } = makeApplication({ attachStream });
    application.leases.claim("s1", "recovered", "other");
    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "srv-2" }));
    // A different turn is already held; the event alone cannot tell stale from
    // concurrent, so the attach decision is "recheck" and the probe decides.
    expect(attachStream).toHaveBeenCalledWith("s1", "srv-2", "recheck");
  });

  it("re-reads interaction, questionnaire and goal through the registered effects", () => {
    const registry = createWebuiEventEffectsRegistry();
    const refreshPending = vi.fn();
    const refreshGoal = vi.fn();
    const setGoal = vi.fn();
    registry.register("s1", { refreshPending, refreshGoal, setGoal });
    const fake = makeChannel();
    createWebuiApplication({
      openEventChannel: () => fake.channel,
      effects: registry.asWebuiEventEffects(),
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });

    fake.emit(event("session.queue.updated", { sessionId: "s1" }));
    expect(refreshPending).toHaveBeenCalledWith("s1");

    fake.emit(
      event("thread_goal.objective_updated_steering", {
        sessionId: "s1",
        goalId: "g1",
      }),
    );
    expect(refreshGoal).toHaveBeenCalledWith("s1");

    // A goal-bearing event routes its write through the session's registered
    // goal writer, so the composer's version guard still owns every write.
    fake.emit(event("thread_goal.cleared", { sessionId: "s1" }));
    expect(setGoal).toHaveBeenCalledWith("s1", undefined);
  });

  it("invalidates the workspace panel git and review queries through the coordinator", () => {
    const workspaceGitChanged = vi.fn();
    const { channels } = makeApplication({ workspaceGitChanged });
    channels[0]!.emit(
      event("workspace.git.changed", {
        workspace: "/repo",
        aliases: ["/repo-alias"],
      }),
    );
    expect(workspaceGitChanged).toHaveBeenCalledWith({
      workspace: "/repo",
      aliases: ["/repo-alias"],
    });
  });

  it("re-probes after reconnect by fanning the ready signal to every session", () => {
    const registry = createWebuiEventEffectsRegistry();
    const firstReady = vi.fn();
    const secondReady = vi.fn();
    registry.register("s1", { channelReady: firstReady });
    registry.register("s2", { channelReady: secondReady });
    const fake = makeChannel();
    createWebuiApplication({
      openEventChannel: () => fake.channel,
      effects: registry.asWebuiEventEffects(),
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    // The server accepted the channel again; each session re-reads its
    // authoritative state, which is how a missed `session.start` is recovered.
    fake.ready();
    expect(firstReady).toHaveBeenCalledTimes(1);
    expect(secondReady).toHaveBeenCalledTimes(1);
  });
});
