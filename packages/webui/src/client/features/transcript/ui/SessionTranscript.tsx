// SessionTranscript — the per-session message log: groups, projectWebuiMessage
// flattening, history paging, streaming loader, and the embedded
// WebuiQuestionnaireResponse renderer for historical questionnaire answers.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { IconChevronUp } from "@tabler/icons-react";
import { ChatSkeleton } from "./TranscriptSkeletons.js";
import { ActivityIndicator, MessageAfterQueryStreamingPlaceholder, MessagePassiveLoadingPlaceholder } from "./ActivityIndicator.js";
import { TurnNavigator, type TurnNavigatorPreview, type TurnSummary } from "./TurnNavigator.js";
import { MessageItem } from "./MessageItem.js";
import { formatWebuiMessageTimestamp } from "../projection/message-timestamp.js";
import type { WebuiMessageActionCapabilities } from "../contracts/transcript-view.js";
import { useWebuiSessionQuestionnaire, useWebuiSessionState, useWebuiSessionStream, useWebuiTranscriptHistoryOwner } from "../../../bindings/use-session-state.js";
import { isTurnLive } from "../../turn/contracts/stream-state.js";
import { isWebuiPlanReviewRequest } from "../../interactions/contracts/plan-mode.js";
import { WebuiTranscriptPlanDelivery } from "./PlanDelivery.js";
import { WebuiQuestionnaireResponse } from "./QuestionnaireResponse.js";
import type { WebuiClientMessagePage } from "../contracts/message-view.js";
import type { WebuiTranscriptItem } from "../contracts/transcript-view.js";
import type { WebuiTranscriptCommands } from "../contracts/session-read-port.js";
import type { WebuiQuestionnaireRequest } from "../../../../shared/contracts/interactions.js";

import type { WebuiTurnDiffView } from "../../../../shared/contracts/session.js";
import type { WebuiQuestionnaireResponseSummary } from "../contracts/transcript-view.js";
import type { WebuiMessageFileReference } from "../projection/message-file-reference.js";
import type { WorkspacePanelCommand } from "../../workspace/contracts/panel-command.js";
import {
  groupWebuiTranscriptItems,
  projectWebuiTranscriptMessages,
  projectWebuiQueryDurations,
  projectWebuiProcessSegments,
  type WebuiTranscriptGroup,
} from "../projection/transcript-projection.js";
import { projectWebuiTranscriptMessage } from "../projection/message-projection.js";
import { projectWebuiTranscriptView } from "../projection/transcript-view-model.js";
import {
  projectHistoricalTurnView,
  projectLiveTurnView,
  type WebuiLiveTurnView,
  type WebuiTurnView,
} from "../projection/transcript-shape.js";
import {
  transcriptViewport,
  useWebuiTranscriptScroll,
} from "../bindings/use-transcript-scroll.js";

const EMPTY_TRANSCRIPT_PAGE: WebuiClientMessagePage = {};

// --- TurnNavigator integration ------------------------------------------------
//
// `TurnNavigator` is the presentational seam and defers hover, scroll and jump
// to this integrator. The helpers below are that integration's pure halves,
// exported so the node-environment suite can assert them without a DOM: which
// message a tick anchors to, what one turn's hover preview shows, and what a
// reveal does to its target. The mouse wiring itself (setState on hover,
// querySelector on activate) stays in the component and is the boundary SSR
// cannot reach.

/** Every rendered message root carries `data-message-id` (MessageItem), so a
 *  tick reuses that attribute as its anchor instead of a second anchor
 *  system. Quotes and backslashes are escaped so a message id cannot close
 *  the attribute selector. */
export function turnNavigatorAnchorSelector(turnId: string): string {
  return `[data-message-id="${turnId.replace(/["\\]/g, "\\$&")}"]`;
}

export const TURN_NAVIGATOR_FLASH_CLASS = "webui-turn-jump-flash";
const TURN_NAVIGATOR_FLASH_MS = 1200;

export interface WebuiTurnRevealTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  readonly classList: { add(token: string): void; remove(token: string): void };
}

/** Reveal one turn after a tick activation: center it in the transcript
 *  viewport and flash it so the destination is findable. The class is removed
 *  after `flashMs` so the highlight stays transient. */
export function revealTurnNavigatorAnchor(
  target: WebuiTurnRevealTarget,
  flashMs = TURN_NAVIGATOR_FLASH_MS,
): void {
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add(TURN_NAVIGATOR_FLASH_CLASS);
  setTimeout(() => target.classList.remove(TURN_NAVIGATOR_FLASH_CLASS), flashMs);
}

const TURN_NAVIGATOR_RESPONSE_MAX_CHARS = 120;

/** The preview's one-line answer summary: the first non-empty line, capped. */
function firstTurnSummaryLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > TURN_NAVIGATOR_RESPONSE_MAX_CHARS
    ? `${line.slice(0, TURN_NAVIGATOR_RESPONSE_MAX_CHARS - 1)}…`
    : line;
}

function hasAssistantItems(group: WebuiTranscriptGroup): boolean {
  return group.items.some((item) => item.kind === "assistant");
}

function turnUserQuery(
  groups: readonly WebuiTranscriptGroup[],
  fromIndex: number,
  step: 1 | -1,
): string | undefined {
  for (let index = fromIndex; index >= 0 && index < groups.length; index += step) {
    const userItem = groups[index]?.items.find(
      (item): item is Extract<WebuiTranscriptItem, { text: string }> => item.kind === "user",
    );
    if (userItem) return userItem.text;
  }
  return undefined;
}

/** The hover preview for one tick: the turn's 1-based number among the
 *  assistant blocks the strip lists, its first answer line as the summary, the
 *  group's own timestamp, framed by the user queries on both sides. Returns
 *  null when the id is not one of the assistant turns the strip lists — the
 *  numbering and membership mirror `projectTurnRows`. */
export function projectTurnNavigatorPreview(input: {
  readonly turnId: string;
  readonly groups: readonly WebuiTranscriptGroup[];
}): TurnNavigatorPreview | null {
  const assistantGroups = input.groups.filter(hasAssistantItems);
  const tickIndex = assistantGroups.findIndex((group) => group.messageId === input.turnId);
  if (tickIndex < 0) return null;
  const group = assistantGroups[tickIndex]!;
  const groupIndex = input.groups.indexOf(group);
  const answer = group.items.find(
    (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
      item.kind === "assistant" && item.text.trim().length > 0,
  );
  const time = formatWebuiMessageTimestamp(
    group.items.find((item) => typeof item.timestamp === "number")?.timestamp,
  );
  const previousQuery = groupIndex > 0 ? turnUserQuery(input.groups, groupIndex - 1, -1) : undefined;
  const nextQuery =
    groupIndex >= 0 && groupIndex < input.groups.length - 1
      ? turnUserQuery(input.groups, groupIndex + 1, 1)
      : undefined;
  return {
    title: `第 ${tickIndex + 1} 轮`,
    ...(time ? { time } : {}),
    ...(previousQuery ? { previousQuery } : {}),
    ...(nextQuery ? { nextQuery } : {}),
    ...(answer ? { response: firstTurnSummaryLine(answer.text) } : {}),
  };
}

export function WebuiSessionTranscript({
  sessionId,
  initialMessages,
  transcriptCommands,
  answerPlanBuild,
  workspaceDir,
  onOpenFile,
  onOpenTurnReview,
  onOpenPlanFile,
}: {
  readonly sessionId: string;
  readonly initialMessages?: WebuiClientMessagePage;
  readonly workspaceDir?: string;
  readonly onOpenFile?: (input: { readonly sessionId: string; readonly workspaceDir: string; readonly reference: WebuiMessageFileReference }) => void;
  readonly onOpenTurnReview?: (command: Extract<WorkspacePanelCommand, { type: "open-turn-review" }>) => void;
  readonly onOpenPlanFile?: (input: { readonly sessionId: string; readonly path: string; readonly content: string }) => void;
  readonly answerPlanBuild?: (request: WebuiQuestionnaireRequest) => Promise<void>;
  readonly transcriptCommands?: WebuiTranscriptCommands;
}): ReactElement {
  const historyOwner = useWebuiTranscriptHistoryOwner();
  const transcriptState = useWebuiSessionState(sessionId).transcript;
  const hasCanonicalPage = transcriptState.page.messages !== undefined;
  const visiblePage = hasCanonicalPage
    ? transcriptState.page
    : initialMessages ?? transcriptState.page ?? EMPTY_TRANSCRIPT_PAGE;
  const loading = hasCanonicalPage
    ? transcriptState.loading
    : initialMessages
      ? false
      : transcriptState.loading;
  const error = transcriptState.error;
  const transcriptRef = useRef<HTMLElement | null>(null);
  const stream = useWebuiSessionStream(sessionId);
  const streamPhase = stream.phase;
  // The plan file is a MESSAGE in the transcript, not a floating card: the
  // it is rendered as the footer of the turn that wrote the plan. It lives
  // on the pending questionnaire, so the transcript reads the same channel the
  // composer does and anchors the card to `request.tool.messageId`.
  //
  // The composer keeps its own copy for the decision; this read only decides
  // whether a plan card belongs in the message column.
  const pendingQuestionnaire = useWebuiSessionQuestionnaire(sessionId);
  const planReview = isWebuiPlanReviewRequest(pendingQuestionnaire)
    ? pendingQuestionnaire
    : undefined;
  // The card is a MESSAGE in the transcript, not a floating card: it anchors to
  // the turn that wrote the plan.
  const planAnchorMessageId = planReview?.tool?.messageId;
  // History and stream frames feed one transcript projection. The live
  // records update the same message identities in this list while history
  // supplies the persisted fields and older messages.
  const turnLive = isTurnLive(streamPhase);
  const previousTurnStateRef = useRef({ sessionId, turnLive });
  useEffect(() => {
    if (initialMessages) historyOwner?.seed(sessionId, initialMessages);
    void historyOwner?.loadPage(sessionId);
  }, [historyOwner, initialMessages, sessionId]);
  useEffect(() => {
    const previous = previousTurnStateRef.current;
    previousTurnStateRef.current = { sessionId, turnLive };
    // 加载历史页只处理会话内的 live → idle 转换；切换会话由首屏请求负责。
    if (previous.sessionId !== sessionId || !previous.turnLive || turnLive) return undefined;
    // A settled turn has persisted messages the page we hold predates: this read
    // is the one that must not join an answer already in flight.
    void historyOwner?.refreshPage(sessionId);
    return undefined;
  }, [historyOwner, sessionId, turnLive]);
  // One view model, derived in one place (`projection/transcript-view-model.ts`);
  // this component renders what it returns.
  const view = useMemo(
    () =>
      projectWebuiTranscriptView({
        sessionId,
        visiblePage,
        streamMessages: stream.messages,
        streamPhase,
        processingStartedAtMs: stream.processingStartedAtMs,
        turnLive,
        loading,
        error,
      }),
    [
      error,
      loading,
      sessionId,
      stream.messages,
      stream.processingStartedAtMs,
      streamPhase,
      turnLive,
      visiblePage,
    ],
  );
  const {
    messageProjections,
    items,
    turnViewsByMessageId,
    groups,
    liveAssistantMessages,
    liveAssistantView,
    liveGroupViews,
    trailingLiveGroupId,
    liveActivityGroupId,
    liveActivityAtTranscriptLevel,
    turns,
    showEmptyState,
  } = view;
  // The scroll binding owns the viewport, the auto-follow policy and the pin.
  const { releaseAutoFollow } = useWebuiTranscriptScroll({
    transcriptRef,
    sessionId,
    turnLive,
    contentKey: items,
  });
  // The navigator's tick interactions: hover decides which turn the preview
  // card describes, activation jumps the viewport to that turn's message root.
  // `TurnNavigator` renders; this integrator owns the state and the DOM.
  const [hoveredTurnId, setHoveredTurnId] = useState<string>();
  const navigatorPreview = useMemo(
    () =>
      hoveredTurnId
        ? projectTurnNavigatorPreview({ turnId: hoveredTurnId, groups })
        : null,
    [groups, hoveredTurnId],
  );
  const activateNavigatorTick = (turnId: string) => {
    const anchor = transcriptRef.current?.querySelector<HTMLElement>(
      turnNavigatorAnchorSelector(turnId),
    );
    if (!anchor) return;
    // 跳转是读者主动离开贴底跟随：先交还控制权，否则后续内容增长会把
    // 视口从落点拽回底部（loadOlder 出于同一原因先释放）。
    releaseAutoFollow();
    revealTurnNavigatorAnchor(anchor);
  };
  const loadOlder = visiblePage.hasMore && visiblePage.nextCursor
    ? () => {
        if (loading) return;
        const requestedCursor = visiblePage.nextCursor;
        if (!requestedCursor) return;
        // 翻历史是用户主动往上走：交还控制权，否则更早消息并进来之后
        // 贴底跟随会把他从正在读的位置拽回末尾。
        releaseAutoFollow();
        const viewport = transcriptViewport(transcriptRef.current);
        const previousScrollTop = viewport?.scrollTop;
        void historyOwner?.loadOlder(sessionId, requestedCursor).then((outcome) => {
          requestAnimationFrame(() => {
            if (
              outcome.status === "applied" &&
              historyOwner.isCurrentPage(outcome.page) &&
              transcriptRef.current?.dataset.webuiTranscript === sessionId &&
              viewport?.isConnected &&
              previousScrollTop !== undefined
            ) {
              viewport.scrollTop = previousScrollTop;
            }
          });
        });
      }
    : undefined;
  return (
    <section
      ref={transcriptRef}
      aria-label="Transcript"
      data-webui-transcript={sessionId}
      data-webui-transcript-empty={showEmptyState ? "true" : undefined}
      className="message-container-viewport scrollbar-hide webui-session-transcript-scroll relative flex w-full flex-col"
      data-webui-session-transcript-scroll="true"
    >
      <div
        className="message-list flex w-full flex-col gap-spacing_8"
        data-webui-message-list="true"
      >
        {error ? (
          <p
            role="alert"
            className="text-text_default_secondary text-size_14 leading-line_height_20"
          >
            Unable to load messages: {error}
          </p>
        ) : null}
        {!turnLive && loading && items.length === 0 ? <ChatSkeleton /> : null}
        {showEmptyState ? (
          <p
            className="webui-transcript-empty-state text-text_default_secondary text-size_14 leading-line_height_20"
            data-testid="transcript-empty-state"
          >
            当前会话暂无消息
          </p>
        ) : null}
        {loadOlder ? (
          <div className="flex w-full justify-center py-1">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loading}
              className="webui-button-secondary text-size_14 leading-line_height_20"
              aria-label={loading ? "正在加载更早消息" : "加载更早消息"}
            >
              <IconChevronUp aria-hidden="true" className="size-4 flex-none" size={16} stroke={1.7} />
              <span>{loading ? "正在加载…" : "加载更早消息"}</span>
            </button>
          </div>
        ) : null}
        {groups.flatMap((group) => {
          const userItem = group.items.find(
            (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
              item.kind === "user",
          );
          const questionnaireResponseItem = group.items.find(
            (
              item,
            ): item is Extract<
              WebuiTranscriptItem,
              { kind: "questionnaire_response" }
            > => item.kind === "questionnaire_response",
          );
          const result: ReactElement[] = [];
          if (questionnaireResponseItem) {
            result.push(
              <WebuiQuestionnaireResponse
                key={`${group.messageId}-questionnaire`}
                messageId={group.messageId}
                summary={questionnaireResponseItem.summary}
                timestamp={questionnaireResponseItem.timestamp}
              />,
            );
          }
          if (userItem) {
            const projectedUserView = turnViewsByMessageId.get(
              userItem.messageId,
            );
            const historicalUserView =
              projectedUserView?.source === "historical"
                ? projectedUserView
                : undefined;
            result.push(
              <MessageItem
                key={group.messageId}
                view={
                  {
                    ...(historicalUserView ?? {
                      source: "historical",
                      messageId: userItem.messageId,
                      role: "user",
                      sessionId,
                    }),
                    source: "historical",
                    messageId: userItem.messageId,
                    role: "user",
                    sessionId,
                    userText: userItem.text,
                    actions: userItem.actions,
                    timestamp: userItem.timestamp,
                    isGoal: userItem.isGoal,
                  }
                }
                transcriptCommands={transcriptCommands}
                workspaceDir={workspaceDir}
                onOpenFile={onOpenFile}
                onOpenTurnReview={onOpenTurnReview}
              />,
            );
          }
          if (result.length > 0) return result;
          // Fall through to the assistant-group renderer below.
          // `wallClockDurationMs` and `processSegments` are group-level
          // facts: the first is the group's span and the second preserves
          // per-message activity rows across the assistant group. The
          // historical per-message adapter leaves processSegments out;
          // this group projection supplies it before rendering.
          const thinkingItems = group.items.filter(
            (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
              item.kind === "thinking",
          );
          const tools = group.items
            .filter(
              (
                item,
              ): item is Extract<WebuiTranscriptItem, { kind: "tool" }> =>
                item.kind === "tool",
            )
            .flatMap((item) => item.tools);
          const answers = group.items.filter(
            (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
              item.kind === "assistant",
          );
          const actions = group.items.find(
            (
              item,
            ): item is Extract<
              WebuiTranscriptItem,
              { actions?: WebuiMessageActionCapabilities }
            > => "actions" in item,
          )?.actions;
          const initialDiff = [...group.items]
            .reverse()
            .find(
              (
                item,
              ): item is Extract<
                WebuiTranscriptItem,
                { diff?: WebuiTurnDiffView }
              > => "diff" in item,
            )?.diff;
          const projectedAssistantView = turnViewsByMessageId.get(
            group.messageId,
          );
          const historicalAssistantView =
            projectedAssistantView?.source === "historical"
              ? projectedAssistantView
              : undefined;
          const groupLiveView = liveGroupViews?.get(group.messageId);
          const assistantView = groupLiveView
            ? {
                ...groupLiveView,
                messageId: group.messageId,
                ...(group.turnId ? { turnId: group.turnId } : {}),
                // Only the trailing live assistant group is still in flight; the
                // ones before it rendered their row as done so the activity
                // pulse stays unique.
                ...(group.messageId === liveActivityGroupId
                  ? {}
                  : { streaming: false }),
              }
            : {
                ...(historicalAssistantView ?? {
                  source: "historical" as const,
                  messageId: group.messageId,
                  role: "assistant" as const,
                  sessionId,
                }),
                source: "historical" as const,
                messageId: group.messageId,
                role: "assistant" as const,
                sessionId,
                ...(group.turnId ? { turnId: group.turnId } : {}),
                ...(group.forceExpanded ? { processForceExpanded: true } : {}),
                userText: undefined,
                thinking: thinkingItems.length > 0
                  ? thinkingItems.map((item) => item.text).join("\n\n")
                  : undefined,
                thinkingDurationMs: thinkingItems[0]?.durationMs,
                tools: tools.length > 0 ? tools : undefined,
                answers: answers.map((item) => item.text),
                timestamp: undefined,
                isGoal: undefined,
                totalRequestDurationMs: group.totalRequestDurationMs,
                totalOutputTokens: group.totalOutputTokens,
                actions,
                initialDiff,
                attachments: answers[0]?.attachments,
                processSegments: projectWebuiProcessSegments(group.items),
              };
          return (
            <Fragment key={group.messageId}>
              <MessageItem
                view={assistantView}
                wallClockDurationMs={group.wallClockDurationMs}
                transcriptCommands={transcriptCommands}
                workspaceDir={workspaceDir}
                onOpenFile={onOpenFile}
                onOpenTurnReview={onOpenTurnReview}
            />
              {planAnchorMessageId !== undefined &&
              group.items.some((item) => item.messageId === planAnchorMessageId) ? (
                <div
                  key={`${group.messageId}-plan`}
                  className="webui-plan-inline"
                  data-testid="plan-inline-anchor"
                >
                  {planReview ? (
                    <WebuiTranscriptPlanDelivery
                      sessionId={sessionId}
                      request={planReview}
                      answerPlanBuild={answerPlanBuild}
                      onOpenPlanFile={onOpenPlanFile}
                    />
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {streamPhase === "reconnecting" ? (
          <MessagePassiveLoadingPlaceholder label="重连中…" />
        ) : null}
        {turnLive && !liveAssistantMessages.length &&
        (streamPhase === "streaming" || streamPhase === "waiting") ? (
          stream.messages.some((message) => message.role === "user") && streamPhase === "waiting" ? (
            <>
              <MessageAfterQueryStreamingPlaceholder />
              <div className="webui-session-stream-status" data-webui-live-thinking="true">
                <ActivityIndicator showLabel labelOverride="思考中…" />
              </div>
            </>
          ) : (
            <div className="webui-session-stream-status" data-webui-live-thinking="true">
              <ActivityIndicator showLabel labelOverride="思考中…" />
            </div>
          )
        ) : null}
        {turnLive && liveAssistantView &&
        (streamPhase === "streaming" || streamPhase === "waiting") &&
        (!liveAssistantView.thinking?.trim() || liveActivityAtTranscriptLevel) ? (
          <div className="webui-session-stream-status" data-webui-live-thinking="true">
            <ActivityIndicator showLabel labelOverride="思考中…" />
          </div>
        ) : null}
      </div>
      <TurnNavigator
        turns={turns}
        preview={navigatorPreview}
        onTickHover={(turnId) => setHoveredTurnId(turnId)}
        onTickLeave={(turnId) =>
          setHoveredTurnId((current) => (current === turnId ? undefined : current))
        }
        onTickActivate={(turnId) => activateNavigatorTick(turnId)}
      />
    </section>
  );
}
