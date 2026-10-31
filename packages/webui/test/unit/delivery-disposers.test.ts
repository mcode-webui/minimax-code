// The delivery disposers.
//
// Two halves, and the split is deliberate. The registry's own rules
// are driven directly; the wiring is driven through the conversation commands and
// the application's public disposal, so what is asserted is that an attempt this
// client started is closable by the application — and that closing it is a
// *detach*, never a host abort.

import { describe, expect, it, vi } from "vitest";

import { createWebuiDeliveryDisposers, holdWebuiDelivery } from "../../src/client/features/turn/application/delivery-disposers.js";
import { createWebuiSessionScopeManager } from "../../src/client/conversation/session-scope.js";
import { createWebuiConversationTurnCommands } from "../../src/client/features/turn/application/turn-commands.js";
import { createWebuiApplication } from "../../src/client/application/create-application.js";
import type { WebuiClientSessionResumer } from "../../src/client/features/turn/contracts/execution-port.js";

function handle() {
  const closed = vi.fn();
  return { closed, handle: { close: closed } };
}

describe("the delivery disposers", () => {
  it("V15 refuses a delivery handle that arrives after authoritative session purge", () => {
    const disposers = createWebuiDeliveryDisposers();
    const scope = createWebuiSessionScopeManager();
    const hold = holdWebuiDelivery(() => "deleted", disposers, scope);
    scope.purge("deleted");
    const late = handle();
    hold.onDelivery(late.handle);
    expect(late.closed).toHaveBeenCalledTimes(1);
    expect(disposers.count()).toBe(0);
    expect(scope.interested()).toEqual([]);
    hold.release(); scope.dispose(); disposers.closeAll();
  });
  it("tracks each attempt against its session and releases only its own", () => {
    const disposers = createWebuiDeliveryDisposers();
    const first = handle();
    const second = handle();

    const releaseFirst = disposers.track("s1", first.handle);
    disposers.track("s1", second.handle);
    expect(disposers.count("s1")).toBe(2);
    expect(disposers.count()).toBe(2);

    releaseFirst();
    expect(disposers.count("s1")).toBe(1);
    // Releasing twice is harmless: a loop's cleanup can race its own terminal.
    releaseFirst();
    expect(disposers.count("s1")).toBe(1);
    expect(first.closed).not.toHaveBeenCalled();
    expect(second.closed).not.toHaveBeenCalled();
  });

  it("closes one session's deliveries without touching another's", () => {
    const disposers = createWebuiDeliveryDisposers();
    const a = handle();
    const b = handle();
    disposers.track("s1", a.handle);
    disposers.track("s2", b.handle);

    disposers.closeSession("s1");

    expect(a.closed).toHaveBeenCalledTimes(1);
    expect(b.closed).not.toHaveBeenCalled();
    expect(disposers.count("s1")).toBe(0);
  });

  it("closes everything on disposal and accepts nothing afterwards", () => {
    const disposers = createWebuiDeliveryDisposers();
    const a = handle();
    const b = handle();
    disposers.track("s1", a.handle);
    disposers.track("s2", b.handle);

    disposers.closeAll();

    expect(a.closed).toHaveBeenCalledTimes(1);
    expect(b.closed).toHaveBeenCalledTimes(1);
    expect(disposers.count()).toBe(0);
    expect(disposers.isDisposed()).toBe(true);
    const late = handle();
    disposers.track("s3", late.handle);
    expect(disposers.count()).toBe(0);
  });

  it("closes the rest when one delivery refuses to close", () => {
    // Disposal has to finish: one stubborn socket cannot strand the others.
    const disposers = createWebuiDeliveryDisposers();
    const broken = {
      close: () => {
        throw new Error("socket already gone");
      },
    };
    const good = handle();
    disposers.track("s1", broken);
    disposers.track("s1", good.handle);

    expect(() => disposers.closeSession("s1")).not.toThrow();
    expect(good.closed).toHaveBeenCalledTimes(1);
  });
});

describe("an attempt the client started is closable by the application", () => {
  it("registers the attempt's handle and closes it on disposal, without aborting the turn", async () => {
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: (async () => undefined) as unknown as WebuiClientSessionResumer },
    });
    app.start({ initialSessionId: "s1" });

    const closed = vi.fn();
    const abort = vi.fn(async () => ({ success: true }));
    // A transport that opens a delivery and hands up its disposer, exactly as
    // `platform/transport.ts` does.
    const send = vi.fn(
      async (
        _body: unknown,
        _onFrame: unknown,
        onDelivery?: (handle: { close: () => void }) => void,
      ) => {
        onDelivery?.({ close: closed });
        return new Promise<never>(() => undefined);
      },
    );
    const commands = createWebuiConversationTurnCommands({
      store: app.store,
      sessionId: "s1",
      capabilities: { send: send as never, stop: abort as never },
      deliveries: app.deliveries,
    });

    void commands.send({
      message: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.deliveries.count("s1")).toBe(1);

    app.dispose();

    // The client stopped observing…
    expect(closed).toHaveBeenCalledTimes(1);
    expect(app.deliveries.count()).toBe(0);
    // …and the host turn was never cancelled: disposal is not a stop.
    expect(abort).not.toHaveBeenCalled();
  });

  it("settles the attempt and clears its sending flag when the host finishes", async () => {
    // The control for the case below. Without it, "the attempt is still pending
    // after a detach" would be guaranteed by the transport that never settles
    // rather than by the detach: this is what completion actually looks like.
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: (async () => undefined) as unknown as WebuiClientSessionResumer },
    });
    app.start({ initialSessionId: "s1" });

    const abort = vi.fn(async () => ({ success: true }));
    const closed = vi.fn();
    const send = vi.fn(
      async (
        _body: unknown,
        onFrame: (frame: { dataJson: string }) => void,
        onDelivery?: (handle: { close: () => void }) => void,
      ) => {
        onDelivery?.({ close: closed });
        // The attempt holds its own delivery while it runs…
        expect(app.deliveries.count("s1")).toBe(1);
        onFrame({ dataJson: '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"hello"}}' });
        onFrame({ dataJson: "[DONE]" });
      },
    );
    const commands = createWebuiConversationTurnCommands({
      store: app.store,
      sessionId: "s1",
      capabilities: { send: send as never, stop: abort as never },
      deliveries: app.deliveries,
    });

    const ticket = commands.send({
      message: "hello",
    });

    await expect(ticket?.completion).resolves.toMatchObject({ kind: "dispatched" });
    // The submit-lifecycle flag came back down, and the attempt released its own
    // handle when it ended: that release is not a detach, so nothing was closed.
    expect(app.store.readSession("s1").sending).toBe(false);
    expect(app.deliveries.count("s1")).toBe(0);
    expect(closed).not.toHaveBeenCalled();
    app.dispose();
  });

  it("leaves the attempt unsettled and still owed when the observer detaches", async () => {
    // A detached observer is not evidence that host execution completed:
    // detaching closes this client's half of the delivery and does nothing
    // else, so against the control above the attempt must still be owed — no
    // completion, and the sending flag the loop clears on a real finish is
    // still set. A dispose path that marked the attempt complete would fail this
    // case.
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: (async () => undefined) as unknown as WebuiClientSessionResumer },
    });
    app.start({ initialSessionId: "s1" });

    const closed = vi.fn();
    const abort = vi.fn(async () => ({ success: true }));
    const send = vi.fn(
      async (
        _body: unknown,
        _onFrame: unknown,
        onDelivery?: (handle: { close: () => void }) => void,
      ) => {
        onDelivery?.({ close: closed });
        // The host keeps producing; this client's read never ends on its own.
        return new Promise<never>(() => undefined);
      },
    );
    const commands = createWebuiConversationTurnCommands({
      store: app.store,
      sessionId: "s1",
      capabilities: { send: send as never, stop: abort as never },
      deliveries: app.deliveries,
    });

    let outcome: "pending" | "settled" | "rejected" = "pending";
    // The ticket's completion never rejects, so there is no rejection arm here
    // that the caller could forget: a submission that failed settles as a value.
    void commands
      .send({ message: "hello" })
      ?.completion.then(() => {
        outcome = "settled";
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.deliveries.count("s1")).toBe(1);
    expect(app.store.readSession("s1").sending).toBe(true);

    app.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The client stopped observing…
    expect(closed).toHaveBeenCalledTimes(1);
    expect(app.deliveries.count("s1")).toBe(0);
    // …and that is all it did: the attempt is still owed, so nothing may report
    // the turn as finished, and the host was never cancelled.
    expect(outcome).toBe("pending");
    expect(app.store.readSession("s1").sending).toBe(true);
    expect(abort).not.toHaveBeenCalled();
  });
});
