// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiSendMessageRequest` | Request to send a message and open its stream. | Browser `client/platform/transport.ts` (`sendMessage`). | `client/features/turn/contracts/execution-port.ts`; runtime `sendMessage` (`runtime/port.ts`; `runtime/harness/host-contract.ts`); `server/operation/interaction.ts`. |
// | `WebuiResumeSessionRequest` | Request to resume a session's stream from a cursor. | Browser `client/platform/transport.ts` (`resumeSession`). | `client/features/turn/contracts/execution-port.ts`; runtime `resumeSession` (`runtime/port.ts`; `runtime/harness/host-contract.ts`); `server/operation/interaction.ts`. |
// | `WebuiRuntimeEvent` | One event frame from the session event stream. | Runtime `watchEvents` (`runtime/harness/execution.ts`, AsyncIterable). | `client/features/turn/application/event-channel.ts`; `client/features/turn/application/event-coordinator.ts`; `client/features/sessions/application/session-activity-controller.ts`; `client/features/shell/contracts/watch-port.ts`; `client/platform/event-channel.ts`; `client/platform/transport.ts`; `client/projection/common/event-parsers.ts`; `client/features/turn/application/effect-reducer.ts`; `client/features/sessions/projection/session-activity.ts`. |
// | `WebuiWatchEventsResult` | The `{ ok, source }` / `{ ok:false, status, body }` envelope of the events channel. | Server `watchEvents` handler (`server/operation/handlers/stream.ts`; declared in `operation-contract.ts`). | `server/operation/operation-contract.ts`; `shared/operation-names.ts`. |
// | `WebuiStreamFrame` | One session-stream frame (cursor, event/data JSON, deltas). | Runtime `sendMessage`/`resumeSession` streams. | `client/features/turn/application/event-coordinator.ts`; `client/features/turn/contracts/execution-port.ts`; `client/platform/transport.ts`; `client/conversation/stream-loop.ts`; `client/features/turn/projection/stream-state.ts`. |
// | `WebuiStreamResult` | The stream envelope shared by send and resume. | Runtime `sendMessage`/`resumeSession`; `server/operation/handlers/stream.ts`. | `runtime/port.ts`; `runtime/harness/host-contract.ts`; `shared/operation-names.ts`. |
// | `WebuiSendMessageResult` | Alias of `WebuiStreamResult` for `sendMessage`. | Same producers as `WebuiStreamResult`. | `runtime/port.ts`; `runtime/harness/host-contract.ts`; `server/operation/operation-contract.ts`. |
import type { WebuiAttachmentInput } from "./messages.js";

/** Deliberately small WebUI-owned shape; the browser does not import the harness contract. */
export interface WebuiSendMessageRequest {
  readonly id: string;
  readonly content?: string;
  readonly turnId?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
}

/**
 * Wire shape for `resumeSession` on the WebUI envelope. The harness
 * `ResumeSessionInput` is what the runtime layer ultimately consumes; this
 * type is a deliberately narrow projection so the browser can ask for a
 * resume without importing the harness contract.
 */
export interface WebuiResumeSessionRequest {
  readonly id: string;
  /** Resume from the stream cursor the client last advanced past. */
  readonly afterCursor?: string;
  /** Resume from after a specific persisted message id, when known. */
  readonly afterMsgId?: string;
  /** Drain any queued turns after the resume point. */
  readonly drainQueued?: boolean;
}

export interface WebuiRuntimeEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
  readonly source: string;
}

export type WebuiWatchEventsResult =
  | {
      readonly ok: true;
      readonly source:
        AsyncIterable<WebuiRuntimeEvent> | Iterable<WebuiRuntimeEvent>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };

export interface WebuiStreamFrame {
  readonly cursor?: string;
  readonly eventJson?: string;
  readonly dataJson?: string;
  readonly messageActionDeltas?: readonly Record<string, unknown>[];
}

/**
 * Result envelope shared between `sendMessage` and `resumeSession`: the
 * harness session-stream contract returns an iterable source on success or
 * a structured error body on failure. The wire envelope (`event` frames
 * over a WebSocket) is the same in both cases.
 */
export type WebuiStreamResult =
  | {
      readonly ok: true;
      readonly source:
        AsyncIterable<WebuiStreamFrame> | Iterable<WebuiStreamFrame>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };

/** `sendMessage` returns the same shape as a resume — kept as an alias. */
export type WebuiSendMessageResult = WebuiStreamResult;
