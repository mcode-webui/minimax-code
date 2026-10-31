// Types for `scripts/check-webui-feedback.mjs`, used by the feedback budget test.

/** The announcement channels a caller may not author for itself. */
export const ANNOUNCEMENT_CHANNELS: readonly string[];

export function scanSource(text: string): number;

/** The announcement channels one source authors, per channel, and the total. */
export function countChannels(code: string): {
  total: number;
  counts: Record<string, number>;
};

export function compareFeedback(
  scanned: Record<string, number>,
  budget: { readonly files?: Record<string, number> },
): string[];
export function scanClient(root?: string): Promise<Record<string, number>>;
export function scanClientByChannel(root?: string): Promise<Record<string, Record<string, number>>>;
