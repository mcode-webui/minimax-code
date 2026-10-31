// The transport-backed process-event channel adapter.
//
// The application event coordinator consumes a `WebuiProcessEventChannel`
// (`features/turn/application/event-channel.ts`); the only concrete source of that stream is
// the transport's `watchEvents` socket. This module is the adapter between the
// two: it turns the transport's event frames into the application channel shape
// the coordinator subscribes to.
//
// The adapter lives here because it is an `application` shape wrapping
// `infrastructure` IO: an infrastructure module may not import `application/`,
// while the bindings layer may import both (`ALLOWED_EDGES` in
// `scripts/lib/webui-dependency-rules.mjs`).
//
// It is the live adapter: the composition root opens one channel through
// `createWebuiOpenEventChannel` and the application coordinator consumes it.

import type {
  WebuiOpenEventChannel,
  WebuiProcessEventChannel,
} from "../features/turn/application/event-channel.js";
import type {WebuiClientEventWatcher} from "../features/shell/contracts/watch-port.js";

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
