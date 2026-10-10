// The session entity catalog: one copy of every session record, plus the two
// query results that reference it (plan §7.1 `application/session-catalog.ts`;
// §7.6 "Flat/tree queries"; §7.7 stage 5; ticket #49 correction 1).
//
// Flat and tree are **two queries, not two sets of entities**. Each keeps its
// own identifiers, cursor, loading and error state; the session records
// themselves live once in `entities`, keyed by session id. A rename therefore
// patches one entity and both derived views agree — no component has to update
// two structures by hand and no rename can leave the flat list and the tree
// disagreeing about a title.
//
// This module is deliberately pure: it holds the state shape and the reducers
// that transform it, and the selectors that resolve a query result into the
// page shapes the rail consumes. The store that owns the single writable copy
// and the command surface over these reducers live in `application/` siblings,
// exactly as the activity slice was split (`session-store.ts` writes it,
// `unread.ts` names the changes).

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

/**
 * Merge a batch of records into the entity map. Returns the *same* map when
 * every record is already present by reference, so a redundant load does not
 * churn the snapshot identity.
 */
function mergeSessions(
  entities: ReadonlyMap<string, WebuiClientSession>,
  sessions: readonly WebuiClientSession[],
): ReadonlyMap<string, WebuiClientSession> {
  let next: Map<string, WebuiClientSession> | undefined;
  for (const session of sessions) {
    if (entities.get(session.sessionId) === session) continue;
    next ??= new Map(entities);
    next.set(session.sessionId, session);
  }
  return next ?? entities;
}

/** Replace the flat query with a freshly loaded page (first page or a reload). */
export function reduceWebuiCatalogFlatLoaded(
  catalog: WebuiSessionCatalogState,
  page: WebuiClientSessionPage,
): WebuiSessionCatalogState {
  return {
    entities: mergeSessions(catalog.entities, page.sessions),
    flat: {
      ids: page.sessions.map((session) => session.sessionId),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      loading: false,
    },
    tree: catalog.tree,
  };
}

/** Append a next page to the flat query, preserving the cursor it reports. */
export function reduceWebuiCatalogFlatAppended(
  catalog: WebuiSessionCatalogState,
  page: WebuiClientSessionPage,
): WebuiSessionCatalogState {
  return {
    entities: mergeSessions(catalog.entities, page.sessions),
    flat: {
      ids: [
        ...catalog.flat.ids,
        ...page.sessions.map((session) => session.sessionId),
      ],
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      loading: catalog.flat.loading,
      ...(catalog.flat.error !== undefined ? { error: catalog.flat.error } : {}),
    },
    tree: catalog.tree,
  };
}

/**
 * The children a wire node declares, read defensively.
 *
 * The wire type says every node carries an array, but nothing on the wire
 * enforces that: a serializer that omits empty fields, a runtime older than the
 * tree projection, or a hand-rolled adapter that only populates the field when
 * there ARE children all produce a node without it — and a session with no
 * sub-agents is the overwhelmingly common case, so omitting the field is the
 * cheap, natural encoding rather than an exotic one. Reading it raw used to
 * throw here, and the throw was swallowed by the caller's catch, so one
 * malformed node silently emptied the whole tree view. A missing or non-array
 * value now means "no children", which is what the sibling read path
 * (`selectWebuiCatalogTreePage`) has always done.
 */
function childSessionsOf(node: WebuiClientSessionTreePage["sessions"][number]): readonly WebuiClientSession[] {
  const children = (node as { readonly childSessions?: unknown }).childSessions;
  return Array.isArray(children) ? (children as readonly WebuiClientSession[]) : [];
}

/** Replace the tree query with a freshly loaded projection. */
export function reduceWebuiCatalogTreeLoaded(
  catalog: WebuiSessionCatalogState,
  page: WebuiClientSessionTreePage,
): WebuiSessionCatalogState {
  const sessions: WebuiClientSession[] = [];
  const nodes: WebuiCatalogTreeQueryNode[] = [];
  for (const node of page.sessions) {
    if (!node?.session) continue;
    const children = childSessionsOf(node);
    sessions.push(node.session, ...children);
    nodes.push({
      sessionId: node.session.sessionId,
      childIds: children.map((child) => child.sessionId),
    });
  }
  return {
    entities: mergeSessions(catalog.entities, sessions),
    flat: catalog.flat,
    tree: {
      nodes,
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    },
  };
}

export function setWebuiCatalogFlatLoading(
  catalog: WebuiSessionCatalogState,
  loading: boolean,
): WebuiSessionCatalogState {
  if (catalog.flat.loading === loading) return catalog;
  return { ...catalog, flat: { ...catalog.flat, loading } };
}

export function setWebuiCatalogFlatError(
  catalog: WebuiSessionCatalogState,
  error: string | undefined,
): WebuiSessionCatalogState {
  if (catalog.flat.error === error) return catalog;
  return {
    ...catalog,
    flat: {
      ...catalog.flat,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

/**
 * Patch one entity in place — the rename/fork/delete coordination point. Both
 * query views re-derive from the patched entity, so a caller updates exactly
 * one structure (ticket #49 correction 2).
 */
export function patchWebuiCatalogEntity(
  catalog: WebuiSessionCatalogState,
  sessionId: string,
  patch: Partial<WebuiClientSession>,
): WebuiSessionCatalogState {
  const current = catalog.entities.get(sessionId);
  if (!current) return catalog;
  const entities = new Map(catalog.entities);
  entities.set(sessionId, { ...current, ...patch });
  return { ...catalog, entities };
}

/** Drop entities for sessions a delete confirmed gone. */
export function removeWebuiCatalogEntities(
  catalog: WebuiSessionCatalogState,
  sessionIds: readonly string[],
): WebuiSessionCatalogState {
  let next: Map<string, WebuiClientSession> | undefined;
  for (const sessionId of sessionIds) {
    if (!catalog.entities.has(sessionId)) continue;
    next ??= new Map(catalog.entities);
    next.delete(sessionId);
  }
  return next ? { ...catalog, entities: next } : catalog;
}

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

/**
 * Seed the catalog from a pre-loaded flat page (SSR snapshot / test seed), so
 * the first paint reads the same entity map the rail will keep using.
 */
export function createWebuiSessionCatalogFromPage(
  page: WebuiClientSessionPage,
): WebuiSessionCatalogState {
  return reduceWebuiCatalogFlatLoaded(initialWebuiSessionCatalogState, page);
}
