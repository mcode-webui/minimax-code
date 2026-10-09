// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiMessage` | One transcript message as it travels on the wire. | Runtime `getMessages` (`runtime/harness/sessions.ts`; CliService). | `server/index.ts` (public barrel re-export); no other in-tree reader. |
// | `WebuiMessagesRequest` | A paginated transcript read (id, limit, before, attachment URLs). | Browser `client/transport.ts` / `client/contracts/message-view.ts` (`getMessages`). | runtime `getMessages`; `server/operation/messages.ts`. |
// | `WebuiMessagesResult` | A page of transcript messages plus todos/usage/context enrichment. | Runtime `getMessages`; enriched by `server/operation/operation-handlers.ts` `getMessages`. | `client/contracts/message-view.ts`; `client/transport.ts`; `server/operation/messages.ts`. |
// | `WebuiAttachmentInput` | One attachment descriptor (meta + local asset/URL) on a send/enqueue request. | Browser `client/projection/composer-state.ts` / `client/components/SessionComposer.tsx`. | `client/contracts/execution-port.ts`; `client/stream-loop.ts`; `shared/contracts/queue.ts`; `shared/contracts/stream.ts`; `server/operation/interaction.ts`. |
export interface WebuiMessage {
  readonly msgId: string;
  readonly parentMsgId?: string;
  readonly timestamp?: number;
  readonly msgContent?: string;
  readonly msgType?: number;
  readonly role?: string;
  readonly thinkingContent?: string;
  readonly thinkingDurationMs?: number;
  readonly finishReason?: string;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly source?: string;
  readonly kind?: string;
  readonly turnId?: string;
  readonly [key: string]: unknown;
}
export interface WebuiMessagesRequest {
  readonly id: string;
  readonly limit?: number;
  readonly before?: string;
  readonly includeAttachmentReadUrls?: boolean;
}
export interface WebuiMessagesResult {
  readonly messages?: readonly WebuiMessage[];
  readonly nextCursor?: string;
  readonly lastMsgId?: string;
  readonly hasMore?: boolean;
  readonly todosJson?: string;
  readonly queryCollapseViews?: readonly Record<string, unknown>[];
  readonly turnResults?: readonly Record<string, unknown>[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly usage?: Record<string, unknown>;
}

export interface WebuiAttachmentInput {
  readonly meta?: {
    readonly attachmentType?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
  };
  readonly local?: {
    readonly assetId?: string;
    readonly filePath?: string;
    readonly dataUrl?: string;
    readonly desktopPath?: string;
  };
}
