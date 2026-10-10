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
  removeWebuiCatalogEntities,
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
  readonly port: QueryPort & MutationPort;
  /** Injected browser IO; absent means the import operation is not wired. */
  readonly importSession?: WebuiSessionImporter;
}): WebuiSessionWorkflows {
  const { store, port, importSession } = deps;
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

  const applyFlatLoaded = (page: WebuiClientSessionPage): void => {
    store.updateCatalog((current) => reduceWebuiCatalogFlatLoaded(current, page));
  };

  const loadFlat = async (): Promise<void> => {
    if (!port.loadSessions) return;
    store.updateCatalog((current) => setWebuiCatalogFlatLoading(current, true));
    try {
      const page = await port.loadSessions();
      store.updateCatalog((current) => {
        const loaded = reduceWebuiCatalogFlatLoaded(current, page);
        return setWebuiCatalogFlatError(loaded, undefined);
      });
    } catch (reason) {
      store.updateCatalog((current) =>
        setWebuiCatalogFlatError(current, message(reason)),
      );
      store.updateCatalog((current) => setWebuiCatalogFlatLoading(current, false));
      return;
    }
    store.updateCatalog((current) => setWebuiCatalogFlatLoading(current, false));
  };

  const loadTree = async (): Promise<void> => {
    if (!port.loadSessionTree) return;
    try {
      const page = await port.loadSessionTree();
      store.updateCatalog((current) =>
        reduceWebuiCatalogTreeLoaded(current, page),
      );
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
    if (tree) store.updateCatalog((current) => reduceWebuiCatalogTreeLoaded(current, tree));
  };

  const loadMore = async (cursor: string | undefined): Promise<void> => {
    if (!port.loadSessions) return;
    store.updateCatalog((current) => setWebuiCatalogFlatLoading(current, true));
    try {
      const page = await port.loadSessions(cursor);
      store.updateCatalog((current) => reduceWebuiCatalogFlatAppended(current, page));
    } finally {
      store.updateCatalog((current) => setWebuiCatalogFlatLoading(current, false));
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
      store.updateCatalog((current) =>
        setWebuiCatalogFlatError(current, message),
      );
    },
    rename: async (sessionId, title) => {
      if (!port.updateSession) return undefined;
      const result = await port.updateSession({ id: sessionId, title });
      const nextTitle = result.session?.title;
      if (nextTitle) {
        store.updateCatalog((current) =>
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
      store.updateCatalog((current) =>
        removeWebuiCatalogEntities(current, [sessionId]),
      );
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
      await loadArchived();
    },
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
        clientRequestId: globalThis.crypto.randomUUID(),
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
