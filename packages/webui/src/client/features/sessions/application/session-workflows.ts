// The session workflows: the business requests that load and mutate session
// entities, bound to the single catalog.
//
// The foundation shell used to call `transport.loadSessions` /
// `loadSessionTree` / `updateSession` / `archiveSession` / `deleteSession`
// directly and then patch two structures by hand (`setPage` *and*
// `setTreePage`). Both the request and the post-success coordination move here:
// a mutation runs against the transport and commits one catalog change, and
// every reader re-derives. The shell submits a workflow and never holds a
// transport call for session entities.
//
// This module is framework-free — no React, no DOM, no storage — so it can be
// unit-tested against a scripted port.

import type { SessionPort, WebuiClientSessionCreator } from "../contracts/session-port.js";
import type { WebuiComposerPurgeSlot } from "../../../features/composer/application/composer-store.public.js";
import type {
  WebuiComposerAttachment,
  WebuiComposerUrlReference,
} from "../../../features/composer/contracts/composer-interactions.js";
import type { WebuiSessionScopeManager } from "../../../conversation/session-scope.js";
import type {
  WebuiClientProject,
  WebuiClientSessionPage,
} from "../contracts/session-view.js";
import type { WebuiSessionListItem } from "../../../../shared/contracts/session.js";
import {
  patchWebuiCatalogEntity,
  reduceWebuiCatalogFlatAppended,
  reduceWebuiCatalogFlatLoaded,
  reduceWebuiCatalogTreeLoaded,
  hideWebuiCatalogSessions,
  removeWebuiCatalogSessions,
  setWebuiCatalogFlatError,
  setWebuiCatalogFlatLoading,
} from "./session-catalog.js";
import type { WebuiSessionCatalogState } from "./session-catalog.public.js";

/** The catalog slice's reader/writer — a `WebuiSessionStore` satisfies it. */
export interface WebuiSessionCatalogStore {
  readonly getSnapshot: () => { readonly catalog: WebuiSessionCatalogState };
  readonly updateCatalog: (
    update: (current: WebuiSessionCatalogState) => WebuiSessionCatalogState,
  ) => void;
  /**
   * Drop every server-derived slice (session record + activity entry) for
   * one session id. The catalog slice is updated separately, so this is
   * *not* a full delete — `remove` / `removeArchived` call this after the
   * server delete commits and the catalog entity has been removed.
   */
  readonly purgeSession: (sessionId: string) => void;
}

/**
 * The session-import capability, injected because the implementation is
 * browser IO (`platform/session-import.ts`) and this module is the
 * application layer. The composition root supplies
 * `importWebuiSessionFile`; the shell submits `importSession` and never calls
 * the importer itself.
 */
export type WebuiSessionImporter = (
  file: Blob,
  options?: {
    readonly agentName?: string;
    readonly workspaceDir?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly sessionId: string }>;

/**
 * The session-export capability, injected for the same reason as the importer:
 * the implementation is browser download IO
 * (`platform/session-transfer-download.ts`) and this module is the
 * application layer. The composition root supplies
 * `startWebuiSessionTransferDownload`; the rail submits `exportSession` and
 * never navigates itself.
 */
export type WebuiSessionExporter = (sessionId: string) => void;

type QueryPort = Pick<
  SessionPort,
  "loadSessions" | "loadSessionTree" | "loadProjects" | "listArchivedSessions"
>;
type MutationPort = Pick<
  SessionPort,
  | "updateSession"
  | "archiveSession"
  | "deleteSession"
  | "getSessionForkOptions"
  | "forkSession"
  | "createSession"
>;

// `crypto.randomUUID()` is reachable from any browser context that exposes the
// standard WebCrypto API. The application workflows deliberately stay off the
// `globalThis` surface (the IO / infrastructure layer is the intended owner),
// so each `clientRequestId` goes through this tiny helper. The fallback keeps
// SSR / test environments that ship without WebCrypto from blowing up.
function generateForkClientRequestId(): string {
  const cryptoSource = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoSource && typeof cryptoSource.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The archived-sessions read. The archived page lives inside the settings
 * dialog, but the query is a session query, so it belongs to the session
 * workflows rather than to a settings owner.
 */
export interface WebuiArchivedSessionsState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sessions: readonly WebuiSessionListItem[];
  readonly error?: string;
}

export interface WebuiProjectsState {
  readonly loading: boolean;
  readonly projects?: readonly WebuiClientProject[];
  readonly error?: string;
}

/**
 * The unsent input a composer slot holds.
 *
 * Draft text is per slot; staged attachments and URL references belong to the
 * slot the user is composing in, so they are read for the session that is
 * selected. Both travel together because they are one submission's input.
 */
export interface WebuiUnsentComposerInput {
  readonly draft: string;
  readonly attachments: readonly WebuiComposerAttachment[];
  readonly urlReferences: readonly WebuiComposerUrlReference[];
}

/**
 * The unsent input one externally deleted session left behind.
 *
 * Retained in the sessions business because losing it is the sessions business's
 * fault: the deletion was somebody else's, and the text was the user's. The title
 * is carried so the notice can say which task it came from.
 */
export interface WebuiRetainedDeletionDraft extends WebuiUnsentComposerInput {
  readonly sessionId: string;
}

/** The composer capabilities a delete reads, structurally. */
export interface WebuiComposerInputSource {
  readonly purgeSlot: WebuiComposerPurgeSlot;
  /** The draft for one slot key. Absent means this deployment has no drafts. */
  readonly readDraft?: (key: string) => string;
  /** The staged attachments and references of the slot being composed in. */
  readonly readStaging?: () => {
    readonly attachments: readonly WebuiComposerAttachment[];
    readonly urlReferences: readonly WebuiComposerUrlReference[];
  };
  readonly setDraft?: (key: string, text: string) => void;
  readonly setStaging?: (
    next: Partial<{
      readonly attachments: readonly WebuiComposerAttachment[];
      readonly urlReferences: readonly WebuiComposerUrlReference[];
    }>,
  ) => void;
}

/**
 * Builds the delete's view of the composer from the composer store.
 *
 * Here rather than inline in the assembly because two callers need the same
 * translation: the application, and any test that deletes a session. Keeping it
 * in the sessions business is deliberate — the question it answers ("what input
 * does this slot still hold?") is the one a deletion has to answer, and the
 * composer store's own API is not the sessions business's vocabulary.
 *
 * `isStagedFor` says whether the staged attachments belong to the slot being
 * read. Staging is the *current* slot's, so retaining another session's
 * attachments would be attributing the user's files to the wrong task.
 */
export function createWebuiSessionComposerAccess(
  source: WebuiComposerInputSource,
  options: {
    readonly homeKey?: string;
    readonly isStagedFor?: (sessionId: string) => boolean;
  } = {},
): WebuiSessionComposerAccess {
  const isStagedFor = options.isStagedFor ?? (() => false);
  return {
    purgeSlot: source.purgeSlot,
    readUnsent: (sessionId) => {
      const draft = source.readDraft?.(sessionId) ?? "";
      const staged = isStagedFor(sessionId) ? source.readStaging?.() : undefined;
      return {
        draft,
        attachments: staged?.attachments ?? [],
        urlReferences: staged?.urlReferences ?? [],
      };
    },
    writeUnsent: (sessionId, input) => {
      source.setDraft?.(sessionId ?? options.homeKey ?? "", input.draft);
      if (input.attachments.length === 0 && input.urlReferences.length === 0) return;
      source.setStaging?.({
        attachments: input.attachments,
        urlReferences: input.urlReferences,
      });
    },
  };
}

/** What a delete needs from the composer: its slot purge, and the input it holds. */
export interface WebuiSessionComposerAccess {
  /** The published purge command the delete already depended on. */
  readonly purgeSlot: WebuiComposerPurgeSlot;
  /**
   * The unsent input for one slot. A delete reads it before it fences the slot,
   * so an externally deleted session's text can be retained instead of dropped.
   */
  readonly readUnsent: (sessionId: string) => WebuiUnsentComposerInput;
  /** Put retained input back into a slot, for an explicit transfer. */
  readonly writeUnsent: (
    sessionId: string | undefined,
    input: WebuiUnsentComposerInput,
  ) => void;
}

export const initialWebuiArchivedSessionsState: WebuiArchivedSessionsState = {
  status: "idle",
  sessions: [],
};

/**
 * A session lifecycle fact, as another client or the CLI published it.
 *
 * Declared here as a structural shape rather than imported from the turn
 * business: this is the sessions business's own read model being told what
 * changed, and a sessions application module must not reach into a peer's
 * application layer to learn the shape of its own catalogue update. The turn
 * business publishes the same union from its decoder and this one accepts it,
 * because the two describe the same fact from opposite ends.
 */
export type WebuiSessionLifecycleFact =
  | { readonly kind: "created"; readonly sessionId: string }
  | { readonly kind: "renamed"; readonly sessionId: string; readonly title: string }
  | { readonly kind: "re-modelled"; readonly sessionId: string; readonly model?: string; readonly agentName?: string }
  | { readonly kind: "interaction-mode"; readonly sessionId: string; readonly mode: string }
  | { readonly kind: "visibility"; readonly sessionId: string; readonly hidden: boolean }
  | { readonly kind: "pinned"; readonly sessionId: string; readonly pinned: boolean }
  | { readonly kind: "deleted"; readonly sessionId: string };

export interface WebuiSessionWorkflows {
  /** The archived-sessions read plus a subscription for its readers. */
  readonly getArchivedSnapshot: () => WebuiArchivedSessionsState;
  readonly subscribeArchived: (listener: () => void) => () => void;
  /**
   * Unsent input an externally deleted session still holds.
   *
   * A session the user did not delete themselves can vanish because another
   * client or the CLI removed it. The text and attachments that were staged for it
   * are the user's, not the catalogue's, so they are retained here rather than
   * dropped with the session: the notice that reports the deletion reads this list
   * until the user copies the text, transfers it to another task, or discards it.
   */
  readonly retainedDeletionDrafts: () => readonly WebuiRetainedDeletionDraft[];
  readonly subscribeRetainedDrafts: (listener: () => void) => () => void;
  /** The text to copy, and the record retires because the user acted on it. */
  readonly copyRetainedDeletionDraft: (sessionId: string) => string | undefined;
  /**
   * Hand the retained input to a task. With no target it goes to the composer's
   * current slot, which is where "continue this elsewhere" starts; the record
   * retires either way, because transferring is the user acting on it.
   */
  readonly transferRetainedDeletionDraft: (
    sessionId: string,
    targetSessionId?: string,
  ) => WebuiUnsentComposerInput | undefined;
  readonly discardRetainedDeletionDraft: (sessionId: string) => void;
  readonly canLoadArchived: boolean;
  readonly loadArchived: () => Promise<void>;
  /** Delete one archived session and refresh the archived list. */
  readonly removeArchived: (sessionId: string) => Promise<void>;
  /** Take one session back out of the archive and refresh both views. */
  readonly unarchive: (sessionId: string) => Promise<void>;
  readonly canUnarchive: boolean;
  /** Whether a flat-list loader is wired (the shell skips the first load when seeded). */
  readonly canLoadFlat: boolean;
  readonly canLoadTree: boolean;
  readonly canMutate: boolean;
  /** Load the first flat page. Resolves when the commit lands. */
  readonly loadFlat: () => Promise<void>;
  readonly loadTree: () => Promise<void>;
  /** Reload both queries in parallel — the post-mutation refresh. */
  readonly refresh: () => Promise<void>;
  /** Append the next flat page. */
  readonly loadMore: (cursor: string | undefined) => Promise<void>;
  /** Set or clear the page-level load error the rail renders. */
  readonly setError: (message: string | undefined) => void;
  /** Rename one session; patches the one entity both views resolve from. */
  readonly rename: (
    sessionId: string,
    title: string,
  ) => Promise<{ readonly title?: string } | undefined>;

  /**
   * Apply a session lifecycle fact another client or the CLI published.
   *
   * The same catalogue patch a local action would make, reached from the wire
   * instead: the rail has to agree with every other window about who exists and
   * what they are named, without the user reloading. A fact about a session this
   * client does not know is ignored rather than inserted — a `created` event from
   * another client means the row belongs in the next page of the catalogue, and
   * synthesizing one here would invent a session record this client never read.
   */
  readonly applyFact: (fact: WebuiSessionLifecycleFact) => void;
  readonly archive: (sessionId: string) => Promise<void>;
  readonly archiveMany: (sessionIds: readonly string[]) => Promise<void>;
  /** Delete one session and drop its entity. */
  readonly remove: (sessionId: string) => Promise<void>;
  /** Whether a fork capability is wired. */
  readonly canFork: boolean;
  /**
   * Fork one session, refreshing the catalog on success. The option gate (a
   * session with no copyable boundary, or an unavailable worktree) is preserved
   * with the same message.
   */
  readonly fork: (
    sessionId: string,
    createIsolatedWorktree: boolean,
  ) => Promise<{ readonly sessionId?: string } | undefined>;
  /** Whether a session-creation capability is wired. */
  readonly canCreateSession: boolean;
  /** Create a session — the agent-chat / plugin surface's session request. */
  readonly createSession: WebuiClientSessionCreator | undefined;
  /** Whether a session-import capability is wired. */
  readonly canImportSession: boolean;
  /** Import a transfer file into a new session; returns its id. */
  readonly importSession: (
    file: Blob,
    context: {
      readonly agentName?: string;
      readonly workspaceDir?: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<{ readonly sessionId: string }>;
  /** Whether a session-export capability is wired. */
  readonly canExportSession: boolean;
  /**
   * Ask the browser to download one session as a transfer file. The decision
   * that this session may be exported is this business's; the navigation is the
   * injected adapter's.
   */
  readonly exportSession: (sessionId: string) => void;
  /** Whether the rail's project list is wired. */
  readonly canLoadProjects: boolean;
  readonly getProjectsSnapshot: () => WebuiProjectsState;
  readonly subscribeProjects: (listener: () => void) => () => void;
  /** Load the visible project list the rail reads (best effort). */
  readonly loadProjects: () => Promise<readonly WebuiClientProject[]>;
  /** Fence project reads when the owning application is disposed. */
  readonly dispose: () => void;
}

export function createWebuiSessionWorkflows(deps: {
  readonly store: WebuiSessionCatalogStore;
  /**
   * The composer's published purge command plus the unsent input it holds. It
   * used to be optional, and absent meant drafts outlive the delete — a soft-loss
   * this module must not keep as a configuration, so the delete **cannot compile**
   * without it. Reading and writing the input is here for the same reason: a
   * deletion is the moment the sessions business has to decide what happens to
   * text the user had not sent.
   */
  readonly composer: WebuiSessionComposerAccess;
  /**
   * The session scope. A delete is an accepted mutation, so it holds a
   * **settlement** lease until its outcome and the invalidation it owes are
   * committed — or until the failure is recorded — and it revokes the deleted
   * session's remaining browser interests at the commit point.
   */
  readonly scope?: WebuiSessionScopeManager;
  /**
   * The delivery disposers. A delete that commits must also stop the wire
   * session it was streaming on: the lease revocation below releases the
   * browser's *interest*, but the loop holding the socket is a separate thing
   * and keeps reading frames for a session that no longer exists.
   */
  readonly deliveries?: { readonly closeSession: (sessionId: string) => void };
  /**
   * Every dependent owner's per-session release, composed by the assembly.
   *
   * A session's disappearance has to reach the owners that were created for it —
   * its goal, its pending permissions and questionnaire, the review of its turns
   * and the workspace resources scoped to it. This module knows *when* they must
   * release; which owners exist and how each releases itself is the assembly's
   * knowledge, and each owner keeps its own command.
   */
  readonly releaseOwners?: (sessionId: string) => void;
  /**
   * Re-read the views that render facts the rail entity does not carry — a
   * session's model and its interaction mode live in the composer's controls and
   * the transcript header, so a wire change to them is answered by a read, not by
   * a patch to a record that has no field for them.
   */
  readonly sessionFactInvalidated?: (sessionId: string) => void;
  readonly port: QueryPort & MutationPort;
  /** Injected browser IO; absent means the import operation is not wired. */
  readonly importSession?: WebuiSessionImporter;
  /** Injected browser IO; absent means the export operation is not wired. */
  readonly exportSession?: WebuiSessionExporter;
}): WebuiSessionWorkflows {
  const { store, composer, port, importSession, exportSession } = deps;
  const message = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);

  // The archived-sessions read keeps its own small state: it is not part of the
  // catalog the rail resolves from, and nothing else writes it.
  let archived: WebuiArchivedSessionsState = initialWebuiArchivedSessionsState;
  let projects: WebuiProjectsState = { loading: false };
  let projectRequestVersion = 0;
  let disposed = false;
  const projectListeners = new Set<() => void>();
  const setProjects = (next: WebuiProjectsState): void => {
    projects = next;
    for (const listener of [...projectListeners]) listener();
  };
  const archivedListeners = new Set<() => void>();
  const setArchived = (next: WebuiArchivedSessionsState): void => {
    archived = next;
    for (const listener of archivedListeners) listener();
  };
  // The newest archived read. A reply whose version is no longer current is
  // dropped, so the ordered pairs of "delete then reload" and "reload then
  // reload" cannot be undone by a slower earlier request (see `loadArchived`).
  let archivedRequestVersion = 0;
  const loadArchived = async (): Promise<void> => {
    if (!port.listArchivedSessions) {
      setArchived({
        status: "error",
        sessions: [],
        error: "当前运行时不支持读取已归档任务。",
      });
      return;
    }
    // The archived list is a second server-derived read, so it needs its own
    // pair of guards — the catalog fence above cannot reach it:
    //
    //   1. the delete filter, because a page the server composed *before* a
    //      delete committed still names the deleted session;
    //   2. a request version, because a page that was already in flight when a
    //      newer read started must not overwrite that newer answer. Without it
    //      a late reply restores the row the delete had just removed, and an
    //      old failure replaces a fresh result.
    const version = archivedRequestVersion + 1;
    archivedRequestVersion = version;
    setArchived({ ...archived, status: "loading" });
    try {
      const page = await port.listArchivedSessions();
      if (version !== archivedRequestVersion) return;
      setArchived({ status: "ready", sessions: dropRemovedArchived(page.sessions) });
    } catch (reason) {
      if (version !== archivedRequestVersion) return;
      setArchived({ status: "error", sessions: [], error: message(reason) });
    }
  };

  // Sessions this workflow has deleted. A catalog load that was already in
  // flight when the delete committed must not put the entity back — the rail
  // would show a session the server no longer has, and the application store
  // has already dropped its record, so the row would render as an empty
  // husk. Every catalog merge runs through `commitCatalog`, so the fence holds
  // for the delete's own `refresh()` as well as for a stale `loadMore` or
  // `loadTree`. Session ids are never reused, so the set only grows with the
  // number of deletions.
  const removedSessionIds = new Set<string>();

  /**
   * Unsent input retained from sessions somebody else deleted.
   *
   * A bounded bucket, like the deletion fence beside it: the record is retired by
   * the user copying, transferring or discarding it, and cleared when the page is
   * torn down. That is the same boundedness exception an in-memory fact log takes for
   * tombstones — bounded by user action rather than by a quota — and it is stated
   * rather than implied.
   */
  const retainedDrafts = new Map<string, WebuiRetainedDeletionDraft>();
  let retainedSnapshot: readonly WebuiRetainedDeletionDraft[] = [];
  const retainedListeners = new Set<() => void>();
  const notifyRetained = (): void => {
    retainedSnapshot = [...retainedDrafts.values()];
    for (const listener of [...retainedListeners]) listener();
  };
  const retainUnsentInput = (sessionId: string): void => {
    const input = composer.readUnsent(sessionId);
    if (input.draft === "" && input.attachments.length === 0 && input.urlReferences.length === 0) {
      // Nothing of the user's was unsent for this session, so there is nothing to
      // retain and no notice to raise.
      return;
    }
    retainedDrafts.set(sessionId, { sessionId, ...input });
    notifyRetained();
  };
  const dropRetained = (sessionId: string): void => {
    if (!retainedDrafts.delete(sessionId)) return;
    notifyRetained();
  };
  const copyRetainedDeletionDraft = (sessionId: string): string | undefined => {
    const retained = retainedDrafts.get(sessionId);
    if (!retained) return undefined;
    // Copying is the user acting on it: the notice has done its job, and keeping
    // the record would mean asking them to dismiss something already handled.
    dropRetained(sessionId);
    return retained.draft;
  };
  const transferRetainedDeletionDraft = (
    sessionId: string,
    targetSessionId?: string,
  ): WebuiUnsentComposerInput | undefined => {
    const retained = retainedDrafts.get(sessionId);
    if (!retained) return undefined;
    const input: WebuiUnsentComposerInput = {
      draft: retained.draft,
      attachments: retained.attachments,
      urlReferences: retained.urlReferences,
    };
    composer.writeUnsent(targetSessionId, input);
    dropRetained(sessionId);
    return input;
  };

  const dropRemovedEntities = (
    state: WebuiSessionCatalogState,
  ): WebuiSessionCatalogState =>
    removedSessionIds.size === 0
      ? state
      : removeWebuiCatalogSessions(state, [...removedSessionIds]);

  /**
   * The archived list's half of the same fence. `commitCatalog` cannot reach
   * it: the archived page is its own server-derived read, so a reply composed
   * before the delete still names the deleted session and would render it as a
   * row the server no longer has.
   */
  const dropRemovedArchived = (
    sessions: readonly WebuiSessionListItem[],
  ): readonly WebuiSessionListItem[] =>
    removedSessionIds.size === 0
      ? sessions
      : sessions.filter((session) => !removedSessionIds.has(session.sessionId));

  /**
   * The archived list's visible half of the delete. `loadArchived` keeps the
   * current sessions while it is `loading` (only the status changes), so a row
   * deleted from the archived page would stay on screen — and stay clickable —
   * until the reply lands. Dropping it at delete-commit time keeps the rendered
   * list from naming a session the server no longer has.
   */
  const dropRemovedArchivedRows = (): void => {
    if (archived.status === "idle") return;
    const sessions = dropRemovedArchived(archived.sessions);
    if (sessions.length === archived.sessions.length) return;
    setArchived({ ...archived, sessions });
  };

  /**
   * The one teardown for a session that is confirmed gone, whichever route
   * noticed. Local delete, archived-page delete and externally observed deletion
   * all converge here, so "the session is gone" has one meaning in this client
   * rather than three that can drift apart.
   *
   * The order is the fence first: `removedSessionIds` before any state changes,
   * so a stream frame, a lifecycle event or a catalog load already in flight
   * writes nothing from the moment this runs.
   *
   * The two origins differ in exactly one place: **what happens to input the user
   * had not sent.** A local delete is the user ending the task, so the composer
   * slot goes with it — that is what they asked for. An external deletion is
   * somebody else ending it, so the unsent text and attachments are retained for
   * the user to copy, transfer or discard; destroying them because another client
   * deleted a session would be losing the user's work to a fact about the
   * catalogue.
   */
  const teardownDeletedSession = (
    sessionId: string,
    origin: "local" | "external",
  ): void => {
    removedSessionIds.add(sessionId);
    // Read before anything is released: the input belongs to a slot this teardown
    // is about to fence.
    if (origin === "external") retainUnsentInput(sessionId);
    // The wire session stops before the interest that could reopen it is
    // released: revoking the lease alone leaves the delivery loop reading frames
    // for a session the server no longer has.
    deps.deliveries?.closeSession(sessionId);
    store.purgeSession(sessionId);
    if (origin === "local") composer.purgeSlot(sessionId);
    // Every browser interest in the deleted session goes with it, including a
    // delivery lease on a stream that can no longer commit.
    deps.scope?.purge(sessionId);
    // The dependent owners: each releases its own observable state through its own
    // command. Disposing the session record and the catalogue is not teardown —
    // a per-session goal, a pending permission, a review of a deleted task and a
    // canvas document would each outlive the session they describe.
    deps.releaseOwners?.(sessionId);
    commitCatalog((current) => removeWebuiCatalogSessions(current, [sessionId]));
    dropRemovedArchivedRows();
  };

  /**
   * The one write path into the catalog. Composing the fence here rather than
   * at each call site is what makes "a removed session stays removed" a
   * property of the workflow instead of a rule each new load has to remember.
   */
  const commitCatalog = (
    update: (current: WebuiSessionCatalogState) => WebuiSessionCatalogState,
  ): void => {
    store.updateCatalog((current) => dropRemovedEntities(update(current)));
  };

  const applyFlatLoaded = (page: WebuiClientSessionPage): void => {
    commitCatalog((current) => reduceWebuiCatalogFlatLoaded(current, page));
  };

  const loadFlat = async (): Promise<void> => {
    if (!port.loadSessions) return;
    commitCatalog((current) => setWebuiCatalogFlatLoading(current, true));
    try {
      const page = await port.loadSessions();
      commitCatalog((current) => {
        const loaded = reduceWebuiCatalogFlatLoaded(current, page);
        return setWebuiCatalogFlatError(loaded, undefined);
      });
    } catch (reason) {
      commitCatalog((current) => setWebuiCatalogFlatError(current, message(reason)));
      commitCatalog((current) => setWebuiCatalogFlatLoading(current, false));
      return;
    }
    commitCatalog((current) => setWebuiCatalogFlatLoading(current, false));
  };

  const loadTree = async (): Promise<void> => {
    if (!port.loadSessionTree) return;
    try {
      const page = await port.loadSessionTree();
      commitCatalog((current) => reduceWebuiCatalogTreeLoaded(current, page));
    } catch {
      // Tree projection is optional; a runtime without child-session support
      // must not break the flat-list rail.
    }
  };

  const refresh = async (): Promise<void> => {
    const [page, tree] = await Promise.all([
      port.loadSessions?.(),
      port.loadSessionTree?.(),
    ]);
    if (page) applyFlatLoaded(page);
    if (tree) commitCatalog((current) => reduceWebuiCatalogTreeLoaded(current, tree));
  };

  const loadMore = async (cursor: string | undefined): Promise<void> => {
    if (!port.loadSessions) return;
    commitCatalog((current) => setWebuiCatalogFlatLoading(current, true));
    try {
      const page = await port.loadSessions(cursor);
      commitCatalog((current) => reduceWebuiCatalogFlatAppended(current, page));
    } finally {
      commitCatalog((current) => setWebuiCatalogFlatLoading(current, false));
    }
  };

  return {
    canLoadFlat: port.loadSessions !== undefined,
    canLoadTree: port.loadSessionTree !== undefined,
    canMutate: port.updateSession !== undefined,
    loadFlat,
    loadTree,
    refresh,
    loadMore,
    setError: (message) => {
      commitCatalog((current) => setWebuiCatalogFlatError(current, message));
    },
    applyFact: (fact) => {
      if (removedSessionIds.has(fact.sessionId)) return;
      // A fact about a session this client has not read is not something to
      // invent: the authoritative copy arrives with the next page of the
      // catalogue, and fabricating an entity here would put a record in the rail
      // that no read ever produced.
      const known = store.getSnapshot().catalog.entities.has(fact.sessionId);
      if (!known) return;
      switch (fact.kind) {
        case "renamed":
          // The local rename patches the entity the same way; this is the wire
          // reaching that same patch rather than reloading the page.
          commitCatalog((current) =>
            patchWebuiCatalogEntity(current, fact.sessionId, { title: fact.title }),
          );
          return;
        case "re-modelled":
          // The rail does not render a session's model, so there is nothing to
          // patch here — but the fact still has to reach this page's routing, so
          // it invalidates the reads that do show it (the composer's model list
          // and this session's transcript header) rather than being dropped.
          deps.sessionFactInvalidated?.(fact.sessionId);
          return;
        case "interaction-mode":
          deps.sessionFactInvalidated?.(fact.sessionId);
          return;
        case "visibility":
          // Hiding is a presentation fact about a session that still exists, so
          // it filters the catalogue rather than deleting anything.
          if (fact.hidden) {
            commitCatalog((current) => hideWebuiCatalogSessions(current, [fact.sessionId]));
          }
          return;
        case "pinned":
          deps.sessionFactInvalidated?.(fact.sessionId);
          return;
        case "created":
          // Another client or the CLI created something this page can see. The
          // flat page is the authoritative list, so the row is not synthesised
          // here — but the fact still has to *cause* the repair rather than wait
          // for one: a session that exists everywhere else and not here is
          // exactly the stale catalogue this route exists to prevent. The reload
          // runs through the same removal fence and request guards as any other.
          void loadFlat();
          return;
        case "deleted":
          // Confirmed gone by another client. This is the same confirmation a
          // local delete produced, so it takes the same teardown — including
          // stopping the wire session, which `removedSessionIds` then keeps from
          // being applied twice if the local delete also lands.
          teardownDeletedSession(fact.sessionId, "external");
          return;
        default:
          return;
      }
    },
    rename: async (sessionId, title) => {
      if (!port.updateSession) return undefined;
      const result = await port.updateSession({ id: sessionId, title });
      const nextTitle = result.session?.title;
      if (nextTitle) {
        commitCatalog((current) =>
          patchWebuiCatalogEntity(current, sessionId, { title: nextTitle }),
        );
      }
      return result.session;
    },
    archive: async (sessionId) => {
      if (!port.archiveSession) return;
      await port.archiveSession({ id: sessionId });
      await refresh();
      if (archived.status !== "idle") await loadArchived();
    },
    archiveMany: async (sessionIds) => {
      if (!port.archiveSession) return;
      await Promise.all(sessionIds.map((id) => port.archiveSession!({ id })));
      await refresh();
      if (archived.status !== "idle") await loadArchived();
    },
    remove: async (sessionId) => {
      if (!port.deleteSession) return;
      // A session this client has already torn down is not deleted twice: the
      // second request would be a redundant mutation for a session the server
      // no longer has, and a second refresh over a catalog that already dropped it.
      if (removedSessionIds.has(sessionId)) return;
      // The settlement lease outlives the view that asked for the delete: the
      // session cannot be evicted while the mutation it owes is in flight.
      const settle = deps.scope?.acquire(sessionId, "settlement", `delete:${sessionId}`);
      try {
        await port.deleteSession({ id: sessionId });
      } catch (error) {
        // A failed delete retains state, and retains nothing of the lease.
        settle?.();
        throw error;
      }
      // The delete has committed, so every slice that could still describe a
      // live session goes. Local and externally observed deletion converge on
      // this one teardown, so neither order can leave a half-deleted session.
      teardownDeletedSession(sessionId, "local");
      await refresh();
      if (archived.status !== "idle") await loadArchived();
      settle?.();
    },
    getArchivedSnapshot: () => archived,
    subscribeArchived: (listener) => {
      archivedListeners.add(listener);
      return () => {
        archivedListeners.delete(listener);
      };
    },
    canLoadArchived: port.listArchivedSessions !== undefined,
    loadArchived,
    removeArchived: async (sessionId) => {
      if (!port.deleteSession) return;
      // The same fence as `remove`: the archived page and the rail are two views
      // of one catalogue, so a delete from either settles for both.
      if (removedSessionIds.has(sessionId)) return;
      const settle = deps.scope?.acquire(sessionId, "settlement", `delete:${sessionId}`);
      try {
        await port.deleteSession({ id: sessionId });
      } catch (error) {
        settle?.();
        throw error;
      }
      // Deleting from the archived page removes the same session the rail
      // could still be showing, so it takes the same teardown as `remove`.
      teardownDeletedSession(sessionId, "local");
      await loadArchived();
    },
    unarchive: async (sessionId) => {
      if (!port.archiveSession) return;
      await port.archiveSession({ id: sessionId, archived: false });
      await refresh();
      if (archived.status !== "idle") await loadArchived();
    },
    canUnarchive: port.archiveSession !== undefined,
    canFork: port.forkSession !== undefined,
    fork: async (sessionId, createIsolatedWorktree) => {
      if (!port.forkSession) return undefined;
      const options = await port.getSessionForkOptions?.({ id: sessionId });
      if (options && !options.canFork)
        throw new Error(
          `当前会话不可复制：${options.unavailableReason ?? "没有可复制的消息边界"}`,
        );
      if (createIsolatedWorktree && options && !options.worktreeVisible)
        throw new Error(
          `当前会话不可复制到新工作树：${options.worktreeUnavailableReason ?? "工作树不可用"}`,
        );
      const result = await port.forkSession({
        id: sessionId,
        clientRequestId: generateForkClientRequestId(),
        useSuggestedTitle: true,
        createIsolatedWorktree,
      });
      await refresh();
      return result.session;
    },
    canCreateSession: port.createSession !== undefined,
    createSession: port.createSession,
    canImportSession: importSession !== undefined,
    importSession: async (file, context) => {
      if (!importSession)
        throw new Error("当前 WebUI 未连接会话导入服务");
      return importSession(file, context);
    },
    canExportSession: exportSession !== undefined,
    exportSession: (sessionId) => {
      // Synchronous, like the adapter: the browser either starts the download
      // or the adapter raises the reason it cannot (no runtime, no address
      // bar), and both callers report that through `setError`.
      if (!exportSession)
        throw new Error("当前 WebUI 未连接会话导出服务");
      exportSession(sessionId);
    },
    canLoadProjects: port.loadProjects !== undefined,
    getProjectsSnapshot: () => projects,
    subscribeProjects: (listener) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    loadProjects: async () => {
      if (!port.loadProjects) return [];
      if (disposed) return projects.projects ?? [];
      const version = ++projectRequestVersion;
      setProjects({ ...projects, loading: true, error: undefined });
      try {
        const result = await port.loadProjects();
        if (disposed || version !== projectRequestVersion) return result;
        setProjects({ loading: false, projects: result });
        return result;
      } catch (error) {
        if (!disposed && version === projectRequestVersion) {
          setProjects({ loading: false, ...(projects.projects ? { projects: projects.projects } : {}), error: message(error) });
        }
        throw error;
      } finally {
        if (!disposed && version === projectRequestVersion && projects.loading) {
          setProjects({ ...projects, loading: false });
        }
      }
    },
    retainedDeletionDrafts: () => retainedSnapshot,
    subscribeRetainedDrafts: (listener) => {
      retainedListeners.add(listener);
      return () => retainedListeners.delete(listener);
    },
    copyRetainedDeletionDraft,
    transferRetainedDeletionDraft,
    discardRetainedDeletionDraft: dropRetained,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      projectRequestVersion += 1;
      if (projects.loading) setProjects({ ...projects, loading: false });
      projectListeners.clear();
      // A retained draft is retained for a notice on this page; the page going
      // away is the end of the retention this owner keeps.
      retainedDrafts.clear();
      retainedSnapshot = [];
      retainedListeners.clear();
    },
  };
}
