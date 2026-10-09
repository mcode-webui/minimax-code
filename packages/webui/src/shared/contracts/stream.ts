// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiSendMessageRequest` | Request to send a message and open its stream. | Browser `client/transport.ts` (`sendMessage`). | `client/contracts/execution-port.ts`; runtime `sendMessage`; `server/operation/interaction.ts`. |
// | `WebuiResumeSessionRequest` | Request to resume a session's stream from a cursor. | Browser `client/transport.ts` (`resumeSession`). | `client/contracts/execution-port.ts`; runtime `resumeSession`; `server/operation/interaction.ts`. |
// | `WebuiRuntimeEvent` | One event frame from the session event stream. | Runtime `watchEvents` (`runtime/harness/execution.ts`, AsyncIterable); re-projected by `server/projections/index.ts`. | `client/session-activity.ts`; `client/projection/event-parsers.ts`; `client/projection/effect-reducer.ts`; `client/transport.ts`. |
// | `WebuiWatchEventsResult` | The `{ ok, source }` / `{ ok:false, status, body }` envelope of the events channel. | Server `watchEvents` handler (`server/operation/handlers/stream.ts`; declared in `operation-contract.ts`). | `client/contracts/execution-port.ts`; `client/transport.ts`. |
// | `WebuiStreamFrame` | One session-stream frame (cursor, event/data JSON, deltas). | Runtime `sendMessage`/`resumeSession` streams; projected by `server/projections/index.ts` `projectSessionStream`. | `client/stream.ts`; `client/stream-loop.ts`; `client/stream-instrumentation.ts`. |
// | `WebuiStreamResult` | The stream envelope shared by send and resume. | Runtime `sendMessage`/`resumeSession`; `server/operation/handlers/stream.ts`. | `client/contracts/execution-port.ts`; `client/transport.ts`. |
// | `WebuiSendMessageResult` | Alias of `WebuiStreamResult` for `sendMessage`. | Same producers as `WebuiStreamResult`. | `client/contracts/execution-port.ts`; `client/transport.ts`. |
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
  readonly projection?: unknown;
}

/**
 * Result envelope shared between `sendMessage` and `resumeSession`: the
 * harness session-stream contract returns an iterable source on success or
 * a structured error body on failure. The wire envelope (`event` frames
 * over a WebSocket) is the same in both cases — see the brief's "two
 * facts that make this ticket small".
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
