/**
 * The credential flow, end to end in code.
 *
 * The claim under test is the whole chain, not one link of it: the browser signs the binding and
 * pushes the one-shot ticket down, the service that holds the socket opens it, and the status
 * stream reports `connected`. Nothing in the middle is faked — the real bridge runs, the real
 * credential provider hands the ticket to the real connection, and only the gateway socket and the
 * runtime are scripted.
 *
 * Two things are asserted alongside it, because they are the ways this flow goes wrong:
 *
 *   * the ticket is consumed by the handshake and never lands in the persisted state;
 *   * a host that has not been given a ticket reports a truthful phase, never `connected`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebuiRemoteControl } from "../../src/runtime/remote-control/owner.js";
import type { RcWebSocketLike } from "../../src/runtime/remote-control/bridge/connection.js";
import type { WebuiRemoteControlEvent } from "../../src/shared/contracts/remote-control.js";

const dataDirs: string[] = [];

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "webui-remote-control-"));
  dataDirs.push(dir);
  return dir;
}

/** A CLI service with an idle event stream. */
function cliServiceStub() {
  return {
    watchEvents: async function* watchEvents() {
      await new Promise<void>(() => {});
    },
  };
}

/** The gateway socket, scripted. */
class FakeGatewaySocket implements RcWebSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (payload?: unknown) => void>();

  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: (code: number, reason?: Buffer | string) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: string, cb: (...args: never[]) => void): void {
    this.handlers.set(event, cb as (payload?: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The gateway speaks first: `ctrl.hello` owns the socket lifetime. */
  hello(connectionId = "conn-1"): void {
    this.handlers.get("open")?.();
    this.handlers.get("message")?.(
      JSON.stringify({
        v: 1,
        id: "f-hello",
        ts: Date.now(),
        type: "ctrl.hello",
        payload: { connection_id: connectionId },
        source: "desktop",
      }),
    );
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("the remote-control credential flow", () => {
  it("opens the socket when the browser pushes a signed ticket, and reports connected", async () => {
    const dir = dataDir();
    let socket: FakeGatewaySocket | undefined;
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: cliServiceStub() as never,
        dataDir: dir,
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      wsFactory: () => {
        socket = new FakeGatewaySocket();
        return socket;
      },
    });

    // Before the ticket: the link is idle, and the page says so.
    expect((await controller.getStatus()).phase).toBe("idle");

    // The handshake is asynchronous: the push hands the ticket over and the socket opens a
    // moment later, so the answer is awaited after the gateway has spoken.
    const applied = controller.applyCredentials({
      bindingId: 7,
      ticket: "one-shot-ticket",
      endpoint: "wss://gateway.example.invalid/socket",
    });

    await waitFor(() => socket !== undefined, "the socket to be created");
    socket?.hello();
    await waitFor(
      () => socket?.sent.some((line) => line.includes("ctrl.auth.complete")) === true,
      "the handshake to complete",
    );
    expect(await applied).toEqual({ success: true });

    // The status is pushed: the stream's first frame is the snapshot.
    const stream = await controller.watchStatus();
    expect(stream.ok).toBe(true);
    if (stream.ok !== true) return;
    const iterator = (stream.source as AsyncIterable<WebuiRemoteControlEvent>)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const frame = first.value as {
      readonly type: string;
      readonly status: { readonly phase: string };
    };
    expect(frame.type).toBe("status");
    expect(frame.status.phase).toBe("connected");

    // The ticket travelled in the handshake query, and nowhere else.
    const state = readFileSync(path.join(dir, "remote-control", "state.json"), "utf8");
    expect(state).not.toContain("one-shot-ticket");
  });

  it("reports a truthful phase when no ticket was ever pushed", async () => {
    const dir = dataDir();
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: cliServiceStub() as never,
        dataDir: dir,
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      wsFactory: () => new FakeGatewaySocket(),
    });

    const status = await controller.getStatus();
    expect(status.phase).toBe("idle");
    // Nothing claims a device that is not there.
    expect(status.displayName).toBeUndefined();
  });
});
