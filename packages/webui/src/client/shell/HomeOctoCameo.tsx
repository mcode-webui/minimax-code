import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { banner } from "ascii.rest/banner";
import { useWebuiBrowserCapabilities, type WebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";

/*
 * 像素只沿品牌字形生长，成形前保持原位，随后随机逐格消散。
 * 字体复用原首页标题的 ascii.rest block 字体，前景中文文案独立渲染。
 */

const BRAND_COLORS = ["#0094fc", "#b06add"] as const;
const SPREAD_SECONDS = 6;
const HOLD_SECONDS = 2;
const DISSOLVE_SECONDS = 3;
const REST_SECONDS = 1;
const CYCLE_SECONDS = SPREAD_SECONDS + HOLD_SECONDS + DISSOLVE_SECONDS + REST_SECONDS;
const FRAME_MS = 1000 / 30;
const COMPACT_WIDTH = 960;

const clamp = (value: number, lo = 0, hi = 1): number =>
  value < lo ? lo : value > hi ? hi : value;

function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Wordmark {
  readonly text: string;
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly { x: number; y: number }[];
}

function readWordmark(text: string): Wordmark {
  const piece = banner(text, {
    font: "block",
    pixel: 1,
    gap: 1,
    pad: 0,
    fill: "█",
    shadow: "none",
    effect: "still",
  });
  const cells: Array<{ x: number; y: number }> = [];
  piece.default()(0).split("\n").forEach((row, y) => {
    Array.from(row).forEach((value, x) => {
      if (value === "█") cells.push({ x, y });
    });
  });
  return { text, columns: piece.meta.cols, rows: piece.meta.rows, cells };
}

const FULL_WORDMARK = readWordmark("MINIMAX CODE");
const COMPACT_WORDMARK = readWordmark("MCODE");

interface BrandPixel {
  readonly x: number;
  readonly y: number;
  readonly reveal: number;
  readonly dissolve: number;
  readonly color: string;
  readonly alpha: number;
}

function brandColor(progress: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const from = parseInt(BRAND_COLORS[0].slice(offset, offset + 2), 16);
    const to = parseInt(BRAND_COLORS[1].slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * progress);
  });
  return "rgb(" + channels.join(",") + ")";
}

/** 从字形中间向两侧传播；空格仅参与传播计算，不绘制背景块。 */
function createBrandPixels(wordmark: Wordmark, cycle: number): readonly BrandPixel[] {
  const { columns, rows } = wordmark;
  const arrival = new Float64Array(columns * rows).fill(Infinity);
  const start = Math.floor(rows / 2) * columns + Math.floor(columns / 2);
  const frontier: Array<{ index: number; time: number }> = [{ index: start, time: 0 }];
  arrival[start] = 0;

  while (frontier.length > 0) {
    let first = 0;
    for (let i = 1; i < frontier.length; i += 1) {
      if (frontier[i]!.time < frontier[first]!.time) first = i;
    }
    const current = frontier[first]!;
    frontier[first] = frontier[frontier.length - 1]!;
    frontier.pop();
    if (current.time !== arrival[current.index]) continue;
    const x = current.index % columns;
    const y = Math.floor(current.index / columns);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= columns || ny < 0 || ny >= rows) continue;
      const next = ny * columns + nx;
      const time = current.time + 0.45 + hash(Math.floor(nx / 3) + cycle * 17, ny + 89) * 1.4;
      if (time >= arrival[next]!) continue;
      arrival[next] = time;
      frontier.push({ index: next, time });
    }
  }

  const arrivals = wordmark.cells.map(({ x, y }) => arrival[y * columns + x]!);
  const firstArrival = Math.min(...arrivals);
  const duration = Math.max(1, Math.max(...arrivals) - firstArrival);
  const dissolveOrder = wordmark.cells.map((_, index) => index)
    .sort((a, b) => hash(a, cycle + 101) - hash(b, cycle + 101));
  const dissolveRank = new Float64Array(wordmark.cells.length);
  dissolveOrder.forEach((index, rank) => {
    dissolveRank[index] = (rank + 1) / wordmark.cells.length;
  });
  return wordmark.cells.map(({ x, y }, index) => ({
    x,
    y,
    reveal: (arrivals[index]! - firstArrival) / duration,
    dissolve: dissolveRank[index]!,
    color: brandColor(x / (columns - 1)),
    alpha: 0.10 + hash(x + 43, y + 53) * 0.04,
  }));
}

/** 只在首页可见时绘制；后台时间不计入播放进度。 */
function runWordmark(
  canvas: HTMLCanvasElement,
  hero: HTMLDivElement,
  browserDom: Pick<WebuiBrowserCapabilities["dom"], "readDocumentTheme" | "isPageHidden" | "listenForVisibilityChange">,
): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};

  let dpr = 1;
  let heroCentreY = 0;
  let backdropReferenceHeight = 0;
  let frame = 0;
  let elapsed = 0;
  let lastTick: number | undefined;
  let disposed = false;
  let pixels: readonly BrandPixel[] = [];
  let pixelKey = "";

  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const heroRect = hero.getBoundingClientRect();
    heroCentreY = heroRect.top - rect.top + heroRect.height / 2;
    // 前景恢复大头像后，背景仍保留已确认的小组合尺寸，避免像素字被一起放大。
    backdropReferenceHeight = window.matchMedia("(max-width: 480px)").matches ? 56 : 72;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  };

  const clear = (): void => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const draw = (): void => {
    clear();
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const wordmark = width < COMPACT_WIDTH ? COMPACT_WORDMARK : FULL_WORDMARK;
    // 品牌字与前景组合共用中心，作为其背后的低对比度底纹。
    const pitch = Math.floor(Math.min(
      (width - 48) / wordmark.columns,
      (height - 48) / wordmark.rows,
      (backdropReferenceHeight + 32) / wordmark.rows,
      36,
    ));
    if (pitch < 3) return;
    const gap = pitch >= 18 ? 4 : Math.min(2, pitch - 1);
    const size = pitch - gap;
    const originX = Math.round((width - wordmark.columns * pitch) / 2);
    const originY = Math.round(clamp(
      heroCentreY - wordmark.rows * pitch / 2,
      24,
      Math.max(24, height - wordmark.rows * pitch - 24),
    ));
    const cycle = Math.floor(elapsed / CYCLE_SECONDS);
    const phase = elapsed % CYCLE_SECONDS;
    const key = wordmark.text + ":" + cycle;
    if (pixelKey !== key) {
      pixels = createBrandPixels(wordmark, cycle);
      pixelKey = key;
      canvas.dataset.webuiHomeBrand = wordmark.text;
    }
    const spread = clamp(phase / SPREAD_SECONDS);
    const dissolve = clamp((phase - SPREAD_SECONDS - HOLD_SECONDS) / DISSOLVE_SECONDS);
    const dark = browserDom.readDocumentTheme() === "dark";
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const pixel of pixels) {
      if (pixel.reveal > spread || pixel.dissolve <= dissolve) continue;
      context.globalAlpha = pixel.alpha * (dark ? 1.4 : 1);
      context.fillStyle = pixel.color;
      context.fillRect(
        originX + pixel.x * pitch + gap / 2,
        originY + pixel.y * pitch + gap / 2,
        size,
        size,
      );
    }
    context.globalAlpha = 1;
  };

  const tick = (now: number): void => {
    if (disposed || browserDom.isPageHidden()) {
      frame = 0;
      return;
    }
    if (lastTick === undefined) lastTick = now;
    if (now - lastTick >= FRAME_MS) {
      elapsed += (now - lastTick) / 1000;
      lastTick = now;
      draw();
    }
    frame = window.requestAnimationFrame(tick);
  };

  resize();
  if (!browserDom.isPageHidden()) frame = window.requestAnimationFrame(tick);
  const observer = new ResizeObserver(() => {
    resize();
    draw();
  });
  observer.observe(canvas);
  observer.observe(hero);

  const onVisibility = (): void => {
    if (frame) window.cancelAnimationFrame(frame);
    lastTick = undefined;
    frame = browserDom.isPageHidden() ? 0 : window.requestAnimationFrame(tick);
  };
  const stopVisibility = browserDom.listenForVisibilityChange(onVisibility);

  return () => {
    disposed = true;
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
    stopVisibility();
    clear();
  };
}

/** 装饰性品牌字不接收指针事件，也不重复播报前景内容。 */
export function HomeOctoCameo({ heroRef }: {
  readonly heroRef: RefObject<HTMLDivElement>;
}): ReactElement {
  const { dom: browserDom } = useWebuiBrowserCapabilities();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const hero = heroRef.current;
    if (!canvas || !hero) return undefined;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop: (() => void) | undefined;
    const syncMotion = (): void => {
      stop?.();
      stop = preference.matches ? undefined : runWordmark(canvas, hero, browserDom);
    };
    syncMotion();
    preference.addEventListener("change", syncMotion);
    return () => {
      preference.removeEventListener("change", syncMotion);
      stop?.();
    };
  }, [heroRef, browserDom]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-webui-home-pixel-wordmark="true"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none"
    />
  );
}
