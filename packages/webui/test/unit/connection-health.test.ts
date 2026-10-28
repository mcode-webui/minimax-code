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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expireWebuiEventWatcherGrace,
  isWebuiEventChannelDegraded,
  markWebuiEventWatcherDown,
  markWebuiEventWatcherHealthy,
  registerWebuiEventWatcher,
  subscribeWebuiConnectionHealth,
  unregisterWebuiEventWatcher,
} from "../../src/client/platform/connection-health.js";
import { createWebuiTransport } from "../../src/client/platform/transport.js";

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

describe("the startup grace on a never-accepted watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a booting watcher unknown until the grace runs out, then degrades", () => {
    // The gap this closes: "unknown" used to last forever, so a host that was
    // already unreachable when the page loaded read as connected until
    // something else moved (the stream phase stays idle between turns).
    register();
    vi.advanceTimersByTime(29_000);
    expect(isWebuiEventChannelDegraded()).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(isWebuiEventChannelDegraded()).toBe(true);
  });

  it("stays unknown for good once the server accepts the watcher", () => {
    // The ordinary boot: accepted in milliseconds, and the cancelled grace
    // never fires — a healthy channel must not degrade on a timer later.
    const token = register();
    markWebuiEventWatcherHealthy(token);
    vi.advanceTimersByTime(120_000);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("an acceptance after the grace still clears the flag", () => {
    // A slow-but-alive backend: the grace fired while the socket was still
    // opening, and the acceptance that arrives afterwards must restore the
    // channel rather than leave it degraded for the page's lifetime.
    const token = register();
    vi.advanceTimersByTime(30_000);
    expect(isWebuiEventChannelDegraded()).toBe(true);
    markWebuiEventWatcherHealthy(token);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("expires the grace even when the socket keeps closing and retrying", () => {
    // The unreachable-host shape end to end: the connect fails, the
    // transport's close handler marks the watcher down and retries. None of
    // that is an acceptance, so the grace still runs out — the state that
    // used to stay silent.
    const token = register();
    markWebuiEventWatcherDown(token);
    vi.advanceTimersByTime(30_000);
    expect(isWebuiEventChannelDegraded()).toBe(true);
  });

  it("does not degrade a healthy channel because one watcher is slow", () => {
    // Several watchers can be mounted (the shell's plus the workspace
    // panels'). A healthy shell with one slow panel still HAS a live link,
    // so the channel is not degraded — the deadline only speaks when no
    // watcher is healthy at all.
    const shell = register();
    const panel = register();
    markWebuiEventWatcherHealthy(shell);
    vi.advanceTimersByTime(60_000);
    expect(isWebuiEventChannelDegraded()).toBe(false);
    // …and once the slow panel is accepted too, still healthy.
    markWebuiEventWatcherHealthy(panel);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("a watcher that held a link and lost it still degrades the channel", () => {
    // The upstream rule, unchanged by this work: a once-healthy watcher going
    // down degrades the channel even while another watcher is healthy. The
    // grace is a separate rule (nobody was ever healthy) and does not relax
    // this one — recorded here so the two are not confused.
    const shell = register();
    const panel = register();
    markWebuiEventWatcherHealthy(shell);
    markWebuiEventWatcherHealthy(panel);
    markWebuiEventWatcherDown(panel);
    expect(isWebuiEventChannelDegraded()).toBe(true);
  });
});

describe("ending the grace ahead of the timer", () => {
  // `expireWebuiEventWatcherGrace` is the channel's fatal path: a fatal
  // rejection that arrives before the first acceptance has already decided
  // the link will never come up, so the 30 s of silence the grace would add
  // on top is not caution, it is a lie of omission. The three cases pin the
  // exact, unchanged aggregation semantics: immediate for the unaccepted
  // lone watcher, silent while any live link exists, and a true no-op for a
  // watcher that was already accepted.

  it("degrades an unaccepted watcher at once, without waiting out the timer", () => {
    const token = register();
    expect(isWebuiEventChannelDegraded()).toBe(false);
    expireWebuiEventWatcherGrace(token);
    expect(isWebuiEventChannelDegraded()).toBe(true);
  });

  it("does not degrade a channel that still holds a live link", () => {
    const shell = register();
    const panel = register();
    markWebuiEventWatcherHealthy(shell);
    expireWebuiEventWatcherGrace(panel);
    // Rule 2 only speaks when no watcher is healthy: a healthy shell with a
    // panel that will never come up is a channel with a live link.
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("is a pure no-op for a watcher that was already accepted", () => {
    const token = register();
    markWebuiEventWatcherHealthy(token);
    const listener = vi.fn();
    const detach = subscribeWebuiConnectionHealth(listener);
    try {
      expireWebuiEventWatcherGrace(token);
      expect(isWebuiEventChannelDegraded()).toBe(false);
      // No-op means no-op: not one listener fires.
      expect(listener).not.toHaveBeenCalled();
    } finally {
      // The listener set is module-level like the store; leave nothing
      // behind for later suites in this worker.
      detach();
    }
  });
});

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
});

describe("V23 · a manual reconnect does not outlive the client that asked for it", () => {
  it("opens no new socket once the channel has been released", async () => {
    // The 250ms reconnect is a timer this client scheduled. Disposing the
    // application must cancel it: a socket opening after the client is gone is
    // a request against a disposed application, and nothing would ever close it.
    const { transport, sockets } = watchEventsHarness();
    const unsubscribe = transport.watchEvents(() => undefined, () => undefined);
    accept(sockets[0]!);

    sockets[0]!.close();
    // The reconnect is now pending.
    unsubscribe();

    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(sockets).toHaveLength(1);
  });

  it("leaves no degradation behind for a client that released the channel", () => {
    const { transport, sockets } = watchEventsHarness();
    const unsubscribe = transport.watchEvents(() => undefined);
    accept(sockets[0]!);
    sockets[0]!.close();
    expect(isWebuiEventChannelDegraded()).toBe(true);

    unsubscribe();

    // The socket is dead and will not be reopened, so the client must not keep
    // reporting a degraded channel it is no longer listening on.
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
