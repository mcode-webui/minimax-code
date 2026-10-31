// The sessions business's published read surface: the catalogue's state shape
// and the two selectors that resolve a query result into a page.
//
// The reducers that transform the catalogue are private to this business — a
// peer reads sessions, it does not rewrite them. Everything a peer needs to
// hold a catalogue and read a page from it is here, so the review settings
// page, the archived-session settings page and the composer's mention menu all
// resolve the same catalogue the rail renders instead of each keeping its own
// read of it.

import type {
  WebuiClientSession,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
} from "../contracts/session-view.js";

/** One tree query node: the root session id and its child session ids. */
export interface WebuiCatalogTreeQueryNode {
  readonly sessionId: string;
  readonly childIds: readonly string[];
}

/**
 * The flat query result. Identifiers, not records: the records are in
 * `entities`. `loading` lives here rather than in the store snapshot's top
 * level because it is a fact about *this* query, and `error` is the
 * page-level load failure the rail renders.
 */
export interface WebuiCatalogFlatQuery {
  readonly ids: readonly string[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly loading: boolean;
  readonly error?: string;
}

/** The tree query result: root→child id relationships plus its own cursor. */
export interface WebuiCatalogTreeQuery {
  readonly nodes: readonly WebuiCatalogTreeQueryNode[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiSessionCatalogState {
  /** The one copy of each session record, keyed by session id. */
  readonly entities: ReadonlyMap<string, WebuiClientSession>;
  readonly flat: WebuiCatalogFlatQuery;
  readonly tree: WebuiCatalogTreeQuery;
}

export const initialWebuiCatalogFlatQuery: WebuiCatalogFlatQuery = {
  ids: [],
  hasMore: false,
  loading: false,
};

export const initialWebuiCatalogTreeQuery: WebuiCatalogTreeQuery = {
  nodes: [],
  hasMore: false,
};

export const initialWebuiSessionCatalogState: WebuiSessionCatalogState = {
  entities: new Map(),
  flat: initialWebuiCatalogFlatQuery,
  tree: initialWebuiCatalogTreeQuery,
};

/** The flat page the rail renders, resolved from the entity map. */
export function selectWebuiCatalogFlatPage(
  catalog: WebuiSessionCatalogState,
): WebuiClientSessionPage {
  const sessions: WebuiClientSession[] = [];
  for (const id of catalog.flat.ids) {
    const entity = catalog.entities.get(id);
    if (entity) sessions.push(entity);
  }
  return {
    sessions,
    hasMore: catalog.flat.hasMore,
    ...(catalog.flat.nextCursor !== undefined
      ? { nextCursor: catalog.flat.nextCursor }
      : {}),
  };
}

/** The tree page the rail renders, resolved from the entity map. */
export function selectWebuiCatalogTreePage(
  catalog: WebuiSessionCatalogState,
): WebuiClientSessionTreePage {
  const sessions: WebuiClientSessionTreePage["sessions"][number][] = [];
  for (const node of catalog.tree.nodes) {
    const session = catalog.entities.get(node.sessionId);
    if (!session) continue;
    const childSessions: WebuiClientSession[] = [];
    for (const childId of node.childIds) {
      const child = catalog.entities.get(childId);
      if (child) childSessions.push(child);
    }
    sessions.push({ session, childSessions });
  }
  return {
    sessions,
    hasMore: catalog.tree.hasMore,
    ...(catalog.tree.nextCursor !== undefined
      ? { nextCursor: catalog.tree.nextCursor }
      : {}),
  };
}
