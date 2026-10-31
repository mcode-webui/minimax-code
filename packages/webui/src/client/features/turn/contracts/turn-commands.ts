import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";
import type { WebuiSubmissionTicket } from "./submission.js";
import type {
  WebuiStreamPhaseCommands,
  WebuiTurnLifecycleCommands,
} from "./turn-command-views.js";

export interface WebuiComposerTurnCallbacks {
  readonly onNeedsSession?: (draft: string) => void;
  /**
   * The session a first message created, with the use case's selection decision: the transfer and the
   * composer's slot move have already happened, and `selected` says whether the navigation claim that
   * started the creation is still current.
   */
  readonly onSessionCreated?: (sessionId: string, selected: boolean) => void;
  readonly onQueued?: () => void;
}

/**
 * What a surface submits: intent and data, never a setter.
 *
 * The `callbacks` bag this replaces was four business setters per call — a draft
 * writer, a created-session handler, a needs-session handler and a queue handler
 * — which meant the caller had to know which branch fired which one, and a
 * callback could write a business field the submission never knew it was
 * changing. Everything the caller still needs is now either in the ticket's
 * admission or in its completion.
 */
export interface WebuiTurnSendIntent {
  readonly message: string;
  readonly clientIntent?: string;
  readonly planMode?: boolean;
  readonly attachments?: readonly WebuiAttachmentInput[];
  /**
   * There is deliberately no staging-clear callback here.
   *
   * Staging is the composer's own input, so *it* consumes it, on the admission the
   * turn owner just decided. A callback on the intent made the caller responsible
   * for a business write whose timing it could not see — and every caller that
   * forgot it leaked staged files into a submission that had already happened.
   */
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
}

/** Commands exposed to a conversation surface by application composition. */
export interface WebuiConversationTurnCommands {
  /**
   * Submit a turn and get its ticket, or `undefined` when the intent carried
   * nothing to submit.
   *
   * The ticket is returned synchronously: its `admission` is already decided, and
   * its `completion` settles later and never rejects. A caller reads the decision
   * now and the outcome later, instead of awaiting a promise that carried both.
   */
  readonly send: (intent: WebuiTurnSendIntent) => WebuiSubmissionTicket | undefined;
  readonly attach: (turnId: string | undefined) => void;
  readonly recheck: (turnId: string | undefined) => void;
  readonly recover: () => void;
  readonly stop: () => Promise<void>;
  /**
   * The stream-phase and turn-lifecycle views for this target, built from the
   * owner's own record writer. A consumer handed one of them cannot reach the
   * other's writes, and neither can reach the store directly — and because the
   * owner builds them, a surface hands out no writer of its own and assembles no
   * second command context.
   */
  readonly phase: WebuiStreamPhaseCommands;
  readonly lifecycle: WebuiTurnLifecycleCommands;
}
