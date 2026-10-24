// The turn commands the composer runs through the application layer.
//
// The stop command already lives in `turn-coordinator.ts`. This module moves
// the rest of the composer's owned execution out of the component and
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

import type {WebuiClientMessageEnqueuer} from "../../composer/contracts/command-port.js";
import type {WebuiClientSessionResumer} from "../contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "../../transcript/contracts/message-view.js";
import type { WebuiClientSessionCreator } from "../../sessions/contracts/session-port.js";
import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";
import type {
  WebuiComposerTurnCallbacks,
  WebuiConversationTurnCommands,
  WebuiTurnSendIntent,
} from "../contracts/turn-commands.js";
export type { WebuiConversationTurnCommands, WebuiTurnSendIntent } from "../contracts/turn-commands.js";
import type { WebuiTurnCommandWriter } from "../contracts/turn-command-views.js";
import { createWebuiStreamPhaseCommands } from "./stream-phase-commands.js";
import { createWebuiTurnLifecycleCommands } from "./turn-lifecycle-commands.js";
import { createWebuiTurnCommands } from "./turn-command-writer.js";
import type { WebuiComposerSubmitHandlers } from "../../composer/contracts/composer-turn.js";
import {
  buildWebuiComposerHandlers,
  submitWebuiTurn,
} from "./composer-submission.js";
import type {
  WebuiSubmissionAdmission,
  WebuiSubmissionIntent,
  WebuiSubmissionTicket,
  WebuiTaskSessionSubmitter,
} from "../contracts/submission.js";
import { isWebuiSubscriptionProbeCurrent, ownsWebuiStreamGeneration, resolveWebuiSubscriptionRecheck, settleStaleWebuiSubscription, type WebuiStreamState } from "../projection/stream-state.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import { runWebuiStreamLoop } from "../../../conversation/stream-loop.js";
import type {
  WebuiDeliveryDeps,
  WebuiDeliverySink,
  WebuiDeliveryTransports,
} from "../../../../shared/contracts/delivery.js";
import { classifyStreamFrame } from "./stream-frame-classify.js";
import {
  webuiActiveTurnProbeFor,
  type WebuiActiveTurnProbe,
  type WebuiActiveTurnProbeFn,
} from "../contracts/active-turn-probe.js";
import { streamStateBundle } from "./stream-state-bundle.js";
import type { WebuiSessionStore } from "../../../application/session-store.js";
import { WEBUI_HOME_SESSION_KEY } from "../../../application/state.js";
import type { WebuiTurnCapabilitySlice } from "./turn-capabilities.js";
import { holdWebuiDelivery, type WebuiDeliveryDisposers } from "./delivery-disposers.js";
import type { WebuiSessionScopeManager } from "../../../conversation/session-scope.js";
import { stopWebuiTurn } from "./turn-coordinator.js";
import {
  classifyWebuiSubmission,
  readWebuiSubmissionAdmissionState,
} from "./execution-target.js";

export interface WebuiAttachTurnDeps {
  readonly sessionId: string | undefined;
  /** The turn named by the event, or `undefined` when it carried none. */
  readonly turnId: string | undefined;
  readonly resumeSession?: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly readStream: () => WebuiStreamState;
  readonly setSending: (sending: boolean) => void;
  /**
   * This attachment's stream sink. Built by the binding that owns the store
   * writer — the sole caller of this command — so its writes are already fenced
   * against the generation it claims, and no component ever holds the factory
   * that mints it.
   */
  readonly sink: WebuiDeliverySink;
}

/**
 * Whether the server's active-turn answer names the turn it is talking about.
 *
 * The contract says the answer carries a turn id, but the wire answer is read
 * as it arrives: a runtime that reports a busy session without naming the turn
 * is a real answer, and this client has to decide what it can do with it. An
 * answer that names no turn cannot be followed — there is nothing to resume,
 * and a lease opened for it would hold the next `session.start` off.
 */
function namesWebuiTurn(active: { readonly turnId?: unknown }): boolean {
  return typeof active.turnId === "string" && active.turnId.length > 0;
}

/**
 * Follow a turn this client did not start, through the same stream loop a local
 * send uses — so history anchoring, cursor resume, `resume_overflow` resync, the
 * lease and every terminal exit stay handled in exactly one place.
 */
export function attachWebuiTurn(deps: WebuiAttachTurnDeps): Promise<void> {
  const { sessionId, turnId, resumeSession, loadMessages, readStream, setSending, sink } = deps;
  if (!sessionId || !resumeSession) return Promise.resolve();
  const existing = readStream();
  if (existing.subscription) return Promise.resolve();
  // The "a turn is live" mark is a claim about a **named** turn. An attach that
  // cannot name the turn it follows is following whatever the session happens
  // to have, and the runtime answers such an attach with whatever is left of
  // it — often nothing, because the turn it was about has already finished.
  //
  // Marking the session live on that guess is not a cosmetic slip: the
  // submission admission reads this flag as "a turn is live", so the next
  // message is queued instead of sent, and the composer's send button becomes
  // the stop button, which swallows the click that was meant to send it. An
  // unnamed attach therefore never marks the session live, and never clears a
  // mark it did not raise.
  const marksLive = turnId !== undefined;
  if (marksLive) setSending(true);
  return runWebuiStreamLoop(
    {
      resumeSession,
      ...(loadMessages ? { loadHistory: loadMessages } : {}),
      classify: classifyStreamFrame,
    },
    {
      sessionId,
      attachId: turnId,
      ...(existing.cursor ? { afterCursor: existing.cursor } : {}),
    },
    sink,
  ).then((generation) => {
    // Only clear the indicator if this loop still owns the stream. A loop that
    // finished after a newer turn started would otherwise make the new turn
    // look idle while it is still streaming.
    if (marksLive && ownsWebuiStreamGeneration(readStream(), generation)) setSending(false);
  });
}

export interface WebuiRecheckSubscriptionDeps {
  readonly sessionId: string | undefined;
  readonly getActiveTurn?: WebuiActiveTurnProbeFn;
  /** A shared, deduplicated probe; falls back to one built for `getActiveTurn`. */
  readonly probe?: WebuiActiveTurnProbe;
  readonly readStream: () => WebuiStreamState;
  /**
   * Drop the subscription only if the live lease still carries this generation.
   * Named and scoped, so a probe that started before a newer turn cannot clear
   * the lease that turn now owns.
   */
  readonly releaseSubscription: (generation: number) => void;
  /** Attach to the turn the recheck resolved to (`retarget`). */
  readonly attach: (turnId: string | undefined) => void;
}

/**
 * `session.start` named a turn we do not hold while holding another. The event
 * alone cannot say whether the held lease is stale or genuinely concurrent, so
 * the authoritative active turn decides.
 */
export function recheckWebuiSubscription(deps: WebuiRecheckSubscriptionDeps): void {
  const { sessionId, readStream, releaseSubscription, attach } = deps;
  if (!sessionId) return;
  const probe = deps.probe ?? webuiActiveTurnProbeFor(deps.getActiveTurn);
  if (!probe) return;
  // Read the lease *before* the probe leaves, not when it returns. A local send
  // that claims during the round trip gets a lease with no turn id yet; reading
  // only at resolution time would let this stale snapshot retarget the user's
  // own turn away from them.
  const probed = readStream().subscription;
  void probe
    .probe(sessionId)
    .then((active) => {
      const owned = readStream().subscription;
      // A terminal event can release the old lease after an earlier
      // `session.start` recheck already resolved. In that case the terminal
      // schedules another recheck with no lease captured; attach only if no
      // newer local/recovered subscription claimed the session meanwhile.
      if (!probed) {
        if (owned) return;
        if (active?.busyReason === "turn") attach(active.turnId);
        else if (!active) attach(undefined);
        return;
      }
      // The lease this probe was about is gone or has been replaced. The answer
      // describes a turn that is no longer ours to act on.
      if (!isWebuiSubscriptionProbeCurrent(probed, owned) || !owned) return;
      const decision = resolveWebuiSubscriptionRecheck(owned, active);
      if (decision === "hold") return;
      // Scoped to the generation we decided is stale: a newer loop may have
      // claimed while the probe was in flight, and that lease is the live one.
      releaseSubscription(owned.generation);
      // A retarget needs a turn to retarget to. An active turn the server
      // names without an id cannot be followed, and the lease just released
      // leaves the next `session.start` free to attach to the turn it names.
      if (decision === "retarget" && active && namesWebuiTurn(active)) attach(active.turnId);
      else if (decision === "release" && !active && !readStream().subscription) attach(undefined);
    })
    .catch(() => undefined);
}

export interface WebuiRecoverMissedTurnDeps {
  readonly sessionId: string | undefined;
  readonly getActiveTurn?: WebuiActiveTurnProbeFn;
  readonly probe?: WebuiActiveTurnProbe;
  readonly readStream: () => WebuiStreamState;
  /** Settle only the same lease when an authoritative read finds no active turn. */
  readonly settleStaleSubscription: (generation: number) => void;
  readonly attach: (turnId: string | undefined) => void;
}

/**
 * Gap recovery: a `session.start` can arrive before this client finished
 * subscribing, or be missed while `watchEvents` reconnects, and the session
 * list cannot answer the question — its `status` carries no turn id. Ask the
 * server instead.
 */
export function recoverMissedWebuiTurn(deps: WebuiRecoverMissedTurnDeps): void {
  const { sessionId, readStream, settleStaleSubscription, attach } = deps;
  if (!sessionId) return;
  const probe = deps.probe ?? webuiActiveTurnProbeFor(deps.getActiveTurn);
  if (!probe) return;
  const probed = readStream().subscription;
  void probe
    .probe(sessionId)
    .then((active) => {
      // A locally issued send can be accepted before `getActiveTurn` reflects
      // it. Its stream lease is already evidence of a live attempt, so an
      // empty probe must not settle it. Recovery only reconciles recovered
      // leases that were established from an earlier authoritative read.
      if (probed?.owner === "recovered") {
        const owned = readStream().subscription;
        if (!isWebuiSubscriptionProbeCurrent(probed, owned)) return;
        if (!active || active.busyReason !== "turn") {
          settleStaleSubscription(probed.generation);
          return;
        }
      }
      if (!active || active.busyReason !== "turn") return;
      // Read the lease at resolution time, not at call time: a local send that
      // started while the probe was in flight has already claimed it.
      if (readStream().subscription) return;
      // The answer has to name the turn. An active turn without an id cannot be
      // followed, and attaching to it would claim a lease with no turn in it —
      // and a turn-less lease holds the next `session.start` off instead of
      // letting this client follow it.
      if (!namesWebuiTurn(active)) return;
      attach(active.turnId);
    })
    .catch(() => undefined);
}

export interface WebuiSendTurnArgs {
  readonly sessionId: string | undefined;
  /**
   * The composer draft this submission consumes.
   *
   * A link the **application** installs, not a setter a caller passes per send.
   * It is the one write the submission genuinely has to make — everything else it
   * used to ask the caller for is now a fact in the completion — and routing it
   * through the composition root is what keeps the public intent free of them.
   */
  /**
   * The task use case, so a first message's creation goes through the one owner.
   * Absent on a host that cannot create, which the submission reports as `unsupported`.
   */
  readonly taskSessions?: WebuiTaskSessionSubmitter;
  readonly clientIntent?: string;
  readonly planMode?: boolean;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly sending: boolean;
  /**
   * The component-owned callbacks. The lease-bearing half of the handler bundle
   * is assembled here, from the writer this command builds, so a caller supplies
   * intent and never a sink.
   */
  /** What the user asked for, as a kind. */
  readonly intent: WebuiSubmissionIntent;
  /** Decided by the owner before any work, so the ticket can say it immediately. */
  readonly admission: WebuiSubmissionAdmission;
  /**
   * Read the live slice of a record, by the key it is filed under.
   *
   * The key is passed in rather than remembered because a first message creates
   * the session it is sent to: the record moves onto that session, and a reader
   * bound to the key the turn started from answers about a slot the record has
   * already left.
   */
  readonly readStream?: (sessionKey: string) => WebuiStreamState;
  readonly deps: Omit<WebuiDeliveryDeps, "projection" | "streamState">;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
  /**
   * Builds the turn's writer. The owner is not an argument: the writer belongs
   * to the session this send is for (or to the home slot before that session
   * exists), and the binding that builds it already knows which.
   */
  readonly createWriter: () => WebuiTurnCommandWriter;
}

/**
 * The one way a turn reaches the wire. A retry re-enters THIS command rather
 * than a second send of its own, so it inherits every rule an ordinary send
 * obeys — including the "a turn is already in flight ⇒ enqueue" branch inside
 * `submitWebuiComposerTurn`.
 */
/**
 * The public send intent, read as one of the submission's kinds.
 *
 * This is the mapping the intent union bought: a surface says *what it wants*
 * (`goal`, a named `command`, prose) and the qualifiers it used to thread — a
 * `clientIntent` string, a `planMode` flag — stop crossing the boundary at all.
 * A new kind is a new case here, not a new optional field on four contracts.
 */
function toSubmissionIntent(intent: WebuiTurnSendIntent): WebuiSubmissionIntent {
  if (intent.clientIntent !== undefined) {
    return {
      kind: "command",
      command: intent.clientIntent,
      ...(intent.message ? { message: intent.message } : {}),
    };
  }
  if (intent.planMode) return { kind: "goal", message: intent.message };
  return {
    kind: "ordinary",
    message: intent.message,
    ...(intent.attachments ? { attachments: intent.attachments } : {}),
  };
}

export function sendWebuiTurn(
  args: WebuiSendTurnArgs,
): WebuiSubmissionTicket | undefined {
  let writer = args.createWriter();
  // The session a first message creates, remembered because the draft's key
  // moves with it.
  let createdSessionId: string | undefined;
  // The bundle is woven here, from the writer this command owns: `createSink`
  // reads the *current* writer, so a turn whose first message created the
  // session mints its lease against the migrated key rather than the home slot.
  const readSessionStream = args.readStream;
  const turnHandlers: WebuiComposerSubmitHandlers = buildWebuiComposerHandlers({
    createSink: () => writer.createSink(),
    resetStreamForTurn: () => writer.resetStreamForTurn(),
    setRefusal: (refusal) => writer.setStreamRefusal(refusal),
    setSending: (sending) => writer.setTurnSending(sending),
    // The live slice, read through the key the turn's record lives under. A
    // first message creates its session and the record moves onto it, so the
    // key the turn started from is not the key the record is on any more — and
    // a reader left on the old key would decide the turn no longer owns the
    // stream, which is what strands its sending flag.
    ...(readSessionStream
      ? {
          readStream: () =>
            readSessionStream(
              createdSessionId ?? args.sessionId ?? WEBUI_HOME_SESSION_KEY,
            ),
        }
      : {}),
    // The draft is consumed by the submission, through the link the assembly
    // installed. No caller supplies a writer.
    //
    // It is cleared against the session the turn actually landed on, which is
    // not necessarily the one it started from: a first message creates its
    // session, and the draft belongs to the created session's key from then on.
    // Clearing the pre-creation key would leave the words the user just sent
    // sitting in a home slot they can no longer reach.
    onSessionCreated: (created, selected) => {
      createdSessionId = created;
      // The writer moves whatever the use case decided about selection: the attempt's frames belong to
      // the session it created, whether or not the view follows the user there.
      // The selection itself is reported in the completion, not applied here.
      void selected;
      if (writer.kind === "home" && writer.migrateToSession) {
        writer = writer.migrateToSession(created);
      }
    },
  });
  return submitWebuiTurn({
    intent: args.intent,
    sessionId: args.sessionId,
    admission: args.admission,
    sending: args.sending,
    deps: args.deps,
    handlers: turnHandlers,
    ...(args.enqueueMessage ? { enqueueMessage: args.enqueueMessage } : {}),
    ...(args.taskSessions ? { submitTask: args.taskSessions } : {}),
    createSessionWorkspaceDir: args.createSessionWorkspaceDir,
    teamModeOff: args.teamModeOff,
  });
}

/**
 * What a turn command needs to run: the application-owned canonical record
 * repository, the session it is about, and the published capability slice.
 */
export interface WebuiTurnCommandContext {
  readonly store: WebuiSessionStore;
  readonly sessionId: string | undefined;
  readonly capabilities?: WebuiTurnCapabilitySlice;
  /**
   * Where each attempt's real disposer is registered, so the application holds
   * something it can close. Absent on a host that has no registry; the attempt
   * then simply cannot be detached by this client.
   */
  readonly deliveries?: WebuiDeliveryDisposers;
  /**
   * The session scope. An accepted attempt takes a **delivery** lease for as long
   * as it runs, so navigating away cannot release a session that still owes a
   * turn — and the lease ends when the attempt does, not when the view does.
   */
  readonly scope?: WebuiSessionScopeManager;
  /** The task use case the substrate creates through. */
  readonly taskSessions?: WebuiTaskSessionSubmitter;
  /** Refresh the mounted queue projection after an attached turn settles. */
  readonly refreshQueue?: () => void;
  /**
   * Reconcile a session whose turn may still be running after this client's own
   * response stream ended.
   *
   * The application installs this rather than the command running the probe
   * itself, because the session to reconcile is not always the one this owner
   * was built for: a first message creates the session it is sent to, and the
   * record moves onto it — so the target is named by the completion, not by the
   * context.
   */
  readonly reconcileTurn?: (sessionId: string) => void;
}

/** What a surface supplies to send: intent and data, never a writer or a sink. */
/**
 * The turn commands a surface invokes, with the application's own construction
 * behind them.
 *
 * A binding used to choose the record key, build the writer, mint the sink and
 * cut the transports out of the capability slice — four decisions about
 * application state, made in a React hook. They are made once here instead, so a
 * binding is a subscription plus an invocation, and a second surface (or a
 * headless caller) gets the same key choice, the same sink and the same
 * absent-capability refusal without repeating any of it.
 *
 * The record key is `sessionId ?? WEBUI_HOME_SESSION_KEY`: a first message may
 * create the session it is sent to, and the writer's own `migrateToSession`
 * carries the attempt from the home slot to that session.
 */
export function createWebuiConversationTurnCommands(
  context: WebuiTurnCommandContext,
): WebuiConversationTurnCommands {
  const { store, sessionId, capabilities, taskSessions, refreshQueue, reconcileTurn } = context;

  /**
   * The record writer for this turn: the session's, or the home slot's before a
   * first message creates the session. Kept as the store writer as well, because
   * the stop command needs the stream/sending writes the command adapter does not
   * publish.
   */
  const storeWriterFor = () =>
    sessionId
      ? store.createSessionWriter({ kind: "session", sessionId })
      : store.createSessionWriter({ kind: "home" });
  const writerFor = (): WebuiTurnCommandWriter => createWebuiTurnCommands(storeWriterFor());

  /**
   * The published views, bound to a writer of this owner's own. A
   * surface used to build these — and the writer behind them — itself, which made
   * every binding a second construction of the same two objects; they are built
   * here instead and handed out through the contract.
   */
  const viewWriter = storeWriterFor();
  const phase = createWebuiStreamPhaseCommands({ setStream: viewWriter.setStream });
  const lifecycle = createWebuiTurnLifecycleCommands({
    setStream: viewWriter.setStream,
    setSending: viewWriter.setSending,
  });

  /** The live slice of a record, read by the key it is filed under. */
  const readSessionStream = (sessionKey: string): WebuiStreamState =>
    store.readSession(sessionKey).stream;
  /** The live slice of this owner's record. */
  const readStream = (): WebuiStreamState =>
    readSessionStream(sessionId ?? WEBUI_HOME_SESSION_KEY);

  /**
   * The loop's transports, cut from the slice: an unwired operation is absent,
   * and the loop refuses with its own stated reason instead of a caller having
   * to know the operation is missing.
   */
  const recordKey = (): string => sessionId ?? WEBUI_HOME_SESSION_KEY;
  /**
   * One attempt's hold on its session: the registered disposer and the delivery
   * lease. Both start when the attempt opens and end when it settles — a
   * navigation in between must not release either.
   */
  const holdDelivery = (): {
    readonly onDelivery: (handle: { readonly close: () => void }) => void;
    readonly release: () => void;
  } => {
    return holdWebuiDelivery(recordKey, context.deliveries, context.scope);
  };
  const loopDeps = (
    hold: { readonly onDelivery: (handle: { readonly close: () => void }) => void },
  ): WebuiDeliveryTransports => ({
    ...(capabilities?.send
      ? { sendMessage: (body, onFrame) => capabilities.send!(body, onFrame, hold.onDelivery) }
      : {}),
    ...(capabilities?.resume
      ? {
          resumeSession: (body, onFrame) =>
            capabilities.resume!(body, onFrame, hold.onDelivery),
        }
      : {}),
    ...(capabilities?.load ? { loadHistory: capabilities.load } : {}),
  });

  // One shared, deduplicated probe per transport: `webuiActiveTurnProbeFor` keys
  // its cache by the `getActiveTurn` function, so the shell's rail probe and this
  // command set collapse a same-session probe into one round trip.
  const activeTurnProbe = (): WebuiActiveTurnProbe | undefined =>
    webuiActiveTurnProbeFor(capabilities?.activeTurn);

  /** Drop the lease only if it still carries the generation the probe decided is stale. */
  const releaseSubscription = (generation: number): void => {
    const writer = storeWriterFor();
    createWebuiTurnLifecycleCommands({
      setStream: writer.setStream,
      setSending: writer.setSending,
    }).releaseStreamSubscription(generation);
  };

  const settleStaleSubscription = (generation: number): void => {
    const writer = storeWriterFor();
    let settled = false;
    writer.setStream((current) => {
      const next = settleStaleWebuiSubscription(current, generation);
      settled = next !== current;
      return next;
    });
    if (settled) writer.setSending(false);
  };

  const attach = (turnId: string | undefined): Promise<void> => {
    const writer = writerFor();
    if (turnId === undefined) {
      // With no authoritative active turn, the recheck may be observing a
      // turn that completed between its lifecycle event and this probe. Force
      // the existing stream path to seed from persisted history instead of
      // resuming after the old cursor and silently keeping a stale transcript.
      let canReconcile = false;
      storeWriterFor().setStream((current) => {
        if (current.subscription) return current;
        canReconcile = true;
        return current.cursor === undefined ? current : { ...current, cursor: undefined };
      });
      if (!canReconcile) return Promise.resolve();
    }
    const hold = holdDelivery();
    return attachWebuiTurn({
      sessionId,
      turnId,
      ...(capabilities?.resume ? { resumeSession: capabilities.resume } : {}),
      ...(capabilities?.load ? { loadMessages: capabilities.load } : {}),
      readStream,
      setSending: writer.setTurnSending,
      // A turn-id-less attach is a history reconciliation after the active-turn
      // probe found no live work. It must replace stale transcript rows without
      // erasing the terminal error that the user needs to retry.
      sink: writer.createSink({ clearRefusalOnAnchor: turnId !== undefined }),
    }).finally(hold.release).then(() => {
      // A resumed stream can finish while the runtime is handing a queued
      // message to the next turn. `watchEvents` is deliberately non-barrier:
      // a `session.start` may be lost during reconnect or between acceptance
      // and the event iterator's first read. Reconcile once the old stream has
      // released its lease so an already-active follow-up turn is attached.
      if (turnId !== undefined) {
        refreshQueue?.();
        recover();
      }
    });
  };

  const probeDeps = (): Pick<WebuiRecheckSubscriptionDeps, "probe"> &
    Pick<WebuiRecoverMissedTurnDeps, "probe"> => {
    const probe = activeTurnProbe();
    return probe ? { probe } : {};
  };

  const recover = (): void =>
    recoverMissedWebuiTurn({
      sessionId,
      ...(capabilities?.activeTurn ? { getActiveTurn: capabilities.activeTurn } : {}),
      ...probeDeps(),
      readStream,
      settleStaleSubscription,
      attach,
    });

  return {
    recheck: (turnId) =>
      recheckWebuiSubscription({
        sessionId,
        ...(capabilities?.activeTurn ? { getActiveTurn: capabilities.activeTurn } : {}),
        ...probeDeps(),
        readStream,
        releaseSubscription,
        attach,
      }),
    recover,
    send: (intent) => {
      const writer = writerFor();
      const hold = holdDelivery();
      const admissionDeps = {
        store,
        capabilities: capabilities ?? {},
        ...(taskSessions ? { taskSessions } : {}),
      };
      const admission = readWebuiSubmissionAdmissionState(admissionDeps, { sessionId });
      const decision = classifyWebuiSubmission(admissionDeps, { sessionId });
      const ticket = sendWebuiTurn({
        sessionId,
        ...(taskSessions ? { taskSessions } : {}),
        intent: toSubmissionIntent(intent),
        admission: decision,
        attachments: intent.attachments,
        // The UI submits intent only. The execution owner reads the canonical
        // target at invocation time so a stale render cannot choose send vs queue.
        sending: admission.turnLive && decision.kind !== "unsupported" && decision.kind !== "needs-session",
        readStream: readSessionStream,
        deps: loopDeps(hold),
        ...(capabilities?.enqueue ? { enqueueMessage: capabilities.enqueue } : {}),
        ...(intent.createSessionWorkspaceDir
          ? { createSessionWorkspaceDir: intent.createSessionWorkspaceDir }
          : {}),
        ...(intent.teamModeOff ? { teamModeOff: intent.teamModeOff } : {}),
        // The writer and, through it, the sink are built here: the caller names
        // no key and holds no factory.
        createWriter: () => writer,
      });
      // The delivery hold covers the attempt, not the decision: releasing it the
      // moment the ticket exists would let a second submission through while the
      // first is still dispatching.
      void ticket?.completion
        .then((completion) => {
          hold.release();
          // The response stream is over; the turn is not necessarily over.
          //
          // A stream that ends says the runtime closed it — not that it finished
          // the turn. The runtime may have closed the stream early, or the queue
          // may have moved on to the next turn while this one was ending, and
          // either way the turn this client was following is not the only
          // candidate for "still running". Only the runtime's active-turn read
          // says which is true, so the client asks once its own stream is done
          // and re-attaches to whatever is still running.
          //
          // A queued submission has no stream of its own to end, so there is
          // nothing here to reconcile: the turn it joined is somebody else's
          // stream, and the queue's own events say when it starts.
          if (completion.kind !== "dispatched") return;
          reconcileTurn?.(completion.sessionId);
        })
        .catch(() => {
          hold.release();
        });
      return ticket;
    },
    attach: (turnId) => {
      void attach(turnId);
    },
    stop: async () => {
      if (!sessionId || !capabilities?.stop) return;
      await stopWebuiTurn({
        abortSession: capabilities.stop,
        sessionId,
        setSending: lifecycle.setTurnSending,
        settleStream: phase.settleStoppedStream,
      });
    },
    phase,
    lifecycle,
  };
}
