// The turn capability slice.
//
// `turn` reaches the harness through four capabilities — **send**, **resume**,
// **load** and **stop** — and this is the one published object that carries
// them. It exists so a turn intent can be submitted *without* the caller
// supplying any of them: the composition root holds the port in a closure,
// builds the slice once, and the binding that submits `attachTurn` /
// `sendTurn` / `stopTurn` reads the members at call time.
//
// Two further members ride along because the send path needs them and they are
// the same kind of thing: the queue's write (`enqueue`), used when a turn is
// already in flight, and `createSession`, used when the first message has no
// session to send into. They are cut from the same port and travel by the same
// rule; a later business carve re-slices them to `composer` and `sessions`.
//
// Every member is optional, exactly like the port it is cut from: `undefined`
// means the operation is not wired on this host, and the loop's own
// absent-capability guards then decide — a refused turn with a stated reason,
// never a thrown one. That is why the slice is built by dropping absent
// members rather than by assigning `undefined` to them: the two are the same
// to every reader, and dropping them keeps a structural comparison honest.

import type { ComposerPort } from "../../composer/contracts/command-port.js";
import type { TurnExecutionPort } from "../contracts/execution-port.js";
import type { WebuiClientMessageLoader } from "../../transcript/contracts/message-view.js";
import type { WebuiClientSessionCreator } from "../../sessions/contracts/session-port.js";

/** The capabilities a turn is run with, published as one object. */
export interface WebuiTurnCapabilitySlice {
  /** **send** — open a turn with a message. */
  readonly send?: TurnExecutionPort["sendMessage"];
  /** **resume** — anchor on a turn already running (or restart one). */
  readonly resume?: TurnExecutionPort["resumeSession"];
  /** **load** — read authoritative history for the anchor and the resync. */
  readonly load?: WebuiClientMessageLoader;
  /** **stop** — abort the running turn. */
  readonly stop?: TurnExecutionPort["abortSession"];
  /**
   * The active-turn probe. It rides on this slice because the presentation that
   * renders a turn no longer receives it as a prop: with it here, a consumer
   * reads the probe the same way it reads send/resume/stop.
   */
  readonly activeTurn?: TurnExecutionPort["getActiveTurn"];
  /** The queue's write; a send while a turn is in flight enqueues instead. */
  readonly enqueue?: ComposerPort["enqueueMessage"];
  /** Create the session a first message needs before that message is sent. */
  createSession?: WebuiClientSessionCreator;
}

/**
 * The port the slice is cut from. `WebuiTransport` satisfies it structurally,
 * so the composition root passes the transport it already holds instead of
 * naming six of its members at the call site.
 */
export interface WebuiTurnCapabilityPort {
  readonly sendMessage?: TurnExecutionPort["sendMessage"];
  readonly getActiveTurn?: TurnExecutionPort["getActiveTurn"];
  readonly resumeSession?: TurnExecutionPort["resumeSession"];
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly abortSession?: TurnExecutionPort["abortSession"];
  readonly enqueueMessage?: ComposerPort["enqueueMessage"];
  readonly createSession?: WebuiClientSessionCreator;
}

/** Cut the slice out of the port, dropping what this host does not wire. */
export function createWebuiTurnCapabilitySlice(
  port: WebuiTurnCapabilityPort,
): WebuiTurnCapabilitySlice {
  return {
    ...(port.sendMessage ? { send: port.sendMessage } : {}),
    ...(port.resumeSession ? { resume: port.resumeSession } : {}),
    ...(port.loadMessages ? { load: port.loadMessages } : {}),
    ...(port.abortSession ? { stop: port.abortSession } : {}),
    ...(port.getActiveTurn ? { activeTurn: port.getActiveTurn } : {}),
    ...(port.enqueueMessage ? { enqueue: port.enqueueMessage } : {}),
    ...(port.createSession ? { createSession: port.createSession } : {}),
  };
}
