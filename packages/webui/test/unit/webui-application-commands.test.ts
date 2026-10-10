// Unit tests for ticket #45 prerequisite 2: the composer's send/queue/attach
// commands and the unread controller, both now application-owned, plus the
// deduplicated active-turn probe they share.
//
// The suite drives the application modules directly (the webui suite has no DOM
// and the layer is not yet wired into the live process-event ingress), pinning
// the properties the moves had to preserve: one probe per concurrent
// same-session request, the queue branch's draft-clear/refusal behaviour, the
// attach/recheck/gap-recovery decisions, and the unread persistence shape.

import { describe, expect, it, vi } from "vitest";

import { createWebuiActiveTurnProbe, webuiActiveTurnProbeFor } from "../../src/client/application/active-turn-probe.js";
import {
  createWebuiUnreadController,
  type WebuiUnreadStore,
} from "../../src/client/application/unread.js";
import { queueWebuiTurn } from "../../src/client/application/queue-command.js";
import {
  recoverMissedWebuiTurn,
  recheckWebuiSubscription,
  sendWebuiTurn,
} from "../../src/client/application/turn-commands.js";
import { initialWebuiStreamState } from "../../src/client/projection/stream-state.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiTranscriptHistoryOwner } from "../../src/client/application/transcript-history.js";
import type { WebuiClientMessagePage } from "../../src/client/contracts/message-view.js";
import type { WebuiSessionActivityMap } from "../../src/client/projection/session-activity.js";
import type { WebuiActiveTurn } from "../../src/shared/contracts/session.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("application-owned transcript history", () => {
  it("commits into the session entity and fences a late result after switching sessions", async () => {
    let resolveA: (page: WebuiClientMessagePage) => void = () => {};
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      store,
      loadMessages: vi.fn(
        ({ id }: { readonly id: string; readonly before?: string }): Promise<WebuiClientMessagePage> =>
          id === "A"
            ? new Promise((resolve) => { resolveA = resolve; })
            : Promise.resolve({ messages: [{ msgId: "B-message" }] }),
      ),
    });
    const loadA = owner.loadPage("A");
    const loadB = owner.loadPage("B");
    await loadB;
    resolveA({ messages: [{ msgId: "A-late" }] });
    await loadA;

    expect(store.readSession("B").transcript.page.messages?.map((message) => message.msgId))
      .toEqual(["B-message"]);
    expect(store.readSession("A").transcript.page.messages).toBeUndefined();
  });
});

function runtimeEvent(
  type: string,
  payload: Record<string, unknown>,
): WebuiRuntimeEvent {
  return { type, payload, timestamp: 1, source: "test" };
}

describe("the deduplicated active-turn probe", () => {
  it("coalesces concurrent same-session requests into one round trip", async () => {
    let resolveProbe: (value: WebuiActiveTurn | undefined) => void = () => {};
    const getActiveTurn = vi.fn(
      () => new Promise<WebuiActiveTurn | undefined>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const probe = createWebuiActiveTurnProbe(getActiveTurn);

    const first = probe.probe("s1");
    const second = probe.probe("s1");
    expect(getActiveTurn).toHaveBeenCalledTimes(1);

    resolveProbe({ turnId: "t1", busyReason: "turn", locallyOwned: false });
    expect(await first).toEqual({ turnId: "t1", busyReason: "turn", locallyOwned: false });
    expect(await second).toBe(await first);
  });

  it("probes each session independently and re-probes once settled", async () => {
    const getActiveTurn = vi.fn(async () => undefined);
    const probe = createWebuiActiveTurnProbe(getActiveTurn);

    await Promise.all([probe.probe("s1"), probe.probe("s2")]);
    expect(getActiveTurn).toHaveBeenCalledTimes(2);
    // A later call is a fresh request, not the settled one.
    await probe.probe("s1");
    expect(getActiveTurn).toHaveBeenCalledTimes(3);
  });

  it("shares one probe per transport function, and none without one", () => {
    const getActiveTurn = async () => undefined;
    expect(webuiActiveTurnProbeFor(getActiveTurn)).toBe(webuiActiveTurnProbeFor(getActiveTurn));
    expect(webuiActiveTurnProbeFor(undefined)).toBeUndefined();
  });
});

describe("the unread controller command surface", () => {
  function makeStore(initial: WebuiSessionActivityMap): {
    readonly store: WebuiUnreadStore;
    readonly read: () => WebuiSessionActivityMap;
  } {
    let activity = initial;
    const listeners = new Set<() => void>();
    return {
      store: {
        getSnapshot: () => ({ activity }),
        updateActivity: (fn) => {
          activity = fn(activity);
          for (const listener of [...listeners]) listener();
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      read: () => activity,
    };
  }

  it("seeds first-paint times and marks a session read", () => {
    const { store, read } = makeStore({ s1: { lastActivityAt: 0, unread: 3 } });
    const controller = createWebuiUnreadController({ store });
    controller.seed([{ sessionId: "s1", updatedAt: 5_000 }] as never);
    expect(read().s1?.lastActivityAt).toBe(5_000);
    expect(read().s1?.unread).toBe(3);

    controller.markRead("s1");
    expect(read().s1?.unread).toBeUndefined();
  });

  it("hydrates stored counts as a floor, excluding the open session", () => {
    const { store, read } = makeStore({
      s1: { lastActivityAt: 0 },
      s2: { lastActivityAt: 0, unread: 5 },
    });
    const controller = createWebuiUnreadController({
      store,
      read: () => ({ s1: 2, s2: 3 }),
    });
    expect(controller.isHydrated()).toBe(false);
    controller.hydrate("s2");
    expect(controller.isHydrated()).toBe(true);
    expect(read().s1?.unread).toBe(2);
    // The open session keeps its live count; the lower stored one is ignored.
    expect(read().s2?.unread).toBe(5);
  });

  it("persists only the positive counts, and only once hydrated", () => {
    const write = vi.fn();
    const { store } = makeStore({
      s1: { lastActivityAt: 0, unread: 2 },
      s2: { lastActivityAt: 0, unread: 0 },
      s3: { lastActivityAt: 0 },
    });
    const controller = createWebuiUnreadController({ store, write });
    // The gate: an un-hydrated writer is silent, so the empty map cannot land.
    controller.persist();
    expect(write).not.toHaveBeenCalled();
    controller.hydrate(undefined);
    expect(write).toHaveBeenCalledWith({ s1: 2 });
  });

  it("refuses a counted event until hydration, then accepts it", () => {
    const { store, read } = makeStore({});
    const controller = createWebuiUnreadController({ store });
    controller.recordEvent(
      runtimeEvent("session.start", { sessionId: "s1", turnId: "t1" }),
      undefined,
    );
    expect(read()).toEqual({});
    controller.hydrate(undefined);
    controller.recordEvent(
      runtimeEvent("session.start", { sessionId: "s1", turnId: "t1" }),
      undefined,
    );
    expect(read().s1?.busy?.turnId).toBe("t1");
  });

  it("probes every visible session and drops answers after cancel", async () => {
    const probe = vi.fn(async (sessionId: string) => ({
      turnId: `t-${sessionId}`,
      busyReason: "turn" as const,
      locallyOwned: false,
    }));
    const { store } = makeStore({});
    const cancel = createWebuiUnreadController({ store }).probeActiveTurns({
      sessions: [{ sessionId: "s1" }, { sessionId: "s2" }],
      probe: { probe },
      now: () => 1,
    });
    cancel();
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    // Cancelled before any answer landed, so the store stayed empty.
    expect(store.getSnapshot().activity).toEqual({});
  });
});

describe("the queue command", () => {
  it("enqueues, clears the draft and refreshes the panel", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const onDraftChange = vi.fn();
    const onQueued = vi.fn();
    await queueWebuiTurn({
      sessionId: "s1",
      message: "hello",
      enqueueMessage,
      onDraftChange,
      onQueued,
      setRefusal: vi.fn(),
    });
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "hello" });
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(onQueued).toHaveBeenCalled();
  });

  it("surfaces a failed enqueue as a refusal", async () => {
    const setRefusal = vi.fn();
    await queueWebuiTurn({
      sessionId: "s1",
      message: "hello",
      enqueueMessage: vi.fn(async () => {
        throw new Error("queue refused");
      }),
      onDraftChange: vi.fn(),
      setRefusal,
    });
    expect(setRefusal).toHaveBeenCalledWith("queue refused");
  });

  it("is a no-op without an enqueuer", async () => {
    const onDraftChange = vi.fn();
    await queueWebuiTurn({ sessionId: "s1", message: "x", onDraftChange, setRefusal: vi.fn() });
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});

describe("the send command", () => {
  it("routes to the queue when a turn is already in flight", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const onDraftChange = vi.fn();
    const writer = { kind: "session" as const, updateStream: vi.fn(), setTurnSending: vi.fn() };
    await sendWebuiTurn({
      sessionId: "s1",
      message: "queued",
      sending: true,
      handlers: { setStream: vi.fn(), setSending: vi.fn(), onDraftChange },
      deps: { sendMessage: vi.fn() },
      enqueueMessage,
      createWriter: () => writer,
    });
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "queued" });
    expect(writer.setTurnSending).not.toHaveBeenCalled();
  });
});

describe("attach, recheck and gap recovery", () => {
  const busy = { turnId: "t-new", busyReason: "turn" as const, locallyOwned: false };

  it("attaches to the running turn when no lease is held", async () => {
    const attach = vi.fn();
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => initialWebuiStreamState,
      attach,
    });
    await flush();
    expect(attach).toHaveBeenCalledWith("t-new");
  });

  it("does not attach when the active turn is a compaction", async () => {
    const attach = vi.fn();
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => ({ turnId: "t-c", busyReason: "compaction", locallyOwned: false }),
      readStream: () => initialWebuiStreamState,
      attach,
    });
    await flush();
    expect(attach).not.toHaveBeenCalled();
  });

  it("recheck retargets a stale lease onto the running turn", async () => {
    const stream = {
      ...initialWebuiStreamState,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-old" },
    };
    const setStream = vi.fn();
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => stream,
      setStream,
      attach,
    });
    await flush();
    expect(setStream).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith("t-new");
  });

  it("recheck holds when the active turn is the lease we already hold", async () => {
    const stream = {
      ...initialWebuiStreamState,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-new" },
    };
    const setStream = vi.fn();
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => stream,
      setStream,
      attach,
    });
    await flush();
    expect(setStream).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
});
