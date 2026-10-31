// WebSocket lifecycle for the loopback service: the upgrade admission path,
// the open-socket set, the liveness heartbeat and connection close. Split from
// `service.ts` with no behaviour change — the upgrade decision, the heartbeat
// interval and the forced-termination order are the ones the service wrote
// before.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { admitWebSocketUpgrade, parseWebSocketUrl, rejectUpgrade } from "./access-policy.js";
import type { BrowserBridgeServer } from "./browser-bridge/server.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../shared/contracts/browser-bridge.js";
import { handleInboundFrame } from "./frame-handler.js";
import type { WebuiOperationRegistryEntry } from "./operation/operations.js";
import type { WebuiCredential } from "./credentials.js";

export interface WebuiWebSocketServerContext {
  readonly maxMessageBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly host: string;
  /** The TCP port the kernel allocated, once `start()` has resolved. */
  readonly boundTcpPort: () => number | undefined;
  readonly credential: WebuiCredential;
  readonly dev: boolean;
  readonly operations: ReadonlyMap<string, WebuiOperationRegistryEntry>;
  readonly isAccepting: () => boolean;
  /**
   * The extension bridge, when one is wired.
   *
   * Optional because a host that has no bridge still serves the page: the
   * upgrade branch below refuses a bridge request outright rather than letting
   * it fall through to an admission that would refuse it for the wrong reason.
   */
  readonly browserBridge?: BrowserBridgeServer;
}

export class WebuiWebSocketServer {
  readonly server: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly connectionSignals = new Map<WebSocket, AbortController>();
  private readonly connectionAlive = new WeakMap<WebSocket, boolean>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly context: WebuiWebSocketServerContext) {
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: context.maxMessageBytes,
    });
    this.server.on("connection", this.#onConnection);
  }

  handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!this.context.isAccepting()) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          "Connection: close\r\n" +
          "\r\n",
      );
      socket.destroy();
      return;
    }
    const url = parseWebSocketUrl(request.url);
    if (!url) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    // The bridge is a different socket with a different credential and a
    // different origin rule, so it is routed BEFORE the generic admission and
    // the generic path never sees it. The order matters in both directions: a
    // bridge request must not be judged by the bearer-token rule, and the page
    // path must not be widened to admit `chrome-extension://` origins in order
    // to make the bridge work (ADR 0019).
    if (url.pathname === WEBUI_BROWSER_BRIDGE_PATH) {
      if (!this.context.browserBridge) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      this.context.browserBridge.handleUpgrade(request, socket, head);
      return;
    }
    if (
      !admitWebSocketUpgrade(request, url, socket, {
        host: this.context.host,
        tcpPort: this.context.boundTcpPort,
        credential: this.context.credential,
        dev: this.context.dev,
      })
    ) {
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.server.emit("connection", ws, request);
    });
  };

  #onConnection = (ws: WebSocket): void => {
    if (!this.context.isAccepting()) {
      ws.close(1001, "service shutting down");
      return;
    }
    this.connections.add(ws);
    this.connectionAlive.set(ws, true);
    if (this.heartbeatTimer === undefined) {
      this.heartbeatTimer = setInterval(() => {
        for (const connection of this.connections) {
          if (this.connectionAlive.get(connection) === false) {
            connection.terminate();
            continue;
          }
          this.connectionAlive.set(connection, false);
          try {
            connection.ping();
          } catch {
            connection.terminate();
          }
        }
      }, this.context.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    const connectionController = new AbortController();
    this.connectionSignals.set(ws, connectionController);
    ws.on("pong", () => this.connectionAlive.set(ws, true));
    ws.on("close", () => {
      this.connections.delete(ws);
      connectionController.abort();
      this.connectionSignals.delete(ws);
    });
    ws.on("error", () => {
      this.connections.delete(ws);
      connectionController.abort();
      this.connectionSignals.delete(ws);
    });
    ws.on("message", (raw, isBinary) => {
      void handleInboundFrame(ws, raw, isBinary, {
        maxMessageBytes: this.context.maxMessageBytes,
        operations: this.context.operations,
        accepting: this.context.isAccepting(),
        signalFor: () => this.connectionSignals.get(ws)?.signal,
      });
    });
  };

  /**
   * Force-terminate every connection and stop the heartbeat, before the server
   * closes. Otherwise `server.close()` waits for the client to ack the close
   * handshake and can hang for the duration of the platform TCP timeout.
   */
  closeConnections(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const connection of this.connections) {
      this.connectionSignals.get(connection)?.abort();
      try {
        connection.terminate();
      } catch {
        // ignore: the connection is already torn down.
      }
    }
    this.connections.clear();
    this.connectionSignals.clear();
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
