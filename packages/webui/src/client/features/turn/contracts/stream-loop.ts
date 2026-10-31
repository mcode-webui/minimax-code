// The stream loop's *published* interface: what a caller hands the loop and
// what the loop hands back through its sink.
//
// These two shapes live here for the same reason the stream *state* types do
// (`./stream-state.ts`): a mechanism may import only `contracts` and `shared`,
// and the loop's own module is a mechanism. Declaring them beside
// the state they read means the mechanism imports them back instead of the
// caller having to name a mechanism-declared type, and it lets a business
// publish the command views it builds over them without reaching into
// `conversation/`.
//
// The loop, and the delivery port it runs against, are declared in
// `src/shared/contracts/delivery.ts` — the one layer a mechanism and a
// business command view can both name. They used to be declared here, so the
// mechanism imported this file back to type them — which is how a
// `refuse(reason, { transcriptIncomplete })` and a `setPhase` ended up on the
// loop's own vocabulary, and how the loop could name what a user sees. What is
// left here is the one shape that is genuinely Turn's: the fields an attaching
// attempt seeds.

/**
 * The stream fields an attachment may seed while it loads history. Closed on
 * purpose: the loop's attach path needs the context snapshot, the elapsed
 * anchor, the `resume_overflow` flag it is repairing and the refusal it clears —
 * and nothing else. It deliberately excludes `subscription` and
 * `lastClaimedGeneration`, which the generation fence reads; an extra that could
 * write them would let any holder of a superseded sink re-admit its own writes.
 */
export interface WebuiStreamLoopExtra {
  readonly contextUsage?: Record<string, unknown>;
  readonly processingStartedAtMs?: number;
  readonly resumeRequired?: boolean;
  readonly refusal?: string;
}
