// Types for `packages/webui/test/browser/support/accessibility.mjs`.
//
// The module is plain JavaScript used by a Playwright spec and by the gate test
// in `packages/webui/test/gates/`, so its shapes are declared here rather than
// arriving at the Vitest call site as `any`.

export interface AccessibilityNode {
  readonly selectors: readonly string[];
  readonly stable: string;
  readonly html: string;
}

export interface AccessibilityFinding {
  readonly rule: string;
  readonly impact?: string;
  readonly help?: string;
  readonly nodes: readonly AccessibilityNode[];
  readonly surface?: string;
  readonly state?: string;
  readonly theme?: string;
}

export interface AccessibilityException {
  readonly rule: string;
  readonly surface: string;
  readonly state: string;
  readonly target: string;
  readonly reason: string;
  readonly owner: string;
  readonly removalCondition: string;
}

export interface AccessibilityDisposition {
  readonly rule: string;
  readonly status: string;
  readonly note: string;
  readonly owner: string;
  readonly closesWhen: string;
}

export function loadExceptions(): { readonly exceptions?: readonly AccessibilityException[] };
export function loadBaseline(): { readonly findings?: readonly Record<string, string>[] };
export function loadReview(): { readonly dispositions?: readonly AccessibilityDisposition[] };
export function classifyFindings(options: {
  surface: string;
  state: string;
  findings: readonly AccessibilityFinding[];
  exceptions: readonly AccessibilityException[];
}): { unexcepted: AccessibilityFinding[]; stale: AccessibilityException[] };
export function compareBaseline(
  recorded: readonly Record<string, string>[],
  findings: readonly AccessibilityFinding[],
): { newFindings: Record<string, string>[]; staleEntries: Record<string, string>[] };
export function staleExceptions(
  findings: readonly AccessibilityFinding[],
  exceptions: readonly AccessibilityException[],
): AccessibilityException[];
export function undispositionedRules(
  incomplete: readonly { readonly rule: string }[],
  dispositions: readonly AccessibilityDisposition[],
): string[];
export function openDispositions(
  dispositions: readonly AccessibilityDisposition[],
): AccessibilityDisposition[];
export function formatReport(options: {
  scanned: number;
  findings: readonly AccessibilityFinding[];
  unexcepted: readonly AccessibilityFinding[];
  stale: readonly unknown[];
  incomplete: readonly { readonly rule: string }[];
  review?: readonly AccessibilityDisposition[];
}): string;
export const AXE_TAGS: readonly string[];
export const SCAN_BOUNDARY: readonly string[];
