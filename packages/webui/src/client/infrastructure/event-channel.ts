// The single long-lived `watchEvents` channel (plan §7.2
// `client/infrastructure/event-channel.ts`, split from `transport.ts`).
//
// One channel per application instance, with its reconnection policy: the socket
// reconnects after a close, and immediately when the document becomes visible or
// the browser reports it is online. It owns no business state — it reports
// connection facts through `connection-health` and hands every event body to the
// caller.
//
// Split out of `transport.ts` so the channel's lifecycle is one module: the
// transport keeps request/response IO and the independent streams (session and
// terminal), and this file owns the one channel that outlives them.

import {
  markWebuiEventWatcherDown,
  markWebuiEventWatcherHealthy,
  registerWebuiEventWatcher,
  unregisterWebuiEventWatcher,
} from "./connection-health.js";
import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";

declare const document: {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
declare const window: {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
};

type WireFrame = {
  readonly kind: string;
  readonly requestId: string;
  readonly body?: unknown;
  readonly message?: string;
};

export interface WebuiSocket {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type WebuiClientRuntimeEvent = WebuiRuntimeEvent;

export type WebuiClientEventWatcher = (
  onEvent: (event: WebuiClientRuntimeEvent) => void,
  onReconnect?: () => void,
) => () => void;

/** Everything the channel needs from the transport that owns the socket factory. */
export interface WebuiEventChannelOptions {
  readonly websocketUrl: () => string;
  readonly webSocket: new (url: string) => WebuiSocket;
}

export function createWebuiEventChannel({
  websocketUrl,
  webSocket,
}: WebuiEventChannelOptions): WebuiClientEventWatcher {
  return (
    onEvent: (event: WebuiClientRuntimeEvent) => void,
    onReconnect?: () => void,
  ): (() => void) => {
    // This socket is the page's only long-lived link while no turn runs, so
    // its health is the user's "am I still connected" signal between turns.
    // Reported from inside the transport so every watcher — the shell's and
    // any panel's — counts without each call site wiring callbacks; the
    // store's ever-healthy rule keeps boot quiet.
    const watcherToken = registerWebuiEventWatcher();
    let stopped = false;
    let socket: WebuiSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const ws = new webSocket(websocketUrl());
      socket = ws;
      const requestId = crypto.randomUUID();
      // Fires when the server *accepts* the `watchEvents` request, not when
      // the socket is created and not when the request is written. It is an
      // acceptance signal, **not** proof that the runtime's event bus has
      // subscribed: `watchProcessEvents` is an async generator whose body —
      // where `subscribe()` lives — does not run until the first `next()`,
      // and the server pumps the iterator after answering. Do not read this
      // as "no event can slip past from here".
      let acknowledged = false;
      ws.addEventListener("open", () => {
        if (stopped) return;
        ws.send(
          JSON.stringify({
            protocolVersion: 1,
            kind: "request",
            requestId,
            operation: "watchEvents",
            body: {},
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        if (stopped) return;
        let frame: WireFrame;
        try {
          frame = JSON.parse(String(event.data)) as WireFrame;
        } catch {
          return;
        }
        if (frame.requestId !== requestId) return;
        if (frame.kind === "error") return;
        if (frame.kind === "response") {
          markWebuiEventWatcherHealthy(watcherToken);
          if (acknowledged) return;
          acknowledged = true;
          // Fires once per connection: the first ack is the initial
          // watcher-ready signal, every later one follows a reconnect.
          onReconnect?.();
          return;
        }
        if (frame.kind !== "event") return;
        const body = frame.body;
        if (body && typeof body === "object" && !Array.isArray(body))
          onEvent(body as WebuiClientRuntimeEvent);
      });
      ws.addEventListener("close", () => {
        if (stopped || socket !== ws) return;
        socket = undefined;
        markWebuiEventWatcherDown(watcherToken);
        reconnectTimer = setTimeout(connect, 250);
      });
      ws.addEventListener("error", () => undefined);
    };
    const reconnectWhenAvailable = () => {
      if (
        stopped ||
        (typeof document !== "undefined" && document.visibilityState === "hidden")
      )
        return;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const previous = socket;
      socket = undefined;
      previous?.close();
      connect();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", reconnectWhenAvailable);
    if (typeof window !== "undefined")
      window.addEventListener("online", reconnectWhenAvailable);
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", reconnectWhenAvailable);
      if (typeof window !== "undefined")
        window.removeEventListener("online", reconnectWhenAvailable);
      socket?.close();
      unregisterWebuiEventWatcher(watcherToken);
    };  };
}
