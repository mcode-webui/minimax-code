// The application instance.
//
// One call builds the whole browser-side application object: the store, the
// single lease controller, the event coordinator and the turn coordinator, and
// it opens **exactly one** process-event channel for the instance. The channel
// is opened here and handed to the event coordinator, which is its sole
// consumer; components subscribe to the application snapshot this object
// exposes.
//
// This module is the live process-event ingress. The composition root creates
// one application through it, and all four former `watchEvents` call sites (the
// shell, the composer and both workspace panels) moved onto it in one delivery
// unit, because a migration period where the shell used the new ingress while
// the composer still opened its own connection would make the migration itself
// a source of duplicated state.

import { createWebuiPortSlices, type WebuiPortSlices } from "./port-slices.js";
import {
  createWebuiSessionComposerAccess,
  createWebuiSessionWorkflows,
} from "../features/sessions/application/session-workflows.js";
import { createWebuiCommandWorkflows } from "../features/composer/application/command-workflows.js";
import { createWebuiComposerController } from "../features/composer/application/composer-controller.js";
import {
  createWebuiObservationScheduler,
  type WebuiObservationScheduler,
} from "./observation-scheduler.js";
import {
  submitWebuiGoal,
  type WebuiGoalOwnerCapability,
} from "../features/goal/application/goal-submission.js";
import type { WebuiComposerController } from "../features/composer/contracts/composer-controller.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../features/composer/application/composer-history.js";
import { createWebuiTurnLifecycleCommands } from "../features/turn/application/turn-lifecycle-commands.js";
import { createWebuiTerminalOwner } from "../features/terminal/application/terminal-owner.js";
import { createWebuiWorkspaceQueries } from "../features/workspace/application/workspace-queries.js";
import { createWebuiWorkspaceReviewOwner } from "../features/review/application/workspace-review-owner.public.js";
import { createWebuiInteractionCommands } from "../features/sessions/application/session-commands.public.js";
import { createWebuiAccountWorkflows } from "../features/account/application/account-workflows.js";
import { createWebuiModelsWorkflows } from "../features/models/application/models-workflows.js";
import { createWebuiSettingsWorkflows } from "../features/settings/application/settings-workflows.js";
import { createWebuiPluginWorkflows } from "../features/plugins/application/plugin-workflows.js";
import type { WebuiPluginManagementAction } from "../../shared/plugin-management.js";
import { createWebuiComposerPluginCatalogue } from "../features/plugins/application/composer-catalogue.js";
import { createWebuiPluginActions } from "../features/plugins/contracts/plugin-actions.js";
import { createWebuiPlanReviewWorkflow } from "../features/interactions/application/interaction-coordinator.js";
import { webuiActiveTurnProbeFor } from "../features/turn/contracts/active-turn-probe.js";
import {
  createWebuiEventCoordinator,
  type WebuiEventCoordinator,
} from "../features/turn/application/event-coordinator.js";
import type { WebuiOpenEventChannel, WebuiProcessEventChannel } from "../features/turn/application/event-channel.js";
import { createWebuiSessionStore, createWebuiTranscriptHistoryWriter } from "./session-store.js";
import { createWebuiTaskSessionWorkflows } from "./task-session-workflows.js";
import type { WebuiSessionStore } from "./session-store.js";
import {
  createWebuiStreamLeaseController,
  type WebuiStreamLeaseController,
} from "../features/turn/application/stream-lease-controller.js";
import {
  createWebuiSessionScopeManager,
  type WebuiSessionScopeManager,
} from "../conversation/session-scope.js";
import {
  createWebuiDeliveryDisposers,
  type WebuiDeliveryDisposers,
} from "../features/turn/application/delivery-disposers.js";
import {
  createWebuiConversationTurnCommands,
  type WebuiConversationTurnCommands,
} from "../features/turn/application/turn-commands.js";
import {
  createWebuiGoalSessionOwners,
  type WebuiGoalSessionOwners,
} from "../features/goal/application/goal-session-owners.js";
import type { WebuiGoalPortSlice } from "../features/goal/application/goal-coordinator.js";
import {
  createWebuiInteractionSessionOwners,
  type WebuiInteractionSessionOwners,
} from "../features/interactions/application/interaction-session-owners.js";
import type { WebuiInteractionPortSlice } from "../features/interactions/application/interaction-coordinator.js";
import { createWebuiInteractionPhaseIntents } from "../features/turn/contracts/interaction-phase-intents.js";
import { selectWebuiCatalogFlatPage, selectWebuiCatalogTreePage } from "../features/sessions/application/session-catalog.public.js";
import { selectWebuiSessionAgentName, selectWebuiSessionLookups } from "../features/sessions/projection/session-lookups.js";
import type { WebuiApplicationState } from "./state.js";
import { WEBUI_HOME_SESSION_KEY } from "./state.js";
import {
  createWebuiTurnCoordinator,
  type WebuiTurnCoordinator,
} from "../features/turn/application/turn-coordinator.js";
import type { WebuiTurnCoordinatorDeps } from "../features/turn/application/turn-coordinator.js";
import {
  createWebuiSessionActivityController,
  type WebuiSessionActivityController,
} from "../features/sessions/application/session-activity-controller.js";
import {
  createWebuiComposerStore,
  type WebuiComposerStore,
} from "../features/composer/application/composer-store.js";
import { createWebuiVersionCells, type WebuiVersionCells } from "./version-cell.js";
import {
  createWebuiIdentityEpochs,
  type WebuiIdentityEpochs,
} from "./identity-epochs.js";
import {
  createWebuiTranscriptHistoryOwner,
  type WebuiTranscriptHistoryOwner,
} from "../conversation/transcript-history.js";
import type {
  WebuiTurnCapabilityPort,
  WebuiTurnCapabilitySlice,
} from "../features/turn/application/turn-capabilities.js";
import { createWebuiTurnCapabilitySlice } from "../features/turn/application/turn-capabilities.js";
import {
  createWebuiTurnReviewOwner,
  type WebuiTurnReviewOwner,
} from "../features/review/application/turn-review-owner.js";
import type { WebuiTurnReviewPort } from "../features/review/contracts/turn-review.js";
import type {
  WebuiClientMessageLoader,
  WebuiClientMessagePage,
} from "../features/transcript/contracts/message-view.js";
import type { WebuiTranscriptCommands } from "../features/transcript/contracts/session-read-port.js";
import type { WebuiStreamState } from "../features/turn/projection/stream-state.js";
import {
  selectWebuiSessionStream,
  selectWebuiSessionTranscriptPage,
} from "./selectors.js";

/**
 * The session reads the shell composes its screens from. The shell may not
 * import the assembly, and it renders the providers its descendants read
 * through, so it cannot reach them through those bindings either. Published on
 * the application instance — the composition root's own interface — because
 * that instance is what the shell is handed. Both reads answer from the one
 * store; `undefined` means "whatever is selected", and with no session selected
 * that is the home slot the first turn streams into.
 */
export interface WebuiApplicationReads {
  readonly stream: (sessionId: string | undefined) => WebuiStreamState;
  readonly transcriptPage: (
    sessionId: string | undefined,
  ) => WebuiClientMessagePage;
}

export interface WebuiApplicationDeps {
  /** Opens the process-event channel. Called exactly once per instance. */
  readonly openEventChannel: WebuiOpenEventChannel;
  /**
   * The one session store the instance owns. Supply it to bind the application
   * to a store created by the caller (the composition root creates exactly one
   * and the shell hands it in); when omitted a fresh store is created here.
   * Either way there is exactly one map — this is not a second store.
   */
  readonly store?: WebuiSessionStore;
  /** The session the UI currently has selected; default reads the store. */
  readonly readActiveSessionId?: () => string | undefined;

  /** Transport-facing dependencies of the turn coordinator. */
  readonly turns: Omit<WebuiTurnCoordinatorDeps, "store">;
  /**
   * The port the turn capability slice is cut from — the composition root's
   * closure over the transport. The slice is built here, not by the component
   * that invokes a turn command, so a submission receives no capability from
   * its caller. Absent on a host with nothing wired (SSR, unit tests), which is
   * exactly the state the loop's absent-capability guards exist for.
   */
  readonly turnCapabilities?: WebuiTurnCapabilityPort;
  /**
   * The turn-review capability. The application owns the review family's query
   * and mutation, so a surface reads it from the application rather than
   * holding its own copy; the absent case is the state the owner's own
   * `unsupported` outcome covers.
   */
  readonly turnReview?: WebuiTurnReviewPort;
  readonly loadMessages?: WebuiClientMessageLoader;
  /**
   * The new-task workspace's persisted "no project" choice
   * (`platform/storage.ts`), injected because the application may not import infrastructure.
   * Absent reads as "nothing was ever cleared" and drops the write, which is
   * what a host with no storage (SSR, unit tests) means.
   */
  readonly workspacePreference?: {
    readonly readNoProjectFlag?: () => boolean;
    readonly writeNoProjectFlag?: (value: boolean) => void;
  };
  /** Seed for the composer store (SSR / tests). */
  readonly composer?: WebuiComposerStore;
  /**
   * The goal capability, so the application can own the goal owner rather than
   * the view that happens to be mounted. Absent on a host with nothing wired,
   * which is the state the owner's own absent-capability handling covers.
   */
  readonly goalPort?: WebuiGoalPortSlice;
  /**
   * The interaction capability, so the application owns the permission and
   * questionnaire owner rather than the view that happens to be mounted.
   */
  readonly interactionsPort?: WebuiInteractionPortSlice;
  /**
   * The fallback requester name for a session. Defaults to the catalogue's own
   * answer for that session, which is where the shell reads it too.
   */
  readonly readAgentName?: (sessionId: string) => string;
  /**
   * The per-business port slices. The composition root cuts them once and hands
   * them in; the application builds every business owner from them, so no view
   * builds an owner to reach a capability. Absent on a host with nothing wired:
   * the slices then cut from the turn capability, which is the same degradation
   * the shell used to perform.
   */
  readonly slices?: WebuiPortSlices;
  /**
   * The session-file import the session workflows submit through. Injected for
   * because the application layer may not import
   * `platform/`.
   */
  readonly sessionImport?: Parameters<typeof createWebuiSessionWorkflows>[0]["importSession"];
  /**
   * The session-file export the session workflows submit through. Injected for
   * the same reason as `sessionImport`: the implementation is a browser
   * navigation, so it belongs to the composition root's platform layer.
   */
  readonly sessionExport?: Parameters<typeof createWebuiSessionWorkflows>[0]["exportSession"];
}

/**
 * The writes that make the composer's installed-plugin read stale. The list is
 * actions rather than methods, because one method can route several actions and
 * the catalogue only cares what became untrue.
 */
const PLUGIN_CATALOGUE_ACTIONS: ReadonlySet<WebuiPluginManagementAction> = new Set([
  "installPlugin",
  "uninstallPlugin",
  "enablePlugin",
  "disablePlugin",
  "importGithubPlugin",
]);

/** The writes that make one agent's composer's skill read stale. */
const SKILL_CATALOGUE_ACTIONS: ReadonlySet<WebuiPluginManagementAction> = new Set([
  "installSkill",
  "createSkill",
  "setSkillEnabled",
  "deleteSkill",
]);

export type WebuiApplicationLifecycleState = "constructed" | "started" | "disposed";

/** What `start` needs from the caller: the route it booted at. */
export interface WebuiApplicationStart {
  /**
   * The session the initial route names, or `undefined` for the home surface.
   * Parsed by the entry (it owns the browser location), passed in so hydration
   * sees the same selection the first render will.
   */
  readonly initialSessionId?: string;
}

export interface WebuiApplication {
  /**
   * The lifecycle state. `constructed` performs no IO; `started` has one open
   * ingress; `disposed` is terminal and refuses to restart.
   */
  readonly state: () => WebuiApplicationLifecycleState;
  /**
   * Install the assembly's routes and open the one event ingress.
   *
   * Idempotent while started, and a refusal (returning `false`, opening
   * nothing) after disposal. The initial selection is passed in rather than
   * read later, so the application store has the right selection before ingress.
   */
  readonly start: (options?: WebuiApplicationStart) => boolean;
  /** The current application snapshot; stable until something changes. */
  readonly getSnapshot: () => WebuiApplicationState;
  /** Subscribe to snapshot changes. Returns a detach; never closes a channel. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * The session reads a surface composes from without importing the assembly.
   * Same store, same subscription as `getSnapshot`; the mapping from "nothing
   * selected" to the home slot stays inside the assembly, so a reader asks for
   * the selected slot rather than naming the sentinel.
   */
  readonly reads: WebuiApplicationReads;
  readonly select: (sessionId: string | undefined) => void;
  readonly store: WebuiSessionStore;
  readonly leases: WebuiStreamLeaseController;
  /**
   * Why each session is still needed. Independent of component mounting: a
   * delivery or settlement lease outlives the view that started it.
   */
  readonly sessionScope: WebuiSessionScopeManager;
  /**
   * The goal owners, one per session. An event route commits through them
   * whether or not a view is mounted, and each session has its own fence.
   */
  readonly goals: WebuiGoalSessionOwners;
  /**
   * The interaction owners, one per session. An event route re-reads and fences
   * through them, and a transcript submits its reply to them, whether or not the
   * composer is mounted on that session.
   */
  readonly interactions: WebuiInteractionSessionOwners;
  /**
   * The client deliveries this application can actually close. Disposal closes
   * them; it never aborts a host turn.
   */
  readonly deliveries: WebuiDeliveryDisposers;
  readonly events: WebuiEventCoordinator;
  readonly turns: WebuiTurnCoordinator;
  /**
   * The conversation command set for one session (or the home slot), built by this
   * application and shared by every surface that drives a turn: the event
   * coordinator's attach and recheck routes, the composer controller's
   * submissions, and the session binding that hands it to a component. It is the
   * one construction, so a binding reads this instead of assembling a second one.
   */
  readonly turnCommandsFor: (sessionId: string | undefined) => WebuiConversationTurnCommands;
  /** The published turn capability slice (send / resume / load / stop). */
  readonly turnCapabilities: WebuiTurnCapabilitySlice;
  /** The one owner of a turn's diff query and revert/reapply. */
  readonly turnReview: WebuiTurnReviewOwner;
  readonly transcriptHistory: WebuiTranscriptHistoryOwner;
  /** Message actions exposed to transcript UI as application commands. */
  readonly transcriptCommands: WebuiTranscriptCommands;
  /** The one owner of per-session activity writes. */
  readonly sessionActivity: WebuiSessionActivityController;
  /** The one owner of composer drafts and input history. */
  readonly composer: WebuiComposerStore;
  readonly composerController: WebuiComposerController;
  /**
   * The port slices the assembly cut. Published so a surface reads the narrowed
   * slice rather than the composed transport: the shell provides these to its
   * descendants and reads none of them itself.
   */
  readonly portSlices: WebuiPortSlices;
  /** The browser terminal owner. */
  readonly terminalOwner: ReturnType<typeof createWebuiTerminalOwner>;
  /** The session business's loads and mutations, one per assembly. */
  readonly sessionWorkflows: ReturnType<typeof createWebuiSessionWorkflows>;
  /** The task/session use case: task workspace policy, creation, and home identity. */
  readonly taskSessions: ReturnType<typeof createWebuiTaskSessionWorkflows>;
  /** The composer business's slash-command runner. */
  readonly commandWorkflows: ReturnType<typeof createWebuiCommandWorkflows>;
  /** The workspace file/environment/review query owner. */
  readonly workspaceQueries: ReturnType<typeof createWebuiWorkspaceQueries>;
  /** The account owner: sign-in, api-key status and usage. */
  readonly accountWorkflows: ReturnType<typeof createWebuiAccountWorkflows>;
  /** The settings owner: instructions, memory, profile and display. */
  readonly settingsWorkflows: ReturnType<typeof createWebuiSettingsWorkflows>;
  /** The models owner: catalogue, selection and provider CRUD. */
  readonly modelsWorkflows: ReturnType<typeof createWebuiModelsWorkflows>;
  /** The plugin manager's owner. */
  readonly pluginWorkflows: ReturnType<typeof createWebuiPluginWorkflows>;
  /** The composer's plugin/skill read model, separate from the manager's. */
  readonly composerPluginCatalogue: ReturnType<typeof createWebuiComposerPluginCatalogue>;
  /** The plan-review reply workflow. */
  readonly planReviewWorkflow: ReturnType<typeof createWebuiPlanReviewWorkflow>;
  /**
   * The application's observation scheduler: the two bounded periodic read
   * classes. A surface registers interest in an identity; it never installs its
   * own timer.
   */
  readonly observations: WebuiObservationScheduler;
  /**
   * The one active-turn probe: a same-session probe from two views collapses to
   * one round trip, and absent means the host predates the operation — the
   * rail's own condition, not a second probe.
   */
  readonly activeTurnProbe: ReturnType<typeof webuiActiveTurnProbeFor>;
  /**
   * The two version cells, one per fence. The application owns the instance; the
   * business owns the policy and reads the cell it is given.
   */
  readonly versionCells: WebuiVersionCells;
  /**
   * The opaque credential/config generation context. Owners put a token in a
   * resource key and compare with `isCurrent`; the business that owns a write
   * advances the epoch it invalidates. Tokens are instance-scoped and carry no
   * credential value.
   */
  readonly identityEpochs: WebuiIdentityEpochs;
  /**
   * The one reconciliation entry point.
   *
   * It runs the authoritative re-reads the installed routes own for one session —
   * the pending-interaction read, the goal re-read and the pending invalidation —
   * and is what a selection change or a suspected observation gap calls instead of
   * each surface inventing its own probe. `sessionId` defaults to the application's
   * selection.
   */
  readonly reconcile: (sessionId?: string) => void;
  /**
   * Subscribe to the channel-accepted signal. A reaction, not a route: the
   * application's own reconciliation runs first, then listeners are told.
   */
  readonly onChannelReady: (listener: () => void) => () => void;
  /** Tear down: detach the coordinator, dispose the store, close the channel. */
  readonly dispose: () => void;
  /**
   * What failed while disposing, by owner label. Empty before disposal and for a
   * clean one; unchanged by a second disposal.
   */
  readonly disposalFailures: () => readonly {
    readonly label: string;
    readonly reason: unknown;
  }[];
}

export function createWebuiApplication(
  deps: WebuiApplicationDeps,
): WebuiApplication {
  const store = deps.store ?? createWebuiSessionStore();
  const leases = createWebuiStreamLeaseController(store);
  const sessionScope = createWebuiSessionScopeManager();
  const deliveries = createWebuiDeliveryDisposers();
  // The goal owners are the application's, not a view's: a goal event commits
  // through the session's owner even with nothing mounted.
  const goals = createWebuiGoalSessionOwners({
    store,
    ...(deps.goalPort ? { port: deps.goalPort } : {}),
  });
  /**
   * The agent a session belongs to, read from the catalogue the rail renders —
   * the same source the shell uses for the composer's fallback requester name.
   */
  const catalogueAgentName = (sessionId: string): string => {
    const catalog = store.getSnapshot().catalog;
    const flat = selectWebuiCatalogFlatPage(catalog);
    const tree = selectWebuiCatalogTreePage(catalog);
    return selectWebuiSessionAgentName(selectWebuiSessionLookups(flat, tree), sessionId);
  };
  const readAgentName = deps.readAgentName ?? catalogueAgentName;
  const interactions = createWebuiInteractionSessionOwners({
    store,
    // The assembly builds the intents because it is what holds the store; the
    // owner itself consumes turn's published contract.
    readPhaseIntents: (sessionId) =>
      createWebuiInteractionPhaseIntents({
        setStream: store.createSessionWriter({ kind: "session", sessionId }).setStream,
      }),
    // Same split for the interaction writers: Sessions publishes the commands,
    // the assembly composes them for the session it is building an owner for.
    commandsFor: (sessionId) =>
      createWebuiInteractionCommands(
        store.createInteractionWriter({ kind: "session", sessionId }),
      ),
    ...(deps.interactionsPort ? { port: deps.interactionsPort } : {}),
    readAgentName,
  });
  /**
   * The one selection command. Selecting activates the new session's scope and
   * releases the previous selection's lease — and only that lease, so an
   * accepted delivery or an outstanding settlement survives the navigation.
   */
  const selectSession = (sessionId: string | undefined): void => {
    sessionScope.select(sessionId);
    store.select(sessionId);
    // The selected session and the model catalogue it exposes share one
    // lifecycle. Selecting the home slot from a session must read its catalogue
    // too; otherwise the new-task composer sees an uninitialised home entry
    // until the page is reloaded directly into that route. Keep an already
    // loaded (or currently loading) catalogue and retry only an idle/failed one.
    modelsWorkflows.selectCatalogue(sessionId);
    const modelCatalogue = modelsWorkflows.readModelsFor(sessionId);
    if (modelCatalogue.status === "idle" || modelCatalogue.status === "error") {
      void modelsWorkflows.loadModels(sessionId);
    }
    composerController?.selectSession(sessionId);
    // Selecting is where a retained dirty marker pays out: the session was
    // marked while nothing needed it, and now something does.
    if (sessionId !== undefined && dirtyResources.has(sessionId)) {
      dirtyResources.delete(sessionId);
      reconcileSession(sessionId);
    }
  };
  const readActiveSessionId =
    deps.readActiveSessionId ?? (() => store.getSelectedSessionId());
  const sessionActivity = createWebuiSessionActivityController(store);
  const composer = deps.composer ?? createWebuiComposerStore();
  // The two fence cells. Created once per application, because the coordinator
  // that uses one is constructed on every render and a counter living in it
  // would reset; published, because the goal's fence is `goal`'s state and
  // interactions' late-read protection is `interactions'`, so the component must
  // not be the thing that declares them.
  const versionCells = createWebuiVersionCells();
  // The opaque identity/freshness context. Created once per instance so a remount
  // gets fresh tokens, and published because every owner that keys a resource by
  // credential/config generation reads it.
  const identityEpochs = createWebuiIdentityEpochs();
  // The effects slot: the initial set is the composition root's, and a later
  // registration (the subtree that owns the effects) replaces it in place. The
  // coordinator holds the slot object, not a copy of its members, so a
  // registration made after construction is what the next event sees.
  /**
   * The dirty markers a read-required event left behind for a session nothing
   * needs yet. They survive until interest arrives or the session is purged —
   * the alternative, dropping the event, is a silent loss.
   */
  const dirtyResources = new Set<string>();
  const channelReadyListeners = new Set<() => void>();
  const notify = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) listener(value);
  };
  let composerController: WebuiComposerController | undefined;
  /**
   * The conversation command set for one session, built on demand and
   * deliberately **not** cached: each set is a closure over the store and the
   * shared owners and holds no state of its own, so a map would only accumulate
   * one entry per session this client ever commanded.
   *
   * The attach and recheck routes are the application's, so a `session.start` is
   * followed whether or not a composer is mounted; and because this is the
   * application's one construction, a binding reads it instead of building a
   * second one.
   */
  const turnCommandsFor = (sessionId: string | undefined): WebuiConversationTurnCommands => {
    return createWebuiConversationTurnCommands({
      store,
      sessionId,
      ...(deps.turnCapabilities ? { capabilities: turnCapabilities } : {}),
      deliveries,
      scope: sessionScope,
      // The one creation owner: a first message's session is created by the task
      // use case, which reserves the admission, transfers the home record under
      // its guards and answers whether the created session may be selected.
      taskSessions: taskSessionWorkflows,
      refreshQueue: () => {
        if (sessionId) composerController?.refreshQueue(sessionId);
      },
      // A turn that outlives the client's own response stream is reconciled
      // through the same owner the event path uses, so a local send and a
      // missed `session.start` are repaired the same way — and the session to
      // reconcile is the one the send landed on, which is not always the one
      // this command set was built for.
      reconcileTurn: (target) => turnCommandsFor(target).recover(),
      // No draft writer crosses into Turn: the composer consumes the input it
      // captured, on the admission the turn owner returns, and a link installed here
      // would clear a slot without knowing whether it was still the submitted
      // revision — which is how newer typing in that slot was erased.
    });
  };
  /**
   * The one reconciliation entry point: the same owner routes the event path
   * uses, so selection and reconnect do not run a second one.
   */
  const reconcileSession = (sessionId: string): void => {
    if (lifecycleState() === "disposed") return;
    interactions.owner(sessionId).invalidatePendingReads();
    void interactions.owner(sessionId).refresh();
    void goals.owner(sessionId).refreshGoal();
  };
  const events = createWebuiEventCoordinator({
    store,
    leases,
    activity: sessionActivity,
    // The permanent routes, installed here — before `start` opens ingress —
    // and outside anything a view can replace, so no surface can displace them.
    routes: {
      setGoal: (sessionId, goal) => goals.owner(sessionId).applyGoal(goal),
      refreshGoal: (sessionId) => goals.owner(sessionId).refreshGoal(),
      invalidatePending: (sessionId) => interactions.owner(sessionId).invalidatePendingReads(),
      refreshPending: (sessionId) => {
        if (!sessionScope.isInterested(sessionId)) {
          // No interest yet: retain the marker and reconcile when it arrives,
          // rather than fanning out a background read.
          dirtyResources.add(sessionId);
          return;
        }
        dirtyResources.delete(sessionId);
        return interactions.owner(sessionId).refresh();
      },
      refreshQueue: (sessionId) => composerController?.refreshQueue(sessionId),
      attachStream: (sessionId, turnId, mode) => {
        const commands = turnCommandsFor(sessionId);
        if (mode === "recheck") commands.recheck(turnId);
        else commands.attach(turnId);
      },
      // The application's own reconciliation first, then the surfaces that
      // subscribed: a reconnect is a possible observation gap, not a barrier.
      channelReady: () => {
        // The handshake facts first: the manifest this client decides availability
        // from arrives with the version, and a service that restarted with a different
        // bridge must not keep the previous connection's answer. Reading it is what
        // makes readiness a live question rather than a boot-time one.
        void settingsWorkflows.loadVersion();
        for (const sessionId of sessionScope.interested()) {
          dirtyResources.delete(sessionId);
          reconcileSession(sessionId);
          turnCommandsFor(sessionId).recover();
          // The queue is a projection of events this channel could have missed:
          // an item that drained while the channel was down leaves a stale row
          // behind, and the authoritative read is what clears it.
          composerController?.refreshQueue(sessionId);
        }
        // The transcript is the same story: the events that would have said a
        // turn started were missed, and a turn that ran and settled in that
        // window is in no probe's answer. The head page is the authoritative
        // read of what the session holds, and the view that presents it is the
        // one that reads it.
        const presented = store.getSelectedSessionId();
        if (presented) void transcriptHistory.refreshPage(presented);
        notify(channelReadyListeners, undefined);
      },
      // The one writer of the working tree tells the reader of it, and the link
      // between them is a fact about the businesses rather than something a
      // mounted view arranges. It is resolved per event, so it cannot be missing
      // for the one event that mattered because a view was not on screen.
      workspaceGitChanged: (payload) => workspaceQueries.invalidateWorkspaceGit(payload),
      // Another client or the CLI changed a session's identity or presentation.
      // The sessions owner owns the catalogue those facts describe, so they go
      // there rather than into a per-session turn effect that has no stream to
      // write into. Installed permanently, like every route here, so the rail
      // cannot go stale whenever no view happens to be mounted.
      sessionFact: (fact) => sessionWorkflows.applyFact(fact),
    },
  });
  const turns = createWebuiTurnCoordinator({
    store,
    ...deps.turns,
    deliveries,
    scope: sessionScope,
  });
  // The slice is cut once, here, from the port the composition root holds. A
  // caller of a conversation command never supplies a capability again.
  const turnCapabilities = createWebuiTurnCapabilitySlice(
    deps.turnCapabilities ?? {},
  );
  const turnReview = createWebuiTurnReviewOwner({ port: deps.turnReview ?? {} });
  const transcriptHistory = createWebuiTranscriptHistoryOwner({
    // The substrate writes the transcript slice through this contract rather
    // than through the record repository.
    transcript: createWebuiTranscriptHistoryWriter(store),
    loadMessages: deps.loadMessages,
  });
  // The business owners, built by the assembly rather than by the mounted view —
  // the shell's own treatment. A view composes screens and reads these; it
  // neither builds one nor holds the capability to build one, so "which business
  // can reach which port" is decided here rather than by which port a component
  // happened to be handed.
  const slices = deps.slices ?? createWebuiPortSlices(deps.turnCapabilities ?? {});
  // The terminal owner reads the handshake's capability manifest when asked, so a
  // host that declares no terminal bridge is reported absent rather than offered,
  // and a bridge that is not ready says so. The reader is lazy because the
  // handshake is read by the settings owner, which is built below.
  const terminalOwner = createWebuiTerminalOwner(slices.workspace, {
    readCapabilities: () => settingsWorkflows.getSnapshot().runtimeVersion.value?.capabilities,
  });
  const transcriptCommands: WebuiTranscriptCommands = {
    ...(slices.sessions.getSessionForkOptions
      ? { getSessionForkOptions: (request) => slices.sessions.getSessionForkOptions!(request) }
      : {}),
    ...(slices.sessions.forkSession
      ? {
          forkSession: async (request) => {
            const result = await slices.sessions.forkSession!(request);
            // Message-row forks use the same wire operation as rail forks,
            // but the row action cannot update the session catalog itself.
            // Refresh the owning session workflow before the shell selects the
            // returned session, so the rail can show which session is active.
            try {
              await sessionWorkflows.refresh();
            } catch (error) {
              sessionWorkflows.setError(error instanceof Error ? error.message : String(error));
            }
            return result;
          },
        }
      : {}),
    ...(slices.transcript.getSessionRewindPreview
      ? { getSessionRewindPreview: (request) => slices.transcript.getSessionRewindPreview!(request) }
      : {}),
    ...(slices.transcript.rewindSession
      ? {
          rewindSession: async (request) => {
            const result = await slices.transcript.rewindSession!(request);
            // The runtime has committed a new transcript revision, but the
            // mounted view still owns its prior page. Replace the selected
            // session's cached pages before resolving the row action so
            // removed messages do not remain rendered until a manual reload.
            await transcriptHistory.replacePage(request.id);
            return result;
          },
        }
      : {}),
    ...(slices.transcript.editSessionMessage
      ? { editSessionMessage: (request) => slices.transcript.editSessionMessage!(request) }
      : {}),
  };
  const sessionWorkflows = createWebuiSessionWorkflows({
    store,
    // What a delete needs from the composer: its slot purge, plus the input the
    // slot holds. A *local* delete is the user ending the task, so the slot goes
    // with it; an externally observed deletion retains the unsent text and
    // attachments instead, and only this seam can read them before the slot is
    // fenced.
    composer: createWebuiSessionComposerAccess(composer, {
      homeKey: WEBUI_COMPOSER_HOME_KEY,
      // Staged attachments belong to the slot the user is composing in.
      isStagedFor: (sessionId) => readActiveSessionId() === sessionId,
    }),
    port: slices.sessions,
    ...(deps.sessionImport ? { importSession: deps.sessionImport } : {}),
    ...(deps.sessionExport ? { exportSession: deps.sessionExport } : {}),
    // A delete is an accepted mutation: it holds a settlement lease and revokes
    // the deleted session's interests.
    scope: sessionScope,
    // A committed delete also stops the wire session it was streaming on.
    deliveries,
    // And it reaches the owners that were created for that session. Each releases
    // its own observable state through its own command — this is the list of
    // owners a session has, which only the assembly knows.
    releaseOwners: (sessionId) => {
      transcriptHistory.releaseSession(sessionId);
      modelsWorkflows.releaseSession(sessionId);
      goals.purge(sessionId);
      interactions.purge(sessionId);
      turnReview.releaseSession(sessionId);
      workspaceQueries.releaseSession(sessionId);
    },
    // A model or interaction-mode change is answered by re-reading the views
    // that render them, because the rail's session record has no field for
    // either. The reads are interest-gated, so a session nobody is watching does
    // not fan out a background request.
    sessionFactInvalidated: (sessionId) => {
      dirtyResources.delete(sessionId);
      // Acquisition, not selection: another client changing a session's model is a
      // fact about that session, and repairing it must not move what this page is
      // looking at.
      void modelsWorkflows.acquireModels(sessionId);
      interactions.owner(sessionId).refresh();
    },
  });
  const commandWorkflows = createWebuiCommandWorkflows({ port: slices.composer });
  /**
   * The goal capability one target session offers, read when the submission asks
   * for it rather than captured up front: a session this submission just created
   * holds no goal, and that is what makes its objective a create rather than a
   * patch. The create-or-patch choice used to be the assembly's inline
   * `usesPatch`/`resolveGoal` pair.
   */
  const goalCapabilityFor = (sessionId: string): WebuiGoalOwnerCapability => {
    const owner = goals.owner(sessionId);
    const currentGoal = store.readSession(sessionId).goal;
    return {
      ...(currentGoal === undefined ? {} : { currentGoal }),
      ...(owner.createGoal ? { createGoal: owner.createGoal } : {}),
      ...(owner.patchGoal ? { patchGoal: owner.patchGoal } : {}),
    };
  };
  // The application's observation scheduler: one place owns the two bounded
  // periodic reads, and the surfaces below contribute interest rather than timers.
  const observations = createWebuiObservationScheduler();
  composerController = createWebuiComposerController({
    store: composer,
    readSelectedSessionId: readActiveSessionId,
    // Every creation the composer drives is the task use case's, so the controller is left with
    // the selection — gated on the use case's own answer.
    selectCreatedSession: selectSession,
    turnCommandsFor,
    commandWorkflows,
    canEnqueue: turnCapabilities.enqueue !== undefined,
    canSend: turnCapabilities.send !== undefined,
    readGoal: (sessionId) => store.readSession(sessionId).goal,
    // The goal submission command is Goal's: the create-or-patch decision, and
    // which owner answers it, live in that module. What the assembly supplies is
    // the capability to read a target session's goal state and the commit that
    // lands a created goal on its owner.
    submitGoal: (input, onSessionCreated) =>
      submitWebuiGoal(
        {
          sessionId: input.sessionId,
          objective: input.objective,
          capabilityFor: goalCapabilityFor,
          // The goal path creates through the same use case the send path does,
          // so the admission reservation, the guarded transfer and the composer's
          // slot move happen once.
          submitTask: taskSessionWorkflows,
          applyGoal: (sessionId, goal) => goals.owner(sessionId).applyGoal(goal),
          ...(input.createSessionWorkspaceDir ? { createSessionWorkspaceDir: input.createSessionWorkspaceDir } : {}),
          ...(input.teamModeOff ? { teamModeOff: true } : {}),
        },
        onSessionCreated,
      ),
    refreshPending: (sessionId) => interactions.owner(sessionId).refresh(),
    refreshGoal: async (sessionId) => { await goals.owner(sessionId).refreshGoal(); },
    recoverTurn: (sessionId) => turnCommandsFor(sessionId).recover(),
    // The scheduler owns when this runs; the composer only says it is interested.
    observations,
    refreshInspection: async (sessionId) => {
      // Acquisition, not selection: this runs on the scheduler's freshness budget
      // while the user may have moved elsewhere, and a background read that selects
      // the catalogue it read is a background read changing what is on screen.
      await Promise.all([
        modelsWorkflows.acquireModels(sessionId),
        accountWorkflows.loadAccount(sessionId),
      ]);
    },
    clearHomeTurn: () => {
      const writer = store.createSessionWriter({ kind: "home" });
      const lifecycle = createWebuiTurnLifecycleCommands({ setStream: writer.setStream, setSending: writer.setSending });
      lifecycle.clearStream();
      lifecycle.setTurnSending(false);
    },
  });
  // The review resource is built once, here, and handed to Workspace. Two
  // construction sites for one owner would mean two owners.
  const workspaceReview = createWebuiWorkspaceReviewOwner({ port: slices.workspace });
  const workspaceQueries = createWebuiWorkspaceQueries({
    port: slices.workspace,
    // Composed here, at the lifetime seam, and handed over as the semantic
    // interface: Workspace owns the git/review coordination, not the review
    // owner's construction. A peer that built it would be a second construction
    // site for one owner, which is the caller-pair this seam replaces.
    review: workspaceReview,
  });
  const accountWorkflows = createWebuiAccountWorkflows({
    port: slices.account,
    identityEpochs,
  });
  const settingsWorkflows = createWebuiSettingsWorkflows({
    port: slices.settings,
    identityEpochs,
  });
  // `models` owns the catalogue, the selection and the provider list. The one
  // call that crosses the boundary is the api-key upsert's: it refreshes
  // `settings`' status read through that owner's published command rather than
  // copying the read.
  const modelsWorkflows = createWebuiModelsWorkflows({
    port: slices.models,
    refreshApiKeyStatus: () => accountWorkflows.loadApiKeyStatus(),
    identityEpochs,
  });
  const composerPluginCatalogue = createWebuiComposerPluginCatalogue({
    actions: createWebuiPluginActions(slices.plugins),
    ...(slices.plugins.listSkills ? { listSkills: slices.plugins.listSkills } : {}),
  });
  /**
   * The agent a skill write was aimed at, or `undefined` for the runtime-wide
   * default. The catalogue keys its skill reads by exactly this, so this is what
   * decides which slot goes stale and which ones survive.
   */
  const mutatedAgentName = (input: unknown): string | undefined => {
    const value = (input as { readonly agentName?: unknown } | null | undefined)?.agentName;
    return typeof value === "string" ? value : undefined;
  };
  const pluginWorkflows = createWebuiPluginWorkflows({
    port: slices.plugins,
    onMutated: (action, input) => {
      // A plugin write can add, remove, rename or reconfigure any installed
      // plugin, so every installed-plugin slot is stale. It says nothing about
      // skills: the runtime answers those separately, per agent.
      if (PLUGIN_CATALOGUE_ACTIONS.has(action)) composerPluginCatalogue.invalidatePlugins();
      // A skill write is scoped to the agent it was aimed at, so the other
      // agents' slots survive — re-reading them would cost a round trip to
      // learn nothing.
      if (SKILL_CATALOGUE_ACTIONS.has(action)) {
        composerPluginCatalogue.invalidateSkills(mutatedAgentName(input));
      }
    },
  });
  // The composer's view of what is installed and what the agent can run: a
  // separate read model from `pluginWorkflows` on purpose, so neither overwrites
  // the other when one reloads.
  /**
   * The task/session use case. The workspace policy it owns used to be the
   * shell's: which directory a fresh home starts in, what the auto-fill may do to
   * it, and what an explicit pick means. It is constructed here because it needs
   * the canonical store, the composer store and the session catalogue; the host
   * injects only the persisted preference.
   */
  const taskSessionWorkflows = createWebuiTaskSessionWorkflows({
    store,
    composer,
    // Creation goes to the runtime through the turn capability the host wired; nothing else may
    // create, which is what makes the reservation single-flight.
    // Creating a session is the sessions capability's (`port-slices.ts`'s table), which is where the
    // goal path read it before this became the one owner. `WebuiTransport` satisfies both slices, so
    // production has one source; a host that wires only one of them still creates here.
    ...(slices.sessions.createSession ? { createSession: slices.sessions.createSession } : {}),
    storage: {
      readNoProjectFlag: () => deps.workspacePreference?.readNoProjectFlag?.() ?? false,
      writeNoProjectFlag: (value) => deps.workspacePreference?.writeNoProjectFlag?.(value),
    },
    catalogue: sessionWorkflows,
  });

  // The plan-review reply goes to the session's interaction owner. The selection
  // and the agent name are read when the reply is submitted rather than captured
  // by the view that renders the card, so a card left open across a selection
  // change replies to the session it belongs to.
  // One shared, deduplicated active-turn probe. The rail and the composer ask the
  // same question, so a probe racing between two views for one session collapses
  // to one round trip; the probe is built by the assembly so a second consumer
  // cannot build a second one.
  const activeTurnProbe = webuiActiveTurnProbeFor(slices.turn.activeTurn);
  const planReviewWorkflow = createWebuiPlanReviewWorkflow({
    answerQuestionnaire: (request, answers) => {
      const target = readActiveSessionId();
      if (!target) {
        return Promise.resolve({ ok: false, error: "Questionnaire replies are unavailable" });
      }
      return interactions
        .owner(target)
        .answerQuestionnaire(request, answers, readAgentName(target));
    },
  });
  // The links between businesses, installed here and never removed.
  //
  // Each one is a fact about two owners — this one writes the working tree or
  // the plugin list, that one reads it — rather than something a view arranges.
  // Installing them at construction is what makes them unconditional: a link
  // routed through a mount only holds while a component happens to be on screen,
  // so the one event that mattered most is the one most likely to arrive when
  // nothing is watching.
  //
  // 1. workspace git → the workspace owner's affected views is a route, above:
  //    the coordinator already hands the payload to a link that exists for the
  //    application's whole life.
  // 2. A settled turn mutation (revert / reapply) changed the working tree, so
  //    the review views for it are stale. The turn owner announces the
  //    settlement; no panel keeps a refresh token for it.
  turnReview.subscribeMutations(() => workspaceQueries.review.invalidateReview());
  // 3. plugin writes → the composer catalogue is wired above, at the workflows
  //    that made the write.

  // The ingress handle: nothing is opened at construction. `start` opens exactly
  // one channel and attaches the coordinator to it; `dispose` detaches, disposes
  // the store that fences late commits, and closes the channel.
  let lifecycle: WebuiApplicationLifecycleState = "constructed";
  /** Read by helpers defined above the lifecycle block. */
  const lifecycleState = (): WebuiApplicationLifecycleState => lifecycle;
  let channel: WebuiProcessEventChannel | undefined;
  let detach: (() => void) | undefined;
  /**
   * Owners that failed while ending, in the order they were ended.
   *
   * Kept on the instance rather than only printed: "the application is gone" and
   * "the application is gone and two owners did not end cleanly" are different
   * states, and a caller that wants to know which one it is should not have to
   * read a console.
   */
  const disposalFailures: { readonly label: string; readonly reason: unknown }[] = [];

  return {
    state: () => lifecycle,
    disposalFailures: () => disposalFailures,
    start: (options) => {
      // A disposed instance is terminal: no hydration, no ingress, no second
      // life through the same object.
      if (lifecycle === "disposed") return false;
      if (lifecycle === "started") return true;
      const initialSessionId = options?.initialSessionId;
      // The boot route is applied before ingress opens. A home boot already is
      // the selected state, so read its catalogue directly without running the
      // user-driven selection effects (which clear the home turn).
      if (initialSessionId !== undefined) selectSession(initialSessionId);
      else void modelsWorkflows.loadModels(undefined);
      channel = deps.openEventChannel();
      detach = events.attach(channel);
      lifecycle = "started";
      return true;
    },
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    // Read through the store's live snapshot, exactly as the selectors did at
    // their call sites; `undefined` selects the home slot, which is the
    // assembly's own identity for "no session yet".
    reads: {
      stream: (sessionId) =>
        selectWebuiSessionStream(
          store.getSnapshot(),
          sessionId ?? WEBUI_HOME_SESSION_KEY,
        ),
      transcriptPage: (sessionId) =>
        selectWebuiSessionTranscriptPage(store.getSnapshot(), sessionId),
    },
    select: selectSession,
    store,
    leases,
    sessionScope,
    deliveries,
    goals,
    interactions,
    events,
    turns,
    turnCommandsFor,
    turnCapabilities,
    turnReview,
    transcriptHistory,
    transcriptCommands,
    sessionActivity,
    composer,
    composerController,
    portSlices: slices,
    terminalOwner,
    sessionWorkflows,
    taskSessions: taskSessionWorkflows,
    commandWorkflows,
    workspaceQueries,
    accountWorkflows,
    settingsWorkflows,
    modelsWorkflows,
    pluginWorkflows,
    composerPluginCatalogue,
    activeTurnProbe,
    planReviewWorkflow,
    observations,
    versionCells,
    identityEpochs,
    reconcile: (sessionId) => {
      // A disposed instance reconciles nothing: its store is fenced, so a read
      // that landed now could not commit anyway.
      if (lifecycle === "disposed") return;
      const target = sessionId ?? readActiveSessionId();
      if (!target) return;
      reconcileSession(target);
    },
    onChannelReady: (listener) => {
      channelReadyListeners.add(listener);
      return () => channelReadyListeners.delete(listener);
    },
    dispose: () => {
      if (lifecycle === "disposed") return;
      // Fence first: whatever a later step throws, this application is now
      // disposed and a second `dispose` must be a no-op.
      lifecycle = "disposed";
      // One owner throwing must not strand the others. The store is fenced
      // last-but-one either way, so a failing cleanup above it cannot leave the
      // application half-alive with writers still accepted — the failure is
      // reported, the rest of the teardown still runs.
      /** What went wrong while ending owners, kept past the disposal call. */
      disposalFailures.length = 0;
      const shutDown = (label: string, end: () => void): void => {
        try {
          end();
        } catch (reason) {
          // One owner's failure does not stop the others: the loop below still
          // runs every step. The failure is kept rather than only printed, so a
          // disposal that went wrong anywhere is inspectable after the fact
          // instead of surviving as a line in a console nobody reads.
          disposalFailures.push({ label, reason });
          console.error(`[webui] ${label} cleanup failed during application disposal`, reason);
        }
      };
      shutDown("event ingress", () => {
        detach?.();
        detach = undefined;
      });
      // Close what this client is observing before fencing the store: the
      // attempt's frames can no longer reach a snapshot, and the host turn keeps
      // running.
      shutDown("delivery", () => deliveries.closeAll());
      shutDown("session scope", () => sessionScope.dispose());
      shutDown("goal owners", () => goals.dispose());
      shutDown("interaction owners", () => interactions.dispose());
      // The account owner runs the login and OAuth-status polls, so its end is
      // the application's end rather than a component unmount.
      shutDown("account owner", () => accountWorkflows.dispose());
      shutDown("session owner", () => sessionWorkflows.dispose());
      // Every independent read owner below was built by this assembly, so this
      // assembly ends it. They are listed individually rather than swept: an
      // owner that can still commit or notify after the application is gone is a
      // lifetime defect whether or not a view happened to be looking at it, and a
      // single shared teardown would hide which family was missed next time.
      shutDown("models owner", () => modelsWorkflows.dispose());
      shutDown("settings owner", () => settingsWorkflows.dispose());
      shutDown("workspace owners", () => workspaceQueries.dispose());
      shutDown("workspace review resource", () => workspaceReview.dispose());
      shutDown("turn review owner", () => turnReview.dispose());
      shutDown("transcript history owner", () => transcriptHistory.dispose());
      shutDown("composer plugin catalogue", () => composerPluginCatalogue.dispose());
      // After the owners it was scheduling: the scheduler holds no owner, only the
      // interest that pointed at them, and it stops issuing work before they go.
      shutDown("observation scheduler", () => observations.dispose());
      // Observation only. The browser page ends its watches here; the PTYs are
      // the service's, and a page that merely listed a terminal has no rights
      // over its process. Explicit close (`disposeProcess`) and service shutdown
      // are the two ways a process ends.
      shutDown("terminal owner", () => terminalOwner.dispose());
      channelReadyListeners.clear();
      dirtyResources.clear();
      shutDown("composer controller", () => composerController?.dispose());
      shutDown("session store", () => store.dispose());
      shutDown("event channel", () => {
        channel?.close?.();
        channel = undefined;
      });
      if (disposalFailures.length > 0) {
        // Every owner had its turn; the failures are reported together, with the
        // labels, so the summary names what went wrong rather than the first thing
        // that did.
        console.error(
          `[webui] application disposal finished with ${disposalFailures.length} failure(s): ${disposalFailures
            .map((failure) => failure.label)
            .join(", ")}`,
          disposalFailures,
        );
      }
    },
  };
}
