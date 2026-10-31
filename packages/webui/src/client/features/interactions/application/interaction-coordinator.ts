// The interaction coordinator.
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
// Three duties stay here: the permission and questionnaire replies, the
// pending/questionnaire re-read, and the late-read protection that re-read needs.
// The goal re-read is not among them: it lives in `goal-coordinator.ts` with its
// own version cell, so the two fences cannot bump each other. The event
// coordinator reaches them through its permanent domain event routes
// (`WebuiDomainEventRoutes` in `features/turn/application/event-coordinator.ts`) —
// that route set is the per-session seam, not an owner, and the application
// assembly installs this coordinator's commands in it. This owner is constructed
// per session, so a re-read cannot land in the wrong one by construction rather
// than by a guard.

import type { InteractionPort } from "../contracts/interaction-port.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";
import { buildWebuiPlanApproveAnswers } from "../projection/plan-mode.js";
import { webuiAnswersEndTurn } from "../projection/questionnaire-state.js";
import type { WebuiInteractionPhaseIntents } from "../../turn/contracts/interaction-phase-intents.js";
import type { WebuiVersionCell } from "../../../application/version-cell.js";

/** The transport methods this owner drives. Absent means "not wired". */
export type WebuiInteractionPortSlice = Pick<
  InteractionPort,
  | "listPendingPermissions"
  | "getPendingQuestionnaire"
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
    /**
     * The requester name this call composes with, when the surface making the
     * call knows it (the composer does: the session list is its prop). Falls
     * back to the owner's reader, then to the request's own requester.
     */
    requesterName?: string,
  ) => Promise<WebuiInteractionOutcome>;
  readonly dismissQuestionnaire: (
    request: WebuiQuestionnaireRequest,
  ) => Promise<WebuiInteractionOutcome>;
}

export interface WebuiInteractionCoordinatorOptions {
  readonly port: WebuiInteractionPortSlice;
  readonly sink: WebuiInteractionSink;
  /**
   * `turn`'s published phase intents, invoked through their names.
   *
   * The rule is about **writers**, not about calling: this owner may invoke
   * another business's published command, and may not be handed that business's
   * state writers. The four stream transitions used to arrive as sink callbacks —
   * `awaitInteraction`, `resumeAfterPermission`, `afterQuestionnaireAnswer`,
   * `afterQuestionnaireDismiss`. They are turn's state and turn's commands, so the
   * flow calls them here and the outcome→transition policy stays with the flow
   * that knows it.
   *
   * The narrow intents rather than the full view: this flow never settles an
   * aborted slice, so it is not handed the member that does.
   */
  readonly streams: WebuiInteractionPhaseIntents;
  /** Persists request/mutation order across render-scoped coordinator objects. */
  readonly pendingVersionRef: WebuiVersionCell;
  /** The session these flows belong to. Absent means nothing to refresh. */
  readonly sessionId?: string;
  /**
   * Fallback requester name when the request carries none. A reader rather than
   * a fixed string: the session's agent is a property of the runtime's session
   * list, which is loaded after the owner exists.
   */
  readonly agentName: string | (() => string);
}

/** Application-owned plan-review reply; the transcript submits this intent. */
export function createWebuiPlanReviewWorkflow(options: {
  readonly answerQuestionnaire: WebuiInteractionCoordinator["answerQuestionnaire"];
}): {
  readonly answerPlanBuild: (request: WebuiQuestionnaireRequest) => Promise<void>;
} {
  return {
    answerPlanBuild: async (request) => {
      const outcome = await options.answerQuestionnaire(
        request,
        buildWebuiPlanApproveAnswers(),
      );
      if (!outcome.ok) throw new Error(outcome.error);
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
  pendingVersionRef,
  streams,
}: WebuiInteractionCoordinatorOptions): WebuiInteractionCoordinator {
  const {
    listPendingPermissions,
    getPendingQuestionnaire,
    replyPermission,
    replyQuestionnaire,
    dismissQuestionnaire,
  } = port;
  const agent = (): string => (typeof agentName === "function" ? agentName() : agentName);
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
          getPendingQuestionnaire?.({ name: agent(), sessionId }),
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
          streams.awaitInteraction();
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
        // An allowed permission resumes the turn: a `turn` command, not a writer.
        streams.startStreaming();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    answerQuestionnaire: async (request, answers, requesterName) => {
      if (!replyQuestionnaire)
        return { ok: false, error: "Questionnaire replies are unavailable" };
      invalidatePendingReads();
      try {
        const result = await replyQuestionnaire({
          name: request.requester?.agentName ?? requesterName ?? agent(),
          requestId: request.id,
          schemaVersion: request.schemaVersion,
          answers,
        });
        if (result.ok !== true) throw new Error("The questionnaire was not accepted");
        invalidatePendingReads();
        sink.applyQuestionnaire(undefined);
        // The answers→phase rule is this flow's policy (`webuiAnswersEndTurn`
        // decides whether a skip ended the turn); the transition itself is turn's
        // command. Leaving `streaming` after a skip strands the transcript's
        // thinking pulse, because a finished turn never sends the frame that
        // would clear it.
        streams.markStreamPhase(
          webuiAnswersEndTurn(answers) ? "idle" : "streaming",
        );
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
          name: request.requester?.agentName ?? agent(),
          requestId: request.id,
        });
        if (result.ok !== true)
          throw new Error("The questionnaire could not be dismissed");
        invalidatePendingReads();
        sink.applyQuestionnaire(undefined);
        // A dismissal never resumes the turn: the runtime only marks it dismissed.
        streams.endStreaming();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
