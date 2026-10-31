// The wire skeleton the three socket-carrying operations share (U24).
//
// `request`, `stream` and `watchTerminal` used to write the same socket setup
// three times: mint a requestId, send the same envelope on `open`, parse each
// frame and drop anything that answers a different request. The consolidation
// lives in `openWireSession`, and these cases pin the part that is now shared —
// which nothing pinned before. The three callers' own policies (what settles
// them, whether a close is an error) stay covered where they already were, in
// `webui-service.test.ts`.
import { describe, expect, it, vi } from "vitest";

import { createWebuiTransport } from "../../src/client/platform/transport.js";
import { createWebuiWire } from "../../src/client/platform/wire.js";
import {
  WebuiErrorCode,
  WebuiWireError,
} from "../../src/shared/envelope.js";

/** A socket that records what was sent and lets a test deliver frames. */
class ControllableSocket {
  static latest: ControllableSocket | undefined;

  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  private closed = false;

  constructor(_url: string) {
    ControllableSocket.latest = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  fail(): void {
    this.emit("error", {});
  }

  /** The request frame the transport wrote, parsed. */
  get request(): { requestId: string; operation: string; body: unknown; [key: string]: unknown } {
    return JSON.parse(this.sent[0] ?? "{}") as never;
  }

  /**
   * Deliver a frame the way the service does: every frame it writes carries the
   * protocol version, and the client now checks it. The fixtures below used to
   * omit it and passed precisely because nothing validated the envelope — so a
   * frame from a service speaking a different version was accepted as an answer.
   */
  deliver(payload: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ protocolVersion: 1, ...payload }) });
  }

  /** A payload that is not JSON at all — `deliver` always stringifies to valid JSON. */
  deliverRaw(data: string): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** The socket writes its request frame from an `open` microtask. */
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function transportWith(socket: typeof ControllableSocket) {
  return createWebuiTransport({
    websocketUrl: "ws://127.0.0.1:1",
    token: "fixture-token",
    webSocket: socket as unknown as NonNullable<
      Parameters<typeof createWebuiTransport>[0]["webSocket"]
    >,
  });
}

describe("the browser input connection", () => {
  const input = {
    command: {
      kind: "text" as const,
      target: { surface: "isolated-chromium" as const, browserId: "b", targetId: "t", generation: 1 },
      text: "a",
    },
  };

  it("reuses a connection and correlates overlapping input responses", async () => {
    vi.useFakeTimers();
    try {
      const transport = transportWith(ControllableSocket);
      const first = transport.sendBrowserInput(input);
      await tick();
      const socket = ControllableSocket.latest!;
      const second = transport.sendBrowserInput({ ...input, runId: "run-2" });
      await tick();
      expect(ControllableSocket.latest).toBe(socket);
      expect(socket.sent).toHaveLength(2);
      const [a, b] = socket.sent.map((text) => JSON.parse(text));
      expect(a.requestId).not.toBe(b.requestId);
      expect(b.body.runId).toBe("run-2");
      socket.deliver({ kind: "response", requestId: b.requestId, body: { accepted: true } });
      socket.deliver({ kind: "error", requestId: a.requestId, code: "browser_target_stale", message: "stale" });
      await expect(first).rejects.toMatchObject({ code: "browser_target_stale" });
      await expect(second).resolves.toEqual({ accepted: true });
      const third = transport.sendBrowserInput(input);
      expect(ControllableSocket.latest).toBe(socket);
      const c = JSON.parse(socket.sent[2]!);
      socket.deliver({ kind: "response", requestId: c.requestId, body: { accepted: true } });
      await third;
      await vi.advanceTimersByTimeAsync(1000);
      const fourth = transport.sendBrowserInput(input);
      await tick();
      const replacement = ControllableSocket.latest!;
      expect(replacement).not.toBe(socket);
      replacement.deliver({ kind: "response", requestId: replacement.request.requestId, body: { accepted: true } });
      await fourth;
      await vi.advanceTimersByTimeAsync(1000);
    } finally { vi.useRealTimers(); }
  });

  it("rejects outstanding inputs on disconnect without replaying them", async () => {
    const transport = transportWith(ControllableSocket);
    const first = transport.sendBrowserInput(input);
    const second = transport.sendBrowserInput(input);
    const assertions = Promise.all([
      expect(first).rejects.toThrow("closed before the response"),
      expect(second).rejects.toThrow("closed before the response"),
    ]);
    await tick();
    const socket = ControllableSocket.latest!;
    expect(socket.sent).toHaveLength(2);
    socket.close();
    await assertions;
    await tick();
    expect(ControllableSocket.latest).toBe(socket);
  });

  it("times out one request without settling or replaying its neighbour", async () => {
    vi.useFakeTimers();
    try {
      const wire = createWebuiWire({ websocketUrl: "ws://127.0.0.1:1", token: "synthetic",
        webSocket: ControllableSocket, requestTimeoutMs: 100 });
      const first = wire.request("sendBrowserInput", input.command, { reuseConnection: true });
      const failed = expect(first).rejects.toThrow("timed out after 100ms");
      await tick();
      const socket = ControllableSocket.latest!;
      await vi.advanceTimersByTimeAsync(50);
      const second = wire.request("sendBrowserInput", input.command, { reuseConnection: true });
      await vi.advanceTimersByTimeAsync(50);
      await failed;
      const [a, b] = socket.sent.map((text) => JSON.parse(text));
      socket.deliver({ kind: "response", requestId: a.requestId, body: { accepted: true } });
      socket.deliver({ kind: "response", requestId: b.requestId, body: { accepted: true } });
      await expect(second).resolves.toEqual({ accepted: true });
      expect(socket.sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
    } finally { vi.useRealTimers(); }
  });

  it("fails all outstanding requests when their shared envelope is invalid", async () => {
    const transport = transportWith(ControllableSocket);
    const first = transport.sendBrowserInput(input);
    const second = transport.sendBrowserInput(input);
    const assertions = Promise.all([
      expect(first).rejects.toMatchObject({ code: WebuiErrorCode.invalidEnvelope }),
      expect(second).rejects.toMatchObject({ code: WebuiErrorCode.invalidEnvelope }),
    ]);
    await tick();
    ControllableSocket.latest!.deliverRaw("not json");
    await assertions;
  });
});

describe("the shared request envelope", () => {
  it("writes one request frame naming the operation, with a fresh id", async () => {
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    const request = socket.request;
    expect(request).toMatchObject({
      protocolVersion: 1,
      kind: "request",
      operation: "listSessions",
      body: { name: "main", limit: 500 },
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    socket.deliver({ kind: "response", requestId: request.requestId, body: { sessions: [] } });
    await expect(pending).resolves.toEqual({ sessions: [] });
  });

  it("ignores a frame answering a different request", async () => {
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    const mine = socket.request.requestId;
    // A frame for someone else must not settle this promise — and it arrives
    // first, so a filter that dropped only later frames would be caught here.
    socket.deliver({ kind: "response", requestId: "another-request", body: { poison: true } });
    socket.deliver({ kind: "response", requestId: mine, body: { sessions: [] } });
    await expect(pending).resolves.toEqual({ sessions: [] });
  });

  it("rejects the request when the socket answers with something unparseable", async () => {
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    ControllableSocket.latest!.deliverRaw("{not json");
    // The code is the branchable half; the message names the operation so a
    // reader can tell which request produced it.
    await expect(pending).rejects.toThrow("listSessions returned invalid JSON");
    await expect(pending).rejects.toMatchObject({
      code: WebuiErrorCode.invalidEnvelope,
    });
  });
});

describe("the terminal watch", () => {
  it("forwards event frames and stops on request", async () => {
    const transport = transportWith(ControllableSocket);
    const frames: unknown[] = [];
    const stop = transport.watchTerminal({ terminalId: "t1" }, (frame) => frames.push(frame));
    await tick();
    const socket = ControllableSocket.latest!;
    expect(socket.request).toMatchObject({
      kind: "request",
      operation: "watchTerminal",
      body: { terminalId: "t1" },
    });
    const id = socket.request.requestId;
    socket.deliver({ kind: "event", requestId: id, body: { chunk: "one" } });
    // Neither a response frame nor an event frame without an object body is a
    // terminal frame; a watch that forwarded them would hand the caller
    // something the type says cannot arrive.
    socket.deliver({ kind: "response", requestId: id, body: { chunk: "ignored" } });
    socket.deliver({ kind: "event", requestId: id, body: "raw" });
    socket.deliver({ kind: "event", requestId: id, body: { chunk: "two" } });
    expect(frames).toEqual([{ chunk: "one" }, { chunk: "two" }]);
    stop();
    socket.deliver({ kind: "event", requestId: id, body: { chunk: "after-stop" } });
    expect(frames).toEqual([{ chunk: "one" }, { chunk: "two" }]);
  });
});

describe("the Mini App agent turn watch", () => {
  it.each(["close", "error"] as const)("settles as unknown when the socket %s without a final frame", async (event) => {
    const transport = transportWith(ControllableSocket);
    const frames: unknown[] = [];
    const failures: Error[] = [];
    transport.watchMiniAppAgentTurn(
      {
        pluginId: "fixture.miniapp",
        hostSessionId: "host-session",
        connection: 1,
        requestId: "turn-1",
        method: "run",
        text: "hello",
        observe: true,
      },
      (frame) => frames.push(frame),
      (error) => failures.push(error),
    );
    await tick();
    const socket = ControllableSocket.latest!;
    if (event === "close") socket.close();
    else socket.fail();
    expect(frames).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "result_unknown" });
  });
});

describe("the Mini App presentation lease watch", () => {
  it("reacquires the lease after an unexpected transport close", async () => {
    vi.useFakeTimers();
    try {
      const transport = transportWith(ControllableSocket);
      const failures: Error[] = [];
      const stop = transport.watchMiniAppPresentation(
        { pluginId: "fixture.miniapp", sessionId: "session-1" },
        () => undefined,
        (error) => failures.push(error),
      );
      await tick();
      const first = ControllableSocket.latest!;
      expect(first.request.operation).toBe("watchMiniAppPresentation");
      first.close();
      expect(failures).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250);
      await tick();
      const replacement = ControllableSocket.latest!;
      expect(replacement).not.toBe(first);
      expect(replacement.request.operation).toBe("watchMiniAppPresentation");
      expect(replacement.request.body).toEqual({ pluginId: "fixture.miniapp", sessionId: "session-1" });

      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ControllableSocket.latest).toBe(replacement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off repeated short-lived lease reconnects", async () => {
    vi.useFakeTimers();
    try {
      const transport = transportWith(ControllableSocket);
      const failures: Error[] = [];
      const stop = transport.watchMiniAppPresentation(
        { pluginId: "fixture.miniapp", sessionId: "session-1" },
        () => undefined,
        (error) => failures.push(error),
      );
      await tick();
      const first = ControllableSocket.latest!;
      first.fail();
      expect(failures).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250);
      await tick();
      const second = ControllableSocket.latest!;
      expect(second).not.toBe(first);
      second.fail();
      expect(failures).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(499);
      expect(ControllableSocket.latest).toBe(second);
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      expect(ControllableSocket.latest).not.toBe(second);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The delivery handle (`stream`'s third argument). A streaming operation used to return a promise
// and nothing else, so the client held no disposer at all: the only ways a stream
// could end were `[DONE]`, an error, or the socket dropping. These cases pin the
// handle the application can now keep, and that detaching is about THIS client's
// observation only — the request was already accepted by the host.
describe("the delivery handle a streaming operation hands out", () => {
  it("stops delivering frames and closes the socket when it is closed", async () => {
    const transport = transportWith(ControllableSocket);
    const frames: unknown[] = [];
    let delivery: { close: () => void } | undefined;
    const settled = transport.sendMessage(
      { id: "s1", content: "hello" },
      (frame) => frames.push(frame),
      (handle) => {
        delivery = handle;
      },
    );
    await tick();
    const socket = ControllableSocket.latest!;
    const id = socket.request.requestId;
    socket.deliver({ kind: "event", requestId: id, body: { dataJson: "{\"chunk\":1}" } });
    expect(frames).toHaveLength(1);

    expect(delivery).toBeDefined();
    delivery!.close();
    // A detach settles the operation: there is no error to report, because the
    // host accepted this request long ago. Failing here would make a deliberate
    // detach look like a dropped connection.
    await expect(settled).resolves.toBeUndefined();

    // And it only stops the client watching.
    socket.deliver({ kind: "event", requestId: id, body: { dataJson: "{\"chunk\":2}" } });
    expect(frames).toHaveLength(1);
  });

  it("hands out one for an attachment too", async () => {
    const transport = transportWith(ControllableSocket);
    let delivery: { close: () => void } | undefined;
    void transport.resumeSession({ id: "s1" }, () => undefined, (handle) => {
      delivery = handle;
    });
    await tick();
    expect(delivery).toBeDefined();
    // Closing twice is harmless: a detach and a terminal exit can both race here.
    delivery!.close();
    delivery!.close();
  });

  it("still settles on [DONE] when nobody detaches", async () => {
    const transport = transportWith(ControllableSocket);
    const frames: unknown[] = [];
    const settled = transport.sendMessage(
      { id: "s1", content: "hello" },
      (frame) => frames.push(frame),
      () => undefined,
    );
    await tick();
    const socket = ControllableSocket.latest!;
    const id = socket.request.requestId;
    socket.deliver({ kind: "event", requestId: id, body: { dataJson: "[DONE]" } });
    await expect(settled).resolves.toBeUndefined();
    expect(frames).toHaveLength(1);
  });
});

describe("an inbound frame is judged before it is believed", () => {
  it("carries the service's own code on a refusal, so callers branch on it", async () => {
    // Before this, every refusal arrived as `new Error(frame.message)` and the
    // service's stable code was dropped on the floor. A caller could therefore
    // only tell "shutting down" from "unsupported operation" by matching English
    // text that no gate protects.
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    socket.deliver({
      protocolVersion: 1,
      kind: "error",
      requestId: socket.request.requestId,
      code: "shutting_down",
      message: "service is shutting down",
    });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(WebuiWireError);
    // The stable half is what survived.
    expect((error as WebuiWireError).code).toBe(WebuiErrorCode.shuttingDown);
    expect((error as WebuiWireError).requestId).toBe(socket.request.requestId);
  });

  it("keeps an unfamiliar but stable code rather than flattening it", async () => {
    // A runtime that raises a code of its own has said something more precise
    // than "harness error"; the client's correct response is not to erase it.
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    socket.deliver({
      protocolVersion: 1,
      kind: "error",
      requestId: socket.request.requestId,
      code: "capability_unavailable",
      message: "runtime host does not expose project listing",
    });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as WebuiWireError).code).toBe(
      WebuiErrorCode.capabilityUnavailable,
    );
  });

  it("refuses a frame from a different protocol version instead of reading it as an answer", async () => {
    // The client used to `JSON.parse(...) as WireFrame` and check nothing else,
    // so a frame from a service speaking another version was accepted as though
    // it had answered.
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    socket.deliver({
      protocolVersion: 99,
      kind: "response",
      requestId: socket.request.requestId,
      body: { sessions: [], hasMore: false },
    });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as WebuiWireError).code).toBe(WebuiErrorCode.protocolMismatch);
  });

  it("names a malformed frame of the right version as an envelope failure", async () => {
    // Same version, wrong shape: a different situation from a version mismatch,
    // and the client needs to tell them apart.
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    socket.deliver({
      protocolVersion: 1,
      kind: "gossip",
      requestId: socket.request.requestId,
    });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as WebuiWireError).code).toBe(WebuiErrorCode.invalidEnvelope);
  });

  it("ignores an unrelated named response rather than answering with it", async () => {
    // It belongs to another request. Dropping it is the only correct action:
    // settling this request with it would answer the wrong question.
    const transport = transportWith(ControllableSocket);
    const pending = transport.loadSessions();
    await tick();
    const socket = ControllableSocket.latest!;
    socket.deliver({
      protocolVersion: 1,
      kind: "response",
      requestId: "some-other-request",
      body: { sessions: [{ sessionId: "elsewhere" }], hasMore: false },
    });
    socket.deliver({
      protocolVersion: 1,
      kind: "response",
      requestId: socket.request.requestId,
      body: { sessions: [], hasMore: false },
    });

    await expect(pending).resolves.toEqual({ sessions: [], hasMore: false });
  });
});
