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
// Ownership boundary, stated because the file name is broader than what it holds:
// the goal re-read and its version guard are still in the composer, and the
// pending/questionnaire/goal re-reads registered with the event coordinator still
// route through `application/event-effects-registry.ts`. Moving those here is the
// rest of this file's duty sentence and is not done. This owner is constructed per
// session, so a re-read cannot land in the wrong one by construction rather than
// by a guard.

import type { InteractionPort } from "../contracts/interaction-port.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";

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
}

export interface WebuiInteractionCoordinatorOptions {
  readonly port: WebuiInteractionPortSlice;
  readonly sink: WebuiInteractionSink;
  /** The session these flows belong to. Absent means nothing to refresh. */
  readonly sessionId?: string;
  /** Fallback requester name when the request carries none. */
  readonly agentName: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebuiInteractionCoordinator({
  port,
  sink,
  sessionId,
  agentName,
}: WebuiInteractionCoordinatorOptions): WebuiInteractionCoordinator {
  const {
    listPendingPermissions,
    getPendingQuestionnaire,
    replyPermission,
    replyQuestionnaire,
    dismissQuestionnaire,
  } = port;

  return {
    refresh: async () => {
      // No session, nothing to read: the composer mounts without one on the home
      // screen, and a re-read there would ask for a session it does not have.
      if (!sessionId) return { ok: true };
      if (!listPendingPermissions && !getPendingQuestionnaire) return { ok: true };
      try {
        const [permissionResult, questionnaireResult] = await Promise.all([
          listPendingPermissions?.(),
          getPendingQuestionnaire?.({ name: agentName, sessionId }),
        ]);
        const sessionPermissions = (permissionResult?.requests ?? []).filter(
          (permission) => permission.sessionId === sessionId,
        );
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
        sink.removePendingPermission(permission.requestId);
        sink.resumeAfterPermission();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    answerQuestionnaire: async (request, answers) => {
      if (!replyQuestionnaire) return { ok: true };
      try {
        const result = await replyQuestionnaire({
          name: request.requester?.agentName ?? agentName,
          requestId: request.id,
          schemaVersion: request.schemaVersion,
          answers,
        });
        if (result.ok !== true) throw new Error("The questionnaire was not accepted");
        sink.applyQuestionnaire(undefined);
        sink.afterQuestionnaireAnswer(answers);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    dismissQuestionnaire: async (request) => {
      if (!dismissQuestionnaire) return { ok: true };
      try {
        const result = await dismissQuestionnaire({
          name: request.requester?.agentName ?? agentName,
          requestId: request.id,
        });
        if (result.ok !== true)
          throw new Error("The questionnaire could not be dismissed");
        sink.applyQuestionnaire(undefined);
        sink.afterQuestionnaireDismiss();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
