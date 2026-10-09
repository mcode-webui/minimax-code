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
