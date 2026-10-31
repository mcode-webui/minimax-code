// Turn execution capability port.
//
// The substrate's four execution members. The execution surface is split three
// ways: these four are `turn`'s (`client/features/turn/contracts/execution-port.ts`),
// `runCommand` and the queue members are the composer's
// (`client/features/composer/contracts/command-port.ts`), and the process-event
// watcher is the shell's (`client/features/shell/contracts/watch-port.ts`).
//
// `sendMessage` and `resumeSession` are the two members the substrate drives.
// `abortSession` and `getActiveTurn` are assigned here too, because `turn` owns
// the in-flight read (the active-turn probe) and the turn commands
// (attach/send/stop/retry) — the stop command's capability is `abortSession`.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";
import type {
  WebuiActiveTurnRequest,
  WebuiActiveTurnResult,
} from "../../../../shared/contracts/session.js";
import type { WebuiStreamFrame } from "../../../../shared/contracts/stream.js";

/**
 * The client's half of an accepted delivery.
 *
 * Closing it stops **this client** observing the attempt — no further frames are
 * delivered — and nothing else: the host turn keeps running, and cancelling it
 * stays a separate command. That separation is the whole point of the handle, so
 * a delivery that is detached is not a delivery that was aborted.
 */
export interface WebuiDeliveryHandle {
  readonly close: () => void;
}

export type WebuiClientMessageSender = (
  request: {
    readonly id: string;
    readonly content: string;
    readonly clientIntent?: string;
    readonly attachments?: readonly WebuiAttachmentInput[];
  },
  onFrame: (frame: WebuiStreamFrame) => void,
  /**
   * Receives the delivery handle once the attempt has opened, so the caller can
   * keep the actual disposer rather than a promise it cannot reach into. An
   * implementation that cannot cancel simply never calls it.
   */
  onDelivery?: (handle: WebuiDeliveryHandle) => void,
) => Promise<void>;

export type WebuiClientSessionResumer = (
  request: {
    readonly id: string;
    readonly afterCursor?: string;
    readonly afterMsgId?: string;
    readonly drainQueued?: boolean;
  },
  onFrame: (frame: WebuiStreamFrame) => void,
  onDelivery?: (handle: WebuiDeliveryHandle) => void,
) => Promise<void>;

export interface TurnExecutionPort {
  readonly sendMessage?: WebuiClientMessageSender;
  readonly resumeSession?: WebuiClientSessionResumer;
  /**
   * Authoritative active-turn read. Answers "is a turn running, and which
   * one" when the `session.start` event was missed or arrived before the
   * client finished subscribing.
   */
  readonly getActiveTurn?: (
    request: WebuiActiveTurnRequest,
  ) => Promise<WebuiActiveTurnResult>;
  readonly abortSession?: (request: {
    readonly id: string;
  }) => Promise<{ readonly success?: boolean }>;
}
