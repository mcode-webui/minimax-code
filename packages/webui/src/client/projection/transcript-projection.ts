// Transcript projection 负责将 transcript items 分组为渲染区块。
// `groupWebuiTranscriptItems` 是供 renderer 使用的 helper；每组对应一个 user bubble 或 assistant turn。

import type { WebuiClientMessage, WebuiClientMessagePage, WebuiQueryCollapseView } from "../contracts/message-view.js";
import type { WebuiTranscriptItem, WebuiTranscriptActivityPart, WebuiTranscriptProcessSegment } from "../contracts/transcript-view.js";
import type { WebuiStreamMessage } from "../stream.js";
import { readUsageNumber } from "./message-projection.js";

/** A render block: one user bubble, or one assistant turn. The transcript
 * renderer iterates these groups; per-block fields tell it how long the turn
 *  took and how many output tokens it used. */
export interface WebuiTranscriptGroup {
  readonly messageId: string;
  readonly turnId?: string;
  readonly items: WebuiTranscriptItem[];
  readonly totalRequestDurationMs?: number;
  readonly totalOutputTokens?: number;
  readonly forceExpanded?: boolean;
  /** Wall-clock turn duration derived from message timestamps: the oldest
   *  `user` timestamp in the same turn (across group boundaries) to the
   *  newest `assistant` timestamp. */
  readonly wallClockDurationMs?: number;
}

export interface WebuiMessageQueryDuration {
  readonly queryKey: string;
  readonly durationMs: number;
  readonly forceExpanded?: boolean;
}

/**
 * Build one transcript timeline from the durable snapshot and its live
 * message updates. Stream updates address the same server message identity as
 * history, so they update that record in place; this is the transcript's
 * normal upsert path, not a second rendered list with a duplicate filter.
 */
export function projectWebuiTranscriptMessages(
  page: WebuiClientMessagePage,
  streamMessages: readonly WebuiStreamMessage[],
  preferStreamUpdates = true,
): readonly WebuiClientMessage[] {
  const messages = [...(page.messages ?? [])];
  const indexById = new Map(messages.map((message, index) => [message.msgId, index]));
  const refreshIndexes = (from: number) => {
    for (let index = from; index < messages.length; index += 1)
      indexById.set(messages[index]!.msgId, index);
  };
  for (let streamIndex = 0; streamIndex < streamMessages.length; streamIndex += 1) {
    const stream = streamMessages[streamIndex]!;
    const index = indexById.get(stream.id);
    const previous = index === undefined ? undefined : messages[index];
    if (previous && !preferStreamUpdates) continue;
    const next: WebuiClientMessage = {
      ...(previous ?? { msgId: stream.id }),
      msgId: stream.id,
      ...(stream.role || previous?.role ? { role: stream.role ?? previous?.role } : {}),
      ...(stream.answer || previous?.msgContent !== undefined
        ? { msgContent: stream.answer || previous?.msgContent }
        : {}),
      ...(stream.thinking || previous?.thinkingContent !== undefined
        ? { thinkingContent: stream.thinking || previous?.thinkingContent }
        : {}),
      ...(stream.timestamp !== undefined || previous?.timestamp !== undefined
        ? { timestamp: stream.timestamp ?? previous?.timestamp }
        : {}),
      ...(stream.toolCalls || previous?.toolCalls
        ? { toolCalls: stream.toolCalls ?? previous?.toolCalls }
        : {}),
      ...(stream.parts || previous?.parts
        ? { parts: stream.parts ?? previous?.parts }
        : {}),
      ...(stream.usage || previous?.usage
        ? { usage: stream.usage ?? previous?.usage }
        : {}),
      ...(stream.isGoal || previous?.kind === "goal" || previous?.source === "thread-goal"
        ? { kind: "goal" }
        : {}),
    };
    if (index === undefined) {
      // History can already contain a queued user message that was accepted
      // after an in-flight assistant message. Insert the stream-only record
      // beside its nearest later stream identity so the ordered stream acts as
      // the sequence of anchors across the two sources.
      let insertAt: number | undefined;
      for (let nextStream = streamIndex + 1; nextStream < streamMessages.length; nextStream += 1) {
        const nextIndex = indexById.get(streamMessages[nextStream]!.id);
        if (nextIndex !== undefined) {
          insertAt = nextIndex;
          break;
        }
      }
      if (insertAt === undefined) {
        for (let previousStream = streamIndex - 1; previousStream >= 0; previousStream -= 1) {
          const previousIndex = indexById.get(streamMessages[previousStream]!.id);
          if (previousIndex !== undefined) {
            insertAt = previousIndex + 1;
            break;
          }
        }
      }
      const insertionIndex = insertAt ?? messages.length;
      messages.splice(insertionIndex, 0, next);
      refreshIndexes(insertionIndex);
    } else {
      messages[index] = next;
    }
  }
  return messages;
}

/** Map persisted query timing to the messages that belong to that query. */
export function projectWebuiQueryDurations(
  messages: readonly Pick<WebuiClientMessage, "msgId" | "queryKey">[],
  views: readonly WebuiQueryCollapseView[],
): ReadonlyMap<string, WebuiMessageQueryDuration> {
  const durationByQuery = new Map<string, WebuiMessageQueryDuration>();
  for (const view of views) {
    const { processingStartedAtMs: start, processingFinishedAtMs: end } = view;
    if (
      typeof view.queryKey === "string" && view.queryKey.length > 0 &&
      typeof start === "number" && Number.isFinite(start) &&
      typeof end === "number" && Number.isFinite(end) && end >= start
    ) durationByQuery.set(view.queryKey, {
      queryKey: view.queryKey,
      durationMs: end - start,
      ...(view.forceExpanded === true ? { forceExpanded: true } : {}),
    });
  }
  const out = new Map<string, WebuiMessageQueryDuration>();
  for (const message of messages) {
    if (!message.queryKey) continue;
    const queryDuration = durationByQuery.get(message.queryKey);
    if (queryDuration) out.set(message.msgId, queryDuration);
  }
  return out;
}

/** Preserve the per-message activity segments that Desktop renders as rows. */
export function projectWebuiProcessSegments(
  items: readonly WebuiTranscriptItem[],
): readonly WebuiTranscriptProcessSegment[] {
  const segments: WebuiTranscriptProcessSegment[] = [];
  const byMessageId = new Map<string, WebuiTranscriptProcessSegment>();
  for (const item of items) {
    if (item.kind !== "thinking" && item.kind !== "tool" && item.kind !== "assistant" && !("activityType" in item)) continue;
    const current = byMessageId.get(item.messageId) ?? {
      messageId: item.messageId,
    };
    let parts: readonly WebuiTranscriptActivityPart[];
    if (item.kind === "thinking") parts = [{ type: "thinking", text: item.text, ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}) }];
    else if (item.kind === "tool") parts = item.tools.map((tool) => ({ type: "tool", tool }));
    else if (item.kind === "assistant") parts = [{ type: "text", text: item.text }];
    else {
      const activity = item as Extract<WebuiTranscriptItem, { activityType: string }>;
      if (activity.activityType === "delegation") parts = [{ type: "delegation", message: activity.detail ?? {} }];
      else if (activity.activityType === "agent_joined") parts = [{ type: "agent_joined", agent: activity.detail ?? {} }];
      else if (activity.activityType === "asset_list") parts = [{ type: "asset_list", assets: Array.isArray(activity.detail?.assets) ? activity.detail.assets.flatMap((asset) => asset && typeof asset === "object" && !Array.isArray(asset) ? [asset as Record<string, unknown>] : []) : [] }];
      else if (activity.activityType === "cognitive") parts = [{ type: "cognitive", text: activity.text ?? "" }];
      else if (activity.activityType === "compaction") parts = [{ type: "compaction", text: activity.text ?? "" }];
      else parts = [];
    }
    const next: WebuiTranscriptProcessSegment = item.kind === "thinking"
      ? {
          ...current,
          thinking: item.text,
          ...(item.durationMs !== undefined
            ? { thinkingDurationMs: item.durationMs }
            : {}),
        }
      : item.kind === "tool"
      ? {
          ...current,
          tools: [...(current.tools ?? []), ...(item as Extract<WebuiTranscriptItem, { kind: "tool" }>).tools],
        }
      : current;
    const withParts = { ...next, activityParts: [...(current.activityParts ?? []), ...parts] };
    if (!byMessageId.has(item.messageId)) segments.push(withParts);
    else {
      const index = segments.findIndex(
        (segment) => segment.messageId === item.messageId,
      );
      if (index >= 0) segments[index] = withParts;
    }
    byMessageId.set(item.messageId, withParts);
  }
  // Once a group has process activity, keep text-only assistant messages too:
  // Desktop treats earlier replies as archived process content while the
  // final reply remains outside the disclosure. Dropping text-only segments
  // here makes that boundary impossible to project in the renderer.
  return segments.some((segment) => segment.activityParts?.some((part) => part.type !== "text"))
    ? segments
    : [];
}

/**
 * Group transcript items into renderer blocks. A user line always opens its
 * own block; the assistant's following tool/answer items for the same
 * `messageId` merge into the same block. Wall-clock duration is computed
 * across group boundaries (the user's prompt timestamp → the assistant's
 * last timestamp) so the header reads "共执行 N 分 M 秒".
 *
 * `usage.outputTokens` is counted once per messageId, not once per item —
 * `projectWebuiMessage` emits one item per part (thinking / tool / text) and
 * every part carries the same `usage` blob.
 */
export function groupWebuiTranscriptItems(
  items: readonly WebuiTranscriptItem[],
  queryDurationByMessageId: ReadonlyMap<string, WebuiMessageQueryDuration> = new Map(),
): readonly WebuiTranscriptGroup[] {
  type Group = {
    messageId: string;
    turnId?: string;
    items: WebuiTranscriptItem[];
    totalRequestDurationMs?: number;
    totalOutputTokens?: number;
    forceExpanded?: boolean;
    assistantMaxTimestamp?: number;
    queryDurations?: Map<string, WebuiMessageQueryDuration>;
  };
  // The user and assistant blocks live in different groups (the renderer
  // opens its own block for every user line). To compute a wall-clock span
  // across the user prompt and the assistant reply, remember the smallest
  // user timestamp we have seen per turn key, then look it up when the
  // matching assistant block lands. Keyed by turnId when present, falling
  // back to queryKey and finally messageId for unkeyed cases.
  const userStartByTurn = new Map<string, number>();
  const turnKeyFor = (item: WebuiTranscriptItem): string =>
    item.turnId ?? item.messageId;
  for (const item of items) {
    if (
      item.kind === "user" &&
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp)
    ) {
      const key = turnKeyFor(item);
      const current = userStartByTurn.get(key);
      if (current === undefined || item.timestamp < current) {
        userStartByTurn.set(key, item.timestamp);
      }
    }
  }
  const countedMessages = new Set<string>();
  const out: Group[] = [];
  const addUsage = (group: Group, item: WebuiTranscriptItem): void => {
    if (item.kind === "user" || item.kind === "questionnaire_response" || item.kind === "activity") return;
    if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp)) {
      group.assistantMaxTimestamp = Math.max(
        group.assistantMaxTimestamp ?? Number.NEGATIVE_INFINITY,
        item.timestamp,
      );
    }
    if (countedMessages.has(item.messageId)) return;
    countedMessages.add(item.messageId);
    const queryDuration = queryDurationByMessageId.get(item.messageId);
    if (queryDuration) {
      group.queryDurations ??= new Map();
      group.queryDurations.set(queryDuration.queryKey, queryDuration);
      if (queryDuration.forceExpanded) group.forceExpanded = true;
    }
    const usage = item.usage;
    const tokens = readUsageNumber(usage, "outputTokens", "output_tokens");
    if (typeof tokens === "number") {
      group.totalOutputTokens = (group.totalOutputTokens ?? 0) + tokens;
    }
    const duration = readUsageNumber(
      usage,
      "requestDurationMs",
      "request_duration_ms",
    );
    if (typeof duration === "number") {
      group.totalRequestDurationMs =
        (group.totalRequestDurationMs ?? 0) + duration;
    }
  };
  for (const item of items) {
    const last = out[out.length - 1];
    const lastIsUser = last?.items[0]?.kind === "user";
    const joinsOpenBlock =
      last &&
      ((!lastIsUser && item.kind !== "user") ||
        last.messageId === item.messageId);
    if (joinsOpenBlock && last) {
      last.items.push(item);
      if (!last.turnId && item.turnId) last.turnId = item.turnId;
      addUsage(last, item);
    } else {
      const group: Group = {
        messageId: item.messageId,
        ...(item.turnId ? { turnId: item.turnId } : {}),
        items: [item],
      };
      countedMessages.clear();
      addUsage(group, item);
      out.push(group);
    }
  }
  return out.map((group) => {
    const { assistantMaxTimestamp, queryDurations, ...rest } = group;
    if (queryDurations?.size) {
      const queryViews = [...queryDurations.values()];
      rest.totalRequestDurationMs = queryViews.reduce((sum, view) => sum + view.durationMs, 0);
      if (queryViews.some((view) => view.forceExpanded)) rest.forceExpanded = true;
    }
    const userStart = userStartByTurn.get(group.turnId ?? group.messageId);
    if (
      typeof userStart === "number" &&
      typeof assistantMaxTimestamp === "number" &&
      assistantMaxTimestamp > userStart
    ) {
      const wallClockDurationMs = assistantMaxTimestamp - userStart;
      // Only surface the duration when it is meaningful (≥ 1s). A single
      // timestamp or sub-second gap would otherwise render as "共执行 0 秒".
      if (wallClockDurationMs >= 1000) {
        return { ...rest, wallClockDurationMs };
      }
    }
    return rest;
  });
}
