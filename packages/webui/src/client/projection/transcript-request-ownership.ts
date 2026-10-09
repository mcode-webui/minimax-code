import type { WebuiClientMessagePage } from "../contracts/message-view.js";

function mergeQueryCollapseViews(
  current: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
  older: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
) {
  const byQueryKey = new Map(current.map((view) => [view.queryKey, view]));
  for (const view of older) byQueryKey.set(view.queryKey, view);
  return [...byQueryKey.values()];
}

export interface WebuiOwnedTranscriptState {
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly page: WebuiClientMessagePage;
  readonly loading: boolean;
  readonly error?: string;
}

export interface WebuiTranscriptRequestToken {
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly requestId: number;
}

export function createWebuiTranscriptRequestCoordinator(initialOwner: string) {
  let owner = { ownerSessionId: initialOwner, generation: 0 };
  let latestRequestId = 0;

  return {
    commitOwner(ownerSessionId: string): void {
      if (owner.ownerSessionId === ownerSessionId) return;
      owner = { ownerSessionId, generation: owner.generation + 1 };
      latestRequestId = 0;
    },
    getCommittedOwner() {
      return owner;
    },
    beginRequest(ownerSessionId: string): WebuiTranscriptRequestToken | undefined {
      if (owner.ownerSessionId !== ownerSessionId) return undefined;
      latestRequestId += 1;
      return { ...owner, requestId: latestRequestId };
    },
    isCurrent(token: WebuiTranscriptRequestToken): boolean {
      return owner.ownerSessionId === token.ownerSessionId &&
        owner.generation === token.generation &&
        latestRequestId === token.requestId;
    },
  };
}

export async function runWebuiTranscriptPageRequest<TPage>(
  coordinator: ReturnType<typeof createWebuiTranscriptRequestCoordinator>,
  token: WebuiTranscriptRequestToken,
  load: () => Promise<TPage>,
  stateCommit: (update: (state: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState) => void,
  onSuccess: (
    page: TPage,
    commit: (update: (state: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState) => boolean,
  ) => void,
  onError: (
    reason: unknown,
    commit: (update: (state: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState) => boolean,
  ) => void,
  onFinally: (
    commit: (update: (state: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState) => boolean,
  ) => void,
): Promise<void> {
  const commit = (
    update: (state: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState,
  ): boolean => {
    if (!coordinator.isCurrent(token)) return false;
    stateCommit((state) => updateOwnedTranscriptState(
      state,
      token.ownerSessionId,
      token.generation,
      update,
    ));
    return true;
  };
  try {
    const page = await load();
    if (coordinator.isCurrent(token)) onSuccess(page, commit);
  } catch (reason) {
    if (coordinator.isCurrent(token)) onError(reason, commit);
  } finally {
    if (coordinator.isCurrent(token)) onFinally(commit);
  }
}

export function getOwnedTranscriptPage(
  state: WebuiOwnedTranscriptState,
  sessionId: string,
): WebuiClientMessagePage | undefined {
  return state.ownerSessionId === sessionId ? state.page : undefined;
}

export function updateOwnedTranscriptState(
  current: WebuiOwnedTranscriptState,
  ownerSessionId: string,
  generation: number,
  update: (current: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState,
): WebuiOwnedTranscriptState {
  return current.ownerSessionId === ownerSessionId && current.generation === generation
    ? update(current)
    : current;
}

export function mergeOlderTranscriptPage(
  current: WebuiOwnedTranscriptState,
  olderPage: WebuiClientMessagePage,
  requestedCursor: string,
): { readonly state: WebuiOwnedTranscriptState; readonly error?: string } {
  if (
    (olderPage.messages?.length ?? 0) === 0 ||
    (olderPage.hasMore && olderPage.nextCursor === requestedCursor)
  ) {
    return {
      state: {
        ...current,
        page: { ...current.page, hasMore: false, nextCursor: undefined },
      },
      error: "没有找到更早的消息，请刷新会话后重试。",
    };
  }

  return {
    state: {
      ...current,
      page: {
        messages: [
          ...(olderPage.messages ?? []),
          ...(current.page.messages ?? []),
        ],
        queryCollapseViews: mergeQueryCollapseViews(
          current.page.queryCollapseViews ?? [],
          olderPage.queryCollapseViews ?? [],
        ),
        nextCursor: olderPage.nextCursor,
        hasMore: olderPage.hasMore,
      },
    },
  };
}
