/**
 * The binding watcher.
 *
 * The claim under test is that the service keeps its producer on the binding
 * the phone is actually on.
 *
 * The regression this pins is the one that cost three rounds of pairing: the
 * bridge's own pairing poll lives only inside a pairing window and confirms
 * whichever binding exists when it first ticks — which, right after a second
 * pairing, is the *previous* one. The phone then sits on a new binding while
 * the producer stays on the old one, and the phone reports the desktop as
 * offline. The watcher is the WebUI's stand-in for the Desktop's renderer,
 * which owns the binding and pushes it down whenever it changes.
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
  const dir = mkdtempSync(path.join(tmpdir(), "webui-rc-watch-"));
  dirs.push(dir);
  return dir;
}

/** A WebSocket that completes the handshake the way the gateway does. */
function socketFactory(urls: string[]) {
  return (url: string) => {
    urls.push(url);
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Waits for the phase to become what the test is waiting for. */
async function waitForPhase(
  controller: ReturnType<typeof createWebuiRemoteControl>,
  phase: string,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let current = "";
  while (Date.now() < deadline) {
    current = (await controller.getStatus()).phase;
    if (current === phase) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return current;
}

describe("the remote-control binding watcher", () => {
  it("picks up the binding the phone paired while the service was not looking", async () => {
    const dir = dataDir();
    const urls: string[] = [];
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
      wsFactory: socketFactory(urls),
      bindingWatchIntervalMs: 20,
      fetchImpl: (async (input: string | URL) => {
        if (String(input).includes("/desktop/bindings")) {
          return jsonResponse({
            binding: {
              state: "bound",
              binding_id: 4242,
              ticket: "ticket-1",
              endpoint: "wss://gateway.example.invalid/remote-control/v1/connect",
            },
          });
        }
        return jsonResponse({ binding: { state: "none" } });
      }) as unknown as typeof fetch,
    });

    // The first status read creates the proxy, and the proxy starts the watcher.
    await controller.getStatus();

    expect(await waitForPhase(controller, "connected")).toBe("connected");
    expect(urls.some((url) => url.includes("binding_id=4242"))).toBe(true);
  });

  it("follows the binding when the phone pairs again", async () => {
    const dir = dataDir();
    const urls: string[] = [];
    let bindingId = 4242;
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
      wsFactory: socketFactory(urls),
      bindingWatchIntervalMs: 20,
      fetchImpl: (async (input: string | URL) => {
        if (String(input).includes("/desktop/bindings")) {
          return jsonResponse({
            binding: {
              state: "bound",
              binding_id: bindingId,
              ticket: `ticket-${bindingId}`,
              endpoint: "wss://gateway.example.invalid/remote-control/v1/connect",
            },
          });
        }
        return jsonResponse({ binding: { state: "none" } });
      }) as unknown as typeof fetch,
    });

    await controller.getStatus();
    expect(await waitForPhase(controller, "connected")).toBe("connected");

    // The phone pairs again: the server hands out a new binding.
    bindingId = 4343;

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !urls.some((url) => url.includes("binding_id=4343"))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(urls.some((url) => url.includes("binding_id=4343"))).toBe(true);
  });
});
