// The turn coordinator (plan §7.1 `application/turn-coordinator.ts`).
//
// Stage 4 of this slice brings over one owning command: the **manual retry**,
// the arm the connection banner's "重试连接" button runs. It replaces
// `client/session-stream-retry.ts`, which is deleted once its behaviour has
// moved (plan §7.3); its tests are rewired to `retry()` rather than deleted.
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

import type { WebuiClientSessionResumer } from "../contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "../contracts/message-view.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import { reduceWebuiStreamFrame } from "../projection/stream-state.js";
import { fenceWebuiLeaseStream } from "../mechanisms/stream-lease.js";
import {
  runWebuiStreamLoop,
  type WebuiStreamLoopSink,
} from "../mechanisms/stream-loop.js";
import type { WebuiSessionStore, WebuiSessionWriter } from "./session-store.js";
import type { WebuiStreamLeaseController } from "./stream-lease-controller.js";
import { streamStateBundle } from "./stream-state-bundle.js";

export interface WebuiTurnCoordinatorDeps {
  readonly store: WebuiSessionStore;
  readonly leases: WebuiStreamLeaseController;
  readonly resumeSession: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
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

/**
 * The attempt's sink. It is the loop sink, but every write goes through the
 * lease fence first, so only the newest attempt reaches the store.
 */
function createLeaseSink(
  sessionId: string,
  store: WebuiSessionStore,
  leases: WebuiStreamLeaseController,
): WebuiStreamLoopSink {
  const writer: WebuiSessionWriter = store.createSessionWriter({
    kind: "session",
    sessionId,
  });
  let generation: number | undefined;
  const write = (
    apply: (current: WebuiStreamState) => WebuiStreamState,
  ): void => {
    writer.setStream((current) =>
      fenceWebuiLeaseStream(current, generation, apply),
    );
  };
  return {
    claimSubscription: (owner, turnId) => {
      generation = leases.claim(sessionId, owner, turnId);
      return generation;
    },
    // Released raw on every terminal exit, scoped to this attempt's generation
    // so a superseded attempt cannot clear the lease the current one holds.
    releaseSubscription: () => {
      if (generation === undefined) return;
      leases.release(sessionId, { generation });
    },
    applyFrame: (frame) => write((current) => reduceWebuiStreamFrame(current, frame)),
    setPhase: (phase) => write((current) => ({ ...current, phase })),
    setMessages: (messages) => write((current) => ({ ...current, messages })),
    setStreamExtra: (extra) => write((current) => ({ ...current, ...extra })),
    refuse: (reason, options) =>
      write((current) => ({
        ...current,
        phase: "refused",
        refusal: reason,
        transcriptIncomplete: options?.transcriptIncomplete ?? false,
      })),
  };
}

export function createWebuiTurnCoordinator(
  deps: WebuiTurnCoordinatorDeps,
): WebuiTurnCoordinator {
  const { store, leases, resumeSession, loadMessages } = deps;
  const runStreamLoop = deps.runStreamLoop ?? runWebuiStreamLoop;
  return {
    retry: (sessionId) => {
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
        { resumeSession, loadMessages, projection: streamRecoveryProjection, streamState: streamStateBundle },
        {
          sessionId,
          ...(current.cursor ? { afterCursor: current.cursor } : {}),
        },
        createLeaseSink(sessionId, store, leases),
      );
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
