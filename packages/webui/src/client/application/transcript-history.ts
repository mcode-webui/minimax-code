import type {
  WebuiClientMessageLoader,
  WebuiClientMessagePage,
} from "../contracts/message-view.js";
import type { WebuiSessionStore } from "./session-store.js";
import { mergeOlderTranscriptPage } from "./transcript-request-ownership.js";

export interface WebuiTranscriptHistoryOwner {
  readonly selectSession: (sessionId: string | undefined) => void;
  readonly seed: (sessionId: string, page: WebuiClientMessagePage) => void;
  readonly loadPage: (sessionId: string) => Promise<void>;
  readonly loadOlder: (sessionId: string, cursor: string) => Promise<void>;
}

/** Owns transcript history RPCs and commits their results into the one session map. */
export function createWebuiTranscriptHistoryOwner(deps: {
  readonly store: WebuiSessionStore;
  readonly loadMessages?: WebuiClientMessageLoader;
}): WebuiTranscriptHistoryOwner {
  let selectedSessionId: string | undefined;
  let generation = 0;
  let requestId = 0;
  const selectSession = (sessionId: string | undefined): void => {
    if (selectedSessionId === sessionId) return;
    selectedSessionId = sessionId;
    generation += 1;
    requestId += 1;
    if (sessionId)
      deps.store.updateSession(sessionId, (current) => ({
        ...current,
        transcript: {
          ...current.transcript,
          generation,
          loading: !current.transcript.page.messages,
        },
      }));
  };
  const seed = (sessionId: string, page: WebuiClientMessagePage): void => {
    deps.store.updateSession(sessionId, (current) =>
      current.transcript.page.messages
        ? current
        : {
            ...current,
            transcript: { ...current.transcript, page, loading: false },
          },
    );
  };
  const load = async (sessionId: string, before?: string): Promise<void> => {
    if (!deps.loadMessages) return;
    if (selectedSessionId !== sessionId) selectSession(sessionId);
    const ownGeneration = generation;
    const ownRequest = ++requestId;
    deps.store.updateSession(sessionId, (state) => ({
      ...state,
      transcript: { ...state.transcript, loading: true, error: undefined },
    }));
    const isCurrent = (): boolean =>
      selectedSessionId === sessionId &&
      generation === ownGeneration &&
      requestId === ownRequest;
    try {
      const page = await deps.loadMessages({
        id: sessionId,
        ...(before ? { before } : {}),
      });
      if (!isCurrent()) return;
      deps.store.updateSession(sessionId, (state) => {
        const current = state.transcript;
        const olderResult = before
          ? mergeOlderTranscriptPage(
              {
                ownerSessionId: sessionId,
                generation: ownGeneration,
                page: current.page,
                loading: false,
              },
              page,
              before,
            )
          : undefined;
        return {
          ...state,
          transcript: {
            ...state.transcript,
            page: olderResult?.state.page ?? page,
            loading: false,
            ...(olderResult?.error ? { error: olderResult.error } : {}),
          },
        };
      });
    } catch (reason) {
      if (!isCurrent()) return;
      deps.store.updateSession(sessionId, (state) => ({
        ...state,
        transcript: {
          ...state.transcript,
          error: reason instanceof Error ? reason.message : String(reason),
          loading: false,
        },
      }));
    }
  };
  return {
    selectSession,
    seed,
    loadPage: (sessionId) => load(sessionId),
    loadOlder: (sessionId, cursor) => load(sessionId, cursor),
  };
}
