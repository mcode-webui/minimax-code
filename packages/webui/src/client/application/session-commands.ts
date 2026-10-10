// Purpose-named domain commands for the migrated execution state
// (plan §7.6 "Final state ownership and write authority"; ticket #45
// prerequisite 3).
//
// The session store owns the session record — the live stream, the `sending`
// flag, the pending permissions, the questionnaire and the goal — and every
// write to it is one of the named changes below, never a raw setter call from a
// component. This module is the **command surface** for those writes: a
// framework-free factory that binds the commands to a set of write targets, so
// a component *submits a command* (`startStreaming()`, `removePendingPermission
// (id)`) instead of holding and calling a store writer.
//
// Naming alone does not narrow authority, so the surface carries no
// reducer-taking writer: a command that accepted `(current) => next` would let a
// component rewrite any field of the slice and walk straight around the
// generation fence the owner applies. The stream's open-ended writes stay behind
// single-field intent commands (`markStreamPhase`, `setContextUsage`,
// `setStreamRefusal`, …), and the *lease* is not on this surface at all: a sink
// factory here would let a component mint a new lease at will and take one from
// a newer turn. Opening a turn's stream belongs to the binding that owns the
// store writer, which composes it into the attach/send intents a component
// submits (plan §7.2 `:555`, §7.6 `:583`). Nothing here
// opens a channel or reads a transport: the process-event ingress is untouched,
// and the write targets are injected exactly as `turn-commands.ts` already
// injects the setters it moved out of the composer.

import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import {
  initialWebuiStreamState,
  settleAbortedStream,
} from "../projection/stream-state.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import { releaseWebuiSubscription } from "../mechanisms/stream-lease.js";
import {
  buildWebuiStreamLoopSink,
  type WebuiStreamLoopSink,
} from "../mechanisms/stream-loop.js";
import { streamStateBundle } from "./stream-state-bundle.js";

/** The phases the stream slice can be moved to by name. */
export type WebuiStreamPhase = WebuiStreamState["phase"];

/** The write targets the stream and sending commands are bound to. */
export interface WebuiSessionCommandTargets {
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
}

export interface WebuiSessionCommands {
  /**
   * Replace the live stream with the idle initial state — returning to a blank
   * composer (New Task), so the previous session's turn cannot bleed through.
   */
  readonly clearStream: () => void;
  /** Apply the history-derived context snapshot without exposing the stream writer. */
  readonly setContextUsage: (contextUsage: Record<string, unknown>) => void;
  /**
   * The stream a turn is about to open: the slice resets to the initial state
   * with a live phase and a fresh elapsed anchor. Intent-named because the
   * reset is what "a turn starts here" means; the component has no way to reach
   * the slice otherwise.
   */
  readonly resetStreamForTurn: () => void;
  /** Record or clear the refusal banner's message. */
  readonly setStreamRefusal: (refusal: string | undefined) => void;
  /** Move the stream's phase without touching any other field. */
  readonly markStreamPhase: (phase: WebuiStreamPhase) => void;
  /** A turn is live: it is streaming. */
  readonly startStreaming: () => void;
  /** The turn ends locally. */
  readonly endStreaming: () => void;
  /** A pending interaction gates the turn. */
  readonly awaitInteraction: () => void;
  /**
   * The user stopped the turn: settle the slice to `done`/`aborted` and drop
   * the claim marker so the loop it silenced cannot write again.
   */
  readonly settleStoppedStream: () => void;
  /**
   * Release the subscription this client holds **only** if the live lease still
   * carries that generation, so a probe that started before a newer turn cannot
   * clear the newer lease.
   */
  readonly releaseStreamSubscription: (generation: number) => void;
  /** The `sending` indicator the composer renders from. */
  readonly setTurnSending: (sending: boolean) => void;
}

export function createWebuiSessionCommands(
  targets: WebuiSessionCommandTargets,
): WebuiSessionCommands {
  const { setStream, setSending } = targets;
  return {
    clearStream: () => setStream(() => initialWebuiStreamState),
    setContextUsage: (contextUsage) =>
      setStream((current) => ({ ...current, contextUsage })),
    resetStreamForTurn: () =>
      setStream(() => ({
        ...initialWebuiStreamState,
        phase: "streaming",
        processingStartedAtMs: Date.now(),
      })),
    setStreamRefusal: (refusal) => setStream((current) => ({ ...current, refusal })),
    markStreamPhase: (phase) => setStream((current) => ({ ...current, phase })),
    startStreaming: () =>
      setStream((current) => ({ ...current, phase: "streaming" })),
    endStreaming: () => setStream((current) => ({ ...current, phase: "idle" })),
    awaitInteraction: () =>
      setStream((current) => ({ ...current, phase: "waiting" })),
    settleStoppedStream: () => setStream(settleAbortedStream),
    releaseStreamSubscription: (generation) =>
      setStream((current) => releaseWebuiSubscription(current, { generation })),
    setTurnSending: (sending) => setSending(sending),
  };
}

/** The write targets the interaction commands are bound to. */
export interface WebuiInteractionCommandTargets {
  readonly setPermissions: (
    update: (
      current: readonly WebuiPendingPermission[],
    ) => readonly WebuiPendingPermission[],
  ) => void;
  readonly setQuestionnaire: (
    value:
      | WebuiQuestionnaireRequest
      | undefined
      | ((
          current: WebuiQuestionnaireRequest | undefined,
        ) => WebuiQuestionnaireRequest | undefined),
  ) => void;
  readonly setGoal: (goal: WebuiGoal | undefined) => void;
}

export interface WebuiInteractionCommands {
  /** A fresh read of the pending permissions replaces the current list. */
  readonly replacePendingPermissions: (
    permissions: readonly WebuiPendingPermission[],
  ) => void;
  /** Answering one permission drops exactly that request. */
  readonly removePendingPermission: (requestId: string) => void;
  /** Apply or clear the pending questionnaire. */
  readonly applyQuestionnaire: (
    request: WebuiQuestionnaireRequest | undefined,
  ) => void;
  /** Apply or clear the session goal. */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
}

export function createWebuiInteractionCommands(
  targets: WebuiInteractionCommandTargets,
): WebuiInteractionCommands {
  const { setPermissions, setQuestionnaire, setGoal } = targets;
  return {
    replacePendingPermissions: (permissions) =>
      setPermissions(() => permissions),
    removePendingPermission: (requestId) =>
      setPermissions((current) =>
        current.filter((item) => item.requestId !== requestId),
      ),
    applyQuestionnaire: (request) => setQuestionnaire(request),
    applyGoal: (goal) => setGoal(goal),
  };
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
  readonly createSink: () => WebuiStreamLoopSink;
  readonly resetStreamForTurn: () => void;
  readonly setStreamRefusal: (refusal: string | undefined) => void;
  readonly setTurnSending: (sending: boolean) => void;
  readonly migrateToSession?: (sessionId: string) => WebuiTurnCommandWriter;
}

export function createWebuiTurnCommands(writer: {
  readonly kind: "session" | "home";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
  readonly migrateToSession?: (sessionId: string) => {
    readonly kind: "session";
    readonly setStream: (
      update: (current: WebuiStreamState) => WebuiStreamState,
    ) => void;
    readonly setSending: (sending: boolean) => void;
  };
}): WebuiTurnCommandWriter {
  const commands = createWebuiSessionCommands({
    setStream: writer.setStream,
    setSending: writer.setSending,
  });
  return {
    kind: writer.kind,
    // The attempt's sink, built from this writer's own `setStream`: the fence
    // travels with the writer instead of being a convention the caller honours.
    createSink: () => buildWebuiStreamLoopSink(writer.setStream, streamStateBundle),
    resetStreamForTurn: commands.resetStreamForTurn,
    setStreamRefusal: commands.setStreamRefusal,
    setTurnSending: commands.setTurnSending,
    ...(writer.migrateToSession
      ? {
          migrateToSession: (sessionId: string) =>
            createWebuiTurnCommands(writer.migrateToSession!(sessionId)),
        }
      : {}),
  };
}
