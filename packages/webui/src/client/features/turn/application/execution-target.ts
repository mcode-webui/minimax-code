// What a submission's target looks like right now. The creation reservation is bound here.
//
// The admission rule in `submission-admission.ts` is pure and takes state; this is where the state
// comes from, so the rule never has to be told a fact the client already knows. Nothing passes
// `sending` down any more: the record that carries it is read under the same key the turn commands
// use — the target's session, or the home record when the submission has no session yet.

import { WEBUI_HOME_SESSION_KEY } from "../../../application/state.js";
import type {
  WebuiSubmissionAdmissionState,
  WebuiSubmissionAdmission,
} from "../contracts/submission.js";
import type { WebuiTurnCapabilitySlice } from "./turn-capabilities.js";
import { admitWebuiSubmission } from "./submission-admission.js";

/** The target a submission names. An absent session is the home surface. */
export interface WebuiExecutionTarget {
  readonly sessionId?: string;
}

/** What the reader needs: the canonical record, the cut capability slice, and the creation use case. */
export interface WebuiExecutionObservationDeps {
  /** The canonical store, narrowed to the one read this needs. */
  readonly store: {
    readonly readSession: (sessionKey: string) => { readonly sending: boolean };
  };
  readonly capabilities: WebuiTurnCapabilitySlice;
  /**
   * The task/session use case, for the creation reservation. Absent on a host that has no creation use
   * case, which means no creation can be in flight either.
   */
  readonly taskSessions?: { readonly creationPending?: () => boolean };
}

/**
 * Read the target's admission state.
 *
 * `canSend` / `canEnqueue` / `canCreateSession` are the cut slice's own members rather than a second
 * capability source: the slice is already "what this host wires", so its absence is the answer.
 */
export function readWebuiSubmissionAdmissionState(
  deps: WebuiExecutionObservationDeps,
  target: WebuiExecutionTarget,
): WebuiSubmissionAdmissionState {
  const hasSession = target.sessionId !== undefined;
  return {
    hasSession,
    canCreateSession: deps.capabilities.createSession !== undefined,
    canSend: deps.capabilities.send !== undefined,
    canEnqueue: deps.capabilities.enqueue !== undefined,
    turnLive: deps.store.readSession(target.sessionId ?? WEBUI_HOME_SESSION_KEY).sending,
    // The reservation is per home incarnation and only a home submission can be behind one: a
    // session target is not waiting on a creation, so it never reads as `creating`.
    creating: !hasSession && (deps.taskSessions?.creationPending?.() ?? false),
  };
}

/** Read the target's state and classify the submission in one step, which is how the owner calls it. */
export function classifyWebuiSubmission(
  deps: WebuiExecutionObservationDeps,
  target: WebuiExecutionTarget,
): WebuiSubmissionAdmission {
  return admitWebuiSubmission(readWebuiSubmissionAdmissionState(deps, target));
}
