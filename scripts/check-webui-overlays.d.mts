// Types for `scripts/check-webui-overlays.mjs`, used by the overlay gate test.

export interface ScannedOverlays {
  readonly dropdowns: number;
  readonly dialogs: number;
  readonly managed: number;
}

export interface OverlayEntry {
  readonly disposition: string;
  readonly reason?: string;
  readonly boundary?: string;
  readonly note?: string;
}

export function scanSource(text: string): ScannedOverlays;
export function compareOverlays(
  scanned: Record<string, ScannedOverlays>,
  inventory: { readonly files?: Record<string, OverlayEntry> },
): string[];
export function scanClient(root?: string): Promise<Record<string, ScannedOverlays>>;
