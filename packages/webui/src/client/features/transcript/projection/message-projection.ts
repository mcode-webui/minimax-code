// Message projection — convert a wire `WebuiClientMessage` into the
// component-facing transcript items, plus the small diff helpers the
// projection relies on.
//
// The split is deliberate: `message-parts.ts` turns the same wire
// message into an ordered `parts[]`, and this module adapts those parts
// into the `WebuiTranscriptItem[]` shape the components already render. It
// also owns `readMessageDiff`, which both projections consume. The wire
// normalisation and the usage readers moved to
// `../contracts/message-stream.ts` — the conversation substrate's recovery
// bundle and two other businesses read them, so they are published there — and
// are imported back here.

import {
  booleanValue,
  numberValue,
  recordValue,
  stringValue,
} from "../../../contracts/value-readers.js";
import type { WebuiClientMessage, WebuiMessageAttachment } from "../contracts/message-view.js";
import type { WebuiTranscriptItem } from "../contracts/transcript-view.js";
import type { WebuiStreamMessage } from "../../turn/contracts/stream-state.js";
import type {
  WebuiFileDiffInfoView,
  WebuiTurnDiffView,
} from "../../../../shared/contracts/session.js";
import type { WebuiUsageQuotaResult } from "../../../../shared/contracts/usage-quota.js";
import {
  projectMessageParts,
  type WebuiMessageForParts,
} from "./message-parts.js";
import {
  normalizeWebuiClientMessage,
  readMessageUsage,
} from "../contracts/message-stream.js";

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
 * pure parts layer preserves the source order (thinking → text → tool
 * calls → synthetic). Keep that order here: a text part is a boundary between
 * activity groups, so moving tools ahead of text incorrectly merges activity
 * that the transcript renders on opposite sides of an assistant reply.
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
    } else if (part.type === "runtime_warning") {
      // A humanized warning row, not an assistant message: the envelope's
      // `message` is the body, and the structured fields ride along so the
      // renderer composes the title without re-parsing JSON.
      item = {
        kind: "activity",
        activityType: "runtime_warning",
        messageId: normalized.msgId,
        ...turn,
        text: part.warning.message,
        warning: part.warning,
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

// The wire-message seam — `normalizeWebuiClientMessage`, `readMessageUsage`,
// `projectWebuiMessageToStreamMessage` and `readUsageNumber` — moved to
// `../contracts/message-stream.ts`: the conversation substrate's recovery
// bundle and two other businesses read it, and they may not import this private
// projection. They are imported at the top of this module; this file keeps the
// component-facing projection.

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
