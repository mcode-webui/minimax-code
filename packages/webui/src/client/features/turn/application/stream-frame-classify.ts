// Reading a frame's recovery signal.
//
// The loop knows what to *do* when the server says a view has fallen too far
// behind — reload history, subscribe again from the latest persisted point. It
// does not know what a payload *means*, so that stays here, on the Turn side,
// with the recogniser that already defines it.
//
// One function rather than an injected bundle: the loop takes a classifier as a
// single structural callback so a mechanism stays a mechanism, and this is the
// one place that supplies it.

import type { WebuiStreamFrame } from "../../../../shared/contracts/stream.js";
import type { WebuiDeliverySignal } from "../../../../shared/contracts/delivery.js";
import { streamStateBundle } from "./stream-state-bundle.js";

/**
 * Does this frame ask the attempt to reload authoritative history?
 *
 * The shared recogniser is what the reducer and this both read, so a future
 * envelope change touches one place — which was the reason it was extracted from
 * the reducer in the first place.
 */
export function classifyStreamFrame(frame: WebuiStreamFrame): WebuiDeliverySignal {
  return streamStateBundle.recognisePayload(frame.dataJson).kind === "resume_overflow"
    ? { kind: "reload_history" }
    : { kind: "continue" };
}
