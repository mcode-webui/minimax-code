// The process-event channel abstraction (plan §7.1 `client/application/`).
//
// One channel is opened per application instance, and the application's event
// coordinator is its *sole* consumer: components never subscribe to the raw
// process-event stream, they subscribe to application snapshots. This module
// declares only the shape; the concrete transport-backed channel and its
// reconnection live in `client/infrastructure/` and are supplied at
// composition time, which is what keeps `application` off the transport.

import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";

/**
 * The single long-lived subscription to the server's process events.
 *
 * `subscribe` registers one listener and returns an unsubscribe that detaches
 * *only that listener*. It never tears the channel down: the channel's lifetime
 * is the application instance, not a component mount. `close` (when the
 * transport offers one) ends the channel and is owned by the application, not
 * by any subscriber.
 *
 * `onReady` mirrors the transport's `watchEvents` acceptance callback: it fires
 * when the server has accepted the request and started pumping, not when a
 * socket opened. It is not a subscription barrier — a `session.start` can still
 * slip past it — so consumers re-probe rather than assume they saw everything.
 */
export interface WebuiProcessEventChannel {
  readonly subscribe: (
    listener: (event: WebuiRuntimeEvent) => void,
    onReady?: () => void,
  ) => () => void;
  readonly close?: () => void;
}

/** Opens the process-event channel. Called exactly once per application. */
export type WebuiOpenEventChannel = () => WebuiProcessEventChannel;
