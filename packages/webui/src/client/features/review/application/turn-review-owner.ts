// The turn-review owner.
//
// One owner for a turn's diff: the query, the revert/reapply mutations and the
// freshness of both. It used to be the diff card's own: the component held the
// state machine, issued `getTurnDiff` itself, and decided the mutation request —
// so a second surface wanting the same turn could only duplicate it, and the
// card's unmount took the answer with it.
//
// The identity is the turn-review key (session + turn/changeset), and the
// answer lives under it in a keyed resource: two readers of one turn share the
// read, a newer read for one key supersedes only that key's earlier answer, and a
// mutation that took effect is announced so the workspace review family can be
// invalidated as part of its settlement.

import {
  createWebuiKeyedResource,
  serializeWebuiResourceKey,
  type WebuiCommitToken,
} from "../../../conversation/request-freshness.js";
import {
  buildWebuiDiffMutationRequest,
  initialWebuiDiffState,
  reduceWebuiDiffState,
  resolveWebuiDiffMutation,
} from "../projection/review-state.js";
import type { WebuiDiffState } from "../contracts/review-view.js";
import type {
  WebuiTurnReviewKey,
  WebuiTurnReviewMutation,
  WebuiTurnReviewOutcome,
  WebuiTurnReviewPort,
} from "../contracts/turn-review.js";

export interface WebuiTurnReviewOwner {
  /** The state for one key, or the initial state when nothing was read for it. */
  readonly read: (key: WebuiTurnReviewKey) => WebuiDiffState;
  /** Reads the turn's diff, joining a read already in flight for that key. */
  readonly load: (key: WebuiTurnReviewKey) => Promise<WebuiTurnReviewOutcome>;
  /** Reverts or reapplies, and reports what the runtime said. */
  readonly mutate: (
    key: WebuiTurnReviewKey,
    action: "revert" | "reapply",
  ) => Promise<WebuiTurnReviewOutcome>;
  readonly invalidate: (key: WebuiTurnReviewKey) => void;
  /** Clears the last refusal. The error is the mutation's, so it is cleared where
   *  it was recorded; the card's dismiss button calls this. */
  readonly dismissError: (key: WebuiTurnReviewKey) => void;
  /**
   * Whether the runtime offers turn diffs at all. The card learns this from an
   * `unsupported` outcome; a surface that must decide *before* reading (the
   * activity group, which otherwise infers success from edit-tool output) asks
   * here instead of holding a copy of the capability.
   */
  /**
   * Release one session's turn diffs.
   *
   * The turn is the session's, so a session that is gone cannot have a diff any
   * surface should still be reading: the session is fenced and its cached states
   * are dropped. A later read for it refuses rather than re-asking a runtime for
   * a turn that no longer exists.
   */
  readonly releaseSession: (sessionId: string) => void;
  readonly supportsQueries: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Fence the owner: a diff read that lands after teardown cannot commit or
   * notify, and no later mutation announcement reaches a listener. The assembly
   * owns this owner's life; a card never ends it.
   */
  readonly dispose: () => void;
  /**
   * Settled mutations, for the families they affect. The workspace review
   * family is the caller's — a mutation commits once, then invokes the affected
   * owners' explicit invalidation commands — so this owner announces rather
   * than reaches into it.
   */
  readonly subscribeMutations: (listener: (mutation: WebuiTurnReviewMutation) => void) => () => void;
}

/** The resource key: the query request's identity, serialized by the primitive. */
function resourceKey(key: WebuiTurnReviewKey) {
  return {
    sessionId: key.sessionId,
    turn: key.turnId ?? key.assistantMessageId ?? "",
    changeSetId: key.changeSetId ?? "",
  };
}

/** The query request the port takes, rebuilt from the key. */
function queryRequest(key: WebuiTurnReviewKey) {
  // These selectors are alternatives, not cumulative filters. The runtime
  // resolves changeSetId first, then assistantMessageId, then turnId; sending
  // the transcript group's first assistant message alongside its turnId can
  // therefore select a different (often empty) diff. Keep the most specific
  // available identity and only fall back when it is absent.
  return {
    id: key.sessionId,
    ...(key.changeSetId
      ? { changeSetId: key.changeSetId }
      : key.turnId
        ? { turnId: key.turnId }
        : key.assistantMessageId
          ? { assistantMessageId: key.assistantMessageId }
          : {}),
  };
}

export function createWebuiTurnReviewOwner(deps: {
  readonly port: WebuiTurnReviewPort;
}): WebuiTurnReviewOwner {
  const pages = createWebuiKeyedResource<WebuiDiffState>();
  const listeners = new Set<() => void>();
  const mutationListeners = new Set<(mutation: WebuiTurnReviewMutation) => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const announce = (mutation: WebuiTurnReviewMutation): void => {
    for (const listener of [...mutationListeners]) listener(mutation);
  };
  const read = (key: WebuiTurnReviewKey): WebuiDiffState =>
    pages.read(resourceKey(key))?.value ?? initialWebuiDiffState;
  const write = (key: WebuiTurnReviewKey, token: WebuiCommitToken, state: WebuiDiffState): boolean => {
    const landed = pages.commit(token, { status: "ready", value: state });
    if (landed) notify();
    return landed;
  };

  /** Sessions this owner has released; a released session is never re-asked. */
  const releasedSessions = new Set<string>();
  /**
   * The keys this owner has asked about.
   *
   * Tracked because a release has to supersede exactly one session's in-flight and
   * cached answers, and the resource keys are opaque strings by the time the
   * primitive holds them. The owner knows which session each key names, so it
   * keeps that mapping rather than asking the primitive to decode its own keys.
   */
  const askedKeys = new Map<string, WebuiTurnReviewKey>();
  const recordAsked = (key: WebuiTurnReviewKey): void => {
    askedKeys.set(serializeWebuiResourceKey(resourceKey(key)), key);
  };

  const releaseSession = (sessionId: string): void => {
    if (releasedSessions.has(sessionId)) return;
    for (const [serialized, key] of [...askedKeys]) {
      if (key.sessionId !== sessionId) continue;
      pages.release(resourceKey(key));
      askedKeys.delete(serialized);
    }
    releasedSessions.add(sessionId);
    notify();
  };

  const load = async (key: WebuiTurnReviewKey): Promise<WebuiTurnReviewOutcome> => {
    // A released session is not re-asked: the runtime no longer has the session,
    // so a read would be a request whose answer nothing may show.
    if (releasedSessions.has(key.sessionId)) return { status: "stale" };
    recordAsked(key);
    const resource = resourceKey(key);
    const getTurnDiff = deps.port.getTurnDiff;
    if (!getTurnDiff) {
      write(key, pages.capture(resource), reduceWebuiDiffState(read(key), { type: "unsupported" }));
      return { status: "unsupported" };
    }
    // Joining is the point: two surfaces opening the same turn share one request.
    const outcome = await pages.load(resource, async () => {
      const view = await getTurnDiff(queryRequest(key));
      return reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view });
    });
    // The resource reports what this request produced, so the owner no longer
    // re-reads the shared entry to guess whether its answer is the current one. A
    // read the resource refused — superseded, disposed or failed — belongs to
    // nobody and is reported as stale rather than claiming whatever answer is
    // current; the failure itself stays visible as the entry's error state.
    if (outcome.status !== "ready") return { status: "stale" };
    notify();
    return { status: "applied" };
  };

  const mutate = async (
    key: WebuiTurnReviewKey,
    action: "revert" | "reapply",
  ): Promise<WebuiTurnReviewOutcome> => {
    // Same fence as a read: reverting a deleted session's turn would be a
    // mutation aimed at something the runtime no longer has.
    if (releasedSessions.has(key.sessionId)) return { status: "stale" };
    const resource = resourceKey(key);
    const handler =
      action === "revert" ? deps.port.revertTurnDiff : deps.port.reapplyTurnDiff;
    const current = read(key);
    const request = buildWebuiDiffMutationRequest(current, queryRequest(key), action);
    if (!request || !handler) {
      write(key, pages.capture(resource), reduceWebuiDiffState(current, { type: "unsupported" }));
      return { status: "unsupported" };
    }
    const token = pages.capture(resource);
    write(key, token, reduceWebuiDiffState(current, { type: "begin-mutation" }));
    let next: WebuiDiffState;
    try {
      const result = await handler(request);
      next = reduceWebuiDiffState(read(key), resolveWebuiDiffMutation(action, result));
    } catch (thrown) {
      next = reduceWebuiDiffState(read(key), resolveWebuiDiffMutation(action, undefined, thrown));
    }
    if (!write(key, token, next)) return { status: "stale" };
    if (next.mutationError) return { status: "failed", reason: next.mutationError };
    // Settled: the workspace review family reads a working tree this mutation
    // just changed.
    announce({ sessionId: key.sessionId, action });
    return { status: "applied" };
  };

  return {
    read,
    load,
    mutate,
    dismissError: (key) => {
      write(
        key,
        pages.capture(resourceKey(key)),
        reduceWebuiDiffState(read(key), { type: "dismiss-mutation-error" }),
      );
    },
    invalidate: (key) => {
      pages.invalidate(resourceKey(key));
      notify();
    },
    releaseSession,
    supportsQueries: () => deps.port.getTurnDiff !== undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeMutations: (listener) => {
      mutationListeners.add(listener);
      return () => mutationListeners.delete(listener);
    },
    dispose: () => {
      pages.dispose();
      listeners.clear();
      mutationListeners.clear();
    },
  };
}
