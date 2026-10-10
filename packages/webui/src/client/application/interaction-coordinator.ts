// The interaction coordinator (plan §7.1 `client/application/interaction-coordinator.ts`).
//
// One owner for the interaction flows the composer used to run inline: the
// permission and questionnaire replies, and the authoritative re-read of pending
// permission and questionnaire state. It is framework-free — no React, no DOM —
// so it can be unit-tested against a scripted port.
//
// The split is *policy here, wiring there*. What counts as an accepted reply, and
// which state transition follows it, are decisions; they live here. The transport
// call, the store write and the stream-phase transition are wiring; the caller
// supplies them through the port and the sink. The composer keeps its one
// user-visible error slot, because that slot is shared with flows this owner does
// not run, so these commands return an outcome instead of writing an error
// themselves.
//
// All four of the duties §7.1 names for this file are here: the permission and
// questionnaire replies, the pending/questionnaire re-read, the goal re-read, and
// the late-read protection both re-reads need. The event coordinator still
// reaches them through `application/event-effects-registry.ts` — that registry is
// the per-session routing seam, not an owner, and the composer registers this
// coordinator's commands with it. This owner is constructed per
// session, so a re-read cannot land in the wrong one by construction rather than
// by a guard.

import type { InteractionPort } from "../contracts/interaction-port.js";
import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import { buildWebuiPlanApproveAnswers } from "../projection/plan-mode.js";

/** The transport methods this owner drives. Absent means "not wired". */
export type WebuiInteractionPortSlice = Pick<
  InteractionPort,
  | "listPendingPermissions"
  | "getPendingQuestionnaire"
  | "getGoal"
  | "replyPermission"
  | "replyQuestionnaire"
  | "dismissQuestionnaire"
>;

/** The store writes and stream-phase transitions a flow drives. */
export interface WebuiInteractionSink {
  readonly replacePendingPermissions: (
    permissions: readonly WebuiPendingPermission[],
  ) => void;
  readonly removePendingPermission: (requestId: string) => void;
  readonly applyQuestionnaire: (
    request: WebuiQuestionnaireRequest | undefined,
  ) => void;
  readonly awaitInteraction: () => void;
  /** The turn resumes after an allowed permission. */
  readonly resumeAfterPermission: () => void;
  /**
   * The turn resumes after an answer, or ends after a skip — see
   * `webuiAnswersEndTurn`. Leaving `streaming` after a skip strands the
   * transcript's thinking pulse, because a finished turn never sends the
   * `[DONE]` frame that would otherwise clear it.
   */
  readonly afterQuestionnaireAnswer: (
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => void;
  /** A dismissal never resumes the turn: the runtime only marks it dismissed. */
  readonly afterQuestionnaireDismiss: () => void;
  /** The one goal write path the coordinator drives. */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
  /**
   * After a steering re-read actually lands. The re-read is eventually
   * consistent, so the caller may want to reconcile view-only state (the
   * composer's goal mode) with what the read returned; the coordinator does not
   * own that state and does not guess at it.
   */
  readonly afterGoalReRead: (goal: WebuiGoal | undefined) => void;
}

/**
 * The result of a reply or a re-read. `error` is the message the caller shows in
 * its own error slot; a flow never writes that slot itself.
 */
export type WebuiInteractionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface WebuiInteractionCoordinator {
  /**
   * The authoritative re-read: pending permissions filtered to this session and
   * the pending questionnaire, applied through the sink. Queue state is not this
   * owner's: the composer reads it separately.
   */
  readonly refresh: () => Promise<WebuiInteractionOutcome>;
  /** Fence pending reads when an event or another owner changes this projection. */
  readonly invalidatePendingReads: () => void;
  readonly replyPermission: (
    permission: WebuiPendingPermission,
    decision: "allowOnce" | "allowAlways" | "deny",
  ) => Promise<WebuiInteractionOutcome>;
  readonly answerQuestionnaire: (
    request: WebuiQuestionnaireRequest,
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => Promise<WebuiInteractionOutcome>;
  readonly dismissQuestionnaire: (
    request: WebuiQuestionnaireRequest,
  ) => Promise<WebuiInteractionOutcome>;
  /**
   * The goal version, bumped by every goal write. A re-read captures it before
   * asking and compares after, so a late answer cannot resurrect the goal a
   * newer write already replaced.
   */
  readonly goalVersion: () => number;
  /**
   * The one goal write path. Every writer goes through it — a direct store write
   * would let an in-flight re-read resurrect the state it was meant to replace.
   */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
  /**
   * The steering re-read. Goal events announce that the objective moved without
   * carrying the new goal, so the banner is re-read rather than patched.
   */
  readonly refreshGoal: () => Promise<WebuiInteractionOutcome>;
}

/**
 * The goal version cell. It is injected rather than held here because this
 * coordinator is deliberately stateless: a component may construct it on every
 * render, and a counter that lived in the coordinator would reset each time and
 * silently disable the guards it protects. The *policy* — bump on every write,
 * capture before a read and compare after — stays here; only the storage is the
 * caller's.
 */
export interface WebuiGoalVersionCell {
  current: number;
}

export interface WebuiInteractionCoordinatorOptions {
  readonly port: WebuiInteractionPortSlice;
  readonly sink: WebuiInteractionSink;
  readonly goalVersionRef: WebuiGoalVersionCell;
  /** Persists request/mutation order across render-scoped coordinator objects. */
  readonly pendingVersionRef: WebuiGoalVersionCell;
  /** The session these flows belong to. Absent means nothing to refresh. */
  readonly sessionId?: string;
  /** Fallback requester name when the request carries none. */
  readonly agentName: string;
}

/** Application-owned plan-review reply; the transcript submits this intent. */
export function createWebuiPlanReviewWorkflow(options: {
  readonly replyQuestionnaire: InteractionPort["replyQuestionnaire"];
  readonly clearQuestionnaire: () => void;
}): {
  readonly answerPlanBuild: (request: WebuiQuestionnaireRequest) => Promise<void>;
} {
  return {
    answerPlanBuild: async (request) => {
      const reply = options.replyQuestionnaire;
      if (!reply) throw new Error("Questionnaire replies are unavailable");
      const result = await reply({
        name: request.requester?.agentName ?? "main",
        requestId: request.id,
        schemaVersion: request.schemaVersion,
        answers: buildWebuiPlanApproveAnswers(),
      });
      if (result.ok !== true) throw new Error("The plan decision was not accepted");
      options.clearQuestionnaire();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebuiInteractionCoordinator({
  port,
  sink,
  sessionId,
  agentName,
  goalVersionRef,
  pendingVersionRef,
}: WebuiInteractionCoordinatorOptions): WebuiInteractionCoordinator {
  const {
    listPendingPermissions,
    getPendingQuestionnaire,
    getGoal,
    replyPermission,
    replyQuestionnaire,
    dismissQuestionnaire,
  } = port;
  const applyGoal = (goal: WebuiGoal | undefined): void => {
    goalVersionRef.current += 1;
    sink.applyGoal(goal);
  };
  const invalidatePendingReads = (): void => {
    pendingVersionRef.current += 1;
  };

  return {
    invalidatePendingReads,
    refresh: async () => {
      // No session, nothing to read: the composer mounts without one on the home
      // screen, and a re-read there would ask for a session it does not have.
      if (!sessionId) return { ok: true };
      if (!listPendingPermissions && !getPendingQuestionnaire) return { ok: true };
      const versionAtRequest = ++pendingVersionRef.current;
      try {
        const [permissionResult, questionnaireResult] = await Promise.all([
          listPendingPermissions?.(),
          getPendingQuestionnaire?.({ name: agentName, sessionId }),
        ]);
        const sessionPermissions = (permissionResult?.requests ?? []).filter(
          (permission) => permission.sessionId === sessionId,
        );
        if (pendingVersionRef.current !== versionAtRequest) return { ok: true };
        // A committed snapshot advances the same version as events and
        // successful replies, fencing any older concurrent read.
        pendingVersionRef.current += 1;
        sink.replacePendingPermissions(sessionPermissions);
        sink.applyQuestionnaire(questionnaireResult?.request);
        if (sessionPermissions.length > 0 || questionnaireResult?.request)
          sink.awaitInteraction();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    replyPermission: async (permission, decision) => {
      if (!replyPermission) return { ok: true };
      invalidatePendingReads();
      try {
        const result = await replyPermission({
          name: permission.agentName,
          requestId: permission.requestId,
          reply: decision,
        });
        // A reply the server no longer holds is a failure the user has to see:
        // the request is gone, so staying silent would leave the prompt up.
        if (result.success !== true)
          throw new Error("The permission request was no longer pending");
        invalidatePendingReads();
        sink.removePendingPermission(permission.requestId);
        sink.resumeAfterPermission();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    answerQuestionnaire: async (request, answers) => {
      if (!replyQuestionnaire) return { ok: true };
      invalidatePendingReads();
      try {
        const result = await replyQuestionnaire({
          name: request.requester?.agentName ?? agentName,
          requestId: request.id,
          schemaVersion: request.schemaVersion,
          answers,
        });
        if (result.ok !== true) throw new Error("The questionnaire was not accepted");
        invalidatePendingReads();
        sink.applyQuestionnaire(undefined);
        sink.afterQuestionnaireAnswer(answers);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    goalVersion: () => goalVersionRef.current,

    applyGoal,

    refreshGoal: async () => {
      if (!sessionId || !getGoal) return { ok: true };
      // The same monotonically increasing cell orders reads and writes. A
      // later read supersedes an earlier one even when no event or user write
      // lands between them.
      const versionAtRequest = ++goalVersionRef.current;
      try {
        const nextGoal = await getGoal({ sessionId });
        // A newer write landed while this read was in flight: its answer is
        // stale and is dropped rather than applied over the newer goal.
        if (goalVersionRef.current !== versionAtRequest) return { ok: true };
        // Query completion is a goal commit too; keep every commit on the
        // versioned entry point so the next in-flight read observes it.
        applyGoal(nextGoal);
        sink.afterGoalReRead(nextGoal);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    dismissQuestionnaire: async (request) => {
      if (!dismissQuestionnaire) return { ok: true };
      invalidatePendingReads();
      try {
        const result = await dismissQuestionnaire({
          name: request.requester?.agentName ?? agentName,
          requestId: request.id,
        });
        if (result.ok !== true)
          throw new Error("The questionnaire could not be dismissed");
        invalidatePendingReads();
        sink.applyQuestionnaire(undefined);
        sink.afterQuestionnaireDismiss();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
