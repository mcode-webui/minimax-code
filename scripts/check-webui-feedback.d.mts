// Types for `scripts/check-webui-feedback.mjs`, used by the feedback budget test.

export function scanSource(text: string): number;
export function compareFeedback(
  scanned: Record<string, number>,
  budget: { readonly files?: Record<string, number> },
): string[];
export function scanClient(root?: string): Promise<Record<string, number>>;
