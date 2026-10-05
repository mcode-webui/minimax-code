// ActivityIndicator — the WebUI's transcription of Desktop's `function V()`
// (defined in `mine-transcript/58686.pretty.js` at line 682). Used for the
// "thinking…" pulse shown beneath the latest assistant stream and inside the
// streaming placeholders. Verbatim class names, testids, sizing algorithm and
// phrase-rotation weights.
//
// The phrase rotation weights (basic 0.75 / specific 0.15 / motion 0.1) and the
// 2000–3000 ms startup delay followed by 3500 ms swaps come from the same
// source. Avoiding consecutive repeats is verbatim too (line 740–743). When
// `prefers-reduced-motion: reduce` is on the Lottie playback halts but the
// label keeps ticking, mirroring Desktop's `useEffect` at lines 760–773.
//
// The runtime dep is `lottie-web` (Desktop ships the same library verbatim;
// see `minimax-webui/app/out/_next/static/chunks/47bf8baf-*.js`). The exported
// `LottiePlayer` wrapper accepts the same prop surface Desktop's `qf`
// component uses (play, loop, speed, name, data, innerClassName, style) so a
// future port can lift a Desktop chunk without contract drift.
//
// Phrase vocabulary defaults to the zh i18n bundle (`message.item.thinking_phrases`)
// and falls back to the single string `message.item.thinking`. The fallback
// matches Desktop (`g = e ? (r ?? t ?? p ?? (0, h.t)("message.item.thinking")) : null`,
// line 758).
//
// `thinkingPhrases` is overridable so a unit test can pin a deterministic list
// without having to load the i18n bundle; the integration session can pass the
// real one extracted from runtime i18n state.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import lottie from "lottie-web";
import streamingRoseLoaderData from "../assets/lottie/streaming-rose-loader.json";

export interface LottiePlayerProps {
  play: boolean;
  loop: boolean;
  speed: number;
  name: string;
  data: unknown;
  innerClassName?: string;
  style?: CSSProperties;
}

export function LottiePlayer(props: LottiePlayerProps): React.JSX.Element {
  const { play, loop, speed, name, innerClassName, style } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<ReturnType<typeof lottie.loadAnimation> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const animation = lottie.loadAnimation({
      container,
      renderer: "svg",
      loop,
      autoplay: play,
      // `lottie-web`'s `AnimationConfigWithData` accepts the JSON object
      // directly; the type union pulls in `path` for the other overload,
      // which `unknown` covers structurally.
      animationData: props.data as object,
      name,
    });
    animation.setSpeed(speed);
    animationRef.current = animation;
    return () => {
      animation.destroy();
      animationRef.current = null;
    };
    // We intentionally only run this once: lottie-web's reactive updates are
    // done through the imperative setters below. This mirrors Desktop's
    // `useEffect` that mounts the animation once and toggles play/loop via
    // subsequent prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;
    if (play) animation.play();
    else animation.pause();
  }, [play]);

  useEffect(() => {
    animationRef.current?.setSpeed(speed);
  }, [speed]);

  return (
    <div
      ref={containerRef}
      className={innerClassName}
      style={style}
      data-lottie-name={name}
    />
  );
}

export interface ThinkingPhraseSet {
  basic: readonly string[];
  specific: readonly string[];
  motion: readonly string[];
}

export const DEFAULT_THINKING_PHRASES: ThinkingPhraseSet = {
  basic: [
    "分析中…",
    "处理中…",
    "推进中…",
    "规划中…",
    "整理中…",
    "构建中…",
    "生成中…",
    "优化中…",
    "调整中…",
    "校准中…",
    "汇总中…",
    "提炼中…",
    "检查中…",
    "完善中…",
    "整合中…",
    "排布中…",
    "归并中…",
    "链接中…",
    "统筹中…",
    "展开中…",
    "补全中…",
    "修正中…",
    "结构化中…",
    "优先排序中…",
  ],
  specific: [
    "梳理结构中…",
    "串联信息中…",
    "逐步补全中…",
    "校验细节中…",
    "优化表达中…",
  ],
  motion: [
    "起势中…",
    "盘旋中…",
    "俯瞰中…",
    "定位中…",
    "调整方向中…",
    "对准中…",
    "轨迹调整中…",
    "定点处理中…",
    "俯冲准备中…",
    "收拢路径中…",
    "孵化中…",
    "降落中…",
    "筑巢中…",
  ],
};

export const DEFAULT_THINKING_PHRASE_FALLBACK = "思考中…";
export const DEFAULT_THINKING_PHRASE_START_DELAY_MIN_MS = 2000;
export const DEFAULT_THINKING_PHRASE_START_DELAY_MAX_MS = 3000;
export const DEFAULT_THINKING_PHRASE_ROTATION_INTERVAL_MS = 3500;

export interface ThinkingPhraseRotationOptions {
  phraseRootKey?: string;
  startDelayMinMs?: number;
  startDelayMaxMs?: number;
  rotationIntervalMs?: number;
  phrases?: ThinkingPhraseSet;
  fallback?: string;
  random?: () => number;
}

interface WeightedPhraseBucket {
  key: keyof ThinkingPhraseSet;
  weight: number;
  phrases: readonly string[];
}

const DEFAULT_WEIGHTS: readonly { key: keyof ThinkingPhraseSet; weight: number }[] = [
  { key: "basic", weight: 0.75 },
  { key: "specific", weight: 0.15 },
  { key: "motion", weight: 0.1 },
];

export function bucketPhrases(phrases: ThinkingPhraseSet): WeightedPhraseBucket[] {
  return DEFAULT_WEIGHTS.map((entry) => ({
    key: entry.key,
    weight: entry.weight,
    phrases: phrases[entry.key] ?? [],
  })).filter((bucket) => bucket.phrases.length > 0);
}

export function pickWeightedPhrase(
  buckets: readonly WeightedPhraseBucket[],
  previous: string | null,
  random: () => number = Math.random,
): string | null {
  if (buckets.length === 0) return null;
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
  if (totalWeight <= 0) return null;
  let threshold = random() * totalWeight;
  let chosen: WeightedPhraseBucket | null = null;
  for (const bucket of buckets) {
    threshold -= bucket.weight;
    if (threshold <= 0) {
      chosen = bucket;
      break;
    }
  }
  if (!chosen) {
    chosen = buckets[buckets.length - 1] ?? null;
  }
  if (!chosen) return null;
  const pool = chosen.phrases;
  if (pool.length === 0) return null;
  let candidates = pool;
  if (previous && pool.length > 1) {
    const filtered = pool.filter((entry) => entry !== previous);
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

export function computeThinkingPhraseStartDelay(
  startMinMs: number,
  startMaxMs: number,
  random: () => number = Math.random,
): number {
  return startMinMs + random() * Math.max(0, startMaxMs - startMinMs);
}

export function shouldPlayActivityIndicator(prefersReducedMotion: boolean): boolean {
  return !prefersReducedMotion;
}

function useThinkingPhrase(
  active: boolean,
  options: ThinkingPhraseRotationOptions = {},
): string | null {
  const phrases = options.phrases ?? DEFAULT_THINKING_PHRASES;
  const startMin = options.startDelayMinMs ?? DEFAULT_THINKING_PHRASE_START_DELAY_MIN_MS;
  const startMax = options.startDelayMaxMs ?? DEFAULT_THINKING_PHRASE_START_DELAY_MAX_MS;
  const interval = options.rotationIntervalMs ?? DEFAULT_THINKING_PHRASE_ROTATION_INTERVAL_MS;
  const random = options.random ?? Math.random;
  const [value, setValue] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setValue(null);
    if (!active) return undefined;

    const buckets = bucketPhrases(phrases);
    let previous: string | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const next = pickWeightedPhrase(buckets, previous, random);
      previous = next;
      setValue(next);
      timeoutRef.current = setTimeout(tick, interval);
    };

    const startDelay = computeThinkingPhraseStartDelay(startMin, startMax, random);
    timeoutRef.current = setTimeout(tick, startDelay);

    return () => {
      cancelled = true;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [active, phrases, startMin, startMax, interval, random]);

  return value;
}

export interface ActivityIndicatorProps {
  showLabel?: boolean;
  label?: string;
  labelOverride?: string;
  className?: string;
  iconSizePx?: number;
  pulseMinSizePx?: number;
  pulseMaxSizePx?: number;
  visualScale?: number;
  phrases?: ThinkingPhraseSet;
  phraseFallback?: string;
  "aria-hidden"?: "true" | "false";
}

export function ActivityIndicator(props: ActivityIndicatorProps): React.JSX.Element {
  const {
    showLabel = false,
    label,
    labelOverride,
    className = "",
    iconSizePx = 27,
    pulseMinSizePx,
    pulseMaxSizePx,
    visualScale = 1,
    phrases,
    phraseFallback = DEFAULT_THINKING_PHRASE_FALLBACK,
    "aria-hidden": ariaHidden,
  } = props;

  const containerSize = useMemo(() => {
    if (pulseMinSizePx !== undefined || pulseMaxSizePx !== undefined) {
      return Math.max(
        16,
        Math.ceil(
          Math.max(iconSizePx, pulseMinSizePx ?? iconSizePx, pulseMaxSizePx ?? iconSizePx) *
            visualScale,
        ) + 0,
      );
    }
    return 27;
  }, [iconSizePx, pulseMinSizePx, pulseMaxSizePx, visualScale]);

  const innerSize = Math.ceil(iconSizePx * visualScale);

  const [play, setPlay] = useState(true);

  const rotated = useThinkingPhrase(showLabel && !label && !labelOverride, {
    ...(phrases ? { phrases } : {}),
    fallback: phraseFallback,
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setPlay(shouldPlayActivityIndicator(mql.matches));
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  const resolvedLabel = showLabel ? (labelOverride ?? label ?? rotated ?? phraseFallback) : null;

  const containerClass = [
    "flex w-fit max-w-full items-center justify-start gap-[3px] text-left text-[13px] leading-5 tracking-normal text-text_default_tertiary pointer-events-none select-none",
    className,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return (
    <div
      className={containerClass}
      data-testid="streaming-rose-loader"
      aria-hidden={ariaHidden}
    >
      <div
        className="relative flex shrink-0 items-center justify-center overflow-visible"
        style={{
          width: `${containerSize}px`,
          height: `${containerSize}px`,
          minWidth: `${containerSize}px`,
          minHeight: `${containerSize}px`,
        }}
      >
        <LottiePlayer
          play={play}
          loop
          speed={0.8}
          name="streaming-rose-loader"
          data={streamingRoseLoaderData}
          innerClassName="h-full w-full"
          style={{ width: `${innerSize}px`, height: `${innerSize}px` }}
        />
      </div>
      {resolvedLabel ? (
        <span
          className="min-w-0 truncate text-sm leading-5 text-text_default_tertiary"
          style={{ marginTop: "6px" }}
          data-testid="streaming-rose-loader-label"
        >
          {resolvedLabel}
        </span>
      ) : null}
    </div>
  );
}

export interface MessageViewportStreamingLoaderProps {
  testId: string;
  slot?: React.ReactNode;
}

export function MessageViewportStreamingLoader(
  props: MessageViewportStreamingLoaderProps,
): React.JSX.Element {
  const { testId, slot } = props;
  return (
    <div
      className="mb-4 min-h-9 w-full flow-root pointer-events-none"
      data-testid={testId}
    >
      {slot}
    </div>
  );
}

export function MessageAfterQueryStreamingPlaceholder(): React.JSX.Element {
  return (
    <div
      className="mb-4 min-h-9 w-full flow-root pointer-events-none"
      data-testid="message-after-query-streaming-placeholder"
      aria-hidden="true"
    />
  );
}

export interface MessagePassiveLoadingPlaceholderProps {
  label?: string;
}

// No default for `props`: React's `createElement` always materialises a props
// object (it substitutes `{}` for a missing config), so the `= {}` default was
// unreachable from either call site — `SessionTranscript.tsx` passes `label`,
// and the tests call through `createElement`. Keeping it made the parameter
// type `Props | undefined`, which defeats `createElement`'s `P extends {}`
// inference and pushed `label` onto `Attributes` as an excess property.
export function MessagePassiveLoadingPlaceholder(
  props: MessagePassiveLoadingPlaceholderProps,
): React.JSX.Element {
  const { label } = props;
  return (
    <div
      className="mb-4 min-h-9 w-full flow-root pointer-events-none"
      data-testid={label ? "message-passive-loading-status" : "message-passive-loading-placeholder"}
      aria-hidden={!label}
    >
      {label ? <ActivityIndicator showLabel labelOverride={label} /> : null}
    </div>
  );
}
