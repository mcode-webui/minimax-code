// The turn business's published read surface for stream state.
//
// The composer needs to know whether a session it is about to inspect is still
// running, so it asks the owner that knows what a session status means rather
// than decoding the wire enum itself: `Started` is 1, and an early adapter may
// have sent a string. That normalisation is a turn fact — it is what the turn's
// own lifecycle observer matches on — so it lives here, published, instead of
// being re-derived from a peer's private projection.
//
// The reducers, the frame sink and the lease decisions stay in
// `stream-state.ts`: a peer reads the stream's status, it does not drive it.

import { recordValue } from "../../../contracts/value-readers.js";

/**
 * Session lists carry `SessionStatusInfoView.statusType` as a numeric enum
 * (`Started` is 1), while early WebUI adapters supplied a status string.
 * Normalize both shapes so refresh recovery can recognize active sessions.
 */
export function webuiSessionStatusType(value: unknown): string {
  const status = recordValue(value);
  const raw = status?.statusType ?? status?.type ?? value;
  if (raw === 1 || raw === "1") return "started";
  if (raw === 0 || raw === "0") return "idle";
  if (raw === 2 || raw === "2") return "error";
  if (raw === 3 || raw === "3") return "aborted";
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}
