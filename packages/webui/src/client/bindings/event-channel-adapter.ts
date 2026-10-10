// The transport-backed process-event channel adapter (ticket #45, pre-flip
// bridge).
//
// The application event coordinator consumes a `WebuiProcessEventChannel`
// (`application/event-channel.ts`); the only concrete source of that stream is
// the transport's `watchEvents` socket. This module is the adapter between the
// two: it turns the transport's event frames into the application channel shape
// the coordinator subscribes to.
//
// **Deliberate divergence from plan §7.2.** The plan names
// `client/infrastructure/event-channel.ts` as the home for this adapter, but an
// infrastructure module may not import `application/` (see `ALLOWED_EDGES` in
// `scripts/lib/webui-dependency-rules.mjs` and plan §3), and this adapter is an
// `application` shape wrapping `infrastructure` IO. The bindings layer may
// import both, so the adapter lives here instead. This is a reasoned placement,
// not a silent one: the plan's §7.1 row names the target *behaviour*, and the
// direction matrix, which is authoritative for edges, fixes the file's layer.
//
// It is the live adapter: the composition root opens one channel through
// `createWebuiOpenEventChannel` and the application coordinator consumes it
// (ticket #45, the atomic ingress flip).

import type {
  WebuiOpenEventChannel,
  WebuiProcessEventChannel,
} from "../application/event-channel.js";
import type { WebuiClientEventWatcher } from "../contracts/execution-port.js";

/**
 * Adapts one transport `watchEvents` watcher into the application's channel
 * shape. The transport already owns the `watchEvents` reconnection loop
 * (visibility/online + backoff), so `subscribe` is its raw registration: the
 * returned unsubscribe detaches only that listener, and `close` is left to the
 * application that owns the channel.
 */
export function createWebuiTransportEventChannel(
  watch: WebuiClientEventWatcher,
): WebuiProcessEventChannel {
  return {
    subscribe: (listener, onReady) => watch(listener, onReady),
  };
}

/**
 * The `openEventChannel` factory `createWebuiApplication` takes, backed by one
 * transport watcher. Opens exactly one channel when the application calls it
 * once.
 */
export function createWebuiOpenEventChannel(
  watch: WebuiClientEventWatcher,
): WebuiOpenEventChannel {
  return () => createWebuiTransportEventChannel(watch);
}
