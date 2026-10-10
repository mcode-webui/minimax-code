// Request ownership for late results (ticket #45: "a result belonging to a
// previously selected session is not applied to the current one").
//
// The failure this closes: the user selects session A, a query — a goal read, a
// history load, a resume anchor — is issued for A, the user switches to B before
// it answers, and the answer for A lands in the view the user is now looking at.
// The result is not wrong, it is *stale for the selection*, and applying it
// stamps A's facts onto B.
//
// A ticket captures the session the request was issued for. A completion is
// applied only while that session is still the selected one. The check runs at
// *completion* time against the live selection, not at issue time, because the
// selection can move during the round trip — that is exactly the case a
// call-time check would miss.

export interface WebuiRequestTicket {
  readonly sessionId: string;
}

export interface WebuiRequestOwnership {
  /** Capture the session a request is issued for. */
  capture: (sessionId: string) => WebuiRequestTicket;
  /** True while the ticket's session is still the selected one. */
  owns: (ticket: WebuiRequestTicket) => boolean;
  /**
   * Wrap a completion so it runs only when the ticket still owns the
   * selection. Returns the guard; the caller passes the value through.
   */
  guard: <T>(
    ticket: WebuiRequestTicket,
    apply: (value: T) => void,
  ) => (value: T) => void;
}

export function createWebuiRequestOwnership(
  readSelectedSessionId: () => string | undefined,
): WebuiRequestOwnership {
  return {
    capture: (sessionId) => ({ sessionId }),
    owns: (ticket) => readSelectedSessionId() === ticket.sessionId,
    guard:
      (ticket, apply) =>
      (value) => {
        if (readSelectedSessionId() !== ticket.sessionId) return;
        apply(value);
      },
  };
}
