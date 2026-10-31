/**
 * The 远程控制 status stream.
 *
 * The claim under test is that the browser receives the bridge's status changes.
 *
 * The regression this pins was silent and severe: the stream's subscriber
 * re-emitted the owner's events into the owner's own subscriber set — the set
 * the subscriber itself belonged to — so every status change recursed until the
 * stack ran out. The proxy caught the overflow and logged it, the frame never
 * reached the browser, and the panel showed whatever it had last seen. The
 * pairing worked; the panel simply never knew.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebuiRemoteControl } from "../../src/runtime/remote-control/owner.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "webui-rc-stream-"));
  dirs.push(dir);
  return dir;
}

/** A WebSocket that completes the handshake the way the gateway does. */
function socketFactory() {
  return () => {
    const handlers = new Map<string, (arg?: unknown) => void>();
    const socket = {
      on(event: string, cb: (arg?: unknown) => void) {
        handlers.set(event, cb);
        if (event === "open") setTimeout(() => cb(), 0);
      },
      send() {},
      close() {},
      readyState: 1,
    };
    setTimeout(() => {
      handlers.get("message")?.(
        JSON.stringify({
          v: 1,
          id: "hello-1",
          ts: Date.now(),
          type: "ctrl.hello",
          payload: { connection_id: "conn-1", server_time_ms: Date.now(), max_message_bytes: 1024 },
          source: "gateway",
          trace_id: "trace-1",
        }),
      );
    }, 5);
    return socket as never;
  };
}

describe("the remote-control status stream", () => {
  it("delivers the bridge's status changes to the browser", async () => {
    const dir = dataDir();
    const controller = createWebuiRemoteControl({
      host: {
        apiHost: { close: async () => {} },
        cliService: {
          watchEvents: async function* watchEvents() {
            await new Promise<void>(() => {});
          },
        } as never,
        dataDir: dir,
        getAuthCredential: async () => ({
          accessToken: "lease-token",
          realUserID: "42",
        }),
      } as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      wsFactory: socketFactory(),
      // The relink asks the server for the binding, and the 连接 button asks
      // for a pairing code; a unit test must not ask the real ones.
      fetchImpl: (async (input: string | URL) => {
        const url = String(input);
        const body = url.includes("/pairing/code")
          ? { pairing_code: "1234", expires_in_s: 300 }
          : { binding: { state: "none" } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const stream = await controller.watchStatus();
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    // The stream source is `AsyncIterable | Iterable`; the owner's stream is the
    // async one, so narrow it before asking for its iterator.
    const iterator = (stream.source as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    // The first frame is the snapshot.
    const snapshot = await iterator.next();
    expect(snapshot.value).toMatchObject({ type: "status" });

    // A status change on the bridge has to reach the stream. The 连接 button
    // is the one the user presses: it moves the phase to pairing.
    await controller.connect({ requestCode: true });

    const frame = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the status frame never arrived")), 3000),
      ),
    ]);
    expect(frame.value).toMatchObject({
      type: "status",
      status: { phase: "pairing", pairingCode: "1234" },
    });

    // Closing the stream has to finish: a stream that cannot be closed keeps
    // its runtime subscription alive.
    await iterator.return?.(undefined);
  });
});
