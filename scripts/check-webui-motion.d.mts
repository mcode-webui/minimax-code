// Types for `scripts/check-webui-motion.mjs`, used by the motion gate test.

export interface ScannedStylesheet {
  readonly durations: readonly string[];
  readonly keyframes: readonly string[];
}

export interface MotionDurationEntry {
  readonly value: string;
  readonly family: string;
  readonly reason?: string;
}

export interface MotionKeyframeEntry {
  readonly name: string;
  readonly family: string;
  readonly reason?: string;
}

export interface MotionInventory {
  readonly tokens: Record<string, string | undefined>;
  readonly files: Record<string, { readonly durations?: readonly MotionDurationEntry[]; readonly keyframes?: readonly MotionKeyframeEntry[] }>;
}

export function scanStylesheet(text: string): ScannedStylesheet;
export function compareMotion(
  scannedByFile: Record<string, ScannedStylesheet>,
  inventory: MotionInventory,
): string[];
export function scanClient(root?: string): Promise<Record<string, ScannedStylesheet>>;
