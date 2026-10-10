export function isTurnCompactionMessage(message: {
  readonly role?: string;
  readonly turnId?: string;
  readonly kind?: string;
}, turnId: string): boolean {
  return message.role === "assistant" &&
    (message.turnId === undefined || message.turnId === turnId) &&
    message.kind?.startsWith("compaction") === true;
}

export function projectUsage(messages: readonly Record<string, unknown>[], turnId: string): Record<string, unknown> {
  return messages.reduce<Record<string, unknown>>((total, message) => {
    if (isTurnCompactionMessage(message, turnId)) return total;
    const usage = message.usage;
    if (!isRecord(usage)) return total;
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] as number | undefined ?? 0) + value;
    }
    return total;
  }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

