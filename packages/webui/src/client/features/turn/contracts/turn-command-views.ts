// The command views a session's record writer is bound to, published from Turn
// because the execution substrate is what drives them.
//
// The substrate both builds and drives these views now: their factories are
// `turn/application/stream-phase-commands.ts`, `turn-lifecycle-commands.ts` and
// `turn-command-writer.ts`, each of which needs the stream loop mechanism or the
// stream-state transforms and so stays an implementation. Publishing the shapes
// here keeps the phase/lifecycle vocabulary in one home rather than two, and it
// is what the sessions business reads when it builds a view for a record it owns.

import type { WebuiInteractionPhaseIntents, WebuiStreamPhase } from "./interaction-phase-intents.js";
import type { WebuiDeliverySink } from "../../../../shared/contracts/delivery.js";

export type { WebuiStreamPhase };

/**
 * The **stream-phase** view: every member moves or settles the `phase` field and
 * writes nothing else.
 *
 * The four transitions an interaction flow drives are published separately, as
 * `WebuiInteractionPhaseIntents`, because that flow decides *when* the phase moves
 * and needs no mechanism to say so. This view adds the one member that does need
 * one — `settleStoppedStream`, which settles an aborted slice.
 */
export interface WebuiStreamPhaseCommands extends WebuiInteractionPhaseIntents {
  /**
   * The user stopped the turn: settle the slice to `done`/`aborted` and drop
   * the claim marker so the loop it silenced cannot write again.
   */
  readonly settleStoppedStream: () => void;
}

/**
 * The **turn-lifecycle** view: opening a turn's stream, clearing it for a new
 * task, recording what it carries and closing it. It is the one view that also
 * writes the `sending` indicator, because `sending` is the submit's lifecycle
 * flag rather than part of the phase.
 */
export interface WebuiTurnLifecycleCommands {
  /**
   * The stream a turn is about to open: the slice resets to the initial state
   * with a live phase and a fresh elapsed anchor. Intent-named because the
   * reset is what "a turn starts here" means.
   */
  readonly resetStreamForTurn: () => void;
  /**
   * Replace the live stream with the idle initial state — returning to a blank
   * composer (New Task), so the previous session's turn cannot bleed through.
   */
  readonly clearStream: () => void;
  /** Record or clear the refusal banner's message. */
  readonly setStreamRefusal: (refusal: string | undefined) => void;
  /** The `sending` indicator the composer renders from. */
  readonly setTurnSending: (sending: boolean) => void;
  /**
   * Release the subscription this client holds **only** if the live lease still
   * carries that generation, so a probe that started before a newer turn cannot
   * clear the newer lease.
   */
  readonly releaseStreamSubscription: (generation: number) => void;
}

/**
 * A turn's stream writer, expressed as the named commands a component submits.
 * It is a structural adapter — it imports no store — so a component can build
 * it for a send and immediately stop holding it: from then on it only submits
 * the intents below, and the home→session migration stays behind
 * `migrateToSession` exactly as before.
 *
 * There is deliberately no `updateStream(update)`: the sink is built **inside**
 * the adapter, so the generation fence travels with the writer instead of being
 * a convention the caller has to honour.
 */
export interface WebuiTurnCommandWriter {
  readonly kind: "session" | "home";
  readonly createSink: (options?: { readonly clearRefusalOnAnchor?: boolean }) => WebuiDeliverySink;
  readonly resetStreamForTurn: () => void;
  readonly setStreamRefusal: (refusal: string | undefined) => void;
  readonly setTurnSending: (sending: boolean) => void;
  readonly migrateToSession?: (sessionId: string) => WebuiTurnCommandWriter;
}
