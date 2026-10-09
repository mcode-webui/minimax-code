// Execution capability port.
//
// Send / queue / resume / stop, the turn-event stream, the active-turn probe
// and the command runner. Split from the monolithic `WebuiTransport` in the
// former `client/contracts.ts`; `transport.ts` composes it. Every method stays
// optional — `undefined` means "the operation is not wired".

import type { WebuiAttachmentInput } from "../../shared/contracts/messages.js";
import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../../shared/contracts/queue.js";
import type {
  WebuiActiveTurnRequest,
  WebuiActiveTurnResult,
} from "../../shared/contracts/session.js";
import type {
  WebuiRuntimeEvent,
  WebuiStreamFrame,
} from "../../shared/contracts/stream.js";

export type WebuiClientMessageSender = (
  request: {
    readonly id: string;
    readonly content: string;
    readonly clientIntent?: string;
    readonly attachments?: readonly WebuiAttachmentInput[];
  },
  onFrame: (frame: WebuiStreamFrame) => void,
) => Promise<void>;

export type WebuiClientMessageEnqueuer = (
  request: WebuiEnqueueMessageRequest,
) => Promise<WebuiEnqueueMessageResult>;

export type WebuiClientSessionResumer = (
  request: {
    readonly id: string;
    readonly afterCursor?: string;
    readonly afterMsgId?: string;
    readonly drainQueued?: boolean;
  },
  onFrame: (frame: WebuiStreamFrame) => void,
) => Promise<void>;

export type WebuiClientEventWatcher = (
  onEvent: (event: WebuiRuntimeEvent) => void,
  /**
   * Fires when the server accepts `watchEvents` and starts pumping it — not
   * when the socket is created and not when the request is written. The
   * runtime's own subscription is established later still, when the server
   * first pulls the event iterator, so this is the right moment to re-read
   * authoritative state and re-probe for a running turn; it is not a
   * barrier that no `session.start` can slip past.
   */
  onReconnect?: () => void,
) => () => void;

export interface ExecutionPort {
  readonly sendMessage?: WebuiClientMessageSender;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly resumeSession?: WebuiClientSessionResumer;
  readonly watchEvents?: WebuiClientEventWatcher;
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
  readonly listQueueMessages?: (request: {
    readonly id: string;
  }) => Promise<{
    readonly items?: readonly WebuiQueueItem[];
    readonly paused?: boolean;
    readonly pendingCount?: number;
  }>;
  readonly deleteQueueItem?: (request: {
    readonly id: string;
    readonly itemId: string;
  }) => Promise<{ readonly item?: WebuiQueueItem }>;
  readonly runCommand?: (request: {
    readonly command: "help" | "new" | "compact" | "status" | "usage" | "model";
    readonly input?: string;
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  }) => Promise<Record<string, unknown>>;
}
