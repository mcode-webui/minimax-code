// The transcript's view model: the transcript owns grouping and view projection.
//
// Everything here is a pure function of the page, the live stream and the stream
// phase. It used to be eleven `useMemo` blocks inside the component, which made
// the component's job — render — indistinguishable from the derivation it
// renders. The component now calls this once and destructures the result.
//
// Two of the derivations are subtle enough to keep their reasons in one place:
//
// - `liveGroupViews` projects each group's live view from that group's OWN
//   messages. A goal run injects a synthetic user continuation between model
//   calls, and a user item opens a new group, so one live turn can own several
//   assistant groups; broadcasting the turn-wide live view into every one of them
//   duplicated the streamed content across the transcript and stranded a second
//   activity pulse mid-thread.
// - `trailingLiveGroupId` decides which group owns the live activity row, so the
//   `推理中…` indicator renders exactly once and always trails the transcript.

import type { WebuiClientMessagePage } from "../contracts/message-view.js";
import { isTurnLive } from "../../turn/contracts/stream-state.js";
import { projectWebuiTranscriptMessage } from "./message-projection.js";
import {
  groupWebuiTranscriptItems,
  projectWebuiQueryDurations,
  projectWebuiTranscriptMessages,
} from "./transcript-projection.js";
import {
  projectHistoricalTurnView,
  projectLiveTurnView,
  type WebuiLiveTurnView,
  type WebuiTurnView,
} from "./transcript-shape.js";

type WebuiTranscriptStreamMessages = Parameters<typeof projectWebuiTranscriptMessages>[1];
type WebuiTranscriptStreamPhase = Parameters<typeof isTurnLive>[0];
type WebuiTranscriptMessageProjection = ReturnType<typeof projectWebuiTranscriptMessage>;
type WebuiTranscriptGroup = ReturnType<typeof groupWebuiTranscriptItems>[number];

/** One assistant turn as the right-rail navigator lists it. */
export interface WebuiTranscriptTurnRow {
  readonly id: string;
  readonly state: "active" | "running" | "default";
}

export interface WebuiTranscriptView {
  readonly messages: ReturnType<typeof projectWebuiTranscriptMessages>;
  readonly messageProjections: readonly WebuiTranscriptMessageProjection[];
  readonly items: WebuiTranscriptMessageProjection["items"];
  readonly turnViewsByMessageId: ReadonlyMap<string, WebuiTurnView>;
  readonly groups: readonly WebuiTranscriptGroup[];
  readonly liveAssistantMessages: WebuiTranscriptStreamMessages;
  readonly liveAssistantView: WebuiLiveTurnView | undefined;
  readonly liveGroupViews: ReadonlyMap<string, WebuiLiveTurnView> | undefined;
  readonly trailingLiveGroupId: string | undefined;
  readonly liveActivityGroupId: string | undefined;
  readonly liveActivityAtTranscriptLevel: boolean;
  readonly turns: readonly WebuiTranscriptTurnRow[];
  readonly showEmptyState: boolean;
}

export function projectWebuiTranscriptView(input: {
  readonly sessionId: string;
  readonly visiblePage: WebuiClientMessagePage;
  readonly streamMessages: WebuiTranscriptStreamMessages;
  readonly streamPhase: WebuiTranscriptStreamPhase;
  readonly processingStartedAtMs: number | undefined;
  /** Passed in rather than derived again, so the component's effects and this
   *  projection can never disagree about whether the turn is live. */
  readonly turnLive: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
}): WebuiTranscriptView {
  const { sessionId, visiblePage, streamMessages, streamPhase, processingStartedAtMs } = input;
  // History and stream frames feed one transcript projection. The live records
  // update the same message identities in this list while history supplies the
  // persisted fields and older messages.
  const messages = projectWebuiTranscriptMessages(
    visiblePage,
    streamMessages,
    streamPhase !== "done",
  );
  const messageProjections = messages.map((message) =>
    projectWebuiTranscriptMessage(message),
  );
  const items = messageProjections.flatMap((projection) => projection.items);
  // 每条消息使用统一视图；历史适配器提供持久化字段，实时适配器提供流式标记。
  const turnViewsByMessageId = new Map<string, WebuiTurnView>(
    messageProjections.map(({ message, items: projectedItems }) => [
      message.msgId,
      projectHistoricalTurnView(message, sessionId, projectedItems),
    ]),
  );
  // Group by message so one turn renders as one block: a process disclosure
  // carrying the thinking and the tool steps, then the assistant's markdown. A
  // user turn is its own block.
  const queryDurationByMessageId = projectWebuiQueryDurations(
    visiblePage.messages ?? [],
    visiblePage.queryCollapseViews ?? [],
  );
  const groups = groupWebuiTranscriptItems(items, queryDurationByMessageId);
  const liveAssistantMessages = streamMessages.filter(
    (message) => message.role !== "user",
  );
  const liveAssistantView = projectLiveTurnView(streamMessages, {
    sessionId,
    streaming: streamPhase === "streaming",
    processingStartedAtMs,
  });
  const liveGroupViews = projectLiveGroupViews({
    groups,
    streamMessages,
    sessionId,
    streamPhase,
    processingStartedAtMs,
    turnLive: input.turnLive,
  });
  const trailingLiveGroupId = projectTrailingLiveGroupId(groups, streamMessages);
  // The activity indicator falls back to transcript level when the last live
  // group is the goal continuation BUBBLE rather than an assistant group: no
  // message body is left to host the row, the previous round has settled, and the
  // next model call has not started thinking yet.
  const liveActivityGroupId =
    trailingLiveGroupId && liveGroupViews?.has(trailingLiveGroupId)
      ? trailingLiveGroupId
      : undefined;
  const turns = projectTurnRows(groups, streamPhase);
  const showEmptyState =
    !input.turnLive && !input.error && !input.loading && items.length === 0;
  return {
    messages,
    messageProjections,
    items,
    turnViewsByMessageId,
    groups,
    liveAssistantMessages,
    liveAssistantView,
    liveGroupViews,
    trailingLiveGroupId,
    liveActivityGroupId,
    liveActivityAtTranscriptLevel:
      trailingLiveGroupId !== undefined && liveActivityGroupId === undefined,
    turns,
    showEmptyState,
  };
}

function projectLiveGroupViews(input: {
  readonly groups: readonly WebuiTranscriptGroup[];
  readonly streamMessages: WebuiTranscriptStreamMessages;
  readonly sessionId: string;
  readonly streamPhase: WebuiTranscriptStreamPhase;
  readonly processingStartedAtMs: number | undefined;
  readonly turnLive: boolean;
}): ReadonlyMap<string, WebuiLiveTurnView> | undefined {
  if (!input.turnLive) return undefined;
  const views = new Map<string, WebuiLiveTurnView>();
  for (const group of input.groups) {
    const owned = new Set(group.items.map((item) => item.messageId));
    const own = input.streamMessages.filter((message) => owned.has(message.id));
    if (own.length === 0) continue;
    const view = projectLiveTurnView(own, {
      sessionId: input.sessionId,
      streaming: input.streamPhase === "streaming",
      processingStartedAtMs: input.processingStartedAtMs,
    });
    if (view) views.set(group.messageId, view);
  }
  return views.size > 0 ? views : undefined;
}

function projectTrailingLiveGroupId(
  groups: readonly WebuiTranscriptGroup[],
  streamMessages: WebuiTranscriptStreamMessages,
): string | undefined {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    const owned = new Set(group.items.map((item) => item.messageId));
    if (streamMessages.some((message) => owned.has(message.id))) {
      return group.messageId;
    }
  }
  return undefined;
}

/** The navigator's tick list: one row per assistant block. A user turn is not a
 *  tick — only the assistant block that follows it counts. The first row is
 *  `active` while nothing has settled; the last is `running` while streaming. */
function projectTurnRows(
  groups: readonly WebuiTranscriptGroup[],
  streamPhase: WebuiTranscriptStreamPhase,
): readonly WebuiTranscriptTurnRow[] {
  const assistantGroups = groups.filter((group) =>
    group.items.some((item) => item.kind === "assistant"),
  );
  if (assistantGroups.length === 0) return [];
  const lastIndex = assistantGroups.length - 1;
  return assistantGroups.map((group, index) => ({
    id: group.messageId,
    state:
      index === lastIndex && streamPhase === "streaming"
        ? "running"
        : index === 0
          ? "active"
          : "default",
  }));
}
