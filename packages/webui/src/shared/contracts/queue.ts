// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiEnqueueMessageRequest` | Request to enqueue a message (id, content, model, attachments). | Browser `client/transport.ts` (`enqueueMessage`). | `client/contracts/execution-port.ts`; runtime `enqueueMessage`; `server/operation/interaction.ts`. |
// | `WebuiEnqueueMessageResult` | The enqueue outcome (itemId, status, position). | Runtime `enqueueMessage` (`runtime/harness/execution.ts`; CliService). | `client/contracts/execution-port.ts`; `client/transport.ts`; `server/operation/interaction.ts`. |
// | `WebuiQueueItem` | One queued message in a session's queue. | Runtime `listQueueMessages` (`runtime/harness/execution.ts`). | `client/contracts/execution-port.ts`; `client/components/SessionComposer.tsx`; `client/components/QueuePanel.tsx`; `server/operation/queue.ts`. |
import type { WebuiAttachmentInput } from "./messages.js";

export interface WebuiEnqueueMessageRequest {
  readonly id: string;
  readonly content: string;
  readonly model?: Record<string, unknown>;
  readonly clientRequestId?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
}

export interface WebuiEnqueueMessageResult {
  readonly itemId?: string;
  readonly status?: string;
  readonly position?: number;
}

export interface WebuiQueueItem {
  readonly itemId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly content?: string;
  readonly source?: string;
  readonly failedReason?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}
