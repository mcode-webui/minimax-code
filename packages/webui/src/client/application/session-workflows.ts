// The session workflows: the business requests that load and mutate session
// entities, bound to the single catalog (plan §7.1 `application/session-workflows.ts`;
// §7.7 stage 5; ticket #49 correction 2 and criterion 8).
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
import type {
  WebuiClientProject,
  WebuiClientSessionPage,
} from "../contracts/session-view.js";
import type { WebuiSessionListItem } from "../../shared/contracts/session.js";
import {
  patchWebuiCatalogEntity,
  reduceWebuiCatalogFlatAppended,
  reduceWebuiCatalogFlatLoaded,
  reduceWebuiCatalogTreeLoaded,
  removeWebuiCatalogSessions,
  setWebuiCatalogFlatError,
  setWebuiCatalogFlatLoading,
} from "./session-catalog.js";
import type { WebuiSessionCatalogState } from "./session-catalog.js";

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
 * The composer store's reader/writer — drafts and input history per slot.
 * The session workflow takes only the purge method because a delete is the
 * single trigger for clearing a session's draft.
 */
export interface WebuiComposerPurger {
  readonly purgeSlot: (key: string) => void;
}

/**
 * The session-import capability, injected because the implementation is
 * browser IO (`infrastructure/session-import.ts`) and this module is the
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
 * The archived-sessions read (ticket #52). The archived page lives inside the
 * settings dialog, but the query is a session query, so it belongs to the
 * session workflows rather than to a settings owner.
 */
export interface WebuiArchivedSessionsState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sessions: readonly WebuiSessionListItem[];
  readonly error?: string;
}

export const initialWebuiArchivedSessionsState: WebuiArchivedSessionsState = {
  status: "idle",
  sessions: [],
};

export interface WebuiSessionWorkflows {
  /** The archived-sessions read plus a subscription for its readers. */
  readonly getArchivedSnapshot: () => WebuiArchivedSessionsState;
  readonly subscribeArchived: (listener: () => void) => () => void;
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
  /** Whether the rail's project list is wired. */
  readonly canLoadProjects: boolean;
  /** Load the visible project list the rail reads (best effort). */
  readonly loadProjects: () => Promise<readonly WebuiClientProject[]>;
}

export function createWebuiSessionWorkflows(deps: {
  readonly store: WebuiSessionCatalogStore;
  /** The composer purger; absent means drafts outlive the delete (a soft-loss). */
  readonly composer?: WebuiComposerPurger;
  readonly port: QueryPort & MutationPort;
  /** Injected browser IO; absent means the import operation is not wired. */
  readonly importSession?: WebuiSessionImporter;
}): WebuiSessionWorkflows {
  const { store, composer, port, importSession } = deps;
  const message = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);

  // The archived-sessions read keeps its own small state: it is not part of the
  // catalog the rail resolves from, and nothing else writes it.
  let archived: WebuiArchivedSessionsState = initialWebuiArchivedSessionsState;
  const archivedListeners = new Set<() => void>();
  const setArchived = (next: WebuiArchivedSessionsState): void => {
    archived = next;
    for (const listener of archivedListeners) listener();
  };
  const loadArchived = async (): Promise<void> => {
    if (!port.listArchivedSessions) {
      setArchived({
        status: "error",
        sessions: [],
        error: "当前运行时不支持读取已归档任务。",
      });
      return;
    }
    setArchived({ ...archived, status: "loading" });
    try {
      const page = await port.listArchivedSessions();
      setArchived({ status: "ready", sessions: page.sessions });
    } catch (reason) {
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

  const dropRemovedEntities = (
    state: WebuiSessionCatalogState,
  ): WebuiSessionCatalogState =>
    removedSessionIds.size === 0
      ? state
      : removeWebuiCatalogSessions(state, [...removedSessionIds]);

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
      await port.deleteSession({ id: sessionId });
      // The delete has committed, so every slice that could still describe a
      // live session goes: the session fence first (so a stream frame or event
      // that arrives from here on writes nothing), then the application-store
      // record and activity, then the composer slot's draft and history, then
      // the catalog entity. `removedSessionIds` keeps the entity out of every
      // later merge, including the `refresh()` below.
      removedSessionIds.add(sessionId);
      store.purgeSession(sessionId);
      composer?.purgeSlot(sessionId);
      commitCatalog((current) => removeWebuiCatalogSessions(current, [sessionId]));
      await refresh();
      if (archived.status !== "idle") await loadArchived();
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
      await port.deleteSession({ id: sessionId });
      // Deleting from the archived page removes the same session the rail
      // could still be showing, so it takes the same teardown as `remove`.
      removedSessionIds.add(sessionId);
      store.purgeSession(sessionId);
      composer?.purgeSlot(sessionId);
      commitCatalog((current) => removeWebuiCatalogSessions(current, [sessionId]));
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
    canLoadProjects: port.loadProjects !== undefined,
    loadProjects: async () => port.loadProjects?.() ?? [],
  };
}
