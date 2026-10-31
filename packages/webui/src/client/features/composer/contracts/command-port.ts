// Composer capability port.
//
// The queue's four members and the command runner. `composer` owns `runCommand`,
// the queue's commands and the queue's state; `turn` keeps only the queue's
// *command* — so the queue's own request/result members live here, with the business
// that owns the state they write.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../../../../shared/contracts/queue.js";

export type WebuiClientMessageEnqueuer = (
  request: WebuiEnqueueMessageRequest,
) => Promise<WebuiEnqueueMessageResult>;

export interface ComposerPort {
  readonly runCommand?: (request: {
    readonly command: "help" | "new" | "compact" | "status" | "usage" | "model";
    readonly input?: string;
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  }) => Promise<Record<string, unknown>>;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
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
}
