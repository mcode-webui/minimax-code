// Unit tests for the event-channel health store and the transport's
// reporting into it.
//
// Q-b's defect, reproduced first against the built client: while the page is
// idle (no turn running), killing every socket and gating new ones produced
// NO visible signal at all — the connection banner reads the session
// stream's phase, which stays `idle` ("connected") between turns, and the
// transport's 250ms silent reconnect loop told nobody. The watcher socket is
// the only long-lived link in that state, so its health is the signal.
//
// Two layers here:
//   * the store's aggregation rule — degraded means "lost a link it
//     previously held"; a never-accepted watcher is unknown, not degraded,
//     so a booting page never flashes a reconnecting banner;
//   * the transport wiring — `watchEvents` registers, marks healthy on the
//     server's acceptance, marks down on socket close, and unregisters on
//     unsubscribe, so every current and future watcher counts without its
//     call site changing.
//
// The store is module-level (the runtime-store precedent), so every case
// unregisters in `afterEach` — a leaked once-healthy watcher would degrade
// every later suite in this worker.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isWebuiEventChannelDegraded,
  markWebuiEventWatcherDown,
  markWebuiEventWatcherHealthy,
  registerWebuiEventWatcher,
  unregisterWebuiEventWatcher,
} from "../../src/client/connection-health.js";
import { createWebuiTransport } from "../../src/client/transport.js";

const tracked: number[] = [];

function register(): number {
  const token = registerWebuiEventWatcher();
  tracked.push(token);
  return token;
}

afterEach(() => {
  for (const token of tracked.splice(0)) unregisterWebuiEventWatcher(token);
  expect(isWebuiEventChannelDegraded()).toBe(false);
});

describe("the watcher health store", () => {
  it("treats a never-accepted watcher as unknown, not degraded", () => {
    // Boot shape: the socket exists but the server has not answered yet.
    // Flagging this would flash 正在重连 on every page load.
    register();
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("degrades only after a healthy watcher goes down", () => {
    const token = register();
    markWebuiEventWatcherHealthy(token);
    expect(isWebuiEventChannelDegraded()).toBe(false);
    markWebuiEventWatcherDown(token);
    expect(isWebuiEventChannelDegraded()).toBe(true);
    markWebuiEventWatcherHealthy(token);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("aggregates: any once-healthy watcher down degrades the channel", () => {
    // The shell keeps one watcher from boot; the workspace panels open more.
    // One dying link is a degraded channel even while the others stream.
    const shell = register();
    const panel = register();
    markWebuiEventWatcherHealthy(shell);
    markWebuiEventWatcherHealthy(panel);
    markWebuiEventWatcherDown(panel);
    expect(isWebuiEventChannelDegraded()).toBe(true);
    markWebuiEventWatcherHealthy(panel);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("unregistering a down watcher stops it from counting", () => {
    // A panel unmounting its watcher mid-outage must not pin the channel
    // degraded forever — the shell's link is the one that matters.
    const shell = register();
    const panel = register();
    markWebuiEventWatcherHealthy(shell);
    markWebuiEventWatcherHealthy(panel);
    markWebuiEventWatcherDown(panel);
    expect(isWebuiEventChannelDegraded()).toBe(true);
    unregisterWebuiEventWatcher(panel);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("marks on unknown tokens are ignored", () => {
    markWebuiEventWatcherHealthy(999_999);
    markWebuiEventWatcherDown(999_999);
    unregisterWebuiEventWatcher(999_999);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });
});

/** Minimal WebuiSocket double: enough open/message/close/error for watchEvents. */
class FakeSocket {
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly sent: string[] = [];
  closed = false;

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: "open" | "message" | "error" | "close", event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

function watchEventsHarness() {
  const sockets: FakeSocket[] = [];
  class Socket extends FakeSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const transport = createWebuiTransport({
    websocketUrl: "ws://harness.invalid",
    token: "t",
    webSocket: Socket as unknown as new (url: string) => FakeSocket,
  });
  return { transport, sockets };
}

/** Drives one watcher socket through acceptance. */
function accept(socket: FakeSocket): void {
  socket.emit("open");
  const request = JSON.parse(socket.sent[0] ?? "{}") as { requestId?: string };
  socket.emit("message", {
    data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: request.requestId, body: { ok: true } }),
  });
}

describe("the transport's watcher reporting", () => {
  it("marks healthy on the server's acceptance and down on socket close", () => {
    const { transport, sockets } = watchEventsHarness();
    const unsubscribe = transport.watchEvents(() => undefined);
    expect(isWebuiEventChannelDegraded()).toBe(false);

    const socket = sockets[0]!;
    accept(socket);
    expect(isWebuiEventChannelDegraded()).toBe(false);

    socket.close();
    expect(isWebuiEventChannelDegraded()).toBe(true);
    unsubscribe();
  });

  it("clears the degradation when the reconnect is accepted", async () => {
    const { transport, sockets } = watchEventsHarness();
    const onReconnect = vi.fn();
    const unsubscribe = transport.watchEvents(() => undefined, onReconnect);
    accept(sockets[0]!);
    sockets[0]!.close();
    expect(isWebuiEventChannelDegraded()).toBe(true);

    // The 250ms reconnect timer opens a fresh socket; accepting it restores
    // the channel. Advance the timer by waiting it out for real — the delay
    // is short, and fake timers would also have to drive the microtasks the
    // acceptance path relies on.
    await new Promise((resolve) => setTimeout(resolve, 320));
    const reopened = sockets.at(-1)!;
    expect(reopened).not.toBe(sockets[0]!);
    accept(reopened);
    expect(isWebuiEventChannelDegraded()).toBe(false);
    // onReconnect fires per acceptance — the first ack plus this one.
    expect(onReconnect).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("unsubscribing unregisters the watcher", () => {
    const { transport, sockets } = watchEventsHarness();
    const unsubscribe = transport.watchEvents(() => undefined);
    accept(sockets[0]!);
    sockets[0]!.close();
    expect(isWebuiEventChannelDegraded()).toBe(true);
    unsubscribe();
    // The watcher no longer counts, so the channel is not degraded even
    // though its socket never came back before the unsubscribe.
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });
  it("marks the channel down on a FORCED reconnect, not only on a guarded close", () => {
    // The defect: `reconnectWhenAvailable` (tab back into view, network back)
    // cleared `socket` and then called `previous.close()`. The close handler
    // guards on `socket !== ws`, which is therefore always true on that path,
    // so `markWebuiEventWatcherDown` was skipped and the banner read 已连接
    // for the whole reconnect window — the exact lie this watcher exists to
    // remove. Zero tests reached it: this file had no `dispatchEvent` at all.
    const online = new Map<string, () => void>();
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { document: globals.document, window: globals.window };
    globals.document = {
      visibilityState: "visible",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    globals.window = {
      addEventListener: (type: string, fn: () => void) => online.set(type, fn),
      removeEventListener: (type: string) => online.delete(type),
    };
    try {
      const { transport, sockets } = watchEventsHarness();
      const unsubscribe = transport.watchEvents(() => undefined);
      accept(sockets[0]!);
      expect(isWebuiEventChannelDegraded()).toBe(false);

      online.get("online")?.();

      expect(isWebuiEventChannelDegraded()).toBe(true);
      unsubscribe();
    } finally {
      globals.document = saved.document;
      globals.window = saved.window;
    }
  });
});
