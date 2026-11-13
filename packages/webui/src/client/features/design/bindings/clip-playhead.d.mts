export function wirePlayhead(options: {
  track: HTMLElement;
  playhead?: HTMLElement | null;
  getRange(): { startMs: number; endMs: number; durationMs: number };
  getDurationMs(): number;
  getCurrentMs?(): number;
  seek(ms: number): void;
  paint(): void;
  onPress?(): void;
  onRelease?(): void;
  win?: Window;
}): () => void;
