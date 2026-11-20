export function frameStops(count?: number, durationSec?: number): number[];
export function waveformPeaks(
  samples: ArrayLike<number>,
  buckets?: number,
): number[];
export function paintFilmstrip(
  canvas: HTMLCanvasElement,
  url: string,
  stops: readonly number[],
): Promise<boolean>;
export function waveformFor(url: string, buckets?: number): Promise<number[]>;
export function paintWaveform(
  canvas: HTMLCanvasElement,
  url: string,
  buckets?: number,
  options?: { oversample?: number },
): Promise<boolean>;
export function redrawStrips(): void;
export function forgetStrip(canvas: HTMLCanvasElement): void;
