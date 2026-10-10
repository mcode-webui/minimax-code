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
// The commands are named for the domain change they represent, not for the
// setter they replace: `startStreaming`, `endStreaming`, `awaitInteraction`,
// `clearStream` and `updateStream` are the stream slice's verbs, and
// `replacePendingPermissions`, `removePendingPermission`, `applyQuestionnaire`
// and `applyGoal` are the interaction slice's. Nothing here opens a channel or
// reads a transport: the process-event ingress is untouched, and the write
// targets are injected exactly as `turn-commands.ts` already injects the setters
// it moved out of the composer.

import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import { initialWebuiStreamState } from "../projection/stream-state.js";
import type { WebuiStreamState } from "../projection/stream-state.js";

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
  /** Turn orchestration callbacks; callers outside application workflows use named commands above. */
  readonly updateStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  /** Move the stream's phase without touching any other field. */
  readonly markStreamPhase: (phase: WebuiStreamPhase) => void;
  /** A turn is live: it is streaming. */
  readonly startStreaming: () => void;
  /** The turn ends locally. */
  readonly endStreaming: () => void;
  /** A pending interaction gates the turn. */
  readonly awaitInteraction: () => void;
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
    updateStream: (update) => setStream(update),
    markStreamPhase: (phase) => setStream((current) => ({ ...current, phase })),
    startStreaming: () =>
      setStream((current) => ({ ...current, phase: "streaming" })),
    endStreaming: () => setStream((current) => ({ ...current, phase: "idle" })),
    awaitInteraction: () =>
      setStream((current) => ({ ...current, phase: "waiting" })),
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
  /** Apply a permission-list update — the reducer's `set-permissions` arm. */
  readonly updatePermissions: (
    update: (
      current: readonly WebuiPendingPermission[],
    ) => readonly WebuiPendingPermission[],
  ) => void;
  /** Answering one permission drops exactly that request. */
  readonly removePendingPermission: (requestId: string) => void;
  /** Apply or clear the pending questionnaire. */
  readonly applyQuestionnaire: (
    request: WebuiQuestionnaireRequest | undefined,
  ) => void;
  /** Apply a questionnaire update — the reducer's `set-questionnaire` arm. */
  readonly updateQuestionnaire: (
    update: (
      current: WebuiQuestionnaireRequest | undefined,
    ) => WebuiQuestionnaireRequest | undefined,
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
    updatePermissions: (update) => setPermissions(update),
    removePendingPermission: (requestId) =>
      setPermissions((current) =>
        current.filter((item) => item.requestId !== requestId),
      ),
    applyQuestionnaire: (request) => setQuestionnaire(request),
    updateQuestionnaire: (update) => setQuestionnaire(update),
    applyGoal: (goal) => setGoal(goal),
  };
}

/**
 * A turn's stream/sending writer, expressed as the named commands a component
 * submits. It is a structural adapter — it imports no store — so a component
 * can build the writer for a send and immediately stop holding it: from then on
 * it only calls `updateStream` / `setTurnSending`, and the home→session
 * migration stays behind `migrateToSession` exactly as before.
 */
export interface WebuiTurnCommandWriter {
  readonly kind: "session" | "home";
  readonly updateStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
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
  return {
    kind: writer.kind,
    updateStream: (update) => writer.setStream(update),
    setTurnSending: (sending) => writer.setSending(sending),
    ...(writer.migrateToSession
      ? {
          migrateToSession: (sessionId: string) =>
            createWebuiTurnCommands(writer.migrateToSession!(sessionId)),
        }
      : {}),
  };
}
