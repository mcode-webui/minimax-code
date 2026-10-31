// The turn coordinator.
//
// It owns one command: the **manual retry**, the arm the connection banner's
// "重试连接" button runs. It takes over the session-stream retry helper's
// behaviour, and that helper's tests are rewired to `retry()` rather than
// deleted.
//
// The command preserves every property the old helper pinned:
//
//   * the standing refusal is cleared *synchronously*, before the attempt opens
//     — a banner that still says 连接失败 over an attempt already streaming is a
//     lie;
//   * the attempt is anchored on the last cursor this client applied, so a
//     resume neither replays the transcript nor skips frames;
//   * one call is exactly one attempt: a still-dead server refuses again through
//     the identical path, and the banner returns with the new reason.
//
// The attempt runs through the single lease implementation: the sink claims,
// fences its own writes and releases on terminal, error or cancellation, so the
// retry cannot strand a "thinking" indicator or let a superseded attempt write.

import type {WebuiClientSessionResumer} from "../contracts/execution-port.js";
import type {
  WebuiClientMessage,
  WebuiClientMessageLoader,
} from "../../transcript/contracts/message-view.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import { runWebuiStreamLoop } from "../../../conversation/stream-loop.js";
import { buildWebuiStreamLoopSink } from "./stream-loop-sink.js";
import { classifyStreamFrame } from "./stream-frame-classify.js";
import type { WebuiSessionStore } from "../../../application/session-store.js";
import { streamStateBundle } from "./stream-state-bundle.js";
import { holdWebuiDelivery, type WebuiDeliveryDisposers } from "./delivery-disposers.js";
import type { WebuiSessionScopeManager } from "../../../conversation/session-scope.js";

export interface WebuiTurnCoordinatorDeps {
  readonly store: WebuiSessionStore;
  readonly resumeSession: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly deliveries?: WebuiDeliveryDisposers;
  readonly scope?: WebuiSessionScopeManager;
  /** Injected for tests; production uses the mechanism's loop. */
  readonly runStreamLoop?: typeof runWebuiStreamLoop;
}

export interface WebuiTurnCoordinator {
  /**
   * The manual retry command. Clears the refusal and runs exactly one attempt
   * from the recorded cursor. Resolves with the generation the attempt claimed,
   * or `undefined` if it never claimed one.
   */
  readonly retry: (sessionId: string) => Promise<number | undefined>;
}

export function createWebuiTurnCoordinator(
  deps: WebuiTurnCoordinatorDeps,
): WebuiTurnCoordinator {
  const { store, resumeSession, loadMessages } = deps;
  const runStreamLoop = deps.runStreamLoop ?? runWebuiStreamLoop;
  return {
    retry: (sessionId) => {
      if (deps.deliveries?.isDisposed() || deps.scope?.isDisposed()) return Promise.resolve(undefined);
      const hold = holdWebuiDelivery(() => sessionId, deps.deliveries, deps.scope);
      const writer = store.createSessionWriter({ kind: "session", sessionId });
      const current = store.readSession(sessionId).stream;
      // Clear the refusal first, synchronously: the banner reads the phase, and
      // leaving `refused` standing while the new attempt opens would show the
      // failure for a loop that is already streaming again.
      writer.setStream((stream) => ({
        ...stream,
        phase: "idle",
        refusal: undefined,
        transcriptIncomplete: false,
      }));
      return runStreamLoop(
        {
          resumeSession: (request, onFrame) => resumeSession(request, onFrame, hold.onDelivery),
          ...(loadMessages ? { loadHistory: loadMessages } : {}),
          classify: classifyStreamFrame,
        },
        {
          sessionId,
          ...(current.cursor ? { afterCursor: current.cursor } : {}),
        },
        // The Turn-owned adapter, not a second copy of it: this coordinator's
        // retry path and the composer's submit path must translate a frame into
        // the record the same way, or a retried turn would seed itself
        // differently from a submitted one.
        buildWebuiStreamLoopSink(writer.setStream, streamStateBundle),
      ).finally(hold.release);
    },
  };
}

export interface WebuiStopTurnDeps {
  readonly abortSession: (request: {
    readonly id: string;
  }) => Promise<{ readonly success?: boolean }>;
  readonly sessionId: string;
  readonly setSending: (sending: boolean) => void;
  /**
   * Settle the local stream to `done`/`aborted`. A named command rather than a
   * reducer: the caller has no business composing a write over the slice.
   */
  readonly settleStream: () => void;
}

/**
 * Stops the running turn and settles the local stream.
 *
 * `abortSession` reports success even when the runtime says the session is
 * not running, so no `session.abort` event is guaranteed to arrive. The stop
 * button is therefore the last chance to drop the lease, and it has to do so
 * itself.
 */
export async function stopWebuiTurn(deps: WebuiStopTurnDeps): Promise<void> {
  const result = await deps.abortSession({ id: deps.sessionId });
  if (result.success === false)
    throw new Error("The running turn could not be stopped");
  deps.setSending(false);
  deps.settleStream();
}
