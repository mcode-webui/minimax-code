// The turn commands the composer runs through the application layer
// (plan §7.1 `application/turn-coordinator.ts`: "owns send/queue/stop/retry").
//
// The stop command already lives in `turn-coordinator.ts`. This module moves
// the rest of the composer's owned execution out of the 3000-line component and
// alongside it: the **attach** that follows a turn this client did not start,
// the **recheck** of a lease a `session.start` no longer matches, the **gap
// recovery** that repairs a missed `session.start`, and the **send** whose first
// message may create the session the turn then streams into.
//
// The shape is the same one `stopWebuiTurn` uses: a framework-free unit that
// takes the component's setters and transports as arguments. It is a *move*, not
// a re-implementation — every property the component's inline copies pinned
// (the lease claimed before the loop opens, the cursor anchored from history,
// the sending flag cleared only by the loop that still owns the stream, the
// probe reading the lease before it leaves and again when it returns) is
// preserved verbatim. Nothing here opens a channel: the process-event ingress
// stays exactly where it is.

import type {
  WebuiClientMessageEnqueuer,
  WebuiClientSessionResumer,
} from "../contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "../contracts/message-view.js";
import type { WebuiClientSessionCreator } from "../contracts/session-port.js";
import type { WebuiAttachmentInput } from "../../shared/contracts/messages.js";
import type { WebuiTurnCommandWriter } from "./session-commands.js";
import {
  submitWebuiComposerTurn,
  type WebuiComposerSubmitHandlers,
} from "../projection/composer-state.js";
import { isWebuiSubscriptionProbeCurrent, ownsWebuiStreamGeneration, resolveWebuiSubscriptionRecheck, type WebuiStreamState } from "../projection/stream-state.js";
import {
  releaseWebuiSubscription,
} from "../mechanisms/stream-lease.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import {
  buildWebuiStreamLoopSink,
  runWebuiStreamLoop,
  type WebuiStreamLoopDeps,
} from "../mechanisms/stream-loop.js";
import {
  webuiActiveTurnProbeFor,
  type WebuiActiveTurnProbe,
  type WebuiActiveTurnProbeFn,
} from "./active-turn-probe.js";
import { streamStateBundle } from "./stream-state-bundle.js";

export type WebuiStreamSetter = (
  update: (current: WebuiStreamState) => WebuiStreamState,
) => void;

/**
 * The stream/sending writer a send streams into, home-keyed until it migrates.
 * It is the command-shaped writer from `application/session-commands.ts`, so the
 * caller builds it once and then only submits `updateStream` / `setTurnSending`
 * — the store setters never leave the command surface.
 */
export type WebuiTurnWriter = WebuiTurnCommandWriter;

export type WebuiTurnWriterOwner =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly sessionId: string };

export interface WebuiAttachTurnDeps {
  readonly sessionId: string | undefined;
  /** The turn named by the event, or `undefined` when it carried none. */
  readonly turnId: string | undefined;
  readonly resumeSession?: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly readStream: () => WebuiStreamState;
  readonly setSending: (sending: boolean) => void;
  readonly setStream: WebuiStreamSetter;
}

/**
 * Follow a turn this client did not start, through the same stream loop a local
 * send uses — so history anchoring, cursor resume, `resume_overflow` resync, the
 * lease and every terminal exit stay handled in exactly one place.
 */
export function attachWebuiTurn(deps: WebuiAttachTurnDeps): void {
  const { sessionId, turnId, resumeSession, loadMessages, readStream, setSending, setStream } = deps;
  if (!sessionId || !resumeSession) return;
  const existing = readStream();
  if (existing.subscription) return;
  setSending(true);
  void runWebuiStreamLoop(
    { resumeSession, loadMessages, projection: streamRecoveryProjection, streamState: streamStateBundle },
    {
      sessionId,
      attachTurnId: turnId,
      ...(existing.cursor ? { afterCursor: existing.cursor } : {}),
    },
    buildWebuiStreamLoopSink(setStream, streamStateBundle),
  ).then((generation) => {
    // Only clear the indicator if this loop still owns the stream. A loop that
    // finished after a newer turn started would otherwise make the new turn
    // look idle while it is still streaming.
    if (ownsWebuiStreamGeneration(readStream(), generation)) setSending(false);
  });
}

export interface WebuiRecheckSubscriptionDeps {
  readonly sessionId: string | undefined;
  readonly getActiveTurn?: WebuiActiveTurnProbeFn;
  /** A shared, deduplicated probe; falls back to one built for `getActiveTurn`. */
  readonly probe?: WebuiActiveTurnProbe;
  readonly readStream: () => WebuiStreamState;
  readonly setStream: WebuiStreamSetter;
  /** Attach to the turn the recheck resolved to (`retarget`). */
  readonly attach: (turnId: string | undefined) => void;
}

/**
 * `session.start` named a turn we do not hold while holding another. The event
 * alone cannot say whether the held lease is stale or genuinely concurrent, so
 * the authoritative active turn decides.
 */
export function recheckWebuiSubscription(deps: WebuiRecheckSubscriptionDeps): void {
  const { sessionId, readStream, setStream, attach } = deps;
  if (!sessionId) return;
  const probe = deps.probe ?? webuiActiveTurnProbeFor(deps.getActiveTurn);
  if (!probe) return;
  // Read the lease *before* the probe leaves, not when it returns. A local send
  // that claims during the round trip gets a lease with no turn id yet; reading
  // only at resolution time would let this stale snapshot retarget the user's
  // own turn away from them.
  const probed = readStream().subscription;
  if (!probed) return;
  void probe
    .probe(sessionId)
    .then((active) => {
      const owned = readStream().subscription;
      // The lease this probe was about is gone or has been replaced. The answer
      // describes a turn that is no longer ours to act on.
      if (!isWebuiSubscriptionProbeCurrent(probed, owned) || !owned) return;
      const decision = resolveWebuiSubscriptionRecheck(owned, active);
      if (decision === "hold") return;
      // Scoped to the generation we decided is stale: a newer loop may have
      // claimed while the probe was in flight, and that lease is the live one.
      setStream((current) =>
        releaseWebuiSubscription(current, { generation: owned.generation }),
      );
      if (decision === "retarget" && active) attach(active.turnId);
    })
    .catch(() => undefined);
}

export interface WebuiRecoverMissedTurnDeps {
  readonly sessionId: string | undefined;
  readonly getActiveTurn?: WebuiActiveTurnProbeFn;
  readonly probe?: WebuiActiveTurnProbe;
  readonly readStream: () => WebuiStreamState;
  readonly attach: (turnId: string | undefined) => void;
}

/**
 * Gap recovery: a `session.start` can arrive before this client finished
 * subscribing, or be missed while `watchEvents` reconnects, and the session
 * list cannot answer the question — its `status` carries no turn id. Ask the
 * server instead.
 */
export function recoverMissedWebuiTurn(deps: WebuiRecoverMissedTurnDeps): void {
  const { sessionId, readStream, attach } = deps;
  if (!sessionId) return;
  const probe = deps.probe ?? webuiActiveTurnProbeFor(deps.getActiveTurn);
  if (!probe) return;
  void probe
    .probe(sessionId)
    .then((active) => {
      if (!active || active.busyReason !== "turn") return;
      // Read the lease at resolution time, not at call time: a local send that
      // started while the probe was in flight has already claimed it.
      if (readStream().subscription) return;
      attach(active.turnId);
    })
    .catch(() => undefined);
}

export interface WebuiSendTurnArgs {
  readonly sessionId: string | undefined;
  readonly message: string;
  readonly clientIntent?: string;
  readonly planMode?: boolean;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly onAttachmentsSubmitted?: () => void;
  readonly sending: boolean;
  readonly handlers: WebuiComposerSubmitHandlers;
  readonly deps: Omit<WebuiStreamLoopDeps, "projection" | "streamState">;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly createSession?: WebuiClientSessionCreator;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
  /** Builds the turn's writer; the home writer migrates when the session exists. */
  readonly createWriter: (owner: WebuiTurnWriterOwner) => WebuiTurnWriter;
}

/**
 * The one way a turn reaches the wire. A retry re-enters THIS command rather
 * than a second send of its own, so it inherits every rule an ordinary send
 * obeys — including the "a turn is already in flight ⇒ enqueue" branch inside
 * `submitWebuiComposerTurn`.
 */
export async function sendWebuiTurn(args: WebuiSendTurnArgs): Promise<void> {
  let writer = args.createWriter(
    args.sessionId ? { kind: "session", sessionId: args.sessionId } : { kind: "home" },
  );
  const turnHandlers: WebuiComposerSubmitHandlers = {
    ...args.handlers,
    setStream: (update) => writer.updateStream(update),
    setSending: (sending) => writer.setTurnSending(sending),
    onSessionCreated: (createdSessionId) => {
      args.handlers.onSessionCreated?.(createdSessionId);
      if (writer.kind === "home" && writer.migrateToSession) {
        writer = writer.migrateToSession(createdSessionId);
      }
    },
  };
  await submitWebuiComposerTurn(
    {
      sessionId: args.sessionId,
      // `submitWebuiComposerTurn` reads `message ?? draft` and trims it, so
      // passing the effective text as `message` re-sends it through exactly the
      // path an ordinary send takes.
      draft: args.message,
      message: args.message,
      ...(args.clientIntent
        ? { clientIntent: args.clientIntent }
        : args.planMode
          ? { clientIntent: "plan-entry" }
          : {}),
      attachments: args.attachments,
      onAttachmentsSubmitted: args.onAttachmentsSubmitted,
      sending: args.sending,
      deps: args.deps,
      enqueueMessage: args.enqueueMessage,
      createSession: args.createSession,
      createSessionWorkspaceDir: args.createSessionWorkspaceDir,
      teamModeOff: args.teamModeOff,
    },
    turnHandlers,
  );
}
