// The turn-review family's published port and outcome.
//
// The transcript's diff card and the review page both read this family, and
// neither of them owns it: the owner holds the query and the mutation, the
// surfaces hold their presentation.

import type {
  WebuiGetTurnDiffRequest,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiTurnDiffView,
} from "../../../../shared/contracts/session.js";

/**
 * The identity one turn review answer belongs to. A turn is identified by its
 * turn id, or by the assistant message that stands for it when the caller has no
 * turn id; `changeSetId` joins the key only when the caller names one, so a
 * request for the turn and a request for a changeset are different resources.
 */
export interface WebuiTurnReviewKey {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly assistantMessageId?: string;
  readonly changeSetId?: string;
}

/** The capabilities this family needs, injected by the assembly. */
export interface WebuiTurnReviewPort {
  readonly getTurnDiff?: (request: WebuiGetTurnDiffRequest) => Promise<WebuiTurnDiffView>;
  readonly revertTurnDiff?: (
    request: WebuiRevertTurnDiffRequest,
  ) => Promise<WebuiRevertTurnDiffResult>;
  readonly reapplyTurnDiff?: (
    request: WebuiReapplyTurnDiffRequest,
  ) => Promise<WebuiReapplyTurnDiffResult>;
}

/**
 * What a command did.
 *
 * `unsupported` and `failed` are deliberately different: the first means the
 * runtime never offered the capability, the second means it answered and
 * declined. Collapsing them made every failure read as an absent capability and,
 * because a mutation request is refused once `unsupported` is set, left the card
 * permanently unrecoverable.
 */
export type WebuiTurnReviewOutcome =
  | { readonly status: "applied" }
  | { readonly status: "unsupported" }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly reason: string };

/** A mutation that took effect, announced so the workspace family can be
 *  invalidated as part of settlement. */
export interface WebuiTurnReviewMutation {
  readonly sessionId: string;
  readonly action: "revert" | "reapply";
}
