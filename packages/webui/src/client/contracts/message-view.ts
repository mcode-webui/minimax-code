// Browser-local message view types.
//
// Projection outputs and loader inputs the components consume. Split from the
// former `client/contracts.ts`; nothing here crosses the process boundary.

import type { WebuiFileDiffInfoView } from "../../shared/contracts/session.js";

/* Attachment shape — used by the components layer, declared here so the
 * projection layer can return an `attachments` array without importing the
 * React component. The actual component lives at
 * `components/MessageAttachments.tsx`. */

export type WebuiMessageAttachmentType = "image" | "file";

export interface WebuiMessageAttachment {
  id: string;
  type: WebuiMessageAttachmentType;
  file_name: string;
  file_path?: string;
  preview_url?: string;
  desktop_path?: string;
  mime_type?: string;
  file_size?: number;
  /** Pre-resolved absolute URL the WebUI should render. */
  src?: string;
}

/* Session & message wire types — the loader shape the transport returns. */

export interface WebuiClientMessage {
  readonly msgId: string;
  readonly parentMsgId?: string;
  readonly turnId?: string;
  readonly queryKey?: string;
  readonly timestamp?: number;
  readonly msgContent?: string;
  readonly msgType?: number;
  readonly role?: string;
  readonly thinkingContent?: string;
  readonly thinkingDurationMs?: number;
  readonly finishReason?: string;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly attachments?: readonly WebuiMessageAttachment[];
  readonly usage?: Record<string, unknown>;
  readonly source?: string;
  readonly kind?: string;
  readonly actions?: {
    readonly fork?: boolean;
    readonly rewind?: boolean;
    readonly edit?: boolean;
  };
  readonly forkOrigin?: Record<string, unknown>;
  readonly originJson?: string;
  readonly communicationInfosJson?: string;
  readonly parts?: readonly Record<string, unknown>[];
  readonly rawJson?: string;
  readonly contextUsage?: Record<string, unknown>;
  readonly fileChanges?: readonly WebuiFileDiffInfoView[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly turnDiffStatus?: string;
  readonly revertedAt?: number;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface WebuiClientMessagePage {
  readonly messages?: readonly WebuiClientMessage[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly queryCollapseViews?: readonly WebuiQueryCollapseView[];
  readonly nextCursor?: string;
  readonly hasMore?: boolean;
}

export interface WebuiQueryCollapseView {
  readonly queryKey: string;
  readonly currentTurnId: string;
  /** Runtime reconciliation can require details to stay open, which removes
   *  the outer disclosure control in Desktop. */
  readonly forceExpanded?: boolean;
  readonly processingStartedAtMs: number;
  readonly processingFinishedAtMs?: number;
}

export type WebuiClientMessageLoader = (request: {
  readonly id: string;
  readonly before?: string;
}) => Promise<WebuiClientMessagePage>;
