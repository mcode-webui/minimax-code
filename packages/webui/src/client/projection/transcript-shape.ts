/**
 * Transcript shape catalog + turn-view adapters.
 *
 * SessionTranscript combines two data sources into one message timeline:
 *
 *   1. **Historical** — `loadMessages({ id })` → `WebuiClientMessagePage`
 *      (`contracts.ts`). The server returns fully-materialised records; each
 *      record carries every field the runtime has ever written for the
 *      message (timestamp, usage, fileChanges, forkOrigin, etc.).
 *
 *   2. **Live** — `stream.messages` (`stream.ts`). Each frame upserts the
 *      same server message identity in the combined timeline, so it updates
 *      in place while the history snapshot supplies older and persisted data.
 *
 * Both sources reduce to the same leaf-renderer shape (`MessageItem`), but
 * the field sets they carry differ: the live path has no `usage` /
 * `fileChanges` / `forkOrigin` until the corresponding frames arrive, and
 * the historical path has no `streaming` flag — the live path is what marks
 * the boundary between the two adapters.
 *
 * This module is now the **production wiring** for that boundary, not just
 * documentation. The shared `WebuiTurnView` type captures the minimum set
 * of fields both adapters must surface to the leaf renderer. Two pure
 * adapter functions (`projectHistoricalTurnView` and
 * `projectLiveTurnView`) read the wire shapes and produce the normalised
 * view; the consumers in `SessionTranscript.tsx`, `SessionComposer.tsx`,
 * and `MessageItem.tsx` import them directly.
 *
 * `WEBUI_HISTORICAL_FIELD_TABLE`, `WEBUI_LIVE_FIELD_TABLE`, and
 * `WEBUI_FIELD_OWNERSHIP_TABLE` are kept as readonly documentation tables;
 * the runtime field-ownership truth lives in the two adapters.
 */

import type { WebuiClientMessage, WebuiMessageAttachment } from "../contracts/message-view.js";
import type { WebuiTranscriptItem, WebuiTranscriptProcessSegment, WebuiTranscriptActivityPart } from "../contracts/transcript-view.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type { WebuiStreamMessage } from "./stream-state.js";
import type { WebuiTurnDiffView } from "../../shared/contracts/session.js";
import type { WebuiMessageActionCapabilities } from "../contracts/transcript-view.js";
import {
  projectMessageAttachments,
  readMessageDiff,
  projectWebuiMessage,
  readUsageNumber,
} from "./message-projection.js";
import { projectMessageParts } from "./message-parts.js";

// ── Field table documentation (readonly; pinned by tests) ────────────

export interface WebuiHistoricalFieldRow {
  readonly field: keyof WebuiClientMessage | "derived";
  readonly projectedTo: string;
  readonly projection: "verbatim" | "reshape" | "join" | "derive";
  readonly notes: string;
}

export interface WebuiLiveFieldRow {
  readonly field: keyof WebuiStreamMessage | "derived";
  readonly projectedTo: string;
  readonly projection: "verbatim" | "reshape" | "join" | "derive";
  readonly notes: string;
}

export interface WebuiFieldOwnershipRow {
  readonly field: string;
  readonly owner: "historical" | "live" | "shared";
  readonly notes: string;
}

export const WEBUI_HISTORICAL_FIELD_TABLE: readonly WebuiHistoricalFieldRow[] =
  [
    { field: "msgId", projectedTo: "messageId", projection: "verbatim", notes: "Server-assigned message id; React key + data-message-id." },
    { field: "parentMsgId", projectedTo: "(parent chain)", projection: "derive", notes: "Used by message-projection.ts to stitch branches; not surfaced to MessageItem directly." },
    { field: "turnId", projectedTo: "turnId", projection: "verbatim", notes: "Assistant-group key; absent on pure user bubbles." },
    { field: "queryKey", projectedTo: "(query-key — indexing only)", projection: "reshape", notes: "Server-side ordering key; not rendered." },
    { field: "timestamp", projectedTo: "timestamp", projection: "verbatim", notes: "formatWebuiMessageTimestamp(timestamp) in the bubble footer." },
    { field: "msgContent", projectedTo: "userText / answers[*]", projection: "reshape", notes: "Stripped of <questionnaire-response> XML by message-parts; the rest becomes text parts." },
    { field: "msgType", projectedTo: "(unused by leaf renderer)", projection: "reshape", notes: "Server-side kind enum; projection ignores." },
    { field: "role", projectedTo: "role", projection: "verbatim", notes: "'user' | 'assistant' — drives bubble alignment." },
    { field: "thinkingContent", projectedTo: "thinking", projection: "reshape", notes: "Joined across thinking parts by projectMessageParts." },
    { field: "thinkingDurationMs", projectedTo: "thinkingDurationMs", projection: "verbatim", notes: "First thinking part's duration; drives the 已思考 N 秒 row." },
    { field: "toolCalls", projectedTo: "tools[*]", projection: "reshape", notes: "Each tool call becomes one tool-call item under the assistant group." },
    { field: "parts", projectedTo: "ordered activity rows", projection: "reshape", notes: "Persisted Desktop part ordering and activity kinds from the raw history payload." },
    { field: "attachments", projectedTo: "attachments", projection: "verbatim", notes: "Passthrough to MessageItem; ordered by message-parts projector." },
    { field: "usage", projectedTo: "totalRequestDurationMs / totalOutputTokens / wallClockDurationMs", projection: "reshape", notes: "messageUsage reader pulls request_duration_ms + output_tokens; wall clock derives from group span." },
    { field: "source", projectedTo: "isGoal (when source === 'thread-goal' || kind === 'goal')", projection: "derive", notes: "Right-aligned goal banner instead of plain user bubble." },
    { field: "kind", projectedTo: "isGoal (when kind === 'goal')", projection: "derive", notes: "Same flag as `source === 'thread-goal'`; either suffices." },
    { field: "actions", projectedTo: "actions", projection: "verbatim", notes: "fork / rewind / edit capability flags forwarded to MessageItem." },
    { field: "fileChanges", projectedTo: "initialDiff", projection: "reshape", notes: "Last (most recent) file diff in the message wins; matches Desktop's 'newest diff' rule." },
    { field: "forkOrigin", projectedTo: "(metadata only)", projection: "reshape", notes: "Server-side fork lineage; not surfaced." },
    { field: "communicationInfosJson", projectedTo: "(metadata only)", projection: "reshape", notes: "Server-side communication log; not surfaced." },
  ] as const;

export const WEBUI_LIVE_FIELD_TABLE: readonly WebuiLiveFieldRow[] = [
  { field: "id", projectedTo: "messageId / streamMessageId", projection: "verbatim", notes: "Server-assigned message id; same id reappears on the historical record after the turn lands." },
  { field: "answer", projectedTo: "userText / answers[*] (live)", projection: "verbatim", notes: "In-flight text updated in the unified transcript's right-aligned user bubble or assistant body." },
  { field: "thinking", projectedTo: "thinking (live)", projection: "verbatim", notes: "In-flight thinking; replaced by the historical record on land." },
  { field: "timestamp", projectedTo: "timestamp (live)", projection: "verbatim", notes: "Optional in-flight timestamp." },
  { field: "isGoal", projectedTo: "isGoal", projection: "verbatim", notes: "Right-aligned goal banner flag." },
  { field: "toolCalls", projectedTo: "tools (live)", projection: "verbatim", notes: "In-flight tool calls; carried through the turn." },
  { field: "parts", projectedTo: "processSegments[*].activityParts", projection: "reshape", notes: "Ordered Desktop activity parts from the existing agent_message frame." },
  { field: "usage", projectedTo: "totalRequestDurationMs / totalOutputTokens (live)", projection: "reshape", notes: "Per-message usage reported on agent_message frames." },
  { field: "role", projectedTo: "role", projection: "verbatim", notes: "'user' replays from the server as the in-flight user bubble." },
  { field: "derived", projectedTo: "streaming / messageRootId", projection: "derive", notes: "Driven by stream.phase; not a field on WebuiStreamMessage itself." },
] as const;

export const WEBUI_FIELD_OWNERSHIP_TABLE: readonly WebuiFieldOwnershipRow[] = [
  { field: "source", owner: "shared", notes: "Both adapters discriminate the view by source." },
  { field: "messageId", owner: "shared", notes: "Server-assigned id; both adapters surface it." },
  { field: "role", owner: "shared", notes: "Both historical and live views identify user or assistant." },
  { field: "sessionId", owner: "shared", notes: "Historical adapter requires it; live assistant receives it from the caller." },
  { field: "userText", owner: "shared", notes: "Historical user parts and the live user frame supply it." },
  { field: "thinking", owner: "shared", notes: "Live stream carries in-flight text; historical carries recorded text." },
  { field: "tools", owner: "shared", notes: "Tool calls appear in live frames and historical records." },
  { field: "answers", owner: "shared", notes: "Assistant answers are projected by both adapters." },
  { field: "timestamp", owner: "shared", notes: "Both adapters can surface message timestamps." },
  { field: "isGoal", owner: "shared", notes: "Both adapters can mark a goal view." },
  { field: "totalRequestDurationMs", owner: "shared", notes: "Read from historical usage or aggregated from live assistant frames." },
  { field: "totalOutputTokens", owner: "shared", notes: "Read from historical usage or aggregated from live assistant frames." },
  { field: "processSegments", owner: "shared", notes: "Historical assistant groups enrich the per-message adapter result; live assistant adapter supplies segments directly." },
  { field: "activityParts", owner: "shared", notes: "Ordered thinking/cognitive/compaction/tool/delegation parts from persisted parts or live agent_message frames." },
  { field: "turnId", owner: "historical", notes: "Persisted message or group key; live turns merge without a turn id." },
  { field: "thinkingDurationMs", owner: "historical", notes: "Persisted thinking duration; live stream has no duration field." },
  { field: "initialDiff", owner: "historical", notes: "Diff is projected from persisted file changes; live never carries it." },
  { field: "actions", owner: "historical", notes: "Fork, rewind and edit capabilities are persisted on historical messages." },
  { field: "attachments", owner: "historical", notes: "Attachments are read from persisted historical messages." },
  { field: "assistantMessageId", owner: "live", notes: "Identifies the last in-flight assistant frame." },
  { field: "streaming", owner: "live", notes: "Only live views carry the streaming state." },
  { field: "streamMessageId", owner: "live", notes: "Identifies the in-flight message stream." },
  { field: "messageRootId", owner: "live", notes: "Identifies the in-flight message root." },
  { field: "processingStartedAtMs", owner: "live", notes: "Runtime timestamp for the current live processing interval." },
] as const;

// ── Shared leaf renderer input contract ──────────────────────────────

/**
 * The normalised turn view shared by historical and live rendering.
 *
 * Ownership rule: `WebuiTurnViewBase` contains fields read by the shared
 * leaf renderer on both paths. A historical per-message adapter may be
 * enriched by `SessionTranscript` with group-level facts before rendering;
 * `processSegments` is the one such field and remains in the base because
 * the live adapter also supplies it. Fields only produced/read on one path
 * live on that path's extension (`WebuiHistoricalTurnView` or
 * `WebuiLiveTurnView`). The union `WebuiTurnView` is the consumer-facing
 * type accepted by `MessageItem`.
 *
 * One row per field. Producer and consumer references are source line
 * numbers, not inferred from optionality. Verdict matches the type above.
 *
 *   | field | historical producer (source line) | live producer (source line) | MessageItem read (source line) | verdict |
 *   |---|---|---|---|---|
 *   | source | historical adapter `transcript-shape.ts:326` | live adapters `transcript-shape.ts:418,452` | `MessageItem.tsx:87` | shared base |
 *   | messageId | historical adapter `transcript-shape.ts:327` | live adapters `transcript-shape.ts:419,453` | `MessageItem.tsx:85` | shared base |
 *   | role | historical adapter `transcript-shape.ts:328` | live adapters `transcript-shape.ts:420,454` | `MessageItem.tsx:86` | shared base |
 *   | sessionId | historical adapter `transcript-shape.ts:329` | live assistant adapter `transcript-shape.ts:421`; caller `SessionComposer.tsx:1238` | `MessageItem.tsx:95` | shared base |
 *   | userText | historical adapter `transcript-shape.ts:331-333` | live user adapter `transcript-shape.ts:455` | `MessageItem.tsx:96` | shared base |
 *   | thinking | historical adapter `transcript-shape.ts:334-336` | live assistant adapter `transcript-shape.ts:422` | `MessageItem.tsx:97` | shared base |
 *   | tools | historical adapter `transcript-shape.ts:340` | live assistant adapter `transcript-shape.ts:423` | `MessageItem.tsx:98` | shared base |
 *   | answers | historical adapter `transcript-shape.ts:341-343` | live assistant adapter `transcript-shape.ts:424` | `MessageItem.tsx:99` | shared base |
 *   | timestamp | historical adapter `transcript-shape.ts:303-304` | live user adapter `transcript-shape.ts:457` | `MessageItem.tsx:100` | shared base |
 *   | isGoal | historical adapter `transcript-shape.ts:305-308,344` | live user adapter `transcript-shape.ts:458` | `MessageItem.tsx:101` | shared base |
 *   | totalRequestDurationMs | historical adapter `transcript-shape.ts:315-319,345-348` | live assistant adapter `transcript-shape.ts:390-399,433` | `MessageItem.tsx:102` | shared base |
 *   | totalOutputTokens | historical adapter `transcript-shape.ts:320-324,348` | live assistant adapter `transcript-shape.ts:400-409,434` | `MessageItem.tsx:103` | shared base |
 *   | processSegments | historical group projector `transcript-projection.ts:39-72`, applied at `SessionTranscript.tsx:394` | live assistant adapter `transcript-shape.ts:410-416,432` | `MessageItem.tsx:118` | shared base (group-enriched history + live adapter) |
 *   | turnId | historical adapter `transcript-shape.ts:314,330` and group fallback `SessionTranscript.tsx:393` | none | `MessageItem.tsx:106` | historical extension |
 *   | thinkingDurationMs | historical adapter `transcript-shape.ts:337-339`; group projector `transcript-projection.ts:49-56` | none | `MessageItem.tsx:107` | historical extension |
 *   | initialDiff | historical adapter `transcript-shape.ts:287-290,351` | none | `MessageItem.tsx:108` | historical extension |
 *   | actions | historical adapter `transcript-shape.ts:291-293,349` | none | `MessageItem.tsx:109` | historical extension |
 *   | attachments | historical adapter `transcript-shape.ts:309,350` | none | `MessageItem.tsx:110` | historical extension |
 *   | assistantMessageId | none | live assistant adapter `transcript-shape.ts:425` | `MessageItem.tsx:113` | live extension |
 *   | streaming | none | live assistant adapter `transcript-shape.ts:426` | `MessageItem.tsx:114` | live extension |
 *   | streamMessageId | none | live adapters `transcript-shape.ts:427,456` | `MessageItem.tsx:115` | live extension |
 *   | messageRootId | none | live assistant adapter `transcript-shape.ts:428` | `MessageItem.tsx:116` | live extension |
 *   | processingStartedAtMs | none | live assistant adapter `transcript-shape.ts:429-431` | `MessageItem.tsx:117` | live extension |
 *
 * `wallClockDurationMs` is *group-level* (sum-of-frame span), not
 * per-message. Neither adapter produces it; `SessionTranscript.tsx`
 * computes it on the `group` and passes it as a non-view MessageItem prop.
 *
 * `changeSetId` is carried in the wire shape and the historical
 * message-projection reads it for the diff, but it is never surfaced
 * to `MessageItem`. Removed from the leaf renderer prop block entirely.
 */
export interface WebuiTurnViewBase {
  readonly source: "historical" | "live";
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly sessionId?: string;
  readonly userText?: string;
  readonly thinking?: string;
  readonly tools?: readonly Record<string, unknown>[];
  readonly answers?: readonly string[];
  readonly timestamp?: number;
  readonly isGoal?: boolean;
  readonly totalRequestDurationMs?: number;
  readonly totalOutputTokens?: number;
  /** Live adapter or historical assistant-group projector. */
  readonly processSegments?: readonly WebuiTranscriptProcessSegment[];
}

/**
 * Historical-only extension: persisted fields the live path never carries.
 * `source: "historical"` narrows the union for `MessageItem` reads.
 */
export interface WebuiHistoricalTurnView extends WebuiTurnViewBase {
  readonly source: "historical";
  readonly turnId?: string;
  readonly processForceExpanded?: boolean;
  readonly thinkingDurationMs?: number;
  readonly initialDiff?: WebuiTurnDiffView;
  readonly actions?: WebuiMessageActionCapabilities;
  readonly attachments?: readonly WebuiMessageAttachment[];
}

/**
 * Live-only extension: in-flight fields the historical path never carries.
 * `source: "live"` narrows the union for `MessageItem` reads.
 */
export interface WebuiLiveTurnView extends WebuiTurnViewBase {
  readonly source: "live";
  readonly assistantMessageId?: string;
  readonly streaming?: boolean;
  readonly streamMessageId?: string;
  readonly messageRootId?: string;
  readonly processingStartedAtMs?: number;
}

/**
 * Discriminated union the leaf renderer accepts. Access to side-specific
 * fields (`initialDiff`, `streaming`, …) requires narrowing on `source`.
 */
export type WebuiTurnView = WebuiHistoricalTurnView | WebuiLiveTurnView;

// ── Adapters ─────────────────────────────────────────────────────────

/**
 * Project a single persisted `WebuiClientMessage` into the leaf renderer's
 * input view. Pulls the user / thinking / tool / answer parts through the
 * existing `projectWebuiMessage` (so part ordering and synthetic-message
 * rules stay in one place), then folds the per-message `usage` into
 * `totalRequestDurationMs` / `totalOutputTokens` the leaf renderer
 * expects, and pulls the last `WebuiTurnDiffView` for `initialDiff`.
 *
 * `sessionId` is provided by the caller (the transcript projection owns the
 * session scope; the adapter is per-message).
 *
 * Returns `WebuiHistoricalTurnView` — the historical-only extension of the
 * shared `WebuiTurnViewBase`. The result is a strict subtype: the type
 * system itself rejects any field that isn't either shared or historical-
 * only (e.g. `streaming`, `processSegments`).
 */
export function projectHistoricalTurnView(
  message: WebuiClientMessage,
  sessionId: string,
  projectedItems?: readonly WebuiTranscriptItem[],
  projectMessage: typeof projectWebuiMessage = projectWebuiMessage,
): WebuiHistoricalTurnView {
  const items: readonly WebuiTranscriptItem[] =
    projectedItems ?? projectMessage(message);
  const userItems = items.filter(
    (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
      item.kind === "user",
  );
  const thinkingItems = items.filter(
    (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
      item.kind === "thinking",
  );
  const assistantItems = items.filter(
    (item): item is Extract<WebuiTranscriptItem, { text: string }> =>
      item.kind === "assistant",
  );
  const tools = items
    .filter(
      (item): item is Extract<WebuiTranscriptItem, { kind: "tool" }> =>
        item.kind === "tool",
    )
    .flatMap((item) => item.tools);
  const lastDiff = [...items]
    .reverse()
    .find(
      (item): item is Extract<WebuiTranscriptItem, { diff?: WebuiTurnDiffView }> =>
        "diff" in item,
    )?.diff;
  const fallbackDiff = readMessageDiff(message);
  const initialDiff = lastDiff ?? fallbackDiff;
  const firstItem = items[0];
  const actions =
    firstItem && "actions" in firstItem ? firstItem.actions : undefined;
  const timestamp =
    firstItem && "timestamp" in firstItem ? firstItem.timestamp : undefined;
  const isGoal = assistantItems.some((item) => item.isGoal) ||
    userItems.some((item) => item.isGoal) ||
    message.source === "thread-goal" ||
    message.kind === "goal";
  const attachments = projectMessageAttachments(message.attachments);
  const role: "user" | "assistant" = userItems.length > 0 &&
    assistantItems.length === 0
    ? "user"
    : "assistant";
  const turnId = message.turnId;
  const totalRequestDurationMs = readUsageNumber(
    message.usage,
    "requestDurationMs",
    "request_duration_ms",
  );
  const totalOutputTokens = readUsageNumber(
    message.usage,
    "outputTokens",
    "output_tokens",
  );
  const view: WebuiHistoricalTurnView = {
    source: "historical",
    messageId: message.msgId,
    role,
    sessionId,
    ...(turnId ? { turnId } : {}),
    ...(userItems[0]?.text !== undefined
      ? { userText: userItems[0].text }
      : {}),
    ...(thinkingItems.length > 0
      ? { thinking: thinkingItems.map((item) => item.text).join("\n\n") }
      : {}),
    ...(thinkingItems[0]?.durationMs !== undefined
      ? { thinkingDurationMs: thinkingItems[0].durationMs }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(assistantItems.length > 0
      ? { answers: assistantItems.map((item) => item.text) }
      : {}),
    ...(isGoal ? { isGoal: true } : {}),
    ...(typeof totalRequestDurationMs === "number"
      ? { totalRequestDurationMs }
      : {}),
    ...(typeof totalOutputTokens === "number" ? { totalOutputTokens } : {}),
    ...(actions ? { actions } : {}),
    ...(attachments ? { attachments } : {}),
    ...(initialDiff ? { initialDiff } : {}),
  };
  return view;
}

/**
 * Project the in-flight live stream into one assistant-turn view. A single
 * `WebuiStreamMessage` is one frame — the live column renders the whole
 * turn as one body, so this adapter joins all non-user frames into one
 * `WebuiTurnView`. The first non-empty user frame is kept separately so the
 * caller can render the right-aligned pending bubble.
 *
 * Returns `undefined` when there are no assistant frames (the live column
 * is empty — caller renders the streaming loader instead).
 *
 * Returns `WebuiLiveTurnView` — the live-only extension. The result type
 * excludes historical-only fields (`initialDiff`, `attachments`, `actions`)
 * by construction.
 */
export function projectLiveTurnView(
  messages: readonly WebuiStreamMessage[],
  args: {
    readonly sessionId?: string;
    readonly streaming: boolean;
    readonly processingStartedAtMs?: number;
  },
): WebuiLiveTurnView | undefined {
  const assistant = messages.filter((message) => message.role !== "user");
  if (assistant.length === 0) return undefined;
  const last = assistant[assistant.length - 1];
  if (!last) return undefined;
  const thinking = assistant
    .map((message) => message.thinking)
    .filter((value) => value.trim())
    .join("\n\n");
  const tools = assistant.flatMap((message) => message.toolCalls ?? []);
  const answers = assistant
    .map((message) => message.answer)
    .filter((value) => value.trim());
  const totalRequestDurationMs = assistant.reduce((sum, message) => {
    const value = readUsageNumber(
      message.usage,
      "requestDurationMs",
      "request_duration_ms",
    );
    return typeof value === "number" && Number.isFinite(value)
      ? sum + value
      : sum;
  }, 0);
  const totalOutputTokens = assistant.reduce((sum, message) => {
    const value = readUsageNumber(
      message.usage,
      "outputTokens",
      "output_tokens",
    );
    return typeof value === "number" && Number.isFinite(value)
      ? sum + value
      : sum;
  }, 0);
  const projectedProcessSegments = assistant
    .map((message) => {
      const parts = projectMessageParts({
        msgId: message.id,
        thinkingContent: message.thinking,
        msgContent: message.answer,
        toolCalls: message.toolCalls,
        parts: message.parts,
      });
      const activityParts = parts.flatMap<WebuiTranscriptActivityPart>((part) => {
        if (part.type === "thinking") return [{ type: "thinking", text: part.content, ...(part.durationMs !== undefined ? { durationMs: part.durationMs } : {}) }];
        if (part.type === "text") return [{ type: "text", text: part.content }];
        if (part.type === "cognitive") return [{ type: "cognitive", text: part.content }];
        if (part.type === "compaction") return [{ type: "compaction", text: part.content }];
        if (part.type === "tool_call") return [{ type: "tool", tool: part.toolCall }];
        if (part.type === "delegation") return [{ type: "delegation", message: part.message }];
        if (part.type === "agent_joined") return [{ type: "agent_joined", agent: part.agent as Record<string, unknown> }];
        if (part.type === "asset_list") return [{ type: "asset_list", assets: part.assets.map((asset) => ({ ...asset })) }];
        return [];
      });
      return {
        messageId: message.id,
        ...(message.thinking.trim() ? { thinking: message.thinking } : {}),
        ...(message.toolCalls?.length ? { tools: message.toolCalls } : {}),
        // Keep text parts on their own segment too. A reply that arrives as its
        // own text-only message used to drop out of `processSegments` here, and
        // then out of the per-turn filter below, which left the answer with no
        // text part in the process block: `primaryAnswerPart` went undefined and
        // the answer rendered AFTER the block — below the live activity row.
        // Whether the turn shows a process block at all stays the decision of
        // the per-turn guard below, which still keys on non-text activity.
        ...(activityParts.length ? { activityParts } : {}),
      };
    });
  const processSegments = projectedProcessSegments.some((segment) =>
    segment.activityParts?.some((part) => part.type !== "text"),
  )
    ? projectedProcessSegments.filter((segment) => segment.activityParts?.length)
    : [];
  const view: WebuiLiveTurnView = {
    source: "live",
    messageId: last.id,
    role: "assistant",
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(answers.length > 0 ? { answers } : {}),
    ...(typeof last.id === "string" ? { assistantMessageId: last.id } : {}),
    streaming: args.streaming,
    streamMessageId: "merged",
    messageRootId: "merged",
    ...(args.processingStartedAtMs !== undefined
      ? { processingStartedAtMs: args.processingStartedAtMs }
      : {}),
    ...(processSegments.length > 0 ? { processSegments } : {}),
    ...(totalRequestDurationMs > 0 ? { totalRequestDurationMs } : {}),
    ...(totalOutputTokens > 0 ? { totalOutputTokens } : {}),
  };
  return view;
}

/**
 * Project the pending user frame into the user-bubble view. Returns
 * `undefined` when there is no pending user bubble.
 *
 * The user bubble is a `WebuiLiveTurnView` — it inherits the live-only
 * `streamMessageId` provenance attr the historical path doesn't carry.
 */
export function projectLiveUserView(
  messages: readonly WebuiStreamMessage[],
): WebuiLiveTurnView | undefined {
  const user = messages.find((message) => message.role === "user");
  if (!user) return undefined;
  const view: WebuiLiveTurnView = {
    source: "live",
    messageId: user.id,
    role: "user",
    userText: user.answer,
    streamMessageId: user.id,
    ...(user.timestamp !== undefined ? { timestamp: user.timestamp } : {}),
    ...(user.isGoal ? { isGoal: true } : {}),
  };
  return view;
}
