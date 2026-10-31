// The observation seam, as a contract between the application's scheduler and the
// businesses that register reads with it.
//
// It lives in `shared/` because more than one business hands it work and none of
// them should import the scheduler's implementation to say "read this again".

export interface WebuiObservationSignal {
  /**
   * Whether the result this read is producing is still wanted.
   *
   * A read that takes longer than the thing that asked for it must not apply its
   * answer; the alternative was a caller-owned cancel token, which carries the
   * same information and gets it wrong more often.
   */
  readonly isCurrent: () => boolean;
}

export interface WebuiObservationRequest {
  /** Stable across refreshes: search text and object identity are not identity. */
  readonly identity: string;
  readonly run: (signal: WebuiObservationSignal) => Promise<void>;
}

export interface WebuiObservationSink {
  readonly setInspectionInterest: (requests: readonly WebuiObservationRequest[]) => void;
}
