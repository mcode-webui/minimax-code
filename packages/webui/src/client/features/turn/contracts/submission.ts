// The submission vocabulary.
//
// `WebuiAttachmentInput` is the only shape this file needs from the wire, and it is
// named here rather than re-declared so an intent's attachments stay the same
// value the runtime receives.
//
// One submission is one intent classified by one decision and closed by one completion. The decision
// is what the admission rule concluded — not a UI instruction: the caller decides how a `busy` or an
// `unsupported` reads, and today's Composer says nothing for either.
//
// The completion never rejects. A refusal is a value, because the caller has to be able to report it
// and keep going: a rejected promise would make the refusal path the exception path, and the
// transition the Composer consumes has to be observable either way.

/**
 * What the user asked for, before any decision — as a **kind**, not as a bag of
 * optional fields.
 *
 * The bag is what this replaces. A submission that needs one more qualifier used
 * to add an optional field to `WebuiSubmissionIntent`, then to
 * `WebuiComposerSubmitArgs`, then to `WebuiSendTurnArgs`, and every caller had to
 * learn to pass it — four contracts to touch for one fact about an intent. A
 * kind is one member of one union: the caller picks a case, and the owner reads
 * the case rather than three optional fields that may or may not agree.
 */
import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";

export type WebuiSubmissionIntent =
  /** The user pressed send: dispatch a turn, queue it if one is already running. */
  | {
      readonly kind: "ordinary";
      readonly message: string;
      readonly attachments?: readonly WebuiAttachmentInput[];
    }
  /** The goal flow's submission. It dispatches, and names what it is driving. */
  | {
      readonly kind: "goal";
      readonly message: string;
    }
  /** A named command from a menu: the command is the payload, not the prose. */
  | {
      readonly kind: "command";
      readonly command: string;
      readonly message?: string;
    }
  /**
   * The caller knows a turn is running and asks to queue rather than dispatch.
   *
   * This does not replace the automatic queue on a live turn: an `ordinary`
   * intent that finds one still queues, and says so in its admission. The kind
   * exists so a caller that *knows* can ask, rather than inferring the queue
   * from live state and having to recompute it when that state moves.
   */
  | {
      readonly kind: "queued";
      readonly message: string;
      readonly attachments?: readonly WebuiAttachmentInput[];
    };

/** What the admission rule reads. All of it is observed state, none of it is intent. */
export interface WebuiSubmissionAdmissionState {
  /** The target session exists: a home submission has none until its creation returns. */
  readonly hasSession: boolean;
  /** The client can create the session the intent needs. */
  readonly canCreateSession: boolean;
  /** The client can dispatch a turn. */
  readonly canSend: boolean;
  /** The client can queue onto a running turn. */
  readonly canEnqueue: boolean;
  /** A turn is known to be running on the target. */
  readonly turnLive: boolean;
  /**
   * A creation is already in flight for the current home incarnation. This is the one piece of
   * state the reservation owns: the single-flight check itself lives where the create is issued.
   */
  readonly creating: boolean;
}

/** Why a submission was refused, in terms the caller can act on. */
export type WebuiSubmissionRefusal =
  | { readonly kind: "busy"; readonly reason: "creating" | "turn-live" }
  | { readonly kind: "unsupported"; readonly missing: "create-session" | "transport" }
  | { readonly kind: "needs-session" }
  | { readonly kind: "creation-failed"; readonly error: string }
  | { readonly kind: "failed"; readonly error: string };

/** The terminal state of one submission. Never a rejection. */
export type WebuiSubmissionCompletion =
  | {
      readonly kind: "dispatched";
      readonly sessionId: string;
      /** Whether this submission had to create the session first. */
      readonly created: boolean;
      /**
       * Whether the created session may be selected: false when the navigation
       * claim that started the creation is no longer current.
       *
       * A fact about what happened, not a setter — the caller still decides what
       * to do about it. It is here because the alternative was handing the caller
       * a callback whose *argument* was this value.
       */
      readonly selected: boolean;
    }
  | {
      readonly kind: "queued";
      readonly sessionId: string;
      /** Whether this submission had to create the session first. */
      readonly created: boolean;
      /** Whether that created session may be selected. A queued submission can
       * create one too, so a caller must not have to branch on the outcome kind
       * to find out. */
      readonly selected: boolean;
    }
  | WebuiSubmissionRefusal;

/**
 * The task/session use case, as the submission needs it. Declared structurally because
 * the use case is the application's own module: what crosses is the capability, not the assembly.
 *
 * `busy` means one creation per home incarnation, decided before any wire IO, with the input left
 * alone. `selected` means the created session is selected only while the navigation claim that
 * started the creation is still current.
 */
export interface WebuiTaskSessionSubmitter {
  /** Whether the current home incarnation already has a creation in flight. */
  readonly creationPending?: () => boolean;
  readonly submit: (input: {
    readonly name?: string;
    readonly workspaceDir?: string;
    readonly teamModeOff?: boolean;
    readonly inputRevision?: number;
  }) => Promise<
    | {
        readonly kind: "created";
        readonly sessionId: string;
        readonly selected: boolean;
        /**
         * The destination's composer-slot revision after the input was adopted.
         *
         * Present only when the composer record actually moved: it is the edit identity
         * the submission inherited, so a consumer that clears the destination can ask
         * "is this still the input I carried" instead of comparing text.
         */
        readonly adoptedRevision?: number;
      }
    | { readonly kind: "busy" }
    | { readonly kind: "unsupported" }
    | { readonly kind: "creation-failed"; readonly error: string }
  >;
}

/**
 * What the owner concluded about the submission **before** it did any work.
 *
 * A discriminated union rather than a string, because the refusal members carry
 * the reason and a caller acting on `busy` has to know which busy. `dispatching`
 * and `queued` are the two that are not refusals.
 */
export type WebuiSubmissionAdmission =
  | { readonly kind: "dispatching" }
  | { readonly kind: "queued" }
  | { readonly kind: "busy"; readonly reason: "creating" | "turn-live" }
  | { readonly kind: "unsupported"; readonly missing: "create-session" | "transport" }
  | { readonly kind: "needs-session" };

/**
 * One submission, as a single value the caller holds instead of a protocol it
 * has to sequence.
 *
 * The caller used to receive a set of business setters and a promise, and had to
 * know which callback to wire to which branch and when the promise settled.
 * That sequencing was the caller's to get right, and nothing in its type said so.
 *
 * The ticket is the whole protocol: the identity correlates the transition a
 * caller observes with the one the owner recorded, admission says what the
 * owner concluded immediately, creation reports a home session before its turn
 * stream settles, and completion says how the submission ultimately ended.
 * No setter crosses this boundary — copying application setters into the ticket
 * would preserve exactly the leak that made it necessary.
 */
export interface WebuiSubmissionTicket {
  /** Monotonic and process-local: what a caller correlates its transition on. */
  readonly id: number;
  readonly admission: WebuiSubmissionAdmission;
  /** Resolves when implicit home-session creation completes, before its turn stream settles. */
  readonly creation: Promise<
    | {
        readonly sessionId: string;
        readonly selected: boolean;
        readonly adoptedRevision?: number;
      }
    | undefined
  >;
  /**
   * Settles with what happened. **Never rejects** — a refusal is a value, so a
   * caller that only wants to know when it is done has no error path to forget.
   */
  readonly completion: Promise<WebuiSubmissionCompletion>;
}
