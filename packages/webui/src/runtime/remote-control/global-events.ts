// The bridge's global-event source.
//
// The bridge wants "events that were already decoded and admitted against the frontend Global
// Event catalogue" — it does not want transport, and it does not want to know what a Thrift frame
// is. The WebUI's runtime already publishes exactly that: `cliService.watchEvents()` yields the
// admitted `GlobalEvent`s, the same ones the browser's event channel receives.
//
// The subscription is tied to the signal the bridge hands over, so a dropped WebSocket ends the
// runtime subscription with it. The bridge owns the retry: it re-opens the source after a
// failure, and the source therefore only has to hand back one clean iteration.
import type { WebuiRuntimeCliService } from "../harness/host-contract.js";
import type { RcGlobalEvent, RcGlobalEventSource } from "./bridge/types.js";

export interface RemoteControlGlobalEventOptions {
  readonly cliService: WebuiRuntimeCliService;
}

/**
 * The runtime's admitted event stream, as the bridge's event source.
 *
 * The payload is re-emitted as an open record: the bridge's `RcGlobalEvent` is host-neutral and
 * its own mapper reads the fields it needs. The catalogue's payload type is a per-type union, so
 * the widening happens here, once, instead of at every read site.
 */
export function createRemoteControlGlobalEventSource(
  options: RemoteControlGlobalEventOptions,
): RcGlobalEventSource {
  return async function* source(signal: AbortSignal): AsyncIterable<RcGlobalEvent> {
    for await (const event of options.cliService.watchEvents(signal)) {
      yield {
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload as unknown as Record<string, unknown>,
      };
    }
  };
}
