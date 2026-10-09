// Message projection — convert a wire `WebuiClientMessage` into the
// component-facing transcript items, plus the small diff/usage helpers the
// projection relies on.
//
// The split is deliberate: `projection/message-parts.ts` turns the same wire
// message into Desktop-style `parts[]`, and this module adapts those parts
// into the `WebuiTranscriptItem[]` shape the components already render. It
// also owns the `readMessageDiff` / `readMessageUsage` / `readUsageNumber`
// helpers because both projections consume them — moving them here keeps the
// reusable readers next to each other.

import {
  booleanValue,
  numberValue,
  recordValue,
  stringValue,
} from "../value-readers.js";
import type { WebuiClientMessage, WebuiMessageAttachment } from "../contracts/message-view.js";
import type { WebuiTranscriptItem } from "../contracts/transcript-view.js";
import type { WebuiStreamMessage } from "../stream.js";
import type {
  WebuiFileDiffInfoView,
  WebuiTurnDiffView,
} from "../../shared/contracts/session.js";
import {
  projectMessageParts,
  type WebuiMessageForParts,
} from "./message-parts.js";

/**
 * Read the per-message diff view off a wire message, accepting either the
 * flat `message` shape the live stream sends or the persisted snake_case
 * `rawJson` shape the loader hands back. Returns undefined when none of the
 * recognised fields carries a usable diff.
 */
export function readMessageDiff(
  message: WebuiClientMessage,
): WebuiTurnDiffView | undefined {
  const raw = (() => {
    if (message.rawJson) {
      try {
        return recordValue(JSON.parse(message.rawJson));
      } catch {
        return undefined;
      }
    }
    return recordValue(message);
  })();
  const meta = message.meta ?? recordValue(raw?.meta);
  const rawFiles =
    message.fileChanges ??
    raw?.file_changes ??
    raw?.fileChanges ??
    meta?.file_changes ??
    meta?.fileChanges;
  const fileChanges = Array.isArray(rawFiles)
    ? rawFiles.flatMap((file): WebuiFileDiffInfoView[] => {
        const value = recordValue(file);
        if (!value || typeof value.file !== "string") return [];
        return [
          {
            file: value.file,
            additions: typeof value.additions === "number" ? value.additions : 0,
            deletions: typeof value.deletions === "number" ? value.deletions : 0,
            ...(typeof value.status === "string" ? { status: value.status } : {}),
          },
        ];
      })
    : undefined;
  const sourceMessageId =
    message.sourceMessageId ??
    stringValue(raw?.sourceMessageId) ??
    stringValue(meta?.sourceMessageId);
  const changeSetId =
    message.changeSetId ??
    stringValue(raw?.changeSetId) ??
    stringValue(meta?.changeSetId);
  const status =
    message.turnDiffStatus ??
    stringValue(raw?.turnDiffStatus) ??
    stringValue(meta?.turnDiffStatus);
  const revertedAt =
    message.revertedAt ??
    numberValue(raw?.revertedAt) ??
    numberValue(meta?.revertedAt);
  const canUndo =
    message.canUndo ??
    booleanValue(raw?.canUndo) ??
    booleanValue(meta?.canUndo);
  const canReapply =
    message.canReapply ??
    booleanValue(raw?.canReapply) ??
    booleanValue(meta?.canReapply);
  if (
    !fileChanges?.length &&
    !sourceMessageId &&
    !changeSetId &&
    !status
  )
    return undefined;
  return {
    ...(fileChanges?.length ? { fileChanges } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(changeSetId ? { changeSetId } : {}),
    ...(status ? { status } : {}),
    ...(revertedAt !== undefined ? { revertedAt } : {}),
    ...(canUndo !== undefined ? { canUndo } : {}),
    ...(canReapply !== undefined ? { canReapply } : {}),
  };
}

/**
 * Project the raw wire `attachments[]` into the component-facing
 * `MessageAttachment[]`. Returns undefined when the wire array is missing or
 * carries no usable entries, so callers can use truthiness to decide whether
 * to render the attachments row.
 */
export function projectMessageAttachments(
  attachments: readonly unknown[] | undefined,
): readonly WebuiMessageAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const projected: WebuiMessageAttachment[] = [];
  for (const entry of attachments) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = stringValue(record.id) ?? stringValue(record.attachment_id) ?? `${projected.length}-`;
    const typeValue = stringValue(record.type) ?? stringValue(record.attachment_type);
    const type: WebuiMessageAttachment["type"] = typeValue === "file" ? "file" : "image";
    const fileName =
      stringValue(record.file_name) ??
      stringValue(record.fileName) ??
      stringValue(record.name) ??
      id;
    projected.push({
      id,
      type,
      file_name: fileName,
      ...(stringValue(record.file_path) ?? stringValue(record.filePath)
        ? {
            file_path:
              stringValue(record.file_path) ?? stringValue(record.filePath),
          }
        : {}),
      ...(stringValue(record.preview_url) ?? stringValue(record.previewUrl)
        ? {
            preview_url:
              stringValue(record.preview_url) ?? stringValue(record.previewUrl),
          }
        : {}),
      ...(stringValue(record.desktop_path) ?? stringValue(record.desktopPath)
        ? {
            desktop_path:
              stringValue(record.desktop_path) ?? stringValue(record.desktopPath),
          }
        : {}),
      ...(stringValue(record.mime_type) ?? stringValue(record.mimeType)
        ? {
            mime_type:
              stringValue(record.mime_type) ?? stringValue(record.mimeType),
          }
        : {}),
      ...(typeof record.file_size === "number"
        ? { file_size: record.file_size }
        : {}),
      ...(stringValue(record.src) ? { src: stringValue(record.src) } : {}),
    });
  }
  return projected.length > 0 ? projected : undefined;
}

/**
 * Derive the user's usage banner notice from the cloud-issued quota window.
 * Returns null when no notice is warranted so the caller can fall back to
 * the per-message usage indicator. Only one notice is returned — the most
 * restrictive signal wins — so the banner never duplicates.
 */
export function deriveConversationUsageNotice(
  quota: WebuiUsageQuotaResult | undefined,
): ConversationUsageNotice | null {
  if (!quota || quota.signedIn === false) return null;
  const view = quota.quota;
  if (!view) return null;
  const candidates: ConversationUsageNotice[] = [];
  if (!view.weekly.unlimited && (view.weekly.usedPercent ?? 0) >= 80) {
    candidates.push({
      kind: "weekly",
      messageKey: "weekly",
      resetAtMs: view.weekly.resetAtMs ?? null,
      actions: ["subscribe_plan", "upgrade_plan"],
      dismissable: true,
    });
  }
  if (!view.fiveHour.unlimited && (view.fiveHour.usedPercent ?? 0) >= 80) {
    candidates.push({
      kind: "five_hour",
      messageKey: "five_hour",
      resetAtMs: view.fiveHour.resetAtMs ?? null,
      actions: ["buy_credits"],
      dismissable: true,
    });
  }
  if (view.video && !view.video.unlimited) {
    const remaining =
      (view.video.totalCount ?? 0) - (view.video.usedCount ?? 0);
    if (remaining <= 0) {
      candidates.push({
        kind: "video",
        messageKey: "video",
        resetAtMs: view.video.resetAtMs ?? null,
        actions: ["buy_credits"],
        dismissable: true,
      });
    }
  }
  return candidates[0] ?? null;
}

/**
 * Convert a wire message into the components-facing transcript items. The
 * pure parts layer preserves Desktop's source order (thinking → text → tool
 * calls → synthetic). Keep that order here: a text part is a boundary between
 * activity groups, so moving tools ahead of text incorrectly merges activity
 * that Desktop renders on opposite sides of an assistant reply.
 */
export function projectWebuiMessage(
  message: WebuiClientMessage,
): WebuiTranscriptItem[] {
  const normalized = normalizeWebuiClientMessage(message);
  const orderedItems: WebuiTranscriptItem[] = [];
  const attachments = projectMessageAttachments(normalized.attachments);
  // Pull the raw message-level usage (matches `TokenUsage` from agent-core).
  // The message-parts projector already strips the questionnaire XML block
  // before producing text parts, so the user bubble never surfaces raw
  // `<questionnaire-response>` markup.
  const messageUsage = readMessageUsage(normalized);
  for (const part of projectMessageParts(normalized)) {
    const turn = normalized.turnId ? { turnId: normalized.turnId } : {};
    let item: WebuiTranscriptItem | undefined;
    if (part.type === "thinking") {
      item = {
        kind: "thinking",
        text: part.content,
        messageId: normalized.msgId,
        ...turn,
        ...(part.durationMs !== undefined ? { durationMs: part.durationMs } : {}),
        ...(normalized.actions ? { actions: normalized.actions } : {}),
        ...(normalized.timestamp !== undefined ? { timestamp: normalized.timestamp } : {}),
        ...(attachments ? { attachments } : {}),
        ...(messageUsage ? { usage: messageUsage } : {}),
      };
    } else if (part.type === "text") {
      item = {
        kind: normalized.role === "user" ? "user" : "assistant",
        text: part.content,
        messageId: normalized.msgId,
        ...turn,
        ...(normalized.actions ? { actions: normalized.actions } : {}),
        ...(normalized.timestamp !== undefined ? { timestamp: normalized.timestamp } : {}),
        ...(normalized.source === "thread-goal" || normalized.kind === "goal"
          ? { isGoal: true }
          : {}),
        ...(attachments ? { attachments } : {}),
        ...(messageUsage ? { usage: messageUsage } : {}),
      };
    } else if (part.type === "tool_call") {
      item = {
        kind: "tool",
        tools: [part.toolCall],
        messageId: normalized.msgId,
        ...turn,
        ...(messageUsage ? { usage: messageUsage } : {}),
      };
    } else if (part.type === "cognitive" || part.type === "compaction") {
      item = { kind: "activity", activityType: part.type, text: part.content, messageId: normalized.msgId, ...turn };
    } else if (part.type === "delegation") {
      item = { kind: "activity", activityType: "delegation", detail: part.message, ...(typeof part.message.content === "string" ? { text: part.message.content } : {}), messageId: normalized.msgId, ...turn };
    } else if (part.type === "agent_joined") {
      item = { kind: "activity", activityType: "agent_joined", detail: part.agent as Record<string, unknown>, messageId: normalized.msgId, ...turn };
    } else if (part.type === "asset_list") {
      item = { kind: "activity", activityType: "asset_list", detail: { assets: part.assets }, messageId: normalized.msgId, ...turn };
    } else if (part.type === "questionnaire_response") {
      item = {
        kind: "questionnaire_response",
        messageId: normalized.msgId,
        ...turn,
        summary: part.summary,
        ...(normalized.timestamp !== undefined ? { timestamp: normalized.timestamp } : {}),
      };
    }
    if (item) orderedItems.push(item);
  }
  const output = orderedItems;
  const diff = readMessageDiff(message);
  if (diff && output.length > 0) {
    const last = output.length - 1;
    const lastItem = output[last];
    // The questionnaire response kind intentionally never carries a diff — its
    // text payload records the user's answers, not a tool call summary.
    if (
      lastItem &&
      (lastItem.kind === "user" ||
        lastItem.kind === "assistant" ||
        lastItem.kind === "thinking" ||
        lastItem.kind === "tool")
    )
      output[last] = { ...lastItem, diff };
  }
  return output;
}

/**
 * 对一条历史 transcript message 只做一次 projection，并保留原 message，
 * 供 historical turn adapter 消费同一份结果。
 */
export function projectWebuiTranscriptMessage(
  message: WebuiClientMessage,
  projectMessage: typeof projectWebuiMessage = projectWebuiMessage,
): { readonly message: WebuiClientMessage; readonly items: WebuiTranscriptItem[] } {
  return { message, items: projectMessage(message) };
}

/** Normalize flattened and persisted raw message shapes at the projection seam. */
function normalizeWebuiClientMessage(
  message: WebuiClientMessage,
): WebuiClientMessage {
  const direct = message as unknown as Record<string, unknown>;
  const rawCandidates: Record<string, unknown>[] = [];
  if (typeof message.rawJson === "string") {
    try {
      const parsed = recordValue(JSON.parse(message.rawJson));
      for (const candidate of [
        parsed,
        recordValue(parsed?.message),
        recordValue(parsed?.agent_message),
        recordValue(parsed?.agentMessage),
        recordValue(parsed?.data),
      ]) {
        if (candidate) rawCandidates.push(candidate);
      }
    } catch {
      // Keep using direct fields when rawJson is malformed.
    }
  }
  const read = (...keys: readonly string[]): unknown => {
    for (const key of keys) {
      if (direct[key] !== undefined) return direct[key];
    }
    for (const candidate of rawCandidates) {
      for (const key of keys) {
        if (candidate[key] !== undefined) return candidate[key];
      }
    }
    return undefined;
  };
  const msgContent = read("msgContent", "msg_content", "content");
  const thinkingContent = read(
    "thinkingContent",
    "thinking_content",
    "reasoningContent",
    "reasoning_content",
    "thinking",
  );
  const thinkingDurationMs = read("thinkingDurationMs", "thinking_duration_ms");
  const toolCalls = read("toolCalls", "tool_calls");
  const parts = read("parts");
  const timestamp = read("timestamp");
  const contextUsage = read("contextUsage", "context_usage");
  // Every field the checks below normalize is stripped from the carried-over
  // remainder first. A conditional spread can only *add* a normalized value, so
  // a field that was already malformed on the input used to survive
  // `...message` untouched: the false branch contributed nothing and therefore
  // removed nothing. `projectMessageParts` then called `.trimStart()` on such a
  // `msgContent` and threw `msgContent?.trimStart is not a function` during the
  // transcript render, and a non-array `toolCalls` threw on `.entries`. The
  // guards below look like they drop those values, and now they do: stripping
  // first makes each `typeof`/`Array.isArray` test authoritative in both
  // directions, so a normalized field is present only when it passed.
  const {
    msgContent: _incomingMsgContent,
    thinkingContent: _incomingThinkingContent,
    thinkingDurationMs: _incomingThinkingDurationMs,
    toolCalls: _incomingToolCalls,
    parts: _incomingParts,
    role: _incomingRole,
    source: _incomingSource,
    kind: _incomingKind,
    timestamp: _incomingTimestamp,
    contextUsage: _incomingContextUsage,
    ...remainder
  } = message;
  return {
    ...remainder,
    ...(typeof msgContent === "string" ? { msgContent } : {}),
    ...(typeof thinkingContent === "string" ? { thinkingContent } : {}),
    ...(typeof thinkingDurationMs === "number" ? { thinkingDurationMs } : {}),
    ...(Array.isArray(toolCalls) ? { toolCalls } : {}),
    ...(Array.isArray(parts) ? { parts: parts as Record<string, unknown>[] } : {}),
    ...(typeof read("role") === "string" ? { role: read("role") as string } : {}),
    ...(typeof read("source") === "string" ? { source: read("source") as string } : {}),
    ...(typeof read("kind") === "string" ? { kind: read("kind") as string } : {}),
    ...(typeof timestamp === "number" ? { timestamp } : {}),
    ...(recordValue(contextUsage) ? { contextUsage: recordValue(contextUsage)! } : {}),
  };
}

/**
 * Read the per-message usage block — prefers the live wire frame's
 * camelCase `usage` object, falls back to the persisted snake_case `rawJson`
 * so the same projection works for history and live updates.
 */
export function readMessageUsage(
  message: WebuiClientMessage,
): Record<string, unknown> | undefined {
  const direct = (message as { usage?: unknown }).usage;
  if (direct && typeof direct === "object" && !Array.isArray(direct))
    return direct as Record<string, unknown>;
  if (typeof message.rawJson === "string") {
    try {
      const raw = recordValue(JSON.parse(message.rawJson));
      const candidates = [
        raw,
        recordValue(raw?.message),
        recordValue(raw?.agent_message),
        recordValue(raw?.agentMessage),
        recordValue(raw?.data),
      ];
      for (const candidate of candidates) {
        const usage = recordValue(candidate?.usage) ?? recordValue(candidate?.Usage);
        if (usage) return usage;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Rebuild one historical record as one live/resync message without losing
 *  the Desktop ordered parts or the live message-level fields. */
export function projectWebuiMessageToStreamMessage(
  message: WebuiClientMessage,
): WebuiStreamMessage {
  const normalized = normalizeWebuiClientMessage(message);
  const id = normalized.msgId;
  const parts = Array.isArray(normalized.parts)
    ? normalized.parts.filter((part): part is Record<string, unknown> =>
        !!recordValue(part),
      )
    : undefined;
  const toolCalls = Array.isArray(normalized.toolCalls)
    ? normalized.toolCalls
    : undefined;
  const usage = readMessageUsage(message);
  // `contextUsage` is the field the composer's readout and `latestContextUsage`
  // read. Two different producers write context consumption, and the readout
  // must survive either one:
  //
  //   - `context_usage` (camelCase inside: `contextWindowTokens` /
  //     `usedTokens` / `components`) is the Electron-local live snapshot. It
  //     rides the stream only, never the cloud, and never reaches the database.
  //   - `usage` (`total_tokens` / `context_window`) is the turn-level token
  //     usage in `agent-core/src/protocol/agent-message.ts`, and it is what a
  //     reloaded session actually has.
  //
  // Reading `normalized.contextUsage` alone left the field undefined for every
  // persisted message, so a reloaded session's readout had no input at all and
  // rendered nothing — with no error to point at it. Prefer the explicit
  // snapshot when a live message carries one (it is the richer shape, and the
  // only one with a per-category `components` breakdown) and fall back to the
  // turn usage otherwise, so the readout works on both live and reloaded
  // sessions.
  const contextUsage = normalized.contextUsage ?? usage;
  return {
    id,
    answer: normalized.msgContent ?? "",
    thinking: normalized.thinkingContent ?? "",
    ...(normalized.timestamp !== undefined ? { timestamp: normalized.timestamp } : {}),
    ...(normalized.source === "thread-goal" || normalized.kind === "goal"
      ? { isGoal: true }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(parts ? { parts } : {}),
    ...(usage ? { usage } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(normalized.role === "user" || id.startsWith("msg-user-")
      ? { role: "user" as const }
      : {}),
  };
}

/**
 * Numeric fields on the runtime `usage` payload — accept both the camelCase
 * keys the live wire frame ships and the snake_case keys the persisted
 * `data_json` carries.
 */
export function readUsageNumber(
  usage: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/* Local types referenced by `deriveConversationUsageNotice`. */

export interface WebuiUsageQuotaResult {
  readonly signedIn?: boolean;
  readonly quota?: {
    readonly weekly: {
      readonly unlimited?: boolean;
      readonly usedPercent?: number;
      readonly resetAtMs?: number | null;
    };
    readonly fiveHour: {
      readonly unlimited?: boolean;
      readonly usedPercent?: number;
      readonly resetAtMs?: number | null;
    };
    readonly video?: {
      readonly unlimited?: boolean;
      readonly totalCount?: number;
      readonly usedCount?: number;
      readonly resetAtMs?: number | null;
    };
  };
}

export type ConversationUsageActionKind =
  | "subscribe_plan"
  | "upgrade_plan"
  | "buy_credits";

export interface ConversationUsageNotice {
  readonly kind: "weekly" | "five_hour" | "video";
  readonly messageKey: "weekly" | "five_hour" | "video";
  readonly resetAtMs: number | null;
  readonly actions: readonly ConversationUsageActionKind[];
  readonly dismissable: boolean;
}
