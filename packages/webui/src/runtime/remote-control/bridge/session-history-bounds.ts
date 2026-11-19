const HISTORY_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const TOOL_FIELD_MAX_BYTES = 64 * 1024;
const TOOL_FIELD_HEAD_BYTES = 48 * 1024;
const NOTICE = "…[内容过长已截断，请在桌面端查看]…";

/** Limit phone history responses without altering the stored transcript. */
export function boundHistoryPage(messages: readonly unknown[]): {
  messagesJson: string;
  droppedMessages: number;
} {
  const encoded = messages.map((message) => JSON.stringify(boundToolFields(message)) ?? "null");
  const sizes = encoded.map((row) => Buffer.byteLength(row));
  let bytes = sizes.reduce((total, size) => total + size, 2 + Math.max(0, sizes.length - 1));
  let first = 0;
  while (first < encoded.length - 1 && bytes > HISTORY_PAGE_MAX_BYTES) {
    bytes -= (sizes[first] ?? 0) + 1;
    first += 1;
  }
  const newest = encoded[first];
  if (newest !== undefined && bytes > HISTORY_PAGE_MAX_BYTES) {
    encoded[first] = shrinkEncodedValue(newest, HISTORY_PAGE_MAX_BYTES - 2, 0).text;
  }
  return { messagesJson: `[${encoded.slice(first).join(",")}]`, droppedMessages: first };
}

function boundToolFields(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const key = Array.isArray(message.tool_calls) ? "tool_calls" : "toolCalls";
  const calls = message[key];
  if (!Array.isArray(calls)) return message;
  return {
    ...message,
    [key]: calls.map((call: unknown) => {
      if (!isRecord(call)) return call;
      return {
        ...call,
        ...boundToolField(call, "tool_call_result_data", false),
        ...boundToolField(call, "toolCallResultData", false),
        ...boundToolField(call, "tool_call_args", true),
        ...boundToolField(call, "toolCallArgs", true),
      };
    }),
  };
}

function boundToolField(
  call: Record<string, unknown>, key: string, structured: boolean,
): Record<string, string> {
  const value = call[key];
  if (typeof value !== "string" || Buffer.byteLength(value) <= TOOL_FIELD_MAX_BYTES) return {};
  if (structured) {
    const result = shrinkEncodedValue(value, TOOL_FIELD_MAX_BYTES, 1024);
    if (result.parsed) return { [key]: result.text };
  }
  return { [key]: shortenMiddle(value, TOOL_FIELD_MAX_BYTES) };
}

interface StringSlot {
  value: string;
  replace(value: string): void;
}

function shrinkEncodedValue(text: string, maxBytes: number, minFieldBytes: number) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text, parsed: false };
  }
  if (!Array.isArray(value) && !isRecord(value)) return { text, parsed: false };
  const slots: StringSlot[] = [];
  collectStrings(value, slots);
  let encoded = text;
  while (Buffer.byteLength(encoded) > maxBytes) {
    let largest: StringSlot | undefined;
    let largestBytes = minFieldBytes;
    for (const slot of slots) {
      const size = Buffer.byteLength(slot.value);
      if (size > largestBytes) {
        largest = slot;
        largestBytes = size;
      }
    }
    if (!largest) break;
    const budget = Math.floor(largestBytes / 2);
    const next = budget > Buffer.byteLength(NOTICE) ? shortenMiddle(largest.value, budget) : "";
    largest.replace(next);
    largest.value = next;
    encoded = JSON.stringify(value);
  }
  return { text: encoded, parsed: true };
}

function collectStrings(value: unknown, slots: StringSlot[]): void {
  if (!isRecord(value) && !Array.isArray(value)) return;
  const container: Record<string, unknown> = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(container)) {
    if (typeof item === "string" && key !== "msg_id" && key !== "msgId") {
      slots.push({ value: item, replace: (next) => { container[key] = next; } });
    } else {
      collectStrings(item, slots);
    }
  }
}

function shortenMiddle(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  const contentBytes = maxBytes - Buffer.byteLength(NOTICE);
  let head = Math.min(TOOL_FIELD_HEAD_BYTES, Math.floor(contentBytes * 0.75));
  let tail = buffer.length - (contentBytes - head);
  while (head > 0 && isContinuationByte(buffer[head])) head -= 1;
  while (tail < buffer.length && isContinuationByte(buffer[tail])) tail += 1;
  return `${buffer.toString("utf8", 0, head)}${NOTICE}${buffer.toString("utf8", tail)}`;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
