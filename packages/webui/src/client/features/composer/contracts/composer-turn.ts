import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";
import type { WebuiTaskSessionSubmitter } from "../../turn/contracts/submission.js";
import type {
  WebuiDeliverySink,
  WebuiDeliveryTransports,
} from "../../../../shared/contracts/delivery.js";
import type { WebuiStreamState } from "../../turn/contracts/stream-state.js";
import type { WebuiClientMessageEnqueuer } from "./command-port.js";

export interface WebuiRecordedTurn {
  readonly session: string | undefined;
  readonly message: string;
}

export interface WebuiComposerSubmitArgs {
  readonly sessionId?: string;
  readonly draft: string;
  readonly message?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly sending: boolean;
  /**
   * The transports the turn's loop drives. It is the loop's transport half, not
   * its whole dependency object: the two injected transforms are the caller's to
   * supply, and this workflow supplies them itself.
   */
  readonly deps: WebuiDeliveryTransports;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  /**
   * The task use case the submission creates through. It replaced a raw `createSession`: creation
   * is single-flight per home incarnation, it transfers the home record under the destination-wins
   * and purge guards, and it is what reports whether the created session may be selected. Absent
   * means the host cannot create, which the submission reports as `unsupported`.
   */
  readonly submitTask?: WebuiTaskSessionSubmitter;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
}

export interface WebuiComposerSubmitHandlers {
  /**
   * A fresh, generation-fenced sink for this turn's stream loop. The caller
   * never receives the stream writer itself, so no caller can write a slice
   * field directly or skip the fence.
   */
  readonly createSink: () => WebuiDeliverySink;
  /** Reset the stream slice for a turn that is about to open. */
  readonly resetStreamForTurn: () => void;
  /**
   * The session a first message created, with the use case's selection decision: `selected` is false
   * when the navigation claim that started the creation is no longer current, so the caller must not
   * select a session the user has already navigated away from.
   */
  readonly onSessionCreated?: (sessionId: string, selected: boolean) => void;
  /** Record (or clear) the refusal the transcript banner renders. */
  readonly setRefusal: (refusal: string | undefined) => void;
  readonly readStream?: () => WebuiStreamState;
  readonly setSending: (sending: boolean) => void;
  readonly onNeedsSession?: (draft: string) => void;
  readonly onQueued?: () => void;
}
