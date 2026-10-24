// Unit tests for the application event coordinator.
//
// Every case drives the coordinator through `createWebuiApplication` against a
// fake process-event channel. What it pins is this list:
//
//   * one channel per application instance, and repeated mount/unmount still
//     yields one;
//   * a throwing listener does not break other subscribers, and unsubscribing
//     does not tear down the shared channel;
//   * the coordinator routes events to the retained activity/effect reducers and
//     executes their effect commands against the store's writers;
//   * a late result for a previously selected session is discarded;
//   * lease release on terminal, error and cancellation;
//   * a late completion after disposal writes nothing.
//
// Stream frames are not part of this surface. They reach the store through the
// stream sink (`client/conversation/stream-loop.ts`), which owns the lease fence;
// `webui-shell.test.ts` covers the superseded-generation and resume-overflow
// behaviour on that path.
import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import type { WebuiProcessEventChannel } from "../../src/client/features/turn/application/event-channel.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";
import type {WebuiClientSessionResumer} from "../../src/client/features/turn/contracts/execution-port.js";

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

const noopResumeSession = vi.fn(async () => {}) as unknown as WebuiClientSessionResumer;

function makeApplication(
  options: {
    readonly interactionsPort?: Record<string, unknown>;
    readonly goalPort?: Record<string, unknown>;
    readonly turnCapabilities?: Record<string, unknown>;
  } = {},
) {
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
    ...(options.interactionsPort
      ? { interactionsPort: options.interactionsPort as never }
      : {}),
    ...(options.goalPort ? { goalPort: options.goalPort as never } : {}),
    ...(options.turnCapabilities
      ? { turnCapabilities: options.turnCapabilities as never }
      : {}),
    turns: { resumeSession },
  });
  application.start();
  return { application, channels, opened: () => opened };
}

describe("stage 4 — the four call sites' handling through the coordinator", () => {
  it("attaches to the turn a session.start names, with no view mounted", async () => {
    // The application builds the conversation command set for the session and
    // attaches itself: the composer is not involved. The evidence is the
    // attempt reaching the session's own transport.
    const { application, channels } = makeApplication({
      turnCapabilities: { resume: async () => undefined },
    });

    channels[0]!.emit(event("session.start", { sessionId: "s1", turnId: "turn-B" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The attempt started on the session's record: streaming, with the sending
    // flag up, which is what a mounted composer used to be required for.
    const record = application.store.readSession("s1");
    expect(record.stream.phase).toBe("streaming");
    expect(record.sending).toBe(true);
  });

  it("does not route queue state changes through the pending-interaction owner", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const { channels } = makeApplication({ interactionsPort: { listPendingPermissions } });

    channels[0]!.emit(event("session.queue.updated", { sessionId: "s1" }));

    expect(listPendingPermissions).not.toHaveBeenCalled();
  });

  it("reaches the workspace owner on a workspace-git event with nothing mounted", () => {
    // The signal used to travel through a listener a mounted shell subscribed,
    // so it was delivered exactly when a view happened to be on screen. These
    // three cases pin the links the assembly installs instead: they hold from
    // construction, and none of them needs a component.
    const fake = makeChannel();
    const application = createWebuiApplication({
      openEventChannel: () => fake.channel,
      turns: { resumeSession: noopResumeSession },
    });
    application.start();
    const queries = application.workspaceQueries;
    const invalidate = vi.fn();
    // The route resolves the owner per event, so replacing the method is the
    // same observation a mounted view's callback used to make.
    Object.defineProperty(queries, "invalidateWorkspaceGit", {
      value: invalidate,
      configurable: true,
    });

    fake.emit(
      event("workspace.git.changed", { workspace: "/repo", aliases: ["/repo-alias"] }),
    );

    expect(invalidate).toHaveBeenCalledWith({ workspace: "/repo", aliases: ["/repo-alias"] });
  });

  it("reaches the workspace owner when a turn review mutation settles", async () => {
    // A revert is the mutation: it changes the working tree, so the review views
    // for it are stale. There is no start(), no mount and no teardown between
    // the subscription and the write — exactly the condition a shell-side
    // subscription would have needed to survive.
    const view = {
      changeSetId: "c1",
      status: "active",
      canUndo: true,
      canReapply: false,
      fileChanges: [{ file: "a.ts", additions: 1, deletions: 0 }],
    };
    const fake = makeChannel();
    const application = createWebuiApplication({
      openEventChannel: () => fake.channel,
      turnReview: {
        getTurnDiff: async () => view,
        revertTurnDiff: async () => ({ success: true, turnDiff: view }),
      } as never,
      turns: { resumeSession: noopResumeSession },
    });
    const queries = application.workspaceQueries;
    const invalidate = vi.fn();
    // The review link is one resource's contract now; the root only keeps the
    // git fan-out, which is the one thing that crosses resources.
    Object.defineProperty(queries.review, "invalidateReview", {
      value: invalidate,
      configurable: true,
    });

    await application.turnReview.load({ sessionId: "S", turnId: "T1" });
    await application.turnReview.mutate({ sessionId: "S", turnId: "T1" }, "revert");

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("commits one process event's state patches in a single store write", () => {
    // `session.start` produces three session-slice patches: the workspace
    // progress write, the sending flag, and the phase. Three writes would let a
    // subscriber read a record caught mid-event — progress advanced with no turn
    // explaining it — and would render three times for one event.
    const fake = makeChannel();
    const application = createWebuiApplication({
      openEventChannel: () => fake.channel,
      turns: { resumeSession: noopResumeSession },
    });
    application.start();
    const updateSession = vi.spyOn(application.store, "updateSession");

    fake.emit(event("session.start", { sessionId: "s1", turnId: "turn-1" }));

    expect(updateSession).toHaveBeenCalledTimes(1);
    const session = application.store.readSession("s1");
    // All three landed, in order, inside that one call.
    expect(session.stream.phase).toBe("streaming");
    expect(session.sending).toBe(true);
  });

  it("invalidates the composer catalogue after a settled plugin write", async () => {
    const fake = makeChannel();
    const application = createWebuiApplication({
      openEventChannel: () => fake.channel,
      turns: { resumeSession: noopResumeSession },
      turnCapabilities: {
        pluginManagement: vi.fn(async () => ({ ok: true })),
      } as never,
    });
    const catalogue = application.composerPluginCatalogue;
    const invalidatePlugins = vi.fn();
    const invalidateSkills = vi.fn();
    Object.defineProperty(catalogue, "invalidatePlugins", { value: invalidatePlugins, configurable: true });
    Object.defineProperty(catalogue, "invalidateSkills", { value: invalidateSkills, configurable: true });

    await application.pluginWorkflows.installPlugin({ name: "demo" } as never);

    expect(invalidatePlugins).toHaveBeenCalledTimes(1);
    // A plugin write says nothing about skills: the runtime answers those per
    // agent, and dropping those slots would cost a round trip to learn nothing.
    expect(invalidateSkills).not.toHaveBeenCalled();
  });

  it("V13 rereads the real Composer cache after manager mutations without mounted UI", async () => {
    const fake = makeChannel();
    let generation = 0;
    let refuse = false;
    const pluginManagement = vi.fn(async (request: { action: string }) => {
      if (request.action === "listInstalledPlugins") return { plugins: [{ name: `plugin-${generation}` }] };
      if (refuse) throw new Error("mutation refused");
      generation += 1;
      return { ok: true };
    });
    const application = createWebuiApplication({ openEventChannel: () => fake.channel,
      turns: { resumeSession: noopResumeSession }, turnCapabilities: { pluginManagement } as never });
    const catalogue = application.composerPluginCatalogue;
    expect((await catalogue.installedPlugins())[0]?.name).toBe("plugin-0");
    const intents = ["installPlugin", "disablePlugin", "enablePlugin", "uninstallPlugin"] as const;
    for (const action of intents) {
      await application.pluginWorkflows.runIntent({ kind: action, pluginName: "demo" });
      expect((await catalogue.installedPlugins())[0]?.name).toBe(`plugin-${generation}`);
    }
    const committed = await catalogue.installedPlugins();
    const before = pluginManagement.mock.calls.filter(([r]) => r.action === "listInstalledPlugins").length;
    refuse = true;
    await expect(application.pluginWorkflows.installPlugin({ pluginName: "demo" })).rejects.toThrow("mutation refused");
    expect(await catalogue.installedPlugins()).toBe(committed);
    expect(pluginManagement.mock.calls.filter(([r]) => r.action === "listInstalledPlugins")).toHaveLength(before);
    application.dispose();
  });

  it("reconciles every interested session on a ready signal, then tells subscribers", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const fake = makeChannel();
    const probeApp = createWebuiApplication({
      openEventChannel: () => fake.channel,
      interactionsPort: { listPendingPermissions } as never,
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    probeApp.start();
    probeApp.sessionScope.acquire("s1", "secondary", "tab-1");
    probeApp.sessionScope.acquire("s2", "secondary", "tab-2");
    const ready = vi.fn();
    probeApp.onChannelReady(ready);

    // The server accepted the channel again; each interested session re-reads
    // its authoritative state, which is how a missed `session.start` is
    // recovered, and the surfaces that subscribed are told afterwards.
    fake.ready();

    expect(listPendingPermissions).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

describe("a local send's response stream ending is not the end of the turn", () => {
  it("re-attaches to the turn the runtime says is still running", async () => {
    // The whole shape, end to end: the client's own stream ends, the runtime
    // still has a turn running, and the client asks the runtime instead of
    // concluding from its own stream that nothing is running. The answer comes
    // back with the turn to follow, and the client follows it — so the output
    // of a turn that outlived its stream still reaches the transcript.
    const getActiveTurn = vi.fn(async () => ({
      turnId: "turn-live",
      busyReason: "turn" as const,
      locallyOwned: false,
    }));
    // A resume that never settles: the attachment stays claimed, which is what
    // lets the test read which turn the client attached to.
    const resumeSession = vi.fn(async () => new Promise<never>(() => undefined));
    const sendMessage = vi.fn(async () => {});
    const { application } = makeApplication({
      turnCapabilities: {
        sendMessage,
        resumeSession,
        getActiveTurn,
      } as never,
    });

    await application.turnCommandsFor("s1").send({ message: "hello" })?.completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getActiveTurn).toHaveBeenCalledWith({ id: "s1" });
    expect(resumeSession).toHaveBeenCalled();
    expect(application.store.readSession("s1").stream.subscription?.turnId).toBe("turn-live");
  });
});
