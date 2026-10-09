// The queue command (plan §7.1 `application/` turn coordinator: "owns
// send/queue/stop/retry").
//
// Queueing is what a send becomes when a turn is already in flight: rather than
// racing the running turn, the message drains behind it. The orchestration —
// enqueue against the transport, clear the draft, hand off attachments, refresh
// the queue panel, and surface a refusal inline on failure — used to live inside
// `submitWebuiComposerTurn`'s `sending` branch in `projection/composer-state.ts`.
// It moves here so the application owns the command, and `composer-state` calls
// this one implementation rather than carrying its own copy.
//
// Kept deliberately dependency-light (no import of `composer-state`, so the
// latter can call in without forming a cycle): the only collaborator is the
// error formatter.

import type { WebuiClientMessageEnqueuer } from "../contracts/execution-port.js";
import type { WebuiAttachmentInput } from "../../shared/contracts/messages.js";
import { formatWebuiError } from "../value-readers.js";

export interface WebuiQueueTurnArgs {
  readonly sessionId: string;
  readonly message: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly onDraftChange: (next: string) => void;
  readonly onAttachmentsSubmitted?: () => void;
  readonly onQueued?: () => void;
  /** Records a user-visible refusal from a failed enqueue. */
  readonly setRefusal: (refusal: string) => void;
}

/**
 * Queue one composer turn behind the running one. A no-op when the transport
 * wires no enqueuer (the composer still shows the queue panel, but there is
 * nothing to put on the wire).
 */
export async function queueWebuiTurn(args: WebuiQueueTurnArgs): Promise<void> {
  if (!args.enqueueMessage) return;
  try {
    await args.enqueueMessage({
      id: args.sessionId,
      content: args.message,
      ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}),
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });
    args.onDraftChange("");
    args.onAttachmentsSubmitted?.();
    args.onQueued?.();
  } catch (error) {
    args.setRefusal(formatWebuiError(error));
  }
}
