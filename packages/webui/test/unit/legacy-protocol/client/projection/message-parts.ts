/**
 * Desktop-compatible message projection.
 *
 * The runtime sends message fields, not the Desktop renderer's `parts[]`
 * projection. Keep this module pure so history, live stream tests, and future
 * renderers all consume the same ordering and synthetic-message rules.
 */

export interface WebuiMessageForParts {
  readonly msgId: string;
  readonly turnId?: string;
  readonly queryKey?: string;
  readonly role?: string;
  readonly msgContent?: string;
  readonly thinkingContent?: string;
  readonly thinkingDurationMs?: number;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly attachments?: readonly unknown[];
  /** Desktop's ordered activity parts when the runtime includes them. */
  readonly parts?: readonly Record<string, unknown>[];
  readonly communicationInfosJson?: unknown;
  /** Per-message token usage (matches `TokenUsage` from agent-core). Used to
   *  compute the Desktop-style output rate and turn duration for historical
   *  messages. */
  readonly usage?: Record<string, unknown>;
}

export interface WebuiAgentJoinedPart {
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly title?: string;
}

export interface WebuiDelegationPart {
  readonly fromAgent?: string;
  readonly toAgent?: string;
  readonly content?: string;
  readonly [key: string]: unknown;
}

export interface WebuiDeliveredAsset {
  readonly src: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly caption?: string;
  readonly deleted?: boolean;
}

export type WebuiMessagePart =
  | {
      readonly id: string;
      readonly type: "thinking";
      readonly content: string;
      readonly kind?: string;
      readonly durationMs?: number;
    }
  | { readonly id: string; readonly type: "cognitive"; readonly content: string; readonly kind?: string }
  | { readonly id: string; readonly type: "compaction"; readonly content: string; readonly kind?: string }
  | { readonly id: string; readonly type: "text"; readonly content: string }
  | {
      readonly id: string;
      readonly type: "tool_call";
      readonly toolCall: Record<string, unknown>;
    }
  | {
      readonly id: string;
      readonly type: "agent_joined";
      readonly agent: WebuiAgentJoinedPart;
    }
  | {
      readonly id: string;
      readonly type: "delegation";
      readonly message: WebuiDelegationPart;
    }
  | {
      readonly id: string;
      readonly type: "questionnaire_response";
      readonly summary: WebuiQuestionnaireResponseSummary;
    }
  | { readonly id: string; readonly type: "asset_list"; readonly assets: readonly WebuiDeliveredAsset[] };

export interface WebuiTurnMessageGroup {
  readonly key: string;
  readonly messages: readonly WebuiMessageForParts[];
  readonly parts: readonly WebuiMessagePart[];
  /** Sum of `usage.requestDurationMs` across all messages of the group. */
  readonly totalRequestDurationMs?: number;
  /** Sum of `usage.outputTokens` across all messages of the group. */
  readonly totalOutputTokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value?.[key] === "string" && value[key].trim())
      return value[key] as string;
  }
  return undefined;
}

function parseCommunicationInfos(value: unknown): readonly Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return parseCommunicationInfos(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((item) => parseCommunicationInfos(item));
  const item = record(value);
  if (!item) return [];
  const nested = item.events ?? item.infos ?? item.communicationInfos;
  if (nested !== undefined) return parseCommunicationInfos(nested);
  return [item];
}

function eventType(info: Record<string, unknown>): string | undefined {
  const generic = record(info.generic);
  return stringValue(info, "eventType", "event_type", "type") ??
    stringValue(generic, "eventType", "event_type", "type");
}

function eventData(info: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(info.data) ?? record(record(info.generic)?.data) ?? info;
}

function projectSyntheticParts(
  message: WebuiMessageForParts,
): WebuiMessagePart[] {
  const parts: WebuiMessagePart[] = [];
  for (const [infoIndex, info] of parseCommunicationInfos(message.communicationInfosJson).entries()) {
    const type = eventType(info);
    const data = eventData(info);
    if (type === "session.spawned") {
      const agent: WebuiAgentJoinedPart = {
        ...(stringValue(data, "agentName", "agent_name")
          ? { agentName: stringValue(data, "agentName", "agent_name") }
          : {}),
        ...(stringValue(data, "sessionId", "session_id")
          ? { sessionId: stringValue(data, "sessionId", "session_id") }
          : {}),
        ...(stringValue(data, "parentSessionId", "parent_session_id")
          ? { parentSessionId: stringValue(data, "parentSessionId", "parent_session_id") }
          : {}),
        ...(stringValue(data, "title") ? { title: stringValue(data, "title") } : {}),
      };
      parts.push({
        id: `agent-joined-${message.msgId}`,
        type: "agent_joined",
        agent,
      });
    } else if (type === "communication.message" || type === "delegation.message") {
      parts.push({
        id: `delegation-${message.msgId}`,
        type: "delegation",
        message: data ?? {},
      });
    } else if (type === "questionnaire.response" || type === "questionnaire_response") {
      const requestId =
        stringValue(data, "requestId", "request_id", "id") ??
        `${message.msgId}-${infoIndex}`;
      const schemaVersion =
        stringValue(data, "schemaVersion", "schema_version");
      const submittedAt = stringValue(data, "submittedAt", "submitted_at");
      const mode = stringValue(data, "mode");
      const source =
        stringValue(data, "responseSource", "source") ?? stringValue(data, "source");
      const featureKey = stringValue(data, "featureKey", "feature_key");
      const rawAnswers =
        (Array.isArray(data?.answers)
          ? data?.answers
          : Array.isArray(data?.selections)
            ? data?.selections
            : []) ?? [];
      const labels: string[] = [];
      for (const entry of rawAnswers as readonly unknown[]) {
        if (typeof entry === "string" && entry.trim()) {
          labels.push(entry);
          continue;
        }
        const item = record(entry);
        if (!item) continue;
        const label =
          stringValue(item, "label", "value", "text", "optionLabel") ?? "";
        if (label) labels.push(label);
      }
      const question =
        stringValue(data, "question", "title", "prompt") ?? "Questionnaire";
      const pairs: WebuiQuestionnaireResponseAnswer[] = labels.length > 0
        ? [{ question, labels }]
        : [{ question: "Questionnaire", labels: ["(未选择)"] }];
      parts.push({
        id: `questionnaire-response-${message.msgId}-${infoIndex}`,
        type: "questionnaire_response",
        summary: {
          requestId,
          ...(schemaVersion ? { schemaVersion } : {}),
          ...(submittedAt ? { submittedAt } : {}),
          ...(mode ? { mode } : {}),
          ...(source ? { source } : {}),
          ...(featureKey ? { featureKey } : {}),
          answers: pairs,
        },
      });
    }
  }
  return parts;
}

/** Desktop consumes the serialized todo_updated system event as progress
 *  state; it must not also appear as an assistant message containing JSON. */
function isTodoUpdatedEventMessage(message: WebuiMessageForParts): boolean {
  const content = message.msgContent?.trimStart();
  if (!content?.startsWith('{"eventType":')) return false;
  try {
    const parsed = record(JSON.parse(content));
    return parsed?.eventType === "todo_updated";
  } catch {
    return false;
  }
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&quot;/giu, '"').replace(/&apos;/giu, "'").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&amp;/giu, "&");
}

function projectDeliveredAssets(content: string, messageId: string): { content: string; parts: WebuiMessagePart[] } {
  const parts: WebuiMessagePart[] = [];
  const containers = /<(deliver-assets|deliver_assets|image-gallery)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu;
  let cleaned = content;
  let match: RegExpExecArray | null;
  while ((match = containers.exec(content)) !== null) {
    const inner = match[2] ?? "";
    const assets: WebuiDeliveredAsset[] = [];
    for (const mediaMatch of inner.matchAll(/<media\b([^>]*?)\/?\s*>/giu)) {
      const attributes = mediaMatch[1] ?? "";
      const values: Record<string, string> = {};
      for (const attribute of attributes.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gu)) {
        if (attribute[1] && attribute[3] !== undefined) values[attribute[1].toLowerCase()] = decodeXmlAttribute(attribute[3]);
      }
      const src = values.src?.trim();
      if (!src) continue;
      const name = values.name?.trim() || values.caption?.trim() || src.split(/[\\/]/u).at(-1) || src;
      assets.push({ src, name, ...(values.type ? { mediaType: values.type } : {}), ...(values.caption ? { caption: values.caption } : {}), ...(values.deleted === "true" ? { deleted: true } : {}) });
    }
    if (assets.length) parts.push({ id: `delivered-assets-${messageId}-${parts.length}`, type: "asset_list", assets });
    cleaned = cleaned.replace(match[0], "");
  }
  return { content: cleaned, parts };
}

const DESKTOP_INTERNAL_MESSAGE_BLOCK = /<(agent-message|agent-context|system-reminder|peer-memory-path|engine-message|inbound-context|archon_internal_context|locale-context|runtime-data-context|permission-ask|permission-response|questionnaire-ask|deliver-assets|deliver_assets|image-gallery)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

function stripDesktopInternalMessageBlocks(content: string): string {
  return content
    .replace(DESKTOP_INTERNAL_MESSAGE_BLOCK, "")
    // Desktop normalizes <path> to <asset-path> and unwraps <filepath> before
    // passing the remaining text through Markdown. Keep the path text so the
    // WebUI file-reference renderer can turn workspace paths into links.
    .replace(/<(?:asset-path|path|filepath)\b[^>]*>([\s\S]*?)<\/(?:asset-path|path|filepath)\s*>/giu, "$1")
    .replace(/<video-generation-options\b[^>]*>[\s\S]*?<\/video-generation-options\s*>/giu, "")
    .replace(/<\/?(user-provided-context|mavis-chat-context|html-selection-context)\b[^>]*>/giu, "")
    .trim();
}

function projectMavisThinking(content: string, messageId: string): { content: string; parts: WebuiMessagePart[] } {
  const parts: WebuiMessagePart[] = [];
  const cleaned = content.replace(/<mavis-thinking\b[^>]*>([\s\S]*?)<\/mavis-thinking\s*>/giu, (_match, body: string) => {
    const text = body.trim();
    if (text) parts.push({ id: `mavis-thinking-${messageId}-${parts.length}`, type: "thinking", content: text });
    return "";
  });
  return { content: cleaned, parts };
}

/** Build parts in the exact Desktop order: thinking, text, then tool calls. */
export function projectMessageParts(
  message: WebuiMessageForParts,
): readonly WebuiMessagePart[] {
  // `todo_updated` is a persisted SystemEvent envelope. Workspace progress
  // consumes it separately; mirroring Desktop means omitting it from the
  // conversational transcript while retaining actual `todowrite` calls.
  if (isTodoUpdatedEventMessage(message)) return [];
  const assetProjection = projectDeliveredAssets(message.msgContent ?? "", message.msgId);
  const thinkingProjection = projectMavisThinking(assetProjection.content, message.msgId);
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    const ordered: WebuiMessagePart[] = [];
    for (const [index, raw] of message.parts.entries()) {
      const type = stringValue(raw, "type");
      const id = stringValue(raw, "id") ?? `part-${index}`;
      const content = stringValue(raw, "content") ?? "";
      if (type === "thinking" || type === "cognitive_text" || type === "cognitive" || type === "compaction") {
        const kind = stringValue(raw, "kind");
        ordered.push(type === "thinking"
          ? { id, type: "thinking", content, ...(kind ? { kind } : {}) }
          : { id, type: type === "compaction" ? "compaction" : "cognitive", content, ...(kind ? { kind } : {}) });
      } else if (type === "text" && content.trim()) {
        // Persisted/Desktop messages may already have an ordered parts array,
        // while still carrying renderer-only XML inside a text part. Apply
        // the same special-message projection as the legacy msgContent path.
        const assetProjection = projectDeliveredAssets(content, `${message.msgId}-${id}`);
        const thinkingProjection = projectMavisThinking(assetProjection.content, `${message.msgId}-${id}`);
        const strippedContent = stripQuestionnaireResponse(
          stripDesktopInternalMessageBlocks(thinkingProjection.content),
        );
        ordered.push(...thinkingProjection.parts);
        if (strippedContent.content.trim())
          ordered.push({ id, type: "text", content: strippedContent.content });
        if (strippedContent.questionnaire)
          ordered.push({ id: `${id}-questionnaire`, type: "questionnaire_response", summary: strippedContent.questionnaire });
        ordered.push(...assetProjection.parts);
      }
      else if (type === "tool_call") {
        const call = record(raw.tool_call) ?? record(raw.toolCall);
        if (call) ordered.push({ id, type: "tool_call", toolCall: call });
      } else if (type === "agent_joined") {
        ordered.push({ id, type: "agent_joined", agent: record(raw.agent) ?? raw });
      } else if (type === "delegation") {
        const data = record(raw.message) ?? record(raw.delegation) ?? raw;
        const delegations: Record<string, unknown>[] = Array.isArray(raw.delegations)
          ? raw.delegations.flatMap((value: unknown) => {
              const entry = record(value);
              return entry ? [entry] : [];
            })
          : [data];
        for (const [delegationIndex, message] of delegations.entries()) {
          ordered.push({ id: delegations.length > 1 ? `${id}-${delegationIndex}` : id, type: "delegation", message });
        }
      }
    }
    return [...ordered, ...projectSyntheticParts(message)];
  }
  const parts: WebuiMessagePart[] = [];
  if (message.thinkingContent?.trim()) {
    parts.push({
      id: "thinking",
      type: "thinking",
      content: message.thinkingContent,
      ...(typeof message.thinkingDurationMs === "number"
        ? { durationMs: message.thinkingDurationMs }
        : {}),
    });
  }
  parts.push(...thinkingProjection.parts);
  const strippedContent = stripQuestionnaireResponse(stripDesktopInternalMessageBlocks(thinkingProjection.content));
  if (strippedContent.content.trim()) {
    parts.push({
      id: "text",
      type: "text",
      content: strippedContent.content,
    });
  }
  if (strippedContent.questionnaire) {
    parts.push({
      id: `questionnaire-response-${message.msgId}`,
      type: "questionnaire_response",
      summary: strippedContent.questionnaire,
    });
  }
  if (assetProjection.parts.length) parts.push(...assetProjection.parts);
  for (const [index, toolCall] of (message.toolCalls ?? []).entries()) {
    const toolId =
      typeof toolCall.id === "string" && toolCall.id.trim()
        ? toolCall.id
        : `tool-${index}`;
    parts.push({ id: toolId, type: "tool_call", toolCall });
  }
  // Desktop message type 3 is a file/attachment-only row. Give the ordinary
  // attachment renderer a text-shaped anchor even when the record has no
  // caption; this keeps the attachment visible instead of dropping the row.
  if (parts.length === 0 && (message.attachments?.length ?? 0) > 0)
    parts.push({ id: `attachments-${message.msgId}`, type: "text", content: "" });
  return [...parts, ...projectSyntheticParts(message)];
}

/**
 * Strip a `<questionnaire-response>…</questionnaire-response>` block from the
 * visible user message and return both the cleaned text and a parsed
 * `questionnaire_response` record. The runtime serializes the user's reply as
 * the XML payload followed by the human-readable Q/A summary; without this
 * strip the bubble would surface the raw XML to the reader.
 */
export interface StrippedQuestionnaire {
  readonly content: string;
  readonly questionnaire?: WebuiQuestionnaireResponseSummary;
}

export interface WebuiQuestionnaireResponseAnswer {
  /** The question text from the trailing `Q:` line, when available. */
  readonly question: string;
  /** One human-readable label per answer; for multi-select responses we
   *  keep every option the user chose in order, joined by the renderer. */
  readonly labels: readonly string[];
}

export interface WebuiQuestionnaireResponseSummary {
  readonly requestId: string;
  readonly schemaVersion?: string;
  readonly submittedAt?: string;
  readonly mode?: string;
  readonly source?: string;
  readonly featureKey?: string;
  readonly answers: readonly WebuiQuestionnaireResponseAnswer[];
}

const QUESTIONNAIRE_RESPONSE_BLOCK = /<questionnaire-response>[\s\S]*?<\/questionnaire-response>/g;

export function stripQuestionnaireResponse(text: string): StrippedQuestionnaire {
  if (!text) return { content: "" };
  let extracted: WebuiQuestionnaireResponseSummary | undefined;
  let cleaned = text;
  let match: RegExpExecArray | null;
  QUESTIONNAIRE_RESPONSE_BLOCK.lastIndex = 0;
  while ((match = QUESTIONNAIRE_RESPONSE_BLOCK.exec(text)) !== null) {
    const block = match[0];
    const matchIndex = match.index ?? 0;
    if (!extracted) extracted = parseQuestionnaireResponsePayload(text, block, matchIndex);
    cleaned = cleaned.replace(block, "");
  }
  cleaned = cleaned.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
  return extracted ? { content: cleaned, questionnaire: extracted } : { content: cleaned };
}

/**
 * Parse a `<questionnaire-response>` block together with the trailing
 * `Q:` / `A:` text that the runtime appends after `</questionnaire-response>`.
 *
 * Earlier the helper only received the matched XML block and never saw the
 * trailing Q/A lines, so the rendered card had to fall back to raw markup.
 * Now we receive the full source string and the block's match offset, so we
 * can locate the trailing text, prefer its human-readable question text, and
 * still pull `requestId` / `schemaVersion` / `submittedAt` / `mode` /
 * `responseSource` / `featureKey` from the XML.
 */
function parseQuestionnaireResponsePayload(
  fullText: string,
  block: string,
  matchIndex: number,
): WebuiQuestionnaireResponseSummary {
  const requestId =
    extractXmlElement(block, "requestId") ?? extractXmlElement(block, "request_id") ?? "";
  const schemaVersion = extractXmlElement(block, "schemaVersion");
  const submittedAt = extractXmlElement(block, "submittedAt");
  const mode = extractXmlElement(block, "mode");
  const source =
    extractXmlElement(block, "responseSource") ?? extractXmlElement(block, "source");
  const featureKey = extractXmlElement(block, "featureKey");

  const trailingText = fullText.slice(matchIndex + block.length);
  const trailing = parseTrailingQuestionnaireLines(trailingText);

  // Fall back to the XML `<answer>` blocks when the trailing text is empty
  // (older payloads) or when the trailing text didn't pair up cleanly.
  const answers: WebuiQuestionnaireResponseAnswer[] =
    trailing && trailing.pairs.length > 0
      ? [...trailing.pairs]
      : extractAnswerPairsFromXml(block);
  if (answers.length === 0) {
    answers.push({ question: "Questionnaire", labels: ["(未选择)"] });
  }
  return {
    requestId,
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(submittedAt ? { submittedAt } : {}),
    ...(mode ? { mode } : {}),
    ...(source ? { source } : {}),
    ...(featureKey ? { featureKey } : {}),
    answers,
  };
}

interface TrailingQuestionnaire {
  readonly pairs: readonly WebuiQuestionnaireResponseAnswer[];
}

/**
 * Parse the `Q:` / `A:` lines that follow the `</questionnaire-response>`
 * closing tag. The runtime emits one pair per question and uses two-space
 * trailing whitespace to mark a soft break, so the formatter output reads
 * as Markdown prose. We treat each `Q:` line as the start of a new pair
 * and accumulate `A:` lines until the next `Q:` (or end of input).
 */
function parseTrailingQuestionnaireLines(text: string): TrailingQuestionnaire | undefined {
  const trimmed = text.replace(/^\s*\n+/, "").trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const pairs: WebuiQuestionnaireResponseAnswer[] = [];
  let current: WebuiQuestionnaireResponseAnswer | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "").replace(/^  $/, "").trim();
    if (!line) continue;
    if (line.startsWith("Q:")) {
      if (current) pairs.push(current);
      current = { question: line.replace(/^Q:\s*/, "").trim(), labels: [] };
    } else if (line.startsWith("A:")) {
      const label = line.replace(/^A:\s*/, "").trim();
      if (!label) continue;
      if (current) {
        current = { ...current, labels: [...current.labels, label] };
      } else {
        // `A:` line without a preceding `Q:` — synthesize a placeholder
        // question so we never surface an empty pair.
        current = { question: "Questionnaire", labels: [label] };
      }
    } else if (current && current.labels.length > 0) {
      // Continuation of the previous A: line — fold it in so multi-line
      // answers (Markdown tables, code blocks) keep their structure.
      const last = current.labels[current.labels.length - 1];
      current = { ...current, labels: [...current.labels.slice(0, -1), `${last}\n${line}`] };
    }
  }
  if (current) pairs.push(current);
  return pairs.length > 0 ? { pairs } : undefined;
}

/**
 * Walk the `<answer>` blocks inside the XML and build a question/answer pair
 * per step. The XML only carries the option IDs (`<item>id</item>`), so the
 * rendered label is the ID itself — the renderer tags these as step ids so
 * the reader can tell apart option IDs from human-readable labels.
 */
function extractAnswerPairsFromXml(block: string): WebuiQuestionnaireResponseAnswer[] {
  const pairs: WebuiQuestionnaireResponseAnswer[] = [];
  const answerRegex = /<answer>([\s\S]*?)<\/answer>/g;
  let match: RegExpExecArray | null;
  while ((match = answerRegex.exec(block)) !== null) {
    const inner = match[1] ?? "";
    const stepId = extractXmlElement(inner, "stepId") ?? "step";
    if (/<skipped>\s*true\s*<\/skipped>/i.test(inner)) {
      pairs.push({ question: stepId, labels: ["(已跳过)"] });
      continue;
    }
    const optionRegex = /<item>([\s\S]*?)<\/item>/g;
    const labels: string[] = [];
    let optionMatch: RegExpExecArray | null;
    while ((optionMatch = optionRegex.exec(inner)) !== null) {
      const label = unescapeXml((optionMatch[1] ?? "").trim());
      if (label) labels.push(label);
    }
    const otherTextMatch = /<otherText>([\s\S]*?)<\/otherText>/i.exec(inner);
    if (otherTextMatch) {
      const otherText = unescapeXml((otherTextMatch[1] ?? "").trim());
      if (otherText) labels.push(`其他: ${otherText}`);
    }
    pairs.push({
      question: stepId,
      labels: labels.length > 0 ? labels : ["(未选择)"],
    });
  }
  return pairs;
}

function extractXmlElement(block: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = regex.exec(block);
  if (!match) return undefined;
  return unescapeXml((match[1] ?? "").trim());
}

function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function turnKey(message: WebuiMessageForParts): string {
  if (message.turnId) return `turn:${message.turnId}`;
  if (message.queryKey) return `query:${message.queryKey}`;
  return `message:${message.msgId}`;
}

function remapConflictingPartIds(
  parts: readonly WebuiMessagePart[],
  usedIds: Set<string>,
  messageId: string,
): WebuiMessagePart[] {
  return parts.map((part) => {
    if (!usedIds.has(part.id)) {
      usedIds.add(part.id);
      return part;
    }
    const id = `${messageId}::${part.id}`;
    usedIds.add(id);
    return { ...part, id };
  });
}

/**
 * Merge adjacent messages from one turn/query into one render unit.
 *
 * A repeated message id is legal when the runtime emits several parts for the
 * same logical message. Desktop makes those React keys unique by appending the
 * part id; this projection applies the same rule to the merged unit.
 */
export function groupTurnMessages(
  messages: readonly WebuiMessageForParts[],
): readonly WebuiTurnMessageGroup[] {
  const groups: WebuiTurnMessageGroup[] = [];
  for (const message of messages) {
    const key = turnKey(message);
    const current = groups.at(-1);
    const summary = summarizeMessageUsage(message);
    if (!current || current.key !== key) {
      groups.push({
        key,
        messages: [message],
        parts: projectMessageParts(message),
        ...(summary.requestDurationMs !== undefined
          ? { totalRequestDurationMs: summary.requestDurationMs }
          : {}),
        ...(summary.outputTokens !== undefined
          ? { totalOutputTokens: summary.outputTokens }
          : {}),
      });
      continue;
    }
    const usedIds = new Set(current.parts.map((part) => part.id));
    const nextParts = remapConflictingPartIds(
      projectMessageParts(message),
      usedIds,
      message.msgId,
    );
    groups[groups.length - 1] = {
      ...current,
      messages: [...current.messages, message],
      parts: [...current.parts, ...nextParts],
      ...(summary.requestDurationMs !== undefined || current.totalRequestDurationMs !== undefined
        ? {
            totalRequestDurationMs:
              (current.totalRequestDurationMs ?? 0) + (summary.requestDurationMs ?? 0),
          }
        : {}),
      ...(summary.outputTokens !== undefined || current.totalOutputTokens !== undefined
        ? {
            totalOutputTokens:
              (current.totalOutputTokens ?? 0) + (summary.outputTokens ?? 0),
          }
        : {}),
    };
  }
  return groups;
}

function summarizeMessageUsage(message: WebuiMessageForParts): {
  readonly requestDurationMs?: number;
  readonly outputTokens?: number;
} {
  const usage = message.usage;
  if (!usage) return {};
  const requestDurationMs =
    typeof usage.request_duration_ms === "number"
      ? usage.request_duration_ms
      : typeof usage.requestDurationMs === "number"
        ? usage.requestDurationMs
        : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : undefined;
  return {
    ...(typeof requestDurationMs === "number" ? { requestDurationMs } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
  };
}
