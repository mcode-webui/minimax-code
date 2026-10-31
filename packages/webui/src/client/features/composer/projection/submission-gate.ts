/**
 * The composer's submission gate, read by both the send button and the editor's
 * Enter handler.
 *
 * It was two expressions inline in the component, which made the one
 * rule — the button and Enter accept exactly the same submissions — impossible
 * to check without rendering the whole composer, and possible to drift apart one
 * edit at a time. As a read it has one definition and one test; the component
 * computes it once per render and hands the same value to both consumers.
 *
 * Two destinations satisfy a submission: sending (the substrate can send for
 * this session) and queueing (the substrate can enqueue for a known session).
 * Either is enough — a session that has been archived for sending but still
 * accepts a queue entry can be queued to — and something must be submitted: a
 * non-empty draft or at least one staged attachment.
 *
 * A submission already in flight blocks the next one: both the slash command
 * runner and a goal submit hold the gate, so a second Enter cannot start a
 * second turn on top of the first.
 */

export interface WebuiComposerSubmitGateInput {
  /** The substrate publishes a send for this session. */
  readonly canCompose: boolean;
  /** The substrate publishes an enqueue for this session. */
  readonly canQueue: boolean;
  /** The draft as the editor holds it; whitespace counts, as it always has. */
  readonly draft: string;
  /** How many attachments and URL references are staged. */
  readonly attachmentCount: number;
  /** A slash command is running. */
  readonly commandRunning: boolean;
  /** A goal submission is in flight. */
  readonly goalSubmitting: boolean;
}

export interface WebuiComposerSubmitGate {
  /** There is something to submit and somewhere to submit it. */
  readonly sendable: boolean;
  /** The send button is disabled and Enter does not submit. */
  readonly submitBlocked: boolean;
}

export function readWebuiComposerSubmitGate(
  input: WebuiComposerSubmitGateInput,
): WebuiComposerSubmitGate {
  const hasInput = input.draft.length > 0 || input.attachmentCount > 0;
  const sendable = (input.canCompose || input.canQueue) && hasInput;
  return {
    sendable,
    submitBlocked: !sendable || input.commandRunning || input.goalSubmitting,
  };
}
