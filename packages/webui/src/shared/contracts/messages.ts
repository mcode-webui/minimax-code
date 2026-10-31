// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiMessage` | One transcript message as it travels on the wire. | Runtime `getMessages` (`runtime/harness/sessions.ts`; CliService). | `server/index.ts` (public barrel re-export); no other in-tree reader. |
// | `WebuiMessagesRequest` | A paginated transcript read (id, limit, before, attachment URLs). | Browser `client/platform/transport.ts` / `client/features/transcript/contracts/message-view.ts` (`getMessages`). | `runtime/port.ts`; `server/operation/messages.ts`. |
// | `WebuiMessagesResult` | A page of transcript messages plus todos/usage/context enrichment. | Runtime `getMessages`; enriched by `server/operation/handlers/messages.ts` `getMessages`. | `runtime/port.ts`; `server/operation/messages.ts`. |
// | `WebuiAttachmentInput` | One attachment descriptor (meta + local asset/URL) on a send/enqueue request. | Browser `client/features/composer/ui/WebuiComposer.tsx`, assembled in `client/features/turn/application/queue-command.ts` and `client/features/turn/application/turn-commands.ts`. | `client/features/turn/contracts/execution-port.ts`; `client/conversation/stream-loop.ts`; `shared/contracts/queue.ts`; `shared/contracts/stream.ts`; `server/operation/interaction.ts`. |
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
  readonly queryCollapseViews?: readonly WebuiQueryCollapseView[];
  readonly turnResults?: readonly Record<string, unknown>[];
  readonly contextSnapshot?: Record<string, unknown>;
  readonly usage?: Record<string, unknown>;
}

/**
 * One query's collapse state inside a transcript page.
 *
 * The server forwards the runtime's `QueryCollapseView`
 * (`packages/protocol/src/local.ts`) verbatim, so this is the reader's
 * declaration of that same object. It used to be `Record<string, unknown>[]`
 * here while the browser declared the real fields, which left the two
 * declarations disagreeing about one wire object and nothing comparing them.
 * `forceExpanded` is optional because a reader must tolerate its absence; the
 * runtime always sends it.
 */
export interface WebuiQueryCollapseView {
  readonly queryKey: string;
  readonly currentTurnId: string;
  readonly forceExpanded?: boolean;
  readonly processingStartedAtMs: number;
  readonly processingFinishedAtMs?: number;
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
