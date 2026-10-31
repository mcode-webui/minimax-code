// The **turn-lifecycle** view: opening a turn's stream, clearing it for a new
// task, recording what it carries and closing it. It was Sessions' until the
// execution substrate took it over.
//
// It is the one view that also writes the `sending` indicator, because `sending`
// is the submit's lifecycle flag rather than part of the phase. The *lease* is
// not on this surface: a sink factory here would let a component mint a new lease
// at will and take one from a newer turn, so opening a turn's stream stays behind
// the writer that owns the store writer.

import {
  initialWebuiStreamState,
} from "../projection/stream-state.js";
import { releaseWebuiSubscription } from "./stream-lease.js";
import type { WebuiStreamWriteTarget } from "./stream-phase-commands.js";
import type { WebuiTurnLifecycleCommands } from "../contracts/turn-command-views.js";

export interface WebuiTurnLifecycleTargets extends WebuiStreamWriteTarget {
  readonly setSending: (sending: boolean) => void;
}

export function createWebuiTurnLifecycleCommands(
  targets: WebuiTurnLifecycleTargets,
): WebuiTurnLifecycleCommands {
  const { setStream, setSending } = targets;
  return {
    resetStreamForTurn: () =>
      setStream(() => ({
        ...initialWebuiStreamState,
        phase: "streaming",
        processingStartedAtMs: Date.now(),
      })),
    clearStream: () => setStream(() => initialWebuiStreamState),
    setStreamRefusal: (refusal) => setStream((current) => ({ ...current, refusal })),
    setTurnSending: (sending) => setSending(sending),
    releaseStreamSubscription: (generation) =>
      setStream((current) => releaseWebuiSubscription(current, { generation })),
  };
}
