// The loopback → server → harness-port evidence, as one reproducible check
// instead of a one-off run recorded in an issue comment: this is evidence
// level 3 in packages/webui/docs/verification/gates.md.
//
// That level asks for a real run covering authentication failure, shutdown and
// reconnect, and says explicitly that fixtures do not substitute for it. What
// this file does and does not establish is stated at the bottom; read it before
// treating a green run as proof of the live-agent path.
//
// What is real here, end to end and in one process:
//   * a real `WebuiService` binds a real loopback TCP port;
//   * a real `ws` client connects, and is refused without a credential;
//   * a request travels the real operation registry, the real dispatcher and
//     the real frame envelope, and lands on the `WebuiHarnessPort` method the
//     runtime adapter (`runtime/harness/adapter.ts`) also implements;
//   * the `watchEvents` subscription opens and delivers a live event;
//   * the client drops and reconnects against the same service;
//   * after `close()`, the socket is closed by the server and a fresh
//     connection is refused.
//
// What is NOT real, and is the boundary of this evidence: the leaf host behind
// the harness port. `createHarnessPortFromHost` wraps a live CliService, and a
// live CliSession is not deterministic to drive from a test. So the port here
// is a scripted stand-in, exactly as ADR 0006 requires of every harness-side
// test. That means this file proves the loopback, envelope, dispatch, stream
// and shutdown path; it does **not** prove that a real agent process answers.
// No test in this repository can, and the plan no longer implies one does.

import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import { WebuiService } from "../../src/server/service.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import type {
  WebuiRuntimeEvent,
  WebuiWatchEventsResult,
} from "../../src/shared/contracts/stream.js";
import type { WebuiSessionPage } from "../../src/shared/contracts/session.js";
import { createWebuiWire, type WebuiSocket } from "../../src/client/platform/wire.js";
import { createWebuiSettingsWorkflows } from "../../src/client/features/settings/application/settings-workflows.js";

interface TestPort extends WebuiHarnessPort {
  /** Every harness method the run actually reached, in call order. */
  readonly calls: string[];
}

function scriptedPort(): TestPort {
  const calls: string[] = [];
  const events: AsyncIterable<WebuiRuntimeEvent> = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "session_changed",
        payload: { sessionId: "s-loopback" },
        timestamp: 1,
        source: "loopback-integration",
      } satisfies WebuiRuntimeEvent;
      // Stay open: the iterator must not end, or the stream would close
      // before the reconnect and shutdown steps can observe it.
      await new Promise<void>(() => {});
    },
  };
  const port = {
    calls,
    version: () => ({ version: "loopback-fixture", protocolVersion: 1 }),
    listSessions: async (): Promise<WebuiSessionPage> => {
      calls.push("listSessions");
      return {
        sessions: [
          {
            sessionId: "s-loopback",
            title: "loopback session",
            status: "idle",
            agentName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      } as unknown as WebuiSessionPage;
    },
    watchEvents: (): AsyncIterable<WebuiRuntimeEvent> => {
      calls.push("watchEvents");
      return events;
    },
    close: async (): Promise<void> => {
      calls.push("close");
    },
  } as unknown as TestPort;
  return port;
}

interface Client {
  readonly ws: WebSocket;
  /** Resolves on a successful upgrade, rejects with the refusal otherwise. */
  readonly upgrade: Promise<unknown>;
  readonly closed: Promise<{ code: number }>;
}

function openClient(url: string): Client {
  const ws = new WebSocket(url);
  ws.on("error", () => undefined);
  const upgrade = once(ws, "open");
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.once("close", (code) => resolve({ code }));
  });
  return { ws, upgrade, closed };
}

/** Adapt the native ws event interface to the browser wire's narrow interface. */
class LoopbackSocket implements WebuiSocket {
  private readonly socket: WebSocket;
  constructor(url: string) { this.socket = new WebSocket(url); }
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void {
    this.socket.addEventListener(type, (event) => listener("data" in event ? { data: event.data } : {}));
  }
  send(data: string): void { this.socket.send(data); }
  close(): void { this.socket.close(); }
}

/** Send one request frame and resolve with the next frame the server writes. */
function once_(ws: WebSocket, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      ws.off("message", onMessage);
      try {
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
    ws.send(JSON.stringify(request));
  });
}

/**
 * Wait for the next frame matching `predicate`. The events subscription
 * answers its own request first (`{ stream: true }`) and only then emits
 * event frames, so a stream assertion has to skip the acknowledgement.
 */
function awaitFrame(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch (error) {
        ws.off("message", onMessage);
        reject(error);
        return;
      }
      if (!predicate(frame)) return;
      ws.off("message", onMessage);
      resolve(frame);
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
  });
}

/** Poll a condition the socket cannot signal; the stream has no ack of its own. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A terminal-process port stand-in: the six terminal operations talk to this
 * narrow port, so the test can drive delivery without a real PTY. The PTY itself
 * is the boundary this test does not cover.
 */
function stubTerminalPort() {
  const calls: string[] = [];
  const listeners = new Set<(data: string) => void>();
  let disposed = 0;
  return {
    calls,
    emit(data: string) {
      for (const listener of [...listeners]) listener(data);
    },
    disposeCount: () => disposed,
    create(workspaceDir: string) {
      calls.push(`create:${workspaceDir}`);
      return { terminalId: "t-terminal", status: "running" as const };
    },
    list() {
      return [
        { terminalId: "t-terminal", status: "running" as const, output: "" },
      ];
    },
    write(terminalId: string, data: string) {
      calls.push(`write:${terminalId}:${data}`);
      return { success: true as const };
    },
    resize(terminalId: string, cols: number, rows: number) {
      calls.push(`resize:${terminalId}:${cols}x${rows}`);
      return { success: true as const };
    },
    dispose(terminalId: string) {
      calls.push(`dispose:${terminalId}`);
      return { success: true as const };
    },
    async *watch(terminalId: string, signal?: AbortSignal) {
      calls.push(`watch:${terminalId}`);
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const listener = (data: string) => {
        queue.push(data);
        wake?.();
      };
      listeners.add(listener);
      try {
        while (!signal?.aborted) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          } else {
            yield { terminalId, data: queue.shift() ?? "", exited: false };
          }
        }
      } finally {
        listeners.delete(listener);
      }
    },
    disposeBySession() {
      disposed += 1;
      calls.push("disposeBySession");
    },
  };
}

describe("loopback to harness-port evidence", () => {
  let service: WebuiService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("V20 reconciles a committed mutation after the real socket loses its response, without retrying", async () => {
    let content = "before";
    let writes = 0;
    let finish!: () => void;
    const answer = () => ({ content, exists: true, path: "AGENTS.md", maxBytes: 32768 });
    const port: WebuiHarnessPort = {
      ...scriptedPort(),
      getGlobalInstructions: async () => answer(),
      setGlobalInstructions: async (request) => {
        writes += 1;
        content = request.content;
        // The host committed, but the response is held past the client deadline.
        await new Promise<void>((resolve) => { finish = resolve; });
        return answer();
      },
    };
    service = new WebuiService({ port, operations: createOperationRegistry(port), credential: { token: "lost-response-fixture" } });
    const info = await service.start();
    const wire = createWebuiWire({ websocketUrl: `ws://127.0.0.1:${info.tcpPort}`, token: info.credential.token, webSocket: LoopbackSocket, requestTimeoutMs: 100 });
    const owner = createWebuiSettingsWorkflows({ port: {
      getGlobalInstructions: () => wire.request("getGlobalInstructions", {}),
      setGlobalInstructions: (request) => wire.request("setGlobalInstructions", request),
    } });
    try {
      await owner.loadInstructions();
      await expect(owner.saveInstructions("committed despite lost response")).rejects.toThrow("timed out");
      expect(writes).toBe(1);
      expect(owner.getSnapshot().instructions.value?.content).toBe("committed despite lost response");
    } finally { finish?.(); owner.dispose(); }
  });

  it("covers authentication, dispatch, watchEvents, reconnect and shutdown", async () => {
    const port = scriptedPort();
    service = new WebuiService({
      port,
      operations: createOperationRegistry(port),
      // A fixed token keeps the URL readable and the refusal assertions
      // independent of whatever the per-start generator produced.
      credential: { token: "loopback-integration-token" },
      webSocketHeartbeatIntervalMs: 30_000,
    });
    const info = await service.start();

    // 1. A real loopback listener is bound, on an OS-assigned port.
    expect(info.tcpPort).toBeGreaterThan(0);
    const base = `ws://127.0.0.1:${info.tcpPort}`;
    const url = `${base}/?token=${info.credential.token}`;

    // 2. Authentication failure: the same listener refuses a client that
    //    presents no credential, before any operation is dispatched.
    const anonymous = openClient(base);
    await expect(anonymous.upgrade).rejects.toThrow(/401/u);
    expect((await anonymous.closed).code).not.toBe(1000);
    expect(port.calls).not.toContain("listSessions");

    // 3. An authenticated client connects and a request travels the real
    //    registry and dispatcher to the harness port.
    const first = openClient(url);
    await first.upgrade;
    const listed = await once_(first.ws, {
      kind: "request",
      protocolVersion: info.protocolVersion,
      requestId: "r-list-1",
      operation: "listSessions",
      body: { name: "main", limit: 500 },
    });
    expect(listed.kind).toBe("response");
    expect(port.calls).toContain("listSessions");

    // 4. The events subscription opens and delivers a live event frame.
    const watcher = new WebSocket(url);
    watcher.on("error", () => undefined);
    await once(watcher, "open");
    const eventFrame = awaitFrame(
      watcher,
      (frame) => frame.kind === "event",
    );
    watcher.send(
      JSON.stringify({
        kind: "request",
        protocolVersion: info.protocolVersion,
        requestId: "r-watch-1",
        operation: "watchEvents",
        body: {},
      }),
    );
    const frame = await eventFrame;
    expect(frame.requestId).toBe("r-watch-1");
    expect(port.calls).toContain("watchEvents");
    expect(JSON.stringify(frame)).toContain("session_changed");

    // 5. Reconnect: the client drops and a fresh socket dispatches again on
    //    the same service, so the credential outlives one connection.
    first.ws.close();
    await first.closed;
    const second = openClient(url);
    await second.upgrade;
    const listedAgain = await once_(second.ws, {
      kind: "request",
      protocolVersion: info.protocolVersion,
      requestId: "r-list-2",
      operation: "listSessions",
      body: { name: "main", limit: 500 },
    });
    expect(listedAgain.requestId).toBe("r-list-2");

    // 6. Shutdown: the server closes the live socket and stops accepting.
    const shutdown = service.close();
    // `node:events`' `once` resolves to the event's *argument array*, so the
    // close code has to be taken out of it. Comparing the array itself against a
    // number was always unequal and made this assertion vacuous — it claimed the
    // socket was not closed cleanly without ever reading the code.
    const watcherClosed = once(watcher, "close");
    const secondClosed = once(second.ws, "close");
    await shutdown;
    service = undefined;
    const [watcherCloseCode] = await watcherClosed;
    const [secondCloseCode] = await secondClosed;
    expect(watcherCloseCode).not.toBe(1000);
    expect(secondCloseCode).not.toBe(1000);

    const afterShutdown = openClient(url);
    await expect(afterShutdown.upgrade).rejects.toThrow();
    // The port itself was closed, so a later reconnect cannot silently succeed.
    const relisten = new WebSocket(base);
    relisten.on("error", () => undefined);
    await expect(once(relisten, "open")).rejects.toThrow();
  });
  it("delivers terminal traffic through the registry the host assembled", async () => {
    const port = scriptedPort();
    const terminal = stubTerminalPort();
    // The registry is built by the host from both ports and handed to the
    // service, which binds it.
    service = new WebuiService({
      port,
      operations: createOperationRegistry(port, terminal),
      terminal,
      credential: { token: "loopback-terminal-token" },
      webSocketHeartbeatIntervalMs: 30_000,
    });
    const info = await service.start();
    const url = `ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`;
    const client = openClient(url);
    await client.upgrade;

    // 1. A terminal is created through the real dispatcher and the port.
    const created = await once_(client.ws, {
      kind: "request",
      protocolVersion: info.protocolVersion,
      requestId: "r-term-create",
      operation: "createTerminal",
      body: { workspaceDir: "/synthetic/workspace" },
    });
    expect(created.kind).toBe("response");
    expect(JSON.stringify(created)).toContain("t-terminal");
    expect(terminal.calls).toContain("create:/synthetic/workspace");

    // 2. Watching delivers what the port produces: the request is acknowledged
    //    and then the output arrives as event frames on the same socket.
    const delivered = awaitFrame(
      client.ws,
      (frame) => frame.kind === "event" && frame.requestId === "r-term-watch",
    );
    client.ws.send(
      JSON.stringify({
        kind: "request",
        protocolVersion: info.protocolVersion,
        requestId: "r-term-watch",
        operation: "watchTerminal",
        body: { terminalId: "t-terminal" },
      }),
    );
    await waitFor(() => terminal.calls.includes("watch:t-terminal"));
    terminal.emit("hello from the pty\n");
    const frame = await delivered;
    expect(JSON.stringify(frame)).toContain("hello from the pty");
    expect(terminal.calls).toContain("watch:t-terminal");

    // 3. Write, resize and dispose reach the port with their arguments intact.
    for (const [requestId, operation, body] of [
      ["r-term-write", "writeTerminal", { terminalId: "t-terminal", data: "ls\n" }],
      ["r-term-resize", "resizeTerminal", { terminalId: "t-terminal", cols: 120, rows: 40 }],
      ["r-term-dispose", "disposeTerminal", { terminalId: "t-terminal" }],
    ] as const) {
      await once_(client.ws, {
        kind: "request",
        protocolVersion: info.protocolVersion,
        requestId,
        operation,
        body,
      });
    }
    expect(terminal.calls).toEqual(
      expect.arrayContaining([
        "write:t-terminal:ls\n",
        "resize:t-terminal:120x40",
        "dispose:t-terminal",
      ]),
    );

    // 4. Shutdown disposes the terminals the port owns.
    await service.close();
    service = undefined;
    expect(terminal.disposeCount()).toBe(1);
  });
});
