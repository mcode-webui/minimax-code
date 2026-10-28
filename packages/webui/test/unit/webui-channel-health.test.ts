// The event channel's health: what counts as "not going to work", what counts as
// "try again", and what a fatal state means.
//
// These are the facts the plan states about the long-lived link (V26): a dropped
// connection retries with a bounded, jittered, exponentially growing delay; a
// **protocol or capability** rejection is fatal because retrying sends the same
// frame; and a code this build has never seen is transient, because an unfamiliar
// code is a newer server rather than a malformed one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWebuiEventChannel,
  isFatalWebuiChannelCode,
  WEBUI_CHANNEL_MAX_RETRY_MS,
  webuiChannelRetryDelayMs,
} from "../../src/client/platform/event-channel.js";
import { isWebuiEventChannelDegraded } from "../../src/client/platform/connection-health.js";
import { WebuiErrorCode, WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";

/** A socket that records what the channel wrote and lets a test drive it. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "open" | "message" | "error" | "close", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  /** The request id the channel generated for this connection. */
  get requestId(): string {
    const frame = JSON.parse(this.sent[0] ?? "{}") as { requestId?: string };
    return frame.requestId ?? "";
  }
}

const lastSocket = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function channel(options: Partial<Parameters<typeof createWebuiEventChannel>[0]> = {}) {
  const onEvent = vi.fn();
  const onReconnect = vi.fn();
  const created = createWebuiEventChannel({
    websocketUrl: () => "ws://runtime.test/events",
    webSocket: FakeSocket as unknown as Parameters<typeof createWebuiEventChannel>[0]["webSocket"],
    baseRetryMs: 100,
    maxRetryMs: 400,
    jitter: () => 1,
    report: () => undefined,
    ...options,
  });
  // The channel *is* the watcher: call it to subscribe, and read `health` beside it.
  const unsubscribe = created(onEvent, onReconnect);
  return { channel: created, onEvent, onReconnect, unsubscribe };
}

describe("the liveness probe on an open socket", () => {
  // This suite must stay FIRST in the file. The health store behind
  // `connection-health` is module-level, and the older suites below never
  // call the `unsubscribe` they get — their watchers (some permanently
  // healthy) stay registered for the rest of this worker's life. Vitest runs
  // describes in definition order, so running here means the store is clean
  // and these cases own the only watchers in it; the cases' own afterEach
  // keeps it that way. The one case that needs a degraded channel to clear
  // (the fatal one) would read false against a correct implementation if a
  // leftover healthy watcher from an earlier suite were present.
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    // The socket double's ledger is file-level; each case counts from zero.
    FakeSocket.instances.length = 0;
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    expect(isWebuiEventChannelDegraded()).toBe(false);
    vi.useRealTimers();
  });

  const subscribe = () => {
    const created = channel();
    unsubscribers.push(created.unsubscribe);
    return created;
  };

  /** Drives the newest socket through open and the `watchEvents` acceptance. */
  const accept = (socket: FakeSocket): void => {
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "response",
        requestId: socket.requestId,
        body: { ok: true, source: [] },
      }),
    );
  };

  const sentFrames = (socket: FakeSocket): Array<Record<string, unknown>> =>
    socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  const livenessFrames = (socket: FakeSocket): Array<Record<string, unknown>> =>
    sentFrames(socket).filter((frame) => frame.operation === "version");

  it("N1 · forces a reconnect when an accepted socket goes silent, and recovers on the next acceptance", () => {
    subscribe();
    const socket = lastSocket();
    // The acceptance clears the startup grace, so whatever degrades or dials
    // from here on can only be the probe's doing.
    accept(socket);

    vi.advanceTimersByTime(60_000); // and never emits another frame

    // The verdict dialled a replacement and closed the silent one — the test
    // emitted no "close", so the probe is the only possible cause.
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    // Probes were really sent before the verdict; this is a probe kill, not a
    // stray close.
    expect(livenessFrames(FakeSocket.instances[0]!)).not.toHaveLength(0);
    // reconnectNow marks the watcher down before dialling, so the channel
    // reads degraded at the moment of the kill.
    expect(isWebuiEventChannelDegraded()).toBe(true);

    // The round trip starts with the replacement opening — and its first
    // written frame being its own `watchEvents` request, which is also the
    // guard that the verdict did not fall through to `send`: a liveness frame
    // written to the CONNECTING replacement would sit in front of it.
    const replacement = FakeSocket.instances[1]!;
    replacement.emit("open");
    const firstOnReplacement = JSON.parse(replacement.sent[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(firstOnReplacement.operation).toBe("watchEvents");
    // …and the acceptance restores the channel.
    replacement.emit(
      "message",
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "response",
        requestId: replacement.requestId,
        body: { ok: true, source: [] },
      }),
    );
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("N2 · never probes — and never kills — a socket that keeps delivering events", () => {
    subscribe();
    const socket = lastSocket();
    accept(socket);
    // An event every 8 s: quieter than the 10 s probe interval, but never
    // silent. Live traffic is its own liveness evidence.
    for (let tick = 0; tick < 8; tick += 1) {
      vi.advanceTimersByTime(8_000);
      socket.emit(
        "message",
        JSON.stringify({
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "event",
          requestId: socket.requestId,
          body: { type: "session.updated", payload: {}, timestamp: 0, source: "runtime" },
        }),
      );
    }
    expect(sentFrames(socket)).toHaveLength(1); // only the watchEvents request
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("N3 · a probe that is answered keeps the channel alive", () => {
    subscribe();
    const socket = lastSocket();
    accept(socket);
    for (let round = 0; round < 3; round += 1) {
      vi.advanceTimersByTime(10_000); // the quiet gap fires one probe
      const probe = JSON.parse(socket.sent.at(-1) ?? "{}") as Record<string, unknown>;
      expect(probe.operation).toBe("version");
      // The answer arrives within the tick: like any inbound frame it is the
      // liveness evidence, and the request-id filter drops it right after the
      // refresh — the probe's answer is never mistaken for an acceptance.
      socket.emit(
        "message",
        JSON.stringify({
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "response",
          requestId: String(probe.requestId),
          body: { version: "probe-answer", protocolVersion: 1 },
        }),
      );
    }
    expect(FakeSocket.instances).toHaveLength(1);
    expect(isWebuiEventChannelDegraded()).toBe(false);
  });

  it("N4 · a hidden page suspends both the probe and the verdict until it is seen again", () => {
    // This node environment has no `document`; the stub supplies the
    // visibility surface the channel reads, installed before `channel()` so
    // the subscribe wiring sees it (the precedent is the document stub in
    // `connection-health.test.ts`).
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = globals.document;
    const document = {
      visibilityState: "hidden",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    globals.document = document;
    try {
      subscribe();
      const socket = lastSocket();
      // The acceptance clears the startup grace; without it the 30 s grace
      // would degrade during the 120 s advance below and the case would test
      // the grace, not the probe.
      accept(socket);
      vi.advanceTimersByTime(120_000); // silent AND hidden the whole time
      // Suspended, not dead: no probe was sent, no verdict fired, the socket
      // was neither closed nor replaced.
      expect(sentFrames(socket)).toHaveLength(1);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(socket.closed).toBe(false);
      expect(isWebuiEventChannelDegraded()).toBe(false);
      // The control: the same silence, once the page is visible again, gets
      // the verdict it deserved all along.
      document.visibilityState = "visible";
      vi.advanceTimersByTime(10_000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(socket.closed).toBe(true);
      expect(isWebuiEventChannelDegraded()).toBe(true);
    } finally {
      globals.document = saved;
    }
  });

  it("N5 · a fatal rejection degrades immediately, and neither probes nor retries", () => {
    subscribe();
    const socket = lastSocket();
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "error",
        requestId: socket.requestId,
        code: WebuiErrorCode.capabilityNotReady,
        message: "terminal bridge is not ready",
      }),
    );
    // Immediately — no advancing the 30 s startup grace. The fatal verdict
    // ended the grace on the spot, so the never-accepted watcher degrades
    // now; before that behaviour this read false for the first 30 s of a
    // fatal outage, which the banner projected as connected.
    expect(isWebuiEventChannelDegraded()).toBe(true);

    vi.advanceTimersByTime(60_000);
    // Fatal exempts itself from the probe and from retrying: nothing was
    // written beyond the watchEvents request, and no second socket exists.
    expect(sentFrames(socket)).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(isWebuiEventChannelDegraded()).toBe(true);
  });
});

describe("V26 · the delay before a retry is bounded and spread", () => {
  it("grows exponentially, jitters, and stops at the ceiling", () => {
    const at = (attempt: number, jitter: number) =>
      webuiChannelRetryDelayMs(attempt, { baseMs: 100, maxMs: 1_600, jitter: () => jitter });

    expect([1, 2, 3, 4].map((attempt) => at(attempt, 1))).toEqual([100, 200, 400, 800]);
    // Capped, then jittered below the cap — the ceiling still means something.
    expect(at(5, 1)).toBe(1_600);
    expect(at(9, 1)).toBe(1_600);
    expect(at(5, 0)).toBe(800);
    // The default ceiling is the 30 s interval a client will not exceed.
    expect(WEBUI_CHANNEL_MAX_RETRY_MS).toBe(30_000);
    expect(webuiChannelRetryDelayMs(20, { jitter: () => 1 })).toBe(30_000);
  });

  it("treats protocol and capability rejections as fatal, and an unknown code as transient", () => {
    expect(isFatalWebuiChannelCode(WebuiErrorCode.protocolMismatch)).toBe(true);
    expect(isFatalWebuiChannelCode(WebuiErrorCode.invalidEnvelope)).toBe(true);
    expect(isFatalWebuiChannelCode(WebuiErrorCode.capabilityUnavailable)).toBe(true);
    expect(isFatalWebuiChannelCode(WebuiErrorCode.capabilityNotReady)).toBe(true);
    // An open string: a code this build has never heard of is a newer server, and
    // guessing "fatal" from it would strand a client that could have reconnected.
    expect(isFatalWebuiChannelCode("some_code_from_the_future")).toBe(false);
  });
});

describe("V26 · one socket, one health signal", () => {
  it("reports open on the acknowledgement and reconnects once per connection", () => {
    const { channel: created, onReconnect } = channel();
    const socket = lastSocket();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: socket.requestId, body: {} }));
    expect(created.health.state().kind).toBe("open");
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // A second acknowledgement on the same connection is not a reconnect.
    socket.emit("message", JSON.stringify({ protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: socket.requestId, body: {} }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("goes transient with an attempt count and a delay when the socket closes", () => {
    const { channel: created } = channel({ baseRetryMs: 100, jitter: () => 1 });
    lastSocket().emit("close");
    const state = created.health.state();
    expect(state.kind).toBe("transient");
    if (state.kind === "transient") {
      expect(state.attempt).toBe(1);
      expect(state.retryInMs).toBe(100);
    }
  });

  it("stops retrying on a fatal rejection, and only a deliberate reconnect resumes", () => {
    const { channel: created } = channel();
    const socket = lastSocket();
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "error",
        requestId: socket.requestId,
        code: WebuiErrorCode.capabilityNotReady,
        message: "terminal bridge is not ready",
      }),
    );
    const fatal = created.health.state();
    expect(fatal.kind).toBe("fatal");
    if (fatal.kind === "fatal") expect(fatal.code).toBe(WebuiErrorCode.capabilityNotReady);

    // A close after a fatal state does not restart the loop.
    socket.emit("close");
    expect(created.health.state().kind).toBe("fatal");

    // A deliberate act does: this is the one thing that ends a fatal condition.
    const before = FakeSocket.instances.length;
    created.health.reconnect();
    expect(FakeSocket.instances.length).toBe(before + 1);
    expect(created.health.state().kind).toBe("connecting");
  });

  it("keeps a protocol-valid frame from a different request from marking it healthy", () => {
    const { channel: created } = channel();
    const socket = lastSocket();
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({ protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: "someone-else", body: {} }),
    );
    expect(created.health.state().kind).toBe("connecting");
  });
});
