// The **stream-phase** view: the phase field, and nothing else.
//
// The old command bag was split into three views so a consumer handed one cannot
// reach another's commands; this is the narrowest of them. It carries no
// `sending` write, because `sending` is the submit's lifecycle flag rather than
// part of the phase, and that flag belongs to the lifecycle view next door.
//
// The four transitions an interaction flow drives are the published
// `WebuiInteractionPhaseIntents`, so this view composes them rather than declaring
// them a second time. What it adds is `settleStoppedStream`, which settles an
// aborted slice through the stream-state transform — that transform is why this
// factory stays in `application/` while the intents are published.

import { settleAbortedStream } from "../projection/stream-state.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import { createWebuiInteractionPhaseIntents } from "../contracts/interaction-phase-intents.js";
import type { WebuiStreamPhaseWriteTarget } from "../contracts/interaction-phase-intents.js";
import type { WebuiStreamPhaseCommands } from "../contracts/turn-command-views.js";

/** The write target both turn views are bound to. */
export interface WebuiStreamWriteTarget {
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
}

/** The stream-phase view needs no `sending` write, and is not given one. */
export type WebuiStreamPhaseTargets = WebuiStreamPhaseWriteTarget;

export function createWebuiStreamPhaseCommands(
  targets: WebuiStreamPhaseTargets,
): WebuiStreamPhaseCommands {
  const { setStream } = targets;
  return {
    ...createWebuiInteractionPhaseIntents(targets),
    settleStoppedStream: () => setStream(settleAbortedStream),
  };
}
