// The conversation turn commands as a surface invokes them.
//
// The point of this seam is that a caller supplies intent and data and nothing
// else: no record key, no writer, no sink, no transports. These cases drive the
// factory headlessly — a store and a capability slice, no React — and assert the
// outcomes a surface can observe: which record the attempt was written to, that
// the lease was claimed, what reached the port, and that an absent capability
// refuses instead of pretending.

import { describe, expect, it, vi } from "vitest";

import { createWebuiConversationTurnCommands } from "../../src/client/features/turn/application/turn-commands.js";

/** The peer command factories the substrate drives, as composition supplies them. */
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiSessionScopeManager } from "../../src/client/conversation/session-scope.js";
import { createWebuiDeliveryDisposers } from "../../src/client/features/turn/application/delivery-disposers.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

/** A resume that never settles: the attachment's lease stays claimed. */
const openStream = () => new Promise<never>(() => undefined);

describe("the conversation turn commands", () => {
  it("claims the session's lease from an attachment without being given a writer or a key", () => {
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { resume: openStream as never },
    });

    commands.attach("t-1");

    // The record the attempt was written to is the session's, chosen by the
    // command: the caller named neither the key nor the sink.
    const record = store.readSession("s1");
    expect(record.sending).toBe(true);
    expect(record.stream.subscription).toBeDefined();
    expect(store.readSession(WEBUI_HOME_SESSION_KEY).stream.subscription).toBeUndefined();
  });

  it("attaches nothing without a session: the home slot is a send's, not an attachment's", () => {
    // An attachment follows a turn the server started, and a turn is named by a
    // session. The home slot exists for a first message that will create the
    // session it is sent to, so nothing claims its lease here.
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: undefined,
      capabilities: { resume: openStream as never },
    });

    commands.attach("t-home");

    expect(store.readSession(WEBUI_HOME_SESSION_KEY).sending).toBe(false);
    expect(store.readSession(WEBUI_HOME_SESSION_KEY).stream.subscription).toBeUndefined();
  });

  it("reaches the port with the session and writes the attempt to the session's record", async () => {
    const store = createWebuiSessionStore();
    const sendMessage = vi.fn(async (_request: unknown) => openStream());
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { send: sendMessage as never },
    });

    // The stream the send opens never settles, so the loop is still running when
    // the assertions below read the record — which is the state being asserted.
    void commands.send({
      message: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ id: "s1", content: "hello" });
    // The command chose the key and built the writer, so the attempt landed on
    // the session's record without the caller naming either.
    expect(store.readSession("s1").sending).toBe(true);
    expect(store.readSession("s1").stream.phase).toBe("streaming");
  });

  it("chooses queueing from the live store state rather than a caller snapshot", async () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);
    const enqueueMessage = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => openStream());
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { enqueue: enqueueMessage as never, send: sendMessage as never },
    });

    const ticket = commands.send({
      message: "queue from live state",
    });

    // The queue is chosen from the live store, not from what the caller passed.
    expect(ticket?.admission).toEqual({ kind: "queued" });
    await expect(ticket?.completion).resolves.toEqual({
      kind: "queued",
      sessionId: "s1",
      created: false,
      selected: false,
    });
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "queue from live state" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not pretend to run a send the slice cannot run", async () => {
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: {},
    });

    // The loop's own absent-capability guard decides; what this seam owes the
    // caller is that no attempt is started, nothing is reported as running, and
    // the transition says why rather than leaving it to be inferred.
    const refused = commands.send({
      message: "hello",
    });
    expect(refused?.admission).toEqual({ kind: "unsupported", missing: "transport" });
    await expect(refused?.completion).resolves.toMatchObject({
      kind: "unsupported",
      missing: "transport",
    });
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.readSession("s1").stream.phase).not.toBe("streaming");
  });

  it("stops through the slice's abort and settles the local record", async () => {
    const store = createWebuiSessionStore();
    const abortSession = vi.fn(async () => ({ success: true }));
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { stop: abortSession as never },
    });

    await commands.stop();

    expect(abortSession).toHaveBeenCalledWith({ id: "s1" });
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.readSession("s1").stream.phase).not.toBe("streaming");
  });

  it("does nothing when the slice has no stop", async () => {
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: {},
    });

    await expect(commands.stop()).resolves.toBeUndefined();
    expect(store.readSession("s1").sending).toBe(false);
  });

  it("does not require a capability slice at all", () => {
    // A host with nothing wired: the commands still exist and still refuse.
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
    });
    expect(() => commands.attach("t-1")).not.toThrow();
  });
});

describe("a first message on the home surface", () => {
  const createSession = async () => ({ sessionId: "s-created" });

  it("clears the sending flag on the session the message created", async () => {
    // The first message has no session yet, so the turn creates one and its
    // record moves onto it. The flag the composer renders from lives on that
    // record, and the turn's own cleanup has to read it there: a reader still
    // looking at the home slot would decide the turn no longer owns the
    // stream, skip the cleanup, and leave the send button as a stop button —
    // which swallows the next message into the queue.
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: undefined,
      capabilities: {
        createSession: createSession as never,
        send: (async (
          _request: unknown,
          onFrame: (frame: WebuiStreamFrame) => void,
        ) => {
          onFrame({
            cursor: "c1",
            dataJson: JSON.stringify({
              type: 2,
              agent_message: { msg_id: "m1", msg_content: "hi" },
            }),
          });
          onFrame({ cursor: "c2", dataJson: "[DONE]" });
        }) as never,
      },
      taskSessions: {
        creationPending: () => false,
        submit: async () => {
          // The creation moves the home record onto the session it created,
          // so the home slot is empty by the time the turn settles.
          store.transferSession(WEBUI_HOME_SESSION_KEY, "s-created", {
            expectSourceIncarnation: store.readHomeIncarnation(),
          });
          return {
            kind: "created" as const,
            sessionId: "s-created",
            selected: true,
          };
        },
      },
    });

    const ticket = commands.send({ message: "hello" });
    await ticket?.completion;

    expect(store.readSession("s-created").sending).toBe(false);
    expect(store.readSession("s-created").stream.phase).toBe("done");
  });

  it("sends the next message instead of queueing it", async () => {
    // The same defect, seen from the composer: a sending flag left standing
    // makes the next submission look like a turn that is already live, so it
    // is queued rather than sent.
    const store = createWebuiSessionStore();
    const enqueueMessage = vi.fn(async () => undefined);
    const sendMessage = vi.fn(
      async (
        _request: unknown,
        onFrame: (frame: WebuiStreamFrame) => void,
      ) => {
        onFrame({ cursor: "c1", dataJson: "[DONE]" });
      },
    );
    const capabilities = {
      createSession: createSession as never,
      send: sendMessage as never,
      enqueue: enqueueMessage as never,
    };
    const taskSessions = {
      creationPending: () => false,
      submit: async () => ({
        kind: "created" as const,
        sessionId: "s-created",
        selected: true,
      }),
    };
    const home = createWebuiConversationTurnCommands({
      store,
      sessionId: undefined,
      capabilities,
      taskSessions,
    });

    await home.send({ message: "first" })?.completion;

    // The created session is the one the user is now in, so the next message
    // is sent from it.
    const inSession = createWebuiConversationTurnCommands({
      store,
      sessionId: "s-created",
      capabilities,
      taskSessions,
    });
    const second = inSession.send({ message: "second" });

    expect(second?.admission).toEqual({ kind: "dispatching" });
    await second?.completion;
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});

describe("recheck and gap recovery are the command set's, not the view's", () => {
  const busy = { turnId: "t-1", busyReason: "turn" as const, locallyOwned: false };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("recovers a turn the client never saw, on the session's record", async () => {
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { resume: openStream as never, activeTurn: (async () => busy) as never },
    });

    commands.recover();
    await tick();

    // The command chose the probe, the key and the sink: the attachment landed
    // on the session's record with the turn the server named.
    expect(store.readSession("s1").stream.subscription?.turnId).toBe("t-1");
    expect(store.readSession("s1").sending).toBe(true);
  });

  it("settles a stale lease when the authoritative recovery read finds no active turn", async () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({
      ...current,
      sending: true,
      stream: {
        ...current.stream,
        phase: "streaming",
        lastClaimedGeneration: 7,
        subscription: { owner: "recovered", generation: 7, turnId: "t-old" },
      },
    }));
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { activeTurn: (async () => undefined) as never },
    });

    commands.recover();
    await tick();

    expect(store.readSession("s1").stream.phase).toBe("idle");
    expect(store.readSession("s1").stream.subscription).toBeUndefined();
    expect(store.readSession("s1").stream.lastClaimedGeneration).toBeUndefined();
    expect(store.readSession("s1").sending).toBe(false);
  });

  it("shares one probe across recovery calls in the same round trip", async () => {
    const store = createWebuiSessionStore();
    const getActiveTurn = vi.fn(async () => busy);
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { resume: openStream as never, activeTurn: getActiveTurn as never },
    });

    // Two callers, one session, one round trip: the probe is the transport's
    // shared one, not a second one built here.
    commands.recover();
    commands.recover();
    await tick();

    expect(getActiveTurn).toHaveBeenCalledTimes(1);
  });

  it("retargets a lease a session.start no longer matches", async () => {
    const store = createWebuiSessionStore();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: {
        resume: openStream as never,
        activeTurn: (async () => ({ ...busy, turnId: "t-new" })) as never,
      },
    });

    commands.attach("t-old");
    expect(store.readSession("s1").stream.subscription?.turnId).toBe("t-old");

    commands.recheck("t-new");
    await tick();

    // The stale lease was released (scoped to its generation) and the live turn
    // attached in its place.
    expect(store.readSession("s1").stream.subscription?.turnId).toBe("t-new");
  });
});

describe("a response stream that ends is not the end of the turn", () => {
  /** A send whose own stream ends immediately: the runtime closed it. */
  const endTheStream = async (
    _request: unknown,
    onFrame: (frame: WebuiStreamFrame) => void,
  ): Promise<void> => {
    onFrame({ cursor: "c1", dataJson: "[DONE]" });
  };

  it("asks the owner to reconcile the session the send landed on", async () => {
    // The client's own stream ending says the runtime closed it — not that it
    // finished the turn. The runtime may have closed the stream early, or the
    // queue may have moved on to the next turn while this one was ending, and
    // only the runtime's active-turn read says which is true. So the send hands
    // the session to the owner, which asks that read and re-attaches to
    // whatever is still running.
    const store = createWebuiSessionStore();
    const reconcileTurn = vi.fn();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { send: endTheStream as never },
      reconcileTurn,
    });

    await commands.send({ message: "hello" })?.completion;

    expect(reconcileTurn).toHaveBeenCalledWith("s1");
  });

  it("reconciles the session a first message created, not the home slot", async () => {
    // The turn landed on the session the first message created, so that is the
    // session whose turn may still be running — and the home slot is no longer
    // where the turn is.
    const store = createWebuiSessionStore();
    const reconcileTurn = vi.fn();
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: undefined,
      capabilities: {
        createSession: (async () => ({ sessionId: "s-created" })) as never,
        send: endTheStream as never,
      },
      taskSessions: {
        creationPending: () => false,
        submit: async () => {
          store.transferSession(WEBUI_HOME_SESSION_KEY, "s-created", {
            expectSourceIncarnation: store.readHomeIncarnation(),
          });
          return { kind: "created" as const, sessionId: "s-created", selected: true };
        },
      },
      reconcileTurn,
    });

    await commands.send({ message: "hello" })?.completion;

    expect(reconcileTurn).toHaveBeenCalledWith("s-created");
  });

  it("does not reconcile a queued submission: it had no stream of its own to end", async () => {
    // A queued submission joined somebody else's turn. Its own stream never
    // opened, so there is no stream of its own that ended — and the turn it
    // joined is somebody else's stream, which the queue's own events speak for.
    const store = createWebuiSessionStore();
    const reconcileTurn = vi.fn();
    const enqueueMessage = vi.fn(async () => undefined);
    store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { enqueue: enqueueMessage as never },
      reconcileTurn,
    });

    await commands.send({ message: "queued" })?.completion;

    expect(reconcileTurn).not.toHaveBeenCalled();
  });
});

describe("an accepted attempt leases its session", () => {
  it("keeps the session interesting across a navigation and releases it when the attempt settles", async () => {
    const store = createWebuiSessionStore();
    const scope = createWebuiSessionScopeManager();
    const deliveries = createWebuiDeliveryDisposers();
    let settle!: () => void;
    const send = vi.fn(
      async (
        _body: unknown,
        _onFrame: unknown,
        onDelivery?: (handle: { close: () => void }) => void,
      ) => {
        onDelivery?.({ close: () => undefined });
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    );
    const commands = createWebuiConversationTurnCommands({
      store,
      sessionId: "s1",
      capabilities: { send: send as never },
      deliveries,
      scope,
    });

    void commands.send({
      message: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The attempt holds a delivery lease, and its real disposer is registered.
    expect(scope.kinds("s1")).toContain("delivery");
    expect(deliveries.count("s1")).toBe(1);

    // Navigating away must not release a session that still owes a turn.
    scope.select("s2");
    expect(scope.isInterested("s1")).toBe(true);
    expect(scope.mayEvict("s1")).toBe(false);

    // The attempt ends on its own: the lease and the registration end with it.
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scope.isInterested("s1")).toBe(false);
    expect(scope.mayEvict("s1")).toBe(true);
    expect(deliveries.count()).toBe(0);
  });
});
