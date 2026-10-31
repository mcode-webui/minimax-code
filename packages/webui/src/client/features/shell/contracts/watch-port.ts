// Shell event port.
//
// The process-event watcher. `watchEvents` belongs to `shell`: the shell is the
// composition root that opens the one channel per application instance
// (`client/main.tsx`), and the event coordinator consumes it. `turn` reads the
// events it needs from that channel rather than owning the watcher's
// declaration.
//
// The method stays optional — `undefined` means "the operation is not wired",
// and the application opens nothing when it is absent.

import type { WebuiRuntimeEvent } from "../../../../shared/contracts/stream.js";

export type WebuiClientEventWatcher = (
  onEvent: (event: WebuiRuntimeEvent) => void,
  /**
   * Fires when the server accepts `watchEvents` and starts pumping it — not
   * when the socket is created and not when the request is written. The
   * runtime's own subscription is established later still, when the server
   * first pulls the event iterator, so this is the right moment to re-read
   * authoritative state and re-probe for a running turn; it is not a
   * barrier that no `session.start` can slip past.
   */
  onReconnect?: () => void,
) => () => void;

export interface ShellEventPort {
  readonly watchEvents?: WebuiClientEventWatcher;
}
