// The application event coordinator.
//
// It is the **sole consumer of the process-event channel** and the sole owner of
// the two write paths that used to be spread across the shell, the composer and
// both workspace panels:
//
//   * it routes each process event to the *existing* domain reducers — the
//     activity reducer and the effect reducer are kept unchanged; what is
//     unified is the ingress, the owned effect execution and the write
//     authority, not the reducers themselves;
//   * it runs the effect commands the effect reducer produces against the
//     store's writers, so components no longer compute and apply business
//     effects from a raw event callback;
//   * live stream frames do not come through here at all. They arrive at the
//     stream sink (`client/conversation/stream-loop.ts`), which owns the single
//     lease fence; this coordinator handles process events only.
//
// One channel, one coordinator: `attach` subscribes exactly once and `detach`
// only removes that one listener. The channel's lifetime belongs to the
// application, so unsubscribing never tears it down.

import type { WebuiRuntimeEvent } from "../../../../shared/contracts/stream.js";
import type { WebuiGoal } from "../../../../shared/contracts/goal.js";
import {
  reduceWebuiEffect,
} from "./effect-reducer.js";
import type {
  WebuiEffectCommand,
  WebuiEffectState,
} from "./effect-reducer.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
// The same resolver the effect reducer's own session guard uses. It carries
// the nested-goal fallback for `thread_goal.*` events, whose payload declares
// the id inside `goal` rather than at the top level. Reading the top level
// only here dropped every such event before it could reach the reducer.
import { eventSessionId } from "../../../projection/common/event-parsers.js";
import type { WebuiProcessEventChannel } from "./event-channel.js";
import type { WebuiSessionStore } from "../../../application/session-store.js";
import type { WebuiApplicationSessionState } from "../../../application/state.js";
import type { WebuiStreamLeaseController } from "./stream-lease-controller.js";
import { readWebuiSessionFact, type WebuiSessionFact } from "./session-fact.js";

/**
 * One session-record write, taken out of an event's command list.
 *
 * The patches are the session's own slices, so they can all be folded into a
 * single update; the commands that are not this — an owner's fenced write, a
 * refresh, an attach — are not, and run separately.
 */
export type WebuiSessionStatePatch =
  | {
      readonly type: "set-stream";
      readonly patch: (current: WebuiStreamState) => WebuiStreamState;
    }
  | {
      readonly type: "set-sending";
      readonly sending: boolean;
      /**
       * Optional live-state guard, resolved against the *store* before the
       * batch is folded — never against the batch's own earlier patches.
       *
       * That is the whole point of the guard: a terminal event for an older turn
       * must not clear the sending flag of the turn we have since attached to,
       * and the event's own progress patch has already released the lease the
       * guard would otherwise read. A batch that consulted itself would answer
       * the question the guard exists to avoid.
       */
      readonly when?: (current: WebuiStreamState) => boolean;
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
    };

export interface WebuiEffectHandlers {
  readonly refreshPending: () => void | Promise<unknown>;
  readonly refreshQueue?: () => void;
  /**
   * Commit every patch one event produced, in the order the event produced them.
   *
   * One call, one notification, one render: a subscriber that reads the record
   * between two patches of the same event would otherwise see a state that never
   * existed — the progress write applied without the turn write that explains
   * it — and could act on it.
   */
  readonly applyPatches: (patches: readonly WebuiSessionStatePatch[]) => void;
  readonly setGoal: (goal: WebuiGoal | undefined) => void;
  readonly refreshGoal: () => void | Promise<unknown>;
  readonly attachStream?: (turnId: string | undefined, mode: "attach" | "recheck") => void;
}

/** Runs reducer commands against the application-owned writers and effects. */
export function applyWebuiEffectCommands(
  commands: readonly WebuiEffectCommand[],
  handlers: WebuiEffectHandlers,
  readStream?: () => WebuiStreamState,
): void {
  // The session's own slices, in the order the event produced them.
  const patches: WebuiSessionStatePatch[] = [];
  // Everything that is not a session-slice write: an owner's fenced write, a
  // refresh, an attach. Order among these is preserved; they run after the
  // commit, because a refresh has to re-read what the commit wrote.
  const after: WebuiEffectCommand[] = [];
  for (const cmd of commands) {
    if (
      cmd.type === "set-stream" ||
      cmd.type === "set-sending" ||
      cmd.type === "set-permissions" ||
      cmd.type === "set-questionnaire"
    ) {
      patches.push(cmd);
      continue;
    }
    after.push(cmd);
  }

  if (patches.length > 0) {
    // Guards are resolved first, against the store, so a patch this event must
    // not apply never reaches the commit at all.
    const permitted = patches.filter((patch) => {
      if (patch.type !== "set-sending" || patch.when === undefined) return true;
      // A guard with nothing to read against cannot be answered, and admitting
      // it would apply a patch whose entire condition is unknown.
      return readStream !== undefined && patch.when(readStream());
    });
    if (permitted.length > 0) handlers.applyPatches(permitted);
  }

  for (const cmd of after) {
    switch (cmd.type) {
      case "refresh-pending":
        Promise.resolve(handlers.refreshPending()).catch(() => undefined);
        break;
      case "refresh-queue":
        handlers.refreshQueue?.();
        break;
      case "refresh-goal":
        Promise.resolve(handlers.refreshGoal()).catch(() => undefined);
        break;
      case "set-goal":
        handlers.setGoal(cmd.goal);
        break;
      case "attach-stream":
        handlers.attachStream?.(cmd.turnId, cmd.mode);
        break;
      default:
        break;
    }
  }
}

/**
 * Fold an event's patches into one session record.
 *
 * Exported so the owner and the tests fold patches the same way: the guard on
 * `set-sending` reads the stream *as the batch leaves it*, which is the only
 * record a later patch in the same event can be looking at.
 */
/**
 * The slices a patch may write: the session record's own state, without the
 * fields no patch touches (the goal, which has a fenced owner, and the
 * transcript, which is its own keyed resource).
 */
export type WebuiSessionStateWritable = Pick<
  WebuiApplicationSessionState,
  "stream" | "sending" | "permissions" | "questionnaire"
>;

export function reduceWebuiSessionStatePatch<T extends WebuiSessionStateWritable>(
  session: T,
  patch: WebuiSessionStatePatch,
): T {
  switch (patch.type) {
    case "set-stream":
      return { ...session, stream: patch.patch(session.stream) };
    case "set-sending":
      // No guard check here: the executor resolves them against the store
      // before folding. A patch that reaches this function has already been
      // admitted, and re-reading `session.stream` would consult the batch rather
      // than the world.
      return { ...session, sending: patch.sending };
    case "set-permissions":
      return { ...session, permissions: patch.patch(session.permissions) };
    case "set-questionnaire":
      return { ...session, questionnaire: patch.patch(session.questionnaire) };
    default:
      return session;
  }
}

/**
 * Reduce one process event against a session's latest state and run the
 * commands it produces.
 *
 * This is the per-session half of `handleEvent`, extracted so the channel
 * consumer and the tests drive the same function. It used to be a factory that
 * returned the callback — with nobody calling it: `handleEvent` spelled the
 * same four lines out inline, so the extraction existed twice and only the
 * inline copy ran.
 */
export function applyWebuiEventToSession(
  sessionId: string,
  event: WebuiRuntimeEvent,
  readStream: () => WebuiStreamState,
  readState: () => Omit<WebuiEffectState, "stream">,
  handlers: WebuiEffectHandlers,
): void {
  const commands = reduceWebuiEffect(
    { ...readState(), stream: readStream() },
    event,
    sessionId,
  ).commands;
  applyWebuiEffectCommands(commands, handlers, readStream);
}

/** The parsed payload of a `workspace.git.changed` process event. */
export interface WebuiWorkspaceGitChangedPayload {
  readonly workspace?: string;
  readonly aliases?: readonly string[];
}

/**
 * The permanent domain routes.
 *
 * They are installed by the application assembly **before** ingress opens, and
 * there is no replaceable effect set: a view reaction may subscribe after a
 * commit, but it cannot displace the route that owns the commit. An event set
 * registered by a subtree supplied its own goal handler for the session it was
 * mounted on, and a goal event for any other session was dropped, because the
 * handler's presence suppressed the coordinator's own write and then found no
 * registration to route to.
 *
 * Every member is required: a missing route would be a silent drop, and
 * `createWebuiApplication` always installs them.
 */
export interface WebuiDomainEventRoutes {
  /** The goal write path for one session, through that session's owner. */
  readonly setGoal: (sessionId: string, goal: WebuiGoal | undefined) => void;
  /** The steering re-read for one session, through that session's owner. */
  readonly refreshGoal: (sessionId: string) => void | Promise<unknown>;
  /** Fence this session's pending-interaction projection. */
  readonly invalidatePending: (sessionId: string) => void;
  /** The authoritative permission/questionnaire re-read for one session. */
  readonly refreshPending: (sessionId: string) => void | Promise<unknown>;
  readonly refreshQueue?: (sessionId: string) => void;
  /** Attach to, or recheck, the turn a `session.start` names. */
  readonly attachStream: (
    sessionId: string,
    turnId: string | undefined,
    mode: "attach" | "recheck",
  ) => void;
  /**
   * The channel was accepted: a possible observation gap. Not a barrier — a
   * `session.start` can still slip past it — so reconciliation decides what to
   * re-read.
   */
  readonly channelReady: () => void;
  /**
   * A `workspace.git.changed` event, which carries no session id. The owner
   * invalidates the workspace git and review queries it affects.
   */
  readonly workspaceGitChanged: (payload: WebuiWorkspaceGitChangedPayload) => void;

  /**
   * A fact about a session's identity or presentation that another client or the
   * CLI changed: it was created, renamed, re-modelled, switched to interaction
   * mode, pinned or hidden.
   *
   * These are not turn effects, so they have no session stream to write into.
   * They are catalogue facts, and the sessions owner is where the catalogue
   * lives — routing them here is what makes this page agree with every other
   * client about who exists and what they are named, instead of showing what it
   * last loaded until the user reloaded the window.
   */
  readonly sessionFact: (fact: WebuiSessionFact) => void;
}


export interface WebuiEventCoordinatorDeps {
  readonly store: WebuiSessionStore;
  /** The permanent owner routes. See `WebuiDomainEventRoutes`. */
  readonly routes: WebuiDomainEventRoutes;
  readonly leases: WebuiStreamLeaseController;
  /** The session activity controller owns the per-session activity reduction. */
  readonly activity: WebuiActivityIngress;
}

/**
 * The activity ingress the coordinator routes events to. A
 * `WebuiSessionActivityController` satisfies it structurally.
 */
export interface WebuiActivityIngress {
  readonly recordEvent: (
    event: WebuiRuntimeEvent,
  ) => void;
}

export interface WebuiEventCoordinator {
  /** Subscribe to the channel exactly once; returns a detach that removes it. */
  readonly attach: (channel: WebuiProcessEventChannel) => () => void;
  readonly handleEvent: (event: WebuiRuntimeEvent) => void;
  readonly detach: () => void;
  /** Whether the coordinator currently holds the channel subscription. */
  readonly isAttached: () => boolean;
}

export function createWebuiEventCoordinator(
  deps: WebuiEventCoordinatorDeps,
): WebuiEventCoordinator {
  const { store, leases, activity } = deps;
  let unsubscribe: (() => void) | undefined;

  const handlersFor = (sessionId: string): WebuiEffectHandlers => ({
    refreshPending: () => deps.routes.refreshPending(sessionId),
    refreshQueue: () => deps.routes.refreshQueue?.(sessionId),
    // The route, never the replaceable set: a mounted view cannot take the goal
    // read away from the owner that fences it.
    refreshGoal: () => deps.routes.refreshGoal(sessionId),
    // One event, one commit. Folding here rather than calling four writers means
    // the store notifies once, so no subscriber ever reads a record caught
    // between two of the same event's writes.
    applyPatches: (patches) =>
      store.updateSession(sessionId, (current) =>
        patches.reduce(reduceWebuiSessionStatePatch, current),
      ),
    setGoal: (goal) => {
      // Every goal write goes through the session's owner, so the version fence
      // sees it and a late re-read cannot resurrect what it replaced.
      deps.routes.setGoal(sessionId, goal);
    },
    attachStream: (turnId, mode) => deps.routes.attachStream(sessionId, turnId, mode),
  });

  const handleEvent = (event: WebuiRuntimeEvent): void => {
    if (store.isDisposed()) return;
    activity.recordEvent(event);
    // A workspace-git event carries no session id. It is routed to the
    // application-wide invalidation hook, not a per-session effect, so the
    // workspace panels' git and review queries are invalidated through the
    // coordinator instead of a second subscription in the panels.
    if (event.type === "workspace.git.changed") {
      const rawWorkspace = event.payload.workspace;
      const rawAliases = event.payload.aliases;
      deps.routes.workspaceGitChanged({
        ...(typeof rawWorkspace === "string" ? { workspace: rawWorkspace } : {}),
        ...(Array.isArray(rawAliases)
          ? {
              aliases: rawAliases.filter(
                (alias): alias is string => typeof alias === "string",
              ),
            }
          : {}),
      });
      return;
    }
    const sessionId = eventSessionId(event);
    if (!sessionId) return;
    // Session lifecycle facts are catalogue facts, not turn effects: this page's
    // rail names sessions that another client or the CLI created, renamed,
    // re-modelled or hid, and it must agree with them without waiting for a
    // reload. They arrive on the same envelope as everything else and were
    // previously dropped by the default branch, which is why the rail went stale
    // whenever another window changed anything.
    const fact = readWebuiSessionFact(event, sessionId);
    if (fact) {
      deps.routes.sessionFact(fact);
      return;
    }
    deps.routes.invalidatePending(sessionId);
    // The effect executor is the existing one; it walks the command list in
    // order, and its `set-*` commands land on this coordinator's store writers.
    applyWebuiEventToSession(
      sessionId,
      event,
      () => store.readSession(sessionId).stream,
      () => {
        const current = store.readSession(sessionId);
        return {
          permissions: current.permissions,
          questionnaire: current.questionnaire,
          goal: current.goal,
        };
      },
      handlersFor(sessionId),
    );
  };

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  return {
    attach: (channel) => {
      if (unsubscribe) return unsubscribe;
      const off = channel.subscribe(
        (event) => handleEvent(event),
        () => deps.routes.channelReady(),
      );
      unsubscribe = off;
      return off;
    },
    handleEvent,
    detach,
    isAttached: () => unsubscribe !== undefined,
  };
}
