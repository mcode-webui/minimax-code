// Effect reducer — extract the runtime-event switch from the
// `WebuiClientFoundationApp` component effect into a pure function.
//
// `app.tsx`'s `watchEvents` callback is an inline closure that closes over
// `sessionId`, `setStream`, `setSending`, `setPermissions`,
// `setQuestionnaire`, `setGoal`, and `refreshPending`. The closure does
// two things: (a) guard on the event's target session, and (b) dispatch
// on `event.type` to write a sequence of state changes and optionally
// kick off the async refresh. This module factors out the pure decision —
// `(state, event) → { state, commands }` — so a test can drive the
// production protocol without standing up a DOM.
//
// ## Design contract (W2.9)
//
//   1. The **session guard is the first thing** the reducer does. If
//      `eventSessionId(event) !== sessionId`, the reducer returns
//      `{ state, commands: [] }` — same object identity on the state, and
//      no workspace progress touched. An event carrying no string
//      `payload.sessionId` takes that same path, because
//      `eventSessionId` yields `undefined` for it and `undefined` never
//      equals the active session.
//   2. Workspace progress is **the first command** whenever the guard
//      passes. Every dispatched branch — including the `default` arm for
//      unknown event types — produces a `set-stream` command that
//      patches the new `workspaceProgress` first. The host executor walks
//      the command list in order; the first command is therefore the
//      progress write.
//
//      We do NOT short-circuit "value didn't change, skip the command".
//      The original closure built a fresh object on every event and
//      always called `setStream`; the reducer mirrors that. Skipping here
//      would also break the "command list = host setter trace" contract.
//   3. Behaviours that read like bugs but are deliberate:
//
//        a. `permission.resolved` and `questionnaire.dismiss`/`superseded`
//           always emit the `set-stream` command, but the phase write is
//           now guarded: it resumes the turn only when the event names the
//           request this client is still showing. The composer settles the
//           phase itself when the user answers locally, and the runtime
//           reports a questionnaire skip as `status:"answered"`, so an
//           unconditional flip turned a settled turn back into a live
//           "推理中" pulse. The command is still pushed either way, so the
//           "command list = host setter trace" contract is unchanged.
//        b. `session.finish`/`abort`/`error` write `refusal` only when
//           `payload.error` is a string; other shapes leave `refusal`
//           alone.

import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";
import {
  eventSessionId,
  pendingPermissionFromEvent,
  questionnaireFromEvent,
  replacePermission,
} from "./event-parsers.js";
import {
  initialWebuiWorkspaceProgress,
  reduceWebuiWorkspaceProgressEvent,
  type WebuiWorkspaceProgressState,
} from "./workspace-progress.js";
import {
  claimWebuiSubscriptionTurn,
  decideWebuiSessionStart,
  matchesWebuiTerminalTurn,
  releaseWebuiSubscription,
  type WebuiStreamState,
} from "./stream-state.js";
import { projectWebuiThreadGoalMessage } from "./goal-state.js";

/** The slice of component state the reducer mutates. Workspace progress
 *  lives on the stream slice (where `app.tsx` puts it) — see the source
 *  for `WebuiStreamState`. The full `WebuiClientFoundationApp` state has
 *  more (models, account status, …) but those are owned by sibling
 *  effects, not this one. */
export interface WebuiEffectState {
  readonly stream: WebuiStreamState;
  readonly permissions: readonly WebuiPendingPermission[];
  readonly questionnaire: WebuiQuestionnaireRequest | undefined;
  readonly goal: WebuiGoal | undefined;
}

/** One side effect the host executor must perform in order. The host
 *  walks the list in order; each command is a 1-to-1 trace of a setter
 *  call (or, for `refresh-pending`, a `void` async kick). */
export type WebuiEffectCommand =
  | { readonly type: "refresh-pending" }
  | { readonly type: "refresh-goal" }
  | {
      readonly type: "set-sending";
      readonly sending: boolean;
      /**
       * Optional live-state guard, evaluated when the command is applied
       * rather than when it is built. A terminal event for an older turn
       * must not clear the sending flag of the turn we have since attached
       * to, and the reducer's snapshot is too old to decide that.
       */
      readonly when?: (current: WebuiStreamState) => boolean;
    }
  | {
      readonly type: "set-stream";
      readonly patch: (current: WebuiStreamState) => WebuiStreamState;
    }
  | {
      readonly type: "set-permissions";
      readonly patch: (
        current: readonly WebuiPendingPermission[],
      ) => readonly WebuiPendingPermission[];
    }
  | {
      readonly type: "set-questionnaire";
      readonly patch: (
        current: WebuiQuestionnaireRequest | undefined,
      ) => WebuiQuestionnaireRequest | undefined;
    }
  | { readonly type: "set-goal"; readonly goal: WebuiGoal | undefined }
  | {
      readonly type: "attach-stream";
      readonly turnId: string | undefined;
      /** "recheck" means we hold another turn's lease and the active-turn probe decides. */
      readonly mode: "attach" | "recheck";
    };

export interface WebuiEffectResult {
  readonly state: WebuiEffectState;
  readonly commands: readonly WebuiEffectCommand[];
}

/** Initial state for tests and the `cancelled = true` effect-cleared path. */
export function initialWebuiEffectState(
  stream: WebuiStreamState,
): WebuiEffectState {
  return {
    stream,
    permissions: [],
    questionnaire: undefined,
    goal: undefined,
  };
}

/**
 * Pure event reducer. Returns the new state and the ordered list of
 * commands the host should run.
 *
 * `sessionId` is passed in by the host (the host already knows the
 * active session from its own state). The session guard runs first;
 * events not addressed to this session return the input state with an
 * empty command list and zero progress writes. See the module-level
 * contract for the order in which state writes happen.
 */
export function reduceWebuiEffect(
  state: WebuiEffectState,
  event: WebuiRuntimeEvent,
  sessionId: string,
): WebuiEffectResult {
  // (1) Session guard runs FIRST. Anything not addressed to the active
  // session is dropped wholesale — no progress write, no commands, exact
  // same state object. An event carrying no string `payload.sessionId`
  // takes this path too, since `eventSessionId` yields `undefined` for it.
  if (eventSessionId(event) !== sessionId) {
    return { state, commands: [] };
  }

  // (2) Compute the next workspace progress. The reducer is unconditional
  // — unknown event types still get reduced, even if no observable change
  // comes out. This is what the host closure did (it called the reducer
  // before the type dispatch).
  const nextWorkspaceProgress = reduceWebuiWorkspaceProgressEvent(
    state.stream.workspaceProgress,
    { type: event.type, ...event.payload },
    sessionId,
  );

  // (3) Build the command list. The first command is ALWAYS the progress
  // write — this is what lets trace 9 prove "progress first, then
  // dispatch" without the previous "same final state" weakness.
  const commands: WebuiEffectCommand[] = [
    {
      type: "set-stream",
      patch: (current) => ({ ...current, workspaceProgress: nextWorkspaceProgress }),
    },
  ];

  switch (event.type) {
    case "session.start": {
      commands.push({ type: "set-sending", sending: true });
      commands.push({
        type: "set-stream",
        patch: (current) => ({ ...current, phase: "streaming" }),
      });
      // The server starts turns this client did not initiate too — the goal
      // flow posts a hidden continuation prompt, a queued message drains,
      // another client sends. Those turns never reach the transcript unless
      // somebody opens a stream, and the transcript is the only thing that
      // renders them. Our own send already claimed the subscription, so the
      // decision keeps the two paths apart.
      const rawTurnId = event.payload.turnId;
      const turnId = typeof rawTurnId === "string" ? rawTurnId : undefined;
      const decision = decideWebuiSessionStart(state.stream, turnId);
      if (decision === "attach")
        commands.push({ type: "attach-stream", turnId, mode: "attach" });
      else if (decision === "recheck")
        commands.push({ type: "attach-stream", turnId, mode: "recheck" });
      else if (decision === "claim")
        commands.push({
          type: "set-stream",
          patch: (current) => claimWebuiSubscriptionTurn(current, turnId),
        });
      // `hold` already tracks this turn; `recheck` means we hold a stream for
      // a different one and cannot tell stale from concurrent from the event
      // alone — the active-turn probe owns that decision.
      break;
    }
    case "session.finish":
    case "session.abort":
    case "session.error": {
      const rawTurnId = event.payload.turnId;
      const turnId = typeof rawTurnId === "string" ? rawTurnId : undefined;
      // The whole terminal settles behind one guard. Scoping only the lease
      // release left the newer turn's phase and sending flag settled by the
      // older turn's finish — the spinner vanishing early, which is the
      // same defect class as the spinner that never leaves. Both patches and
      // the sending command ask the same question, so they cannot disagree.
      const isCurrentTurn = (current: WebuiStreamState) =>
        matchesWebuiTerminalTurn(current, turnId);
      commands.push({ type: "set-sending", sending: false, when: isCurrentTurn });
      const status =
        event.type === "session.finish"
          ? "finished"
          : event.type === "session.abort"
            ? "aborted"
            : "error";
      // `refusal` is written only when `payload.error` is a string — matches
      // the original closure's `typeof event.payload.error === "string"`
      // conditional. Other shapes (object, number, undefined) leave
      // `refusal` untouched.
      const refusalPatch = (current: WebuiStreamState): WebuiStreamState => {
        if (!isCurrentTurn(current)) return current;
        const nextState: WebuiStreamState = {
          ...current,
          phase: "done",
          status,
        };
        // The turn is over, so this client holds no stream for it any more.
        // Keeping the lease would make the next `session.start` collide with
        // a dead owner instead of attaching.
        const released = releaseWebuiSubscription(
          nextState,
          turnId === undefined ? undefined : { turnId },
        );
        return typeof event.payload.error === "string"
          ? { ...released, refusal: event.payload.error as string }
          : released;
      };
      commands.push({ type: "set-stream", patch: refusalPatch });
      break;
    }
    case "session.queue.updated": {
      commands.push({ type: "refresh-pending" });
      break;
    }
    case "permission.ask": {
      const permission = pendingPermissionFromEvent(event);
      if (permission) {
        commands.push({
          type: "set-permissions",
          patch: (current) => replacePermission(current, permission),
        });
        commands.push({
          type: "set-stream",
          patch: (current) => ({ ...current, phase: "waiting" }),
        });
      }
      // When the payload is malformed the closure used to be a no-op
      // for the permission+stream writes — only the progress command
      // remains. The trace 4 assertion now expects this exactly.
      break;
    }
    case "permission.resolved": {
      const requestId = event.payload.requestId;
      if (typeof requestId === "string") {
        commands.push({
          type: "set-permissions",
          patch: (current) =>
            current.filter((permission) => permission.requestId !== requestId),
        });
      }
      // Resuming the turn is only meaningful for a request this client was
      // actually showing. `handlePermission` (SessionComposer) already drops
      // the row and sets phase:"streaming" itself, so a late event for a
      // permission that is no longer pending must not resurrect the pulse.
      const resumesShownRequest =
        typeof requestId === "string" &&
        state.permissions.some(
          (permission) => permission.requestId === requestId,
        );
      commands.push({
        type: "set-stream",
        patch: resumesShownRequest
          ? (current) => ({ ...current, phase: "streaming" })
          : (current) => current,
      });
      break;
    }
    case "questionnaire.ask": {
      const request = questionnaireFromEvent(event);
      if (request) {
        commands.push({
          type: "set-questionnaire",
          patch: () => request,
        });
        commands.push({
          type: "set-stream",
          patch: (current) => ({ ...current, phase: "waiting" }),
        });
      }
      break;
    }
    case "thread_goal.objective_updated_steering": {
      // Steering announces that the objective moved on, but it carries only
      // `{ sessionId, goalId }` — no goal object — so there is nothing here to
      // project. The published name also did not match any case above, which
      // is why the old handler never fired for it at all.
      //
      // Re-read the goal instead of guessing a patch: steering is rare and the
      // read is authoritative. Publishing the full goal on this event would be
      // the alternative, but the event contract is shared with the TUI and
      // Desktop, so the repair belongs in the consumer that is broken.
      commands.push({ type: "refresh-goal" });
      break;
    }
    // Alternate spellings of the steering event. Nothing in this checkout
    // publishes them, but one unreachable branch is cheaper than a silently
    // stale banner against a version-skewed runtime.
    case "thread_goal.objective_updated":
    case "thread_goal.objective_steering":
    case "thread_goal.updated": {
      const nextGoal = event.payload.goal;
      if (nextGoal && typeof nextGoal === "object") {
        const projectedGoal = nextGoal as WebuiGoal;
        commands.push({ type: "set-goal", goal: projectedGoal });
        commands.push({
          type: "set-stream",
          patch: (current) => {
            const message = projectWebuiThreadGoalMessage(
              event.type,
              projectedGoal,
            );
            if (!message) return current;
            const messageId = message.id;
            const existing = current.messages.findIndex(
              (item) => item.id === messageId,
            );
            if (existing < 0)
              return { ...current, messages: [...current.messages, message] };
            const messages = [...current.messages];
            messages[existing] = message;
            return { ...current, messages };
          },
        });
      }
      break;
    }
    case "thread_goal.cleared": {
      commands.push({ type: "set-goal", goal: undefined });
      break;
    }
    case "questionnaire.dismiss":
    case "questionnaire.superseded": {
      const requestId = event.payload.requestId;
      // The closure always invoked setQuestionnaire with the patch
      // function when `requestId` is a string — even when the patch ends
      // up a no-op for non-matching ids. We mirror that: the command list
      // still carries a `set-questionnaire` so the trace matches.
      if (typeof requestId === "string") {
        commands.push({
          type: "set-questionnaire",
          patch: (current) =>
            current?.id === requestId ? undefined : current,
        });
      }
      // A dismiss for the questionnaire this client is still showing means
      // something else resolved it and the turn carries on. A dismiss for
      // anything else is a late echo: `handleQuestionnaire` / `handleDismiss`
      // have already cleared the card and settled the phase (idle after a
      // skip, streaming after a normal answer), and the runtime reports a
      // skip as `status:"answered"` (local-runtime questionnaire service), so
      // the payload cannot be used to tell the two apart. Flipping here
      // unconditionally is what stranded a live "推理中" pulse above the
      // answered questionnaire.
      const resumesShownRequest =
        typeof requestId === "string" && state.questionnaire?.id === requestId;
      commands.push({
        type: "set-stream",
        patch: resumesShownRequest
          ? (current) => ({ ...current, phase: "streaming" })
          : (current) => current,
      });
      break;
    }
    default:
      // Unknown event types fall through with just the progress command.
      break;
  }

  return {
    state: applyAllCommands(state, commands),
    commands,
  };
}

/** Apply every command's patch in order to derive the final state. The
 *  host executor does the same against its real React setters; running
 *  it here keeps the reducer pure and lets tests assert both the command
 *  list AND the resulting state in lockstep.
 *
 *  IMPORTANT: the progress patch comes from `commands[0]`, so this loop
 *  is what materialises `workspaceProgress` into the returned state.
 *  There is no separate `stream: { ...stream, workspaceProgress }`
 *  override — that would split "commands" from "state" and break the
 *  single-source-of-truth contract. */
function applyAllCommands(
  state: WebuiEffectState,
  commands: readonly WebuiEffectCommand[],
): WebuiEffectState {
  let stream = state.stream;
  let permissions = state.permissions;
  let questionnaire = state.questionnaire;
  let goal = state.goal;
  for (const cmd of commands) {
    if (cmd.type === "set-stream") stream = cmd.patch(stream);
    else if (cmd.type === "set-permissions") permissions = cmd.patch(permissions);
    else if (cmd.type === "set-questionnaire")
      questionnaire = cmd.patch(questionnaire);
    else if (cmd.type === "set-goal") goal = cmd.goal;
  }
  return { stream, permissions, questionnaire, goal };
}

/* --------------------------------------------------------------------------
 * Effect executor
 *
 * Walks a `WebuiEffectCommand[]` against a bag of host handlers. This is
 * the production glue between the pure reducer and the React setters.
 *
 * Contract:
 *   - `set-stream` / `set-permissions` / `set-questionnaire` are patch
 *     commands; we call `handlers.setX(cmd.patch)` exactly the way the
 *     host's `useState` setters expect (functional updater form).
 *     `questionnaire.ask` deliberately carries a `() => request` patch
 *     (passing a value would be equivalent under React 18+, but the
 *     "command list = setter call trace" contract needs every command
 *     to land on the same shape).
 *   - `set-sending` / `set-goal` are value commands; pass the value
 *     directly (`setGoal(undefined)` / `setSending(true)`).
 *   - `refresh-pending` is `void refreshPending().catch(() => undefined)`
 *     in the original closure. We swallow the rejection here too so
 *     `void` does not turn into an unhandled rejection.
 *   - Commands are walked in array order, no reordering.
 * ------------------------------------------------------------------------ */

export interface WebuiEffectHandlers {
  readonly refreshPending: () => void | Promise<unknown>;
  readonly setSending: (sending: boolean) => void;
  readonly setStream: (patch: (current: WebuiStreamState) => WebuiStreamState) => void;
  readonly setPermissions: (
    patch: (
      current: readonly WebuiPendingPermission[],
    ) => readonly WebuiPendingPermission[],
  ) => void;
  readonly setQuestionnaire: (
    patch: (
      current: WebuiQuestionnaireRequest | undefined,
    ) => WebuiQuestionnaireRequest | undefined,
  ) => void;
  readonly setGoal: (goal: WebuiGoal | undefined) => void;
  /**
   * Re-read the session goal from the server. Used for goal events that
   * announce a change without carrying the new goal, so the banner cannot be
   * projected from the event itself.
   *
   * Required on purpose: the reducer emits `refresh-goal` unconditionally, so
   * an optional handler would turn a missing wiring into a silent no-op — the
   * exact failure this repair exists to remove.
   */
  readonly refreshGoal: () => void | Promise<unknown>;
  /**
   * Open a stream for a turn the server started without this client. The
   * handler is responsible for claiming the subscription before it does, so
   * a second `session.start` for the same turn cannot open another.
   *
   * `mode: "recheck"` means we already hold a different turn's lease, so the
   * handler must consult the authoritative active turn before attaching.
   */
  readonly attachStream?: (
    turnId: string | undefined,
    mode: "attach" | "recheck",
  ) => void;
}

export function applyWebuiEffectCommands(
  commands: readonly WebuiEffectCommand[],
  handlers: WebuiEffectHandlers,
  readStream?: () => WebuiStreamState,
): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "refresh-pending":
        // The original closure wrote `void refreshPending().catch(...)`
        // — swallow rejections so this Promise doesn't surface as
        // unhandled. `handlers.refreshPending` returns `void |
        // Promise<unknown>`; if it returns a promise we attach the
        // catch, otherwise we drop it on the floor.
        Promise.resolve(handlers.refreshPending()).catch(() => undefined);
        break;
      case "refresh-goal":
        Promise.resolve(handlers.refreshGoal()).catch(() => undefined);
        break;
      case "set-sending":
        if (cmd.when && readStream && !cmd.when(readStream())) break;
        handlers.setSending(cmd.sending);
        break;
      case "set-stream":
        handlers.setStream(cmd.patch);
        break;
      case "set-permissions":
        handlers.setPermissions(cmd.patch);
        break;
      case "set-questionnaire":
        handlers.setQuestionnaire(cmd.patch);
        break;
      case "set-goal":
        handlers.setGoal(cmd.goal);
        break;
      case "attach-stream":
        handlers.attachStream?.(cmd.turnId, cmd.mode);
        break;
    }
  }
}

export function createWebuiWatchEventCallback(
  sessionId: string,
  readStream: () => WebuiStreamState,
  readState: () => Omit<WebuiEffectState, "stream">,
  handlers: WebuiEffectHandlers,
): (event: WebuiRuntimeEvent) => void {
  return (event) => {
    const commands = reduceWebuiEffect(
      { ...readState(), stream: readStream() },
      event,
      sessionId,
    ).commands;
    applyWebuiEffectCommands(commands, handlers, readStream);
  };
}

// `initialWebuiWorkspaceProgress` is re-exported only because a few tests
// reach for it as the "empty" workspace progress state. The reducer itself
// doesn't import it directly.
export { initialWebuiWorkspaceProgress };
