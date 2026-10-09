// The manual arm of the stream loop's recovery.
//
// The automatic arm lives in `stream-loop.ts`: a socket drop mid-turn sets
// `reconnecting` and runs ONE `resumeSession` attempt; when that attempt
// itself dies the loop commits `refused` and stops. Nothing else in the
// client re-enters the loop after that — which was the gap: a failed
// connection had no user-facing way back.
//
// This helper is what the connection banner's 重试连接 button runs. It
// clears the standing refusal and re-runs the same attach loop the shell
// uses for a turn the server started (`attachToTurn` in the composer),
// anchored on the last cursor this client applied. One call is one attempt:
// a still-dead server refuses again through the identical path and the
// banner returns with the new reason, so the loop cannot spin on its own.

import type { WebuiClientSessionResumer } from "./contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "./contracts/message-view.js";
import { buildWebuiStreamLoopSink, runWebuiStreamLoop } from "./stream-loop.js";
import { streamRecoveryProjection } from "./projection/stream-recovery.js";
import {
  createSessionRuntimeWriter,
  readSessionRuntimeState,
} from "./session-runtime-store.js";

export function createSessionStreamRetry({
  sessionId,
  resumeSession,
  loadMessages,
}: {
  readonly sessionId: string;
  readonly resumeSession: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
}): () => void {
  return () => {
    const writer = createSessionRuntimeWriter({
      kind: "session",
      sessionId,
    });
    const current = readSessionRuntimeState(sessionId).stream;
    // Clear the refusal first, synchronously: the banner reads the phase, and
    // leaving `refused` standing while the new attempt opens would show the
    // failure for a loop that is already streaming again.
    writer.setStream((stream) => ({
      ...stream,
      phase: "idle",
      refusal: undefined,
      transcriptIncomplete: false,
    }));
    void runWebuiStreamLoop(
      { resumeSession, loadMessages, projection: streamRecoveryProjection },
      {
        sessionId,
        ...(current.cursor ? { afterCursor: current.cursor } : {}),
      },
      buildWebuiStreamLoopSink(writer.setStream),
    );
  };
}
