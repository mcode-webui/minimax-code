import type { WebuiGoal } from "../../../../shared/contracts/goal.js";
import type { WebuiComposerController, WebuiComposerControllerSnapshot, WebuiComposerSubmitOutcome } from "../contracts/composer-controller.js";
import type { WebuiComposerStore } from "./composer-store.js";
import type { WebuiComposerSubmitIntent } from "../contracts/composer-controller.js";
import type { WebuiComposerStagingState } from "../contracts/composer-state.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../contracts/composer-state.js";
import type { WebuiRunCommandRequest, WebuiCommandWorkflows } from "./command-workflows.js";
import type { WebuiConversationTurnCommands } from "../../turn/contracts/turn-commands.js";
import type { WebuiSubmissionCompletion, WebuiSubmissionTicket } from "../../turn/contracts/submission.js";
import { resolveWebuiSubmissionIntent } from "../projection/composer-state.js";
import { readWebuiComposerGoalModeAfterSubmit } from "../projection/composer-goal-outcome.js";
import { planWebuiRetryResend } from "./turn-retry.js";
import { formatWebuiError } from "../../../contracts/value-readers.js";
import { createWebuiComposerQueueCommands } from "./composer-queue.js";
import { shouldRecordWebuiComposerSubmission } from "../projection/composer-state.js";
import type { WebuiComposerObservationSink } from "../contracts/composer-observations.js";

export interface WebuiComposerControllerDeps {
  readonly store: WebuiComposerStore;
  readonly readSelectedSessionId: () => string | undefined;
  /**
   * Select the session a *send* created. The send's transfer and composer adoption are the task use
   * case's, so all that is left for the caller is the selection — and only when the use case says
   * the navigation claim that started the creation is still current.
   */
  readonly selectCreatedSession: (sessionId: string) => void;
  readonly turnCommandsFor: (sessionId: string | undefined) => WebuiConversationTurnCommands;
  readonly commandWorkflows: WebuiCommandWorkflows;
  readonly canEnqueue: boolean;
  readonly canSend: boolean;
  readonly readGoal: (sessionId: string) => WebuiGoal | undefined;
  /**
   * The goal submission command, which Goal owns: whether the objective is
   * created or patched — and on which owner — is decided there. The objective is
   * created as the home slot's session when there is no session.
   */
  readonly submitGoal: (input: {
    readonly sessionId?: string;
    readonly objective: string;
    readonly createSessionWorkspaceDir?: string;
    readonly teamModeOff?: boolean;
  }, onSessionCreated: (sessionId: string, selected: boolean) => void) => Promise<{ readonly goal: WebuiGoal; readonly sessionId: string }>;
  readonly refreshPending: (sessionId: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly refreshGoal: (sessionId: string) => Promise<void>;
  readonly recoverTurn: (sessionId: string) => void;
  readonly refreshInspection: (sessionId: string) => Promise<void>;
  /**
   * The application's observation scheduler.
   *
   * The composer contributes *interest* in an inspection identity; it does not own
   * a timer. Attaching used to run one immediate read and detaching dropped the
   * only reason the model and account facts were fresh at all, which made their
   * freshness depend on a rendered attachment rather than on a policy.
   */
  readonly observations?: WebuiComposerObservationSink;
  readonly clearHomeTurn: () => void;
}

const HOME_KEY = WEBUI_COMPOSER_HOME_KEY;

/** Application coordinator for the existing composer store and owners. */
export function createWebuiComposerController(deps: WebuiComposerControllerDeps): WebuiComposerController {
  let commandRunning = false;
  let goalSubmitting = false;
  let interactionError: string | undefined;
  let commandOutput: string | undefined;
  let inspectionSessionId: string | undefined;
  let createdSession: WebuiComposerControllerSnapshot["createdSession"];
  let viewGeneration = 0;
  let lastSelectedSessionId = deps.readSelectedSessionId();
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshot: WebuiComposerControllerSnapshot;

  const publish = (): void => {
    snapshot = {
      composer: deps.store.getSnapshot(),
      commandRunning,
      goalSubmitting,
      ...(interactionError === undefined ? {} : { interactionError }),
      ...(commandOutput === undefined ? {} : { commandOutput }),
      ...(inspectionSessionId === undefined ? {} : { inspectionSessionId }),
      canCompose: deps.canSend,
      canQueue: deps.canEnqueue && deps.readSelectedSessionId() !== undefined,
      canRunCommand: deps.commandWorkflows.canRunCommand,
      canRemoveQueued: deps.commandWorkflows.canRemoveQueued,
      ...(createdSession ? { createdSession } : {}),
    };
    for (const listener of [...listeners]) listener();
  };
  const keyNow = (): string => deps.readSelectedSessionId() ?? HOME_KEY;
  const setDraft = (text: string): void => deps.store.setDraft(keyNow(), text);

  /**
   * What one submission consumed, captured before it crossed any await.
   *
   * The identity is *the slot and the revisions that were submitted*, not whatever
   * happens to be selected when the work finishes. Everything a completion does to
   * the input goes through this: a user who switches sessions or types during a
   * command must not have another slot cleared, and a newer edit in the same slot
   * must survive the older completion.
   */
  interface CapturedInput {
    readonly key: string;
    readonly draftRevision: number;
    /** The staged value that was submitted; its identity is the consumption token. */
    readonly staging: WebuiComposerStagingState;
  }
  const captureInput = (): CapturedInput => {
    const key = keyNow();
    return {
      key,
      draftRevision: deps.store.readSlotRevision(key),
      staging: deps.store.readStaging(),
    };
  };
  /**
   * Clear the submitted slot's draft — and only while it is still the revision
   * that was submitted. Newer typing is never removed by an older completion.
   */
  const consumeDraft = (captured: CapturedInput): void => {
    if (deps.store.readSlotRevision(captured.key) !== captured.draftRevision) return;
    deps.store.setDraft(captured.key, "");
  };
  /** Clear staging only while the staged value submitted is still the staged value. */
  const consumeStaging = (captured: CapturedInput): void => {
    if (deps.store.readStaging() !== captured.staging) return;
    deps.store.setStaging({ attachments: [], urlReferences: [] });
  };

  /**
   * Clear a slot the input was *moved* into, by the revision the move produced.
   *
   * A submission that creates a session transfers the home record under the use case's
   * guards, so the input ends up in a slot the capture never named. The identity that
   * proves the text standing there is *this submission's* input is the destination
   * revision the adoption produced — text equality is not edit identity, and a slot the
   * user retyped to the same words is a different edit.
   */
  const consumeAdoptedDraft = (key: string, adoptedRevision: number): void => {
    if (deps.store.readSlotRevision(key) !== adoptedRevision) return;
    deps.store.setDraft(key, "");
  };
  const queueCommands = createWebuiComposerQueueCommands({
    store: deps.store,
    workflows: deps.commandWorkflows,
    onError: (message) => { interactionError = message; publish(); },
  });
  const refreshQueue = queueCommands.refresh;
  const queueView = (sessionId: string | undefined, turn: {
    readonly message: string;
    readonly clientIntent?: string;
    readonly attachments?: WebuiComposerSubmitIntent["attachments"];
    readonly planMode?: boolean;
    readonly createSessionWorkspaceDir?: string;
    readonly teamModeOff?: boolean;
  }, captured: CapturedInput): WebuiSubmissionTicket | undefined => {
    // Intent and data only — no setter crosses this boundary. The draft is
    // consumed through the link the assembly installed on the command set, and the
    // *staging* is consumed here, by its owner, on the admission the owner just
    // decided: admission is synchronous, so clearing on it preserves the timing the
    // mid-flight callback had while removing the caller-supplied business setter.
    const ticket: WebuiSubmissionTicket | undefined = deps.turnCommandsFor(sessionId).send({
      message: turn.message,
      ...(turn.clientIntent ? { clientIntent: turn.clientIntent } : {}),
      ...(turn.planMode ? { planMode: true } : {}),
      attachments: turn.attachments,
      ...(turn.createSessionWorkspaceDir
        ? { createSessionWorkspaceDir: turn.createSessionWorkspaceDir }
        : {}),
      ...(turn.teamModeOff ? { teamModeOff: turn.teamModeOff } : {}),
    });
    if (ticket && (ticket.admission.kind === "dispatching" || ticket.admission.kind === "queued")) {
      // The draft and the staged input are consumed by the same rule, on the same
      // admission: the exact revision that was submitted, cleared early because a
      // dispatch is not proof the host accepted it, and never the *current* slot's
      // contents, which the user may have replaced while the send was in flight.
      consumeDraft(captured);
      consumeStaging(captured);
    }
    return ticket;
  }

  snapshot = {
    composer: deps.store.getSnapshot(),
    commandRunning,
    goalSubmitting,
    canCompose: deps.canSend,
    canQueue: deps.canEnqueue && deps.readSelectedSessionId() !== undefined,
    canRunCommand: deps.commandWorkflows.canRunCommand,
    canRemoveQueued: deps.commandWorkflows.canRemoveQueued,
    ...(createdSession ? { createdSession } : {}),
  };
  const detachStore = deps.store.subscribe(publish);

  const controller: WebuiComposerController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: async (input) => {
      if (disposed) return { kind: "ignored" };
      interactionError = undefined;
      commandOutput = undefined;
      const sessionId = deps.readSelectedSessionId();
      const intent = resolveWebuiSubmissionIntent({
        draft: input.draft,
        commandMatch: input.commandMatch,
        ...(input.commandInvocationInput === undefined ? {} : { commandInvocationInput: input.commandInvocationInput }),
        goalMode: deps.store.readModes().goal,
        planMode: input.planMode ?? deps.store.readModes().plan,
      });
      const resolved = input.forceTurn
        ? { kind: "submit-turn" as const }
        : intent ?? (input.attachments?.length ? { kind: "submit-turn" as const } : undefined);
      if (!resolved) return { kind: "ignored" };
      if (shouldRecordWebuiComposerSubmission(resolved)) {
        deps.store.recordInput(keyNow(), input.draft);
      }
      if (resolved.kind === "activate-goal-mode") {
        deps.store.setModes({ goal: true, plan: false });
        setDraft("");
        publish();
        return { kind: "mode-activated", mode: "goal" };
      }
      if (resolved.kind === "activate-plan-mode") {
        deps.store.setModes({ plan: true });
        setDraft("");
        publish();
        return { kind: "mode-activated", mode: "plan" };
      }
      if (resolved.kind === "submit-goal") {
        if (!input.goalEnabled) return { kind: "ignored" };
        // Captured before the goal command awaits: the completion below clears the
        // slot that was submitted, whatever is selected by then.
        const captured = captureInput();
        goalSubmitting = true;
        publish();
        try {
          let createdSessionId: string | undefined;
          const result = await deps.submitGoal({
            sessionId,
            objective: resolved.objective,
            ...(input.createSessionWorkspaceDir ? { createSessionWorkspaceDir: input.createSessionWorkspaceDir } : {}),
            ...(input.teamModeOff ? { teamModeOff: true } : {}),
          }, (createdId, selected) => {
            createdSessionId = createdId;
            // The transfer and the composer's slot move are the use case's; the caller is left with
            // the selection, gated on the use case's own answer.
            if (selected) deps.selectCreatedSession(createdId);
            input.onSessionCreated?.(createdId, selected);
          });
          deps.store.setModes({ goal: readWebuiComposerGoalModeAfterSubmit(result.goal) });
          // The draft is what the goal submission consumed. The staged input is
          // *not* consumed here: a goal or a command is not the message those
          // attachments belong to, so it stays staged for the send that is.
          consumeDraft(captured);
          publish();
          return { kind: "goal-updated", sessionId: result.sessionId, ...(createdSessionId ? { createdSessionId } : {}) };
        } catch (error) {
          interactionError = formatWebuiError(error);
          publish();
          return { kind: "failed", error: interactionError };
        } finally {
          goalSubmitting = false;
          publish();
        }
      }
      if (resolved.kind === "run-command") {
        if (!deps.commandWorkflows.canRunCommand) return { kind: "ignored" };
        const captured = captureInput();
        commandRunning = true;
        publish();
        try {
          const request: WebuiRunCommandRequest = {
            command: resolved.command.name,
            ...(resolved.input ? { input: resolved.input } : {}),
            ...(sessionId ? { sessionId } : {}),
            agentName: input.agentName,
            ...(input.createSessionWorkspaceDir ? { workspaceDir: input.createSessionWorkspaceDir } : {}),
          };
          const result = await deps.commandWorkflows.runCommand(request);
          const output = typeof result.output === "string" ? result.output : JSON.stringify(result.data ?? result, null, 2);
          commandOutput = output;
          consumeDraft(captured);
          publish();
          return { kind: "command-completed", output };
        } catch (error) {
          interactionError = formatWebuiError(error);
          publish();
          return { kind: "failed", error: interactionError };
        } finally {
          commandRunning = false;
          publish();
        }
      }

      if (resolved.clientIntent === "plan-entry") deps.store.setModes({ goal: false, plan: true });
      const message = (resolved.message ?? input.draft).trim();
      deps.store.setRetry({ session: sessionId, message });
      // The ordinary path's capture: one identity for the queue refresh, the
      // staging consumption the submission performs, and the completion below.
      const captured = captureInput();
      // Captured *before* the submission, not just before the refresh. A user who
      // switches sessions while an enqueue is in flight must not have the mirror
      // reclaimed by the reply: the refresh is only allowed to apply if the
      // destination it was issued for is still the one it was captured against.
      const queueGeneration = sessionId ? queueCommands.captureDestination(sessionId) : undefined;
      // The ticket reports home creation before the turn settles; completion
      // later reports whether the submission dispatched or queued.
      const ticket = queueView(sessionId, {
        message,
        ...(resolved.clientIntent ? { clientIntent: resolved.clientIntent } : {}),
        attachments: input.attachments,
        ...(input.planMode ? { planMode: true } : {}),
        ...(input.createSessionWorkspaceDir ? { createSessionWorkspaceDir: input.createSessionWorkspaceDir } : {}),
        ...(input.teamModeOff ? { teamModeOff: true } : {}),
      }, captured);
      if (!ticket) return { kind: "ignored" };
      void ticket.creation.then((created) => {
        if (!created) return;
        if (created.selected) deps.selectCreatedSession(created.sessionId);
        // The home record was moved into the created session, so the input is in that
        // slot now: clearing only the slot it was captured in would leave it sitting in
        // the session it was sent to. The right to clear that slot is the revision the
        // adoption produced, and it is reported by the use case that performed it.
        if (created.adoptedRevision !== undefined) {
          consumeAdoptedDraft(created.sessionId, created.adoptedRevision);
        }
        createdSession = { ticketId: ticket.id, ...created };
        publish();
      });
      const operation = await ticket.completion;
      if (operation?.kind === "needs-session") return { kind: "needs-session", draft: input.draft };
      // A created session is named by the completion, and whether the view should
      // follow the user there is the use case's verdict, not something to guess.
      const created =
        operation !== undefined &&
        (operation.kind === "dispatched" || operation.kind === "queued") &&
        operation.created === true
          ? operation
          : undefined;
      const settledSessionId = created?.sessionId ?? sessionId;
      if (operation?.kind === "queued") {
        if (settledSessionId) {
          // A session this submission created had no pre-submit capture to hold
          // against; capturing now is the earliest the caller can see it.
          const generation = created
            ? queueCommands.captureDestination(settledSessionId)
            : queueGeneration;
          refreshQueue(settledSessionId, generation);
        }
        return {
          kind: "queued",
          sessionId: settledSessionId ?? sessionId!,
          ...(created && !sessionId ? { createdSessionId: created.sessionId } : {}),
        };
      }
      return {
        kind: "submitted",
        ...(settledSessionId ? { sessionId: settledSessionId } : {}),
        ...(created && !sessionId ? { createdSessionId: created.sessionId } : {}),
      };
    },
    retry: async ({ refusal, sessionId, ...input }) => {
      const recordedTurn = deps.store.readRetry();
      const plan = planWebuiRetryResend({ refusal, recordedSession: recordedTurn?.session, session: sessionId, lastSubmittedText: recordedTurn?.message });
      if (plan.kind !== "resend") return;
      // The resend is observed like any other submission. Discarding its outcome
      // meant a resend that landed on `needs-session` or `failed` did nothing the
      // user could see: no draft to retry from, no reason on screen, and the
      // recorded retry still advertising a message that never reached the runtime.
      const outcome = await controller.submit({ ...input, draft: plan.message, forceTurn: true });
      if (outcome.kind === "failed") {
        interactionError = outcome.error;
        publish();
        return;
      }
      if (outcome.kind === "needs-session") {
        // Nothing to send it to yet. The draft goes back where the user can
        // choose a session and resend from there, rather than vanishing.
        setDraft(outcome.draft);
        publish();
      }
    },
    removeQueued: ({ sessionId, itemId }) => queueCommands.remove({ sessionId, itemId, selectedSessionId: deps.readSelectedSessionId() }),
    refreshQueue: (sessionId) => refreshQueue(sessionId),
    selectSession: (sessionId) => {
      if (sessionId !== lastSelectedSessionId) deps.store.setModes({ goal: false });
      lastSelectedSessionId = sessionId;
      if (sessionId) refreshQueue(sessionId);
      else deps.clearHomeTurn();
      publish();
    },
    attachView: (sessionId) => {
      const generation = ++viewGeneration;
      inspectionSessionId = sessionId;
      // Inspection is an interest, not a one-off: the scheduler re-reads the model
      // catalogue and the account status on the foreground freshness budget while
      // this view is attached, and stops when it detaches or the page is hidden.
      // Detaching does not cancel an accepted Turn delivery; only observation.
      deps.observations?.setInspectionInterest(
        sessionId
          ? [
              {
                identity: `inspection:${sessionId}`,
                run: async (signal) => {
                  try {
                    await deps.refreshInspection(sessionId);
                  } catch (error) {
                    if (generation !== viewGeneration || !signal.isCurrent()) return;
                    interactionError = formatWebuiError(error);
                    publish();
                  }
                },
              },
            ]
          : [],
      );
      if (sessionId) {
        void deps.refreshPending(sessionId).then((outcome) => {
          if (!outcome.ok) throw new Error(outcome.error ?? "加载待处理请求失败");
        }).catch((error: unknown) => {
          if (generation !== viewGeneration) return;
          interactionError = formatWebuiError(error);
          publish();
        });
        deps.refreshGoal(sessionId).catch(() => undefined);
        deps.recoverTurn(sessionId);
      }
      publish();
      return () => {
        if (generation !== viewGeneration) return;
        viewGeneration += 1;
        inspectionSessionId = undefined;
        // The view that was interested is gone, so the identity leaves the
        // scheduler's interest set and its queued work is dropped.
        deps.observations?.setInspectionInterest([]);
        publish();
      };
    },
    setGoalMode: (enabled) => { deps.store.setModes({ goal: enabled, ...(enabled ? { plan: false } : {}) }); },
    setPlanMode: (enabled) => { deps.store.setModes({ plan: enabled }); },
    clearError: () => { interactionError = undefined; publish(); },
    setMentionRange: deps.store.setMentionRange,
    setStagedAttachments: (update) => deps.store.setStaging((current) => ({ attachments: update(current.attachments) })),
    setAttachmentBusy: (busy) => deps.store.setStaging({ busy }),
    consumeSeed: (token) => deps.store.setStaging({ seedToken: token }),
    setUrlReferences: (update) => deps.store.setStaging((current) => ({ urlReferences: update(current.urlReferences) })),
    setDraft: (text, sessionId) => deps.store.setDraft(sessionId ?? deps.readSelectedSessionId() ?? HOME_KEY, text),
    recordInput: (text, sessionId) => deps.store.recordInput(sessionId ?? deps.readSelectedSessionId() ?? HOME_KEY, text),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      viewGeneration += 1;
      detachStore();
      listeners.clear();
      inspectionSessionId = undefined;
    },
  };
  return controller;
}
