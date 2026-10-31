// What a retry of a recorded turn sends, and where it starts.
//
// Carved out of `components/SessionComposer.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **3 declarations**, 2 functions, 1 type and constant they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

import type { WebuiRecordedTurn } from "../projection/composer-state.js";

export type WebuiRetryResendPlan =
  | { readonly kind: "resend"; readonly message: string }
  | {
      readonly kind: "withheld";
      readonly reason: "no-refusal" | "no-recorded-input";
    };

/**
 * Decide what a retry on a failed turn does.
 *
 * A retry RE-SENDS the input the user submitted. It must not abort: the abort
 * operation carries only a session id, so a "retry" wired to it killed a turn
 * that may still have been running instead of re-asking. The input therefore
 * comes from what this component recorded locally at submit time — never from
 * a server round-trip, which would be slower and able to return a different
 * message than the one that actually failed.
 *
 * `withheld` is the honest answer when there is nothing to re-send. A button
 * that cannot do the thing it names is worse than no button: the previous
 * defect was exactly a control that was present and could not work.
 */
export function planWebuiRetryResend(args: {
  readonly refusal: string | undefined;
  /** The session the recorded input was submitted in; `undefined` is home. */
  readonly recordedSession: string | undefined;
  readonly session: string | undefined;
  readonly lastSubmittedText: string | undefined;
}): WebuiRetryResendPlan {
  if (!args.refusal) return { kind: "withheld", reason: "no-refusal" };
  // `WebuiComposer` is not remounted per session, so a record left over from
  // the previous session would re-send that session's turn. A record is only
  // good for the session that produced it.
  if (args.recordedSession !== args.session)
    return { kind: "withheld", reason: "no-recorded-input" };
  const recorded = args.lastSubmittedText?.trim();
  if (!recorded) return { kind: "withheld", reason: "no-recorded-input" };
  return { kind: "resend", message: recorded };
}

/**
 * Run a retry: hand the recorded input back to the ordinary send path.
 *
 * Split out of the component so the decision and the resend are one testable
 * unit. `sendTurn` is the very function the submit path uses, so a retry
 * cannot drift into a second, subtly different way of sending — and there is no
 * abort anywhere in this path to wire it to by mistake.
 */
export function resendRecordedWebuiTurn(args: {
  readonly refusal: string | undefined;
  readonly recordedTurn: WebuiRecordedTurn | undefined;
  readonly session: string | undefined;
  readonly sendTurn: (turn: { readonly message: string }) => void | Promise<void>;
}): WebuiRetryResendPlan {
  const plan = planWebuiRetryResend({
    refusal: args.refusal,
    recordedSession: args.recordedTurn?.session,
    session: args.session,
    lastSubmittedText: args.recordedTurn?.message,
  });
  if (plan.kind === "resend") void args.sendTurn({ message: plan.message });
  return plan;
}
