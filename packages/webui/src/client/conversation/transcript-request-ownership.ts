// Transcript page merging.
//
// This module used to also carry a request-ownership coordinator: a generation
// plus request-id fence, a `runWebuiTranscriptPageRequest` wrapper that drove
// load/success/error/finally through it, and two state helpers. None of it had
// a production caller — `transcript-history.ts` owns request ownership for the
// live path and implements the same fence inline — so the only thing keeping
// the coordinator alive was the test that imported it. The behaviour it pinned
// is covered on the live seam instead (`webui-application-commands.test.ts`),
// and what remains here is the one function the application actually calls.
//
// `WebuiOwnedTranscriptState` stays because `mergeOlderTranscriptPage` takes it.

import type { WebuiClientMessagePage } from "../features/transcript/contracts/message-view.js";

function mergeQueryCollapseViews(
  current: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
  older: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
) {
  const byQueryKey = new Map(current.map((view) => [view.queryKey, view]));
  for (const view of older) byQueryKey.set(view.queryKey, view);
  return [...byQueryKey.values()];
}

function mergeHeadMessages(
  olderMessages: readonly NonNullable<WebuiClientMessagePage["messages"]>[number][],
  headMessages: readonly NonNullable<WebuiClientMessagePage["messages"]>[number][],
) {
  const merged = [...olderMessages];
  for (const message of headMessages) {
    const existing = merged.findIndex((candidate) => candidate.msgId === message.msgId);
    if (existing < 0) merged.push(message);
    else merged[existing] = message;
  }
  return merged;
}

function mergeQueryViews(
  older: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
  head: NonNullable<WebuiClientMessagePage["queryCollapseViews"]>,
) {
  const byQueryKey = new Map(older.map((view) => [view.queryKey, view]));
  for (const view of head) byQueryKey.set(view.queryKey, view);
  return [...byQueryKey.values()];
}

/** Keep loaded older pages while replacing the authoritative head page. */
export function mergeRefreshedTranscriptHead(
  current: WebuiClientMessagePage,
  previousHead: WebuiClientMessagePage | undefined,
  refreshedHead: WebuiClientMessagePage,
): WebuiClientMessagePage {
  if (!previousHead) return refreshedHead;
  const previousHeadIds = new Set((previousHead.messages ?? []).map(({ msgId }) => msgId));
  const olderMessages = (current.messages ?? []).filter(({ msgId }) => !previousHeadIds.has(msgId));
  const hasLoadedOlderMessages = olderMessages.length > 0;
  return {
    ...refreshedHead,
    messages: mergeHeadMessages(olderMessages, refreshedHead.messages ?? []),
    queryCollapseViews: mergeQueryViews(
      current.queryCollapseViews ?? [],
      refreshedHead.queryCollapseViews ?? [],
    ),
    ...(refreshedHead.contextSnapshot
      ? { contextSnapshot: refreshedHead.contextSnapshot }
      : current.contextSnapshot
        ? { contextSnapshot: current.contextSnapshot }
        : {}),
    ...(hasLoadedOlderMessages
      ? {
          nextCursor: current.nextCursor,
          hasMore: current.hasMore,
        }
      : {}),
  };
}

export interface WebuiOwnedTranscriptState {
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly page: WebuiClientMessagePage;
  readonly loading: boolean;
  readonly error?: string;
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
        // The page's context snapshot belongs to the SESSION, not to the page
        // of messages: it says how much of the context window the session has
        // spent, and it is the reading a reloaded session's ring is drawn from.
        // An older page carries no snapshot of its own, and dropping the
        // session's one while merging it in took the reading away from every
        // reader of the page — the composer's ring went blank the moment the
        // user scrolled up.
        ...(current.page.contextSnapshot
          ? { contextSnapshot: current.page.contextSnapshot }
          : {}),
      },
    },
  };
}
