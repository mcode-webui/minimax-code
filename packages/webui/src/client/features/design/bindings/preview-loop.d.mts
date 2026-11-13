export function wirePreviewLoop(
  preview: HTMLMediaElement,
  options: {
    fromSec(): number;
    toSec(): number;
    isPlaying(): boolean;
    playAt(second: number): void;
  },
): () => void;
