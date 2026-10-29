// The Mini App page bridge's two operations over the real wire.
//
// `packages/webui/AGENTS.md` names this level as the evidence a new operation
// needs: a real `WebuiService` on a real loopback socket, the real operation
// registry and frame envelope, and the real stream dispatcher. What sits behind
// the port is scripted, so this proves the wire — envelopes, ordering, settlement
// and disconnect — and not that a Mini App process answered.
//
// Three claims are specific to this surface and are why the file exists:
//
//   * the unary call's refusal envelope survives the wire unchanged (`ok:false`
//     with a documented code, never a dropped connection);
//   * a followed turn's events arrive in order and the turn is settled by a frame,
//     not by the socket closing;
//   * a client that disconnects aborts the turn it was following, because the
//     runtime's run must not outlive the document that asked for it.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { WebuiService } from "../../src/server/service.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";
import { createMiniAppProxyRegistry } from "../../src/server/miniapp/proxy-registry.js";
import { createWebuiWire, type WebuiSocket } from "../../src/client/platform/wire.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "../../src/shared/contracts/miniapp-agent.js";
import type { MiniAppAgentRunEvent } from "@mavis/shared/miniapp-surface";

const PLUGIN = "loopback.miniapp";
const HOST_SESSION = "session-loopback";
const MINI_SESSION = "session-mini";

/** The `ws` client behind the wire's socket interface. */
class LoopbackSocket implements WebuiSocket {
  private readonly socket: WebSocket;
  constructor(url: string) {
    this.socket = new WebSocket(url);
  }
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    this.socket.addEventListener(type, (event) =>
      listener("data" in event ? { data: event.data } : {}),
    );
  }
  send(data: string): void {
    this.socket.send(data);
  }
  close(): void {
    this.socket.close();
  }
}

interface Recorded {
  readonly calls: WebuiMiniAppAgentCallRequest[];
  readonly turns: WebuiMiniAppAgentTurnRequest[];
  readonly signals: AbortSignal[];
}

function scriptedPort(): { port: WebuiHarnessPort; recorded: Recorded } {
  const recorded: Recorded = { calls: [], turns: [], signals: [] };
  const port = {
    version: () => ({ version: "loopback-fixture", protocolVersion: 1 }),
    close: async () => undefined,
    // A launch is what makes a page addressable at all: the handler records the
    // generation it carries, and every page call is checked against it.
    listMiniApps: async () => ({ miniApps: [] }),
    openMiniApp: async () => ({
      miniApp: {
        pluginId: PLUGIN,
        runtime: { kind: "process" as const, status: "running" as const },
      },
      launch: {
        origin: "http://127.0.0.1:1",
        surfacePath: "/",
        runId: "gen-loopback",
        credential: "loopback-credential",
        credentialHeader: "x-mavis-miniapp-token",
      },
    }),
    stopMiniApp: async () => undefined,
    openMiniAppAgentSession: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      hostSessionId: HOST_SESSION,
    }),
    panelOpenedMiniAppAgentSession: async (input: { sessionId: string; hostSessionId: string }) => {
      recorded.calls.push({
        pluginId: PLUGIN,
        hostSessionId: input.hostSessionId,
        connection: 1,
        requestId: "port-panel-open",
        method: "panelOpened",
        targetSessionId: input.sessionId,
      });
    },
    panelClosedMiniAppAgentSession: async () => undefined,
    replyMiniAppAgentPermission: async () => undefined,
    listMiniAppAgentModels: async () => ({
      models: [],
      default: { providerId: "p", modelId: "m" },
    }),
    listMiniAppAgentAgents: async () => ({ agents: [] }),
    listMiniAppAgentSessions: async () => ({ sessions: [] }),
    readMiniAppAgentSession: async () => undefined,
    createMiniAppAgentSession: async () => ({ sessionId: MINI_SESSION }),
    runMiniAppAgentTurn: (input: {
      caller: unknown;
      text: string;
      sessionId?: string;
      onEvent?: (event: MiniAppAgentRunEvent) => void;
      signal?: AbortSignal;
    }) => {
      recorded.turns.push({
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: "port-turn",
        method: "run",
        observe: input.onEvent !== undefined,
        text: input.text,
      });
      if (input.signal) recorded.signals.push(input.signal);
      const emit = input.onEvent;
      emit?.({
        type: "turn.started",
        sessionId: MINI_SESSION,
        turnId: "turn-1",
        model: { providerId: "p", modelId: "m" },
      });
      emit?.({
        type: "text.delta",
        sessionId: MINI_SESSION,
        turnId: "turn-1",
        text: "hel",
      });
      // `hold` keeps the turn open so the disconnect case can observe the abort;
      // every other turn finishes, which is what settles the stream with a frame.
      if (input.text !== "hold") {
        return Promise.resolve({
          sessionId: MINI_SESSION,
          turnId: "turn-1",
          model: { providerId: "p", modelId: "m" },
          status: "finished" as const,
          text: "done",
        });
      }
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { code: "REQUEST_CANCELLED" })),
        );
      });
    },
    answerMiniAppAgentQuestion: async () => {
      throw new Error("not used");
    },
  } as unknown as WebuiHarnessPort;
  return { port, recorded };
}

describe("the Mini App page bridge over the loopback wire", () => {
  let service: WebuiService | undefined;
  /**
   * The listeners the handler would otherwise keep privately.
   *
   * A Mini App's proxy port is derived from its plugin id, so a listener left
   * bound makes the next start of that plugin fail. The service owns the registry
   * it is given, and this file owns it here.
   */
  let proxies: ReturnType<typeof createMiniAppProxyRegistry> | undefined;

  afterEach(async () => {
    await service?.close();
    await proxies?.closeAll();
    service = undefined;
    proxies = undefined;
  });

  /**
   * One service per case, on its own Mini App plugin id.
   *
   * The proxy's loopback port is derived from the plugin id, so two cases sharing
   * one id would contend for the same port if a shutdown were ever slow.
   */
  async function connect(pluginId: string) {
    const { port, recorded } = scriptedPort();
    proxies = createMiniAppProxyRegistry();
    service = new WebuiService({
      port,
      operations: createOperationRegistry(port, undefined, undefined, undefined, proxies),
      credential: { token: "miniapp-agent-loopback" },
      webSocketHeartbeatIntervalMs: 30_000,
    });
    const info = await service.start();
    const wire = createWebuiWire({
      websocketUrl: `ws://127.0.0.1:${info.tcpPort}`,
      token: info.credential.token,
      webSocket: LoopbackSocket,
      requestTimeoutMs: 5_000,
    });
    // The page's view is open before anything may act as it.
    const opened = await wire.request("openMiniApp", { pluginId });
    return { wire, recorded, opened };
  }

  it("carries a unary call and its refusal envelope unchanged", async () => {
    const pluginId = "loopback.unary";
    const { wire, recorded, opened } = await connect(pluginId);
    expect(opened).toMatchObject({ pluginId: PLUGIN, connection: 1 });

    const openedSession = await wire.request("miniAppAgentCall", {
      pluginId: PLUGIN,
      hostSessionId: HOST_SESSION,
      connection: (opened as { connection: number }).connection,
      requestId: "call-open",
      method: "open",
      targetSessionId: MINI_SESSION,
    });
    expect(openedSession).toEqual({
      ok: true,
      method: "open",
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
    });

    await wire.request("miniAppAgentCall", {
      pluginId: PLUGIN,
      hostSessionId: HOST_SESSION,
      connection: 1,
      requestId: "call-panel",
      method: "panelOpened",
      targetSessionId: MINI_SESSION,
    });
    expect(recorded.calls[0]).toMatchObject({
      method: "panelOpened",
      targetSessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
    });

    // A body the validator refuses, and a generation this service never issued:
    // both answer a code rather than closing the socket or hanging.
    await expect(
      wire.request("miniAppAgentCall", {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        method: "models",
        targetSessionId: 42,
        // A request id past every bound the page may use: the body is refused
        // before any handler sees it.
        requestId: "x".repeat(200),
      } as never),
    ).rejects.toThrow();

    const stale = await wire.request("miniAppAgentCall", {
      pluginId: PLUGIN,
      hostSessionId: HOST_SESSION,
      connection: 99,
      requestId: "call-stale",
      method: "models",
    });
    expect(stale).toEqual({ ok: false, code: "runtime_unavailable" });
  });

  it("streams a followed turn's events and settles it with a frame", async () => {
    const { wire, recorded } = await connect("loopback.stream");
    const frames: WebuiMiniAppAgentTurnFrame[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const stop = wire.watchMiniAppAgentTurn(
        "watchMiniAppAgentTurn",
        {
          pluginId: PLUGIN,
          hostSessionId: HOST_SESSION,
          connection: 1,
          requestId: "turn-over-wire",
          method: "run",
          observe: true,
          text: "hello over the socket",
        },
        (frame) => {
          frames.push(frame);
          if (frame.kind !== "event") {
            stop();
            resolve();
          }
        },
        reject,
      );
    });
    await done;

    expect(frames.map((frame) => frame.kind)).toEqual(["event", "event", "settled"]);
    expect(recorded.turns[0]).toMatchObject({
      text: "hello over the socket",
      observe: true,
    });
  });

  it("aborts the turn it was following when the client goes away", async () => {
    const { wire, recorded } = await connect("loopback.disconnect");
    const seen: WebuiMiniAppAgentTurnFrame[] = [];
    const firstEvent = new Promise<void>((resolve) => {
      const stop = wire.watchMiniAppAgentTurn(
        "watchMiniAppAgentTurn",
        {
          pluginId: PLUGIN,
          hostSessionId: HOST_SESSION,
          connection: 1,
          requestId: "turn-disconnect",
          method: "run",
          observe: true,
          text: "hold",
        },
        (frame) => {
          seen.push(frame);
          if (frame.kind === "event") {
            resolve();
            // The document goes away mid-turn; the server must abort the run.
            stop();
          }
        },
        () => undefined,
      );
    });
    await firstEvent;

    const signal = recorded.signals[0];
    expect(signal).toBeDefined();
    for (let tick = 0; tick < 40 && !signal?.aborted; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(signal?.aborted).toBe(true);
  });
});
