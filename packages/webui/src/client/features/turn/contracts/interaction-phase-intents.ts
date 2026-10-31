// The narrow phase intents a non-Turn business may drive.
//
// The interaction flow decides *when* the phase moves — a pending permission gates
// the turn, an allowed one resumes it, a skipped questionnaire may end it. Turn owns
// the write and the vocabulary. So the flow is handed this view and nothing else:
// four named transitions over a `setStream` target, no state object, no generic
// writer it could reach another field through.
//
// Published here rather than left in `application/` because it needs neither the
// stream-loop mechanism nor the stream-state transforms. The full
// `WebuiStreamPhaseCommands` view does need them — its `settleStoppedStream` settles
// an aborted slice — so that one stays an implementation next door and extends this.

import type { WebuiStreamState } from "./stream-state.js";

/** The phases the stream slice can be moved to by name. */
export type WebuiStreamPhase = WebuiStreamState["phase"];

/**
 * The four phase transitions an interaction flow drives, and no others. A turn's
 * own `sending` flag and its lifecycle are not here: they belong to the submit, not
 * to the phase an interaction implies.
 */
export interface WebuiInteractionPhaseIntents {
  /** Move the stream's phase without touching any other field. */
  readonly markStreamPhase: (phase: WebuiStreamPhase) => void;
  /** A turn is live: it is streaming. */
  readonly startStreaming: () => void;
  /** The turn ends locally. */
  readonly endStreaming: () => void;
  /** A pending interaction gates the turn. */
  readonly awaitInteraction: () => void;
}

/** The write target these intents are bound to: the session's stream setter. */
export interface WebuiStreamPhaseWriteTarget {
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
}

/**
 * The intents over one session's stream setter. Every member writes `phase` and
 * nothing else — which is why a business that only decides *when* the phase moves
 * can hold this without holding the record.
 */
export function createWebuiInteractionPhaseIntents(
  targets: WebuiStreamPhaseWriteTarget,
): WebuiInteractionPhaseIntents {
  const { setStream } = targets;
  return {
    markStreamPhase: (phase) => setStream((current) => ({ ...current, phase })),
    startStreaming: () =>
      setStream((current) => ({ ...current, phase: "streaming" })),
    endStreaming: () => setStream((current) => ({ ...current, phase: "idle" })),
    awaitInteraction: () =>
      setStream((current) => ({ ...current, phase: "waiting" })),
  };
}
