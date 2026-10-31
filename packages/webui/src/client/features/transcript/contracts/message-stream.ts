// The wire-message seam the transcript business publishes.
//
// Moved here from `projection/message-projection.ts`. Three readers need
// it and none of them may import that private projection: the conversation
// substrate's recovery bundle (`features/turn/projection/stream-recovery.ts`),
// the composer's readout, and the sessions rail's context indicator. What moves
// is the normalisation of a wire `WebuiClientMessage` and the rebuild of one
// historical record as a live/resync message, plus the `usage` readers both
// depend on.
//
// What stays in `projection/message-projection.ts` is the component-facing
// projection — `projectWebuiMessage`, `projectWebuiTranscriptMessage`,
// `projectMessageAttachments`, `deriveConversationUsageNotice`, `readMessageDiff`
// — which imports these back. `normalizeWebuiClientMessage` is published (it is
// the normalized-wire seam both halves share) rather than duplicated; the
// declarations themselves are unchanged.
//
// Layer note: this module reads `client/contracts/value-readers.ts` (same
// layer) and two contract modules, which is what a contracts home may import.
// It is also why the moved projector could not stay where it was and be read
// from turn: the substrate may not import a peer's `projection/`.

import { recordValue } from "../../../contracts/value-readers.js";
import type { WebuiStreamMessage } from "../../turn/contracts/stream-state.js";
import type { WebuiClientMessage, WebuiMessageAttachment } from "./message-view.js";

/**
 * Normalize flattened and persisted raw message shapes at the projection seam.
 *
 * Published with the rest of this seam: the projection module that used
 * to hide it imports it back for `projectWebuiMessage`.
 */
export function normalizeWebuiClientMessage(
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
    // `attachments` rides through `...remainder` untouched without this, and
    // `projectMessageAttachments` iterates it with a bare `for...of` — so
    // `attachments: {}` / `42` / `true` on the wire threw
    // `TypeError: attachments is not iterable` and took the whole transcript
    // render with it. Same class as the fields above; it was just missing from
    // the list, so the guard was not authoritative in both directions.
    attachments: _incomingAttachments,
    ...remainder
  } = message;
  return {
    ...remainder,
    ...(typeof msgContent === "string" ? { msgContent } : {}),
    ...(typeof thinkingContent === "string" ? { thinkingContent } : {}),
    ...(typeof thinkingDurationMs === "number" ? { thinkingDurationMs } : {}),
    ...(Array.isArray(toolCalls) ? { toolCalls } : {}),
    ...(Array.isArray(parts) ? { parts: parts as Record<string, unknown>[] } : {}),
    ...(Array.isArray(read("attachments"))
      ? { attachments: read("attachments") as WebuiMessageAttachment[] }
      : {}),
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
 *  the ordered parts or the live message-level fields. */
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
