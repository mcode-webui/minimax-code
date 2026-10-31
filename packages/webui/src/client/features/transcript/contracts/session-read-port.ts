// Transcript capability port.
//
// The conversation's own reads and rewrites: loading a history page, the turn
// diff read/revert/reapply, the rewind preview, rewinding and editing a message.
// They travel with `message-view` (the message half) because the review surface
// — and the read that presents it — belongs to the business that presents it.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type { WebuiClientMessageLoader } from "./message-view.js";
import type { WebuiEditSessionMessageRequest, WebuiEditSessionMessageResult, WebuiForkSessionRequest, WebuiForkSessionResult, WebuiGetSessionDiffRequest, WebuiGetSessionDiffResult, WebuiGetSessionForkOptionsRequest, WebuiGetSessionForkOptionsResult, WebuiGetSessionRewindPreviewRequest, WebuiGetSessionRewindPreviewResult, WebuiGetTurnDiffRequest, WebuiGetTurnDiffResult, WebuiReapplyTurnDiffRequest, WebuiReapplyTurnDiffResult, WebuiRevertTurnDiffRequest, WebuiRevertTurnDiffResult, WebuiRewindSessionRequest, WebuiRewindSessionResult } from "../../../../shared/contracts/session.js";

export interface TranscriptPort {
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly getSessionDiff?: (
    request: WebuiGetSessionDiffRequest,
  ) => Promise<WebuiGetSessionDiffResult>;
  readonly getTurnDiff?: (
    request: WebuiGetTurnDiffRequest,
  ) => Promise<WebuiGetTurnDiffResult>;
  readonly revertTurnDiff?: (
    request: WebuiRevertTurnDiffRequest,
  ) => Promise<WebuiRevertTurnDiffResult>;
  readonly reapplyTurnDiff?: (
    request: WebuiReapplyTurnDiffRequest,
  ) => Promise<WebuiReapplyTurnDiffResult>;
  readonly getSessionRewindPreview?: (
    request: WebuiGetSessionRewindPreviewRequest,
  ) => Promise<WebuiGetSessionRewindPreviewResult>;
  readonly rewindSession?: (
    request: WebuiRewindSessionRequest,
  ) => Promise<WebuiRewindSessionResult>;
  readonly editSessionMessage?: (
    request: WebuiEditSessionMessageRequest,
  ) => Promise<WebuiEditSessionMessageResult>;
}

/** Commands the transcript presentation may invoke through the application. */
export interface WebuiTranscriptCommands {
  readonly getSessionForkOptions?: (
    request: WebuiGetSessionForkOptionsRequest,
  ) => Promise<WebuiGetSessionForkOptionsResult>;
  readonly forkSession?: (request: WebuiForkSessionRequest) => Promise<WebuiForkSessionResult>;
  readonly getSessionRewindPreview?: TranscriptPort["getSessionRewindPreview"];
  readonly rewindSession?: TranscriptPort["rewindSession"];
  readonly editSessionMessage?: TranscriptPort["editSessionMessage"];
}
