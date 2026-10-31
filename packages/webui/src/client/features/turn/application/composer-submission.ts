// The composer's submission, executed.
//
// It lives here because execution does: the substrate that dispatches a turn is Turn's, and it may not
// reach back into Composer's application modules to do it. Composer keeps what is Composer's — slash,
// goal and plan intent, the draft and history, attachment staging, the queue presentation, resend
// eligibility — and the intent it hands over arrives as `WebuiComposerSubmitArgs`.
//
// The submission now *reports* what it decided. Every callback it already called fires exactly as
// before, so this is additive to the callers that still read them; the returned operation is what the
// Composer will consume instead, and it is the honest classification of what happened rather
// than a prediction: the branch produces the completion and the decision is derived from it.

import type {
  WebuiComposerSubmitArgs,
  WebuiComposerSubmitHandlers,
} from "../../composer/contracts/composer-turn.js";
import {
  createdWebuiSessionId,
} from "../../sessions/contracts/session-port.js";
import { formatWebuiError } from "../../../contracts/value-readers.js";
import { readWorkspaceDirField } from "../../../projection/common/paths.js";
import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";
import type { WebuiDeliveryTransports } from "../../../../shared/contracts/delivery.js";
import type { WebuiClientMessageEnqueuer } from "../../composer/contracts/command-port.js";
import type { WebuiTaskSessionSubmitter } from "../contracts/submission.js";
import type {
  WebuiSubmissionAdmission,
  WebuiSubmissionCompletion,
  WebuiSubmissionIntent,
  WebuiSubmissionTicket,
} from "../contracts/submission.js";
import { queueWebuiTurn } from "./queue-command.js";
import { ownsWebuiStreamGeneration } from "../projection/stream-state.js";
import { runWebuiStreamLoop } from "../../../conversation/stream-loop.js";
import { classifyStreamFrame } from "./stream-frame-classify.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import { streamStateBundle } from "./stream-state-bundle.js";

export function buildWebuiComposerHandlers(
  args: WebuiComposerSubmitHandlers,
): WebuiComposerSubmitHandlers {
  return {
    createSink: args.createSink,
    resetStreamForTurn: args.resetStreamForTurn,
    setRefusal: args.setRefusal,
    ...(args.readStream ? { readStream: args.readStream } : {}),
    setSending: args.setSending,
    onNeedsSession: args.onNeedsSession,
    onSessionCreated: args.onSessionCreated,
    onQueued: args.onQueued,
  };
}

/** Ticket ids are process-local and monotonic: they correlate a transition with its submission. */
let nextSubmissionId = 0;

/**
 * What an intent means to the wire, read from the intent's **kind**.
 *
 * This is the whole point of making the intent a union: the mapping from "what the
 * user asked for" to "what the runtime is told" lives in one exhaustive switch,
 * so a new kind is one case here rather than an optional field threaded through
 * every contract between the caller and this module.
 */
function wireIntentFor(intent: WebuiSubmissionIntent): {
  readonly message: string;
  readonly clientIntent?: string;
  readonly attachments: readonly WebuiAttachmentInput[];
} {
  switch (intent.kind) {
    case "ordinary":
    case "queued":
      return {
        message: intent.message,
        ...(intent.attachments && intent.attachments.length
          ? { attachments: intent.attachments }
          : {}),
        attachments: intent.attachments ?? [],
      };
    case "goal":
      return { message: intent.message, clientIntent: "goal-entry", attachments: [] };
    case "command":
      return {
        message: intent.message ?? "",
        clientIntent: intent.command,
        attachments: [],
      };
  }
}

/**
 * Submit one turn and return its ticket.
 *
 * The ticket comes back **synchronously**: the admission is a conclusion about
 * observed state, and there is nothing to await before the owner has that state.
 * Only the completion is asynchronous, which is the shape the caller actually
 * wants — it can render the decision now and observe the outcome later, instead
 * of awaiting a promise that would have told it both at once.
 *
 * The callbacks below are the owner's, not the caller's. They existed on the
 * public submission so a caller could wire a business setter into a branch; the
 * caller now holds a ticket, and the owner performs its own writes.
 */
export function submitWebuiTurn(
  args: {
    readonly intent: WebuiSubmissionIntent;
    readonly sessionId: string | undefined;
    /** Decided by the owner from observed state, before any work. */
    readonly admission: WebuiSubmissionAdmission;
    readonly sending: boolean;
    readonly deps: WebuiDeliveryTransports;
    readonly handlers: WebuiComposerSubmitHandlers;
    readonly enqueueMessage?: WebuiClientMessageEnqueuer;
    readonly submitTask?: WebuiTaskSessionSubmitter;
    readonly createSessionWorkspaceDir?: string;
    readonly teamModeOff?: boolean;
  },
): WebuiSubmissionTicket {
  const id = ++nextSubmissionId;
  const handlers = args.handlers;
  const { message, clientIntent, attachments } = wireIntentFor(args.intent);
  let resolveCreation!: (
    created:
      | {
          readonly sessionId: string;
          readonly selected: boolean;
          readonly adoptedRevision?: number;
        }
      | undefined,
  ) => void;
  const creation = new Promise<
    | {
        readonly sessionId: string;
        readonly selected: boolean;
        readonly adoptedRevision?: number;
      }
    | undefined
  >((resolve) => {
    resolveCreation = resolve;
  });

  /**
   * The promise a caller observes. It never rejects: every failure below is
   * caught and returned as a value, so a caller awaiting completion has no error
   * path it can forget to handle.
   */
  const completion = (async (): Promise<WebuiSubmissionCompletion> => {
    try {
      return await runSubmission();
    } catch (error) {
      return ({ kind: "failed", error: formatWebuiError(error) });
    }
  })();
  void completion.then(() => resolveCreation(undefined));

  async function runSubmission(): Promise<WebuiSubmissionCompletion> {
    // Nothing to submit is not a refusal: it never reached a decision. What
    // counts as "something" is a property of the intent's **kind**, not of the
    // text: a `command` carries its payload in the command name, so a nameless
    // prose body is still a complete submission and must not be refused here.
    const carriesPayload =
      args.intent.kind === "command" ||
      message.trim().length > 0 ||
      attachments.length > 0;
    if (!carriesPayload) {
      return { kind: "failed", error: "Nothing to submit" };
    }
    if (!args.deps.sendMessage && !args.enqueueMessage) {
      // The baseline returned silently here, before it would have created
      // anything: a creator alone is not a way to deliver a message.
      return ({ kind: "unsupported", missing: "transport" });
    }

    let sessionId = args.sessionId;
    let created = false;
    // The use case's selection verdict, reported rather than applied: a caller
    // decides what to do with it, and the submission only has to survive it.
    let selectedAfterCreation = false;
    if (!sessionId) {
      const submitTask = args.submitTask;
      if (!submitTask) {
        handlers.onNeedsSession?.(args.intent.kind === "command" ? "" : args.intent.message);
        return ({ kind: "needs-session" });
      }
      let workspaceDir: string | undefined;
      try {
        workspaceDir = readWorkspaceDirField(args.createSessionWorkspaceDir);
      } catch (error) {
        const text = formatWebuiError(error);
        handlers.setRefusal(text);
        return ({ kind: "creation-failed", error: text });
      }
      // The creation is the task use case's: single-flight per home incarnation,
      // it transfers the home record onto the created session under the
      // destination-wins and purge guards, and it reports whether the created
      // session may be selected.
      const outcome = await submitTask.submit({
        name: "main",
        ...(workspaceDir === undefined ? {} : { workspaceDir }),
        ...(args.teamModeOff === undefined ? {} : { teamModeOff: args.teamModeOff }),
      });
      if (outcome.kind === "unsupported") {
        handlers.onNeedsSession?.(args.intent.kind === "command" ? "" : args.intent.message);
        return ({ kind: "needs-session" });
      }
      if (outcome.kind === "busy") return ({ kind: "busy", reason: "creating" });
      if (outcome.kind === "creation-failed") {
        handlers.setRefusal(outcome.error);
        return ({ kind: "creation-failed", error: outcome.error });
      }
      sessionId = outcome.sessionId;
      created = true;
      selectedAfterCreation = outcome.selected;
      resolveCreation({
        sessionId,
        selected: outcome.selected,
        ...(outcome.adoptedRevision === undefined
          ? {}
          : { adoptedRevision: outcome.adoptedRevision }),
      });
      handlers.onSessionCreated?.(sessionId, outcome.selected);
    }
    if (sessionId === undefined) return ({ kind: "failed", error: "No session to submit to" });
    if (args.sending || args.intent.kind === "queued") {
      if (!args.enqueueMessage) {
        // A live turn with nowhere to queue: refused, and the caller may keep the
        // input. The baseline dropped it in silence.
        return ({ kind: "busy", reason: "turn-live" });
      }
      let refusal: string | undefined;
      await queueWebuiTurn({
        sessionId,
        message,
        ...(clientIntent ? { clientIntent } : {}),
        ...(attachments.length ? { attachments } : {}),
        enqueueMessage: args.enqueueMessage,
        onQueued: handlers.onQueued,
        setRefusal: (next) => {
          refusal = next;
          handlers.setRefusal(next);
        },
      });
      return refusal === undefined
        ? { kind: "queued", sessionId, created, selected: selectedAfterCreation }
        : { kind: "failed", error: refusal };
    }
    if (!args.deps.sendMessage) return ({ kind: "unsupported", missing: "transport" });
    handlers.setSending(true);
    handlers.resetStreamForTurn();
    let claimed: number | undefined;
    try {
      claimed = await runWebuiStreamLoop(
        { ...args.deps, classify: classifyStreamFrame },
        {
          sessionId,
          message,
          ...(clientIntent ? { clientIntent } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        handlers.createSink(),
      );
    } finally {
      const current = handlers.readStream?.();
      if (current === undefined || ownsWebuiStreamGeneration(current, claimed)) {
        handlers.setSending(false);
      }
    }
    return { kind: "dispatched", sessionId, created, selected: selectedAfterCreation };
  }

  return { id, admission: args.admission, creation, completion };
}
