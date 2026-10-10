// SessionTranscript — the per-session message log: groups, projectWebuiMessage
// flattening, history paging, streaming loader, and the embedded
// WebuiQuestionnaireResponse renderer for historical questionnaire answers.
//
// W3 tier 4 lift: this cluster (2 components) was moved verbatim out of
// `app.tsx`. The bodies are byte-identical to what used to live there;
// the lift is move-only. `app.tsx` keeps a thin re-export block so
// existing consumers (`webui-shell.test.ts`, importers via `app.tsx`)
// keep their current import path during the W3 wave.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChatSkeleton } from "./TranscriptSkeletons.js";
import { ActivityIndicator, MessageAfterQueryStreamingPlaceholder, MessagePassiveLoadingPlaceholder } from "./ActivityIndicator.js";
import { TurnNavigator, type TurnSummary } from "./TurnNavigator.js";
import { MessageItem } from "./MessageItem.js";
import { formatWebuiMessageTimestamp } from "./MessageActions.js";
import type { WebuiMessageActionCapabilities } from "../contracts/transcript-view.js";
import { useWebuiSessionQuestionnaire, useWebuiSessionStream } from "../bindings/use-session-state.js";
import { isTurnLive } from "../projection/composer-state.js";
import {
  isWebuiPlanReviewRequest,
  webuiPlanMarkdown,
  webuiPlanPath,
} from "../projection/plan-mode.js";
import { WebuiPlanDeliveryCard } from "./PlanModeCards.js";
import type { WebuiClientMessageLoader, WebuiClientMessagePage } from "../contracts/message-view.js";
import type { WebuiTranscriptItem } from "../contracts/transcript-view.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type { WebuiQuestionnaireRequest } from "../../shared/contracts/interactions.js";

/** Capability subset the transcript passes through to each message item.
 *  Single source of truth lives in `WebuiTransport`; this alias keeps the
 *  prop block free of per-key `WebuiTransport["x"]` redeclarations. */
type WebuiSessionTranscriptCapabilities = Pick<
  WebuiTransport,
  | "getTurnDiff"
  | "revertTurnDiff"
  | "reapplyTurnDiff"
  | "getSessionForkOptions"
  | "forkSession"
  | "getSessionRewindPreview"
  | "rewindSession"
  | "editSessionMessage"
>;
import type { WebuiTurnDiffView } from "../../shared/contracts/session.js";
import type { WebuiQuestionnaireResponseSummary } from "../contracts/transcript-view.js";
import type { WebuiMessageFileReference } from "../projection/message-file-reference.js";
import type { WorkspacePanelCommand } from "../projection/workspace-panel-state.js";
import {
  groupWebuiTranscriptItems,
  projectWebuiTranscriptMessages,
  projectWebuiQueryDurations,
  projectWebuiProcessSegments,
} from "../projection/transcript-projection.js";
import { projectWebuiTranscriptMessage } from "../projection/message-projection.js";
import {
  projectHistoricalTurnView,
  projectLiveTurnView,
  type WebuiLiveTurnView,
  type WebuiTurnView,
} from "../projection/transcript-shape.js";
import {
  createWebuiTranscriptRequestCoordinator,
  getOwnedTranscriptPage,
  mergeOlderTranscriptPage,
  runWebuiTranscriptPageRequest,
  updateOwnedTranscriptState,
  type WebuiOwnedTranscriptState,
  type WebuiTranscriptRequestToken,
} from "../application/transcript-request-ownership.js";
import {
  webuiScrollBottomTop,
  webuiScrollFollowsBottom,
} from "../projection/transcript-scroll.js";

const EMPTY_TRANSCRIPT_PAGE: WebuiClientMessagePage = {};

/**
 * Historical questionnaire-response projection. Once the user submits a
 * questionnaire we render the question and the recorded answers inside the
 * conversation so a rewinded session still remembers what the user picked.
 */
export function WebuiQuestionnaireResponse({
  messageId,
  summary,
  timestamp,
}: {
  readonly messageId: string;
  readonly summary: WebuiQuestionnaireResponseSummary;
  readonly timestamp?: number;
}): ReactElement {
  const { requestId, answers } = summary;
  return (
    <article
      className="webui-questionnaire-history flex w-full max-w-[80%] min-w-0 flex-col gap-3 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-4 text-text_default_primary"
      data-webui-questionnaire-history="true"
      data-message-id={messageId}
      data-webui-questionnaire-request={requestId}
      data-testid={`questionnaire-history-${requestId}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <span
          className="text-size_14 font-medium leading-line_height_20 text-text_default_primary"
          data-testid="questionnaire-history-label"
        >
          问卷回答
        </span>
        {typeof timestamp === "number" ? (
          <time
            className="shrink-0 text-size_12 leading-line_height_16 text-text_default_tertiary"
            dateTime={new Date(timestamp).toISOString()}
            data-testid="questionnaire-history-timestamp"
          >
            {formatWebuiMessageTimestamp(timestamp)}
          </time>
        ) : null}
      </header>
      <ul
        className="webui-questionnaire-history-answers flex min-w-0 flex-col gap-3"
        data-testid="questionnaire-history-answers"
      >
        {answers.map((answer, index) => (
          <li
            key={`${requestId}-${index}`}
            className="webui-questionnaire-history-answer flex min-w-0 flex-col gap-1.5 text-size_14 leading-line_height_20"
            data-testid={`questionnaire-history-answer-${index}`}
          >
            <strong
              className="text-text_default_primary"
              data-testid={`questionnaire-history-answer-${index}-question`}
            >
              {answer.question}
            </strong>
            <ul className="flex min-w-0 flex-wrap gap-2">
              {answer.labels.map((label, labelIndex) => (
                <li
                  key={`${requestId}-${index}-${labelIndex}`}
                  className="webui-questionnaire-history-label max-w-full rounded-lg bg-bg_grouped_tertiary px-3 py-1.5 text-text_default_secondary [overflow-wrap:anywhere]"
                  data-testid={`questionnaire-history-answer-${index}-label-${labelIndex}`}
                >
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <details className="webui-questionnaire-history-details border-t-[0.5px] border-border_default pt-2">
        <summary className="w-fit cursor-pointer text-size_12 leading-line_height_16 text-text_default_tertiary hover:text-text_default_secondary">
          查看回答信息
        </summary>
        <dl
          className="webui-questionnaire-history-meta mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-size_12 leading-line_height_16 text-text_default_tertiary"
          data-testid="questionnaire-history-meta"
        >
          <div className="contents" data-testid="questionnaire-history-meta-requestId">
            <dt>requestId</dt>
            <dd className="min-w-0 break-all font-mono">{requestId || "(未提供)"}</dd>
          </div>
          {summary.schemaVersion ? (
            <div className="contents" data-testid="questionnaire-history-meta-schema">
              <dt>schemaVersion</dt>
              <dd className="font-mono">{summary.schemaVersion}</dd>
            </div>
          ) : null}
          {summary.submittedAt ? (
            <div className="contents" data-testid="questionnaire-history-meta-submitted">
              <dt>submittedAt</dt>
              <dd className="min-w-0 break-all font-mono">{summary.submittedAt}</dd>
            </div>
          ) : null}
          {summary.mode ? (
            <div className="contents" data-testid="questionnaire-history-meta-mode">
              <dt>mode</dt>
              <dd className="break-all font-mono">{summary.mode}</dd>
            </div>
          ) : null}
          {summary.source ? (
            <div className="contents" data-testid="questionnaire-history-meta-source">
              <dt>source</dt>
              <dd className="break-all font-mono">{summary.source}</dd>
            </div>
          ) : null}
          {summary.featureKey ? (
            <div className="contents" data-testid="questionnaire-history-meta-feature-key">
              <dt>featureKey</dt>
              <dd className="break-all font-mono">{summary.featureKey}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </article>
  );
}

export function WebuiSessionTranscript({
  sessionId,
  loadMessages,
  initialMessages,
  getTurnDiff,
  revertTurnDiff,
  reapplyTurnDiff,
  getSessionForkOptions,
  forkSession,
  getSessionRewindPreview,
  rewindSession,
  editSessionMessage,
  answerPlanBuild,
  workspaceDir,
  onOpenFile,
  onOpenTurnReview,
  onOpenPlanFile,
}: {
  readonly sessionId: string;
  readonly loadMessages: WebuiClientMessageLoader;
  readonly initialMessages?: WebuiClientMessagePage;
  readonly workspaceDir?: string;
  readonly onOpenFile?: (input: { readonly sessionId: string; readonly workspaceDir: string; readonly reference: WebuiMessageFileReference }) => void;
  readonly onOpenTurnReview?: (command: Extract<WorkspacePanelCommand, { type: "open-turn-review" }>) => void;
  readonly onOpenPlanFile?: (input: { readonly sessionId: string; readonly path: string; readonly content: string }) => void;
  readonly answerPlanBuild?: (request: WebuiQuestionnaireRequest) => Promise<void>;
} & WebuiSessionTranscriptCapabilities): ReactElement {
  const coordinatorRef = useRef(createWebuiTranscriptRequestCoordinator(sessionId));
  const coordinator = coordinatorRef.current;
  useLayoutEffect(() => {
    coordinator.commitOwner(sessionId);
  }, [coordinator, sessionId]);
  const committedOwner = coordinator.getCommittedOwner();
  const [transcriptState, setTranscriptState] = useState<WebuiOwnedTranscriptState>(
    () => ({
      ownerSessionId: sessionId,
      generation: 0,
      page: initialMessages ?? {},
      loading: initialMessages === undefined,
    }),
  );
  const commitTranscriptRequest = (
    token: WebuiTranscriptRequestToken,
    update: (current: WebuiOwnedTranscriptState) => WebuiOwnedTranscriptState,
  ) => {
    setTranscriptState((current) => coordinator.isCurrent(token)
      ? updateOwnedTranscriptState(current, token.ownerSessionId, token.generation, update)
      : current);
  };
  const visibleState = transcriptState.ownerSessionId === sessionId &&
      transcriptState.generation === committedOwner.generation
    ? transcriptState
    : undefined;
  const visiblePage = visibleState
    ? getOwnedTranscriptPage(visibleState, sessionId) ?? EMPTY_TRANSCRIPT_PAGE
    : EMPTY_TRANSCRIPT_PAGE;
  const loading = visibleState?.loading ?? true;
  const error = visibleState?.error;
  const transcriptRef = useRef<HTMLElement | null>(null);
  const loadingLifecycleRef = useRef(0);
  const beginLoadingLifecycle = () => ++loadingLifecycleRef.current;
  const settleLoadingLifecycle = (
    lifecycleId: number,
    ownerSessionId: string,
    generation: number,
  ) => {
    setTranscriptState((current) =>
      lifecycleId === loadingLifecycleRef.current &&
      current.ownerSessionId === ownerSessionId &&
      current.generation === generation
        ? { ...current, loading: false }
        : current,
    );
  };
  const stream = useWebuiSessionStream(sessionId);
  const streamPhase = stream.phase;
  const autoFollowRef = useRef(true);
  const manualScrollIntentRef = useRef(false);
  // The plan file is a MESSAGE in the transcript, not a floating card: the
  // desktop renders it as the footer of the turn that wrote the plan. It lives
  // on the pending questionnaire, so the transcript reads the same channel the
  // composer does and anchors the card to `request.tool.messageId`.
  //
  // The composer keeps its own copy for the decision; this read only decides
  // whether a plan card belongs in the message column.
  const pendingQuestionnaire = useWebuiSessionQuestionnaire(sessionId);
  const planReview = isWebuiPlanReviewRequest(pendingQuestionnaire)
    ? pendingQuestionnaire
    : undefined;
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const [planError, setPlanError] = useState<string | undefined>(undefined);
  const planAnchorMessageId = planReview?.tool?.messageId;
  const submitPlanBuild = useCallback(() => {
    if (!planReview || !answerPlanBuild) return;
    setPlanError(undefined);
    setPlanSubmitting(true);
    void answerPlanBuild(planReview)
      .catch((error: unknown) => {
        setPlanError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPlanSubmitting(false));
  }, [answerPlanBuild, planReview]);
  // 预览 opens the whole plan file in the workspace panel, the way the desktop
  // hands the markdown to its file viewer. The file lives outside the workspace
  // root, so the content travels with the command instead of being read back.
  const openPlanFile = useCallback(
    (request: WebuiQuestionnaireRequest) => {
      const path = webuiPlanPath(request);
      if (!path || !onOpenPlanFile) return;
      onOpenPlanFile({ sessionId, path, content: webuiPlanMarkdown(request) });
    },
    [onOpenPlanFile, sessionId],
  );
  // History and stream frames feed one transcript projection. The live
  // records update the same message identities in this list while history
  // supplies the persisted fields and older messages.
  const turnLive = isTurnLive(streamPhase);
  const previousTurnStateRef = useRef({ sessionId, turnLive });
  useEffect(() => {
    const token = coordinator.beginRequest(sessionId);
    if (!token) return;
    const loadingLifecycleId = beginLoadingLifecycle();
    setTranscriptState((current) => {
      if (!coordinator.isCurrent(token)) return current;
      if (current.ownerSessionId !== token.ownerSessionId || current.generation !== token.generation) {
        return {
          ownerSessionId: token.ownerSessionId,
          generation: token.generation,
          page: initialMessages ?? EMPTY_TRANSCRIPT_PAGE,
          loading: initialMessages === undefined,
        };
      }
      return {
        ...current,
        loading: initialMessages === undefined ? true : current.loading,
        error: undefined,
      };
    });
    void runWebuiTranscriptPageRequest(
      coordinator,
      token,
      () => loadMessages({ id: sessionId }),
      (update) => commitTranscriptRequest(token, update),
      (nextPage, commit) => {
        commit((owned) => ({
          ...owned,
          page: nextPage,
        }));
      },
      (reason, commit) => {
        commit((owned) => ({
          ...owned,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      },
      () => settleLoadingLifecycle(
        loadingLifecycleId,
        token.ownerSessionId,
        token.generation,
      ),
    );
  }, [coordinator, loadMessages, sessionId]);
  useEffect(() => {
    const previous = previousTurnStateRef.current;
    previousTurnStateRef.current = { sessionId, turnLive };
    // 加载历史页只处理会话内的 live → idle 转换；切换会话由首屏请求负责。
    if (previous.sessionId !== sessionId || !previous.turnLive || turnLive) return undefined;
    const token = coordinator.beginRequest(sessionId);
    if (!token) return undefined;
    const loadingLifecycleId = beginLoadingLifecycle();
    void runWebuiTranscriptPageRequest(
      coordinator,
      token,
      () => loadMessages({ id: sessionId }),
      (update) => commitTranscriptRequest(token, update),
      (nextPage, commit) => {
        commit((owned) => ({
          ...owned,
          page: nextPage,
        }));
      },
      (reason, commit) => {
        commit((owned) => ({
          ...owned,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      },
      () => settleLoadingLifecycle(
        loadingLifecycleId,
        token.ownerSessionId,
        token.generation,
      ),
    );
    return undefined;
  }, [coordinator, loadMessages, sessionId, turnLive]);
  const messages = useMemo(
    () => projectWebuiTranscriptMessages(visiblePage, stream.messages, streamPhase !== "done"),
    [visiblePage, stream.messages, streamPhase],
  );
  const transcriptProjection = useMemo(() => {
    const messageProjections = messages.map((message) =>
      projectWebuiTranscriptMessage(message),
    );
    return {
      messageProjections,
      items: messageProjections.flatMap((projection) => projection.items),
    };
  }, [messages]);
  const { messageProjections, items } = transcriptProjection;
  // 每条消息使用统一视图；历史适配器提供持久化字段，实时适配器提供流式标记。
  // MessageItem 只通过 view 属性读取这些值。
  const turnViewsByMessageId = useMemo(
    () =>
      new Map<string, WebuiTurnView>(
        messageProjections.map(({ message, items: projectedItems }) => [
          message.msgId,
          projectHistoricalTurnView(message, sessionId, projectedItems),
        ]),
      ),
    [messageProjections, sessionId],
  );
  // Group by message so one turn renders as one block, the way the desktop
  // does: a process disclosure carrying the thinking and the tool steps, then
  // the assistant's markdown. A user turn is its own block.
  const queryDurationByMessageId = useMemo(
    () => projectWebuiQueryDurations(
      visiblePage.messages ?? [],
      visiblePage.queryCollapseViews ?? [],
    ),
    [visiblePage.messages, visiblePage.queryCollapseViews],
  );
  const groups = useMemo(
    () => groupWebuiTranscriptItems(items, queryDurationByMessageId),
    [items, queryDurationByMessageId],
  );
  const liveAssistantMessages = useMemo(
    () => stream.messages.filter((message) => message.role !== "user"),
    [stream.messages],
  );
  const liveAssistantView = useMemo(
    () => projectLiveTurnView(stream.messages, {
      sessionId,
      streaming: streamPhase === "streaming",
      processingStartedAtMs: stream.processingStartedAtMs,
    }),
    [sessionId, stream.messages, stream.processingStartedAtMs, streamPhase],
  );
  /**
   * A goal run injects a synthetic user continuation between model calls, and
   * a user item always opens a NEW group — so one live turn can own several
   * assistant groups. Broadcasting the turn-wide `liveAssistantView` into every
   * one of them duplicated the streamed content across the transcript and left
   * a second activity pulse stranded mid-thread.
   *
   * Project each group's live view from its OWN messages instead. A group's
   * items carry every message id merged into it, so this stays exact whether the
   * group holds one assistant message or several. Groups with no live message
   * (pure history, and the user-only continuation bubble) get no entry and keep
   * the historical branch below.
   */
  const liveGroupViews = useMemo(() => {
    if (!turnLive) return undefined;
    const views = new Map<string, WebuiLiveTurnView>();
    for (const group of groups) {
      const owned = new Set(group.items.map((item) => item.messageId));
      const own = stream.messages.filter((message) => owned.has(message.id));
      if (own.length === 0) continue;
      const view = projectLiveTurnView(own, {
        sessionId,
        streaming: streamPhase === "streaming",
        processingStartedAtMs: stream.processingStartedAtMs,
      });
      if (view) views.set(group.messageId, view);
    }
    return views.size > 0 ? views : undefined;
  }, [groups, sessionId, stream.messages, stream.processingStartedAtMs, streamPhase, turnLive]);
  /**
   * The trailing live assistant group owns the live activity row, so the
   * `推理中…` indicator is rendered exactly once and always trails the
   * transcript. Earlier live groups still render their own live content, but as
   * settled history: a second pulse earlier in the thread is exactly the state
   * this guards against.
   */
  const trailingLiveGroupId = useMemo(() => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (!group) continue;
      const owned = new Set(group.items.map((item) => item.messageId));
      if (stream.messages.some((message) => owned.has(message.id))) {
        return group.messageId;
      }
    }
    return undefined;
  }, [groups, stream.messages]);
  const liveActivityGroupId = useMemo(() => {
    if (!trailingLiveGroupId) return undefined;
    return liveGroupViews?.has(trailingLiveGroupId)
      ? trailingLiveGroupId
      : undefined;
  }, [liveGroupViews, trailingLiveGroupId]);
  /**
   * The activity indicator falls back to transcript level when the last live
   * group is the goal continuation BUBBLE rather than an assistant group: no
   * message body is left to host the row, the previous round has settled, and
   * the next model call has not started thinking yet.
   */
  const liveActivityAtTranscriptLevel =
    trailingLiveGroupId !== undefined && liveActivityGroupId === undefined;
  useLayoutEffect(() => {
    if (!turnLive) return undefined;
    const transcript = transcriptRef.current;
    const viewport = transcript?.closest<HTMLElement>(
      '[data-webui-session-scroll="true"]',
    );
    if (!transcript || !viewport) return undefined;
    if (
      previousTurnStateRef.current.sessionId !== sessionId ||
      !previousTurnStateRef.current.turnLive
    ) {
      autoFollowRef.current = true;
      manualScrollIntentRef.current = false;
    }
    const followBottom = () => {
      if (autoFollowRef.current)
        viewport.scrollTop = webuiScrollBottomTop(viewport);
    };
    const onScroll = () => {
      if (webuiScrollFollowsBottom(viewport)) {
        autoFollowRef.current = true;
        manualScrollIntentRef.current = false;
      } else if (manualScrollIntentRef.current) {
        autoFollowRef.current = false;
      }
    };
    const onWheel = () => { manualScrollIntentRef.current = true; };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(followBottom);
    observer?.observe(transcript);
    followBottom();
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
    };
  }, [sessionId, turnLive]);
  useLayoutEffect(() => {
    if (!turnLive) return;
    const viewport = transcriptRef.current?.closest<HTMLElement>(
      '[data-webui-session-scroll="true"]',
    );
    if (viewport && autoFollowRef.current)
      viewport.scrollTop = webuiScrollBottomTop(viewport);
  }, [items, turnLive]);
  // 进入会话时落在最后一条消息上，和桌面端一致。上面那套跟随只在回合 live 时
  // 装配，所以非 live 的会话会保留上一个会话留下的 scrollTop（新挂载的视口就是 0，
  // 即顶部）。
  //
  // 这里不能只跳一次：首屏消息落地后内容还会继续撑开高度（代码高亮、图片、
  // markdown 表格），一次性跳转按当帧高度算出的"底部"会停在倒数几条消息上，实测
  // 差出近一屏。所以进入会话期间用 ResizeObserver 持续贴底，直到用户自己滚动，
  // 或者主动去翻更早的历史为止。骨架屏期间视口不足一屏，贴底等价于不动，无副作用。
  const openScrollFollowRef = useRef(false);
  useLayoutEffect(() => {
    openScrollFollowRef.current = true;
  }, [sessionId]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const viewport = transcript?.closest<HTMLElement>(
      '[data-webui-session-scroll="true"]',
    );
    if (!transcript || !viewport) return undefined;
    const followBottom = () => {
      if (openScrollFollowRef.current)
        viewport.scrollTop = webuiScrollBottomTop(viewport);
    };
    // 用户开始滚动即交还控制权。程序化设置 scrollTop 不产生 wheel/touchmove，
    // 所以跟随自己的写入不会把自己关掉。
    const releaseControl = () => { openScrollFollowRef.current = false; };
    viewport.addEventListener("wheel", releaseControl, { passive: true });
    viewport.addEventListener("touchmove", releaseControl, { passive: true });
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(followBottom);
    observer?.observe(transcript);
    followBottom();
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("wheel", releaseControl);
      viewport.removeEventListener("touchmove", releaseControl);
    };
  }, [sessionId]);
  const showEmptyState = !turnLive && !error && !loading && items.length === 0;
  // The right-rail navigator's tick list mirrors the assistant turns visible
  // on the page. A user turn isn't a tick — only the assistant block that
  // follows it counts. The first assistant group is `active` while we have
  // nothing settled; the last is `running` while streaming is live.
  const turns = useMemo<readonly TurnSummary[]>(() => {
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
  }, [groups, streamPhase]);
  const loadOlder = visibleState?.page.hasMore && visibleState.page.nextCursor
    ? () => {
        if (loading) return;
        const requestedCursor = visibleState.page.nextCursor;
        if (!requestedCursor) return;
        // 翻历史是用户主动往上走：交还控制权，否则更早消息并进来之后
        // 贴底跟随会把他从正在读的位置拽回末尾。
        openScrollFollowRef.current = false;
        const token = coordinator.beginRequest(sessionId);
        if (!token) return;
        const loadingLifecycleId = beginLoadingLifecycle();
        const viewport = transcriptRef.current?.closest<HTMLElement>(
          '[data-webui-session-scroll="true"]',
        );
        const previousScrollTop = viewport?.scrollTop;
        commitTranscriptRequest(token, (owned) => ({
          ...owned,
          loading: true,
          error: undefined,
        }));
        void runWebuiTranscriptPageRequest(
          coordinator,
          token,
          () => loadMessages({ id: token.ownerSessionId, before: requestedCursor }),
          (update) => commitTranscriptRequest(token, update),
          (olderPage, commit) => {
            const applied = commit((owned) => {
              const result = mergeOlderTranscriptPage(owned, olderPage, requestedCursor);
              return { ...result.state, error: result.error };
            });
            if (!applied) return;
            requestAnimationFrame(() => {
              if (
                coordinator.isCurrent(token) &&
                viewport?.isConnected &&
                previousScrollTop !== undefined
              ) viewport.scrollTop = previousScrollTop;
            });
          },
          (reason, commit) => {
            commit((owned) => ({
              ...owned,
              error: reason instanceof Error ? reason.message : String(reason),
            }));
          },
          () => settleLoadingLifecycle(
            loadingLifecycleId,
            token.ownerSessionId,
            token.generation,
          ),
        );
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
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="size-4 flex-none"
              >
                <path
                  d="m4 10 4-4 4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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
                getSessionForkOptions={getSessionForkOptions}
                forkSession={forkSession}
                getSessionRewindPreview={getSessionRewindPreview}
                rewindSession={rewindSession}
                editSessionMessage={editSessionMessage}
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
                getTurnDiff={getTurnDiff}
                revertTurnDiff={revertTurnDiff}
                reapplyTurnDiff={reapplyTurnDiff}
                getSessionForkOptions={getSessionForkOptions}
                forkSession={forkSession}
                getSessionRewindPreview={getSessionRewindPreview}
                rewindSession={rewindSession}
              editSessionMessage={editSessionMessage}
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
                    <WebuiPlanDeliveryCard
                      request={planReview}
                      onBuild={submitPlanBuild}
                      onViewPlan={() => openPlanFile(planReview)}
                      chrome={{ busy: planSubmitting, error: planError }}
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
      <TurnNavigator turns={turns} />
    </section>
  );
}
