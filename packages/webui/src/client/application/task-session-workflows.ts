// The task/session creation use case.
//
// This module is a **named cross-business use case**, not another generic
// service layer. It owns three things that used to be spread across the
// composition root and a React effect:
//
//   * the task workspace / no-project policy — which directory the next task
//     starts in, and where the user's explicit choice is persisted;
//   * creation completion — what a successful create settles into: the created
//     destination, the Agent Team choice it was started with, and the catalogue
//     reads that are now stale;
//   * the home incarnation and navigation epoch that decide whether a completion
//     may still adopt, move the draft, or select.
//
// It delegates rather than re-implements: catalogue storage to Sessions, the
// composer slot to the composer store, the runtime record to the canonical
// session store, and platform storage to its injected adapter. It keeps only
// this operation's metadata and the immutable inputs it was given — never a
// second mutable session map.
//
// Framework-free: no React, no DOM, no `window`. The browser's URL and other
// DOM effects stay in the shell, which consumes the committed result this
// module returns.

import type { WebuiClientSession } from "../features/sessions/contracts/session-view.js";
import {
  createdWebuiSessionId,
  type WebuiClientCreateSessionResult,
  type WebuiClientSessionCreator,
} from "../features/sessions/contracts/session-port.js";
import type { WebuiComposerStore } from "../features/composer/application/composer-store.js";
import { formatWebuiError } from "../contracts/value-readers.js";
import {
  type WebuiSessionStore,
  type WebuiSessionTransferOutcome,
} from "./session-store.js";
import { WEBUI_HOME_SESSION_KEY } from "./state.js";

/** The browser storage surface this use case reads and writes. */
export interface WebuiTaskSessionStorage {
  readonly readNoProjectFlag: () => boolean;
  readonly writeNoProjectFlag: (value: boolean) => void;
}

/**
 * The catalogue reads creation completion invalidates. Injected because
 * `client/application/` composes owners rather than calling transport itself.
 */
export interface WebuiTaskSessionCatalogue {
  readonly canLoadFlat: boolean;
  readonly canLoadTree: boolean;
  readonly loadFlat: () => Promise<void>;
  readonly loadTree: () => Promise<void>;
}

export interface WebuiTaskSessionDeps {
  readonly store: WebuiSessionStore;
  /** The composer store whose home slot the adoption moves. */
  readonly composer: WebuiComposerStore;
  readonly storage: WebuiTaskSessionStorage;
  readonly catalogue: WebuiTaskSessionCatalogue;
  /** The creation capability. Absent means this host cannot create at all. */
  readonly createSession?: WebuiClientSessionCreator;
  /**
   * Record the Agent Team choice the created session was started with. Sessions
   * owns that choice, so this asks for the record rather than writing it here.
   */
  readonly recordTeamMode?: (sessionId: string) => void;
}

/** The immutable inputs one submission carries. */
export interface WebuiTaskSessionSubmit {
  /** The absolute project directory the created session starts in. */
  readonly workspaceDir?: string;
  /** The Agent Team choice captured with the request. */
  readonly teamModeOff?: boolean;
  /** The session name. The client sends `main`, as it always has. */
  readonly name?: string;
  /**
   * The revision of the composer input this submission carries. Completion
   * clears or moves the draft/staging only while they still belong to it, so
   * typing during creation is not lost.
   */
  readonly inputRevision?: number;
}

/**
 * One submission's terminal result. `busy` and `unsupported` are decided before
 * any wire IO and preserve the caller's input; `created` and `creation-failed`
 * come from the attempt.
 */
export type WebuiTaskCreationOutcome =
  | {
      readonly kind: "created";
      readonly sessionId: string;
      /** What the guarded transfer onto the destination did. */
      readonly transfer: WebuiSessionTransferOutcome;
      /** Whether the originating navigation claim was still current. */
      readonly selected: boolean;
      readonly navigationEpoch: number;
      /** The catalogue refresh failure, when one happened. Retryable; the session stays created. */
      readonly catalogueError?: string;
    }
  | { readonly kind: "busy"; readonly homeIncarnation: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "creation-failed"; readonly error: string };

export interface WebuiTaskSessionWorkflows {
  /** The directory the next task starts in, for a fresh home surface. */
  readonly initialWorkspaceDir: (input: {
    readonly selectedSessionId?: string;
    readonly sessions: readonly WebuiClientSession[];
  }) => string | undefined;
  /**
   * The auto-fill decision for the picker: what the current directory should
   * become as sessions load and the selection moves. An explicit clearing in
   * this session wins over the auto-fill, so picking a project and then asking
   * for a new task does not pull a workspace back.
   */
  readonly autoFillWorkspaceDir: (input: {
    readonly current: string | undefined;
    readonly selectedSessionId?: string;
    readonly sessions: readonly WebuiClientSession[];
  }) => string | undefined;
  /** Record the user's project choice (or its clearing) and return what to render. */
  readonly chooseWorkspaceDir: (workspaceDir: string | undefined) => string | undefined;
  /**
   * Explicit New Task: a fresh home incarnation, a fresh navigation claim, and
   * the home record dropped. It advances the incarnation even while the
   * selection stays `undefined`, so a creation that started before this point
   * cannot adopt onto the home the user has already replaced.
   */
  readonly beginNewTask: (workspaceDir?: string) => {
    readonly navigationEpoch: number;
    readonly workspaceDir: string | undefined;
  };
  /**
   * Note that the application navigated. Returns the epoch now live. Duplicate
   * route or binding notifications do not advance it, returning home after
   * visiting another session does not recreate the old claim.
   */
  readonly noteNavigation: (sessionId: string | undefined) => number;
  /** Whether one creation is already pending for the current home incarnation. */
  readonly creationPending: () => boolean;
  /** Submit one creation. Single-flight per home incarnation, before any wire IO. */
  readonly submit: (input: WebuiTaskSessionSubmit) => Promise<WebuiTaskCreationOutcome>;
}

export function createWebuiTaskSessionWorkflows(
  deps: WebuiTaskSessionDeps,
): WebuiTaskSessionWorkflows {
  const { store, composer, storage, catalogue } = deps;
  /**
   * Whether the user cleared the project in *this* session. It starts from the
   * persisted choice, which is what the shell's own flag did: an explicit
   * clearing outlives the component, an auto-fill does not.
   */
  let clearedInThisSession = storage.readNoProjectFlag();
  /** The navigation claim. It advances when the destination actually changes. */
  let navigationEpoch = 0;
  let lastNavigatedTo: string | undefined | symbol = NEVER_NAVIGATED;
  /**
   * The home incarnation one creation is already working on, if any. Keyed by
   * incarnation rather than a bare boolean: a New Task during creation replaces
   * the home slot, and the *new* home must be able to start its own creation
   * without waiting for the old attempt.
   */
  let pendingHomeIncarnation: number | undefined;

  const sessionsWithWorkspace = (
    sessions: readonly WebuiClientSession[],
  ): string | undefined => sessions.find((session) => session.workspaceDir)?.workspaceDir;

  return {
    initialWorkspaceDir: ({ selectedSessionId, sessions }) => {
      if (storage.readNoProjectFlag()) return undefined;
      const selected = sessions.find((session) => session.sessionId === selectedSessionId);
      return selected?.workspaceDir ?? sessionsWithWorkspace(sessions);
    },

    autoFillWorkspaceDir: ({ current, selectedSessionId, sessions }) => {
      if (clearedInThisSession) return current;
      const selected = sessions.find((session) => session.sessionId === selectedSessionId);
      if (selected?.workspaceDir) return selected.workspaceDir;
      if (current) return current;
      return sessionsWithWorkspace(sessions);
    },

    chooseWorkspaceDir: (workspaceDir) => {
      clearedInThisSession = workspaceDir === undefined;
      storage.writeNoProjectFlag(clearedInThisSession);
      return workspaceDir;
    },

    beginNewTask: (workspaceDir) => {
      clearedInThisSession = workspaceDir === undefined;
      storage.writeNoProjectFlag(clearedInThisSession);
      // The home record is dropped and its incarnation advanced in one step:
      // the composer draft is the shell's to clear, the record is the store's.
      store.resetHomeRecord();
      navigationEpoch += 1;
      lastNavigatedTo = undefined;
      return { navigationEpoch, workspaceDir };
    },

    noteNavigation: (sessionId) => {
      if (lastNavigatedTo === NEVER_NAVIGATED) {
        // The first note establishes the claim the boot route already made; it
        // is not a navigation the epoch has to record.
        lastNavigatedTo = sessionId;
        return navigationEpoch;
      }
      if (lastNavigatedTo === sessionId) return navigationEpoch;
      lastNavigatedTo = sessionId;
      navigationEpoch += 1;
      return navigationEpoch;
    },

    creationPending: () => pendingHomeIncarnation === store.readHomeIncarnation(),

    submit: async (input) => {
      if (!deps.createSession) return { kind: "unsupported" };
      const homeIncarnation = store.readHomeIncarnation();
      // Single flight, decided before any wire IO: a second submit for the same
      // home incarnation is `busy`, not a deferred FIFO, and it creates nothing.
      if (pendingHomeIncarnation === homeIncarnation)
        return { kind: "busy", homeIncarnation };
      const claim = navigationEpoch;
      const inputRevision = input.inputRevision;
      pendingHomeIncarnation = homeIncarnation;
      let created: WebuiClientCreateSessionResult;
      try {
        created = await deps.createSession({
          name: input.name ?? "main",
          ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
          teamModeOff: input.teamModeOff,
        });
      } catch (error) {
        pendingHomeIncarnation = undefined;
        return { kind: "creation-failed", error: formatWebuiError(error) };
      }
      if (pendingHomeIncarnation === homeIncarnation) pendingHomeIncarnation = undefined;
      const sessionId = createdWebuiSessionId(created);
      if (!sessionId) {
        return { kind: "creation-failed", error: "createSession response did not include a session id" };
      }

      // The guarded transfer: the destination wins, a purged destination is not
      // resurrected, and a home incarnation that moved under us transfers
      // nothing — the created session is still the destination, the *new* home
      // record is left alone. The attempt terminates on every outcome below.
      const transfer = store.transferSession(WEBUI_HOME_SESSION_KEY, sessionId, {
        expectSourceIncarnation: homeIncarnation,
      });
      // The composer slot moves whenever the record did not refuse the move. A stale source, an
      // occupied destination and a purged destination are the three refusals, and each of them means
      // the draft belongs where it is; `no-source` is not one of them — there was no home record to
      // protect, and the text the user typed is still theirs to keep with the session it created.
      let adoptedRevision: number | undefined;
      if (transfer.outcome === "transferred" || transfer.outcome === "no-source") {
        const adopted = composer.adoptHome(sessionId, {
          ...(inputRevision !== undefined ? { expectSourceRevision: inputRevision } : {}),
        });
        // The revision the destination holds *after* the move is the only identity that
        // proves the text standing there is the input this submission carried. Comparing
        // text instead would clear a slot the user had retyped to the same words —
        // equal text is not equal edit identity, and the slot's revision is.
        if (adopted) adoptedRevision = composer.readSlotRevision(sessionId);
      }

      // Rule 3: the created session records the choice the *request* carried,
      // whatever the default has become since.
      if (input.teamModeOff !== undefined) deps.recordTeamMode?.(sessionId);

      let catalogueError: string | undefined;
      try {
        if (catalogue.canLoadFlat) await catalogue.loadFlat();
        if (catalogue.canLoadTree) await catalogue.loadTree();
      } catch (error) {
        // A catalogue read failure is recorded and retryable; it does not undo
        // the created session and does not trigger a second creation.
        catalogueError = formatWebuiError(error);
      }

      return {
        kind: "created",
        sessionId,
        transfer: transfer.outcome,
        ...(adoptedRevision === undefined ? {} : { adoptedRevision }),
        // Rule 7: the created destination is selected only while the navigation
        // claim that started the creation is still the current one.
        selected: claim === navigationEpoch,
        navigationEpoch,
        ...(catalogueError === undefined ? {} : { catalogueError }),
      };
    },
  };
}

/** A sentinel no session id can equal, so the first note is distinguishable. */
const NEVER_NAVIGATED: unique symbol = Symbol("webui.never-navigated");
