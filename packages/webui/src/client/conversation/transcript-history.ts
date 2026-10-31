// Transcript history request ownership.
//
// This used to be a singleton: one `selectedSessionId`, one `generation` and one
// `requestId` for the whole owner. Two problems followed from that. A page
// request for one session fenced a page request for another, and a head-page
// request and an older-page request for the same session shared one identity, so
// a pagination anchor and a stream-recovery read were conflated.
//
// There are now two identities, and they are the two contracts of
// `request-freshness`:
//
// - a **keyed resource** per `(sessionId, anchor)`, where the anchor is the page
//   cursor or `head`. Each key carries its own request generation, so a newer
//   request supersedes only its own key's earlier answer;
// - a **selected-view slot** for presentation. Selecting another session
//   invalidates the token captured for the session that left, so its late answer
//   is refused — the promise the old singleton made, kept separate from the
//   per-page identity instead of entangled with it.

import type {
  WebuiClientMessageLoader,
  WebuiClientMessagePage,
} from "../features/transcript/contracts/message-view.js";
import {
  createWebuiKeyedResource,
  createWebuiSelectedSlot,
  type WebuiCommitToken,
} from "./request-freshness.js";
import {
  mergeOlderTranscriptPage,
  mergeRefreshedTranscriptHead,
} from "./transcript-request-ownership.js";

/**
 * The slice this owner writes, as a contract the assembly satisfies.
 *
 * The conversation substrate may not reach the session-record repository — it
 * depends on pure shared DTOs and injected IO/writer contracts — so what it
 * needs is stated here and the application adapts its store to it.
 */
export interface WebuiTranscriptHistoryWriter {
  readonly updateTranscript: (
    sessionId: string,
    update: (current: WebuiTranscriptRecord) => WebuiTranscriptRecord,
  ) => void;
}

/** The transcript slice of one session's record, as this owner reads it. */
export interface WebuiTranscriptRecord {
  readonly page: WebuiClientMessagePage;
  readonly generation: number;
  readonly loading: boolean;
  readonly error?: string;
}

/** A failure's message, for the transcript's own error field. */
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The page a load produced, and the identity a later check is made against. */
export interface WebuiTranscriptPageHandle {
  readonly sessionId: string;
  /** Absent for the head page. */
  readonly cursor?: string;
  readonly token: WebuiCommitToken;
}

export interface WebuiTranscriptHistoryOwner {
  readonly selectSession: (sessionId: string | undefined) => void;
  readonly seed: (sessionId: string, page: WebuiClientMessagePage) => void;
  /**
   * Reads the head page, joining a read already in flight for that key.
   *
   * Opening a session view is the caller: two readers wanting the same page at
   * once (the transcript and a context inspection) share one request rather than
   * one superseding the other.
   */
  readonly loadPage: (sessionId: string) => Promise<WebuiTranscriptLoadOutcome>;
  /**
   * Reads the head page as it is NOW: freshness advances first, so an answer
   * already in flight cannot land. A turn settling is the caller — the page it
   * held was written before the turn's messages were persisted.
   */
  readonly refreshPage: (sessionId: string) => Promise<WebuiTranscriptLoadOutcome>;
  /**
   * Discards every cached page for a session, then replaces its head page.
   * History mutations that can remove messages (rewind/edit) must not merge
   * rows from the old projection back into the authoritative result.
   */
  readonly replacePage: (sessionId: string) => Promise<WebuiTranscriptLoadOutcome>;
  readonly loadOlder: (
    sessionId: string,
    cursor: string,
  ) => Promise<WebuiTranscriptLoadOutcome>;
  /** Whether the page a load produced is still the one its key holds. */
  readonly isCurrentPage: (handle: WebuiTranscriptPageHandle) => boolean;
  /**
   * The head page for a session, from this owner's keyed resource: a cached answer
   * is returned as it is, and otherwise one read is issued (or joined, when the
   * transcript is already reading the same key).
   *
   * This is the seam a *context-only* inspection uses. It exists so the composer
   * reads the transcript's page instead of issuing its own `getMessages` for the
   * same session, which used to cost a second page read on every switch.
   */
  readonly ensurePage: (sessionId: string) => Promise<WebuiClientMessagePage | undefined>;
  readonly releaseSession: (sessionId: string) => void;
  /**
   * Fence the owner: no later page read commits, and the presentation slot stops
   * accepting a page for a session nothing presents. The assembly calls this on
   * teardown; a view never does.
   */
  readonly dispose: () => void;
}

export type WebuiTranscriptLoadOutcome =
  | { readonly status: "applied"; readonly page: WebuiTranscriptPageHandle }
  | { readonly status: "stale" }
  | { readonly status: "failed" };

/** Owns transcript history RPCs and commits their results into the one session map. */
export function createWebuiTranscriptHistoryOwner(deps: {
  readonly transcript: WebuiTranscriptHistoryWriter;
  readonly loadMessages?: WebuiClientMessageLoader;
}): WebuiTranscriptHistoryOwner {
  const pages = createWebuiKeyedResource<WebuiClientMessagePage>();
  const presentation = createWebuiSelectedSlot<{ readonly sessionId: string }>();
  const incarnation = pages.capture({ sessionId: "", anchor: "head" }).incarnation;
  pages.release({ sessionId: "", anchor: "head" });
  const asked = new Map<string, Map<string, { sessionId: string; anchor: string }>>();
  const headPages = new Map<string, WebuiClientMessagePage>();
  const releasedSessions = new Set<string>();

  const keyOf = (sessionId: string, cursor: string | undefined) => ({
    sessionId,
    anchor: cursor ?? "head",
  });
  const remember = (sessionId: string, cursor: string | undefined) => {
    const key = keyOf(sessionId, cursor);
    const keys = asked.get(sessionId) ?? new Map<string, typeof key>();
    keys.set(key.anchor, key);
    asked.set(sessionId, keys);
    return key;
  };

  const selectSession = (sessionId: string | undefined): void => {
    if (presentation.identity() === sessionId) return;
    presentation.select(sessionId);
    if (sessionId)
      deps.transcript.updateTranscript(sessionId, (current) => ({
        ...current,
        generation: current.generation + 1,
        loading: !current.page.messages,
      }));
  };

  const seed = (sessionId: string, page: WebuiClientMessagePage): void => {
    let seeded = false;
    deps.transcript.updateTranscript(sessionId, (current) => {
      if (current.page.messages) return current;
      seeded = true;
      return { ...current, page, loading: false };
    });
    if (seeded) headPages.set(sessionId, page);
  };

  /**
   * One page read for one key.
   *
   * `join` goes through the resource's own read, so two readers asking for the
   * same key share one request — the context inspection and the transcript do
   * exactly that when a session view opens. `fresh` advances the key's freshness
   * first, which is what a caller wants when the answer may have changed under it
   * (a turn just settled, a mutation landed): the read already in flight can no
   * longer commit and a new one starts.
   */
  const load = async (
    sessionId: string,
    cursor: string | undefined,
    mode: "join" | "fresh",
  ): Promise<WebuiTranscriptLoadOutcome> => {
    if (releasedSessions.has(sessionId)) return { status: "stale" };
    if (!deps.loadMessages) return { status: "failed" };
    if (presentation.identity() !== sessionId) selectSession(sessionId);
    const key = remember(sessionId, cursor);
    if (mode === "fresh") pages.invalidate(key);
    // Captured before the read: refused if the presentation has moved on.
    const presentationToken = presentation.capture();
    deps.transcript.updateTranscript(sessionId, (state) => ({
      ...state,
      loading: true,
      error: undefined,
    }));
    const loadMessages = deps.loadMessages;
    // What THIS request produced, told by the resource rather than reconstructed
    // by re-reading the shared entry: a superseded or disposed read says so, and
    // a joining read receives the joined request's own outcome.
    const outcome = await pages.load(key, () =>
      loadMessages({
        id: sessionId,
        ...(cursor ? { before: cursor } : {}),
      }),
    );
    if (outcome.status === "superseded" || outcome.status === "disposed") {
      return { status: "stale" };
    }
    if (outcome.status === "failed") {
      deps.transcript.updateTranscript(sessionId, (state) => ({
        ...state,
        error: message(outcome.error),
        loading: false,
      }));
      return { status: "failed" };
    }
    const page = outcome.value;
    // The presentation fence: a page that arrived for a session the view has
    // left is not written, so the store never gains a page nothing presented.
    if (
      !presentation.commit(presentationToken, {
        status: "ready",
        value: { sessionId },
      })
    ) {
      return { status: "stale" };
    }
    let updatedHead = false;
    deps.transcript.updateTranscript(sessionId, (state) => {
      if (!cursor) {
        updatedHead = true;
        return {
          ...state,
          page: mergeRefreshedTranscriptHead(
            state.page,
            headPages.get(sessionId),
            page,
          ),
          loading: false,
        };
      }
      const olderResult = mergeOlderTranscriptPage(
        {
          ownerSessionId: sessionId,
          generation: state.generation,
          page: state.page,
          loading: false,
        },
        page,
        cursor,
      );
      return {
        ...state,
        page: olderResult.state.page,
        loading: false,
        ...(olderResult.error ? { error: olderResult.error } : {}),
      };
    });
    if (updatedHead) headPages.set(sessionId, page);
    return {
      status: "applied",
      // The token the resource returned with its own answer: the identity that
      // committed is the one a later check is made against, so a re-read is not
      // needed to learn whether this page is still current.
      page: {
        sessionId,
        ...(cursor ? { cursor } : {}),
        token: outcome.token,
      },
    };
  };

  const ensurePage = async (
    sessionId: string,
  ): Promise<WebuiClientMessagePage | undefined> => {
    if (releasedSessions.has(sessionId)) return undefined;
    const key = remember(sessionId, undefined);
    const cached = pages.read(key);
    if (cached?.status === "ready") return cached.value;
    if (!deps.loadMessages) return undefined;
    const loadMessages = deps.loadMessages;
    const outcome = await pages.load(key, () => loadMessages({ id: sessionId }));
    // A read that did not commit produced nothing to show. Only `ready` carries
    // a value, so the entry does not have to be re-read to find out.
    return outcome.status === "ready" ? outcome.value : undefined;
  };

  return {
    selectSession,
    seed,
    ensurePage,
    releaseSession: (sessionId) => {
      for (const key of asked.get(sessionId)?.values() ?? []) pages.release(key);
      asked.delete(sessionId);
      headPages.delete(sessionId);
      // Authoritative deletions are replay-unsafe; retain only this compact
      // fence until application disposal, never the session's cached pages.
      releasedSessions.add(sessionId);
      if (presentation.identity() === sessionId) presentation.select(undefined);
    },
    loadPage: (sessionId) => load(sessionId, undefined, "join"),
    refreshPage: (sessionId) => load(sessionId, undefined, "fresh"),
    replacePage: (sessionId) => {
      for (const key of asked.get(sessionId)?.values() ?? []) pages.invalidate(key);
      asked.delete(sessionId);
      headPages.delete(sessionId);
      return presentation.identity() === sessionId
        ? load(sessionId, undefined, "fresh")
        : Promise.resolve({ status: "stale" });
    },
    loadOlder: (sessionId, cursor) => load(sessionId, cursor, "fresh"),
    isCurrentPage: (handle) =>
      !pages.isDisposed() &&
      handle.token.incarnation === incarnation &&
      pages.revision(keyOf(handle.sessionId, handle.cursor)) ===
        handle.token.revision,
    dispose: () => {
      pages.dispose();
      presentation.dispose();
      asked.clear();
      headPages.clear();
      releasedSessions.clear();
    },
  };
}
