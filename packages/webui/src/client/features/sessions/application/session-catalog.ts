// The session entity catalog: one copy of every session record, plus the two
// query results that reference it.
//
// Flat and tree are **two queries, not two sets of entities**. Each keeps its
// own identifiers, cursor, loading and error state; the session records
// themselves live once in `entities`, keyed by session id. A rename therefore
// patches one entity and both derived views agree — no component has to update
// two structures by hand and no rename can leave the flat list and the tree
// disagreeing about a title.
//
// This module is deliberately pure: it holds the reducers that transform the
// catalogue. The state shape and the selectors that resolve a query result
// into page shapes live in the published sibling `session-catalog.public.ts`,
// which is what a peer business reads; the reducers stay here because a peer
// reads sessions, it does not rewrite them. The store that owns the single
// writable copy and the command surface over these reducers live in
// `application/` siblings, exactly as the activity slice was split
// (`session-store.ts` writes it, the activity controller names the changes).

import type {
  WebuiClientSession,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
} from "../contracts/session-view.js";
import {
  initialWebuiSessionCatalogState,
  type WebuiCatalogTreeQueryNode,
  type WebuiSessionCatalogState,
} from "./session-catalog.public.js";

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
 * one structure.
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

/**
 * Drop sessions a delete confirmed gone — the entity **and** every identifier
 * that still points at it.
 *
 * Entity removal alone leaves a phantom id in `flat.ids` and a stale node in
 * `tree.nodes`: the selectors skip an id whose entity is missing, so the rail
 * would render correctly, but the catalog would keep claiming a session the
 * server no longer has. That phantom is exactly what a stale load produces, so
 * the delete fence needs the identifier removed too. Returns the same object
 * when there is nothing to drop.
 */
export function removeWebuiCatalogSessions(
  catalog: WebuiSessionCatalogState,
  sessionIds: readonly string[],
): WebuiSessionCatalogState {
  const removed = new Set(sessionIds);
  const entities = removeWebuiCatalogEntities(catalog, sessionIds);
  const ids = catalog.flat.ids.filter((id) => !removed.has(id));
  const nodes: WebuiCatalogTreeQueryNode[] = [];
  let treeChanged = false;
  for (const node of catalog.tree.nodes) {
    if (removed.has(node.sessionId)) {
      treeChanged = true;
      continue;
    }
    const childIds = node.childIds.filter((childId) => !removed.has(childId));
    if (childIds.length === node.childIds.length) {
      nodes.push(node);
      continue;
    }
    treeChanged = true;
    nodes.push({ ...node, childIds });
  }
  const flatChanged = ids.length !== catalog.flat.ids.length;
  if (entities === catalog && !treeChanged && !flatChanged) return catalog;
  return {
    entities: entities.entities,
    flat: flatChanged ? { ...catalog.flat, ids } : catalog.flat,
    tree: treeChanged ? { ...catalog.tree, nodes } : catalog.tree,
  };
}

/**
 * Hide sessions from the rendered lists while keeping their records.
 *
 * Distinct from `removeWebuiCatalogSessions`, which is for a session that is gone.
 * A session another client hid still exists and can be unhidden, so its entity
 * stays: dropping it would make a later unhide a full re-read, and would lose
 * the record the rail would need to show it again.
 */
export function hideWebuiCatalogSessions(
  catalog: WebuiSessionCatalogState,
  sessionIds: readonly string[],
): WebuiSessionCatalogState {
  const hidden = new Set(sessionIds);
  if (hidden.size === 0) return catalog;
  const ids = catalog.flat.ids.filter((id) => !hidden.has(id));
  const nodes: WebuiCatalogTreeQueryNode[] = [];
  let treeChanged = false;
  for (const node of catalog.tree.nodes) {
    if (hidden.has(node.sessionId)) {
      treeChanged = true;
      continue;
    }
    const childIds = node.childIds.filter((childId) => !hidden.has(childId));
    if (childIds.length === node.childIds.length) {
      nodes.push(node);
      continue;
    }
    treeChanged = true;
    nodes.push({ ...node, childIds });
  }
  const flatChanged = ids.length !== catalog.flat.ids.length;
  if (!treeChanged && !flatChanged) return catalog;
  // `entities` is deliberately carried over untouched.
  return {
    entities: catalog.entities,
    flat: flatChanged ? { ...catalog.flat, ids } : catalog.flat,
    tree: treeChanged ? { ...catalog.tree, nodes } : catalog.tree,
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
